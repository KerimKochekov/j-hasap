import base64
import json
import unittest
from receipt_config import default_template, validate_template
import test_server
import server

class ReceiptValidationTests(unittest.TestCase):
    def test_qr_link_validation_and_persistence(self):
        template=default_template()
        template['blocks'].append({'id':'qr','type':'qr','url':'https://www.instagram.com/example_shop/', 'caption':None,'align':'center','size':'normal','bold':False})
        self.assertEqual(validate_template(template)['blocks'][-1]['url'],'https://www.instagram.com/example_shop/')
        for url in ['javascript:alert(1)','https://','not a link','https://example.com/space here','https://example.com/'+('a'*300)]:
            template['blocks'][-1]['url']=url
            with self.assertRaises(ValueError):validate_template(template)

    def test_custom_text_width_and_logo(self):
        template=default_template()
        template.update(paperWidth=58,font='sans',feed=4)
        template['blocks'][0]['text']='Dükan / Магазин'
        template['blocks'].insert(1,{'id':'logo','type':'logo','align':'center','size':'normal','bold':False,
                                     'image':'data:image/png;base64,'+base64.b64encode(b'\x89PNG\r\n\x1a\nexample').decode()})
        self.assertEqual(validate_template(template),template)

    def test_reject_removed_required_blocks_and_duplicate_ids(self):
        for kind in ('meta','items','total'):
            template=default_template()
            template['blocks']=[b for b in template['blocks'] if b['type']!=kind]
            with self.assertRaises(ValueError):validate_template(template)
        template=default_template()
        template['blocks'][1]['id']=template['blocks'][0]['id']
        with self.assertRaises(ValueError):validate_template(template)

    def test_reject_unsafe_styles_images_and_order(self):
        for field,value in [('paperWidth',100),('font','url(https://example.com)'),('fontSize',True),('feed',10)]:
            template=default_template();template[field]=value
            with self.assertRaises(ValueError):validate_template(template)
        template=default_template();template['blocks'][0]['align']='left; color:red'
        with self.assertRaises(ValueError):validate_template(template)
        template=default_template();template['blocks'].insert(0,{'id':'logo','type':'logo','align':'center','size':'normal','bold':False,'image':'data:image/svg+xml;base64,PHN2Zz4='})
        with self.assertRaises(ValueError):validate_template(template)
        template=default_template();template['blocks'][4],template['blocks'][6]=template['blocks'][6],template['blocks'][4]
        with self.assertRaises(ValueError):validate_template(template)

class ReceiptPersistenceTests(unittest.TestCase):
    setUp = test_server.SalesTests.setUp
    tearDown = test_server.SalesTests.tearDown
    sale = test_server.SalesTests.sale
    def test_sale_keeps_design_after_settings_change(self):
        template=default_template();template['blocks'][0]['text']='First store'
        with server.connect() as db:
            db.execute('INSERT INTO settings(key,value) VALUES(?,?)',('receipt_template',json.dumps(template)))
        sale=self.sale()
        template['blocks'][0]['text']='Second store'
        with server.connect() as db:
            db.execute('UPDATE settings SET value=? WHERE key=?',(json.dumps(template),'receipt_template'))
        with server.connect() as db:
            self.assertEqual(server.sale_detail(db,sale['id'])['receipt_template']['blocks'][0]['text'],'First store')
            self.assertEqual(server.get_receipt_template(db)['blocks'][0]['text'],'Second store')

    def test_initialize_preserves_sales_and_migrates_legacy_receipts(self):
        sale=self.sale()
        with server.connect() as db:
            db.execute('UPDATE sales SET receipt_template=NULL WHERE id=?',(sale['id'],))
        server.initialize()
        with server.connect() as db:
            saved=server.sale_detail(db,sale['id'])
            self.assertEqual(saved['total'],2500)
            self.assertEqual(saved['receipt_template'],default_template())

class BarcodeTemplateTests(unittest.TestCase):
    def test_defaults_and_custom_layout_are_valid(self):
        from receipt_config import default_barcode_template,validate_barcode_template
        design=default_barcode_template()
        self.assertEqual(validate_barcode_template(design),design)
        design['paperWidth']=58
        design['blocks'].insert(0,{'id':'custom','type':'text','text':'Shop <name>','align':'left','size':'small','bold':False})
        self.assertEqual(validate_barcode_template(design),design)
        self.assertEqual(len(default_barcode_template()['blocks']),3)

    def test_required_product_blocks_and_receipt_blocks_are_rejected(self):
        from receipt_config import default_barcode_template,validate_barcode_template
        design=default_barcode_template()
        for kind in ['items','meta','total','payment','qr']:
            broken=default_barcode_template();broken['blocks'][0]['type']=kind
            with self.assertRaises(ValueError):validate_barcode_template(broken)
        design['blocks'][0]['type']='product_price'
        with self.assertRaises(ValueError):validate_barcode_template(design)

    def test_barcode_and_receipt_settings_are_independent(self):
        from receipt_config import default_barcode_template
        import server,json,tempfile
        from pathlib import Path
        old=server.DB
        with tempfile.TemporaryDirectory() as directory:
            try:
                server.DB=Path(directory)/'test.sqlite3';server.initialize()
                with server.connect() as db:
                    design=default_barcode_template();design['fontSize']=14
                    db.execute("INSERT INTO settings(key,value) VALUES('barcode_template',?)",(json.dumps(design),))
                    self.assertEqual(server.get_barcode_template(db),design)
                    self.assertEqual(server.get_receipt_template(db),default_template())
                server.initialize()
                with server.connect() as db:self.assertEqual(server.get_barcode_template(db),design)
            finally:server.DB=old

if __name__=='__main__':unittest.main()
