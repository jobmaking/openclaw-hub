'use strict';
const assert=require('node:assert/strict');
const { test }=require('node:test');
const { scryptSync }=require('node:crypto');
const { spawn }=require('node:child_process');
const { once }=require('node:events');
const fs=require('node:fs/promises');
const net=require('node:net');
const os=require('node:os');
const path=require('node:path');
const {setTimeout:delay}=require('node:timers/promises');

test('real Hub advertises workInbox inside capabilities and keeps the API private',{timeout:10000},async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'hub-work-branding-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const s=net.createServer();s.listen(0,'127.0.0.1');await once(s,'listening');
  const port=s.address().port;await new Promise(r=>s.close(r));
  const password='isolated-fixture-key',salt='fixture-salt';
  await fs.writeFile(path.join(dir,'agents.json'),JSON.stringify([{id:'fixture',name:'Fixture',url:'ws://127.0.0.1:1',token:'local-fixture'}]),{mode:0o600});
  await fs.writeFile(path.join(dir,'users.json'),JSON.stringify([{u:'fixture',pw:'scrypt$'+salt+'$'+scryptSync(password,salt,64).toString('hex'),allowedAgents:['fixture']}]),{mode:0o600});
  const hub=spawn(process.execPath,['server.js'],{cwd:path.resolve(__dirname,'..'),
    env:{PATH:process.env.PATH,HOME:dir,DATA_DIR:dir,BIND:'127.0.0.1',PORT:String(port)},stdio:'ignore'});
  t.after(async()=>{if(hub.exitCode!==null||hub.signalCode!==null)return;const end=once(hub,'exit');hub.kill();await end;});
  const root='http://127.0.0.1:'+port;
  const get=(url,opts={})=>fetch(root+url,{...opts,signal:AbortSignal.timeout(1700)});
  let res;
  for(let i=0;i<55;i++){
    assert.equal(hub.exitCode,null);
    try{res=await get('/api/branding');break;}catch{await delay(85);}
  }
  assert.equal(res?.status,200);
  const branding=await res.json();assert.equal(branding.capabilities?.workInbox,true);assert.equal(branding.workInbox,undefined);
  assert.equal(branding.capabilities?.artifactMedia,true);
  assert.equal((await get('/api/work-inbox')).status,401);
  assert.equal((await get('/api/artifact-media')).status,401);
  const login=await get('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({u:'fixture',p:password})});
  assert.equal(login.status,200);const cookie=login.headers.getSetCookie()[0]?.split(';')[0];assert.ok(cookie);
  const authed=await get('/api/work-inbox',{headers:{Cookie:cookie}});assert.equal(authed.status,200);
  assert.match(authed.headers.get('cache-control'),/private.*no-store/);
  const result=await authed.json();assert.deepEqual(result.deliveries,[]);assert.equal(result.partial,true);
  assert.equal((await fs.stat(path.join(dir,'work-inbox','following.sqlite3'))).mode&0o777,0o600);
});
