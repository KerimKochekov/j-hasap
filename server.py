"""Offline POS: standard-library local server and SQLite storage."""
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from decimal import Decimal, InvalidOperation
import sqlite3
import json
import base64
import re
import os
import argparse
import subprocess
import sys
from datetime import datetime
from urllib.parse import urlparse, parse_qs
from receipt_config import default_template, validate_template
from bluetooth_printer import PRINT_BLOCK_REASON, available as bluetooth_available, run_bridge

ROOT = Path(__file__).resolve().parent
DB = Path(os.environ.get('POS_DB', str(ROOT / 'data' / 'pos.sqlite3')))
PRODUCT_PICTURES = {'water','sparkling','milk','bread','eggs','rice','pasta','coffee','chocolate','cookies','oil','default'}

def connect():
    DB.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(DB, timeout=20)
    db.row_factory = sqlite3.Row
    db.execute('PRAGMA foreign_keys=ON')
    return db

def initialize():
    with connect() as db:
        db.executescript('''
        CREATE TABLE IF NOT EXISTS products (
          id INTEGER PRIMARY KEY, name TEXT NOT NULL, barcode TEXT NOT NULL UNIQUE,
          price INTEGER NOT NULL CHECK(price >= 0), active INTEGER NOT NULL DEFAULT 1);
        CREATE TABLE IF NOT EXISTS sales (
          id INTEGER PRIMARY KEY, created_at TEXT NOT NULL, total INTEGER NOT NULL,
          payment TEXT NOT NULL, tendered INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS sale_items (
          id INTEGER PRIMARY KEY, sale_id INTEGER NOT NULL REFERENCES sales(id),
          product_id INTEGER NOT NULL, name TEXT NOT NULL, barcode TEXT NOT NULL,
          price INTEGER NOT NULL, quantity INTEGER NOT NULL CHECK(quantity > 0));
        CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS product_price_history (
          id INTEGER PRIMARY KEY, product_id INTEGER NOT NULL REFERENCES products(id),
          changed_at TEXT NOT NULL, old_price INTEGER, new_price INTEGER NOT NULL,
          source TEXT NOT NULL CHECK(source IN ('baseline','initial','change')));
        CREATE INDEX IF NOT EXISTS price_history_product ON product_price_history(product_id,id);
        CREATE INDEX IF NOT EXISTS sale_items_product ON sale_items(product_id,sale_id);
        ''')
        if 'receipt_template' not in {r['name'] for r in db.execute('PRAGMA table_info(sales)')}:
            db.execute('ALTER TABLE sales ADD COLUMN receipt_template TEXT')
        if 'stock' not in {r['name'] for r in db.execute('PRAGMA table_info(products)')}:
            db.execute('ALTER TABLE products ADD COLUMN stock INTEGER NOT NULL DEFAULT 0 CHECK(stock >= 0)')
        if 'image' not in {r['name'] for r in db.execute('PRAGMA table_info(products)')}:
            db.execute("ALTER TABLE products ADD COLUMN image TEXT NOT NULL DEFAULT ''")
        db.execute('UPDATE sales SET receipt_template=? WHERE receipt_template IS NULL', (json.dumps(default_template()),))
        db.execute("""INSERT INTO product_price_history(product_id,changed_at,old_price,new_price,source)
                   SELECT id,?,NULL,price,'baseline' FROM products p
                   WHERE NOT EXISTS (SELECT 1 FROM product_price_history h WHERE h.product_id=p.id)""",
                   (datetime.now().astimezone().isoformat(timespec='seconds'),))

def get_receipt_template(db):
    row = db.execute("SELECT value FROM settings WHERE key='receipt_template'").fetchone()
    return json.loads(row['value']) if row else default_template()

def get_print_settings(db):
    row = db.execute("SELECT value FROM settings WHERE key='print_settings'").fetchone()
    settings = json.loads(row['value']) if row else {'method':'browser', 'deviceId':None, 'name':None}
    if PRINT_BLOCK_REASON:
        settings['method'] = 'browser'
    return {**settings, 'bluetoothAvailable':bluetooth_available() and not bool(PRINT_BLOCK_REASON),
            'bluetoothPrintError':PRINT_BLOCK_REASON}

def save_print_settings(db, settings):
    value = {key:settings.get(key) for key in ('method','deviceId','name')}
    db.execute("INSERT INTO settings(key,value) VALUES('print_settings',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (json.dumps(value),))

def printer_status():
    result = {'queues':[], 'bluetooth':None, 'devices':[], 'queueAvailable':False, 'bluetoothAvailable':False}
    try:
        queues = subprocess.run(['lpstat','-p'],capture_output=True,text=True,timeout=5)
        result['queueAvailable'] = queues.returncode == 0 or 'No destinations added' in queues.stderr
        result['queues'] = [line.split()[1] for line in queues.stdout.splitlines() if line.startswith('printer ') and len(line.split())>1]
    except (OSError,subprocess.TimeoutExpired):
        pass
    if sys.platform == 'darwin':
        try:
            info = subprocess.run(['/usr/sbin/system_profiler','SPBluetoothDataType','-json'],capture_output=True,text=True,timeout=10)
            for adapter in json.loads(info.stdout).get('SPBluetoothDataType',[]):
                result['bluetoothAvailable'] = True
                result['bluetooth'] = adapter.get('controller_properties',{}).get('controller_state') == 'attrib_on'
                for key,connected in [('device_connected',True),('device_not_connected',False)]:
                    for entry in adapter.get(key,[]):
                        for name,device in entry.items():
                            if device.get('device_minorType') == 'Printer' or re.search(r'BT.?802|802.?TSC',name,re.I):
                                result['devices'].append({'name':name,'connected':connected})
        except (OSError,subprocess.TimeoutExpired,ValueError):
            pass
    return result

def cents(value):
    try:
        amount = Decimal(str(value))
        if not amount.is_finite() or amount < 0 or amount > 1000000 or amount != amount.quantize(Decimal('.01')):
            raise ValueError('Enter a price with at most two decimal places, between 0 and 1,000,000.')
        return int(amount * 100)
    except (InvalidOperation, TypeError):
        raise ValueError('Enter a valid monetary amount.')

def validate_product_image(image):
    if not image:
        return ''
    if isinstance(image, str) and image in {f'/product-images/{key}.svg' for key in PRODUCT_PICTURES}:
        return image
    match = re.fullmatch(r'data:image/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)', image) if isinstance(image,str) else None
    if not match or len(image) > 550000:
        raise ValueError('Use a PNG, JPEG or WebP picture smaller than 400 KB.')
    try:
        data = base64.b64decode(match[2], validate=True)
    except ValueError:
        raise ValueError('Invalid product picture.')
    signatures = {'png':data.startswith(b'\x89PNG\r\n\x1a\n'), 'jpeg':data.startswith(b'\xff\xd8\xff'),
                  'webp':data.startswith(b'RIFF') and data[8:12] == b'WEBP'}
    if len(data) > 400000 or not signatures[match[1]]:
        raise ValueError('Invalid product picture.')
    return image

def product_fields(body):
    name = str(body.get('name', '')).strip()
    barcode = str(body.get('barcode', '')).strip().upper()
    if not name or len(name) > 120:
        raise ValueError('Product name is required (maximum 120 characters).')
    if not re.fullmatch(r'[A-Z0-9.\- $/+%]{1,32}', barcode):
        raise ValueError('Barcode must have 1–32 Code 39 characters: letters, numbers, spaces or - . $ / + %.')
    stock = body.get('stock', 0)
    if type(stock) is not int or not 0 <= stock <= 1000000:
        raise ValueError('Available quantity must be a whole number between 0 and 1,000,000.')
    return name, barcode, cents(body.get('price')), stock, validate_product_image(body.get('image',''))

def save_product(db, body):
    fields = product_fields(body)
    pid = body.get('id')
    db.execute('BEGIN IMMEDIATE')
    changed_at = datetime.now().astimezone().isoformat(timespec='seconds')
    if pid is None:
        pid = db.execute('INSERT INTO products(name,barcode,price,stock,image) VALUES(?,?,?,?,?)', fields).lastrowid
        db.execute("INSERT INTO product_price_history(product_id,changed_at,old_price,new_price,source) VALUES(?,?,NULL,?,'initial')",
                   (pid,changed_at,fields[2]))
    else:
        previous = db.execute('SELECT price FROM products WHERE id=? AND active=1',(pid,)).fetchone()
        if previous is None:
            raise ValueError('Product not found.')
        db.execute('UPDATE products SET name=?,barcode=?,price=?,stock=?,image=? WHERE id=? AND active=1', (*fields,pid))
        if previous['price'] != fields[2]:
            db.execute("INSERT INTO product_price_history(product_id,changed_at,old_price,new_price,source) VALUES(?,?,?,?,'change')",
                       (pid,changed_at,previous['price'],fields[2]))
    return {'id':pid}

def product_detail(db, pid):
    product = db.execute('SELECT * FROM products WHERE id=?',(pid,)).fetchone()
    if product is None:
        raise ValueError('Product not found.')
    result = dict(product)
    result['price_history'] = [dict(r) for r in db.execute(
        'SELECT * FROM product_price_history WHERE product_id=? ORDER BY id DESC',(pid,))]
    result['sales'] = [dict(r) for r in db.execute('''
        SELECT s.id sale_id,s.created_at,s.payment,i.name,i.price,i.quantity,i.price*i.quantity total
        FROM sale_items i JOIN sales s ON s.id=i.sale_id WHERE i.product_id=?
        ORDER BY s.created_at DESC,s.id DESC,i.id DESC''',(pid,))]
    result['units_sold'] = sum(row['quantity'] for row in result['sales'])
    result['sales_revenue'] = sum(row['total'] for row in result['sales'])
    return result

def complete_sale(body):
    lines = body.get('items')
    payment = body.get('payment')
    if payment not in ('Cash', 'Card', 'Other') or not isinstance(lines, list) or not 1 <= len(lines) <= 500:
        raise ValueError('Choose a payment method and add products to the basket.')
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        items, seen, total = [], set(), 0
        for line in lines:
            pid, qty = line.get('id'), line.get('quantity')
            if type(pid) is not int or type(qty) is not int or not 1 <= qty <= 1000000 or pid in seen:
                raise ValueError('Invalid product or quantity in the basket.')
            seen.add(pid)
            p = db.execute('SELECT * FROM products WHERE id=? AND active=1', (pid,)).fetchone()
            if p is None:
                raise ValueError('A product is no longer available. Refresh your basket.')
            if line.get('price') != p['price']:
                raise ValueError('A product price changed. Clear and rebuild the basket before completing the sale.')
            if qty > p['stock']:
                raise ValueError('Not enough stock. Review the available quantities in your basket.')
            items.append((p, qty))
            total += p['price'] * qty
        tendered = cents(body.get('tendered', 0)) if payment == 'Cash' else total
        if tendered < total:
            raise ValueError('Cash received must cover the total.')
        created = datetime.now().astimezone().isoformat(timespec='seconds')
        sid = db.execute('INSERT INTO sales(created_at,total,payment,tendered,receipt_template) VALUES(?,?,?,?,?)',
                         (created, total, payment, tendered, json.dumps(get_receipt_template(db)))).lastrowid
        db.executemany('INSERT INTO sale_items(sale_id,product_id,name,barcode,price,quantity) VALUES(?,?,?,?,?,?)',
                       [(sid, p['id'], p['name'], p['barcode'], p['price'], q) for p, q in items])
        db.executemany('UPDATE products SET stock=stock-? WHERE id=?', [(q, p['id']) for p, q in items])
        result = sale_detail(db, sid)
        result['remaining_stock'] = {str(p['id']):p['stock']-q for p, q in items}
        return result

def sale_detail(db, sid):
    sale = db.execute('SELECT * FROM sales WHERE id=?', (sid,)).fetchone()
    if not sale:
        raise ValueError('Sale not found.')
    result = dict(sale)
    result['receipt_template'] = json.loads(result['receipt_template']) if result.get('receipt_template') else default_template()
    result['items'] = [dict(r) for r in db.execute('SELECT * FROM sale_items WHERE sale_id=?', (sid,))]
    return result

class Handler(BaseHTTPRequestHandler):
    def respond(self, payload, status=200):
        data = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        url = urlparse(self.path)
        try:
            with connect() as db:
                if url.path == '/api/receipt-template':
                    return self.respond(default_template() if parse_qs(url.query).get('default')==['1'] else get_receipt_template(db))
                if url.path == '/api/printer-status':
                    return self.respond(printer_status())
                if url.path == '/api/print-settings':
                    return self.respond(get_print_settings(db))
                if url.path == '/api/products':
                    return self.respond([dict(r) for r in db.execute('SELECT * FROM products WHERE active=1 ORDER BY name COLLATE NOCASE')])
                if re.fullmatch(r'/api/products/\d+', url.path):
                    return self.respond(product_detail(db, int(url.path.split('/')[-1])))
                if url.path == '/api/sales':
                    return self.respond([dict(r) for r in db.execute('SELECT id,created_at,total,payment,tendered FROM sales ORDER BY id DESC')])
                if re.fullmatch(r'/api/sales/\d+', url.path):
                    return self.respond(sale_detail(db, int(url.path.split('/')[-1])))
                if url.path == '/api/stats':
                    args = parse_qs(url.query)
                    start, end = args.get('start', ['0000-01-01'])[0], args.get('end', ['9999-12-31'])[0]
                    where = 'substr(s.created_at,1,10) BETWEEN ? AND ?'
                    summary = dict(db.execute(f'SELECT COUNT(*) sales, COALESCE(SUM(total),0) revenue FROM sales s WHERE {where}', (start,end)).fetchone())
                    summary['units'] = db.execute(f'SELECT COALESCE(SUM(i.quantity),0) FROM sale_items i JOIN sales s ON s.id=i.sale_id WHERE {where}', (start,end)).fetchone()[0]
                    summary['top'] = [dict(r) for r in db.execute(f'SELECT i.product_id, i.name, SUM(i.quantity) units, SUM(i.price*i.quantity) revenue FROM sale_items i JOIN sales s ON s.id=i.sale_id WHERE {where} GROUP BY i.product_id ORDER BY revenue DESC LIMIT 10', (start,end))]
                    summary['days'] = [dict(r) for r in db.execute(f'SELECT substr(s.created_at,1,10) day, SUM(total) revenue FROM sales s WHERE {where} GROUP BY day ORDER BY day', (start,end))]
                    return self.respond(summary)
            files = {'/': 'index.html', '/app.js': 'app.js', '/i18n.js': 'i18n.js', '/receipt-designer.js': 'receipt-designer.js', '/vendor-qrcode.js': 'vendor-qrcode.js', '/vendor-html2canvas.js':'vendor-html2canvas.js', '/bluetooth-print.js':'bluetooth-print.js', '/style.css': 'style.css', '/receipt-designer.css': 'receipt-designer.css'}
            files.update({f'/product-images/{key}.svg':f'product-images/{key}.svg' for key in PRODUCT_PICTURES})
            if url.path not in files:
                return self.respond({'error':'Not found'}, 404)
            path = ROOT / files[url.path]
            data = path.read_bytes()
            self.send_response(200)
            self.send_header('Content-Type', {'html':'text/html; charset=utf-8','js':'text/javascript; charset=utf-8','css':'text/css; charset=utf-8','svg':'image/svg+xml'}[path.suffix[1:]])
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except ValueError as e:
            self.respond({'error':str(e)}, 400)

    def do_POST(self):
        try:
            origin = self.headers.get('Origin')
            if origin and origin != 'http://' + self.headers.get('Host', ''):
                return self.respond({'error':'Cross-origin request rejected'}, 403)
            if self.headers.get('Content-Type', '').split(';')[0] != 'application/json':
                return self.respond({'error':'JSON content required'}, 415)
            length = int(self.headers.get('Content-Length', '0'))
            maximum = 900000 if self.path == '/api/bluetooth/print' else (650000 if self.path in ('/api/receipt-template','/api/products') else 100000)
            if not 0 < length <= maximum:
                raise ValueError('Invalid request size.')
            body = json.loads(self.rfile.read(length))
            if not isinstance(body, dict):
                raise ValueError('Invalid request.')
            if self.path == '/api/sales':
                return self.respond(complete_sale(body), 201)
            if self.path in ('/api/bluetooth/connect','/api/bluetooth/test','/api/bluetooth/print'):
                with connect() as db:
                    settings = get_print_settings(db)
                action = self.path.rsplit('/',1)[1]
                if action != 'connect' and not settings['deviceId']:
                    raise ValueError('Connect the BT-802 in Receipt designer first.')
                response = run_bridge(action, settings['deviceId'], body if action == 'print' else None)
                if action == 'connect':
                    settings.update(deviceId=response['deviceId'],name=response['name'])
                    with connect() as db:
                        save_print_settings(db, settings)
                    return self.respond({**settings,'status':response.get('status'),'paperStatus':response.get('paperStatus')})
                return self.respond(response)
            if self.path == '/api/print-settings':
                method = body.get('method')
                if method not in ('browser','bluetooth'):
                    raise ValueError('Invalid printing method.')
                with connect() as db:
                    settings = get_print_settings(db)
                    if method == 'bluetooth' and (not settings['bluetoothAvailable'] or not settings['deviceId']):
                        raise ValueError('Connect the BT-802 in Receipt designer first.')
                    settings['method'] = method
                    save_print_settings(db, settings)
                return self.respond(settings)
            if self.path == '/api/receipt-template':
                template = validate_template(body)
                with connect() as db:
                    db.execute("INSERT INTO settings(key,value) VALUES('receipt_template',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (json.dumps(template),))
                return self.respond(template)
            with connect() as db:
                if self.path == '/api/products':
                    return self.respond(save_product(db,body))
                if self.path == '/api/products/archive':
                    db.execute('UPDATE products SET active=0 WHERE id=?', (body.get('id'),))
                    return self.respond({'ok':True})
            return self.respond({'error':'Not found'},404)
        except sqlite3.IntegrityError:
            self.respond({'error':'This barcode is already assigned to a product.'},409)
        except (ValueError, AttributeError, TypeError) as e:
            self.respond({'error':str(e)},400)

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Local offline POS')
    parser.add_argument('--database', type=Path, default=DB)
    parser.add_argument('--port', type=int, default=int(os.environ.get('POS_PORT','8765')))
    args = parser.parse_args()
    DB = args.database
    initialize()
    port = args.port
    httpd = ThreadingHTTPServer(('127.0.0.1',port), Handler)
    print(f'Offline POS running at http://127.0.0.1:{port}', flush=True)
    httpd.serve_forever()
