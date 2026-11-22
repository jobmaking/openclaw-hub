'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const {
  FORMATS, ARTIFACT, DocumentError, DocumentStore, error, scopeKey, snapshot, structured, parse, sha, signed, plain, anchorFor, insertion,
} = require('./documents-store');
const { renderDocument } = require('./document-export');
const { createOfferRoutes } = require('./document-offers');
const ID = /^[a-z0-9_-]{1,80}$/i;
const SESSION = /^[^\s\x00-\x1f\x7f]{1,180}$/u;
const clean = (value, re) => typeof value === 'string' && re.test(value);
const limitedText = (text, n) => text.slice(0,n).toWellFormed();

function createDocuments({ dataDir, publicTenant, getLink, access, originAllowed, editor, renderer = renderDocument }) {
  // Reads of approved outputs remain available if the editor is switched off; removing a grant revokes both.
  const policyPath = path.join(dataDir,'documents-policy.json');
  function policy() {
    if (publicTenant) return null;
    try {
      const stat = fs.statSync(policyPath);
      if (!stat.isFile() || stat.size > 8192 || (stat.mode & 0o077)) return null;
      const value = parse(fs.readFileSync(policyPath,'utf8'));
      return value?.version === 1 && value.grants && typeof value.grants === 'object' ? value : null;
    } catch { return null; }
  }
  function granted(user, agent, editing = true) {
    if (!user || !agent || publicTenant || !access.canAgent(user,agent)) return false;
    const cfg = policy();
    if (!cfg || (editing && cfg.enabled !== true) || !Object.hasOwn(cfg.grants,user)) return false;
    const allowed = cfg.grants[user];
    return Array.isArray(allowed) && allowed.every(a => clean(a,ID)) && allowed.includes(agent);
  }
  let store;
  const getStore = () => store ||= new DocumentStore(dataDir);
  const open = new Map(), rendering = new Map();
  const technical = 'El asistente no devolvió una revisión válida. Tu documento no se modificó.';
  function currentScope(req, selection) {
    return scopeKey({ user:req.user, agent:selection.id, key:selection.key, sessionId:selection.row.sessionId });
  }
  async function target(user, { agent, key, sessionId }) {
    if (!clean(agent,ID) || !granted(user,agent)) error(403,'Documentos no está habilitado para esta cuenta y agente');
    if (typeof key !== 'string' || key.length > 1024 || !key.trim() || !clean(sessionId,SESSION)) error(400,'Selecciona una conversación con el historial cargado');
    const link = getLink(agent);
    if (!link || !await access.authorize(user,link,key)) error(403,'No tienes acceso a esta conversación');
    const result = await link.req('sessions.describe',{key},8000);
    const row = result.payload?.session;
    if (!result.ok || !access.validRow(link,key,row) || !clean(row?.sessionId,SESSION) || row.sessionId !== sessionId) error(409,'La conversación cambió o no se pudo verificar. Vuelve al chat y recarga su historial.');
    // Recheck after asynchronous reads so a concurrent ACL change wins over an admitted read.
    if (!granted(user,agent) || !await access.authorize(user,link,key)) error(403,'No tienes acceso a esta conversación');
    return { user, agent, key, sessionId, link, row, scope:scopeKey({user,agent,key,sessionId}) };
  }
  function view(db,row) { return db.project(row,open); }
  function jobOutput(value, action, anchor, doc) {
    if (action === 'propose') {
      const after = plain(value?.replacement,8_000,'El reemplazo propuesto no es válido');
      const note = plain(value?.note,600,'La propuesta no tiene una nota válida',{nonempty:true});
      if (anchor.before === after || !note.trim()) error(400,'La propuesta no contiene un cambio válido');
      insertion(doc,anchor,after);
      return { after, note };
    }
    if (!['approved','changes'].includes(value?.verdict)) error(400,'Revisión no válida');
    return { verdict:value.verdict, note:plain(value?.note,1000,'La revisión necesita una nota válida',{nonempty:true}) };
  }
  function jobInput(doc, action, anchor, instruction) {
    if (action === 'review') return { title:doc.title, sections:doc.blocks.map(b=>b.kind==='table'
      ? {type:'table',rows:b.rows.map(r=>({header:r.header===true,cells:r.cells.map(c=>({text:c.text,span:c.span||1}))}))}
      : {type:b.kind,text:b.text,...(b.pageNumber?{pageNumber:true}:{})}) };
    const i = doc.blocks.findIndex(b => b.id === anchor.blockId);
    // Only the verified cell and its local context are sent for a proposal inside a table.
    const before = anchor.cellId ? '' : (doc.blocks[i-1]?.text?.slice(-220)||'')+'\n';
    const after = anchor.cellId ? '' : '\n'+(doc.blocks[i+1]?.text?.slice(0,220)||'');
    return { requestedChange:instruction, selectedText:anchor.before,
      before:limitedText(before + anchor.source.slice(Math.max(0,anchor.start-600),anchor.start),820),
      after:limitedText(anchor.source.slice(anchor.end,anchor.end+600) + after,820),
    };
  }
  function launch(db, owner, row, data, signature) {
    if (!editor || editor.available?.(owner,data.action) === false) error(503,'La revisión por el modelo de esta conversación no está disponible. Puedes seguir editando el documento.');
    if (row.proposal || open.has(parse(row.job)?.id)) error(409,'Resuelve la revisión pendiente antes de pedir otra',view(db,row));
    if (data.action === 'review' && db.rev(row.id,row.n).approval) return { status:200, document:view(db,row) };
    if (open.size >= 4 || [...open.values()].some(job => job.user === owner.user)) error(429,'Ya hay una revisión en curso. Inténtalo cuando termine.');
    const doc = db.content(row), action = data.action;
    const anchor = action === 'propose' ? anchorFor(doc,data) : null;
    const instruction = anchor ? plain(data.instruction,1200,'La instrucción debe tener entre 1 y 1.200 caracteres',{nonempty:true}) : null;
    const input = jobInput(doc,action,anchor,instruction);
    const job = { id:randomUUID(), action, state:'running' };
    if (action === 'review') db.retireApproval(row);
    db.set(row,{job});db.record(row.scope,data.opId,signature,row.id);
    open.set(job.id,owner);
    const finish = async () => {
      try {
        const value = jobOutput(await editor.run(owner,action,input,job.id),action,anchor,doc);
        await target(owner.user,owner);
        db.atomic(() => {
          const latest=db.require(owner.scope,row.id);
          if (parse(latest.job)?.id !== job.id) return;
          if (action === 'propose') {
            let stale=db.anchorChanged(latest,row.n,anchor);
            if (!stale) { try { insertion(db.content(latest),anchor,value.after); } catch { stale=true; } }
            db.set(latest,{job:null,proposal:{id:job.id,...anchor,...value,status:stale?'stale':'pending'}});
          } else if (latest.hash !== row.hash) {
            db.set(latest,{job:{...job,state:'failed',error:'Se editó el borrador durante la revisión. Revisa la versión actual.'}});
          } else {
            db.storeReview(latest,{...value,hash:row.hash,at:Date.now()});
            db.set(latest,{job:null});
          }
        });
      } catch (cause) {
        try {
          db.atomic(() => {
            const latest=db.row(owner.scope,row.id);
            if (latest && parse(latest.job)?.id === job.id) db.set(latest,{job:{...job,state:'failed',error:cause?.safeMessage || technical}});
          });
        } catch { /* A stale running marker is rendered as interrupted on the next read. */ }
      } finally { open.delete(job.id); }
    };
    // Run only after the admission transaction commits, and never retry inference automatically.
    setImmediate(finish);
    return { status:202,jobId:job.id,document:view(db,db.require(owner.scope,row.id)) };
  }
  async function exportAction(owner,id,data,route='editor') {
    const db=getStore();
    if (!FORMATS.includes(data.format)) error(400,'Elige PDF, Word o Markdown');
    const row=db.require(owner.scope,id);
    const signature=signed(['export',id,data.base,data.format,route]);
    const op=db.op(owner.scope,data.opId,signature);
    if(op?.artifact)return {document:view(db,row),artifact:db.artifactForId(owner.scope,op.artifact)};
    // A selected previous, already approved revision remains exportable even while a new draft is open.
    const revision=typeof data.base === 'string' && db.revisionAt(row.id,data.base);
    if (!revision || !revision.approval || parse(revision.review)?.verdict !== 'approved') error(409,'Antes de exportar, el agente y tú debéis aprobar la misma revisión',view(db,row));
    let result;
    if(!db.existing(id,revision.hash,data.format)) {
      const k=signed([id,revision.hash,data.format]);
      if (!rendering.has(k)) {
        if (rendering.size >= 4) error(429,'Hay exportaciones en curso. Espera un momento.');
        rendering.set(k,Promise.resolve().then(() => renderer(parse(revision.snapshot),data.format)));
      }
      const pending=rendering.get(k);
      try { result=await pending; } catch { error(503,'No se pudo generar el archivo. La revisión conforme sigue guardada.'); }
      finally { if(rendering.get(k)===pending)rendering.delete(k); }
    }
    await target(owner.user,owner);
    const artifact=db.commitOutput(owner.scope,id,revision,data.format,result,route,data,signature);
    return {document:view(db,db.require(owner.scope,id)),artifact};
  }
  const offers=createOfferRoutes({editor,target,open});
  function mount(app,auth) {
    function handler(fn,mutation=false) {
      return async (req,res) => {
        res.set('Cache-Control','no-store');
        try {
          if (mutation && (!req.is('application/json') || req.get('x-hub-documents') !== '1' || !originAllowed(req))) error(403,'La solicitud no procede del HUB');
          const owner=await target(req.user,req.query);
          const id=req.params.id;
          if (id !== undefined && !clean(id,ID)) error(404,'No se encontró el documento');
          const db=getStore(), data=req.body||{};
          // A previously opened tab must not silently strip a newer document representation.
          if(req.get('x-hub-document-schema')!=='2' && !['/api/documents/chat-offers/:id'].includes(req.route.path)){
            if(id && structured(db.content(db.require(owner.scope,id))))error(409,'Actualiza el Hub para abrir este documento con tablas o pies de página');
            if(Array.isArray(data.blocks)&&data.blocks.some(b=>b&&(['table','header','footer'].includes(b.kind)||b.level!==undefined)))error(409,'Actualiza el editor antes de guardar la estructura del documento');
          }
          const result=await fn(db,owner,id,data);
          const { status=200,...value }=result;
          return res.status(status).json(value);
        } catch(cause) {
          if(cause instanceof DocumentError)return res.status(cause.status).json({error:cause.message,...(cause.document ? {document:cause.document} : {})});
          // Do not include document text, provider output, or tenant credentials in logs or HTTP details.
          console.error('[documents] request failed:', cause.code?.startsWith('SQLITE_') ? cause.code : cause.name);
          return res.status(500).json({error:'No se pudo completar la operación. No cierres el borrador hasta comprobar el guardado.'});
        }
      };
    }
    app.get('/api/documents',auth,handler((db,o) => ({documents:db.list(o.scope),formats:FORMATS})));
    app.post('/api/documents',auth,handler((db,o,id,data)=>({status:201,document:offers.materialize(db,o,data,row=>view(db,row))}),true));
    app.get('/api/documents/chat-offers',auth,handler(offers.list));
    // Older opened clients must not generate a draft from a prompt detached from its conversation.
    app.post('/api/documents/chat-offers',auth,handler(()=>error(410,'Recarga el Hub. Pide el archivo en el chat y ábrelo desde Entregables.'),true));
    app.get('/api/documents/chat-offers/:id',auth,handler(offers.detail));
    app.post('/api/documents/chat-export',auth,handler(async (db,o,id,data)=>({artifact:await exportFromChat(o,data.format,data.opId)}),true));
    app.get('/api/documents/:id',auth,handler((db,o,id)=>({document:view(db,db.require(o.scope,id))})));
    app.put('/api/documents/:id',auth,handler((db,o,id,data)=>({document:view(db,db.update(o.scope,id,snapshot(data),data,open))}),true));
    app.post('/api/documents/:id/action',auth,handler((db,o,id,data)=>{
      if (data.action==='export')return exportAction(o,id,data);
      const signature=signed([id,data.action,data.base,data.proposalId,data.decision,data.blockId,data.start,data.end,data.quote,data.instruction,data.revision,...(data.cellId?[data.cellId]:[])]);
      return db.atomic(()=>{
        const row=db.require(o.scope,id);
        if (db.op(o.scope,data.opId,signature)) {
          const document=view(db,row);
          return document.job?.state==='running' ? {status:202,jobId:document.job.id,document} : {document};
        }
        db.checkBase(row,data.base,open);
        if (data.action==='propose' || data.action==='review') return launch(db,o,row,data,signature);
        if (data.action==='resolve') db.resolve(row,data,open);
        else if (data.action==='restore') {
          if (!Number.isSafeInteger(data.revision)) error(400,'Elige una revisión del historial');
          const old=db.rev(id,data.revision);
          if(!old)error(404,'No se encontró esa revisión');
          const restore=parse(old.snapshot);
          if(structured(restore)&&data.structure!==2)error(409,'Actualiza el Hub para restaurar esta revisión con estructura');
          db.append(row,restore,'Tú · restauración de v'+old.n,true);
        } else if (data.action==='approve') {
          if (open.has(parse(row.job)?.id)) error(409,'Espera a que termine la revisión en curso');
          db.approve(row);
        } else error(400,'Acción de documento desconocida');
        db.record(o.scope,data.opId,signature,id);
        return {document:view(db,db.require(o.scope,id))};
      });
    },true));
  }
  function localArtifacts(req, selection) {
    if (!granted(req.user,selection.id,false) || !clean(selection.row?.sessionId,SESSION) || !access.validRow(selection.link,selection.key,selection.row)) return [];
    if (!store && !fs.existsSync(path.join(dataDir,'documents','documents.sqlite3'))) return [];
    return getStore().outputs(currentScope(req,selection));
  }
  function localArtifact(req,res,selection,id) {
    if (!ARTIFACT.test(id)) return false;
    const file=granted(req.user,selection.id,false) && clean(selection.row?.sessionId,SESSION) && access.validRow(selection.link,selection.key,selection.row)
      ? getStore().output(currentScope(req,selection),id) : null;
    if (!file) {res.set('Cache-Control','no-store').status(404).json({error:'No se encontró el entregable en esta conversación'});return true;}
    const bytes=Buffer.from(file.data);
    if (sha(bytes)!==file.sha) {res.status(503).json({error:'La copia guardada no ha superado la verificación de integridad'});return true;}
    res.set({'Content-Type':file.mime,'Content-Length':String(bytes.length),'Content-Disposition':'attachment; filename="'+file.name+'"',
      'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"sandbox; default-src 'none'; frame-ancestors 'none'"});
    res.end(req.method==='HEAD' ? undefined : bytes);return true;
  }
  async function exportFromChat(owner, format, opId) {
    const db=getStore();
    const prior=clean(opId,ID)&&db.p('SELECT doc,artifact FROM ops WHERE scope=? AND id=?').get(owner.scope,opId);
    if (prior?.artifact) {
      const original=db.output(owner.scope,prior.artifact);
      if (original?.format!==format || !db.op(owner.scope,opId,signed(['export',original.doc,original.rev,format,'chat']))) error(409,'Esa operación ya se utilizó con otros datos');
      return db.artifactForId(owner.scope,prior.artifact);
    }
    const docs=db.p('SELECT d.id,r.hash FROM docs d JOIN revisions r ON r.doc=d.id WHERE d.scope=? AND r.approval IS NOT NULL AND r.n=(SELECT max(rr.n) FROM revisions rr WHERE rr.doc=d.id AND rr.approval IS NOT NULL) ORDER BY d.updated DESC LIMIT 2').all(owner.scope);
    if(docs.length!==1) error(409,docs.length>1?'Hay varios documentos conformes. Abre el documento que quieres exportar.':'Todavía no hay un documento con las dos conformidades en esta conversación.');
    return (await exportAction(owner,docs[0].id,{base:docs[0].hash,opId,format},'chat')).artifact;
  }
  return { granted, mount, localArtifacts, localArtifact, close:()=>store?.close() };
}
module.exports={createDocuments};
