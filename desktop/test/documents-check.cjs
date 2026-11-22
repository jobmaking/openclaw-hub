'use strict';
// Installed Electron, isolated profile and loopback fixture. The backend document/SQLite/export
// code is real; the Gateway model returns a controlled verdict. No production account is used.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const http=require('node:http');
const {spawn}=require('node:child_process');
const {once}=require('node:events');
const {setTimeout:pause}=require('node:timers/promises');
const {WebSocketServer}=require('ws');
const express=require('express');
const {CDP}=require('./cdp.cjs');
const {createDocuments}=require('../../lib/documents');
const {mountArtifactRoutes}=require('../../lib/artifact-routes');
const {documentEditor}=require('../../lib/document-editor');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hub-documents-electron-'));
const profile=path.join(dir,'profile'),dl=path.join(dir,'downloads'), publicRoot=path.resolve(__dirname,'../../public');
fs.mkdirSync(profile);fs.mkdirSync(dl);fs.writeFileSync(path.join(profile,'settings.json'),JSON.stringify({directory:dl}));
fs.writeFileSync(path.join(dir,'documents-policy.json'),JSON.stringify({version:1,enabled:true,grants:{reviewer:['assistant']}}),{mode:0o600});
const sessions=[['agent:main:dashboard:doc-a','document-session-A','Informe semanal'],['agent:main:dashboard:doc-b','document-session-B','Otra conversación']];
const rows=sessions.map(([key,sessionId,label])=>({key,sessionId,label,agentId:'main',hasActiveRun:false,model:'editor-test',modelProvider:'fixture',updatedAt:Date.now(),createdVia:'dashboard',classification:'direct',group:'general'}));
const first=rows[0], second=rows[1], byKey=k=>rows.find(s=>s.key===k);
const attachedText='Texto ya terminado, sin modificar ninguno de sus importes.';
const attachedBytes=Buffer.from(attachedText);
const attached={id:'attached-original',title:'Informe existente v0.1.md',type:'artifact',mimeType:'text/markdown',sizeBytes:attachedBytes.length,download:{mode:'bytes'}};
let engineCalls=0, lastInstruction; const bridge={id:'assistant',cfg:{url:'ws://127.0.0.1:1'},connected:true,gatewayMethods:new Set(['agent','tools.invoke']),async documentModelRun(spec){const i=spec.message.indexOf('DATOS JSON:');const p={args:{input:JSON.parse(spec.message.slice(i+11))}};const out=await this.req('tools.invoke',p);return {ok:true,payload:{runId:spec.idempotencyKey,result:{meta:{agentMeta:{provider:'fixture',model:'editor-test'}},payloads:[{text:JSON.stringify(out.payload.output.details.json)}]}}};},async req(method,p){
 if(method==='sessions.describe')return {ok:true,payload:{session:byKey(p.key)}};
 if(method==='artifacts.list')return {ok:true,payload:{artifacts:[attached]}};
 if(method==='artifacts.download'&&p.artifactId===attached.id)return {ok:true,payload:{artifact:attached,encoding:'base64',data:attachedBytes.toString('base64')}};
 if(method==='tools.invoke'){
  engineCalls++;if(p.args.input.selectedText)lastInstruction=p.args.input.requestedChange;await pause(750);
  const result=p.args.input.requestedDocument?{title:'Informe de ensayo',blocks:[{kind:'paragraph',text:'Alinearemos las tres prioridades del equipo.'}]}:p.args.input.selectedText?{replacement:'acordar prioridades',note:'Se conserva el significado con menos palabras.'}:{verdict:'approved',note:'El informe ficticio es claro y coherente.'};
  return {ok:true,payload:{ok:true,toolName:'llm-task',output:{details:{model:'editor-test',provider:'fixture',json:result}}}};
 }throw Error(method);
}};
const access={canAgent:(u,a)=>u==='reviewer'&&a==='assistant',authorize:async(u,l,k)=>access.canAgent(u,l.id)&&!!byKey(k),validRow:(l,k,r)=>Boolean(r&&r.key===k&&r.agentId==='main')};
const app=express(),server=http.createServer(app),ws=new WebSocketServer({server});
let total=0,docRequests=0,downloads=0,chatSends=0,lastPath='';
const auth=(req,res,next)=>{if(!req.get('cookie')?.includes('hubfixture=1'))return res.status(401).json({error:'auth required'});req.user='reviewer';next();};
const docs=createDocuments({dataDir:dir,getLink:id=>id==='assistant'?bridge:null,access,originAllowed:req=>!req.get('origin')||req.get('origin')==='http://127.0.0.1:'+server.address().port,editor:documentEditor});
app.use(express.json());app.use((req,res,next)=>{if(req.path.startsWith('/api/documents')&&!req.path.startsWith('/api/documents/chat-offers'))docRequests++;if(req.path==='/api/artifact-download')downloads++;lastPath=req.path;next();});
app.post('/api/login',(q,s)=>s.cookie('hubfixture','1',{httpOnly:true,sameSite:'strict'}).json({ok:true,user:'reviewer'}));
app.get('/api/me',auth,(q,s)=>s.json({user:'reviewer'}));
const uiVersion=fs.readFileSync(path.resolve(__dirname,'../../VERSION'),'utf8').trim();
app.get('/api/branding',(q,s)=>s.json({name:'HUB · Prueba',version:'0.0.0 · DEMO'}));
app.get('/api/agents',auth,(q,s)=>s.json({agents:[{id:'assistant',name:'Assistant',emoji:'🔨',connected:true,documentsEnabled:docs.granted(q.user,'assistant'),models:[{id:'editor-test',name:'Editor de prueba',provider:'fixture',ref:'fixture/editor-test'}]}]}));
app.get('/api/sessions',auth,(q,s)=>s.json({sessions:rows,total:rows.length}));
app.get(['/api/history','/api/history-page'],auth,(q,s)=>s.json({sessionId:byKey(q.query.key)?.sessionId,hasMore:false,messages:[{id:'a1',role:'assistant',text:'Podemos preparar el informe y recoger los acuerdos.',ts:Date.now()}]}));
app.get('/api/session-settings',auth,(q,s)=>s.json({ok:true,settings:{key:q.query.key,model:'editor-test',modelProvider:'fixture',modelRef:'fixture/editor-test',thinkingLevels:[]}}));
app.get('/api/run-status',auth,(q,s)=>s.json({hasActiveRun:false}));
docs.mount(app,auth);mountArtifactRoutes(app,{getLink:id=>id==='assistant'?bridge:null,requireAuth:auth,authorizeSession:(q,l,k)=>access.authorize(q.user,l,k),documents:docs});
app.all('/api/*',(q,s)=>s.json({}));app.use(express.static(publicRoot));
ws.on('connection',(socket)=>{socket.send(JSON.stringify({type:'hello',user:'reviewer',agents:[{id:'assistant',connected:true}]}));socket.on('message',raw=>{if(JSON.parse(raw).type==='send')chatSends++;});});
let processUnderTest,guest,shell,stdout='',debugPort;
function check(title,p){assert(p,title);console.log('PASS '+(++total)+' '+title);}
async function until(label,f,timeout=11000){const end=Date.now()+timeout;let issue;do{try{const v=await f();if(v)return v;}catch(e){issue=e.message;}await pause(75);}while(Date.now()<end);throw Error('Timeout '+label+(issue?' ('+issue+')':'')+'; last request '+lastPath);}
const get=selector=>guest.evaluate('document.querySelector('+JSON.stringify(selector)+')?.textContent');
const only=selector=>guest.evaluate('!!document.querySelector('+JSON.stringify(selector)+')?.getClientRects().length');
async function click(selector,label){
 const code='(()=>{const el=Array.from(document.querySelectorAll('+JSON.stringify(selector)+')).find(e=>e.getClientRects().length'+(label?'&&e.textContent.trim()==='+JSON.stringify(label):'')+');if(!el)return null;el.scrollIntoView({block:"nearest"});const r=el.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;return el.contains(document.elementFromPoint(x,y))?{x,y}:null;})()';
 const xy=await until('control '+(label||selector),()=>guest.evaluate(code));
 for(const type of ['mousePressed','mouseReleased'])await guest.send('Input.dispatchMouseEvent',{...xy,type,button:'left',clickCount:1});
}
async function key(value,modifiers=0){
 const n={Escape:27,Enter:13,ArrowLeft:37,Tab:9}[value];
 for(const type of ['keyDown','keyUp']){
  // CDP needs the character carried by Enter as well as the physical key.
  const text=type==='keyDown'&&value==='Enter'?String.fromCharCode(13):'';
  await guest.send('Input.dispatchKeyEvent',{type,key:value,code:value,windowsVirtualKeyCode:n,nativeVirtualKeyCode:n,modifiers,text,unmodifiedText:text});
 }
}
async function type(selector,value){if(!await only(selector))throw Error('input not visible: '+selector);await click(selector);await guest.evaluate('document.querySelector('+JSON.stringify(selector)+').select()');await guest.send('Input.insertText',{text:value});}
function editorFocus(selector) {
 return guest.evaluate(
  '(() => {'+
  ' const el=document.querySelector('+JSON.stringify(selector)+'), style=getComputedStyle(el);'+
  ' if(document.activeElement!==el || style.outlineStyle!=="none" || !/0px -1px 0px 0px inset$/.test(style.boxShadow)) return false;'+
  ' const canvas=document.createElement("canvas"); canvas.width=canvas.height=1; const ctx=canvas.getContext("2d");'+
  ' const luminance=color=>{ctx.clearRect(0,0,1,1);ctx.fillStyle=color;ctx.fillRect(0,0,1,1);const rgb=Array.from(ctx.getImageData(0,0,1,1).data).slice(0,3).map(c=>c/255).map(x=>x<=.04045?x/12.92:Math.pow((x+.055)/1.055,2.4));return .2126*rgb[0]+.7152*rgb[1]+.0722*rgb[2];};'+
  ' const line=style.boxShadow.replace(/ 0px -1px 0px 0px inset$/, ""), a=luminance(line), b=luminance(style.backgroundColor); return (Math.max(a,b)+.05)/(Math.min(a,b)+.05)>=3;'+
  '})()');
}
const capture=async name=>{const snap=await guest.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(dir,name+'.png'),Buffer.from(snap.data,'base64'));};
const docsSelector='/api/documents?'+new URLSearchParams({key:first.key,agent:'assistant',sessionId:first.sessionId});
const getDocs=async()=>{const r=await fetch(base+docsSelector,{headers:{Cookie:'hubfixture=1'}});assert.equal(r.status,200);return (await r.json()).documents;};
let base;
(async()=>{
 server.listen(0,'127.0.0.1');await once(server,'listening');base='http://127.0.0.1:'+server.address().port;
 const reserve=http.createServer();reserve.listen(0,'127.0.0.1');await once(reserve,'listening');debugPort=reserve.address().port;await new Promise(r=>reserve.close(r));
 const launch=process.env.HUB_LINUX_LAUNCHER||path.join(os.homedir(),'.local/bin/openclaw-hub-desktop');
 processUnderTest=spawn(launch,['--remote-debugging-port='+debugPort,'--remote-debugging-address=127.0.0.1','--ozone-platform='+(process.env.HUB_DOC_TEST_PLATFORM||'x11')],{env:{...process.env,HUB_URL:base+'/',HUB_USER_DATA_DIR:profile,XDG_CONFIG_HOME:path.join(dir,'config'),XDG_STATE_HOME:path.join(dir,'state'),DBUS_SESSION_BUS_ADDRESS:'unix:path='+path.join(dir,'no-dbus')},stdio:['ignore','pipe','pipe']});
 processUnderTest.on('error',e=>stdout+=e.message);processUnderTest.stderr.on('data',s=>stdout+=s.toString());
 const target='http://127.0.0.1:'+debugPort;
 const targets=await until('Electron targets',async()=>{const a=await (await fetch(target+'/json/list')).json();return a.some(e=>e.url.startsWith('file://'))&&a.some(e=>e.url.startsWith(base))?a:null;});
 guest=await CDP.connect(targets.find(t=>t.url.startsWith(base)).webSocketDebuggerUrl);shell=await CDP.connect(targets.find(t=>t.url.startsWith('file:')).webSocketDebuggerUrl);
 await guest.send('Runtime.enable');await guest.send('Page.enable');
 const expected=fs.readFileSync(path.resolve(__dirname,'../VERSION'),'utf8').trim();
 const version=await until('Electron version',()=>shell.evaluate('typeof hubDesktop!=="undefined" && document.getElementById("app-version")?.textContent==='+JSON.stringify(expected)+' && document.getElementById("app-version").textContent'));
 assert.equal(version,expected);check('HUB Linux '+expected+' in an isolated profile',await guest.evaluate('location.origin')===base);
 await guest.send('Emulation.setDeviceMetricsOverride',{width:1440,height:870,deviceScaleFactor:1,mobile:false});
 await guest.evaluate('fetch("/api/login",{method:"POST"}).then(r=>r.ok)');await guest.send('Page.reload');
 await until('current conversation',()=>guest.evaluate('typeof state!=="undefined" && state.current==='+JSON.stringify(first.key)+' && !state.historyLoading && state.ws?.readyState===1 && !document.getElementById("hub-documents-entry").hidden'));
 check('the live demo shows the loaded UI version after a frontend-only refresh',await guest.evaluate('document.getElementById("sb-version").textContent')==='v'+uiVersion+' · DEMO');
 check('optional editor does not load assets or fetch documents until used',!(await only('.hd-panel'))&&docRequests===0&&await guest.evaluate('!window.HubDocuments && !performance.getEntriesByType("resource").some(r=>/documents[.](js|css)/.test(r.name))'));
 await click('#hub-artifacts summary');await click('.ha-artifact-edit');
 await until('existing attachment editable',()=>guest.evaluate('document.querySelector("#hd-document-title")?.value==="Informe existente v0.1"'));
 check('existing file opens as a text copy, not an inferred draft',await guest.evaluate('document.querySelector(".hd-text")?.value==='+JSON.stringify(attachedText))&&engineCalls===0&&chatSends===0&&(await getDocs()).length===0);
 await click('#hd-save');await until('saved from attachment',async()=> (await getDocs()).length===1);
 await click('.hd-index');await click('.hd-back');
 check('the plain composer keeps its original action',await guest.evaluate('!document.getElementById("document-destination")&&document.getElementById("btn-send").getAttribute("aria-label")==="Enviar mensaje"'));
 await type('#input','Borrador que no debe desaparecer');
 if(await only('#hub-documents-entry'))await click('#hub-documents-entry');else await click('#hub-documents-trigger');
 await until('reopened editor',()=>only('.hd-panel'));
 if(!await only('#hd-new-document'))await click('.hd-index');
 await click('#hd-new-document');
 await type('#hd-document-title','Jornada de coordinación');
 check('document title has a single 1px underline with at least 3:1 contrast',await editorFocus('#hd-document-title'));
 await type('.hd-text','La jornada servirá para poner en común las prioridades y acordar los próximos pasos.');
 check('mouse focus on body text has no outer outline',await editorFocus('.hd-text'));
 await click('#hd-add');await type('.hd-block:last-child .hd-text','Orden del día');
 await guest.evaluate('(()=>{const select=document.querySelector(".hd-block:last-child .hd-kind");select.value="heading";select.dispatchEvent(new Event("change"));})()');
 await key('Tab');
 check('Tab focus on block formatting uses a single thin outline',await guest.evaluate('(()=>{const e=document.querySelector(".hd-block:last-child .hd-kind"),s=getComputedStyle(e);return document.activeElement===e && s.outlineWidth==="1px" && s.outlineStyle==="solid";})()'));
 await key('Tab',8);
 check('Shift+Tab focuses the heading with the same quiet underline',await editorFocus('.hd-block[data-kind=heading] .hd-text'));
 await capture('oscuro-foco-heading');
 await guest.send('Emulation.setEmulatedMedia',{features:[{name:'forced-colors',value:'active'}]});
 check('forced-colors leaves an explicit keyboard focus indicator',await guest.evaluate('(()=>{const e=document.activeElement,s=getComputedStyle(e);return matchMedia("(forced-colors: active)").matches && e.matches(".hd-text:focus-visible") && s.outlineStyle==="solid" && s.outlineWidth==="1px";})()'));
 await guest.send('Emulation.setEmulatedMedia',{features:[]});
 await click('#hd-save');await until('v1',async()=>/v1 · Guardado/.test(await get('.hd-status')));
 check('native text editing, dark style and side-by-side desks',await guest.evaluate('getComputedStyle(document.querySelector(".hd-sheet")).backgroundColor==="rgb(24, 27, 34)" && !document.getElementById("main").inert && document.querySelector(".hd-panel").getBoundingClientRect().width>500'));
 check('document saved on server', (await getDocs()).at(0).title==='Jornada de coordinación');
 await guest.evaluate('document.querySelector(".hd-divider").focus()');await key('ArrowLeft');check('keyboard resize',await guest.evaluate('parseInt(document.querySelector(".hd-divider").getAttribute("aria-valuenow"),10)>56'));
 await guest.evaluate('(()=>{const t=document.querySelector(".hd-text");t.focus();const q="poner en común las prioridades";const s=t.value.indexOf(q);t.setSelectionRange(s,s+q.length);t.dispatchEvent(new Event("select"));})()');
 await click('#hd-ask');
 const getComposer=selector=>guest.evaluate('(() => {const box=document.querySelector('+JSON.stringify(selector)+');if(!box)return null;'+
  'const field=box.querySelector("textarea"),send=box.querySelector(".composer-send,#btn-send");'+
  'if(!field||!send)return null; const b=getComputedStyle(box), f=getComputedStyle(field), s=getComputedStyle(send), rect=box.getBoundingClientRect();'+
  'return {shell:[b.backgroundImage,b.borderTopWidth,b.borderTopLeftRadius,b.paddingLeft,b.marginBottom],'+
  'field:[f.fontSize,f.lineHeight,f.minHeight,f.resize,f.outlineStyle,f.borderTopColor],'+
  'send:[s.width,s.height,s.borderTopLeftRadius,send.querySelector("svg path")?.getAttribute("d")],bottom:rect.bottom};})()');
 const left=await getComposer('#composer'),right=await getComposer('.hd-request');
 check('chat and Documentos share the same surface, text metrics, arrow and bottom alignment',left&&right&&
  JSON.stringify(left.shell)===JSON.stringify(right.shell)&&JSON.stringify(left.field)===JSON.stringify(right.field)&&
  JSON.stringify(left.send)===JSON.stringify(right.send)&&Math.abs(left.bottom-right.bottom)<=1);
 const rawInstruction='Acorta el fragmento.';
 const requestOpen=()=>only('.hd-request');
 check('selection context stays in the document composer and empty instructions cannot send',await guest.evaluate('(()=>{const form=document.querySelector(".hd-request");return form.querySelector("blockquote").textContent==="poner en común las prioridades"&&form.querySelector(".composer-send").disabled&&document.activeElement.id==="hd-instruction";})()'));
 await key('Escape');
 check('Escape returns to the exact document selection, without sending',engineCalls===0&&!(await requestOpen())&&await guest.evaluate('(()=>{const t=document.activeElement;return t.classList.contains("hd-text")&&t.value.slice(t.selectionStart,t.selectionEnd)==="poner en común las prioridades";})()'));
 await click('#hd-ask');await type('#hd-instruction',rawInstruction);
 check('Documentos has one focus indication around the writing box, not around the textarea',await guest.evaluate('(()=>{const form=document.querySelector(".hd-request"),field=document.getElementById("hd-instruction");return getComputedStyle(form).borderTopColor==="rgb(167, 164, 236)"&&getComputedStyle(field).outlineStyle==="none"&&getComputedStyle(field).boxShadow==="none";})()'));
 await until('both send arrows share the enabled palette',()=>guest.evaluate('(()=>{const a=getComputedStyle(document.getElementById("btn-send")),b=getComputedStyle(document.querySelector(".hd-request .composer-send"));return a.backgroundColor===b.backgroundColor&&a.color===b.color&&!document.querySelector(".hd-request .composer-send").disabled;})()'));
 await capture('oscuro-compositores');
 await key('Enter',8);
 check('Shift+Enter adds a line, keeps focus, and never calls the assistant',engineCalls===0&&await guest.evaluate('document.activeElement.id==="hd-instruction"&&document.activeElement.value.endsWith(String.fromCharCode(10))'));
 await guest.send('Input.insertText',{text:'No cambies las cifras.'});
 await guest.send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:1});
 await guest.send('Emulation.setDeviceMetricsOverride',{width:390,height:700,deviceScaleFactor:1,mobile:true});
 await until('touch keyboard mode',()=>guest.evaluate('innerWidth===390 && matchMedia("(pointer: coarse)").matches && !document.getElementById("hd-instruction")?.matches(":disabled")'));
 await key('Enter');
 check('touch Enter adds a line and preserves the instruction',engineCalls===0&&await guest.evaluate('document.activeElement.id==="hd-instruction"&&document.activeElement.value.endsWith("No cambies las cifras."+String.fromCharCode(10))'));
 await guest.send('Emulation.setDeviceMetricsOverride',{width:390,height:340,deviceScaleFactor:1,mobile:true});
 await until('visualViewport settles after keyboard resize',()=>guest.evaluate('Math.abs(visualViewport.height-340)<2 && Math.abs(document.querySelector(".hd-panel").getBoundingClientRect().height-340)<2'));
 check('touch send and dismiss stay inside the visible keyboard-sized area',await guest.evaluate('(()=>{const rect=s=>document.querySelector(s).getBoundingClientRect(),a=rect(".hd-request .composer-send"),b=rect(".hd-request-close");return a.width>=44&&a.height>=44&&b.width>=44&&b.height>=44&&a.bottom<=visualViewport.height&&b.top>=0&&document.documentElement.scrollWidth===390;})()'));
 await capture('movil-compositor-compacto');
 await guest.send('Emulation.setTouchEmulationEnabled',{enabled:false});
 await guest.send('Emulation.setDeviceMetricsOverride',{width:1440,height:870,deviceScaleFactor:1,mobile:false});
 check('draft in the left chat is unchanged by composing in Documentos',await guest.evaluate('document.getElementById("input").value==="Borrador que no debe desaparecer"'));
 await key('Enter');
 await until('proposal',()=>only('.hd-suggestion'));
 check('desktop Enter submits one scoped multiline request, not a chat message',engineCalls===1&&chatSends===0&&lastInstruction===['Acorta el fragmento.','No cambies las cifras.'].join(String.fromCharCode(10)));
 check('assistant proposal does not change the selected text until accepted',await guest.evaluate('document.querySelector(".hd-text").value.includes("poner en común")'));
 await capture('oscuro-propuesta');await click('.hd-suggestion button','Aplicar cambio');
 await until('accepted',()=>guest.evaluate('document.querySelector(".hd-text").value.includes("acordar prioridades")&&!document.querySelector(".hd-suggestion")'));
 await click('.hd-export');await click('.hd-approval button','Pedir revisión al asistente');
 await until('review ready',async()=>/Asistente: conforme/.test(await get('.hd-approval')));check('review does not self-approve the human decision',!(await only('.hd-inline .hd-primary:not(.hd-save)'))||!(await get('.hd-sheet')).includes('Generar PDF'));
 await click('.hd-approval button','Dar mi conformidad a v2');await click('.hd-notice button','Confirmar v2');
 const extensions=[['PDF','pdf','%PDF-'],['Word','docx','PK'],['Markdown','md','# Jornada de coordinación']];
 for(const [label,fmt,magic] of extensions){
   await click('.hd-sheet button','Generar '+label);
   const filename='Jornada-de-coordinacion-v2.'+fmt;
   await until('export link '+fmt,async()=>String(await get('.hd-download')).includes(filename));await click('a.hd-download');
   const bytes=await until('Electron download '+fmt,()=>{const f=path.join(dl,filename);return fs.existsSync(f)&&fs.statSync(f).size>10&&fs.readFileSync(f);});
   const url=await guest.evaluate('document.querySelector("a.hd-download").href');const httpBytes=Buffer.from(await (await fetch(url,{headers:{Cookie:'hubfixture=1'}})).arrayBuffer());
   check(fmt+' saves native bytes, with authenticated download and main view intact',bytes.toString('utf8').startsWith(magic)&&bytes.equals(httpBytes)&&await guest.evaluate('location.pathname==="/" && document.getElementById("input").value==="Borrador que no debe desaparecer"'));
 }
 await click('.hd-back');check('close returns focus and keeps the chat draft',await guest.evaluate('document.activeElement.id==="hub-documents-trigger" && document.getElementById("input").value==="Borrador que no debe desaparecer"'));
 await until('native sources and editor exports in Entregables',()=>guest.evaluate('document.querySelectorAll("#hub-artifacts .ha-artifact").length===4'));
 check('Entregables retains the original and all three editor exports',chatSends===0&&await guest.evaluate('document.querySelector("#hub-artifacts").textContent.includes("Informe existente v0.1.md")'));
 await click('#hub-documents-trigger');if(await only('.hd-doc-card'))await click('.hd-doc-card');
 await until('current doc',()=>only('.hd-text'));
 const id=(await getDocs()).find(v=>v.title==='Jornada de coordinación').id;
 const raw=await fetch(base+'/api/documents/'+id+'?'+docsSelector.split('?')[1],{headers:{Cookie:'hubfixture=1'}}).then(r=>r.json());
 const updated=await fetch(base+'/api/documents/'+id+'?'+docsSelector.split('?')[1],{method:'PUT',headers:{Cookie:'hubfixture=1','Content-Type':'application/json','X-Hub-Documents':'1'},body:JSON.stringify({title:'Título de otra pestaña',blocks:raw.document.blocks,base:raw.document.hash,opId:'another-tab'})});assert.equal(updated.status,200);
 await type('.hd-text','Mi texto no se debe sobrescribir.');
 await until('edit conflict',()=>only('.hd-conflict'));
 check('conflict notice preserves unsaved text in this tab',await guest.evaluate('document.querySelector(".hd-text").value==="Mi texto no se debe sobrescribir."'));
 await click('.hd-conflict button','Ver versión guardada');await click('.hd-conflict button','Descartar mi copia');
 await guest.send('Emulation.setDeviceMetricsOverride',{width:390,height:700,deviceScaleFactor:1,mobile:true});
 await until('single document view on small viewport',()=>guest.evaluate('innerWidth===390 && document.getElementById("main").inert && getComputedStyle(document.getElementById("main")).display==="none"'));
 await capture('oscuro-movil');check('390 px view has a full-width editor without horizontal overflow or clipped header',await guest.evaluate('document.documentElement.scrollWidth===390 && document.querySelector(".hd-panel").getBoundingClientRect().width===390 && document.getElementById("hd-label").scrollWidth<=document.getElementById("hd-label").clientWidth'));
 await click('.hd-back');check('mobile returns to the existing chat',await guest.evaluate('!document.getElementById("main").inert && document.querySelector(".hd-panel").hidden'));
 const browserInfo=await (await fetch(target+'/json/version')).json();const control=await CDP.connect(browserInfo.webSocketDebuggerUrl);
 try{
  const list=(await control.send('SystemInfo.getProcessInfo')).processInfo.filter(e=>e.type==='renderer');
  const status=list.map(e=>fs.readFileSync('/proc/'+e.id+'/status','utf8'));
  check('guest sandbox and no desktop Node access',status.length>=2&&status.every(x=>/NoNewPrivs:\s+1/u.test(x)&&/Seccomp:\s+2/u.test(x))&&await guest.evaluate('typeof require==="undefined" && typeof process==="undefined"'));
 }finally{control.close();}
 check('no renderer exceptions',guest.events.filter(e=>e.method==='Runtime.exceptionThrown').length===0);
 check('fixture exercised editor proposals and real HTTP downloads',engineCalls===2&&downloads===7);
 console.log('RESULT '+total+' checks passed; evidence '+dir+'; assistant responses simulated.');
})().catch(e=>{
 console.error(e.stack);if(!guest)console.error(stdout.slice(-2800));if(guest)console.error(JSON.stringify(guest.events.filter(e=>e.method==='Runtime.exceptionThrown').slice(-3)));console.error('Evidence '+dir);process.exitCode=1;
}).finally(async()=>{
 guest?.close();shell?.close();
 if(processUnderTest?.pid&&processUnderTest.exitCode===null&&processUnderTest.signalCode===null){processUnderTest.kill('SIGTERM');await Promise.race([once(processUnderTest,'exit'),pause(1200)]);}
 for(const client of ws.clients)client.terminate(); ws.close();server.closeAllConnections();server.close();docs.close();
});
