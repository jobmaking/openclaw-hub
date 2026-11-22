'use strict';

// Fixture for hands-on review of the private Documents candidate. Never ties into
// a production account, Gateway, model, transcript, or network interface.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { randomBytes } = require('node:crypto');
const { setTimeout: pause } = require('node:timers/promises');
const express = require('express');
const { WebSocketServer } = require('ws');
const { createDocuments } = require('../lib/documents');
const { mountArtifactRoutes } = require('../lib/artifact-routes');
const { artifactViewerHeaders } = require('../lib/artifact-viewer-headers');
const { documentEditor } = require('../lib/document-editor');
const { DocumentStore, scopeKey, signed } = require('../lib/documents-store');

const user = 'demo-local', agent = 'primary-demo';
const model = { id:'editor-demo', provider:'local-demo', name:'Editor de prueba', ref:'local-demo/editor-demo' };
const port = Number(process.argv[2] === undefined ? 28149 : process.argv[2]);
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw Error('Invalid local preview port');
const host = '127.0.0.1:' + port, origin = 'http://' + host;
const version = fs.readFileSync(path.resolve(__dirname,'../VERSION'),'utf8').trim();
const home = path.resolve(process.argv[3] || fs.mkdtempSync(path.join(os.tmpdir(),'hub-docs-preview-')));
fs.mkdirSync(home,{recursive:true,mode:0o700});
if (fs.lstatSync(home).isSymbolicLink() || (fs.statSync(home).mode&0o077)) throw Error('Preview needs a dedicated private directory');
const policy = path.join(home,'documents-policy.json');
try { fs.writeFileSync(policy,JSON.stringify({version:1,enabled:true,grants:{[user]:[agent]}}),{flag:'wx',mode:0o600}); }
catch (e) { if(e.code!=='EEXIST') throw e; }
const session = { key:'agent:main:dashboard:documents-demo', sessionId:'documents-demo-v1', agentId:'main', label:'Prueba de Documentos', model:model.id, modelProvider:model.provider,
  hasActiveRun:false, classification:'direct', createdVia:'dashboard', updatedAt:Date.now() };
const seed = { title:'Jornada de coordinación', blocks:[
  {id:'intro',kind:'paragraph',text:'La reunión servirá para poner en común las prioridades y acordar los próximos pasos.'},
  {id:'agenda',kind:'heading',text:'Orden del día'},
  {id:'agenda-1',kind:'bullet',text:'Revisar los proyectos pendientes y confirmar responsables.'},
  {id:'agenda-2',kind:'bullet',text:'Acordar una fecha para el seguimiento.'},
] };
const store = new DocumentStore(home);
try { store.create(scopeKey({user,agent,key:session.key,sessionId:session.sessionId}),user,seed,'seed-documents-demo-v1',signed(['create',seed])); } finally { store.close(); }
// Optional attachment supplied by the isolated browser fixture, never by an HTTP request.
const wordBytes=process.env.HUB_FIXTURE_WORD?fs.readFileSync(process.env.HUB_FIXTURE_WORD):null;
const word=wordBytes&&{id:'word-exact-v01',type:'artifact',title:'Informe móvil de ensayo v0.1.docx',mimeType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',sizeBytes:wordBytes.length,download:{mode:'bytes'}};
const files=new Map(word?[[word.id,{artifact:word,bytes:wordBytes}]]:[]);
const viewerFixtures=process.env.HUB_FIXTURE_PREVIEWS;
if(viewerFixtures)for(const [id,title,mimeType] of [
 ['fixture-pdf','Informe de ejemplo.pdf','application/pdf'],
 ['fixture-workbook','Balance de ejemplo.xlsx','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
 ['fixture-unavailable','PDF no disponible.pdf','application/pdf'],
 ['fixture-word-edit','Acuerdo estructurado.docx','application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
 ['fixture-word-complex','Acuerdo complejo.docx','application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
]){
 const bytes=fs.readFileSync(path.join(viewerFixtures,title));
 files.set(id,{bytes,artifact:{id,type:'artifact',title,mimeType,sizeBytes:bytes.length,download:{mode:'bytes'}}});
}
const viewerManifest=viewerFixtures&&fs.existsSync(path.join(viewerFixtures,'fixtures.json'))
  ? JSON.parse(fs.readFileSync(path.join(viewerFixtures,'fixtures.json'),'utf8')) : {};
const readerFixtures=viewerManifest.reader||[];
for(const {id,title,mimeType} of readerFixtures){
 const bytes=fs.readFileSync(path.join(viewerFixtures,title));
 files.set(id,{bytes,artifact:{id,type:'artifact',title,mimeType,sizeBytes:bytes.length,download:{mode:'bytes'}}});
}
const mediaFixture=process.env.HUB_FIXTURE_MEDIA==='1';
const mediaFixtures=mediaFixture?viewerManifest.media||[]:[];
for(const {id,title,mimeType} of mediaFixtures){
 const bytes=fs.readFileSync(path.join(viewerFixtures,title));
 files.set(id,{bytes,artifact:{id,type:'artifact',title,mimeType,sizeBytes:bytes.length,download:{mode:'bytes'}}});
}
const messages = [
  {id:'u1',role:'user',ts:Date.now()-30000,text:'Prepara un plan breve para nuestra jornada de coordinación.'},
  {id:'a1',role:'assistant',ts:Date.now()-29000,text:'Esta es una **prueba local con datos ficticios**. Abre **Documentos → Jornada de coordinación**. En la primera frase selecciona «poner en común las prioridades» y pide «Acorta la frase». Podrás comparar el antes y el después. El asistente está simulado; editar, guardar y exportar sí funcionan.'},
];
const bound = t => String(t||'').trim();
function sampleEdit(phrase) {
  const original=bound(phrase), lower=original.toLocaleLowerCase('es');
  if (lower==='poner en común las prioridades') return 'acordar las prioridades';
  if (lower==='acordar las prioridades') return 'fijar prioridades';
  const known=original.replace(/poner en común las prioridades/giu,'acordar las prioridades').replace(/confirmar responsables/giu,'asignar responsables');
  if(known!==original)return known;
  const words=original.split(/\s+/u);
  return words.length>4 ? words.slice(0,Math.max(3,Math.floor(words.length*.7))).join(' ')+'…' : '«'+original+'»';
}
const bridge = { id:agent, cfg:{url:'ws://127.0.0.1:1',gatewayAgentId:'main'}, connected:true, gatewayMethods:new Set(['tools.invoke']), async req(method,p) {
  if (method==='sessions.describe') return {ok:p.key===session.key,payload:{session:p.key===session.key?session:null}};
  if (method==='artifacts.list') return {ok:true,payload:{artifacts:mediaFixture
    ? mediaFixtures.filter(item=>item.session==='main').map(item=>files.get(item.id).artifact)
    : [...files.values()].filter(item=>!item.artifact.id.startsWith('fixture-reader-')).map(item=>item.artifact)}};
  const downloadable=file=>mediaFixture?mediaFixtures.some(item=>item.session==='main'&&item.id===file.artifact.id):true;
  if(method==='artifacts.download'&&files.has(p.artifactId)&&downloadable(files.get(p.artifactId))){
    const file=files.get(p.artifactId);
    return {ok:true,payload:{artifact:file.artifact,encoding:'base64',data:file.bytes.toString('base64')}};
  }
  if (method!=='tools.invoke' || p.sessionKey!==session.key || p.name!=='llm-task') return {ok:false};
  await pause(480);
  const input=p.args.input;
  const json=input.selectedText ? {replacement:sampleEdit(input.selectedText),note:'Sugerencia simulada para probar el cambio sobre la selección.'}
    : {verdict:'approved',note:'Revisión simulada: conforme para que puedas probar la exportación de esta versión.'};
  return {ok:true,payload:{ok:true,toolName:'llm-task',output:{details:{provider:model.provider,model:model.id,json}}}};
}, async documentModelRun(spec) {
  const payload=JSON.parse(spec.message.slice(spec.message.indexOf('DATOS JSON:')+11));
  await pause(480);
  const json=payload.requestedDocument ? {title:'Informe móvil de ensayo',blocks:[
    {kind:'paragraph',text:'La reunión servirá para poner en común las prioridades de la biblioteca.'},
    {kind:'heading',text:'Orden del día'},
    ...Array.from({length:7},(_,index)=>({kind:'bullet',text:'Tema '+(index+1)+': preparar los materiales y distribuir las tareas del equipo de la biblioteca.'})),
  ]} : payload.selectedText ? {replacement:sampleEdit(payload.selectedText),note:'Sugerencia simulada de la prueba móvil.'}
    : {verdict:'approved',note:'Revisión simulada para probar la exportación.'};
  return {ok:true,payload:{runId:spec.idempotencyKey,result:{meta:{agentMeta:{provider:model.provider,model:model.id}},payloads:[{text:JSON.stringify(json)}]}}};
} };
bridge.gatewayMethods.add('agent');
const workFixture=process.env.HUB_FIXTURE_WORK==='1'||mediaFixture;
const otherId='assistant-demo', runId='fixture-long-run';
const other={...session,key:'agent:main:dashboard:word-source',sessionId:'fixture-source-v2',label:'Contrato de ensayo',hasActiveRun:true};
let terminal=false,late=false;
const otherLink={...bridge,id:otherId,sessions:async()=>[other], async req(method,p){
 if(method==='sessions.describe')return {ok:p.key===other.key,payload:{session:p.key===other.key?other:null}};
 if(method==='artifacts.list')return {ok:true,payload:{artifacts:mediaFixture
   ? mediaFixtures.filter(item=>item.session==='work').map(item=>({...files.get(item.id).artifact,sessionKey:other.key,messageSeq:2}))
   : [...files.values()].filter(x=>x.artifact.id.startsWith('fixture-word')||x.artifact.id.startsWith('fixture-reader-')).map(x=>({...x.artifact,runId:late&&x.artifact.id==='fixture-word-edit'?runId:'previous-version',sessionKey:other.key,messageSeq:2}))}};
 if(method==='artifacts.download'&&files.has(p.artifactId)){
   const allowed=mediaFixture?mediaFixtures.some(item=>item.session==='work'&&item.id===p.artifactId):
     (p.artifactId.startsWith('fixture-word')||p.artifactId.startsWith('fixture-reader-'));
   if(!allowed)return {ok:false,payload:{error:'El archivo no pertenece a esta conversación'}};
   const file=files.get(p.artifactId);
   return {ok:true,payload:{artifact:file.artifact,encoding:'base64',data:file.bytes.toString('base64')}};
 }
 return {ok:false};
}};
const getLink=id=>id===agent?bridge:workFixture&&id===otherId?otherLink:null;
bridge.sessions=async()=>[session];
const known=(u,l,k)=>u===user && (l===bridge&&k===session.key||workFixture&&l===otherLink&&k===other.key);
const access={canAgent:(u,a)=>u===user&&!!getLink(a),authorize:async(...a)=>known(...a),canKnown:known,
 validRow:(l,k,r)=>r?.key===k&&(l===bridge&&r?.sessionId===session.sessionId||workFixture&&l===otherLink&&r?.sessionId===other.sessionId)};
const originAllowed=req=>!req.headers.origin||req.headers.origin===origin;
const cookie = 'hubdocs_local=' + randomBytes(24).toString('hex');
const admitted = req => (req.headers.cookie||'').split(';').some(p=>p.trim()===cookie);
const header = req => req.headers.host===host && !req.headers.forwarded && !req.headers['x-forwarded-host'] && !req.headers['x-forwarded-for'];
const auth = (req,res,next)=>{if(!admitted(req))return res.status(401).json({});req.user=user;next();};
const app=express(), server=http.createServer(app), sockets=new WebSocketServer({noServer:true,maxPayload:64*1024});
app.disable('x-powered-by');
app.use((req,res,next)=>{
  if(!header(req)||!originAllowed(req)||req.headers['sec-fetch-site']==='cross-site')return res.sendStatus(403);
  res.set({'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff',
    'Content-Security-Policy':"default-src 'self'; connect-src 'self' ws://"+host+"; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; object-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"});
  if((req.path==='/'||req.path==='/index.html')&&req.method==='GET')res.set('Set-Cookie',cookie+'; Path=/; HttpOnly; SameSite=Strict');
  next();
});
app.use(express.json({limit:'220kb'}));
app.get('/manifest.webmanifest',(req,res)=>res.type('application/manifest+json').json({
  name:'HUB Documentos · Prueba local',short_name:'Hub prueba',start_url:'/',scope:'/',display:'standalone',
  background_color:'#121419',theme_color:'#181b22',
  icons:[{src:'/icons/hub-v2/icon-192.png',sizes:'192x192',type:'image/png',purpose:'any'},
    {src:'/icons/hub-v2/icon-512.png',sizes:'512x512',type:'image/png',purpose:'any'}],
}));
app.get('/healthz',(req,res)=>res.json({preview:'hub-documents-local-v1',service:'HUB Documentos',status:'ready'}));
app.get('/api/branding',(req,res)=>res.json({name:'HUB · Prueba',title:'HUB Documentos · Prueba local',emoji:'▤',version:version+' · DEMO',capabilities:{files:false,modelSettings:false,push:false,voice:false,artifacts:true,artifactMedia:mediaFixture,...(workFixture?{workInbox:true}:{})}}));
app.get('/api/me',auth,(req,res)=>res.json({user,sessionScope:'own'}));
app.get('/api/agents',auth,(req,res)=>res.json({agents:[{id:agent,name:'Primary · Simulación',emoji:'📄',connected:true,documentsEnabled:true,models:[model]},...(workFixture?[{id:otherId,name:'Assistant · Ensayo',emoji:'🧰',connected:true,documentsEnabled:true,models:[model]}]:[])]}));
app.get('/api/sessions',auth,(req,res)=>res.json({sessions:[{...(workFixture&&req.query.agent===otherId?other:session),kind:'session'}],total:1}));
app.get(['/api/history','/api/history-page'],auth,(req,res)=>res.json(req.query.key===session.key?{sessionId:session.sessionId,hasMore:false,messages}:workFixture&&req.query.key===other.key?{sessionId:other.sessionId,hasMore:false,messages:[{id:'assistant-fixture',role:'assistant',ts:other.updatedAt,text:'El documento exacto del ensayo está en Entregables.'}]}:{}));
app.get('/api/run-status',auth,(req,res)=>res.json({hasActiveRun:false}));
app.get('/api/session-settings',auth,(req,res)=>res.json({ok:true,settings:{key:session.key,model:model.id,modelProvider:model.provider}}));
app.post('/api/logout',auth,(req,res)=>{res.set('Set-Cookie','hubdocs_local=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');res.json({ok:true});});
if(workFixture)fs.writeFileSync(policy,JSON.stringify({version:1,enabled:true,grants:{[user]:[agent,otherId]}}),{mode:0o600});
const docs=createDocuments({dataDir:home,getLink,access,originAllowed,editor:documentEditor});
docs.mount(app,auth);mountArtifactRoutes(app,{getLink,requireAuth:auth,authorizeSession:(req,l,k)=>access.authorize(req.user,l,k),documents:docs,mediaEnabled:mediaFixture});
if(mediaFixture)app.all('/api/artifact-media',auth,(req,res)=>res.status(404).json({error:'La ruta multimedia del visor no está montada'}));
if(workFixture){
 require('../lib/work-inbox').mountWorkInbox(app,{enabled:true,requireAuth:auth,getLinks:()=>mediaFixture?[otherLink]:[bridge,otherLink],access,documents:docs,
  sessionKind:()=> 'session',activityAt:r=>r.updatedAt,dataDir:home,observe:id=>id===otherId?{connected:true,stale:false,activeRunId:terminal?null:runId,
  runs:[{runId,status:terminal?'completed':'running',endedAt:terminal?Date.now()-30000:null}]}:null});
 app.post('/api/fixture-work',auth,(req,res)=>{
  if(req.body.phase==='late')late=true;
  if(req.body.phase==='done'){terminal=true;other.hasActiveRun=false;}
  if(req.body.phase==='reset')other.sessionId='fixture-source-reset';
  if(req.body.phase==='restore')other.sessionId='fixture-source-v2';
  res.json({ok:true});
 });
}
app.get('/api/*',auth,(req,res)=>res.json({}));
app.all('/api/*',auth,(req,res)=>res.status(404).json({error:'Esta acción no está disponible en la prueba local'}));
app.use(express.static(path.resolve(__dirname,'../public'),{dotfiles:'deny',redirect:false,cacheControl:false,setHeaders:artifactViewerHeaders}));
server.on('upgrade',(req,socket,head)=>{
  if(!header(req)||req.headers.origin!==origin||req.url!=='/ws'||!admitted(req)){socket.destroy();return;}
  sockets.handleUpgrade(req,socket,head,ws=>sockets.emit('connection',ws));
});
sockets.on('connection',socket=>{
  socket.send(JSON.stringify({type:'hello',user,agents:[{id:agent,connected:true}]}));
  socket.on('error',()=>{});
  if(workFixture)socket.send(JSON.stringify({type:'question',agentId:otherId,id:'fixture-decision',sessionKey:other.key,questions:[{id:'which',question:'¿Qué versión quieres revisar?',options:[]}]}));
  socket.on('message',raw=>{try{const m=JSON.parse(raw);if(m.type==='send'&&m.agentId===agent&&m.sessionKey===session.key)socket.send(JSON.stringify({type:'send-error',agentId:agent,sessionKey:session.key,requestId:m.requestId,clientMessageId:m.clientMessageId,error:'Esta prueba solo responde desde el documento. Pulsa «Pedir cambio».'}));}catch{}});
});
server.listen(port,'127.0.0.1',()=>console.log('HUB Documents local fixture ready'));
function stop(){for(const c of sockets.clients)c.terminate();sockets.close();server.closeAllConnections();server.close(()=>{docs.close();process.exitCode=0;});}
process.once('SIGTERM',stop);process.once('SIGINT',stop);
