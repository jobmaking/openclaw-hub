import { chromium } from 'playwright-core';
// Local Chromium/CDP fixture: real production HTML/CSS/usage.js, no credentials or external API.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
// Protected gateway_exec supplies an egress proxy; local fixtures must bypass it.
process.env.NO_PROXY = process.env.no_proxy = '127.0.0.1,localhost';
const root = new URL('../public/', import.meta.url);
const out = process.env.HUB_USAGE_OUT || '/tmp/hub-usage-ui'; fs.mkdirSync(out,{recursive:true});
const html = fs.readFileSync(new URL('index.html',root),'utf8').replace(/<script[\s\S]*?<\/script>/g,'').replace(/<link[^>]+(?:manifest|icon)[^>]*>/g,'');
const server = http.createServer((req,res) => { const name = new URL(req.url,'http://localhost').pathname; if(name==='/') {res.setHeader('Content-Type','text/html');res.end(html);return;} try {res.setHeader('Content-Type',name.endsWith('.css')?'text/css':'text/javascript');res.end(fs.readFileSync(new URL(name.slice(1),root)));}catch{res.writeHead(404).end();} });
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'usage-chrome-'));
const chrome=await chromium.launchPersistentContext(profile,{executablePath:process.env.CHROMIUM_PATH || chromium.executablePath(),headless:true,args:['--remote-debugging-port=0','--disable-gpu','--disable-background-networking']});
const sleep=ms=>new Promise(r=>setTimeout(r,ms)); let ws;
let count=0; const checks=[];
function check(name,ok){checks.push({name,ok:!!ok});console.log((ok?'PASS ':'FAIL ')+name);if(!ok)throw Error(name);count++;}
try {
 for(let i=0;i<80&&!fs.existsSync(path.join(profile,'DevToolsActivePort'));i++)await sleep(100);
 const port=fs.readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').split('\n')[0];
 const pages=await(await fetch('http://127.0.0.1:'+port+'/json/list')).json();
 ws=new WebSocket(pages.find(p=>p.type==='page').webSocketDebuggerUrl);await new Promise(r=>ws.onopen=r);
 let seq=0;const pending=new Map();ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){pending.get(m.id)?.(m);pending.delete(m.id);}};
 const send=(method,params={})=>new Promise(r=>{const id=++seq;pending.set(id,r);ws.send(JSON.stringify({id,method,params}));});
 const ev=async expression=>{const m=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(m.result?.exceptionDetails)throw Error(m.result.exceptionDetails.exception?.description||m.result.exceptionDetails.text);return m.result?.result?.value;};
 const click=async id=>{const r=await ev("(()=>{const e=q('"+id+"'),r=e.getBoundingClientRect();if(!r.width||!r.height||e.hidden||e.disabled||document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)!==e&&!e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)))throw Error('Not clickable: "+id+"');return {x:r.x+r.width/2,y:r.y+r.height/2}})()");await send('Input.dispatchMouseEvent',{type:'mousePressed',...r,button:'left',clickCount:1});await send('Input.dispatchMouseEvent',{type:'mouseReleased',...r,button:'left',clickCount:1});};
 await send('Page.enable');await send('Page.navigate',{url:'http://127.0.0.1:'+server.address().port});await sleep(300);
 await ev(fs.readFileSync(new URL('usage.js',root),'utf8'));
 await ev(
  "window.ctx={user:'fixture',agent:'a',key:'agent:a:dashboard:test&space x',provider:'test',model:'fixture',enabled:true};window.calls=[];window.mode='ok';window.fixture=()=>({agentId:ctx.agent,key:ctx.key,provider:ctx.provider,model:ctx.model,subscription:{status:'ready',plan:'Plan de prueba',windows:[{label:'5h',usedPercent:30,resetAt:Date.now()+3600000},{label:'168h',usedPercent:5,resetAt:Date.now()+86400000}],updatedAt:Date.now(),shared:true,scope:'agent-provider',credentialType:'oauth'},tokens:{status:'ready',input:123456,output:0,cacheRead:null,cacheWrite:12345,total:135801,partial:true,updatedAt:Date.now()-600000}});window.fakeFetch=async(url,opts)=>{calls.push(url);if(mode==='delay')return new Promise(r=>window.delayed=()=>r({ok:true,json:async()=>window.oldData}));if(mode==='denied')return {ok:false,status:window.denyStatus||403};if(mode==='fail')throw Error('fixture');if(mode==='timeout')return new Promise((r,j)=>opts.signal.addEventListener('abort',()=>j(Error('aborted'))));return {ok:true,json:async()=>fixture()};};HubUsage.init({context:()=>ctx,fetch:fakeFetch});document.querySelector('#login-view').classList.add('hidden');document.querySelector('#app').classList.remove('hidden');document.querySelector('#composer').classList.remove('hidden');window.q=id=>document.getElementById(id);"
 );
 await sleep(80);
 check('initial inline quota fetch',await ev('calls.length===1'));
 await ev("q('ctx-meter').classList.remove('hidden');q('ctx-text').textContent='Ctx · 24% usado';q('ctx-fill').style.width='24%';q('chat-title').textContent='Conversación de prueba';q('model-controls').classList.remove('hidden');for(const [id,text] of [['provider-select','OpenAI'],['model-select','GPT'],['effort-select','Medio']])q(id).add(new Option(text,text));");
 for(const [width,height] of [[1440,1000],[320,568],[390,844],[844,390]]){
  await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:width<900});await sleep(300);
  check('inline bars and human labels '+width,await ev("q('usage-summary').textContent.includes('5 h · 70 % restante')&&q('usage-summary').textContent.includes('Semana · 95 % restante')&&q('usage-summary').querySelectorAll('.usage-track').length===2"));
  check('compact row no overflow '+width,await ev("(()=>{const r=document.querySelector('.session-meters').getBoundingClientRect();return q('ctx-meter').getBoundingClientRect().width>0&&r.height<=46&&document.elementFromPoint(q('btn-usage').getBoundingClientRect().x+10,r.y+22)?.closest('#btn-usage')&&r.right<=innerWidth&&q('btn-usage').getBoundingClientRect().right<=innerWidth&&document.documentElement.scrollWidth<=innerWidth})()"));
  const inline=await send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,'inline-'+width+'.png'),Buffer.from(inline.result.data,'base64'));
  await click('btn-usage');await sleep(80);
  check('remaining 70/95 '+width,await ev("q('usage-content').textContent.includes('70 % restante')&&q('usage-content').textContent.includes('95 % restante')"));
  check('viewport and touch targets '+width,await ev("(()=>{const d=q('usage-dialog').getBoundingClientRect();return d.left>=0&&d.right<=innerWidth&&d.top>=0&&d.bottom<=innerHeight&&['usage-close','usage-refresh'].every(id=>{const r=q(id).getBoundingClientRect();return r.height>=44&&document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===q(id)})})()"));
  check('internal scroll '+width,await ev("(()=>{const s=document.querySelector('.usage-scroll');s.scrollTop=10000;return s.scrollHeight<=s.clientHeight||s.scrollTop>0})()"));
  await ev("document.querySelector('.usage-scroll').scrollTop=0");
  const shot=await send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,'usage-'+width+'.png'),Buffer.from(shot.result.data,'base64'));
  await click('usage-close');await sleep(40);check('close restores focus '+width,await ev("!q('usage-dialog').open&&document.activeElement===q('btn-usage')"));
 }
 await click('btn-usage');await sleep(60);
 await ev("window.beforeTerminal=calls.length;for(let i=0;i<10;i++)HubUsage.terminal({agentId:ctx.agent,sessionKey:ctx.key,runId:'fixture-run'});HubUsage.terminal({agentId:'other',sessionKey:ctx.key,runId:'other'});");
 await sleep(3200);
 check('terminal refresh coalesced and scoped',await ev('calls.length===beforeTerminal+1'));
 await ev("HubUsage.terminal({agentId:ctx.agent,sessionKey:ctx.key,runId:'fixture-run'})");await sleep(3200);
 check('duplicate terminal and idle no polling',await ev('calls.length===beforeTerminal+1'));
 check('token zero and unknown distinct',await ev("[...document.querySelectorAll('.usage-tokens dd')].map(n=>n.textContent).join('|')==='123.456|0|No disponible|12.345|135.801'"));
 check('partial and stale explicit',await ev("q('usage-content').textContent.includes('Registro parcial')&&q('usage-content').textContent.includes('Datos antiguos')"));
 check('provider OAuth scope explicit',await ev("q('usage-content').textContent.includes('Cuenta OAuth de OpenAI configurada para este agente')"));
 check('native key encoded',await ev("new URL(calls[0],location.origin).searchParams.get('key')===ctx.key&&!calls[0].includes('***')"));
 await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await sleep(60);check('escape closes',await ev("!q('usage-dialog').open"));
 // Each scope begins hidden; establish a fresh photo before exercising actual controls.
 const fresh=async()=>{await ev("mode='ok';ctx.key+='fresh';HubUsage.sync()");await sleep(80);};
 for(const field of ['key','agent','user','model','provider']){
  await fresh();await click('btn-usage');await ev("mode='delay';oldData=fixture()");await click('usage-refresh');await sleep(40);
  await ev('ctx.'+field+"+='changed';HubUsage.sync();delayed();mode='fail'");await sleep(80);
  check('late response discarded on '+field,await ev("!q('usage-dialog').open&&!q('usage-content').textContent&&q('btn-usage').hidden"));
  await ev('HubUsage.sync()');check('sync stays hidden on '+field,await ev("q('btn-usage').hidden"));
 }
 await fresh();await click('btn-usage');await ev("mode='fail'");await click('usage-refresh');await sleep(50);
 check('failure preserves labelled photo and retry',await ev("!q('btn-usage').hidden&&q('usage-summary').textContent.includes('Sin actualizar')&&!q('usage-refresh').disabled"));
 await ev("mode='ok'");await click('usage-refresh');await sleep(50);check('retry succeeds',await ev("q('usage-status').textContent.includes('completada')"));
 await ev("window.originalFixture=fixture;fixture=()=>{const d=originalFixture();d.subscription.windows=[{label:'Unknown',usedPercent:null},{label:'<img src=x onerror=window.xss=1>',usedPercent:0},{label:'Full',usedPercent:100},{label:'Negative',usedPercent:-1},{label:'Too high',usedPercent:101},{label:'String',usedPercent:'30'}];d.subscription.reason='<script>window.xss=1</script>';return d}");await click('usage-refresh');await sleep(50);
 check('only real percentages including bounds',await ev("document.querySelectorAll('.usage-mini').length===2&&q('usage-content').textContent.includes('100 % restante')&&q('usage-content').textContent.includes('0 % restante')&&!q('usage-content').textContent.includes('Unknown')"));
 check('server prose inert',await ev("!window.xss&&!q('usage-content').querySelector('img,script')&&q('usage-content').textContent.includes('<img')"));
 await ev("fixture=()=>{const d=originalFixture();d.tokens.status='refreshing';return d}");await click('usage-refresh');await sleep(50);
 check('stale token values remain visible',await ev("q('usage-content').textContent.includes('135.801')&&q('usage-content').textContent.includes('Actualizando en el proveedor')"));
 for(const status of ['refreshing','unavailable']){
  await ev("fixture=()=>{const d=originalFixture();d.subscription={status:'"+status+"',windows:[]};return d}");await click('usage-refresh');await sleep(50);
  check('retained quota labelled '+status,await ev("!q('btn-usage').hidden&&q('usage-summary').textContent.includes('Sin actualizar')&&q('usage-content').querySelectorAll('progress').length===2"));
 }
 await click('usage-close');
 for(const state of ['loading','unsupported','unavailable','refreshing','empty','nulls','error']){
  await ev("fixture=()=>{const d=originalFixture();d.subscription={status:'"+(['empty','nulls'].includes(state)?'ready':state)+"',windows:"+(state==='nulls'?"[{usedPercent:null},{usedPercent:'0'},{usedPercent:-1},{usedPercent:101}]":"[]")+"};return d};mode='"+(state==='loading'?'delay':state==='error'?'fail':'ok')+"';ctx.key+='absent';HubUsage.sync()");await sleep(70);
  await ev("HubUsage.sync();q('ctx-text').textContent='Ctx · 19% usado';q('ctx-fill').style.width='19%'");
  for(const [width,height] of [[1440,1000],[390,844]]){
   await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:width===390});await sleep(400);
   check('context only '+state+' '+width,await ev("(()=>{const r=document.querySelector('.session-meters').getBoundingClientRect();return q('btn-usage').hidden&&getComputedStyle(q('btn-usage')).display==='none'&&!q('usage-summary').textContent&&!q('usage-dialog').open&&q('ctx-meter').getBoundingClientRect().width>0&&document.elementFromPoint(q('ctx-text').getBoundingClientRect().x+4,q('ctx-text').getBoundingClientRect().y+4)===q('ctx-text')&&r.height>=30&&r.height<=40&&document.documentElement.scrollWidth<=innerWidth})()"));
   if(state==='unsupported'){const shot=await send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,'context-only-'+width+'.png'),Buffer.from(shot.result.data,'base64'));}
  }
 }
 await ev("fixture=originalFixture");await fresh();await click('btn-usage');await ev("mode='delay';oldData=fixture()");await click('usage-refresh');await sleep(40);await ev("HubUsage.reset();delayed()");await sleep(40);
 check('logout clears and aborts',await ev("!q('usage-dialog').open&&!q('usage-content').textContent&&q('btn-usage').hidden"));
 await ev("ctx.enabled=false;HubUsage.sync();window.before=calls.length");await sleep(80);check('disabled feature no request',await ev("q('btn-usage').hidden&&calls.length===before"));
 // Native provider credits: a standalone value beside quota windows, never currency,
 // never a proportional bar, and never retained across scopes, errors or absence.
 await ev("ctx={user:'credit',agent:'a',key:'agent:a:credit',provider:'openai',model:'fixture',enabled:true};window.creditValue=1234.5;window.creditData=value=>{const d={agentId:ctx.agent,key:ctx.key,provider:ctx.provider,model:ctx.model,subscription:{status:'ready',plan:'Plan de prueba',windows:[{label:'5h',usedPercent:30,resetAt:Date.now()+3600000},{label:'168h',usedPercent:5,resetAt:Date.now()+86400000}],updatedAt:Date.now(),shared:true,scope:'agent-provider',credentialType:'oauth'},tokens:{status:'ready',input:11,output:7,cacheRead:3,cacheWrite:2,total:23,partial:false,updatedAt:Date.now()}};if(value!==undefined)d.subscription.creditBalance=value;return d};fixture=()=>creditData(creditValue);mode='ok';HubUsage.sync()");await sleep(100);
 check('credit row shown beside windows as native credits',await ev("q('usage-summary').textContent.includes('Saldo: 1234,5 créditos')&&q('usage-summary').querySelector('.usage-credit')&&q('usage-summary').querySelectorAll('.usage-track').length===2&&!q('usage-summary').querySelector('.usage-credit .usage-track')&&!/[€$%]/.test(q('usage-summary').querySelector('.usage-credit').textContent)"));
 for(const [width,height] of [[1440,1000],[390,844],[320,568]]){
  await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:width<900});await sleep(320);
  check('credit compact row fits '+width,await ev("(()=>{const r=document.querySelector('.session-meters').getBoundingClientRect(),b=q('btn-usage').getBoundingClientRect(),c=q('usage-summary').querySelector('.usage-credit').getBoundingClientRect();return r.height<=80&&b.right<=innerWidth&&c.right<=innerWidth&&c.top>=r.top&&c.bottom<=r.bottom&&document.documentElement.scrollWidth<=innerWidth&&q('usage-summary').textContent.includes('Saldo: 1234,5 créditos')})()"));
  const shot=await send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,'credit-inline-'+width+'.png'),Buffer.from(shot.result.data,'base64'));
 }
 await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});await sleep(250);await click('btn-usage');await sleep(80);
 check('credit detail explains provider credits, no bar',await ev("q('usage-content').textContent.includes('Saldo de créditos del proveedor: 1234,5 créditos')&&q('usage-content').textContent.includes('no es facturación de la API')&&!q('usage-content').querySelector('.usage-credit-detail progress')&&!q('usage-content').querySelector('.usage-credit-detail .usage-track')&&!/[€$]/.test(q('usage-content').querySelector('.usage-credit-value').textContent)&&!q('usage-content').querySelector('.usage-balance-link')"));
 {const shot=await send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,'credit-detail-1440.png'),Buffer.from(shot.result.data,'base64'));}
 await ev("creditValue=0");await click('usage-refresh');await sleep(80);
 check('zero credit is real zero, not absent',await ev("q('usage-summary').textContent.includes('Saldo: 0 créditos')&&q('usage-content').textContent.includes('Saldo de créditos del proveedor: 0 créditos')"));
 {const shot=await send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,'credit-zero-1440.png'),Buffer.from(shot.result.data,'base64'));}
 await ev("creditValue=0.004");await click('usage-refresh');await sleep(80);
 check('fractional credit never rounds to zero',await ev("q('usage-summary').textContent.includes('Saldo: 0,004 créditos')&&!q('usage-summary').textContent.includes('Saldo: 0 créditos')&&q('usage-content').textContent.includes('Saldo de créditos del proveedor: 0,004 créditos')"));
 for (const [amount,text] of [[1.005,'1,005 créditos'],[1,'1 crédito'],[1e-32,'1E-32 créditos']]) {
  await ev('creditValue='+amount);await click('usage-refresh');await sleep(80);
  check('precise native balance '+amount,await ev("q('usage-summary').querySelector('.usage-credit').textContent==="+JSON.stringify('Saldo: '+text)));
 }
 for(const [label,value] of [['undefined',undefined],['null',null],['negative',-3],['string','12']]){
  await ev('creditValue='+JSON.stringify(value));await click('usage-refresh');await sleep(80);
   check('absent credit has no text, detail or link ('+label+')',await ev("!q('usage-summary').textContent.includes('Saldo')&&!q('usage-content').innerText.toLowerCase().includes('saldo')&&!q('usage-content').querySelector('.usage-credit-detail,a')&&q('usage-content').querySelectorAll('progress').length===2"));
 }
 await ev("creditValue=undefined;window.beforeLink=calls.length");await click('usage-refresh');await sleep(120);await sleep(250);
 check('no substitute or navigation when the provider omits balance',await ev("calls.length===beforeLink+1&&!q('usage-dialog').querySelector('a')"));
 await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});await sleep(300);
 check('mobile retains both real windows with no balance note',await ev("q('usage-dialog').open&&q('usage-content').querySelectorAll('progress').length===2&&!q('usage-content').innerText.toLowerCase().includes('saldo')&&!q('usage-dialog').querySelector('a')&&document.documentElement.scrollWidth<=innerWidth"));
 {const shot=await send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,'quota-without-credit-390.png'),Buffer.from(shot.result.data,'base64'));}
 await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});await sleep(250);
 await ev("creditValue=88.25");await click('usage-refresh');await sleep(80);
 check('credit restored before failure',await ev("q('usage-summary').textContent.includes('Saldo: 88,25 créditos')"));
 await ev("mode='fail'");await click('usage-refresh');await sleep(100);
 check('failure drops prior credit but keeps stale windows',await ev("!q('usage-summary').textContent.includes('Saldo')&&q('usage-summary').textContent.includes('Sin actualizar')&&q('usage-summary').querySelectorAll('.usage-track').length===2&&!q('usage-content').textContent.includes('Saldo de créditos del proveedor')&&!q('usage-content').innerText.toLowerCase().includes('saldo')&&q('usage-content').querySelectorAll('progress').length===2&&!q('usage-content').querySelector('.usage-balance-link')"));
 await ev("mode='ok'");await click('usage-refresh');await sleep(80);check('credit returns after retry',await ev("q('usage-summary').textContent.includes('Saldo: 88,25 créditos')"));
 for(const status of [401,403]){
  await ev("mode='denied';denyStatus="+status);await click('usage-refresh');await sleep(100);
  check('denied '+status+' drops prior credit',await ev("!q('usage-summary').textContent.includes('Saldo')&&q('usage-summary').textContent.includes('Sin actualizar')&&q('usage-summary').querySelectorAll('.usage-track').length===2&&!q('usage-content').textContent.includes('Saldo de créditos del proveedor')"));
  await ev("mode='ok'");await click('usage-refresh');await sleep(80);
 }
 await ev("creditValue=66;mode='ok'");await click('usage-refresh');await sleep(80);check('credit established before identity switch',await ev("q('usage-summary').textContent.includes('Saldo: 66 créditos')"));
 await ev("mode='delay';oldData=creditData(66)");await click('usage-refresh');await sleep(40);
 await ev("ctx.key='agent:a:credit-switch';HubUsage.sync();mode='fail';delayed()");await sleep(120);
 check('in-flight credit discarded on identity switch',await ev("!q('usage-dialog').open&&!q('usage-summary').textContent&&q('btn-usage').hidden&&q('usage-credit-only').hidden&&!q('usage-content').textContent.includes('Saldo')"));
 await ev("ctx={user:'credit',agent:'a',key:'agent:a:credit-only',provider:'openai',model:'fixture',enabled:true};creditValue=42.75;fixture=()=>{const d=creditData(42.75);d.subscription.windows=[];return d};mode='ok';HubUsage.reset();HubUsage.sync()");await sleep(100);
 check('credit-only is visible read-only, not a button',await ev("q('btn-usage').hidden&&!q('usage-dialog').open&&!q('usage-credit-only').hidden&&q('usage-credit-only').textContent==='Saldo: 42,75 créditos'&&q('usage-credit-only').tagName==='SPAN'&&!q('usage-credit-only').closest('button')&&q('usage-credit-only').tabIndex===-1&&!q('usage-credit-only').hasAttribute('tabindex')&&!q('usage-summary').textContent"));
 await ev("q('ctx-meter').classList.add('hidden')");await sleep(80);
 check('credit-only row visible without context meter',await ev("(()=>{const m=document.querySelector('.session-meters'),r=m.getBoundingClientRect(),c=q('usage-credit-only').getBoundingClientRect();return getComputedStyle(m).display!=='none'&&r.height>=40&&r.height<=52&&c.width>0&&c.right<=innerWidth&&document.documentElement.scrollWidth<=innerWidth})()"));
 await ev("q('ctx-meter').classList.remove('hidden')");await sleep(40);
 for(const [width,height] of [[390,844],[320,568]]){
  await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:true});await sleep(320);
  await ev("q('ctx-text').textContent='Ctx · 19% usado';q('ctx-fill').style.width='19%'");await sleep(80);
  check('credit-only indicator fits '+width,await ev("(()=>{const r=document.querySelector('.session-meters').getBoundingClientRect(),c=q('usage-credit-only').getBoundingClientRect();return !q('usage-credit-only').hidden&&c.width>0&&c.right<=innerWidth&&c.top>=r.top&&c.bottom<=r.bottom&&r.height>=30&&r.height<=52&&document.documentElement.scrollWidth<=innerWidth&&getComputedStyle(q('usage-credit-only')).display!=='none'})()"));
  const shot=await send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,'credit-only-'+width+'.png'),Buffer.from(shot.result.data,'base64'));
 }
 await ev("HubUsage.reset()");
 check('reset clears credit-only indicator',await ev("q('usage-credit-only').hidden&&!q('usage-credit-only').textContent&&!q('usage-summary').textContent"));
 await ev("ctx={user:'credit',agent:'a',key:'agent:a:credit-small',provider:'openai',model:'fixture',enabled:true};fixture=()=>creditData(9.5);mode='ok';HubUsage.sync()");await sleep(100);
 await send('Emulation.setDeviceMetricsOverride',{width:844,height:390,deviceScaleFactor:1,mobile:true});await sleep(300);await click('btn-usage');await sleep(80);
 check('credit detail fits short landscape and scrolls',await ev("(()=>{const d=q('usage-dialog').getBoundingClientRect(),s=document.querySelector('.usage-scroll');return d.left>=0&&d.right<=innerWidth&&d.top>=0&&d.bottom<=innerHeight&&['usage-close','usage-refresh'].every(id=>{const r=q(id).getBoundingClientRect();return r.height>=44&&document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===q(id)})&&q('usage-content').textContent.includes('Saldo de créditos del proveedor: 9,5 créditos')&&(s.scrollHeight<=s.clientHeight||(s.scrollTop=10000,s.scrollTop>0))})()"));
 await ev("document.querySelector('.usage-scroll').scrollTop=0");await sleep(60);
 {const shot=await send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,'credit-detail-844x390.png'),Buffer.from(shot.result.data,'base64'));}
 await click('usage-close');await sleep(40);
 await ev("mode='fail';ctx.provider='other';HubUsage.sync()");await sleep(60);
 check('provider switch clears credit immediately',await ev("!q('usage-summary').textContent&&q('usage-credit-only').hidden&&q('btn-usage').hidden&&!q('usage-content').textContent.includes('Saldo')"));
 await ev("ctx.provider='openai';ctx.user='other';mode='fail';HubUsage.sync()");await sleep(60);
 check('profile switch clears credit immediately',await ev("!q('usage-summary').textContent&&q('usage-credit-only').hidden&&q('btn-usage').hidden"));
 await ev("ctx.key='agent:a:nonopenai';ctx.user='credit';ctx.provider='other';creditValue=undefined;fixture=()=>creditData(undefined);mode='ok';HubUsage.sync()");await sleep(100);await click('btn-usage');await sleep(80);
 check('other providers also have no substitute for missing balance',await ev("q('usage-content').textContent.includes('Sin datos disponibles')===false&&!q('usage-content').querySelector('.usage-balance-link')&&!q('usage-content').textContent.includes('Saldo no disponible para esta cuenta')&&q('usage-content').querySelectorAll('progress').length===2"));
 await click('usage-close');
 console.log('RESULTADO: TODO OK ('+count+')');
}finally{fs.writeFileSync(path.join(out,'checks.json'),JSON.stringify(checks,null,2));ws?.close();await chrome.close();server.close();}
