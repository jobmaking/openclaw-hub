'use strict';
// Real Electron permission dialogs and OS keyboard input on a private X display.
// Synthetic audio devices only: no user's account, profile or microphone.
const { spawn, spawnSync } = require('node:child_process');
if (process.env.HUB_MICROPHONE_ISOLATED !== '1') {
  const run = spawnSync('xvfb-run', ['-a', '-s', '-screen 0 1360x900x24', 'dbus-run-session', '--', process.execPath, __filename], {
    env: { ...process.env, HUB_MICROPHONE_ISOLATED: '1', GTK_USE_PORTAL: '0', NO_AT_BRIDGE: '1', GIO_USE_VFS: 'local' }, stdio: 'inherit' });
  process.exit(run.status ?? 1);
}
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { once } = require('node:events'), { CDP } = require('./cdp.cjs');
const root = path.resolve(__dirname, '..'), evidence = process.env.HUB_DESKTOP_EVIDENCE || fs.mkdtempSync(path.join(os.tmpdir(), 'hub-microphone-'));
const profile = path.join(evidence, 'profile'); fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
const checks = []; let child, local, remote, log = '', origin;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function check(label, value) { checks.push({ label, ok: !!value }); console.log((value ? 'PASS ' : 'FAIL ') + label); if (!value) throw new Error(label); }
async function until(label, read, maximum = 15000) { const start = Date.now(); while (Date.now() - start < maximum) { const result = await read(); if (result) return result; await sleep(80); } throw new Error('Timeout: ' + label); }
const fixtureHtml = `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Hub microphone fixture</title><style>body{background:#171923;color:#eee;font:16px system-ui;padding:20px}.hidden{display:none!important}button,input,textarea{font:inherit;padding:12px;margin:4px}textarea{display:block;width:85%}#voice-draft{padding:16px;border:1px solid #858299;border-radius:12px}audio{vertical-align:middle}#voice-notice{padding:12px}.voice-draft-head,.voice-player{display:flex;align-items:center;gap:12px}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden}svg{width:24px;height:24px;fill:none;stroke:currentColor}</style></head><body>
<h1>Nota de voz · integración del escritorio</h1><textarea id="input" aria-label="Texto del borrador"></textarea><button id="btn-voice" class="hidden">Grabar nota</button><div id="voice-draft" class="hidden"></div><div id="voice-notice" class="hidden" role="status"></div><label id="voice-preferences" class="hidden"><input id="voice-replies" type="checkbox">Responder con voz</label>
<script src="/voice.js"></script><script>
window.result = 'idle'; window.stream = null; window.voiceTracks=[];
const realCapture=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
navigator.mediaDevices.getUserMedia=async constraints=>{const stream=await realCapture(constraints);window.voiceTracks.push(...stream.getTracks());return stream;};
async function requestCapture(constraints){window.result='pending';try{window.stream=await navigator.mediaDevices.getUserMedia(constraints);window.result='granted';}catch(error){window.result=error.name;}}
let draft=JSON.parse(localStorage.getItem('mic-fixture-draft')||'{"text":""}');const editor=document.getElementById('input');editor.value=draft.text;
const context={user:'native-mic-fixture',agent:'bu',key:'agent:main:microphone',sessionId:'mic-transcript',voiceEnabled:true};
const adapter={context:()=>context,fetch:window.fetch.bind(window),readDraft:()=>draft,writeDraft:next=>{draft=next;localStorage.setItem('mic-fixture-draft',JSON.stringify(draft));},saveDraft(){this.writeDraft({...draft,text:editor.value});},restoreDraft(){editor.value=draft.text;},updateComposer(){},refreshHistory(){}};
editor.addEventListener('input',()=>adapter.saveDraft());HubVoice.init(adapter);HubVoice.select(context);
</script></body></html>`;
function serveFixture(req,res){if(req.url==='/voice.js'){res.setHeader('Content-Type','text/javascript');res.end(fs.readFileSync(path.join(root,'../public/voice.js')));return;}
  if(req.url.startsWith('/api/')){res.setHeader('Content-Type','application/json');res.end(req.url.startsWith('/api/voice/status')?JSON.stringify({enabled:true,available:true,stt:true,tts:true,maxSeconds:300,maxBytes:26214400}):'{}');return;}
  res.setHeader('Content-Type','text/html');res.end(fixtureHtml);}
const fixture=http.createServer(serveFixture),another=http.createServer(serveFixture);
const settings = () => JSON.parse(fs.readFileSync(path.join(profile, 'settings.json'), 'utf8'));
function native(action, keys = []) {
  const script = `import os,json,sys,time
from Xlib import X,XK,display
from Xlib.ext import xtest
if os.environ.get('DISPLAY','').split('.')[0] in (':0',':1'): raise RuntimeError('An isolated X display is required')
d=display.Display(); windows=[]
def walk(w):
 try:
  name=w.get_wm_name() or ''
  if name and w.get_attributes().map_state==X.IsViewable: windows.append((w,name))
  for child in w.query_tree().children: walk(child)
 except Exception: pass
walk(d.screen().root)
dialogs=[(w,n) for w,n in windows if n=='Micrófono de Hub']
action=sys.argv[1]
if action=='list': print(json.dumps([n for w,n in windows],ensure_ascii=False))
elif action=='click':
 xtest.fake_input(d,X.MotionNotify,x=int(sys.argv[2]),y=int(sys.argv[3]));d.sync();time.sleep(.1)
 xtest.fake_input(d,X.ButtonPress,1);xtest.fake_input(d,X.ButtonRelease,1);d.sync();print('OK')
else:
 if dialogs: d.set_input_focus(dialogs[-1][0],X.RevertToParent,X.CurrentTime);d.sync()
 for name in sys.argv[2:]:
  code=d.keysym_to_keycode(XK.string_to_keysym(name))
  xtest.fake_input(d,X.KeyPress,code);xtest.fake_input(d,X.KeyRelease,code);d.sync();time.sleep(.12)
 print('OK')
d.close()
`;
  const call = spawnSync('/usr/bin/python3', ['-c', script, action, ...keys], { env: process.env, encoding: 'utf8' });
  if (call.status !== 0) throw new Error(call.stderr); return action === 'list' ? JSON.parse(call.stdout) : call.stdout;
}
async function start(url = origin) {
  const active = path.join(profile, 'DevToolsActivePort'); fs.rmSync(active, { force: true });
  child = spawn(path.join(root, 'openclaw-hub-desktop'), ['--password-store=basic', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', '--use-fake-device-for-media-stream'],
    { env: { ...process.env, HUB_URL: url, HUB_USER_DATA_DIR: profile, XDG_CONFIG_HOME: path.join(evidence, 'config'), XDG_STATE_HOME: path.join(evidence, 'state') }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', data => { log += data; });
  await until('Electron debug endpoint', () => fs.existsSync(active)); const port = fs.readFileSync(active, 'utf8').split('\n')[0];
  const targets = await until('native shell and remote document', async () => { try { const value = await fetch('http://127.0.0.1:' + port + '/json/list').then(r => r.json()); return value.some(item => item.url.startsWith('file:')) && value.some(item => item.url.startsWith('http:')) ? value : null; } catch { return null; } });
  local = await CDP.connect(targets.find(item => item.url.startsWith('file:')).webSocketDebuggerUrl);
  remote = await CDP.connect(targets.find(item => item.url.startsWith('http:')).webSocketDebuggerUrl);
  await until('loaded fixture', () => remote.evaluate('typeof requestCapture === "function" && !document.getElementById("btn-voice").classList.contains("hidden")'));
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  const exited = once(child, 'exit'); try { await local.evaluate('hubDesktop.command("close")'); } catch {}
  await Promise.race([exited, sleep(2500)]); if (child.exitCode === null) child.kill('SIGTERM');
  local?.close(); remote?.close();
}
async function request(constraints) { await remote.evaluate('void requestCapture(' + JSON.stringify(constraints) + ')'); }
async function waitDialog() { return until('native microphone consent', () => native('list').includes('Micrófono de Hub')); }
async function answer(keys) { native('keys', keys); return until('capture result', () => remote.evaluate('window.result!=="pending" && window.result')); }
async function clickShell(id){const point=await local.evaluate('(() => {const r=document.getElementById('+JSON.stringify(id)+').getBoundingClientRect();return {x:screenX+r.x+r.width/2,y:screenY+r.y+r.height/2};})()');native('click',[String(Math.round(point.x)),String(Math.round(point.y))]);}
(async () => {
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve)); await new Promise(resolve => another.listen(0, '127.0.0.1', resolve)); origin = 'http://127.0.0.1:' + fixture.address().port;
  try {
    await start();
    check('Linux release is 1.0.4 and remote content has no Node or privileged bridge', await local.evaluate('state.version === "1.0.4"') && await remote.evaluate('typeof require === "undefined" && typeof hubDesktop === "undefined"'));
    for (const constraints of [{ video: true }, { audio: true, video: true }]) {
      await request(constraints); const result = await until('camera denied', () => remote.evaluate('window.result!=="pending" && window.result'));
      check('camera/mixed media are rejected without a microphone consent dialog: ' + JSON.stringify(constraints), result === 'NotAllowedError' && !native('list').includes('Micrófono de Hub'));
    }
    await request({ audio: true, video: false }); await waitDialog();
    check('microphone requires a real native consent dialog before any capture', await remote.evaluate('window.result === "pending" && !window.stream'));
    spawnSync('import', ['-window', 'root', path.join(evidence, 'native-consent.png')]);
    check('default native action refuses microphone access', await answer(['Return']) === 'NotAllowedError' && settings().microphone === false);
    await stop(); await start(); await request({ audio: true, video: false });
    check('refusal is retained across restart without prompting again', await until('persisted refusal', () => remote.evaluate('window.result!=="pending" && window.result')) === 'NotAllowedError' && !native('list').includes('Micrófono de Hub'));
    await stop();
    const reset = settings(); delete reset.microphone; fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify(reset), { mode: 0o600 });
    await start(); await request({ audio: true, video: false }); await waitDialog();
    check('explicit Allow in the native dialog enables audio-only capture', await answer(['Left', 'Return']) === 'granted' && settings().microphone === true && settings().microphoneOrigin === origin);
    check('granted capture has one audio track and no camera tracks', await remote.evaluate('window.stream.getAudioTracks().length===1 && window.stream.getVideoTracks().length===0'));
    check('the visible microphone control reflects consent and has a 44px accessible target',await until('microphone indicator',()=>local.evaluate('(() => {const b=document.getElementById("microphone-toggle"),r=b.getBoundingClientRect();return b.getAttribute("aria-pressed")==="true"&&r.width>=44&&r.height>=44&&b.getAttribute("aria-label").includes("desactivarlo");})()')));
    await remote.evaluate('window.stream.getTracks().forEach(track=>track.stop())');
    for(const constraints of [{video:true},{audio:true,video:true}]){await request(constraints);check('microphone consent never upgrades to camera/mixed access: '+JSON.stringify(constraints),await until('camera blocked despite microphone grant',()=>remote.evaluate('window.result!=="pending"&&window.result'))==='NotAllowedError'&&!native('list').includes('Micrófono de Hub'));}
    check('microphone consent never permits screen capture',await remote.evaluate('navigator.mediaDevices.getDisplayMedia({video:true}).then(stream=>{stream.getTracks().forEach(track=>track.stop());return "granted";},error=>error.name)')==='NotAllowedError');
    await remote.evaluate(`(() => {const frame=document.createElement('iframe');frame.id='same-frame';frame.src='/frame';frame.allow='microphone';document.body.appendChild(frame);})()`);
    await until('same-origin frame fixture', () => remote.evaluate('typeof document.getElementById("same-frame").contentWindow.requestCapture === "function"'));
    await remote.evaluate('void document.getElementById("same-frame").contentWindow.requestCapture({audio:true,video:false})');
    check('same-origin subframes remain unable to capture after the main-frame grant', await until('subframe refusal', () => remote.evaluate('document.getElementById("same-frame").contentWindow.result!=="pending" && document.getElementById("same-frame").contentWindow.result')) === 'NotAllowedError');
    await remote.evaluate('document.getElementById("same-frame").remove()');
    await remote.evaluate('document.getElementById("input").value="Texto que debe conservarse al retirar el micrófono.";document.getElementById("input").dispatchEvent(new Event("input"));document.getElementById("btn-voice").click()');
    await until('actual HubVoice recording',()=>remote.evaluate('document.getElementById("btn-voice").classList.contains("recording")'));await sleep(1200);
    await clickShell('microphone-toggle');
    check('an OS click on the visible revoke control stops the actual HubVoice recorder and retains its audio/text draft',await until('native microphone revoke',()=>remote.evaluate('window.voiceTracks.length>0&&window.voiceTracks.every(track=>track.readyState==="ended")&&!!document.querySelector("#voice-draft audio")&&document.getElementById("input").value==="Texto que debe conservarse al retirar el micrófono."'))&&settings().microphone===false);
    check('revocation indicator switches off without opening a second consent dialog',await local.evaluate('document.getElementById("microphone-toggle").getAttribute("aria-pressed")==="false"')&&!native('list').includes('Micrófono de Hub'));
    spawnSync('import',['-window','root',path.join(evidence,'native-revoked-draft.png')]);
    await remote.send('Page.reload');await until('retained real audio after reload',()=>remote.evaluate('!!document.querySelector("#voice-draft audio")&&document.getElementById("input").value==="Texto que debe conservarse al retirar el micrófono."'));
    check('recorded audio remains playable after renderer reload despite the revoked microphone',await remote.evaluate('document.querySelector("#voice-draft audio").src.startsWith("blob:")&&document.getElementById("voice-transcribe").textContent==="Transcribir"'));
    await remote.evaluate('document.querySelector("#voice-draft audio").play()');
    check('the retained MediaRecorder audio really plays without re-opening the microphone',await until('retained audio playback',()=>remote.evaluate('document.querySelector("#voice-draft audio").currentTime>0&&!document.querySelector("#voice-draft audio").paused&&voiceTracks.every(track=>track.readyState==="ended")')));
    await remote.evaluate('document.querySelector("#voice-draft audio").pause()');
    await clickShell('microphone-toggle');await waitDialog();native('keys',['Left','Return']);
    check('re-enabling via the visible control asks for consent again without restarting Hub',await until('re-enabled permission',()=>settings().microphone===true)&&await local.evaluate('document.getElementById("microphone-toggle").getAttribute("aria-pressed")==="true"'));
    await stop();
    const beforeOriginChange = settings(); beforeOriginChange.microphone = true; fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify(beforeOriginChange), { mode: 0o600 });
    await start('http://127.0.0.1:' + another.address().port); await request({ audio: true, video: false }); await waitDialog();
    check('a configured different Hub origin never inherits microphone consent', await remote.evaluate('window.result === "pending" && !window.stream'));
    await answer(['Return']);
    console.log('RESULTADO: TODO OK · ' + checks.length + ' comprobaciones');
  } finally {
    await stop(); fixture.closeAllConnections(); fixture.close(); another.closeAllConnections(); another.close();
    fs.writeFileSync(path.join(evidence, 'results.json'), JSON.stringify({ checks, evidence }, null, 2));
    fs.writeFileSync(path.join(evidence, 'electron.log'), log); console.log('Evidencia: ' + evidence);
  }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
