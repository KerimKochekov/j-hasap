let printSettings = {method:'browser',deviceId:null,name:null,bluetoothAvailable:false};
let bluetoothPrinting = false;

let pendingPrint = null;
let printerCheckVersion = 0;
function choosePrinter(html,paperWidth){
  const dialog=$('#print-options-dialog');if(dialog.open)return;
  pendingPrint={html,paperWidth};
  $('#job-printer-method').value=printSettings.method;
  $('#job-printer-method').querySelector('[value="bluetooth"]').disabled=!printSettings.bluetoothAvailable;
  $('#job-printer-status').textContent='';
  dialog.showModal();updateJobPrinter();
}
function updateJobPrinter(){
  const bluetooth=$('#job-printer-method').value==='bluetooth';
  $('#job-printer-check').hidden=!bluetooth;
  $('#job-print-confirm').disabled=bluetooth;
  $('#job-printer-status').textContent=bluetooth?'':t('Choose your installed printer in the browser print dialog.');
  if(bluetooth)checkJobPrinter();
}
async function checkJobPrinter(){
  const version=++printerCheckVersion;
  const method=$('#job-printer-method');const check=$('#job-printer-check');const print=$('#job-print-confirm');
  method.disabled=true;check.disabled=true;print.disabled=true;
  $('#job-printer-status').textContent=t('Checking BT-802 connection…');
  try{
    const result=await api('bluetooth/connect',{});
    printSettings={...printSettings,deviceId:result.deviceId,name:result.name,bluetoothAvailable:result.bluetoothAvailable};
    if(version!==printerCheckVersion||!$('#print-options-dialog').open)return;
    $('#job-printer-status').textContent=result.status===null||result.paperStatus===null?t('BT-802 connected. Paper status is unavailable; check its roll and cover.'):t('BT-802 connected. No cover or paper fault reported.');
    print.disabled=false;
  }catch(error){if(version===printerCheckVersion&&$('#print-options-dialog').open)$('#job-printer-status').textContent=t(error.message==='TimeoutError'?'BT-802 did not respond. Turn it on and check its Bluetooth connection.':error.message);}
  finally{if(version===printerCheckVersion){method.disabled=false;check.disabled=false;}}
}
function initializePrintOptions(){
  const dialog=$('#print-options-dialog');
  $('#job-printer-method').onchange=updateJobPrinter;
  $('#job-printer-check').onclick=checkJobPrinter;
  dialog.addEventListener('close',()=>{pendingPrint=null;printerCheckVersion++;$('#job-printer-method').disabled=false;$('#job-printer-check').disabled=false;});
  $('#job-print-confirm').onclick=async()=>{
    if(!pendingPrint)return;
    const job=pendingPrint;const method=$('#job-printer-method').value;
    $('#job-print-confirm').disabled=true;
    try{
      printSettings=await api('print-settings',{method});
      if(!dialog.open||pendingPrint!==job)return;
      dialog.close();
      await executePrintContent(job.html,job.paperWidth,method);
    }catch(error){$('#job-printer-status').textContent=t(error.message);$('#job-print-confirm').disabled=false;}
  };
}

function monochromeRaster(canvas) {
  const width=canvas.width, height=canvas.height;
  if(![384,576].includes(width)||height<1||height>8000)throw new Error(t('The receipt is too long for Bluetooth printing. Use browser printing.'));
  const pixels=canvas.getContext('2d').getImageData(0,0,width,height).data;
  const packed=new Uint8Array(width/8*height);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const offset=(y*width+x)*4, alpha=pixels[offset+3]/255;
    const luminance=(.299*pixels[offset]+.587*pixels[offset+1]+.114*pixels[offset+2])*alpha+255*(1-alpha);
    if(luminance<170)packed[y*(width/8)+(x>>3)]|=0x80>>(x&7);
  }
  let binary='';
  for(let offset=0;offset<packed.length;offset+=8192)binary+=String.fromCharCode(...packed.subarray(offset,offset+8192));
  return {width,height,data:btoa(binary)};
}

function drawThermalAmount(ctx,text,box,fontSize) {
  // Draw each glyph on integer dots with the same advance. Fractional bitmap
  // scaling can otherwise give identical digits different thresholded shapes.
  ctx.save();
  ctx.fillStyle='#fff';ctx.fillRect(Math.floor(box.x),Math.floor(box.y),Math.ceil(box.width)+1,Math.ceil(box.height)+1);
  ctx.fillStyle='#000';ctx.font=`400 ${Math.round(fontSize)}px "Courier New", monospace`;
  ctx.textAlign='left';ctx.textBaseline='middle';
  const advance=Math.ceil(ctx.measureText('0').width);
  const x=Math.round(box.x+box.width)-advance*text.length;
  const y=Math.round(box.y+box.height/2);
  for(let i=0;i<text.length;i++)ctx.fillText(text[i],x+i*advance,y);
  ctx.restore();
}

async function receiptRaster(html,paperWidth) {
  const width=paperWidth===58?384:576;
  const holder=document.createElement('div');
  holder.className='bluetooth-render';
  // Render at 96 CSS dpi, then scale to 203 printer dpi. 80 mm rolls have a 72 mm print head.
  holder.style.width=`${width/8}mm`;
  holder.innerHTML=html;
  document.body.append(holder);
  try{
    const receipt=holder.querySelector('.receipt-v2');
    if(receipt){receipt.style.width='100%';receipt.style.maxWidth='none';}
    const label=holder.querySelector('.barcode-label');if(label)label.style.width='100%';
    await document.fonts.ready;
    await Promise.all([...holder.querySelectorAll('img')].map(img=>img.decode()));
    const bounds=holder.getBoundingClientRect();
    if(bounds.height*width/bounds.width>8000)throw new Error(t('The receipt is too long for Bluetooth printing. Use browser printing.'));
    const rendered=await html2canvas(holder,{backgroundColor:'#ffffff',scale:width/bounds.width,logging:false,useCORS:false});
    const canvas=document.createElement('canvas');canvas.width=width;canvas.height=rendered.height;
    const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,width,canvas.height);ctx.drawImage(rendered,0,0);
    const scale=width/bounds.width;
    for(const element of holder.querySelectorAll('[data-print-amount]')){
      const rect=element.getBoundingClientRect();
      drawThermalAmount(ctx,element.textContent.trim(),{x:(rect.left-bounds.left)*scale,y:(rect.top-bounds.top)*scale,width:rect.width*scale,height:rect.height*scale},parseFloat(getComputedStyle(element).fontSize)*scale);
    }
    return {canvas,raster:monochromeRaster(canvas)};
  }finally{holder.remove();}
}

async function sendBluetoothReceipt(html,paperWidth) {
  if(bluetoothPrinting)return toast(t('The Bluetooth printer is busy. Please wait.'));
  bluetoothPrinting=true;
  const buttons=[...document.querySelectorAll('#print-receipt,#design-test,[data-action="label"]')];
  const disabled=buttons.map(button=>button.disabled);buttons.forEach(button=>button.disabled=true);
  try{
    toast(t('Sending receipt to BT-802…'));
    const {raster}=await receiptRaster(html,paperWidth);
    await api('bluetooth/print',raster);
    toast(t('Receipt sent to BT-802. Check the printed paper.'));
  }catch(error){toast(t(error.message));}
  finally{bluetoothPrinting=false;buttons.forEach((button,index)=>button.disabled=disabled[index]);}
}

function renderBluetoothControls() {
  const panel=$('#bluetooth-controls');if(!panel)return;
  panel.innerHTML=`<label>${t('Printing method')}<select id="printer-method"><option value="browser">${t('Browser / installed printer')}</option><option value="bluetooth" ${!printSettings.bluetoothAvailable||!printSettings.deviceId?'disabled':''}>BT-802 Bluetooth</option></select></label><p class="designer-hint">${t('Bluetooth prints directly. The BT-802 does not need to appear in the system printer list.')}</p><p class="printer-ok" id="bluetooth-status">${printSettings.name?esc(printSettings.name):''}</p><button class="check-printer" id="connect-bluetooth" ${!printSettings.bluetoothAvailable?'disabled':''}>${t('Connect BT-802')}</button><button class="check-printer" id="test-bluetooth" ${!printSettings.deviceId||!printSettings.bluetoothAvailable?'disabled':''}>${t('Print Bluetooth test')}</button>`;
  $('#printer-method').value=printSettings.method;
  if(printSettings.bluetoothPrintError){
    const warning=document.createElement('p');warning.className='designer-hint';
    warning.textContent=printSettings.bluetoothPrintError;panel.append(warning);
  }
  $('#printer-method').onchange=async event=>{
    const select=event.target;select.disabled=true;
    try{printSettings=await api('print-settings',{method:select.value});toast(t('Printing method saved.'));}
    catch(error){select.value=printSettings.method;toast(t(error.message));}
    finally{select.disabled=false;}
  };
  $('#connect-bluetooth').onclick=async event=>{
    event.target.disabled=true;$('#bluetooth-status').textContent=t('Connecting to BT-802…');
    try{printSettings=await api('bluetooth/connect',{});renderBluetoothControls();toast(t('BT-802 connected. Select Bluetooth as the printing method.'));}
    catch(error){if($('#bluetooth-status'))$('#bluetooth-status').textContent=t(error.message);}
    finally{if($('#connect-bluetooth'))$('#connect-bluetooth').disabled=!printSettings.bluetoothAvailable;}
  };
  $('#test-bluetooth').onclick=async event=>{
    event.target.disabled=true;
    try{await api('bluetooth/test',{});toast(t('Test sent. Check for a slip marked BT-802 POS TEST.'));}
    catch(error){toast(t(error.message));}
    finally{if($('#test-bluetooth'))$('#test-bluetooth').disabled=false;}
  };
}
