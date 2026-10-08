import json
import sqlite3
import tempfile
import threading
import unittest
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import server


class QuietHandler(server.Handler):
    def log_message(self, *args):
        pass


class ResetEndpointTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.addCleanup(setattr, server, 'DB', server.DB)
        server.DB = Path(temporary.name) / 'reset-test.sqlite3'
        server.initialize()
        with server.connect() as db:
            self.pid = server.save_product(db, {'name': 'Tea', 'barcode': 'TEA', 'price': '12.50', 'stock': 20})['id']
        with server.connect() as db:
            archived = server.save_product(db, {'name': 'Archived', 'barcode': 'OLD', 'price': '1.00', 'stock': 3})['id']
            db.execute('UPDATE products SET active=0 WHERE id=?', (archived,))
            db.executemany('INSERT INTO settings(key,value) VALUES(?,?)', [
                ('receipt_template', json.dumps(server.default_template())),
                ('barcode_template', json.dumps(server.default_barcode_template())),
                ('print_settings', json.dumps({'method': 'browser', 'deviceId': None, 'name': None})),
            ])
        sale = server.complete_sale({'items': [{'id': self.pid, 'quantity': 2, 'price': 1250}], 'payment': 'Card'})
        with server.connect() as db:
            self.saved_sale = server.sale_detail(db, sale['id'])
        self.httpd = server.ThreadingHTTPServer(('127.0.0.1', 0), QuietHandler)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.stop_server)
        self.base = f'http://127.0.0.1:{self.httpd.server_port}'

    def stop_server(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=5)

    def request(self, path, method='POST', body=None, content_type='application/json', origin=None):
        data = None if method == 'GET' else json.dumps({} if body is None else body).encode()
        headers = {'Content-Type': content_type}
        if origin is not None:
            headers['Origin'] = origin
        request = Request(self.base + path, data=data, headers=headers, method=method)
        try:
            response = urlopen(request, timeout=5)
        except HTTPError as error:
            response = error
        with response:
            return response.status, json.load(response)

    def snapshot(self, *tables):
        with server.connect() as db:
            return {table: [tuple(row) for row in db.execute(f'SELECT * FROM {table} ORDER BY 1')] for table in tables}

    def test_product_reset_preserves_receipts_and_new_products_have_no_old_sales(self):
        preserved = self.snapshot('sales', 'sale_items', 'settings')
        status, result = self.request('/api/products/reset')
        self.assertEqual(status, 200)
        self.assertEqual(result, {'ok': True, 'deleted': {
            'product_price_history': 2, 'product_stock_history': 2, 'products': 2,
        }})
        self.assertEqual(self.snapshot('products', 'product_price_history', 'product_stock_history'), {
            'products': [], 'product_price_history': [], 'product_stock_history': [],
        })
        self.assertEqual(self.snapshot('sales', 'sale_items', 'settings'), preserved)
        self.assertEqual(self.request('/api/products', method='GET'), (200, []))
        self.assertEqual(self.request(f"/api/sales/{self.saved_sale['id']}", method='GET'), (200, self.saved_sale))
        status, product = self.request('/api/products', body={'name': 'New tea', 'barcode': 'TEA', 'price': '3.00', 'stock': 5})
        self.assertEqual(status, 200)
        self.assertNotEqual(product['id'], self.pid)
        status, detail = self.request(f"/api/products/{product['id']}", method='GET')
        self.assertEqual(status, 200)
        self.assertEqual(detail['sales'], [])
        self.assertEqual(detail['units_sold'], 0)
        self.assertEqual(detail['sales_revenue'], 0)
        self.assertEqual([entry['source'] for entry in detail['stock_history']], ['adjustment'])

    def test_sales_reset_preserves_catalog_stock_histories_and_settings(self):
        preserved = self.snapshot('products', 'product_price_history', 'product_stock_history', 'settings')
        status, result = self.request('/api/sales/reset')
        self.assertEqual(status, 200)
        self.assertEqual(result, {'ok': True, 'deleted': {'sale_items': 1, 'sales': 1}})
        self.assertEqual(self.snapshot('sales', 'sale_items'), {'sales': [], 'sale_items': []})
        self.assertEqual(self.snapshot('products', 'product_price_history', 'product_stock_history', 'settings'), preserved)
        self.assertEqual(self.request('/api/sales', method='GET'), (200, []))
        status, stats = self.request('/api/stats', method='GET')
        self.assertEqual(status, 200)
        self.assertEqual(stats, {'sales': 0, 'revenue': 0, 'units': 0, 'top': [], 'days': []})
        status, detail = self.request(f'/api/products/{self.pid}', method='GET')
        self.assertEqual(status, 200)
        self.assertEqual(detail['stock'], 18)
        self.assertEqual(detail['sales'], [])
        self.assertEqual(detail['units_sold'], 0)

    def test_resets_are_repeatable_and_startup_keeps_cleared_data_empty(self):
        for scope in ('products', 'sales'):
            self.assertEqual(self.request(f'/api/{scope}/reset')[0], 200)
            status, result = self.request(f'/api/{scope}/reset')
            self.assertEqual(status, 200)
            self.assertTrue(result['ok'])
            self.assertTrue(all(count == 0 for count in result['deleted'].values()))
        server.initialize()
        self.assertEqual(self.snapshot('products', 'product_price_history', 'product_stock_history', 'sales', 'sale_items'), {
            'products': [], 'product_price_history': [], 'product_stock_history': [], 'sales': [], 'sale_items': [],
        })

    def test_read_requests_and_invalid_posts_cannot_reset_data(self):
        tables = ('products', 'product_price_history', 'product_stock_history', 'sales', 'sale_items', 'settings')
        before = self.snapshot(*tables)
        for scope in ('products', 'sales'):
            path = f'/api/{scope}/reset'
            self.assertEqual(self.request(path, method='GET')[0], 404)
            self.assertEqual(self.request(path, origin='http://example.com')[0], 403)
            self.assertEqual(self.request(path, content_type='text/plain')[0], 415)
            self.assertEqual(self.request(path, body=[])[0], 400)
        self.assertEqual(self.snapshot(*tables), before)

    def test_failed_reset_rolls_back_related_history_deletions(self):
        tables = ('products', 'product_price_history', 'product_stock_history', 'sales', 'sale_items', 'settings')
        before = self.snapshot(*tables)
        for scope in ('products', 'sales'):
            with self.subTest(scope=scope):
                with server.connect() as db:
                    db.execute(f"CREATE TRIGGER block_reset BEFORE DELETE ON {scope} BEGIN SELECT RAISE(ABORT, 'test rollback'); END")
                with self.assertRaises(sqlite3.IntegrityError):
                    server.reset_data(scope)
                self.assertEqual(self.snapshot(*tables), before)
                with server.connect() as db:
                    db.execute('DROP TRIGGER block_reset')


if __name__ == '__main__':
    unittest.main()
