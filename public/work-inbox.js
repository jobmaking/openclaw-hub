/* One workspace for decisions, real deliveries and work in progress. */
'use strict';
(() => {
  const $=id=>document.getElementById(id);
  const dialog=$('work-inbox'), list=$('work-list'), panel=$('work-panel'), info=$('work-status');
  if(!dialog)return;
  const refresh=$('work-refresh'), closeButton=$('work-close'), filter=$('work-filter'), search=$('work-search');
  const overview=$('work-overview'), reader=$('work-reader'), back=$('work-reader-back'), more=$('work-reader-options-button');
  if(!overview||!reader)return;
  const agentPicker=$('work-agent'), guide=$('work-guide');
  if(!agentPicker||!guide)return;
  const options=$('work-reader-options'), fileTitle=$('work-reader-title'), fileOrigin=$('work-reader-origin'), fullName=$('work-reader-full-name');
  const download=$('work-reader-download'), chat=$('work-reader-chat'), retry=$('work-reader-retry');
  const previous=$('work-reader-prev'), next=$('work-reader-next'), position=$('work-reader-position');
  const content={scroll:$('work-reader-body'),status:$('work-reader-status'),tools:$('work-reader-tools'),download};
  const tabs=[...dialog.querySelectorAll('[role=tab]')];
  const groups=['attention','review','active'];
  let callbacks={}, account=null, current='review', questionItems=[], model=null, note='', refreshProblem='', loading=false;
  let request=null, action=null, view=null, timer=null, touched=false, dirty=false, navigationId=null, opener=null, updated=0, pressed=false, renderPending=false;
  let pendingBack=null, closeAfterBack=null, readerSequence=0;
  let selectedAgent='', allowedAgents=new Map();
  let visited=false, seekPosition=null;
  const positions=new Map();
  const format=new Intl.DateTimeFormat('es',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'});
  const keyOf=(e,kind)=>JSON.stringify([kind,e.agent,e.key,e.sessionId,e.file?.id||e.runId||'']);
  const el=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};
  function btn(title,call,cls='work-action'){
    const node=el('button',cls,title);node.type='button';node.addEventListener('click',call);return node;
  }
  const speaker=id=>callbacks.name?.(id)||id;
  const fold=str=>String(str||'').normalize('NFD').replace(/\p{M}/gu,'').toLocaleLowerCase('es');
  const icon=kind=>{
    const n=document.createElementNS('http://www.w3.org/2000/svg','svg');n.classList.add('work-icon');n.setAttribute('viewBox','0 0 24 24');n.setAttribute('aria-hidden','true');
    const p=document.createElementNS(n.namespaceURI,'path');p.setAttribute('d',kind==='review'?'M7 3h7l5 5v13H5V3zm7 0v6h5M8 13h8m-8 4h6':kind==='active'?'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18zm0 4v5l3 2':'M12 3a8 8 0 0 1 8 8c0 5-4 8-8 8H4l2-4a8 8 0 0 1 6-12zm0 12v.01M10 9a2 2 0 1 1 2 2v1');n.append(p);return n;
  };
  const setControl=(node,id,action)=>{node.dataset.workControl=JSON.stringify([id,action]);return node;};
  const findControl=id=>id&&[...list.querySelectorAll('[data-work-control]')].find(e=>e.dataset.workControl===id);
  function restoreControl(id){
    (findControl(id)||tabs[groups.indexOf(current)]).focus({preventScroll:true});
  }
  function listPosition(){
    const scroll=panel.scrollTop, top=panel.getBoundingClientRect().top;
    const anchor=scroll>0?[...list.querySelectorAll('.work-card-main')].find(node=>node.getBoundingClientRect().bottom>top):null;
    return {scroll,control:anchor?.dataset.workControl,offset:anchor?anchor.getBoundingClientRect().top-top:0};
  }
  function place(position){
    panel.scrollTop=position.scroll;
    const anchor=findControl(position.control);
    if(anchor)panel.scrollTop+=anchor.getBoundingClientRect().top-panel.getBoundingClientRect().top-position.offset;
  }
  function savePosition(){
    if(!seekPosition&&(model||current==='attention'))positions.set(current,view?.position||listPosition());
  }
  function forgetView(){
    visited=false;seekPosition=null;positions.clear();search.value='';panel.scrollTop=0;
  }
  function agentIdentity(id){
    const name=speaker(id), picture=allowedAgents.get(id)?.emoji;
    const mark=picture||[...name.trim()].slice(0,2).join('').toLocaleUpperCase('es')||'·';
    const owner=el('span','work-agent-identity');
    const avatar=el('span','work-agent-avatar',mark);avatar.setAttribute('aria-hidden','true');
    owner.append(avatar,el('strong','work-agent-name',name));
    return owner;
  }
  function sessionRow({agent,id,title,when,badge,activate,actions=[],verb}){
    const card=el('div','work-card work-session');card.setAttribute('role','listitem');
    const first=setControl(btn('',activate,'work-card-main'),id,'main');
    const description=el('span','work-description');
    const details=el('span','work-session-details');
    if(badge)details.append(el('span','work-tag '+badge.style,badge.text));
    if(when)details.append(el('span','work-meta',when));
    description.append(el('strong','work-label',title),details);
    const action=el('span','work-row-verb',verb);action.setAttribute('aria-hidden','true');
    first.append(agentIdentity(agent),description,action);
    first.setAttribute('aria-label',verb+' · '+title+' · '+speaker(agent));
    first.setAttribute('aria-description',[badge?.text,when].filter(Boolean).join(' · '));
    card.append(first);
    if(actions.length){const parts=el('div','work-card-actions');parts.append(...actions);card.append(parts);}
    return card;
  }
  function sessionLine(item){return speaker(item.agent)+' · '+item.title;}
  const inScope=id=>allowedAgents.has(id)&&(!selectedAgent||selectedAgent===id);
  function syncCatalog(){
    const source=callbacks.agents?.();
    const agents=new Map((Array.isArray(source)?source:[]).filter(a=>typeof a?.id==='string'&&a.id).map(a=>[
      a.id,{name:speaker(a.id),emoji:typeof a.emoji==='string'?a.emoji.trim():''},
    ]));
    const lost=view?.items.some(item=>!agents.has(item.agent));
    allowedAgents=agents;
    if(selectedAgent&&!agents.has(selectedAgent)){
      selectedAgent='';positions.clear();seekPosition={scroll:0};search.value='';
    }
    const choices=[['','Todos mis agentes'],...[...agents].map(([id,a])=>[id,a.name]).sort((a,b)=>a[1].localeCompare(b[1],'es')||a[0].localeCompare(b[0]))];
    if(choices.length!==agentPicker.options.length||choices.some(([id,name],index)=>{
      const option=agentPicker.options[index];return option.value!==id||option.textContent!==name;
    })){
      agentPicker.replaceChildren(...choices.map(([id,name])=>new Option(name,id)));
    }
    if(agentPicker.value!==selectedAgent)agentPicker.value=selectedAgent;
    if(lost){
      view.position={scroll:0};endPreview(view);
    }
  }
  function resetCatalog(){
    forgetView();selectedAgent='';allowedAgents.clear();agentPicker.replaceChildren(new Option('Todos mis agentes',''));
  }
  const formats={pdf:'PDF',xlsx:'Excel',docx:'Word',image:'Imagen',video:'Vídeo'};
  function formatName(file){
    const extension=file?.title?.match(/[.]([a-z0-9]{1,8})$/i)?.[1];
    return formats[callbacks.previewKind?.(file)]||(extension?extension.toUpperCase():'Archivo');
  }
  function filtered(deliveries){
    const terms=fold(search.value.trim()).split(/\s+/u).filter(Boolean);
    return deliveries.filter(item=>inScope(item.agent)&&(!terms.length||terms.every(word=>fold(item.file.title+' '+sessionLine(item)).includes(word))));
  }
  function fileRow(item){
    const id=keyOf(item,'file'), kind=item.canDownload&&callbacks.previewKind?.(item.file), readable=Boolean(kind);
    const verb=kind==='video'?'Ver vídeo':kind==='image'?'Ver imagen':readable?'Leer':'Opciones';
    const card=el('div','work-card work-file');card.setAttribute('role','listitem');
    const first=setControl(btn('',event=>showReader(item,event.currentTarget),'work-card-main'),id,'main');
    const label=el('span','work-file-action'+(readable?' work-file-read':''),verb);
    first.setAttribute('aria-label',(readable?verb:'Ver opciones')+' · '+item.file.title+' · '+sessionLine(item));
    const description=el('span','work-description'), fileFormat=el('b','work-file-format',formatName(item.file));
    const owner=el('strong','work-file-owner',speaker(item.agent));owner.title=speaker(item.agent);
    const source=el('span','work-file-source',item.title);source.title=item.title;
    const meta=el('span','work-meta');meta.append(owner,fileFormat);
    description.append(el('strong','work-label',item.file.title),meta,source);
    first.append(description,label);card.append(first);return card;
  }
  const tags={waiting:['Esperando archivo','active'],settling:['Comprobando entrega','active'],missing:['Falta la entrega','warn'],
    interrupted:['Turno interrumpido','warn'],unverified:['Sin confirmar','muted'],delivered:['Archivo entregado','ready']};
  function render() {
    if(!dialog.open)return;
    if(pressed||view){renderPending=true;return;}renderPending=false;
    const before=listPosition();
    const deliveries=(model?.deliveries||[]).filter(item=>inScope(item.agent));
    const tracks=(model?.following||[]).filter(item=>inScope(item.agent)), active=(model?.active||[]).filter(item=>inScope(item.agent));
    const attention=questionItems.filter(item=>inScope(item.agentId));
    const trackKeys=new Set(tracks.map(item=>keyOf(item,'run')));
    const untracked=active.filter(item=>!trackKeys.has(keyOf(item,'run')));
    const counts=[attention.length,deliveries.length,untracked.length+tracks.filter(e=>e.status!=='delivered').length];
    panel.setAttribute('aria-labelledby','work-tab-'+current);
    for(let i=0;i<tabs.length;i++){
      const tab=tabs[i], selected=current===groups[i];
      tab.setAttribute('aria-selected',String(selected));tab.tabIndex=selected?0:-1;
      const number=tab.querySelector('b'), text=counts[i]?String(counts[i]):'';
      if(number.textContent!==text)number.textContent=text;
      number.hidden=!text;
    }
    const hasQuery=Boolean(search.value.trim());
    filter.hidden=current!=='review'||!(deliveries.length||hasQuery);
    const files=current==='review'?filtered(deliveries):[];
    guide.textContent=current==='attention'?'Preguntas y permisos que esperan tu respuesta.':current==='active'?
      (untracked.some(item=>item.trackable)?'«Seguir entrega» comprueba si el encargo deja un archivo.':'Chats activos y encargos que sigues.'):
      files.some(item=>item.canDownload&&['image','video'].includes(callbacks.previewKind?.(item.file)))?'Abre documentos, imágenes y vídeos sin salir del HUB.':
      files.some(item=>item.canDownload&&callbacks.previewKind?.(item.file))?'Elige «Leer» para abrir un archivo.':'';
    guide.hidden=!guide.textContent;
    const restored=document.activeElement?.dataset.workControl;
    const parts=[];
    if(current==='attention'){
      for(const item of attention){
        const title=item.questions?.[0]?.question||item.questions?.[0]?.title||item.title||(item.kind==='approval'?'Permiso solicitado':'Pregunta del agente');
        parts.push(sessionRow({agent:item.agentId,id:callbacks.pendingKey(item),title,verb:item.kind==='approval'?'Ver permiso':'Ver pregunta',
          badge:{text:item.kind==='approval'?'Permiso':item.kind==='async'?'Pregunta opcional':'Tu respuesta',style:'ready'},activate:()=>chooseQuestion(item)}));
      }
    } else if(current==='review'){
      parts.push(...files.map(fileRow));
    } else {
      const sections=[['Chats activos',untracked,false],['Entregas que sigo',tracks,true]];
      for(const [heading,items,tracked] of sections){
        if(!items.length)continue;
        const section=el('div','work-group-title',heading);section.setAttribute('role','presentation');parts.push(section);
        for(const item of items){
          const state=tags[item.status]||['En curso','active'];
          const when=item.updatedAt?format.format(item.updatedAt):'';
          const button=tracked?btn('Dejar de seguir',event=>follow(item,'untrack',event.currentTarget)):
            item.trackable?btn('Seguir entrega',event=>follow(item,'track',event.currentTarget)):null;
          if(button){setControl(button,keyOf(item,'run'),tracked?'untrack':'track');button.setAttribute('aria-label',button.textContent+' · '+item.title+' · '+speaker(item.agent));}
          parts.push(sessionRow({agent:item.agent,id:keyOf(item,'run'),title:item.title,when,verb:'Abrir chat',
            badge:{text:state[0],style:state[1]},activate:()=>choose(item),actions:button?[button]:[]}));
        }
      }
    }
    if(!parts.length){
      const empty=current==='attention'?(selectedAgent?['Sin pendientes de '+speaker(selectedAgent),'El filtro solo muestra las solicitudes de este agente.']:['Nada necesita tu respuesta','Aquí aparecerán las preguntas y permisos.']):
        loading&&!model?['Consultando tus agentes…','Puedes cambiar de vista mientras se actualiza.']:
        refreshProblem&&!model?['Sin datos de la bandeja','Usa Actualizar para volver a intentarlo.']:
        current==='review'?(hasQuery?['Sin coincidencias','Busca por nombre de archivo, asunto o agente.']:
          ['No hay archivos recientes',selectedAgent?'No se encontraron archivos recientes de '+speaker(selectedAgent)+'.':'Aquí aparecerán los archivos que te entreguen tus agentes.']):
          ['Nada en curso',selectedAgent?'No se encontraron trabajos activos de '+speaker(selectedAgent)+'.':'Aquí aparecerán las conversaciones activas y las entregas que sigues.'];
      const n=el('div','work-empty');n.setAttribute('role','listitem');n.append(icon(current),el('strong',null,empty[0]),el('span',null,empty[1]));parts.push(n);
    }
    const outside=selectedAgent?questionItems.filter(item=>allowedAgents.has(item.agentId)&&item.agentId!==selectedAgent).length:0;
    if(current==='attention'&&outside){
      const entry=el('div','work-other-attention');entry.setAttribute('role','listitem');
      entry.append(btn(outside===1?'Ver 1 pendiente de otro agente':'Ver '+outside+' pendientes de otros agentes',()=>{
        setAgent('');list.querySelector('.work-card-main')?.focus();
      }));parts.push(entry);
    }
    // Keep the controls if a refresh returned the same view.
    const changed=parts.length!==list.children.length||parts.some((node,i)=>!node.isEqualNode(list.children[i]));
    if(changed)list.replaceChildren(...parts);
    const hints=[];
    if(loading&&model)hints.push('Actualizando…');
    if(note)hints.push(note);
    if(refreshProblem)hints.push(refreshProblem);
    else if(model?.partial)hints.push('Vista parcial: no se pudieron consultar todos los agentes o archivos.');
    if(model&&current==='review')hints.push((hasQuery?files.length+(files.length===1?' coincidencia · ':' coincidencias · '):'')+'Últimos '+model.windowDays+' días'+(model.more?' · lista limitada':'')+'.');
    if(info.textContent!==hints.join(' '))info.textContent=hints.join(' ');
    info.classList.toggle('work-status-warning',Boolean(refreshProblem));
    refresh.setAttribute('aria-disabled',String(loading));refresh.setAttribute('aria-busy',String(loading));
    if(seekPosition){
      // Loading and transient errors have no rows to restore yet.
      if(model||current==='attention'){place(seekPosition);seekPosition=null;}
    }else if(changed)place(before);
    if(changed&&restored)restoreControl(restored);
  }
  async function update(force=false){
    if(!account||!dialog.open||document.hidden||request||action||view)return;
    if(!force&&Date.now()-updated<12000)return;
    const key=account, controller=request=new AbortController();
    clearTimeout(timer);dirty=false;loading=true;note='';render();
    try{
      const response=await fetch('/api/work-inbox',{cache:'no-store',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(11000)])});
      if(controller!==request||account!==key)return;
      if([401,403].includes(response.status)){
        model=null;questionItems=[];forgetView();
        refreshProblem=response.status===401?'Tu sesión ha caducado. Vuelve a iniciar sesión.':'Ya no tienes acceso a Mi trabajo.';
        endPreview(view);
        return;
      }
      if(!response.ok)throw Error('snapshot unavailable');
      const data=await response.json();
      if(controller!==request||account!==key)return;
      if(!Array.isArray(data.deliveries)||!Array.isArray(data.active)||!Array.isArray(data.following))throw Error('No se pudo leer la bandeja');
      model=data;refreshProblem='';
    }catch(error){if(controller===request&&account===key){
      refreshProblem=(error.name==='TimeoutError'?'La consulta tardó demasiado.':'No se pudo actualizar Mi trabajo.')+
        (model?' Se muestran los últimos datos disponibles.':'');
    }}
    finally{if(controller===request){request=null;loading=false;updated=Date.now();render();schedule();}}
  }
  function schedule(){
    clearTimeout(timer);
    if(!dialog.open||document.hidden||view||request)return;
    const delay=dirty?Math.max(1400,updated+12000-Date.now()):25000;
    timer=setTimeout(()=>{if(action){schedule();return;}void update();},delay);
  }
  function frame(){
    const v=window.visualViewport;
    if(!dialog.open||!v||Math.abs(v.scale-1)>.02)return;
    dialog.style.setProperty('--work-visible-h',Math.round(v.height)+'px');
    dialog.style.setProperty('--work-visible-top',Math.round(v.offsetTop)+'px');
    dialog.classList.toggle('work-compact',v.height<420);
  }
  function close(restore=true){
    if(!dialog.open)return;
    savePosition();
    const front=view?.marker;
    endPreview(view,{restore:false,rewind:false});
    clearTimeout(timer);request?.abort();request=null;action?.abort();action=null;
    dialog.close();pressed=renderPending=false;list.replaceChildren();panel.scrollTop=0;model=null;loading=false;note=refreshProblem='';seekPosition=null;
    const marker=navigationId;navigationId=null;
    if(marker&&history.state?.hubWork===marker){
      if(pendingBack)closeAfterBack=marker;
      else if(front&&history.state?.hubWorkPreview===front)history.go(-2);
      else history.back();
    }
    if(restore&&opener?.getClientRects().length)opener.focus({preventScroll:true});
  }
  function open(from=document.activeElement){
    if(!account||dialog.open||closeAfterBack)return;
    syncCatalog();opener=from;questionItems=callbacks.questions?.()||[];
    if(!visited)current=questionItems.some(item=>inScope(item.agentId))?'attention':'review';
    seekPosition=positions.get(current)||null;
    updated=0;dirty=true;touched=visited;visited=true;
    const hasChat=callbacks.hasChat?.()!==false;
    closeButton.textContent=hasChat?'← Chat':'Cerrar';
    closeButton.setAttribute('aria-label',hasChat?'Volver al chat':'Cerrar Mi trabajo');
    dialog.showModal();frame();closeButton.focus({preventScroll:true});
    if(matchMedia('(max-width: 820px), (pointer: coarse)').matches){
      navigationId=String(Date.now());history.pushState({...history.state,hubWork:navigationId},'');
    }
    if(document.hidden)render();else void update(true);
  }
  function endPreview(value,{restore=true,rewind=true}={}){
    if(!value||view!==value)return;
    view=null;value.controller?.abort();
    if(value.chatAction&&action===value.chatAction){action.abort();action=null;}
    clearReader();fileTitle.textContent=fileOrigin.textContent=fullName.textContent=position.textContent='';
    reader.hidden=true;overview.hidden=false;dialog.setAttribute('aria-labelledby','work-title');
    if(rewind&&value.marker&&history.state?.hubWorkPreview===value.marker){pendingBack=value.marker;history.back();}
    if(restore&&dialog.open){seekPosition=value.position;render();restoreControl(value.control);schedule();}
  }
  function rememberReader(value){
    if(value.marker||pendingBack||!navigationId||history.state?.hubWork!==navigationId)return;
    value.marker=navigationId+'-reader-'+(++readerSequence);
    history.pushState({...history.state,hubWorkPreview:value.marker},'');
  }
  function expandOptions(open){
    options.hidden=!open;more.setAttribute('aria-expanded',String(open));
  }
  function clearReader(){
    content.scroll.replaceChildren();content.scroll.scrollTo(0,0);content.scroll.classList.remove('av-pdf');
    content.scroll.setAttribute('aria-label','Contenido del archivo');
    content.tools.hidden=true;content.tools.replaceChildren();
    content.status.textContent='';content.status.classList.remove('av-error');
    download.hidden=chat.hidden=retry.hidden=true;
    download.removeAttribute('href');download.removeAttribute('download');expandOptions(false);
  }
  function readerStatus(message,error=false){
    content.status.textContent=message;content.status.classList.toggle('av-error',error);
  }
  function showReader(item,source){
    if(view||action||!callbacks.readPreview)return;
    const items=filtered(model?.deliveries||[]), index=items.findIndex(row=>keyOf(row,'file')===keyOf(item,'file'));
    if(index<0)return;
    const value=view={items,index,controller:null,control:source.dataset.workControl,position:listPosition(),marker:null,chatAction:null};
    clearTimeout(timer);note='';touched=true;search.blur();
    rememberReader(value);
    overview.hidden=true;reader.hidden=false;dialog.setAttribute('aria-labelledby','work-reader-title');
    void readFile(value,index);
    back.focus({preventScroll:true});
  }
  async function readFile(value,index){
    if(view!==value||action||index<0||index>=value.items.length)return;
    value.controller?.abort();
    const controller=value.controller=new AbortController(), {signal}=controller;
    const item=value.items[index];value.index=index;
    const live=()=>view===value&&value.controller===controller&&!signal.aborted;
    clearReader();
    fileTitle.textContent=fullName.textContent=item.file.title;
    fileOrigin.textContent=formatName(item.file)+' · '+sessionLine(item);
    position.textContent=(index+1)+' de '+value.items.length;
    previous.setAttribute('aria-disabled',String(index===0));next.setAttribute('aria-disabled',String(index===value.items.length-1));
    readerStatus('Abriendo el archivo…');
    try{
      const target=await callbacks.readPreview(item,signal);
      if(!live())return;
      chat.hidden=false;
      if(target.link){download.href=target.link;download.download=target.name;download.hidden=false;}
      if(!target.kind||!target.link){
        readerStatus(target.link?'Este formato no se puede leer aquí. Puedes descargar el original.':'Para consultar este archivo, abre el chat de origen.');
        expandOptions(true);return;
      }
      await callbacks.renderPreview(target,{...content,onUnavailable(){if(live())chat.hidden=true;}},signal);
    }catch(error){
      if(!live())return;
      const denied=[401,403,404,409].includes(error.status);
      readerStatus(denied?error.message:error.name==='TimeoutError'?'La consulta tardó demasiado. Puedes reintentar o pasar al siguiente archivo.':
        'No se pudo abrir este archivo. Puedes reintentar o pasar al siguiente.',true);
      retry.hidden=denied;
    }
  }
  async function choose(item,fromReader=null){
    if(action||view!==fromReader)return;
    const controller=action=new AbortController();
    if(fromReader){fromReader.chatAction=controller;readerStatus('Abriendo el chat de origen…');}
    else{note='Abriendo la conversación…';info.textContent=note;}
    try{
      const shown=await callbacks.openItem(item,AbortSignal.any([controller.signal,AbortSignal.timeout(14000)]));
      if(action!==controller)return;
      close(false);shown?.();
    }catch(error){if(action===controller){
      const message=error.name==='AbortError'?'No se cambió de conversación.':error.name==='TimeoutError'?'La conversación tardó demasiado en responder.':error.message;
      if(fromReader)readerStatus(message,true);else{note=message;render();}
    }}
    finally{if(action===controller)action=null;}
  }
  function chooseQuestion(item){if(view)return;close(false);callbacks.openQuestion(item).catch(()=>callbacks.toast('No se pudo abrir la solicitud.'));}
  async function follow(item, next, source){
    if(action)return;
    const controller=action=new AbortController();source.disabled=true;
    const {agent,key,sessionId,runId}=item;
    try{
      const resp=await fetch('/api/work-inbox/track',{method:'POST',cache:'no-store',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(8000)]),
        headers:{'Content-Type':'application/json','X-Hub-Work':'1'},body:JSON.stringify({agent,key,sessionId,runId,action:next})});
      const body=await resp.json();if(!resp.ok)throw Error(body.error||'No se confirmó el seguimiento');
      if(action===controller){action=null;await update(true);tabs[2].focus({preventScroll:true});}
    }catch(error){if(action===controller){note=error.name==='TimeoutError'?'Seguimiento sin confirmar. Actualiza para comprobarlo.':error.message;render();}}
    finally{source.disabled=false;if(action===controller)action=null;}
  }
  function tab(kind,focus){
    if(!groups.includes(kind))return;
    if(current!==kind){savePosition();current=kind;seekPosition=positions.get(kind)||{scroll:0};panel.scrollTop=0;}
    touched=true;render();if(focus)tabs[groups.indexOf(kind)].focus({preventScroll:true});
  }
  function setAgent(value){
    const next=allowedAgents.has(value)?value:'';
    if(next===selectedAgent)return;
    selectedAgent=agentPicker.value=next;touched=true;positions.clear();seekPosition={scroll:0};panel.scrollTop=0;render();
  }
  tabs.forEach((n,index)=>{
    n.addEventListener('click',()=>tab(groups[index],true));
    n.addEventListener('keydown',event=>{
      const offset={ArrowLeft:-1,ArrowRight:1}[event.key];
      const next=event.key==='Home'?0:event.key==='End'?2:offset?(index+offset+3)%3:null;
      if(next!==null){event.preventDefault();tab(groups[next],true);}
    });
  });
  filter.addEventListener('submit',event=>{event.preventDefault();search.blur();});
  search.addEventListener('input',()=>{touched=true;positions.delete('review');seekPosition={scroll:0};panel.scrollTop=0;render();});
  agentPicker.addEventListener('change',()=>setAgent(agentPicker.value));
  back.addEventListener('click',()=>endPreview(view));
  more.addEventListener('click',()=>expandOptions(options.hidden));
  previous.addEventListener('click',()=>{if(view)void readFile(view,view.index-1);});
  next.addEventListener('click',()=>{if(view)void readFile(view,view.index+1);});
  retry.addEventListener('click',()=>{if(view){back.focus({preventScroll:true});void readFile(view,view.index);}});
  chat.addEventListener('click',()=>{if(view&&!chat.hidden)void choose(view.items[view.index],view);});
  list.addEventListener('pointerdown',()=>{pressed=true;});
  const release=()=>{if(!pressed)return;pressed=false;if(renderPending)setTimeout(render,0);};
  window.addEventListener('pointerup',release);window.addEventListener('pointercancel',release);window.addEventListener('blur',release);
  closeButton.addEventListener('click',()=>close());refresh.addEventListener('click',()=>void update(true));
  dialog.addEventListener('cancel',event=>{event.preventDefault();if(view)endPreview(view);else close();});
  dialog.addEventListener('click',event=>{if(event.target===dialog){const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)close();}});
  window.visualViewport?.addEventListener('resize',frame,{passive:true});window.visualViewport?.addEventListener('scroll',frame,{passive:true});
  window.addEventListener('popstate',()=>{
    if(pendingBack&&history.state?.hubWorkPreview!==pendingBack)pendingBack=null;
    if(closeAfterBack&&!pendingBack){
      const marker=closeAfterBack;closeAfterBack=null;
      if(history.state?.hubWork===marker)history.back();
    }
    if(!dialog.open||!navigationId)return;
    if(history.state?.hubWork!==navigationId)close();
    else if(view?.marker&&history.state?.hubWorkPreview!==view.marker)endPreview(view,{rewind:false});
    else if(view&&!view.marker&&!history.state?.hubWorkPreview)rememberReader(view);
  });
  document.addEventListener('visibilitychange',()=>{if(!document.hidden&&dialog.open){frame();void update(true);}else clearTimeout(timer);});
  window.addEventListener('online',()=>void update(true));
  window.HubWorkInbox=Object.freeze({
    init(options){callbacks=options;},
    setAccount(next){if(account!==next){close(false);resetCatalog();account=next||null;questionItems=[];}$('btn-my-work').hidden=!account;},
    enabled:()=>Boolean(account), open,
    reset(){close(false);resetCatalog();account=null;questionItems=[];$('btn-my-work').hidden=true;},
    catalogChanged(){if(dialog.open){syncCatalog();render();}},
    questions(items){
      const wasEmpty=!questionItems.some(item=>inScope(item.agentId));questionItems=items;if(!dialog.open)return;
      if(wasEmpty&&items.some(item=>inScope(item.agentId))&&!touched&&current!=='attention'){
        savePosition();current='attention';seekPosition=positions.get(current)||{scroll:0};
      }
      render();
    },
    invalidate(){if(dialog.open){dirty=true;schedule();}},
    visible:()=>dialog.open,
  });
})();
