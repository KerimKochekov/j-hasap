// The editor preview and printed receipts use this same renderer.
let receiptTemplate = null;
let receiptDraft = null;
let selectedBlock = null;
let receiptDirty = false;
let receiptSaving = false;
let receiptUndo = [], receiptRedo = [];
const blockNames = {title:'Title',text:'Text',meta:'Date & receipt number',items:'Purchased items',total:'Sale total',payment:'Payment details',divider:'Divider',spacer:'Blank space',logo:'Store logo',barcode:'Receipt barcode',qr:'Instagram QR code'};
const lockedBlocks = new Set(['meta','items','total']);
const cloneReceipt = value => JSON.parse(JSON.stringify(value));
const receiptKey = value => JSON.stringify(value, (key,entry)=>entry&&typeof entry==='object'&&!Array.isArray(entry)?Object.fromEntries(Object.entries(entry).sort(([a],[b])=>a.localeCompare(b))):entry);
const qrCache = new Map();
function validQRLink(value) {
  try{const url=new URL(value);return value.length<=300&&url.href.length<=300&&!/\s/.test(value)&&['http:','https:'].includes(url.protocol)?url.href:null;}catch{return null;}
}
function receiptQR(value, millimeters=36) {
  const url=validQRLink(value);if(!url)return '';
  const key=`${url}|${language}|${millimeters}`;if(qrCache.has(key))return qrCache.get(key);
  const code=qrcode(0,'M');code.addData(url,'Byte');code.make();
  const count=code.getModuleCount(),size=count+8;let path='';
  for(let row=0;row<count;row++)for(let col=0;col<count;col++)if(code.isDark(row,col))path+=`M${col+4},${row+4}h1v1h-1z`;
  const svg=`<svg class="receipt-qr" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${millimeters}mm" height="${millimeters}mm" role="img" aria-label="${t('Instagram QR code')}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="white"/><path d="${path}" fill="black"/></svg>`;
  if(qrCache.size>50)qrCache.clear();qrCache.set(key,svg);return svg;
}
function receiptText(block) { return block.text == null ? t(block.preset || '') : block.text; }
function renderReceipt(sale, template, interactive = false) {
  const amount = value => (value / 100).toFixed(2);
  const number = String(sale.id).padStart(6,'0');
  const blocks = template.blocks.map(block => {
    let body = '';
    switch(block.type) {
      case 'title': case 'text':
        body = `<div class="receipt-copy">${esc(receiptText(block))}</div>`; break;
      case 'meta':
        body = `<div class="receipt-copy">#${esc(number)}<br>${esc(dateText(sale.created_at,true))}</div>`; break;
      case 'items':
        body = sale.items.map(item=>`<div class="receipt-item"><span>${esc(item.name)}<small>${item.quantity} × ${amount(item.price)}</small></span><strong>${amount(item.price*item.quantity)}</strong></div>`).join(''); break;
      case 'total':
        body = `<div class="receipt-item receipt-total"><strong>${t('TOTAL (TMT)')}</strong><strong>${amount(sale.total)}</strong></div>`; break;
      case 'payment':
        body = `<div class="receipt-item"><span>${t('Payment')}</span><span>${esc(t(sale.payment))}</span></div>`;
        if(sale.payment==='Cash') body += `<div class="receipt-item"><span>${t('Cash received')}</span><span>${amount(sale.tendered)}</span></div><div class="receipt-item"><span>${t('Change')}</span><span>${amount(sale.tendered-sale.total)}</span></div>`;
        break;
      case 'divider': body = '<div class="receipt-divider"></div>'; break;
      case 'spacer': body = '<div class="receipt-space"></div>'; break;
      case 'logo':
        body = block.image ? `<img class="receipt-logo" src="${esc(block.image)}" alt="${t('Store logo')}">` : (interactive ? `<div class="receipt-logo-placeholder">${t('Upload your logo')}</div>` : ''); break;
      case 'barcode':
        body = `<div class="receipt-code">${barcodeSVG(number)}<div>${esc(number)}</div></div>`; break;
      case 'qr':
        body=validQRLink(block.url)?`${receiptQR(block.url,{small:28,normal:36,large:44}[block.size])}<div class="receipt-qr-caption">${esc(block.caption??t('Follow us on Instagram'))}</div>`:(interactive?`<div class="receipt-logo-placeholder">${t('Paste your Instagram page link')}</div>`:'');break;
    }
    return `<div class="receipt-block ${interactive?'editable-block':''} ${interactive&&selectedBlock===block.id?'is-selected':''}" ${interactive?`data-block="${esc(block.id)}" tabindex="0" role="button" aria-label="${esc(t(blockNames[block.type]))}"`:''} style="text-align:${block.align};font-size:${{small:.85,normal:1,large:1.4}[block.size]}em;font-weight:${block.bold?'700':'400'}">${body}</div>`;
  }).join('');
  return `<div class="receipt receipt-v2" style="--receipt-width:${template.paperWidth-4}mm;--receipt-size:${template.fontSize}px;--receipt-font:${template.font==='sans'?'Arial, sans-serif':'monospace'}">${blocks}<div class="receipt-feed" style="height:${template.feed*4}mm"></div></div>`;
}
function designerSample() {
  const items = products.slice(0,2).map((product,index)=>({...product,quantity:index+1}));
  if(!items.length) items.push({name:t('Sample product'),price:1250,quantity:2});
  const total=items.reduce((sum,item)=>sum+item.price*item.quantity,0);
  return {id:123,created_at:new Date().toISOString(),items,total,payment:'Cash',tendered:Math.ceil(total/1000)*1000};
}
function startReceiptDraft() {
  if(receiptDraft) return;
  receiptDraft=cloneReceipt(receiptTemplate);
  selectedBlock=receiptDraft.blocks[0].id;
}
function rememberReceipt() {
  receiptUndo.push(cloneReceipt(receiptDraft));
  if(receiptUndo.length>50)receiptUndo.shift();
  receiptRedo=[];
}
function markReceiptChanged() {
  receiptDirty=receiptKey(receiptDraft)!==receiptKey(receiptTemplate);
  updateReceiptPreview();
}
function blockOrderValid(blocks) { return blocks.findIndex(b=>b.type==='items')<blocks.findIndex(b=>b.type==='total'); }
function renderReceiptDesigner() {
  startReceiptDraft();
  $('#view').innerHTML = `<div class="designer-toolbar"><div><span class="designer-badge">${t('ADMIN')}</span><span id="design-status"></span></div><div class="designer-toolbar-actions"><button class="secondary" id="design-undo" aria-label="${t('Undo')}">↶ ${t('Undo')}</button><button class="secondary" id="design-redo" aria-label="${t('Redo')}">↷ ${t('Redo')}</button><button class="secondary" id="design-discard">${t('Discard changes')}</button><button class="secondary" id="design-test">${t('Print sample')}</button><button class="primary" id="design-save">${t('Save design')}</button></div></div>
  <div class="receipt-designer"><section class="designer-panel block-palette"><div class="designer-section-title">⊞ <h2>${t('Add block')}</h2></div><p class="designer-hint">${t('Build your receipt one block at a time.')}</p><div id="block-palette"></div><div class="required-note"><span>▣</span><p>${t('Receipt number, items and total are required. Their values come from each sale.')}</p></div></section>
  <section class="designer-canvas"><div class="canvas-heading"><span>${t('LIVE PREVIEW')}</span><span id="canvas-width"></span></div><div class="paper-stage"><div id="designer-paper"></div></div><div class="preview-caption"><i></i>${t('Sample data · No sale is recorded')}</div><p class="canvas-tip">${t('Select a block on the receipt to edit it.')}</p></section>
  <section class="designer-inspector"><div class="designer-panel"><div class="designer-section-title">▤ <h2>${t('Document')}</h2></div><label>${t('Paper width')}<div class="paper-widths">${[58,72,80].map(width=>`<button class="${receiptDraft.paperWidth===width?'selected':''}" data-width="${width}" aria-label="${width} mm" aria-pressed="${receiptDraft.paperWidth===width}">${width} mm</button>`).join('')}</div></label><div class="document-fields"><label>${t('Font')}<select id="design-font"><option value="monospace" ${receiptDraft.font==='monospace'?'selected':''}>${t('Monospace')}</option><option value="sans" ${receiptDraft.font==='sans'?'selected':''}>${t('Sans serif')}</option></select></label><label>${t('Text size')}<select id="design-font-size">${[10,11,12,13,14].map(size=>`<option value="${size}" ${receiptDraft.fontSize===size?'selected':''}>${size} px</option>`).join('')}</select></label></div><label class="feed-label">${t('Paper feed')}<span id="feed-value">${receiptDraft.feed} / 4</span><input id="design-feed" type="range" min="0" max="4" value="${receiptDraft.feed}"></label><p class="designer-hint">${t('Match the paper size in your printer settings.')}</p></div><div class="designer-panel" id="block-inspector"></div><div class="designer-panel printer-panel"><div class="designer-section-title">▣ <h2>${t('Printer connection')}</h2></div><p class="designer-hint">${t('Choose Bluetooth for BT-802 or browser printing for an installed printer.')}</p><div id="bluetooth-controls"></div><div id="printer-status"></div><button class="check-printer" id="check-printer">${t('Check connection')}</button></div><button class="reset-design" id="design-reset">↻ ${t('Restore default layout')}</button></section></div>`;
  $('#design-save').onclick=saveReceiptDesign;
  $('#check-printer').onclick=checkReceiptPrinter;
  renderBluetoothControls();
  $('#design-discard').onclick=()=>{rememberReceipt();receiptDraft=cloneReceipt(receiptTemplate);selectedBlock=receiptDraft.blocks[0].id;receiptDirty=false;renderReceiptDesigner();};
  $('#design-undo').onclick=()=>{if(!receiptUndo.length)return;receiptRedo.push(cloneReceipt(receiptDraft));receiptDraft=receiptUndo.pop();receiptDirty=receiptKey(receiptDraft)!==receiptKey(receiptTemplate);renderReceiptDesigner();};
  $('#design-redo').onclick=()=>{if(!receiptRedo.length)return;receiptUndo.push(cloneReceipt(receiptDraft));receiptDraft=receiptRedo.pop();receiptDirty=receiptKey(receiptDraft)!==receiptKey(receiptTemplate);renderReceiptDesigner();};
  $('#design-reset').onclick=async()=>{try{const defaults=await api('receipt-template?default=1');rememberReceipt();receiptDraft=defaults;receiptDirty=receiptKey(defaults)!==receiptKey(receiptTemplate);selectedBlock=defaults.blocks[0].id;renderReceiptDesigner();}catch(e){toast(t(e.message));}};
  $('#design-test').onclick=()=>printContent(`<div class="sample-print">${t('SAMPLE — NOT A SALE')}</div>${renderReceipt(designerSample(),receiptDraft)}`,receiptDraft.paperWidth);
  document.querySelectorAll('[data-width]').forEach(button=>button.onclick=()=>{rememberReceipt();receiptDraft.paperWidth=Number(button.dataset.width);receiptDirty=receiptKey(receiptDraft)!==receiptKey(receiptTemplate);renderReceiptDesigner();});
  $('#design-font').onchange=event=>{rememberReceipt();receiptDraft.font=event.target.value;markReceiptChanged();};
  $('#design-font-size').onchange=event=>{rememberReceipt();receiptDraft.fontSize=Number(event.target.value);markReceiptChanged();};
  $('#design-feed').oninput=event=>{rememberReceipt();receiptDraft.feed=Number(event.target.value);$('#feed-value').textContent=`${receiptDraft.feed} / 4`;markReceiptChanged();};
  renderBlockPalette();renderBlockInspector();updateReceiptPreview();
}
function renderBlockPalette() {
  const descriptions = {title:'A prominent store name or heading.',text:'Addresses, contact details and customer notes.',logo:'Your own store logo, printed in the header.',divider:'A visual rule between receipt sections.',spacer:'Extra breathing room between blocks.',payment:'Payment method, cash received and change.',barcode:'A scannable reference for this receipt.',qr:'Let customers scan to visit your Instagram page.'};
  const icons={title:'T',text:'≡',logo:'▧',divider:'—',spacer:'↕',payment:'▣',barcode:'▥',qr:'▦'};
  $('#block-palette').innerHTML=Object.keys(descriptions).map(kind=>{
    const exists=['logo','payment','barcode','qr'].includes(kind)&&receiptDraft.blocks.some(b=>b.type===kind);
    return `<button class="palette-card" data-add-block="${kind}" ${exists||receiptDraft.blocks.length>=30?'disabled':''}><span class="palette-icon">${icons[kind]}</span><div><strong>${t(blockNames[kind])}</strong><small>${t(descriptions[kind])}</small></div><span class="palette-plus">${exists?'✓':'+'}</span></button>`;
  }).join('');
  document.querySelectorAll('[data-add-block]').forEach(button=>button.onclick=()=>{
    const kind=button.dataset.addBlock;
    if(receiptDraft.blocks.length>=30)return;
    rememberReceipt();
    const block={id:`block-${crypto.randomUUID()}`,type:kind,align:['title','logo','barcode','qr'].includes(kind)?'center':'left',size:kind==='title'?'large':'normal',bold:kind==='title'};
    if(['title','text'].includes(kind))block.text=kind==='title'?t('Your store name'):t('Your receipt text');
    if(kind==='logo')block.image='';
    if(kind==='qr'){block.url='';block.caption=null;}
    const index=receiptDraft.blocks.findIndex(b=>b.id===selectedBlock);
    if(kind==='qr')receiptDraft.blocks.push(block);else receiptDraft.blocks.splice(index+1,0,block);selectedBlock=block.id;receiptDirty=true;renderReceiptDesigner();
  });
}
function updateReceiptPreview() {
  if(!$('#designer-paper'))return;
  $('#designer-paper').innerHTML=renderReceipt(designerSample(),receiptDraft,true);
  $('#canvas-width').textContent=`${receiptDraft.paperWidth} mm`;
  $('#design-status').textContent=t(receiptDirty?'Unsaved changes':'All changes saved');
  $('#design-status').className=receiptDirty?'status-dirty':'status-saved';
  $('#design-save').disabled=receiptSaving||!receiptDirty||receiptDraft.blocks.some(b=>b.type==='qr'&&!validQRLink(b.url));
  $('#design-test').disabled=receiptDraft.blocks.some(b=>b.type==='qr'&&!validQRLink(b.url));
  $('#design-undo').disabled=!receiptUndo.length||receiptSaving;
  $('#design-redo').disabled=!receiptRedo.length||receiptSaving;
  $('#design-discard').disabled=!receiptDirty||receiptSaving;
  document.querySelectorAll('[data-block]').forEach(element=>{
    const select=()=>{selectedBlock=element.dataset.block;renderBlockInspector();updateReceiptPreview();};
    element.onclick=select;element.onkeydown=event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();select();}};
  });
}
function renderBlockInspector() {
  if(!receiptDraft.blocks.some(b=>b.id===selectedBlock))selectedBlock=receiptDraft.blocks[0]?.id;
  const index=receiptDraft.blocks.findIndex(b=>b.id===selectedBlock), block=receiptDraft.blocks[index];
  if(!block)return;
  const required=lockedBlocks.has(block.type), textual=['text','title'].includes(block.type), columnLayout=['items','total','payment','divider','spacer'].includes(block.type);
  $('#block-inspector').innerHTML=`<div class="designer-section-title">☷ <h2>${t('Selected block')}</h2></div><div class="selected-kind">${t(blockNames[block.type])}${required?` <span class="locked-tag">${t('Required')}</span>`:''}</div><label>${t('Alignment')}<div class="block-alignments">${['left','center','right'].map((align,i)=>`<button data-align="${align}" ${columnLayout?'disabled':''} class="${block.align===align?'selected':''}" aria-label="${t(['Align left','Align center','Align right'][i])}">${['≡','☰','≡'][i]}<small>${t(['Left','Center','Right'][i])}</small></button>`).join('')}</div></label><div class="document-fields"><label>${t('Size')}<select id="block-size">${['small','normal','large'].map(size=>`<option value="${size}" ${block.size===size?'selected':''}>${t({small:'Small',normal:'Normal',large:'Large'}[size])}</option>`).join('')}</select></label><label class="bold-toggle"><input type="checkbox" id="block-bold" ${block.bold?'checked':''}>${t('Bold')}</label></div><div class="block-actions"><button id="block-up" ${index===0?'disabled':''}>↑ ${t('Up')}</button><button id="block-down" ${index===receiptDraft.blocks.length-1?'disabled':''}>↓ ${t('Down')}</button><button id="block-delete" class="delete-block" ${required?'disabled':''}>${t('Delete')}</button></div>${textual?`<label>${t('Receipt text')}<textarea id="block-text" maxlength="1000" rows="4">${esc(receiptText(block))}</textarea></label>${block.preset?`<button class="auto-language" id="block-auto-text">${t('Use translated default text')}</button>`:''}`:''}${block.type==='logo'?`<label class="logo-upload">${t('Upload your logo')}<input id="block-logo" type="file" accept="image/png,image/jpeg,image/webp"></label><p class="designer-hint">${t('PNG, JPEG or WebP · Up to 400 KB')}</p>`:''}${required?`<p class="designer-hint">${t('Sale data is filled automatically and cannot be replaced with custom text.')}</p>`:''}`;
  const change=(field,value)=>{rememberReceipt();block[field]=value;markReceiptChanged();};
  document.querySelectorAll('[data-align]').forEach(button=>button.onclick=()=>{change('align',button.dataset.align);renderBlockInspector();});
  $('#block-size').onchange=event=>change('size',event.target.value);
  $('#block-bold').onchange=event=>change('bold',event.target.checked);
  if($('#block-text'))$('#block-text').oninput=event=>change('text',event.target.value);
  if($('#block-auto-text'))$('#block-auto-text').onclick=()=>{change('text',null);renderBlockInspector();};
  $('#block-delete').onclick=()=>{if(required)return;rememberReceipt();receiptDraft.blocks.splice(index,1);selectedBlock=receiptDraft.blocks[Math.min(index,receiptDraft.blocks.length-1)].id;receiptDirty=true;renderReceiptDesigner();};
  const move=offset=>{
    const target=index+offset;if(target<0||target>=receiptDraft.blocks.length)return;
    const next=[...receiptDraft.blocks];[next[index],next[target]]=[next[target],next[index]];
    if(!blockOrderValid(next))return toast(t('Place the total after the items.'));
    rememberReceipt();receiptDraft.blocks=next;receiptDirty=receiptKey(receiptDraft)!==receiptKey(receiptTemplate);renderReceiptDesigner();
  };
  $('#block-up').onclick=()=>move(-1);$('#block-down').onclick=()=>move(1);
  if($('#block-logo'))$('#block-logo').onchange=async event=>{
    const file=event.target.files[0];if(!file)return;
    if(!['image/png','image/jpeg','image/webp'].includes(file.type)||file.size>400000){event.target.value='';return toast(t('Use a PNG, JPEG or WebP logo smaller than 400 KB.'));}
    try{const data=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsDataURL(file);});change('image',data);}catch{toast(t('Invalid logo image.'));}
  };
  if(block.type==='qr'){
    const controls=document.createElement('div');
    controls.innerHTML=`<label>${t('Instagram page link')}<input id="block-qr-url" type="url" maxlength="300" placeholder="https://www.instagram.com/your_shop/" value="${esc(block.url)}"></label><p id="qr-error" class="qr-error" ${validQRLink(block.url)?'hidden':''}>${t('Enter a valid HTTP or HTTPS link for the QR code.')}</p><label>${t('QR caption')}<input id="block-qr-caption" maxlength="150" value="${esc(block.caption??t('Follow us on Instagram'))}"></label><p class="designer-hint">${t('Generated offline. Scan the preview with your phone to check the link.')}</p><button class="auto-language" id="qr-default-caption">${t('Use translated default text')}</button>`;
    $('#block-inspector').append(controls);
    $('#block-qr-url').oninput=event=>{change('url',event.target.value);$('#qr-error').hidden=!!validQRLink(event.target.value);};
    $('#block-qr-caption').oninput=event=>change('caption',event.target.value);
    $('#qr-default-caption').onclick=()=>{change('caption',null);renderBlockInspector();};
  }
}
async function saveReceiptDesign() {
  if(receiptSaving||!receiptDirty)return;
  if(receiptDraft.blocks.some(b=>b.type==='qr'&&!validQRLink(b.url)))return toast(t('Enter a valid HTTP or HTTPS link for the QR code.'));
  const submitted=cloneReceipt(receiptDraft);receiptSaving=true;updateReceiptPreview();
  try{receiptTemplate=await api('receipt-template',submitted);receiptDirty=receiptKey(receiptDraft)!==receiptKey(receiptTemplate);toast(t('Receipt design saved.'));}
  catch(error){toast(t(error.message));}
  finally{receiptSaving=false;if(currentView==='designer')updateReceiptPreview();}
}
async function checkReceiptPrinter() {
  const button=$('#check-printer');button.disabled=true;
  $('#printer-status').textContent=t('Checking printer connection…');
  try{
    const status=await api('printer-status');if(!$('#printer-status'))return;
    $('#printer-status').innerHTML=`${printSettings.method==='bluetooth'?`<p class="printer-ok">${t('Direct Bluetooth printing is selected. The printer connects when you print.')}</p>`:''}<div class="printer-status-line"><span>Bluetooth</span><strong>${t(status.bluetoothAvailable?(status.bluetooth?'On':'Off'):'Unavailable')}</strong></div>${status.devices.map(device=>`<div class="printer-status-line"><span>${esc(device.name)}</span><strong class="${device.connected?'printer-ok':'printer-warn'}">${t(device.connected?'Connected':'Disconnected')}</strong></div>`).join('')}${status.bluetoothAvailable&&!status.devices.length?`<p>${t('No Bluetooth printer found in system records.')}</p>`:''}<div class="printer-status-line"><span>${t('Installed printers')}</span><strong>${status.queueAvailable?status.queues.length:t('Unavailable')}</strong></div>${status.queues.map(name=>`<p>${esc(name)}</p>`).join('')}${status.queueAvailable&&!status.queues.length?`<p class="printer-warn">${t('No printer installed. Browser printing is not ready.')}</p>`:''}<small>${t('System status only. A printed test receipt confirms printing.')}</small>`;
  }catch(error){if($('#printer-status'))$('#printer-status').textContent=t(error.message);}
  finally{if($('#check-printer'))$('#check-printer').disabled=false;}
}
