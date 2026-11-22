'use strict';
const {randomUUID}=require('node:crypto');
const {parse:intent,titleKey}=require('../public/document-intent');
const {error,plain,signed,snapshot,parse}=require('./documents-store');
const KEEP=30*24*60*60*1000;
const OP=/^[a-zA-Z0-9_-]{1,80}$/;

function createOfferRoutes({editor,target,open}) {
  const row=(db,o,id)=>db.p('SELECT * FROM offers WHERE scope=? AND id=? AND t>=?').get(o.scope,id,Date.now()-KEEP)||error(404,'No se encontró la tarjeta en esta conversación');
  const summary=r=>({id:r.id,kind:r.doc?'open':r.kind,title:r.title,createdAt:r.t,state:r.state==='running'&&!open.has(r.id)?'failed':r.state});
  const list=(db,o)=>({offers:db.p('SELECT id,kind,title,state,t,doc FROM offers WHERE scope=? AND t>=? ORDER BY t DESC,rowid DESC LIMIT 12').all(o.scope,Date.now()-KEEP).reverse().map(summary)});
  function detail(db,o,id){
    const r=row(db,o,id),offer=summary(r);
    if(offer.state==='ready'){
      if(r.doc){const d=db.require(o.scope,r.doc);offer.title=d.title;offer.documentId=d.id;}
      else offer.blocks=parse(r.data).blocks;
    }
    return {offer};
  }
  function request(db,o,data){
    if(data.destination!==undefined&&data.destination!=='document')error(400,'Destino inválido');
    const detected=intent(data.text);
    // Explicit mode is authority from the signed-in UI, not a guess about the prose.
    const cmd=data.destination==='document'?{kind:'draft',query:detected?.kind==='draft'?detected.query:data.text}:detected;
    if(!cmd||!['draft','open'].includes(cmd.kind)||typeof data.opId!=='string'||!OP.test(data.opId))error(400,'Indica qué documento quieres abrir o crear');
    const value=plain(cmd.query,cmd.kind==='open'?160:4000,'Indica el título o un encargo de hasta 4.000 caracteres',{nonempty:true,line:cmd.kind==='open'});
    const sig=signed([cmd.kind,value]);
    return db.atomic(()=>{
      const prior=db.p('SELECT * FROM offers WHERE scope=? AND op=?').get(o.scope,data.opId);
      if(prior){if(prior.signature!==sig || prior.t<Date.now()-KEEP)error(409,'Esa operación ya fue utilizada');const offer=summary(prior);return {status:offer.state==='running'?202:200,offer};}
      const now=Date.now(),id=randomUUID();
      db.p('DELETE FROM offers WHERE scope=? AND t<?').run(o.scope,now-KEEP);
      if(db.p('SELECT count(*) AS n FROM offers WHERE scope=?').get(o.scope).n>=100)error(409,'Esta conversación alcanzó el límite de tarjetas. Usa el panel de Documentos.');
      if(cmd.kind==='open'){
        const name=titleKey(value), matches=db.list(o.scope).filter(d=>titleKey(d.title)===name);
        if(!name||matches.length!==1)error(409,matches.length>1?'Hay varios documentos con ese título. Elige en Documentos.':'No hay un documento con ese título en esta conversación. Puedes ver tus títulos en Documentos.');
        const d=matches[0];
        // Repeated clicks do not append a second card for the same saved document.
        const known=db.p("SELECT * FROM offers WHERE scope=? AND doc=? AND state='ready' ORDER BY t DESC LIMIT 1").get(o.scope,d.id);
        if(known)return {offer:summary(known)};
        db.p('INSERT INTO offers VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,o.scope,data.opId,sig,'open',d.title,null,'ready',now,d.id);
        return {offer:summary(row(db,o,id))};
      }
      if(!editor || editor.available?.(o,'draft')===false)error(503,'El modelo seleccionado no está disponible para redactar. Puedes crear el documento tú.');
      if(open.size>=4||[...open.values()].some(job=>job.user===o.user))error(429,'Ya hay una revisión en curso. Espera a que termine.');
      db.p('INSERT INTO offers VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,o.scope,data.opId,sig,'draft','Preparando borrador…',null,'running',now,null);
      open.set(id,o);
      setImmediate(async()=>{
        try{
          const doc=snapshot(await editor.run(o,'draft',{requestedDocument:value},id));
          await target(o.user,o);
          db.p("UPDATE offers SET title=?,data=?,state='ready' WHERE id=? AND scope=? AND state='running'").run(doc.title,JSON.stringify(doc),id,o.scope);
        }catch{
          try{db.p("UPDATE offers SET title='No se pudo redactar',data=NULL,state='failed' WHERE id=? AND scope=? AND state='running'").run(id,o.scope);}catch{}
        }finally{open.delete(id);}
      });
      return {status:202,offer:summary(row(db,o,id))};
    });
  }
  function materialize(db,o,data,render) {
    const content=snapshot(data);
    if(data.offerId===undefined)return render(db.create(o.scope,o.user,content,data.opId,signed(['create',content])));
    if(typeof data.offerId!=='string'||!OP.test(data.offerId))error(400,'Tarjeta inválida');
    const r=row(db,o,data.offerId);
    if(r.state!=='ready'||r.kind!=='draft')error(409,'La tarjeta aún no tiene un borrador');
    if(r.doc)return render(db.require(o.scope,r.doc));
    // A frozen operation ID per card closes a duplicate-creation race across tabs and lost ACKs.
    const doc=db.create(o.scope,o.user,content,'offer-'+r.id,signed(['create-from-offer',r.id,content]));
    db.p("UPDATE offers SET doc=?,data=NULL,title=? WHERE id=? AND scope=? AND doc IS NULL").run(doc.id,doc.title,r.id,o.scope);
    return render(doc);
  }
  return {list,detail,request,materialize};
}
module.exports={createOfferRoutes};
