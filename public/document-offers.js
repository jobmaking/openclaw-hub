'use strict';
(() => {
  const $=id=>document.getElementById(id);
  const area=$('hub-document-offers');
  if(!area)return;
  const modes=new Set(['open','draft']), states=new Set(['ready','failed','running']);
  const pages=new Map();let key='',scope=null,timer,requested=0,load=null,active=null;
  const same=k=>scope!==null&&key===k;
  const identity=c=>c?.enabled && c.user && c.agent && c.key && c.sessionId ? JSON.stringify([c.user,c.agent,c.key,c.sessionId]):'';
  const recordOk=r=>r && /^[a-f0-9-]{36}$/u.test(r.id) && modes.has(r.kind) && states.has(r.state) && typeof r.title==='string' && r.title.length<=160;
  async function request(c,path='',body,signal){
    const query=new URLSearchParams({agent:c.agent,key:c.key,sessionId:c.sessionId});
    const res=await fetch('/api/documents/chat-offers'+path+'?'+query,{credentials:'same-origin',cache:'no-store',signal,
      ...(body?{method:'POST',headers:{'Content-Type':'application/json','X-Hub-Documents':'1'},body:JSON.stringify(body)}:{})});
    const data=await res.json().catch(()=>({}));
    if(!res.ok){const err=new Error(res.status===401?'Vuelve a iniciar sesión.':data.error||'No se pudieron consultar las tarjetas de Documentos');err.status=res.status;throw err;}
    return data;
  }
  const local=()=>pages.get(key)||[];
  function render(){
    if(!scope){area.replaceChildren();area.hidden=true;return;}
    const records=local(), count=records.length;
    area.hidden=!count;
    const keep=new Set();
    for(const offer of records){
      if(!recordOk(offer))continue;
      const sig=JSON.stringify([offer.id,offer.kind,offer.state,offer.title]);
      let card=Array.from(area.children).find(n=>n.dataset.signature===sig);
      if(!card){
        card=document.createElement('article');card.className='hub-doc-offer';card.dataset.signature=sig;
        const text=document.createElement('div'), label=document.createElement('small'), title=document.createElement('strong');
        label.textContent=offer.state==='failed'?'DOCUMENTOS · NO COMPLETADO':offer.state==='running'?'DOCUMENTOS · REDACTANDO':'DOCUMENTOS';
        title.textContent=offer.state==='failed'?'No se pudo redactar. Puedes pedirlo de nuevo.':offer.title;text.append(label,title);card.append(text);
        if(offer.state==='ready'){
          const b=document.createElement('button');b.type='button';b.textContent=offer.kind==='open'?'Abrir documento':'Abrir borrador';
          const captured=key;const status=document.createElement('span');status.className='hub-doc-offer-result';status.setAttribute('role','status');
          b.addEventListener('click',async()=>{
            if(!same(captured)||b.disabled)return;
            b.disabled=true;status.textContent='';
            try{const result=await load?.(offer);if(result===false&&same(captured))status.textContent='Ya hay un borrador abierto; sigue la indicación del editor.';}
            catch(e){if(same(captured))status.textContent=e.message||'No se pudo abrir el documento.';}
            finally{if(same(captured))b.disabled=false;}
          });card.append(b,status);
        }
        area.append(card);
      }
      keep.add(card);
    }
    for(const node of Array.from(area.children))if(!keep.has(node))node.remove();
  }
  function upsert(offer){
    if(!recordOk(offer))return;
    pages.set(key,[...local().filter(x=>x.id!==offer.id),offer].sort((a,b)=>a.createdAt-b.createdAt).slice(-12));render();
  }
  function detach(){++requested;active?.abort();active=null;clearTimeout(timer);}
  async function refresh(attempt=0){
    if(!scope)return;
    const prev=key,result=++requested;active?.abort();const abort=active=new AbortController();
    try{const data=await request(scope,'',null,abort.signal);if(!same(prev)||result!==requested)return;
      pages.set(key,Array.isArray(data.offers)?data.offers.filter(recordOk).slice(-12):[]);render();
      if(local().some(o=>o.state==='running')&&attempt<27)timer=setTimeout(()=>refresh(attempt+1),attempt<6?1250:3800);
    }catch(e){if(same(prev)&&result===requested){if(e.status===401||e.status===403||e.status===409){pages.delete(key);render();}
      else if(e.name!=='AbortError'&&attempt<3&&local().some(o=>o.state==='running'))timer=setTimeout(()=>refresh(attempt+1),4000);}}
  }
  function context(next){
    const k=identity(next);if(key===k)return;
    const previous=scope?.user;detach();
    if(!next?.user||previous&&previous!==next.user)pages.clear();
    area.replaceChildren();key=k;scope=k?next:null;while(pages.size>12)pages.delete(pages.keys().next().value);render();
    if(scope)void refresh();
  }
  async function submit(text,opId,destination){
    if(!scope)return null;
    const prev=key,c=scope,result=await request(c,'',{text,opId,...(destination?{destination}:{})});
    if(!same(prev))return null;
    detach();upsert(result.offer);void refresh();return result.offer;
  }
  window.HubDocumentOffers=Object.freeze({context,submit,setup(fn){load=fn;}});
})();
