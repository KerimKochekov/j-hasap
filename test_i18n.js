// Localization checks run without a browser or touching POS data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const context = vm.createContext({URL,btoa:value=>Buffer.from(value,'binary').toString('base64'),localStorage:{getItem:()=>null}});
vm.runInContext(fs.readFileSync('vendor-qrcode.js','utf8'),context);
vm.runInContext(fs.readFileSync('i18n.js','utf8'),context);
const app = fs.readFileSync('app.js','utf8');
const designer = fs.readFileSync('receipt-designer.js','utf8');
const bluetooth = fs.readFileSync('bluetooth-print.js','utf8');
const keys = [...(app+designer+bluetooth).matchAll(/\bt\((["'])(.*?)\1/g)].map(m=>m[2]);
for(const lang of ['tk','ru']) {
  vm.runInContext(`language='${lang}'`,context);
  for(const key of keys) assert.equal(vm.runInContext(`Object.hasOwn(translations[language],${JSON.stringify(key)})`,context),true,`${lang}: ${key}`);
  assert.ok(vm.runInContext("t('Archive {name}? Existing sales will remain in history.',{name:'Çaý'})",context).includes('Çaý'));
}
vm.runInContext('const esc = '+app.match(/const esc = (.*);/)[1]+';',context);
vm.runInContext(designer,context);
vm.runInContext(app.match(/function barcodeSVG\(code\).*\n/)[0],context);
vm.runInContext(app.match(/const alphabet=.*\n/)[0]+app.match(/const patterns=.*\n/)[0],context);
const defaults = JSON.parse(require('node:child_process').execFileSync(process.env.POS_TEST_PYTHON || 'python3', ['-c','import json; from receipt_config import default_template; print(json.dumps(default_template()))'],{encoding:'utf8'}));
context.defaults=defaults;
vm.runInContext('receiptTemplate=defaults;',context);
vm.runInContext(app.match(/function receiptHTML\(s\).*\n/)[0],context);
const sale={id:7,created_at:'2026-10-05T12:00:00+05:00',total:1250,tendered:2000,payment:'Cash',items:[{name:'Çaý <test>',quantity:1,price:1250}]};
context.sale=sale;
for(const [lang,word] of [['tk','Satuw çegi'],['ru','Кассовый чек'],['en','Sales receipt']]) {
  vm.runInContext(`language='${lang}'`,context);
  const html=vm.runInContext('receiptHTML(sale)',context);
  assert.ok(html.includes(word));
  assert.ok(html.includes('12.50'));
  assert.ok(html.includes('7.50'));
  assert.ok(html.includes('Çaý &lt;test&gt;'));
}
vm.runInContext("language='tk'",context);
assert.ok(vm.runInContext("dateText('2026-10-05T12:00:00+05:00')",context).includes('oktýabr'));
const custom=structuredClone(defaults);
custom.paperWidth=58;custom.blocks[0].text='Dükan <script>alert(1)</script>';
custom.blocks[1].text='Address\nPhone';custom.blocks[0].align='right';
context.custom=custom;
const customized=vm.runInContext('renderReceipt(sale,custom)',context);
assert.ok(customized.includes('--receipt-width:54mm'));
assert.ok(customized.includes('text-align:right'));
assert.ok(customized.includes('&lt;script&gt;'));
assert.ok(!customized.includes('<script>'));
assert.ok(customized.includes('Address\nPhone'));
assert.ok(customized.includes('12.50'));
assert.equal(vm.runInContext('receiptKey({font:1,width:2})===receiptKey({width:2,font:1})',context),true);
custom.blocks.push({id:'code',type:'barcode',align:'center',size:'normal',bold:false});
assert.ok(vm.runInContext('renderReceipt(sale,custom)',context).includes('<svg'));
custom.blocks.push({id:'instagram',type:'qr',url:'https://www.instagram.com/example_shop/',caption:null,align:'center',size:'normal',bold:false});
assert.ok(vm.runInContext('renderReceipt(sale,custom)',context).includes('receipt-qr'));
assert.equal(vm.runInContext("validQRLink('javascript:alert(1)')",context),null);
assert.equal(vm.runInContext("validQRLink('https://www.instagram.com/example_shop/')",context),'https://www.instagram.com/example_shop/');
console.log('Translations, custom layouts, escaped content, receipt totals and Turkmen dates passed.');

vm.runInContext(bluetooth,context);
const pixels=new Uint8ClampedArray(384*4);pixels.fill(255);
for(const x of [0,7,8]){pixels[x*4]=pixels[x*4+1]=pixels[x*4+2]=0;}
pixels[9*4]=pixels[9*4+1]=pixels[9*4+2]=pixels[9*4+3]=0;
context.canvas={width:384,height:1,getContext:()=>({getImageData:()=>({data:pixels})})};
const raster=vm.runInContext('monochromeRaster(canvas)',context);
const bytes=Buffer.from(raster.data,'base64');
assert.equal(bytes.length,48);assert.equal(bytes[0],0x81);assert.equal(bytes[1],0x80);
assert.ok(bytes.subarray(2).every(byte=>byte===0));
console.log('Printer raster bit order and transparent pixels passed.');
