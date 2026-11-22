'use strict';
(() => {
  if (window.HubDocuments) return;
  const app=document.getElementById('app'), hub=document.getElementById('main'), head=document.querySelector('#chat-header .header-right');
  const composer=window.HubComposer;
  // Older pages must reload rather than mixing the editor with stale shared assets.
  if (!app || !hub || !head || !composer) return;
  const $=id=>document.getElementById(id);
  const make=(tag, cls, value)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(value!==undefined)e.textContent=value;return e;};
  const button=(label,fn,cls='')=>{const b=make('button',cls,label);b.type='button';b.addEventListener('click',fn);return b;};
  const uid=()=>crypto.randomUUID?.() || Array.from(crypto.getRandomValues(new Uint8Array(16)),n=>n.toString(16).padStart(2,'0')).join('');
  const kinds={paragraph:'Párrafo',heading:'Título de sección',bullet:'Viñeta',number:'Paso numerado',quote:'Cita'};
  const formats={pdf:'PDF',docx:'Word',md:'Markdown'};
  const state={scope:null, key:'', owner:null, opened:false, serial:0, list:[], records:new Map(), active:null, mode:'list', opener:null, loading:false, ready:false, notice:'', width:.56};
  let saveTimer, pollTimer, openChange, composition=false, selected=null, rendered=null, viewport, endNotice, changed, discardTarget=null;
  let requests=new Set(), selectionRequest=0;
  const current=()=>state.records.get(state.active);
  const unconfirmed=r=>Boolean(r?.dirty||r?.inflight||r?.conflict);
  let refreshOnClose=false;
  const scopeKey=c=>c?.enabled && c.user && c.agent && c.key && c.sessionId ? JSON.stringify([c.user,c.agent,c.key,c.sessionId]) : '';
  const active=(serial,r)=>serial===state.serial && state.scope && (!r || state.records.get(r.id)===r);
  const mobile=matchMedia('(max-width: 850px), (pointer: coarse) and (max-width: 1024px)');
  const trigger=button('',()=>state.opened?close():open(),'hd-trigger');
  trigger.id='hub-documents-trigger';trigger.title='Documentos';trigger.setAttribute('aria-label','Documentos');trigger.setAttribute('aria-controls','hub-documents');trigger.hidden=true;
  const icon=document.createElementNS('http://www.w3.org/2000/svg','svg');icon.setAttribute('viewBox','0 0 24 24');icon.setAttribute('aria-hidden','true');const svg=document.createElementNS(icon.namespaceURI,'path');svg.setAttribute('d','M6 3h8l4 4v14H6z M14 3v5h4 M9 12h6 M9 16h6');icon.append(svg);trigger.append(icon,make('span',null,'Documentos'));
  const split=make('div','hd-divider');split.hidden=true;split.tabIndex=0;split.setAttribute('role','separator');split.setAttribute('aria-label','Ancho del documento');split.setAttribute('aria-orientation','vertical');split.setAttribute('aria-valuemin','46');split.setAttribute('aria-valuemax','68');
  const panel=make('section','hd-panel');panel.id='hub-documents';panel.setAttribute('aria-labelledby','hd-label');panel.hidden=true;
  const top=make('header','hd-top'), identity=make('div','hd-identity'), label=make('strong',null,'Documentos'), status=make('span','hd-status'), actions=make('div','hd-actions');
  label.id='hd-label';label.tabIndex=-1;status.setAttribute('role','status');identity.append(label,status);
  const closing=button('← Chat',()=>close(),'hd-back');closing.title='Volver al chat';closing.setAttribute('aria-label',closing.title);
  const index=button('',()=>browse(),'hd-index');index.setAttribute('aria-label','Lista de documentos');index.title='Lista de documentos';index.append(make('i','hd-list-icon','☰'),make('span',null,'Documentos'));index.firstElementChild.setAttribute('aria-hidden','true');
  const history=button('Historial',()=>section(state.mode==='history'?'editor':'history'),'hd-history');
  const deliver=button('Exportar',()=>section(state.mode==='export'?'editor':'export'),'hd-primary hd-export');
  actions.append(index,history,deliver);top.append(closing,identity,actions);
  const draftBar=make('div','hd-draft-bar'), draftHint=make('span','hd-draft-hint');
  const cancelDraft=button('Cancelar',requestDiscard,'hd-cancel-draft');
  const saveControl=button('',()=>{
    const r=current();if(!state.opened||state.mode!=='editor'||!r||composition||r.inflight)return;
    if(r.doc)void flush(r);else void create(r);
  },'hd-save');saveControl.id='hd-save';
  draftBar.hidden=true;draftBar.setAttribute('role','group');draftBar.setAttribute('aria-label','Acciones del borrador');
  draftBar.append(draftHint,cancelDraft);
  const discardDialog=make('dialog','hd-discard-dialog'),discardTitle=make('h2',null,'¿Descartar este borrador?'),discardText=make('p');
  discardTitle.id='hd-discard-title';discardText.id='hd-discard-description';
  discardDialog.setAttribute('aria-labelledby',discardTitle.id);discardDialog.setAttribute('aria-describedby',discardText.id);
  const keepDraft=button('Seguir editando',()=>dismissDiscard(true),'hd-primary');keepDraft.autofocus=true;
  const confirmDiscard=button('Descartar borrador',()=>{
    const r=discardTarget;dismissDiscard();discardDraft(r);
  },'hd-danger');
  const discardActions=make('div','hd-discard-actions');discardActions.append(keepDraft,confirmDiscard);
  discardDialog.append(discardTitle,discardText,discardActions);
  discardDialog.addEventListener('cancel',event=>{event.preventDefault();dismissDiscard(true);});
  const scroll=make('div','hd-scroll'), sheet=make('div','hd-sheet'), feed=make('div','hd-feed'), notice=make('div','hd-notice');
  notice.setAttribute('role','status');notice.hidden=true;
  scroll.append(sheet);panel.append(top,draftBar,notice,scroll,feed,discardDialog);
  const entry=$('hub-documents-entry');
  if(entry&&head.closest('[data-work-header]'))entry.before(trigger);else head.prepend(trigger);
  hub.after(split,panel);

  function refreshLayout(){
    app.classList.toggle('hd-open',state.opened); split.hidden=!state.opened;panel.hidden=!state.opened;
    trigger.hidden=!state.scope;trigger.setAttribute('aria-expanded',String(state.opened));
    const one=state.opened&&mobile.matches;
    hub.inert=one;$('sidebar').inert=one;panel.setAttribute('aria-label',one?'Documento a pantalla completa':'Editor de documentos');
    // The Hub already fits and translates #app to the visual viewport. The phone editor covers
    // that same box; adding the visual offset again would push Send under the keyboard.
    resize(state.width);
  }
  function resize(value){
    state.width=Math.min(.68,Math.max(.46,value));split.setAttribute('aria-valuenow',String(Math.round(state.width*100)));
    const side=$('sidebar')?.getBoundingClientRect().width||0;
    const room=Math.max(0,app.clientWidth-side); const upper=Math.max(350,room-302);
    panel.style.setProperty('--hd-width',Math.min(800,upper,Math.max(350,room*state.width))+'px');
    for(const e of panel.querySelectorAll('.hd-text')) auto(e);
    const instruction=$('hd-instruction');
    if(instruction && state.opened) composer.fit(instruction);
  }
  split.addEventListener('pointerdown',e=>{if(e.button!==0)return;try{split.setPointerCapture(e.pointerId);}catch{};app.classList.add('hd-sizing');});
  split.addEventListener('pointermove',e=>{if(split.hasPointerCapture(e.pointerId)){const ar=app.getBoundingClientRect();resize((ar.right-e.clientX)/Math.max(1,ar.width-$('sidebar').getBoundingClientRect().width));}});
  split.addEventListener('lostpointercapture',()=>app.classList.remove('hd-sizing'));
  split.addEventListener('dblclick',()=>resize(.56));
  split.addEventListener('keydown',e=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;e.preventDefault();resize(e.key==='Home'?.46:e.key==='End'?.68:state.width+(e.key==='ArrowLeft'?.025:-.025));});
  let layoutFrame=null;
  function scheduleLayout(){
    if(layoutFrame===null)layoutFrame=requestAnimationFrame(()=>{layoutFrame=null;
      if(Math.abs((window.visualViewport?.scale||1)-1)>.02)return;
      refreshLayout();
    });
  }
  mobile.addEventListener('change',scheduleLayout);window.addEventListener('resize',scheduleLayout,{passive:true});window.visualViewport?.addEventListener('resize',scheduleLayout,{passive:true});
  panel.addEventListener('keydown',e=>{
    if(e.isComposing || e.keyCode===229 || composition || e.key!=='Escape')return;
    e.preventDefault();e.stopPropagation();
    if(discardDialog.open)dismissDiscard(true);
    else if(openChange)closeRequest();
    else if(state.mode==='history'||state.mode==='export')section('editor');
    else close();
  });
  function setNotice(text='', action=null){
    notice.replaceChildren();notice.hidden=!text;
    if(text){notice.append(make('span',null,text));if(action)notice.append(button(action.label,action.run));}
  }
  function clear(){
    dismissDiscard();
    state.serial++;for(const req of requests)req.abort();requests=new Set();
    clearTimeout(saveTimer);clearTimeout(pollTimer);
    artifactImports.clear();state.records.clear();state.list=[];state.active=null;state.mode='list';state.opened=false;state.loading=false;state.ready=false;
    state.opener=null;refreshOnClose=false;openChange=selected=rendered=viewport=endNotice=changed=null;composition=false;
    setNotice();draftBar.hidden=true;sheet.replaceChildren();feed.replaceChildren();refreshLayout();
  }
  function context(value){
    const key=scopeKey(value);
    if(key===state.key)return;
    const sameUser=Boolean(value?.user && value.user===state.owner);
    const preserve=sameUser&&state.key;
    if(preserve) rememberUncertain();
    if(!sameUser) suspended.clear();
    clear();state.key=key;state.scope=key?{agent:value.agent,key:value.key,sessionId:value.sessionId}:null;
    state.owner=value?.user||null;
    refreshLayout();
  }
  // Unconfirmed drafts survive changing conversation only for the same signed-in account.
  // Never store text in localStorage, IPC, an URL, telemetry or a shared cache.
  const suspended=new Map();
  const meaningful=()=>[...state.records.values()].some(unconfirmed)||[...suspended.values()].some(list=>list.some(unconfirmed));
  window.addEventListener('beforeunload',e=>{if(meaningful()){e.preventDefault();e.returnValue='';}});
  function rememberUncertain(){
    const list=[...state.records.values()].filter(unconfirmed);
    if(!list.length)return;
    // Keep copies scoped to the full transcript. Network callbacks of the former view are ignored.
    suspended.set(state.key,list);while(suspended.size>20)suspended.delete(suspended.keys().next().value);
  }
  async function call(path='',method='GET',body,sc=state.scope){
    const go=new AbortController();requests.add(go);
    try{
      const response=await fetch('/api/documents'+path+'?'+new URLSearchParams(sc),{method,credentials:'same-origin',cache:'no-store',signal:go.signal,headers:body?{'Content-Type':'application/json','X-Hub-Documents':'1','X-Hub-Document-Schema':'2','Accept':'application/json'}:{'X-Hub-Document-Schema':'2','Accept':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
      const result=await response.json().catch(()=>({}));
      if(!response.ok){const e=Error(typeof result.error==='string'?result.error:'No se pudo completar la operación');e.status=response.status;e.latest=result.document;throw e;}
      return result;
    }finally{requests.delete(go);}
  }
  function open(from=document.activeElement){
    if(!state.scope||state.opened)return;
    state.opener=from;state.opened=true;refreshLayout();
    const kept=suspended.get(state.key);suspended.delete(state.key);
    if(kept?.length){for(const r of kept){r.inflight=false;state.records.set(r.id,r);}state.active=kept[0].id;state.mode='editor';}
    else if(current()&&state.mode!=='list')state.mode='editor';
    render();
    if(state.mode==='editor'&&current())scroll.scrollTop=current().scroll||0;
    label.focus({preventScroll:true});list();
    if(current()?.doc?.job?.state==='running')schedulePoll(current());
  }
  function close(restore=false){
    if(!state.opened)return;
    const r=current(), had=panel.contains(document.activeElement)||document.activeElement===split;
    if(r&&state.mode==='editor')r.scroll=scroll.scrollTop;
    // Returning to the chat hides the editor without dropping its in-memory records.
    // Invalidate older selections/imports so they cannot reopen the panel after this click.
    selectionRequest++;dismissDiscard();
    state.opened=false;openChange=selected=null;clearTimeout(pollTimer);setNotice();refreshLayout();
    if(refreshOnClose){refreshOnClose=false;const node=$('hub-artifacts');if(node)node.open=true;}
    if(had||restore){const target=state.opener?.isConnected&&!state.opener.disabled&&state.opener.getClientRects().length?state.opener:trigger;target.focus({preventScroll:true});}
    if(unconfirmed(r))window.dispatchEvent(new Event('hub-documents-parked'));
    // Keep normal autosave for existing documents. Back neither waits for it nor creates a new document.
    if(r?.doc&&r.dirty&&!r.inflight&&!r.conflict&&!composition)void flush(r);
  }
  function dismissDiscard(restore=false){
    discardTarget=null;
    if(!discardDialog.open)return;
    discardDialog.close();
    if(restore&&state.opened&&!draftBar.hidden)cancelDraft.focus({preventScroll:true});
  }
  function requestDiscard(){
    const r=current();
    if(!state.opened||state.mode!=='editor'||!r||r.doc||r.inflight||discardDialog.open)return;
    if(!r.epoch&&!composition&&!r.retry){discardDraft(r);return;}
    discardText.textContent=r.retry?'Se cerrará el borrador de esta pestaña. Si el guardado llegó a completarse, la copia guardada seguirá en Documentos.':
      'Se perderán los cambios de este borrador. No se tocarán el archivo original ni los documentos guardados.';
    discardTarget=r;discardDialog.showModal();keepDraft.focus({preventScroll:true});
  }
  function discardDraft(r){
    if(!state.opened||!r||current()!==r||r.doc||r.inflight)return;
    selectionRequest++;clearTimeout(saveTimer);clearTimeout(pollTimer);
    for(const [id,entry] of artifactImports)if(entry.record===r)artifactImports.delete(id);
    state.records.delete(r.id);state.active=null;state.mode='list';
    openChange=selected=rendered=null;composition=false;setNotice();
    if(r.cancelToList){render();scroll.scrollTop=0;$('hd-new-document')?.focus({preventScroll:true});if(r.retry)void list();}
    else{close(true);draftBar.hidden=true;sheet.replaceChildren();feed.replaceChildren();}
  }
  function useDoc(value){return { id:value.id,doc:value,draft:{title:value.title,blocks:structuredClone(value.blocks)}, dirty:false, inflight:false, conflict:null, retry:null, epoch:0, scroll:0, confirm:false };}
  function replaceDoc(r,value){r.doc=value;r.draft={title:value.title,blocks:structuredClone(value.blocks)};r.dirty=false;r.retry=null;r.conflict=null;r.confirm=false;r.epoch++;}
  function blank(title='',blocks){return {id:'draft-'+uid(),doc:null,draft:{title,blocks:blocks?.length?blocks:[{id:uid(),kind:'paragraph',text:''}]},dirty:true,inflight:false,retry:null,epoch:0,scroll:0,confirm:false};}
  async function select(id){
    if(!state.scope)return;
    const serial=state.serial,opening=++selectionRequest,from=current();
    if(from?.dirty||from?.inflight)await flush(from);
    if(!active(serial)||!state.opened||opening!==selectionRequest||current()!==from)return;
    setNotice();
    try{
      let record=state.records.get(id);
      if(!record||(!record.dirty&&!record.inflight&&!record.conflict)){const {document:doc}=await call('/'+id);if(!active(serial)||!state.opened||opening!==selectionRequest)return;record=useDoc(doc);state.records.set(id,record);}
      if(opening===selectionRequest)show(record);
    }catch(e){if(active(serial)&&e.name!=='AbortError')setNotice(e.message);}
  }
  function show(r){
    selectionRequest++;dismissDiscard();
    if(current())current().scroll=scroll.scrollTop;
    clearTimeout(saveTimer);clearTimeout(pollTimer);state.records.set(r.id,r);state.active=r.id;state.mode='editor';openChange=selected=null;rendered=null;setNotice();render();
    scroll.scrollTop=r.scroll||0;if(r.doc?.job?.state==='running')schedulePoll(r);
  }
  async function browse(){
    const serial=state.serial,opening=++selectionRequest,r=current();
    if(r?.dirty||r?.inflight)await flush(r);
    if(!active(serial)||!state.opened||opening!==selectionRequest)return;
    if(r)r.scroll=scroll.scrollTop;
    state.mode='list';render();list();
  }
  async function list(){
    if(!state.scope||state.loading)return;
    const serial=state.serial;state.loading=true;
    try{
      const v=await call();if(!active(serial))return;
      const next=v.documents||[], changedList=!state.ready||JSON.stringify(next)!==JSON.stringify(state.list);
      state.list=next;state.ready=true;
      if(state.mode==='list'&&changedList){
        const onNew=document.activeElement?.id==='hd-new-document';render();if(onNew)$('hd-new-document')?.focus({preventScroll:true});
      }
    }
    catch(e){if(active(serial)&&e.name!=='AbortError')setNotice(e.message,{label:'Reintentar',run:list});}
    finally{if(active(serial))state.loading=false;}
  }
  let importModule;
  const artifactImports=new Map();
  function loadImporter(){
    if(window.HubDocumentImport)return Promise.resolve(window.HubDocumentImport);
    if(importModule)return importModule;
    importModule=new Promise((yes,no)=>{
      const script=document.createElement('script');script.src='/document-import.js?v=2';
      const failure=()=>{script.remove();importModule=null;no(new Error('No se pudo iniciar la apertura del archivo.'));};
      script.onload=()=>window.HubDocumentImport?yes(window.HubDocumentImport):failure();script.onerror=failure;
      document.head.append(script);
    });
    return importModule;
  }
  async function importArtifact(artifact,opener=document.activeElement){
    if(!state.scope || typeof artifact?.id!=='string' || !artifact.id.length || artifact.id.length>1024)return false;
    const serial=state.serial, opening=selectionRequest, scope=state.scope, id=artifact.id;
    const stillOpening=()=>active(serial)&&opening===selectionRequest;
    const importer=await loadImporter();if(!stillOpening())return false;
    const existing=artifactImports.get(id);
    const showCopy=r=>{
      if(!stillOpening())return false;
      if(!state.opened){open();if(opener?.isConnected)state.opener=opener;}
      const confirm=()=>{
        if(!stillOpening()||!state.opened)return false;
        r.cancelToList=false;if(opener?.isConnected)state.opener=opener;
        show(r);label.focus({preventScroll:true});return true;
      };
      const from=current();
      if(from!==r&&(from?.dirty||from?.inflight)){
        setNotice('El borrador abierto se conserva. El adjunto se abrirá como otra copia.',{label:'Abrir copia',run:confirm});return false;
      }
      return confirm();
    };
    if(existing?.record && (!existing.record.doc || state.records.has(existing.record.id)))return showCopy(existing.record);
    if(existing?.pending)return false;
    const controller=new AbortController(), entry={pending:true};artifactImports.set(id,entry);requests.add(controller);
    try{
      const doc=await importer.fetchFile(artifact,scope,controller.signal);
      if(!stillOpening()||controller.signal.aborted)return false;
      if(!doc.blocks && doc.word)return {preview:doc.word};
      const blocks=doc.blocks.map(b=>b.kind==='table'?{...b,id:uid(),rows:b.rows.map(row=>({...row,cells:row.cells.map(c=>({...c,id:uid()}))}))}:{...b,id:uid()});
      entry.record=blank(doc.title,blocks);
      entry.record.fromArtifact=true;
      return showCopy(entry.record);
    }catch(error){if(artifactImports.get(id)===entry)artifactImports.delete(id);if(error.name==='AbortError'||!stillOpening())return false;throw error;}
    finally{requests.delete(controller);entry.pending=false;if(!entry.record&&artifactImports.get(id)===entry)artifactImports.delete(id);}
  }
  function seed(source,onReady){
    if(!state.scope)return false;
    if(typeof source!=='string'||!source.trim())throw Error('Esta respuesta no tiene texto para pasar a Documentos.');
    if(source.length>32000)throw Error('La respuesta supera los 32.000 caracteres. Selecciona un fragmento y pásalo a Documento.');
    const splitText=text=>{
      const parts=[];
      while(text.length>12000){
        let end=12000;
        if(text.charCodeAt(end)>=0xDC00&&text.charCodeAt(end)<=0xDFFF)end--;
        parts.push(text.slice(0,end));text=text.slice(end);
      }
      return [...parts,text];
    };
    let bodies=source.split(/\n{2,}/u).flatMap(splitText);
    if(bodies.length>160)bodies=splitText(source);
    const parts=bodies.map(text=>({id:uid(),kind:'paragraph',text}));
    const bound=state.key, serial=state.serial;
    if(!state.opened)open();
    const makeDraft=()=>{
      if(!active(serial)||state.key!==bound||!state.opened)return false;
      const first=bodies[0].split(/\n/u)[0].replace(/\t/gu,' ').trim();
      const title=first&&first.length<82?first:'Respuesta del chat';
      show(blank(title,parts));$('hd-document-title')?.focus({preventScroll:true});onReady?.();return true;
    };
    if(current()?.dirty||current()?.inflight){setNotice('Hay otro borrador abierto. Puedes preparar una copia sin perderlo.',{label:'Abrir otro borrador',run:makeDraft});return false;}
    return makeDraft();
  }
  function section(mode){
    const r=current();if(!r?.doc)return;
    r.scroll=state.mode==='editor'?scroll.scrollTop:r.scroll;state.mode=mode;
    selected=openChange=null;render();if(mode==='editor')scroll.scrollTop=r.scroll;
    if(r.dirty)void flush(r);
  }
  const opError=(r,e)=>{if(e.name==='AbortError')return;if(e.status===409&&e.latest){r.conflict=e.latest;r.retry=null;}setNotice(e.message||'No se ha confirmado el guardado.');};
  function touch(r){r.epoch++;r.dirty=true;r.confirm=false;clearTimeout(saveTimer);if(r.doc&&!composition&&!r.conflict)saveTimer=setTimeout(()=>flush(r),900);updateStatus();}
  function normalized(r){return {title:r.draft.title.trim(),blocks:structuredClone(r.draft.blocks)};}
  async function flush(r){
    if(!r||!r.dirty)return true;
    if(r.inflight){await r.inflight;return !r.dirty;}
    if(r.conflict)return false;
    if(!r.doc)return false;
    if(!r.draft.title.trim()){if(current()===r&&state.opened)setNotice('Escribe un título para guardar los cambios.');return false;}
    clearTimeout(saveTimer);
    const serial=state.serial,epoch=r.epoch,base=r.doc.hash,data=normalized(r);
    const k=JSON.stringify([base,data]);const opId=r.retry?.key===k?r.retry.id:uid();r.retry={key:k,id:opId};
    const execute=async()=>{
      try {
        const {document:value}=await call('/'+r.id,'PUT',{base,...data,opId});if(!active(serial,r))return;
        r.doc=value;r.retry=null;r.dirty=r.epoch!==epoch;
        if(!r.dirty)r.conflict=null;
        if(current()===r){setNotice();renderFeed();if(state.mode!=='editor')render();}
      }catch(e){if(active(serial,r)&&current()===r)opError(r,e);}
      finally{r.inflight=false;if(active(serial,r)&&current()===r){updateStatus();if(r.dirty&&r.epoch!==epoch&&!r.conflict)saveTimer=setTimeout(()=>flush(r),700);}}
    };
    r.inflight=execute();updateStatus();await r.inflight;return !r.dirty;
  }
  async function create(r){
    if(r.doc||r.inflight)return;
    const data=normalized(r);
    if(!data.title){setNotice('Escribe un título para guardar el documento.');$('hd-document-title')?.focus();return;}
    const serial=state.serial,ep=r.epoch,key=JSON.stringify(data),opId=r.retry?.key===key?r.retry.id:uid();r.retry={key,id:opId};
    const old=r.id;
    r.inflight=(async()=>{
      try{const {document:value}=await call('','POST',{...data,opId,...(r.offerId?{offerId:r.offerId}:{})});if(!active(serial,r))return;
        state.records.delete(old);r.id=value.id;r.doc=value;const otherSave=r.offerId&&JSON.stringify(data)!==JSON.stringify({title:value.title,blocks:value.blocks});if(otherSave){r.conflict=value;r.epoch++;}r.retry=null;r.dirty=r.epoch!==ep;state.records.set(r.id,r);
        if(state.active===old){
          const restore=state.opened&&document.activeElement===saveControl;
          state.active=r.id;rendered=null;render();if(restore)closing.focus({preventScroll:true});
        }
        if(r.dirty&&!r.conflict)saveTimer=setTimeout(()=>flush(r),450);else if(!r.conflict)setNotice();
      }catch(e){if(active(serial,r)&&current()===r)opError(r,e);}
      finally{r.inflight=false;if(active(serial,r))updateStatus();}
    })();updateStatus();return r.inflight;
  }
  async function action(kind,values={}){
    const r=current();if(!r?.doc||r.working)return;
    if(kind==='approve'&&(values.expected!==r.doc.hash||r.dirty)){setNotice('El borrador cambió. Vuelve a revisar la versión actual.');return;}
    if(kind==='approve')values={};
    const serial=state.serial;r.working=kind;updateStatus();setNotice();
    try{
      if(r.dirty&&!await flush(r)){if(active(serial,r)&&current()===r)setNotice('Guarda primero los cambios del borrador.');return;}
      if(!active(serial,r)||current()!==r)return;
      const epoch=r.epoch,body={base:r.doc.hash,action:kind,...values};const sig=JSON.stringify(body);const opId=r.actionRetry?.sig===sig?r.actionRetry.id:uid();r.actionRetry={sig,id:opId};
      const result=await call('/'+r.id+'/action','POST',{...body,opId});if(!active(serial,r))return;
      const value=result.document;
      r.actionRetry=null;
      if(value){
        const sameDraft=r.epoch===epoch&&!r.dirty;
        if(!sameDraft&&value.hash!==r.doc.hash&&['restore','resolve'].includes(kind))r.conflict=value;
        else if(sameDraft&&value.hash!==r.doc.hash){replaceDoc(r,value);rendered=null;}
        else if(value.hash===r.doc.hash)r.doc=value;
      }
      openChange=null;selected=null;
      if(result.artifact){announceExport(result.artifact); if(current()===r&&state.opened)showExport(result.artifact);}
      else if(current()===r&&state.opened){const focused=document.activeElement;render();if(!focused?.isConnected && !['propose','review'].includes(kind))label.focus({preventScroll:true});}
      if(value?.job?.state==='running'&&current()===r)schedulePoll(r);
    }catch(e){if(active(serial,r)&&current()===r)opError(r,e);if(e.status)r.actionRetry=null;}
    finally{r.working=null;if(active(serial,r)&&current()===r)updateStatus();}
  }
  function schedulePoll(r,attempt=0){
    clearTimeout(pollTimer);const serial=state.serial;
    if(!state.opened||current()!==r||attempt>=43)return;
    pollTimer=setTimeout(async()=>{
      if(!state.opened||current()!==r||!active(serial,r))return;
      if(r.inflight||document.hidden){schedulePoll(r,attempt+1);return;}
      const hash=r.doc.hash, target=r.doc.job?.id;
      try{const {document:value}=await call('/'+r.id);
        if(!active(serial,r)||current()!==r||!state.opened||hash!==r.doc.hash||r.inflight||r.doc.job?.id!==target){if(active(serial,r)&&current()===r&&r.doc?.job?.state==='running')schedulePoll(r,attempt+1);return;}
        if(value.hash===r.doc.hash)r.doc=value;
        else if(r.dirty){r.conflict=value;r.doc={...r.doc,job:null};}
        else {replaceDoc(r,value);rendered=null;}
        render();if(value.job?.state==='running')schedulePoll(r,attempt+1);
      }catch(e){if(active(serial,r)&&e.name!=='AbortError'&&e.status!==403)schedulePoll(r,attempt+1);}
    },attempt<2?450:attempt<9?1150:2200);
  }
  function updateStatus(){
    const r=current();const doc=r?.doc;
    const text=state.mode==='list'?'En esta conversación':r?.conflict?'Conflicto · tu texto está intacto':r?.inflight?'Guardando…':r?.dirty?doc?'Cambios sin confirmar':r.retry?'Guardado sin confirmar':'Borrador sin guardar':doc?'v'+doc.revision+(doc.approval?' · Conforme':' · Guardado'):'En esta conversación';
    if(status.textContent!==text)status.textContent=text;
    label.textContent=state.mode==='list'?'Documentos':doc?'Documento':'Nuevo documento';
    index.hidden=state.mode==='list';history.hidden=!doc||state.mode==='list';deliver.hidden=!doc||state.mode==='list';
    history.setAttribute('aria-pressed',String(state.mode==='history'));deliver.setAttribute('aria-pressed',String(state.mode==='export'));
    const draft=state.mode==='editor'&&r&&!doc;
    draftBar.hidden=!draft;
    cancelDraft.disabled=Boolean(r?.inflight);
    if(draft)draftHint.textContent=r.fromArtifact?'El original no cambia':'Solo en este chat';
    const saveLabel=draft?r.fromArtifact?'Guardar copia':'Guardar documento':'Guardar';
    if(saveControl.textContent!==saveLabel)saveControl.textContent=saveLabel;
    saveControl.disabled=Boolean(!draft&&(r?.inflight||r?.conflict||!r?.dirty));
    if(draft&&r.inflight)saveControl.setAttribute('aria-disabled','true');else saveControl.removeAttribute('aria-disabled');
    if(openChange)updateRequestControls();
    if(r?.conflict&&state.opened&&state.mode==='editor'&&!changed){changed=conflictBox(r);sheet.prepend(changed);}
    else if(!r?.conflict&&changed){changed.remove();changed=null;}
  }
  function render(){
    if(!state.opened)return;
    const r=current();
    if(state.mode==='editor'&&r&&rendered===r){updateStatus();renderFeed();return;}
    rendered=null;changed=null;endNotice=null;saveControl.remove();
    delete feed.dataset.signature;feed.replaceChildren();sheet.replaceChildren();
    if(state.mode==='list'||!r){
      const line=make('div','hd-collection-head'),newDoc=button('＋ Nuevo',()=>{
        const next=blank();next.cancelToList=true;show(next);$('hd-document-title')?.focus();
      },'hd-primary');newDoc.id='hd-new-document';line.append(make('h2',null,'Documentos'),newDoc);
      const records=new Map(state.list.map(item=>[item.id,item]));for(const t of state.records.values())if(t.dirty||t.conflict)records.set(t.id,{id:t.id,title:t.draft.title||'Borrador sin título',revision:t.doc?.revision||0,dirty:true});
      sheet.append(make('p','hd-eyebrow','ESTA CONVERSACIÓN'),line,make('p','hd-sub',records.size?'Selecciona un documento para continuar.':state.ready?'Crea un borrador o convierte una respuesta del chat.':'Cargando documentos…'));
      for(const d of records.values()){
        const b=button('',()=>{const item=state.records.get(d.id);if(item?.dirty||item?.conflict){if(!item.doc)item.cancelToList=true;show(item);}else void select(d.id);},'hd-doc-card');
        b.append(make('strong',null,d.title),make('span',null,d.dirty?'Cambios en esta pestaña':'v'+d.revision+(d.conformable?' · Conforme':' · Borrador')));sheet.append(b);
      }
    } else if(state.mode==='editor')renderEditor(r);
    else if(state.mode==='history')renderHistory(r);
    else renderExport(r);
    updateStatus();renderFeed();
  }
  function conflictBox(r){
    const box=make('section','hd-conflict');box.append(make('strong',null,'Cambios en otra pestaña'),make('p',null,'Tu texto no se ha sobrescrito. Puedes copiarlo o abrir la versión guardada.'));
    const buttons=make('div','hd-inline');
    buttons.append(button('Copiar mi borrador',async()=>{
      const text=[r.draft.title,...r.draft.blocks.map(b=>b.kind==='table'?b.rows.map(row=>row.cells.map(cell=>cell.text).join('\t')).join('\n'):b.text+(b.pageNumber?' [Número de página]':''))].join('\n\n');
      try{await navigator.clipboard.writeText(text);setNotice('Borrador copiado.');}catch{const t=make('textarea','hd-text');t.value=text;t.readOnly=true;t.setAttribute('aria-label','Texto del borrador para copiar');box.append(t);t.focus();t.select();auto(t);}
    }),button('Ver versión guardada',()=>{box.append(make('p','hd-sub','¿Descartar la copia de esta pestaña y abrir la versión guardada?'),button('Descartar mi copia',()=>{replaceDoc(r,r.conflict);setNotice();rendered=null;render();label.focus();},'hd-danger'));},{once:true}));box.append(buttons);return box;
  }
  function auto(el){if(!el.isConnected||el.closest('[hidden]'))return;el.style.height='0px';el.style.height=Math.max(30,el.scrollHeight+2)+'px';}
  function renderEditor(r,focusId){
    sheet.replaceChildren();changed=null;delete feed.dataset.signature;
    rendered=r;
    const eye=make('div','hd-editor-top');eye.append(make('span','hd-eyebrow',r.doc?'DOCUMENTO DE TRABAJO':r.fromArtifact?'COPIA EDITABLE':'BORRADOR'));
    saveControl.classList.toggle('hd-primary',!r.doc);
    const saveParent=r.doc?eye:draftBar;if(saveControl.parentNode!==saveParent)saveParent.append(saveControl);
    const title=make('input','hd-title');title.id='hd-document-title';title.type='text';title.placeholder='Título del documento';title.setAttribute('aria-label','Título del documento');title.maxLength=160;title.value=r.draft.title;
    title.addEventListener('compositionstart',()=>{composition=true;clearTimeout(saveTimer);});title.addEventListener('compositionend',()=>{composition=false;r.draft.title=title.value;touch(r);});
    title.addEventListener('input',e=>{r.draft.title=title.value;if(!e.isComposing&&!composition)touch(r);});
    const blocks=make('div','hd-blocks');blocks.id='hd-blocks';sheet.append(eye,title,blocks);
    r.draft.blocks.forEach((block,i)=>blocks.append(block.kind==='table'?tableView(r,block,i):
      block.kind==='header'||block.kind==='footer'?frameView(r,block):blockView(r,block,i)));
    const insert=make('div','hd-insert');insert.setAttribute('role','group');insert.setAttribute('aria-label','Insertar en el documento');
    const add=button('＋ Añadir párrafo',()=>addBlock(r,r.draft.blocks.length),'hd-add');add.id='hd-add';
    const extra=make('details','hd-insert-menu');extra.append(make('summary',null,'＋ Insertar'));
    const options=make('div','hd-inline');
    options.append(button('Tabla',()=>addStructure(r,'table')));
    if(!r.draft.blocks.some(b=>b.kind==='header'))options.append(button('Encabezado',()=>addStructure(r,'header')));
    if(!r.draft.blocks.some(b=>b.kind==='footer'))options.append(button('Pie de página',()=>addStructure(r,'footer')));
    extra.append(options);insert.append(add,extra);sheet.append(insert);
    if(!r.doc)sheet.append(make('p','hd-sub',r.fromArtifact?'La copia se guarda en este chat. El archivo original sigue en Entregables.':'No se crea hasta que pulses «Guardar documento».'));
    endNotice=make('div','hd-editor-foot');sheet.append(endNotice);
    for(const e of blocks.querySelectorAll('textarea'))auto(e);
    if(focusId){
      const field=Array.from(blocks.querySelectorAll('textarea')).find(x=>x.dataset.cell===focusId||(!x.dataset.cell&&x.dataset.id===focusId));
      if(field){field.focus({preventScroll:true});field.scrollIntoView({block:'nearest',inline:'nearest'});}
      else label.focus({preventScroll:true});
    }
    updateStatus();renderFeed();
  }
  function bodyPosition(r,i){
    const header=r.draft.blocks[0]?.kind==='header'?1:0;
    const footer=r.draft.blocks.at(-1)?.kind==='footer'?1:0;
    return Math.max(header,Math.min(i,r.draft.blocks.length-footer));
  }
  function structureChanged(r,focusId){selected=openChange=null;touch(r);renderEditor(r,focusId);}
  function addBlock(r,i){
    if(r.draft.blocks.length>=160){setNotice('El editor admite 160 bloques.');return;}
    const id=uid();r.draft.blocks.splice(bodyPosition(r,i),0,{id,kind:'paragraph',text:''});structureChanged(r,id);
  }
  const newCell=()=>({id:uid(),text:''});
  const cellsIn=r=>r.draft.blocks.reduce((n,b)=>n+(b.kind==='table'?b.rows.reduce((count,row)=>count+row.cells.length,0):0),0);
  function addStructure(r,kind){
    if(r.draft.blocks.length>=160 || (kind==='table'&&cellsIn(r)+4>320)){setNotice('Se alcanzó el límite de bloques o celdas.');return;}
    const id=uid();
    if(kind==='table'){
      const rows=[{header:true,cells:[newCell(),newCell()]},{cells:[newCell(),newCell()]}];
      r.draft.blocks.splice(bodyPosition(r,r.draft.blocks.length),0,{id,kind,rows});structureChanged(r,rows[0].cells[0].id);
    }else{
      r.draft.blocks.splice(kind==='header'?0:r.draft.blocks.length,0,{id,kind,text:''});structureChanged(r,id);
    }
  }
  function removeStructure(r,b){
    const i=r.draft.blocks.indexOf(b);if(i<0)return;
    r.draft.blocks.splice(i,1);
    if(!r.draft.blocks.some(x=>x.kind!=='header'&&x.kind!=='footer'))r.draft.blocks.splice(bodyPosition(r,1),0,{id:uid(),kind:'paragraph',text:''});
    setNotice();structureChanged(r);
  }
  function confirmRemove(r,b,label){
    setNotice('¿Quitar '+label+' de esta copia? El original no cambia.',{label:'Confirmar eliminación',run:()=>{if(current()===r)removeStructure(r,b);}});
  }
  function fieldFor(r,b,value,labelText,cell){
    const text=make('textarea','hd-text');text.dataset.id=b.id;
    if(cell)text.dataset.cell=cell.id;
    text.rows=1;text.maxLength=b.kind==='header'||b.kind==='footer'?1600:12000;text.value=value.text;
    text.setAttribute('aria-label',labelText);text.placeholder='Escribe aquí…';
    text.addEventListener('compositionstart',()=>{composition=true;clearTimeout(saveTimer);openChange=selected=null;renderFeed();});
    text.addEventListener('compositionend',()=>{composition=false;value.text=text.value;touch(r);auto(text);});
    text.addEventListener('input',e=>{value.text=text.value;if(!e.isComposing&&!composition){touch(r);selection(r,b,text,cell?.id);}auto(text);});
    for(const e of ['select','keyup','pointerup','focus'])text.addEventListener(e,()=>selection(r,b,text,cell?.id));
    text.addEventListener('keydown',e=>{if(e.isComposing||composition)return;
      if(e.ctrlKey&&e.shiftKey&&e.key==='Enter'){e.preventDefault();selection(r,b,text,cell?.id);askSelection();}
    });
    return text;
  }
  function frameView(r,b){
    const name=b.kind==='header'?'Encabezado':'Pie de página';
    const box=make('section','hd-block hd-page-part');box.dataset.block=b.id;box.dataset.kind=b.kind;box.setAttribute('aria-label',name);
    const intro=make('div','hd-structure-head');intro.append(make('strong',null,name),button('Quitar',()=>confirmRemove(r,b,b.kind==='header'?'el encabezado':'el pie de página'),'hd-frame-remove'));
    box.append(intro,fieldFor(r,b,b,name));
    if(b.kind==='footer'){
      const lab=make('label','hd-frame-number'),cb=make('input');cb.type='checkbox';cb.checked=Boolean(b.pageNumber);
      cb.addEventListener('change',()=>{if(cb.checked)b.pageNumber=true;else delete b.pageNumber;touch(r);});
      lab.append(cb,make('span',null,'Número de página automático'));box.append(lab);
    }
    return box;
  }
  function tableView(r,b,i){
    const card=make('section','hd-block hd-table-block');card.dataset.kind='table';card.dataset.block=b.id;
    const nTables=r.draft.blocks.slice(0,i+1).filter(item=>item.kind==='table').length;
    const cols=b.rows[0].cells.reduce((n,c)=>n+(c.span||1),0);
    const top=make('div','hd-structure-head'), name=make('strong',null,'Tabla '+nTables);top.append(name,make('span','hd-sub',b.rows.length+' filas · '+cols+' columnas'));
    const wrap=make('div','hd-table-scroll');wrap.tabIndex=0;wrap.setAttribute('role','region');wrap.setAttribute('aria-label','Desplazar tabla '+nTables);
    const table=make('table','hd-table'), body=make('tbody');table.setAttribute('aria-label','Tabla '+nTables);table.style.setProperty('--hd-cols',cols);
    const columns=make('colgroup');for(let i=0;i<cols;i++)columns.append(make('col'));table.append(columns,body);
    b.rows.forEach((data,ri)=>{
      const row=make('tr');let ci=1;
      data.cells.forEach(c=>{
        const cell=make(data.header?'th':'td');cell.colSpan=c.span||1;if(data.header)cell.scope='col';
        const field=fieldFor(r,b,c,'Tabla '+nTables+', fila '+(ri+1)+', columna '+ci,c);field.placeholder='';
        cell.append(field);row.append(cell);ci+=cell.colSpan;
      });body.append(row);
    });wrap.append(table);
    const rowAdd=button('＋ Fila',()=>{
      if(b.rows.length>=80||cellsIn(r)+cols>320)return;
      const cells=Array.from({length:cols},newCell);b.rows.push({cells});structureChanged(r,cells[0].id);
    },'hd-table-add-row');rowAdd.disabled=b.rows.length>=80||cellsIn(r)+cols>320;
    const columnAdd=button('＋ Columna',()=>{
      if(cols>=12||cellsIn(r)+b.rows.length>320)return;
      const cells=b.rows.map(row=>{const c=newCell();row.cells.push(c);return c;});structureChanged(r,cells[0].id);
    },'hd-table-add-column');columnAdd.disabled=cols>=12||cellsIn(r)+b.rows.length>320;
    const tools=make('div','hd-inline'), more=make('details','hd-table-menu');more.append(make('summary',null,'Opciones de tabla'));
    const commands=make('div','hd-inline'),head=button('Primera fila de títulos',()=>{if(b.rows[0].header)delete b.rows[0].header;else b.rows[0].header=true;structureChanged(r,b.rows[0].cells[0].id);});
    head.setAttribute('aria-pressed',String(Boolean(b.rows[0].header)));
    const tailRow=b.rows.at(-1),emptyRow=button('Quitar última fila vacía',()=>{if(b.rows.length>1&&tailRow.cells.every(c=>!c.text)){b.rows.pop();structureChanged(r,b.rows.at(-1).cells[0].id);}});
    const rowEmpty=()=>b.rows.length>1&&tailRow.cells.every(c=>!c.text);
    const colEmpty=()=>cols>1&&b.rows.every(row=>!row.cells.at(-1).text&&!row.cells.at(-1).span);
    const emptyColumn=button('Quitar última columna vacía',()=>{if(colEmpty()){b.rows.forEach(row=>row.cells.pop());structureChanged(r,b.rows[0].cells.at(-1).id);}});
    const update=()=>{emptyRow.disabled=!rowEmpty();emptyColumn.disabled=!colEmpty();};body.addEventListener('input',update);update();
    commands.append(head,emptyRow,emptyColumn,button('Quitar tabla',()=>confirmRemove(r,b,'la tabla'),'hd-danger'));more.append(commands);
    tools.append(rowAdd,columnAdd,more);card.append(top,wrap,tools);return card;
  }
  function blockView(r,b,i){
    const row=make('div','hd-block');row.dataset.kind=b.kind;row.dataset.block=b.id;
    const text=fieldFor(r,b,b,kinds[b.kind]+' '+(i+1));text.placeholder=b.kind==='heading'?'Título de sección':'Escribe aquí…';
    const changeKind=make('select','hd-kind');changeKind.setAttribute('aria-label','Tipo de bloque '+(i+1));
    for(const [key,label] of Object.entries(kinds)){const opt=make('option',null,label);opt.value=key;opt.selected=b.kind===key;changeKind.append(opt);}
    const styles=make('div','hd-kind-tools'),level=make('select','hd-kind hd-level');level.setAttribute('aria-label','Nivel de título '+(i+1));
    for(let n=1;n<=6;n++){const opt=make('option',null,'Nivel '+n);opt.value=String(n);opt.selected=n===(b.level||1);level.append(opt);}
    row.dataset.level=b.level||1;level.hidden=b.kind!=='heading';
    level.addEventListener('change',()=>{const n=Number(level.value);if(n===1)delete b.level;else b.level=n;row.dataset.level=n;touch(r);auto(text);});
    changeKind.addEventListener('change',()=>{
      b.kind=changeKind.value;if(b.kind!=='heading'){delete b.level;level.value='1';}level.hidden=b.kind!=='heading';row.dataset.kind=b.kind;row.dataset.level=b.level||1;
      text.setAttribute('aria-label',kinds[b.kind]+' '+(i+1));touch(r);auto(text);
    });styles.append(changeKind,level);
    text.addEventListener('keydown',e=>{if(e.isComposing||composition)return;
      if(e.altKey&&e.key==='Enter'){e.preventDefault();addBlock(r,i+1);}
      if(e.altKey&&e.key==='Backspace'&&!text.value&&r.draft.blocks.filter(x=>x.kind!=='header'&&x.kind!=='footer').length>1){e.preventDefault();const target=r.draft.blocks[Math.max(0,i-1)]===b?r.draft.blocks[i+1]:r.draft.blocks[i-1];r.draft.blocks.splice(i,1);touch(r);renderEditor(r,target.id);}
      if(e.altKey&&(e.key==='ArrowUp'||e.key==='ArrowDown')){const j=i+(e.key==='ArrowUp'?-1:1);if(j===bodyPosition(r,j)&&j<r.draft.blocks.length&&r.draft.blocks[j].kind!=='footer'){e.preventDefault();[r.draft.blocks[i],r.draft.blocks[j]]=[r.draft.blocks[j],r.draft.blocks[i]];touch(r);renderEditor(r,b.id);}}
    });
    row.append(text,styles);return row;
  }
  function selection(r,b,text,cellId){
    if(composition||openChange||!r.doc||r.doc.proposal||r.doc.job?.state==='running')return;
    const start=text.selectionStart,end=text.selectionEnd,quote=text.value.slice(start,end);
    if(!quote.trim()||quote.length>3500){if(selected){selected=null;renderFeed();}return;}
    const next={blockId:b.id,...(cellId?{cellId}:{}),start,end,quote}; if(JSON.stringify(next)===JSON.stringify(selected))return;
    selected=next;renderFeed();
  }
  function askSelection(){
    if(!selected||!current()?.doc||current().doc.job?.state==='running')return;
    openChange={...selected,instruction:''};renderFeed();$('hd-instruction')?.focus();
  }
  function closeRequest(){
    if(!openChange||current()?.working==='propose')return;
    const anchor=openChange;
    const field=Array.from(sheet.querySelectorAll('.hd-text')).find(el=>el.dataset.id===anchor.blockId&&(el.dataset.cell||null)===(anchor.cellId||null));
    const keep=field?.value.slice(anchor.start,anchor.end)===anchor.quote;
    openChange=null;selected=keep?{blockId:anchor.blockId,...(anchor.cellId?{cellId:anchor.cellId}:{}),start:anchor.start,end:anchor.end,quote:anchor.quote}:null;
    if(keep)field.setSelectionRange(anchor.start,anchor.end);
    renderFeed();(field||label).focus({preventScroll:true});
  }
  function updateRequestControls(form=feed.querySelector('.hd-request')){
    if(!form)return;
    const field=form.querySelector('.composer-field');
    const busy=current()?.working==='propose';
    field.readOnly=busy;
    form.querySelector('.composer-send').disabled=busy||!field.value.trim();
    form.querySelector('.hd-request-close').disabled=busy;
    if(busy)form.setAttribute('aria-busy','true');else form.removeAttribute('aria-busy');
  }
  function requestComposer(){
    const anchor=openChange;
    const form=make('form','composer hd-request');
    form.setAttribute('aria-label','Pedir cambio en Documentos');
    const meta=make('div','hd-request-meta'), context=make('div','hd-request-context');
    const quote=make('blockquote','hd-request-quote',anchor.quote);quote.title=anchor.quote;
    context.append(make('span','hd-request-scope','Selección'),quote);
    const dismiss=button('',closeRequest,'hd-request-close');
    dismiss.title='Cancelar la petición';dismiss.setAttribute('aria-label',dismiss.title);
    const dismissIcon=document.createElementNS('http://www.w3.org/2000/svg','svg');
    dismissIcon.setAttribute('viewBox','0 0 24 24');dismissIcon.setAttribute('class','ui-icon');dismissIcon.setAttribute('aria-hidden','true');
    const dismissPath=document.createElementNS(dismissIcon.namespaceURI,'path');dismissPath.setAttribute('d','m7 7 10 10M17 7 7 17');dismissIcon.append(dismissPath);dismiss.append(dismissIcon);
    meta.append(context,dismiss);
    const input=make('textarea','composer-field');input.id='hd-instruction';input.rows=1;
    input.placeholder='¿Qué quieres cambiar?';input.maxLength=1200;input.required=true;input.value=anchor.instruction;
    input.setAttribute('aria-label','Instrucción para la selección');
    const submit=make('button','composer-send');submit.type='submit';submit.title='Pedir propuesta';submit.setAttribute('aria-label',submit.title);
    submit.append($('btn-send').querySelector('.ui-icon').cloneNode(true));
    const row=make('div','composer-row');row.append(input,submit);
    const hint=make('div','composer-hint',composer.hint);hint.setAttribute('aria-hidden','true');form.append(meta,row,hint);
    input.addEventListener('input',()=>{anchor.instruction=input.value;composer.fit(input);updateRequestControls(form);});
    input.addEventListener('keydown',e=>{
      if(!composer.enterSends(e))return;
      e.preventDefault();if(!e.repeat&&!submit.disabled)form.requestSubmit(submit);
    });
    form.addEventListener('submit',e=>{
      e.preventDefault();
      if(openChange!==anchor || submit.disabled || !input.value.trim())return;
      const {blockId,cellId,start,end,quote}=anchor;
      void action('propose',{blockId,...(cellId?{cellId}:{}),start,end,quote,instruction:input.value.trim()});
    });
    feed.append(form);updateRequestControls(form);composer.fit(input);
  }
  function renderFeed(){
    const r=current(),doc=r?.doc; if(!state.opened||state.mode!=='editor'||!doc){feed.replaceChildren();return;}
    const proposal=doc.proposal,job=doc.job;
    // Do not recreate a focused instruction field or a native text range on an autosave response.
    const signature=JSON.stringify([r.id,proposal?.id,proposal?.status,job?.id,job?.state,r.conflict?1:0,openChange?openChange.blockId:null,selected]);
    if(feed.dataset.signature===signature&&(feed.childElementCount||!signature))return;
    feed.dataset.signature=signature;feed.replaceChildren();
    panel.querySelectorAll('.hd-suggestion').forEach(el=>el.remove());
    if(proposal){
      const box=make('section','hd-suggestion');box.setAttribute('aria-label','Propuesta de cambio');box.append(make('strong',null,proposal.status==='stale'?'La selección cambió':'Propuesta del asistente'),make('p','hd-sub',proposal.status==='stale'?'Tu texto sigue intacto. Descarta la propuesta y vuelve a seleccionar.':proposal.note));
      const line=(name,tag,text)=>{const d=make('div','hd-diff');d.append(make('b',null,name),make(tag,null,text||'Eliminar este texto'));return d;};
      box.append(line('Antes','del',proposal.before),line('Después','ins',proposal.after));
      const controls=make('div','hd-inline');controls.append(button('Descartar',()=>action('resolve',{proposalId:proposal.id,decision:'discard'})));
      if(proposal.status==='pending')controls.append(button('Aplicar cambio',()=>action('resolve',{proposalId:proposal.id,decision:'apply'}),'hd-primary'));
      box.append(controls);const target=[...sheet.querySelectorAll('.hd-block')].find(e=>e.dataset.block===proposal.blockId);if(target)target.after(box);else endNotice?.append(box);
      const b=button('Ver propuesta',()=>{box.scrollIntoView({block:'nearest'});box.querySelector('button')?.focus({preventScroll:true});},'hd-primary');feed.append(make('span',null,proposal.status==='stale'?'Propuesta desactualizada':'Propuesta lista'),b);return;
    }
    if(job?.state==='running'){const b=make('p','hd-job',job.action==='propose'?'Preparando una propuesta… Puedes seguir escribiendo.':'Revisando la versión guardada…');b.setAttribute('role','status');feed.append(b);return;}
    if(openChange){requestComposer();return;}
    if(selected&&!r.conflict){const b=button('✧ Pedir cambio',askSelection,'hd-primary');b.id='hd-ask';feed.append(make('span',null,'El cambio solo afecta a la selección'),b);return;}
    if(job?.state==='failed'){const p=make('p','hd-sub',job.error||'No se pudo revisar.');p.setAttribute('role','status');feed.append(p);}
    else feed.append(make('span','hd-hint','Selecciona texto y pulsa «Pedir cambio». Tú decides si se aplica.'));
  }
  function renderHistory(r){
    sheet.append(make('p','hd-eyebrow','REVISIONES'),make('h2',null,'Historial'),make('p','hd-sub','Restaurar crea otra versión. Las anteriores no cambian.'));
    for(const h of r.doc.history||[]){const row=make('div','hd-history-row'),s=make('div');s.append(make('strong',null,'v'+h.revision+' · '+h.actor),make('span','hd-sub',new Date(h.updatedAt).toLocaleString('es-ES',{dateStyle:'short',timeStyle:'short'})));row.append(s);
      if(h.revision!==r.doc.revision)row.append(button('Restaurar',()=>{setNotice('¿Crear un borrador a partir de v'+h.revision+'?',{label:'Confirmar restauración',run:()=>action('restore',{revision:h.revision,structure:2})});}));sheet.append(row);}
  }
  function renderExport(r){
    const doc=r.doc;
    sheet.append(make('p','hd-eyebrow','ENTREGABLES'),make('h2',null,'Exportar v'+doc.revision),make('p','hd-sub','La versión debe quedar conforme para ti y para el asistente. El archivo aparecerá en Entregables de esta conversación.'));
    const statusCard=make('section','hd-approval');
    if(doc.proposal)statusCard.append(make('p',null,'Aplica o descarta la propuesta pendiente antes de cerrar esta versión.'));
    else if(doc.job?.state==='running')statusCard.append(make('p',null,'El asistente está revisando la versión…'));
    else if(doc.review?.verdict==='approved'&&doc.review.hash===doc.hash){
      statusCard.append(make('strong',null,'Asistente: conforme'),make('p',null,doc.review.note));
      if(doc.approval?.hash===doc.hash)statusCard.append(make('strong',null,'Tú: conforme'));
      else statusCard.append(button('Dar mi conformidad a v'+doc.revision,()=>{if(r.dirty){setNotice('Guarda los cambios y pide la revisión de la versión actual.');return;}setNotice('Confirmas el contenido exacto de esta versión.',{label:'Confirmar v'+doc.revision,run:()=>action('approve',{expected:doc.hash})});},'hd-primary'));
    }else{
      if(doc.review?.verdict==='changes')statusCard.append(make('strong',null,'El asistente sugiere revisar'),make('p',null,doc.review.note));
      if(doc.job?.error)statusCard.append(make('p','hd-sub',doc.job.error));
      statusCard.append(button('Pedir revisión al asistente',()=>action('review'),'hd-primary'));
    }
    sheet.append(statusCard);
    if(doc.approval?.hash===doc.hash){
      const row=make('div','hd-inline');for(const f of doc.formats||['pdf','docx','md'])if(formats[f])row.append(button('Generar '+formats[f],()=>action('export',{format:f}),'hd-primary'));
      sheet.append(row);
    }
  }
  function artifactHref(id){const q=new URLSearchParams({agent:state.scope.agent,key:state.scope.key,id});return '/api/artifact-download?'+q;}
  function announceExport(artifact){window.dispatchEvent(new CustomEvent('hub-documents-export',{detail:{artifact,scope:state.scope}}));}
  function showExport(artifact){
    setNotice('Ya disponible en Entregables.');const link=make('a','hd-download','Descargar '+artifact.fileName);link.href=artifactHref(artifact.id);link.download=artifact.fileName;
    const row=make('div','hd-inline');row.append(link,button('Ver en el chat',()=>{refreshOnClose=true;close();if(state.opened)return;const node=$('hub-artifacts');if(node){node.open=true;node.querySelector('summary')?.focus({preventScroll:true});node.scrollIntoView({block:'nearest'});}}));notice.append(row);
  }
  window.HubDocuments=Object.freeze({context,seed,open,close,importArtifact});
  refreshLayout();
})();
