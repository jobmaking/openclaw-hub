import { readBounded } from './artifact-zip.mjs?v=1';

const limits = { pdf: 24 * 1024 * 1024, xlsx: 8 * 1024 * 1024, docx: 2 * 1024 * 1024 };
const isMedia = kind => kind === 'image' || kind === 'video';
const ROWS_PER_VIEW = 60, COLS_PER_VIEW = 32;
const create = (tag, cls, text) => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
};
function button(text, label, run) {
  const b = create('button', 'av-control', text); b.type = 'button';
  b.setAttribute('aria-label',label); b.addEventListener('click',run);
  return b;
}
let current = null;
export function closePreview(restoreFocus = false) {
  const item = current;
  if (!item) return;
  current = null;
  item.controller.abort();
  item.dispose?.();
  item.dialog.close(); item.dialog.remove();
  if(restoreFocus){
    const opener=typeof item.opener==='function'?item.opener():item.opener;
    if(opener?.isConnected&&opener.getClientRects().length)opener.focus({preventScroll:true});
  }
}
export function closeMediaIfStale(sessionId, ids) {
  if(current?.mediaSelection&&(sessionId!==current.mediaSelection.sessionId||!ids.includes(current.mediaSelection.id)))closePreview(true);
}
function updateFrame(dialog) {
  const view = window.visualViewport;
  if (view && Math.abs(view.scale - 1) < .03) {
    dialog.style.setProperty('--av-height',Math.round(view.height)+'px');
    dialog.style.setProperty('--av-top',Math.round(view.offsetTop)+'px');
  }
}
function notice(item, text, error = false) {
  if (!item.active()) return;
  item.status.textContent = text;
  item.status.classList.toggle('av-error',error);
}
const kindName = kind => ({pdf:'PDF',docx:'Word',xlsx:'Excel',image:'Imagen',video:'Vídeo'})[kind];
const regionLabel = kind => ({pdf:'Página del PDF',docx:'Texto del Word',xlsx:'Celdas de la hoja',image:'Vista de la imagen',video:'Reproductor de vídeo'})[kind];
function newFrame(title, kind, link, filename, opener) {
  const controller = new AbortController();
  const dialog = create('dialog','av-dialog'); dialog.id='hub-artifact-viewer';
  if(isMedia(kind))dialog.classList.add('av-media-dialog');
  dialog.setAttribute('aria-labelledby','av-title');
  const header = create('header','av-header'), identity = create('div','av-identity');
  const name = create('h2',null,title); name.id='av-title'; name.title=title;
  identity.append(create('small','av-eyebrow',kindName(kind)+' · Solo lectura'),name);
  const download = create('a','av-control av-download','Descargar');
  download.href=link; download.download=filename; download.referrerPolicy='no-referrer'; download.setAttribute('aria-label','Descargar el original');
  const dismiss = button(isMedia(kind)?'← Chat':'×','Cerrar vista previa',()=>closePreview(true));
  dismiss.classList.add('av-close'); dismiss.autofocus=true;
  header.append(identity,download,dismiss);
  const tools=create('div','av-tools'); tools.hidden=true;
  const scroll=create('div','av-scroll'); scroll.tabIndex=0; scroll.setAttribute('role','region');
  scroll.setAttribute('aria-label',regionLabel(kind));
  const status = create('p','av-status'); status.setAttribute('role','status');
  dialog.append(header,tools,status,scroll);
  const item={controller,signal:controller.signal,dialog,download,tools,scroll,status,opener,active:()=>current===item,dispose:null};
  dialog.addEventListener('cancel',event=>{event.preventDefault();closePreview(true);});
  dialog.addEventListener('keydown',event=>{
    if(event.key==='Escape'&&!document.fullscreenElement){event.preventDefault();event.stopPropagation();closePreview(true);}
  });
  dialog.addEventListener('close',()=>{if(current===item)closePreview(true);});
  const frame = () => updateFrame(dialog);
  window.visualViewport?.addEventListener('resize',frame,{signal:controller.signal,passive:true});
  window.visualViewport?.addEventListener('scroll',frame,{signal:controller.signal,passive:true});
  document.body.append(dialog); current=item; frame(); dialog.showModal(); dismiss.focus({preventScroll:true});
  return item;
}

export async function openPreview(artifact, selection, kind, opener = document.activeElement, word = null) {
  if ((!isMedia(kind)&&!Object.hasOwn(limits,kind)) || !selection?.sessionId || typeof artifact?.id!=='string'||!artifact.id||artifact.id.length>1024) return;
  closePreview();
  const filename=String(artifact.fileName || artifact.title || ('archivo.'+kind)).slice(0,180);
  const query=new URLSearchParams({agent:selection.agent,key:selection.key,sessionId:selection.sessionId,id:artifact.id});
  const mediaLink=isMedia(kind)?'/api/artifact-media?'+query:null;
  if(mediaLink)query.delete('sessionId'); // Preserve the original download permission of Entregables.
  const link='/api/artifact-download?'+query;
  const item=newFrame(filename,kind,link,filename,opener);
  if(mediaLink){item.mediaSelection={id:artifact.id,sessionId:selection.sessionId};return showMedia(item,artifact,mediaLink,kind);}
  if(kind==='docx'&&word){showWord(item,word);return;}
  return renderFile(item,artifact,link,kind);
}

// The work inbox owns the navigation and authorization for each selection.
// Each render has its own cancellation scope, even though the shell is reused.
export function renderWorkFile(artifact, link, kind, parts, signal) {
  signal.throwIfAborted();
  if(!isMedia(kind)&&!Object.hasOwn(limits,kind))throw Error('Formato no disponible');
  const item={...parts,signal,fromWork:true,active:()=>!signal.aborted&&parts.scroll.isConnected};
  parts.scroll.setAttribute('aria-label',regionLabel(kind));
  signal.addEventListener('abort',()=>item.dispose?.(),{once:true});
  if(isMedia(kind)){
    const url=new URL(link,location.href);
    if(url.origin!==location.origin||url.pathname!=='/api/artifact-download'||!url.searchParams.get('sessionId'))throw Error('Archivo no disponible');
    return showMedia(item,artifact,'/api/artifact-media'+url.search,kind);
  }
  return renderFile(item,artifact,link,kind);
}

function showMedia(item,artifact,link,kind){
  const {signal}=item, video=kind==='video';
  const title=artifact.fileName||artifact.title||kindName(kind);
  const limit=(video?128:24)*1048576;
  if(Number.isSafeInteger(artifact.sizeBytes)&&artifact.sizeBytes>limit){
    notice(item,'El archivo supera el tamaño de la vista previa. Puedes descargar el original.',true);return;
  }
  const stage=create('div','av-media-stage'), element=create(video?'video':'img',video?'av-media-video':'av-media-image');
  const zoom=video?null:button('Ampliar','Ampliar imagen',()=>{
    const enlarged=stage.classList.toggle('av-media-zoom');
    zoom.setAttribute('aria-pressed',String(enlarged));zoom.textContent=enlarged?'Ajustar':'Ampliar';
    zoom.setAttribute('aria-label',enlarged?'Ajustar imagen':'Ampliar imagen');
    if(!enlarged)item.scroll.scrollTo(0,0);
  });
  let timer, failedOnce=false;
  item.dispose=()=>{
    clearTimeout(timer);
    if(video)element.pause();
    element.removeAttribute('src');
    if(video)element.load();
    stage.remove();
  };
  if(video){
    element.controls=true;element.playsInline=true;element.preload='metadata';
    element.disableRemotePlayback=true;element.disablePictureInPicture=true;
    element.setAttribute('controlslist','nodownload noremoteplayback');
    element.setAttribute('aria-label','Vídeo: '+title);
    document.addEventListener('visibilitychange',()=>{if(document.hidden)element.pause();},{signal});
  }else{
    element.alt=title;element.decoding='async';element.draggable=false;
  }
  element.addEventListener(video?'loadedmetadata':'load',()=>{
    if(!item.active())return;
    clearTimeout(timer);notice(item,'');
    if(zoom){
      zoom.setAttribute('aria-pressed','false');item.tools.append(zoom);item.tools.hidden=false;
      stage.style.setProperty('--av-image-width',Math.min(4096,Math.max(2*element.naturalWidth,2*item.scroll.clientWidth))+'px');
    }
  },{once:true,signal});
  async function failed(timedOut=false){
    if(!item.active()||failedOnce)return;
    failedOnce=true;
    item.dispose();if(zoom){zoom.remove();item.tools.hidden=true;}
    let unavailable=false, tooLarge=false;
    try{
      const probe=await fetch(link,{method:'HEAD',credentials:'same-origin',redirect:'error',cache:'no-store',signal:AbortSignal.any([signal,AbortSignal.timeout(5000)])});
      unavailable=[401,403,404,409].includes(probe.status);tooLarge=probe.status===413;
    }catch{}
    if(!item.active())return;
    if(unavailable){item.download.hidden=true;item.onUnavailable?.();}
    notice(item,unavailable?'Este archivo ya no está disponible en la conversación.':tooLarge?'El archivo supera el tamaño de la vista previa. Puedes descargar el original.':
      timedOut?'El archivo tardó demasiado en abrirse. Puedes descargar el original.':video?'No se pudo reproducir el vídeo. Puedes descargar el original.':
      'No se pudo mostrar la imagen. Puedes descargar el original.',true);
  }
  element.addEventListener('error',()=>void failed(),{once:true,signal});
  notice(item,video?'Cargando vídeo…':'Cargando imagen…');
  stage.append(element);item.scroll.replaceChildren(stage);
  timer=setTimeout(()=>void failed(true),30000);
  element.src=link;
}

async function renderFile(item, artifact, link, kind) {
  const signal=item.signal;
  notice(item,'Abriendo el archivo…');
  try {
    const maximum=limits[kind];
    const limitMessage='Este archivo es demasiado grande para la vista previa ('+(maximum/1048576)+' MB). Puedes descargar el original.';
    if(Number.isSafeInteger(artifact.sizeBytes)&&artifact.sizeBytes>maximum){notice(item,limitMessage,true);return;}
    const response=await fetch(link,{credentials:'same-origin',cache:'no-store',redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(40000)])});
    signal.throwIfAborted();
    if (!response.ok || response.status!==200) {
      await response.body?.cancel();
      if(!item.active())return;
      const unavailable=[401,403,404,409].includes(response.status);
      if(unavailable){item.download.hidden=true;item.onUnavailable?.();}
      notice(item,unavailable?'Este archivo ya no está disponible en la conversación.':'No se pudo cargar el archivo. Puedes probar a descargarlo.',true);return;
    }
    const size=response.headers.get('content-length');
    const length=size!==null && !response.headers.get('content-encoding') ? Number(size) : null;
    if (length>maximum) { await response.body?.cancel(); notice(item,limitMessage,true); return; }
    const data=await readBounded(response.body,maximum,length);
    signal.throwIfAborted();
    if (kind==='pdf') {
      const {openPdf}=await import('./artifact-pdf.mjs?v=1');
      const pdf=await openPdf(data,signal);
      if (!item.active()) { pdf.dispose();return; }
      item.dispose=pdf.dispose; showPdf(item,pdf);
    } else if(kind==='docx') {
      const {readWord}=await import('./artifact-word.mjs?v=1');
      const document=await readWord(data);if(item.active())showWord(item,document);
    } else {
      const {openWorkbook}=await import('./artifact-workbook.mjs?v=1');
      signal.throwIfAborted();
      const workbook=await openWorkbook(data);
      if (item.active()) showWorkbook(item,workbook);
    }
  } catch(error) {
    if(!item.active())return;
    const message=error?.name==='PasswordException'?'Este PDF está protegido. Descárgalo para abrirlo con su contraseña.':
      error?.name==='TimeoutError'?'El archivo tardó demasiado en abrirse. Puedes descargar el original.':
      'No se pudo mostrar este '+kindName(kind)+'. Puedes descargar el original.';
    notice(item,message,true);
  }
}

function showWord(item,word) {
  const paper=create('article','av-word');
  const add=(parent,blocks)=>{
    for(const b of blocks){
      if(b.kind==='paragraph'){
        const p=create(b.level?'h'+Math.min(6,b.level+1):'p',null,b.text);parent.append(p);
        if(b.pageNumber)p.append(create('span','av-word-page','Número de página'));
      }else{
        const wrap=create('div','av-word-table');wrap.tabIndex=0;wrap.setAttribute('aria-label','Tabla desplazable');
        const table=create('table'),body=table.createTBody();
        for(const row of b.rows){const tr=body.insertRow();for(const cell of row.cells){
          const td=create(row.header?'th':'td');if(row.header)td.scope='col';td.colSpan=cell.span;add(td,cell.items);tr.append(td);
        }}
        wrap.append(table);parent.append(wrap);
      }
    }
  };
  for(const note of word.notes.filter(x=>x.part==='header')){
    const el=create('header','av-word-part');el.append(create('strong',null,'Encabezado'));add(el,note.items);paper.append(el);
  }
  add(paper,word.content);
  for(const note of word.notes.filter(x=>x.part==='footer')){
    const el=create('footer','av-word-part');el.append(create('strong',null,'Pie de página'));add(el,note.items);paper.append(el);
  }
  item.scroll.replaceChildren(paper);
  notice(item,word.partial?'Vista parcial del texto. Para ver todos los elementos y el diseño, descarga el Word original.':
    item.fromWork?'Vista de lectura. Para ver el diseño original, descarga el Word.':'Este Word se abre en solo lectura porque tiene elementos que la copia editable no puede conservar.');
}

function showPdf(item, pdf) {
  let page=1, zoom=1, epoch=0, inFlight, width=0, renderedPage=0;
  const progress=create('span','av-position'); progress.setAttribute('aria-live','polite');
  const scale=create('span','av-position'); scale.setAttribute('aria-live','polite');
  const previous=button('‹','Página anterior',()=>{if(page>1){page--;draw(true);}});
  const next=button('›','Página siguiente',()=>{if(page<pdf.numPages){page++;draw(true);}});
  const less=button('−','Reducir zoom',()=>{if(zoom>1){zoom=Math.max(1,zoom-.25);draw();}});
  const more=button('+','Ampliar zoom',()=>{if(zoom<3){zoom=Math.min(3,zoom+.25);draw();}});
  const pages=create('div','av-group'), zoomControls=create('div','av-group');
  pages.setAttribute('role','group');pages.setAttribute('aria-label','Páginas');
  zoomControls.setAttribute('role','group');zoomControls.setAttribute('aria-label','Zoom');
  pages.append(previous,progress,next);zoomControls.append(less,scale,more);
  item.scroll.classList.add('av-pdf');item.tools.append(pages,zoomControls);item.tools.hidden=false;
  async function draw(reset=false) {
    if(!item.active())return;
    width=Math.max(50,item.scroll.clientWidth-24);
    const token=++epoch; inFlight?.abort(); inFlight=new AbortController();
    previous.disabled=page===1; next.disabled=page===pdf.numPages;
    less.disabled=zoom===1; more.disabled=zoom===3;
    progress.textContent=page+' / '+pdf.numPages; scale.textContent=Math.round(zoom*100)+' %';
    const ratioX=item.scroll.scrollLeft/Math.max(1,item.scroll.scrollWidth);
    const ratioY=item.scroll.scrollTop/Math.max(1,item.scroll.scrollHeight);
    if (page!==renderedPage) item.scroll.replaceChildren();
    notice(item,'Mostrando página '+page+'…');
    const renderSignal=AbortSignal.any([inFlight.signal,item.signal,AbortSignal.timeout(20000)]);
    try {
      const canvas=await pdf.render(page,width,zoom,renderSignal);
      if(!item.active()||token!==epoch||renderSignal.aborted){canvas.width=canvas.height=0;return;}
      item.scroll.replaceChildren(canvas); renderedPage=page;
      item.scroll.scrollLeft=reset?0:ratioX*item.scroll.scrollWidth;
      item.scroll.scrollTop=reset?0:ratioY*item.scroll.scrollHeight;
      notice(item,'');
    } catch(error) {
      if(!item.active()||token!==epoch)return;
      notice(item,'No se pudo mostrar esta página. Puedes cambiar de página o descargar el original.',true);
    }
  }
  let timer;
  const observer=new ResizeObserver(()=>{
    if(!width||Math.abs(width-(item.scroll.clientWidth-24))<3)return;
    clearTimeout(timer);timer=setTimeout(()=>draw(),120);
  });
  observer.observe(item.scroll);
  item.signal.addEventListener('abort',()=>{observer.disconnect();clearTimeout(timer);inFlight?.abort();},{once:true});
  void draw(true);
}

function columnName(n) {
  let label='';
  for (;n;n=Math.floor((n-1)/26))label=String.fromCharCode(65+(n-1)%26)+label;
  return label;
}
function showWorkbook(item, workbook) {
  const visible=workbook.sheets.map((sheet,index)=>({sheet,index})).filter(x=>x.sheet.visible!==false);
  if(!visible.length){notice(item,'El libro no tiene hojas visibles.',true);return;}
  const pick=create('select','av-control'); pick.setAttribute('aria-label','Hoja de Excel');
  for(const {sheet,index} of visible) { const opt=create('option',null,sheet.name); opt.value=String(index); pick.append(opt); }
  const rowPosition=create('span','av-position'), colPosition=create('span','av-position');
  const rowPrev=button('‹','Bloque de filas anterior',()=>{rowPage--;paint();});
  const rowNext=button('›','Bloque de filas siguiente',()=>{rowPage++;paint();});
  const colPrev=button('‹','Bloque de columnas anterior',()=>{colPage--;paint();});
  const colNext=button('›','Bloque de columnas siguiente',()=>{colPage++;paint();});
  const rowGroup=create('div','av-group'), colGroup=create('div','av-group');
  rowGroup.append(rowPrev,rowPosition,rowNext); colGroup.append(colPrev,colPosition,colNext);
  rowGroup.setAttribute('role','group');rowGroup.setAttribute('aria-label','Filas');
  colGroup.setAttribute('role','group');colGroup.setAttribute('aria-label','Columnas');
  item.tools.append(pick,rowGroup,colGroup);item.tools.hidden=false;
  let generation=0, sheet, rowPage=0, colPage=0, reading;
  function paint() {
    if(!item.active()||!sheet)return;
    const lastRow=sheet.lastRow,lastColumn=sheet.lastColumn;
    if(!lastRow||!lastColumn){rowGroup.hidden=colGroup.hidden=true;notice(item,sheet.limited?'No hay celdas visibles en el tramo disponible.':'Esta hoja no tiene celdas con contenido.');return;}
    rowPage=Math.max(0,Math.min(rowPage,Math.ceil(lastRow/ROWS_PER_VIEW)-1));
    colPage=Math.max(0,Math.min(colPage,Math.ceil(lastColumn/COLS_PER_VIEW)-1));
    const r0=1+rowPage*ROWS_PER_VIEW,c0=1+colPage*COLS_PER_VIEW;
    const r1=Math.min(r0+ROWS_PER_VIEW-1,lastRow),c1=Math.min(c0+COLS_PER_VIEW-1,lastColumn);
    rowGroup.hidden=lastRow<=ROWS_PER_VIEW;colGroup.hidden=lastColumn<=COLS_PER_VIEW;
    rowPrev.disabled=r0===1;rowNext.disabled=r1===lastRow;colPrev.disabled=c0===1;colNext.disabled=c1===lastColumn;
    rowPosition.textContent='Filas '+r0+'–'+r1;colPosition.textContent=columnName(c0)+'–'+columnName(c1);
    const table=create('table','av-grid');table.setAttribute('aria-label',pick.selectedOptions[0].textContent);
    const head=table.createTHead().insertRow(),first=create('th',null,'Fila');first.scope='col';head.append(first);
    for(let c=c0;c<=c1;c++){const th=create('th',null,columnName(c));th.scope='col';head.append(th);}
    const body=table.createTBody();
    for(let r=r0;r<=r1;r++){
      const tr=body.insertRow(), no=create('th',null,String(r)), values=sheet.rows.get(r);no.scope='row';tr.append(no);
      for(let c=c0;c<=c1;c++){const cell=tr.insertCell();cell.textContent=values?.get(c)??'';}
    }
    item.scroll.replaceChildren(table);item.scroll.scrollTo(0,0);
    notice(item,sheet.limited?'Vista parcial de esta hoja. Descarga el original para consultar todos los datos.':'');
  }
  async function select() {
    const token=++generation; reading?.abort(); reading=new AbortController();
    const signal=AbortSignal.any([reading.signal,item.signal]);
    sheet=null;rowPage=colPage=0;rowGroup.hidden=colGroup.hidden=true;item.scroll.replaceChildren();
    notice(item,'Leyendo la hoja…');
    try {
      const result=await workbook.readSheet(Number(pick.value),signal);
      if(item.active()&&token===generation){sheet=result;paint();}
    } catch {
      if(item.active()&&token===generation)notice(item,'No se pudo mostrar esta hoja. Puedes elegir otra o descargar el original.',true);
    }
  }
  pick.addEventListener('change',select);void select();
}
