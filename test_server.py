import tempfile
import unittest
from pathlib import Path
import server

class SalesTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.previous_db = server.DB
        server.DB = Path(self.tmp.name) / 'test.sqlite3'
        server.initialize()
        with server.connect() as db:
            self.pid = db.execute('INSERT INTO products(name,barcode,price,stock) VALUES(?,?,?,?)', ('Tea','123456',1250,20)).lastrowid

    def tearDown(self):
        server.DB = self.previous_db
        self.tmp.cleanup()

    def sale(self, **kwargs):
        body = {'items':[{'id':self.pid,'quantity':2,'price':1250}], 'payment':'Cash', 'tendered':'30.00'}
        body.update(kwargs)
        return server.complete_sale(body)

    def test_total_and_historical_snapshot(self):
        sale = self.sale()
        self.assertEqual(sale['total'],2500)
        self.assertEqual(sale['tendered'],3000)
        with server.connect() as db:
            db.execute('UPDATE products SET name=?,price=?,active=0 WHERE id=?', ('New tea',1800,self.pid))
        with server.connect() as db:
            saved = server.sale_detail(db,sale['id'])
            self.assertEqual(saved['items'][0]['name'],'Tea')
            self.assertEqual(saved['items'][0]['price'],1250)

    def test_insufficient_cash_creates_no_sale(self):
        with self.assertRaises(ValueError): self.sale(tendered='1.00')
        with server.connect() as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM sales').fetchone()[0],0)

    def test_changed_price_rejected(self):
        with server.connect() as db: db.execute('UPDATE products SET price=1300 WHERE id=?',(self.pid,))
        with self.assertRaisesRegex(ValueError,'price changed'): self.sale()

    def test_card_and_zero_price(self):
        sale = self.sale(payment='Card')
        self.assertEqual(sale['total'],sale['tendered'])
        with server.connect() as db: db.execute('UPDATE products SET price=0 WHERE id=?',(self.pid,))
        sale = self.sale(items=[{'id':self.pid,'quantity':1,'price':0}],tendered='0')
        self.assertEqual(sale['total'],0)

    def test_invalid_and_duplicate_quantities(self):
        for quantity in [0,-1,1.5,True,1000001]:
            with self.assertRaises(ValueError): self.sale(items=[{'id':self.pid,'quantity':quantity,'price':1250}])
        with self.assertRaises(ValueError): self.sale(items=[{'id':self.pid,'quantity':1,'price':1250}]*2)

    def test_archived_product_rejected(self):
        with server.connect() as db: db.execute('UPDATE products SET active=0 WHERE id=?',(self.pid,))
        with self.assertRaises(ValueError): self.sale()

    def stock(self):
        with server.connect() as db:
            return db.execute('SELECT stock FROM products WHERE id=?', (self.pid,)).fetchone()[0]

    def test_sale_deducts_stock_and_sellout_blocks_another_sale(self):
        with server.connect() as db: db.execute('UPDATE products SET stock=2 WHERE id=?', (self.pid,))
        sale = self.sale()
        self.assertEqual(self.stock(), 0)
        self.assertEqual(sale['remaining_stock'], {str(self.pid):0})
        with self.assertRaisesRegex(ValueError, 'Not enough stock'): self.sale()
        self.assertEqual(self.stock(), 0)

    def test_failed_payment_preserves_stock(self):
        with self.assertRaises(ValueError): self.sale(tendered='1.00')
        self.assertEqual(self.stock(), 20)

    def test_one_unavailable_line_rolls_back_entire_sale(self):
        with server.connect() as db:
            other = db.execute("INSERT INTO products(name,barcode,price,stock) VALUES('Coffee','987',100,0)").lastrowid
        with self.assertRaisesRegex(ValueError, 'Not enough stock'):
            self.sale(items=[{'id':self.pid,'quantity':1,'price':1250}, {'id':other,'quantity':1,'price':100}])
        self.assertEqual(self.stock(), 20)
        with server.connect() as db: self.assertEqual(db.execute('SELECT COUNT(*) FROM sales').fetchone()[0],0)

    def test_restart_preserves_remaining_stock(self):
        self.sale()
        server.initialize()
        self.assertEqual(self.stock(),18)

    def test_competing_sales_cannot_sell_the_same_stock(self):
        from concurrent.futures import ThreadPoolExecutor
        with server.connect() as db: db.execute('UPDATE products SET stock=1 WHERE id=?',(self.pid,))
        def attempt():
            try:
                self.sale(items=[{'id':self.pid,'quantity':1,'price':1250}])
                return True
            except ValueError:
                return False
        with ThreadPoolExecutor(max_workers=2) as pool:
            results=list(pool.map(lambda _:attempt(), range(2)))
        self.assertEqual(sorted(results),[False,True])
        self.assertEqual(self.stock(),0)

    def test_product_pictures_allow_local_assets_and_reject_unsafe_content(self):
        self.assertEqual(server.validate_product_image('/product-images/milk.svg'), '/product-images/milk.svg')
        self.assertEqual(server.validate_product_image(''),'')
        for image in ('javascript:alert(1)','https://example.com/image.png','/product-images/../server.py','data:image/svg+xml;base64,PHN2Zz4=', 'data:image/png;base64,AAAA'):
            with self.subTest(image=image), self.assertRaises(ValueError): server.validate_product_image(image)

    def test_stock_validation(self):
        for stock in (-1, 1.5, True, '2', 1000001):
            with self.subTest(stock=stock), self.assertRaises(ValueError):
                server.product_fields({'name':'Tea','barcode':'123','price':'1.00','stock':stock})
        self.assertEqual(server.product_fields({'name':'Tea','barcode':'123','price':'1.00','stock':0})[3],0)

    def save_price(self, price, **changes):
        body={'id':self.pid,'name':'Tea','barcode':'123456','price':price,'stock':20}
        body.update(changes)
        with server.connect() as db: return server.save_product(db,body)

    def test_price_history_records_only_actual_price_changes(self):
        server.initialize()
        self.save_price('12.50',name='Renamed tea')
        self.save_price('15.00')
        self.save_price('9.00')
        with server.connect() as db: detail=server.product_detail(db,self.pid)
        self.assertEqual([(h['old_price'],h['new_price'],h['source']) for h in detail['price_history']],
                         [(1500,900,'change'),(1250,1500,'change'),(None,1250,'baseline')])
        server.initialize()
        with server.connect() as db: self.assertEqual(len(server.product_detail(db,self.pid)['price_history']),3)

    def test_product_sales_log_preserves_sold_prices_quantities_and_dates(self):
        first=self.sale()
        self.save_price('15.00')
        second=self.sale(items=[{'id':self.pid,'quantity':1,'price':1500}])
        with server.connect() as db:
            other=db.execute("INSERT INTO products(name,barcode,price,stock) VALUES('Coffee','987',100,5)").lastrowid
        self.sale(items=[{'id':other,'quantity':1,'price':100}])
        with server.connect() as db: detail=server.product_detail(db,self.pid)
        self.assertEqual([(r['sale_id'],r['price'],r['quantity']) for r in detail['sales']],[(second['id'],1500,1),(first['id'],1250,2)])
        self.assertEqual(detail['sales'][1]['created_at'],first['created_at'])
        self.assertEqual(detail['units_sold'],3)
        self.assertEqual(detail['sales_revenue'],4000)

    def test_failed_product_save_does_not_record_price_change(self):
        server.initialize()
        with server.connect() as db: db.execute("INSERT INTO products(name,barcode,price) VALUES('Other','987',100)")
        import sqlite3
        with self.assertRaises(sqlite3.IntegrityError): self.save_price('15.00',barcode='987')
        with server.connect() as db:
            detail=server.product_detail(db,self.pid)
        self.assertEqual(detail['price'],1250)
        self.assertEqual(len(detail['price_history']),1)

    def test_new_product_has_initial_price_record_and_empty_sales(self):
        with server.connect() as db:
            result=server.save_product(db,{'name':'New','barcode':'NEW','price':'2.00','stock':5})
        with server.connect() as db: detail=server.product_detail(db,result['id'])
        self.assertEqual(detail['price_history'][0]['source'],'initial')
        self.assertEqual(detail['price_history'][0]['new_price'],200)
        self.assertEqual(detail['sales'],[])
        self.assertEqual(detail['units_sold'],0)

    def test_money_validation(self):
        self.assertEqual(server.cents('12.50'),1250)
        for amount in ['NaN','Infinity','-1','0.001','invalid','1000001']:
            with self.assertRaises(ValueError): server.cents(amount)

if __name__ == '__main__': unittest.main()
