const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money = n => `${(n / 100).toFixed(2)} <span class="currency">TMT</span>`;
const day = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };
let products = [], cart = [], currentView = 'checkout', lastReceipt = null, busy = false, discountPercent = 0;
async function api(path, body) {
  const res = await fetch('/api/' + path, body === undefined ? {} : {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const data = await res.json(); if (!res.ok) throw new Error(t(data.error || "Request failed")); return data;
}
function toast(message) { $('#toast').textContent = message; $('#toast').classList.add('show'); clearTimeout(toast.timer); toast.timer = setTimeout(() => $('#toast').classList.remove('show'), 4500); }
function discountedPrice(p) { return Math.round(p.price*(10000-Math.round(discountPercent*100))/10000); }
function total() { return cart.reduce((sum,p) => sum + discountedPrice(p)*p.quantity,0); }
function productImage(p){return p.image||'/product-images/default.svg';}
function productThumbnail(p, className=''){return `<img class="product-picture ${className}" src="${esc(productImage(p))}" alt="${esc(p.name)}" loading="lazy">`;}
function stockLimit(p){return products.find(product=>product.id===p.id)?.stock ?? 0;}
function add(id) { const p=products.find(p=>p.id===id);if(!p||busy)return;const existing=cart.find(item=>item.id===id);if((existing?.quantity||0)>=p.stock)return toast(t("No more stock available."));if(existing)existing.quantity++;else cart.push({...p,quantity:1});renderCart(); }

const titles = {checkout:['Checkout','Scan a product. Make a sale. Keep things moving.'], products:['Products','Your catalog, ready for every sale.'], sales:['Sales history','Every transaction, all in one place.'],statistics:['Statistics','A clear picture of how business is going.'],designer:['Receipt designer','Make every receipt your own.'],'barcode-designer':['Barcode designer','Design product labels with a live preview.']};
async function navigate(view) {
  currentView = view; history.replaceState(null,'', '#'+view); document.querySelectorAll('nav button').forEach(b => b.classList.toggle('active',b.dataset.view===view));
  $('#page-title').textContent=t(titles[view][0]); $('#page-subtitle').textContent=t(titles[view][1]);
  try { if (view==='checkout') renderCheckout(); if(view==='products') renderProducts(); if(view==='sales') await renderSales(); if(view==='statistics') await renderStats(); if(view==='designer'||view==='barcode-designer'){activateDesigner(view);renderReceiptDesigner();} } catch(e) { toast(t(e.message)); }
}
function renderCheckout() {
  $('#view').innerHTML = `<div class="checkout-grid"><section class="catalog"><div class="section-heading"><h2>${t("Product catalog")} <span class="count">${products.length}</span></h2><button class="text-button" id="quick-add">+ ${t("Add product")}</button></div><div class="scan-box"><span>⌕</span><input id="scan" autocomplete="off" placeholder="${t("Scan barcode or search products…")}" aria-label="${t("Scan barcode or search products")}"><kbd>ENTER ↵</kbd></div><div class="catalog-note">${t("SCANNER READY")} <span>·</span> ${t("Scan a barcode and press Enter to add")}</div><div id="product-grid" class="product-grid"></div></section><section class="basket panel"><div class="section-heading"><h2>${t("Current sale")}</h2><button class="text-button muted" id="clear-cart">${t("Clear")}</button></div><div id="cart"></div><div class="checkout-footer"><label>${t("Discount (%)")}<input id="sale-discount" type="number" min="0" max="100" step="0.01" value="${discountPercent}"><small>${t("Applies to all products")}</small></label><div class="total"><span>${t("Total")}</span><strong id="total"></strong></div><label>${t("Payment method")}<select id="payment"><option value="Cash">${t("Cash")}</option><option value="Card">${t("Card")}</option><option value="Other">${t("Other")}</option></select></label><label id="cash-label">${t("Cash received (TMT)")}<input id="tendered" type="number" min="0" step="0.01" placeholder="0.00"></label><div id="change" class="change"></div><button id="complete" class="primary full">${t("Complete sale")} <span>→</span></button><p class="secure-note">${t("Saved locally · No internet needed")}</p></div></section></div>`;
  $('#sale-discount').oninput=()=>{
    if(busy)return;
    const input=$('#sale-discount');input.setCustomValidity('');
    const value=Number(input.value);
    if(input.value.trim()===''||!Number.isFinite(value)||!input.validity.valid){input.setCustomValidity(t('Enter a discount from 0 to 100%.'));renderCart();return;}
    discountPercent=value;renderCart();
  };
  $('#quick-add').onclick=()=>editProduct(); $('#clear-cart').onclick=()=>{if(busy)return;cart=[];discountPercent=0;$('#sale-discount').value='0';renderCart();};
  $('#scan').oninput=()=>renderGrid($('#scan').value); $('#scan').onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();const query=e.target.value.trim().toUpperCase(); const p=products.find(p=>p.barcode===query);if(p){add(p.id);e.target.value='';renderGrid();}else toast(t("Barcode not found. Add the product to your catalog first."));}};
  $('#payment').onchange=()=>{ $('#cash-label').hidden=$('#payment').value!=='Cash';updateChange();};$('#tendered').oninput=updateChange;$('#complete').onclick=checkout;
  renderGrid();renderCart();$('#scan').focus();
}
function renderGrid(query='') {
  const filtered=products.filter(p=>`${p.name} ${p.barcode}`.toLowerCase().includes(query.toLowerCase()));
  $('#product-grid').innerHTML=filtered.length?filtered.map((p,i)=>`<button class="product-card" data-id="${p.id}" ${p.stock===0?'disabled':''}><div class="product-art color-${p.id%4}">${productThumbnail(p)}<b>+</b></div><div class="product-info"><h3>${esc(p.name)}</h3><small>${esc(p.barcode)}</small><strong>${money(p.price)}</strong><div class="stock-count">${t("Available")}: ${p.stock} ${p.stock===0?`· ${t("Out of stock")}`:''}</div></div></button>`).join(''):`<div class="empty catalog-empty"><div class="empty-icon">▤</div><h3>${products.length?t("No matching products"):t("Start with your first product")}</h3><p>${products.length?t("Try another name or barcode."):t("Add a name, price and barcode to begin selling.")}</p><button class="secondary" id="empty-add">+ ${t("Add product")}</button></div>`;
  document.querySelectorAll('.product-card').forEach(b=>b.onclick=()=>add(Number(b.dataset.id))); if($('#empty-add'))$('#empty-add').onclick=()=>editProduct();
}
function renderCart() {
  if(!$('#cart'))return;
  $('#cart').innerHTML=cart.length?cart.map(p=>`<div class="cart-line">${productThumbnail(p,'basket-thumb')}<div class="cart-product-details"><h3>${esc(p.name)}</h3><small class="cart-unit-price">${money(discountedPrice(p))} ${t("each")}</small><div class="quantity"><button data-id="${p.id}" data-delta="-1" aria-label="${t("Decrease quantity")}">−</button><input class="cart-quantity" data-id="${p.id}" type="number" min="1" max="${stockLimit(p)}" step="1" value="${p.quantity}" aria-label="${t("Quantity")}"><button data-id="${p.id}" data-delta="1" ${p.quantity>=stockLimit(p)?'disabled':''} aria-label="${t("Increase quantity")}">+</button></div><small class="stock-count">${t("Available")}: ${stockLimit(p)} · ${t("Remaining after sale")}: ${Math.max(0,stockLimit(p)-p.quantity)}</small></div><div class="line-right"><strong>${money(discountedPrice(p)*p.quantity)}</strong><button class="text-button muted remove" data-id="${p.id}">${t("Remove")}</button></div></div>`).join(''):`<div class="empty basket-empty"><div class="empty-icon">▧</div><h3>${t("Your basket is empty")}</h3><p>${t("Scan a barcode or select a product")}<br>${t("to start a new sale.")}</p></div>`;
  document.querySelectorAll('.quantity button').forEach(b=>b.onclick=()=>{const p=cart.find(p=>p.id===Number(b.dataset.id));if(busy)return;p.quantity=Math.min(stockLimit(p),p.quantity+Number(b.dataset.delta));cart=cart.filter(p=>p.quantity>0);renderCart();});
  document.querySelectorAll('.cart-quantity').forEach(input=>input.onchange=()=>{const p=cart.find(p=>p.id===Number(input.dataset.id));if(busy)return renderCart();const quantity=Number(input.value);p.quantity=Number.isInteger(quantity)?Math.max(1,Math.min(stockLimit(p),quantity)):p.quantity;renderCart();});
  document.querySelectorAll('.remove').forEach(b=>b.onclick=()=>{cart=cart.filter(p=>p.id!==Number(b.dataset.id));renderCart();});
  $('#total').innerHTML=money(total());$('#sale-discount').disabled=busy;$('#complete').disabled=!cart.length||busy||!$('#sale-discount').checkValidity()||cart.some(p=>p.quantity>stockLimit(p));updateChange();
}
function updateChange() { if(!$('#change'))return;const amount=Number($('#tendered').value);$('#change').innerHTML=$('#payment').value==='Cash'&&Number.isFinite(amount)&&amount*100>=total()&&cart.length?`${t("Change")} <strong>${money(Math.round(amount*100)-total())}</strong>`:''; }
async function checkout() {
  if(busy||!cart.length||!$('#sale-discount').reportValidity())return;busy=true;$('#complete').disabled=true;$('#sale-discount').disabled=true;
  try {lastReceipt=await api('sales',{items:cart.map(p=>({id:p.id,quantity:p.quantity,price:p.price})),discount_percent:discountPercent,payment:$('#payment').value,tendered:$('#tendered').value||'0'});for(const p of products)if(Object.hasOwn(lastReceipt.remaining_stock,p.id))p.stock=lastReceipt.remaining_stock[p.id];cart=[];discountPercent=0;$('#sale-discount').value='0';renderGrid($('#scan').value);$('#tendered').value='';renderCart();showReceipt(lastReceipt);toast(t("Sale saved successfully."));}catch(e){toast(t(e.message));try{products=await api('products');renderGrid($('#scan').value);}catch{}}finally{busy=false;renderCart();}
}
function renderProducts() {
  $('#view').innerHTML=`<section class="panel"><div class="section-heading"><h2>${t("All products")} <span class="count">${products.length}</span></h2><button class="primary" id="add-product">+ ${t("Add product")}</button></div><input class="table-search" id="product-search" placeholder="${t("Search product name or barcode")}" aria-label="${t("Search products")}"><div class="table-wrap"><table><thead><tr><th>${t("Product")}</th><th>${t("Barcode")}</th><th>${t("Price")}</th><th>${t("Available quantity")}</th><th class="align-right">${t("Actions")}</th></tr></thead><tbody id="product-rows"></tbody></table></div></section>`;
  $('#add-product').onclick=()=>editProduct();$('#product-search').oninput=renderProductRows;renderProductRows();
}
function renderProductRows(){const query=$('#product-search').value.toLowerCase();$('#product-rows').innerHTML=products.filter(p=>`${p.name} ${p.barcode}`.toLowerCase().includes(query)).map(p=>`<tr><td><button class="product-cell product-history-link" data-action="history" data-id="${p.id}" aria-label="${esc(t('View history for {name}',{name:p.name}))}">${productThumbnail(p,'product-thumb')}<strong>${esc(p.name)}</strong><span class="history-chevron">↗</span></button></td><td><code>${esc(p.barcode)}</code></td><td>${money(p.price)}</td><td>${p.stock}</td><td class="actions"><button data-action="label" data-id="${p.id}">${t("Print barcode")}</button><button data-action="edit" data-id="${p.id}">${t("Edit")}</button><button data-action="archive" data-id="${p.id}" aria-label="${t("Archive")} ${esc(p.name)}">×</button></td></tr>`).join('')||`<tr><td colspan="5" class="empty-cell">${t("No products yet. Add your first product to get started.")}</td></tr>`;document.querySelectorAll('[data-action]').forEach(b=>b.onclick=async()=>{const p=products.find(p=>p.id===Number(b.dataset.id));if(b.dataset.action==='history')await showProductHistory(p.id);if(b.dataset.action==='edit')editProduct(p);if(b.dataset.action==='label')printLabel(p);if(b.dataset.action==='archive'&&confirm(t('Archive {name}? Existing sales will remain in history.', {name:p.name}))){try{await api('products/archive',{id:p.id});products=await api('products');cart=cart.filter(item=>item.id!==p.id);renderProducts();}catch(e){toast(t(e.message));}}});}
async function showProductHistory(id){
  const dialog=$('#product-history-dialog');const content=$('#product-history-content');
  content.innerHTML=`<p class="muted">${t("Loading product history…")}</p>`;dialog.showModal();
  try{
    const p=await api(`products/${id}`);if(!dialog.open)return;
    content.innerHTML=`<div class="history-product">${productThumbnail(p,'history-picture')}<div><h2>${esc(p.name)}</h2><code>${esc(p.barcode)}</code></div></div>
    <div class="history-metrics">${[[t('Current price'),money(p.price)],[t('Available quantity'),p.stock],[t('Units sold'),p.units_sold],[t('Revenue'),money(p.sales_revenue)]].map(([label,value])=>`<div><small>${label}</small><strong>${value}</strong></div>`).join('')}</div>
    <div class="product-history-grid"><section><h3>${t('Price history')} <span class="count">${p.price_history.length}</span></h3><p class="history-note">${t('Price changes are tracked from now. Earlier changes were not recorded.')}</p>
    <ol class="price-timeline">${p.price_history.map(h=>`<li><div class="price-event"><strong>${h.old_price===null?money(h.new_price):`${money(h.old_price)} <span class="price-arrow">→</span> ${money(h.new_price)}`}</strong><span class="price-kind">${t(h.source==='change'?'Price changed':h.source==='initial'?'Initial price':'Tracking started')}</span></div><time>${esc(dateText(h.changed_at,true))}</time></li>`).join('')||`<li>${t('No price history yet.')}</li>`}</ol></section>
    <section><h3>${t('Sales log')} <span class="count">${p.sales.length}</span></h3><p class="history-note">${t('Completed sales, newest first.')}</p><div class="table-wrap"><table class="product-sales-log"><thead><tr><th>${t('Date & time')}</th><th>${t('Receipt')}</th><th>${t('Quantity')}</th><th>${t('Unit price')}</th><th>${t('Total')}</th></tr></thead><tbody>${p.sales.map(row=>`<tr><td>${esc(dateText(row.created_at,true))}</td><td><button class="history-receipt text-button" data-id="${row.sale_id}">#${String(row.sale_id).padStart(6,'0')}</button></td><td><strong>${row.quantity}</strong></td><td>${money(row.price)}</td><td>${money(row.total)}</td></tr>`).join('')||`<tr><td colspan="5" class="empty-cell">${t('No sales for this product yet.')}</td></tr>`}</tbody></table></div></section></div><section class="stock-history-section"><h3>${t('Quantity history')} <span class="count">${p.stock_history.length}</span></h3><p class="history-note">${t('Stock changes and sales, newest first.')}</p><div class="table-wrap"><table><thead><tr><th>${t('Date & time')}</th><th>${t('Quantity')}</th><th>${t('Description')}</th><th>${t('Available quantity')}</th></tr></thead><tbody>${p.stock_history.map(h=>`<tr><td>${esc(dateText(h.changed_at,true))}</td><td><strong class="${h.delta>0?'stock-positive':'stock-negative'}">${h.delta>0?'+':'−'}${Math.abs(h.delta)}</strong></td><td>${h.sale_id?`${t('Sale')} <button class="history-receipt text-button" data-id="${h.sale_id}">#${String(h.sale_id).padStart(6,'0')}</button>`:esc(h.description||t(h.delta>0?'Quantity added':'Quantity removed'))}</td><td>${h.remaining??'—'}</td></tr>`).join('')||`<tr><td colspan="4" class="empty-cell">${t('No quantity changes yet.')}</td></tr>`}</tbody></table></div></section>`;
    content.querySelectorAll('.history-receipt').forEach(button=>button.onclick=async()=>{try{const sale=await api(`sales/${button.dataset.id}`);dialog.close();showReceipt(sale);}catch(error){toast(t(error.message));}});
  }catch(error){content.innerHTML=`<p class="error">${esc(t(error.message))}</p>`;}
}
let stockDirection = null;
function editProduct(p) {const f=$('#product-form');f.reset();stockDirection=null;f.elements.stock.readOnly=!!p;$('#stock-edit-controls').hidden=!p;$('#stock-adjustment-fields').hidden=true;f.elements.adjustment_quantity.required=false;document.querySelectorAll('[data-stock-direction]').forEach(b=>b.classList.remove('selected'));f.elements.id.value=p?.id||'';f.elements.image.value=p?.image||'';$('#product-image-preview').src=productImage(p||{});$('#product-image-preview').alt=p?.name||t('Product picture');if(p){f.elements.name.value=p.name;f.elements.barcode.value=p.barcode;f.elements.price.value=(p.price/100).toFixed(2);f.elements.stock.value=p.stock;}$('#product-title').textContent=p?t("Edit product"):t("Add product");$('#product-error').textContent='';$('#product-dialog').showModal();}
document.querySelectorAll('[data-stock-direction]').forEach(button=>button.onclick=()=>{
  stockDirection=button.dataset.stockDirection;
  $('#stock-adjustment-fields').hidden=false;
  $('#stock-adjustment-title').textContent=t(stockDirection==='add'?'Quantity to add':'Quantity to remove');
  const form=$('#product-form');form.elements.adjustment_quantity.required=true;
  form.elements.adjustment_quantity.max=stockDirection==='remove'?form.elements.stock.value:1000000-Number(form.elements.stock.value);
  document.querySelectorAll('[data-stock-direction]').forEach(b=>b.classList.toggle('selected',b===button));
  form.elements.adjustment_quantity.focus();
});
$('#cancel-stock-adjustment').onclick=()=>{stockDirection=null;$('#stock-adjustment-fields').hidden=true;const f=$('#product-form');f.elements.adjustment_quantity.required=false;f.elements.adjustment_quantity.value='';f.elements.stock_description.value='';document.querySelectorAll('[data-stock-direction]').forEach(b=>b.classList.remove('selected'));};
$('#product-image-file').onchange=async event=>{
  const file=event.target.files[0];if(!file)return;
  const form=$('#product-form');const save=form.querySelector('.primary');save.disabled=true;
  try{
    if(!['image/png','image/jpeg','image/webp'].includes(file.type)||file.size>400000)throw new Error(t('Use a PNG, JPEG or WebP picture smaller than 400 KB.'));
    const data=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error(t('Invalid product picture.')));reader.readAsDataURL(file);});
    const probe=new Image();probe.src=data;await probe.decode();
    form.elements.image.value=data;$('#product-image-preview').src=data;$('#product-error').textContent='';
  }catch(error){$('#product-error').textContent=t(error.message);event.target.value='';}
  finally{save.disabled=false;}
};
$('#remove-product-image').onclick=()=>{$('#product-form').elements.image.value='';$('#product-image-file').value='';$('#product-image-preview').src='/product-images/default.svg';};
$('#generate-barcode').onclick=()=>{$('#product-form').elements.barcode.value=String(Date.now());};
$('#product-form').onsubmit=async e=>{e.preventDefault();const f=e.target;const button=f.querySelector('.primary');button.disabled=true;try{await api('products',{id:f.elements.id.value?Number(f.elements.id.value):undefined,name:f.elements.name.value,barcode:f.elements.barcode.value,price:f.elements.price.value,stock:Number(f.elements.stock.value),stock_adjustment:stockDirection?{direction:stockDirection,quantity:Number(f.elements.adjustment_quantity.value),description:f.elements.stock_description.value}:undefined,image:f.elements.image.value});products=await api('products');cart=cart.map(item=>({...item,...products.find(p=>p.id===item.id)}));$('#product-dialog').close();navigate(currentView);toast(t("Product saved."));}catch(e){$('#product-error').textContent=t(e.message);}finally{button.disabled=false;}};
async function renderSales() {const sales=await api('sales');if(currentView!=='sales')return;$('#view').innerHTML=`<section class="panel"><div class="section-heading"><h2>${t("Transactions")} <span class="count">${sales.length}</span></h2><span class="muted">${t("Click a receipt to view or reprint")}</span></div><div class="table-wrap"><table><thead><tr><th>${t("Receipt")}</th><th>${t("Date & time")}</th><th>${t("Payment")}</th><th>${t("Total")}</th><th></th></tr></thead><tbody>${sales.map(s=>`<tr><td><strong>#${String(s.id).padStart(6,'0')}</strong></td><td>${esc(dateText(s.created_at, true))}</td><td><span class="payment-tag">${esc(t(s.payment))}</span></td><td>${money(s.total)}</td><td><button class="secondary receipt-link" data-id="${s.id}">${t("View receipt")} ↗</button></td></tr>`).join('')||`<tr><td colspan="5" class="empty-cell">${t("Completed sales will appear here.")}</td></tr>`}</tbody></table></div></section>`;document.querySelectorAll('.receipt-link').forEach(b=>b.onclick=async()=>{try{showReceipt(await api(`sales/${b.dataset.id}`));}catch(e){toast(t(e.message));}});}
async function renderStats(start=day(),end=day()) {const data=await api(`stats?start=${start}&end=${end}`);if(currentView!=='statistics')return;const max=Math.max(...data.days.map(d=>d.revenue),1);$('#view').innerHTML=`<div class="stats-toolbar"><span class="muted">${t("Sales performance")}</span><div><label>${t("From")} <input id="stat-start" type="date" value="${esc(start)}"></label><label>${t("To")} <input id="stat-end" type="date" value="${esc(end)}"></label><button class="secondary" id="apply-range">${t("Apply")}</button></div></div><div class="metrics">${[[t("Revenue"),money(data.revenue)],[t("Completed sales"),data.sales],[t("Products sold"),data.units],[t("Average sale"),money(data.sales?Math.round(data.revenue/data.sales):0)]].map(([label,value])=>`<div class="panel metric"><small>${label}</small><strong>${value}</strong></div>`).join('')}</div><div class="stats-grid"><section class="panel"><h2>${t("Daily revenue")}</h2><div class="chart">${data.days.map(d=>`<div class="bar-row"><small>${esc(d.day)}</small><div><span style="width:${d.revenue/max*100}%"></span></div><strong>${money(d.revenue)}</strong></div>`).join('')||`<div class="empty"><h3>${t("No sales in this period")}</h3><p>${t("Choose another date range or complete your first sale.")}</p></div>`}</div></section><section class="panel"><h2>${t("Top products")}</h2><table><thead><tr><th>${t("Product")}</th><th>${t("Units")}</th><th>${t("Revenue")}</th></tr></thead><tbody>${data.top.map(p=>`<tr><td>${esc(p.name)}</td><td>${p.units}</td><td>${money(p.revenue)}</td></tr>`).join('')||`<tr><td colspan="3" class="empty-cell">${t("No sales to show.")}</td></tr>`}</tbody></table></section></div>`;$('#apply-range').onclick=()=>{const s=$('#stat-start').value,e=$('#stat-end').value;if(!s||!e||s>e)return toast(t("Choose a valid date range."));renderStats(s,e).catch(e=>toast(t(e.message)));};}
function receiptHTML(s){return renderReceipt(s, s.receipt_template || receiptTemplate);}
function showReceipt(s){lastReceipt=s;$('#receipt-preview').innerHTML=receiptHTML(s);$('#receipt-dialog').showModal();}
function printContent(html,paperWidth=80){return choosePrinter(html,paperWidth);}
async function executePrintContent(html,paperWidth=80,method='browser'){
  if(method==='bluetooth')return sendBluetoothReceipt(html,paperWidth);
  $('#print-area').innerHTML=html;
  let pageStyle=$('#receipt-print-style');
  if(!pageStyle){pageStyle=document.createElement('style');pageStyle.id='receipt-print-style';document.head.append(pageStyle);}
  pageStyle.textContent=`@media print { @page { size:auto; margin:0; } #print-area { width:${receiptPrintWidth(paperWidth)}mm; max-width:100%; } #print-area .receipt-v2 { width:100%; } }`;
  await document.fonts.ready;
  await Promise.allSettled([...$('#print-area').querySelectorAll('img')].map(img=>img.decode()));
  window.print();
}
function printReceipt(){if(lastReceipt)return printContent(receiptHTML(lastReceipt),(lastReceipt.receipt_template || receiptTemplate).paperWidth);}$('#print-receipt').onclick=printReceipt;
// Code 39: nine elements per character, alternating bars and spaces.
const alphabet='0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-. $/+%*';
const patterns=['nnnwwnwnn','wnnwnnnnw','nnwwnnnnw','wnwwnnnnn','nnnwwnnnw','wnnwwnnnn','nnwwwnnnn','nnnwnnwnw','wnnwnnwnn','nnwwnnwnn','wnnnnwnnw','nnwnnwnnw','wnwnnwnnn','nnnnwwnnw','wnnnwwnnn','nnwnwwnnn','nnnnnwwnw','wnnnnwwnn','nnwnnwwnn','nnnnwwwnn','wnnnnnnww','nnwnnnnww','wnwnnnnwn','nnnnwnnww','wnnnwnnwn','nnwnwnnwn','nnnnnnwww','wnnnnnwwn','nnwnnnwwn','nnnnwnwwn','wwnnnnnnw','nwwnnnnnw','wwwnnnnnn','nwnnwnnnw','wwnnwnnnn','nwwnwnnnn','nwnnnnwnw','wwnnnnwnn','nwwnnnwnn','nwnwnwnnn','nwnwnnnwn','nwnnnwnwn','nnnwnwnwn','nwnnwnwnn'];
function barcodeSVG(code){let x=12,bars='';for(const c of `*${code}*`){const pattern=patterns[alphabet.indexOf(c)];for(let i=0;i<9;i++){const width=pattern[i]==='w'?3:1;if(i%2===0)bars+=`<rect x="${x}" y="0" width="${width}" height="48"/>`;x+=width;}x++;}return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${x+12} 48" width="${(x+12)*0.25}mm" height="16mm" role="img" aria-label="${t("Barcode")} ${esc(code)}">${bars}</svg>`;}
function printLabel(p){if(p.barcode.length>18)return toast(t("This barcode is too long for a reliable 80 mm label. Use a generated barcode or a code of 18 characters or fewer."));printContent(renderBarcodeLabel(p,barcodeTemplate),barcodeTemplate.paperWidth);}
initializePrintOptions();
document.querySelectorAll('nav button').forEach(b=>b.onclick=()=>navigate(b.dataset.view));translateStatic();
$('#language').onchange=async e=>{
  const checkoutState = currentView==='checkout' ? {payment:$('#payment').value, tendered:$('#tendered').value, query:$('#scan').value} : null;
  const range = currentView==='statistics' && $('#stat-start') ? [$('#stat-start').value,$('#stat-end').value] : null;
  language=e.target.value;
  try { localStorage.setItem('counter-language',language); } catch {}
  translateStatic();
  await navigate(currentView);
  if(checkoutState && $('#payment')){
    $('#payment').value=checkoutState.payment; $('#tendered').value=checkoutState.tendered;
    $('#scan').value=checkoutState.query;
    $('#cash-label').hidden=checkoutState.payment!=='Cash'; renderGrid(checkoutState.query); updateChange();
  }
  if(range) await renderStats(...range);
};
Promise.all([api('products'),api('receipt-template'),api('print-settings'),api('barcode-template')]).then(([data,template,settings,labelTemplate])=>{products=data;receiptTemplate=template;barcodeTemplate=labelTemplate;designTemplate=template;printSettings=settings;const initial=location.hash.slice(1);navigate(Object.hasOwn(titles,initial)?initial:'checkout');}).catch(e=>{$('#view').innerHTML=`<div class="panel empty"><h2>${t("Could not connect to local storage")}</h2><p>${t("Keep the Python server running and reload this page.")}</p></div>`;toast(t(e.message));});
