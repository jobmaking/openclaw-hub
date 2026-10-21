// Pegar en el panel: verificación LOCAL, sin credenciales ni gateway.
//
// Cubre lo que falló en PC (clipboard regression report): pegar una CAPTURA no hacía
// nada. Aquí se sirve el `public/` real con las APIs stubeadas y se lanzan eventos
// de pegado de verdad:
//
//   1) pegar un fichero  -> se adjunta (preventDefault + /api/upload + chip)
//   2) pegar texto puro  -> NO se intercepta (lo pega el navegador, como siempre)
//   3) pegar en el login -> NO se intercepta ni sube nada
//
// Uso:  node tools/hub-paste-local-check.mjs        (HUB_ASSET_DIR para apuntar a otro public/)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const publicDir = process.env.HUB_ASSET_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-paste-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
let uploads = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) fails++;
};

const server = http.createServer((request, response) => {
  if (request.url.startsWith('/api/upload') && request.method === 'POST') {
    uploads++;
    request.resume();
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ files: [{ id: 'up-' + uploads, name: 'captura.png', mimeType: 'image/png', size: 128 }] }));
    return;
  }
  if (request.url === '/api/branding') {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ name: 'Hub', emoji: '🧭' }));
    return;
  }
  if (request.url.startsWith('/api/files')) {
    response.writeHead(200, { 'Content-Type': 'image/png' });
    response.end(Buffer.from('89504e470d0a1a0a', 'hex'));
    return;
  }
  if (request.url.startsWith('/api/')) {
    response.writeHead(401, { 'Content-Type': 'application/json' });
    response.end('{}');
    return;
  }
  const filename = path.join(publicDir, request.url === '/' ? 'index.html' : request.url.split('?')[0]);
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
  response.setHeader('Content-Type', types[path.extname(filename)] || 'application/octet-stream');
  if (fs.existsSync(filename) && fs.statSync(filename).isFile()) response.end(fs.readFileSync(filename));
  else { response.statusCode = 404; response.end(); }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

const chromiumPath = process.env.CHROMIUM_PATH || (await import('playwright-core')).chromium.executablePath();
const chrome = spawn(chromiumPath, [
  '--headless=new', '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check',
  '--user-data-dir=' + profile, '--disable-gpu', '--window-size=1280,900', 'about:blank',
], { stdio: 'ignore' });

let socket;
try {
  const portFile = path.join(profile, 'DevToolsActivePort');
  for (let attempt = 0; attempt < 100 && !fs.existsSync(portFile); attempt++) await sleep(100);
  const port = fs.readFileSync(portFile, 'utf8').split('\n')[0];
  const targets = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
  socket = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let sequence = 0;
  const pending = new Map();
  socket.onmessage = (event) => {
    const result = JSON.parse(event.data);
    if (pending.has(result.id)) { pending.get(result.id)(result); pending.delete(result.id); }
  };
  const send = (method, params = {}) => new Promise((resolve) => {
    const id = ++sequence;
    pending.set(id, resolve);
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.result.exceptionDetails) throw new Error(JSON.stringify(result.result.exceptionDetails.exception?.description || result.result.exceptionDetails.text));
    return result.result.result.value;
  };

  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: 'http://127.0.0.1:' + server.address().port + '/' });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await evaluate('typeof uploadFiles === "function"')) break;
    await sleep(100);
  }

  // Panel "abierto" con una sesión elegida, sin gateway de por medio.
  await evaluate(`(() => {
    document.getElementById('login-view').classList.add('hidden');
    document.getElementById('app').classList.remove('hidden');
    document.getElementById('composer').classList.remove('hidden');
    state.agent = 'bu'; state.current = 'root';
    state.pendingFiles = []; renderChips();
    return true;
  })()`);

  const hasListener = await evaluate("typeof getEventListeners === 'function' ? getEventListeners(document).paste?.length || 0 : 'n/a'");
  console.log('oyentes de paste en document:', hasListener);

  // --- 1) pegar un FICHERO: debe adjuntarse ---
  await evaluate(`(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 40; canvas.height = 40;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#4f8cff'; ctx.fillRect(0, 0, 40, 40);
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
    const dt = new DataTransfer();
    dt.items.add(new File([blob], 'captura.png', { type: 'image/png' }));
    const target = document.getElementById('input');
    target.focus();
    const ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt });
    if (!ev.clipboardData) Object.defineProperty(ev, 'clipboardData', { value: dt });
    window.__pasteFile = { prevented: null, count: ev.clipboardData ? ev.clipboardData.items.length : -1 };
    target.dispatchEvent(ev);
    window.__pasteFile.prevented = ev.defaultPrevented;
  })()`);
  await sleep(900);
  const filePaste = await evaluate('window.__pasteFile');
  const chips = await evaluate("document.getElementById('chips').children.length");
  check('evento con un fichero (items=1)', filePaste && filePaste.count === 1, JSON.stringify(filePaste));
  check('se intercepta (preventDefault: no se cuela HTML/base64)', filePaste && filePaste.prevented === true, JSON.stringify(filePaste));
  check('sube a /api/upload', uploads === 1, 'subidas=' + uploads);
  check('aparece el chip del adjunto', chips === 1, 'chips=' + chips);
  check('el texto del composer queda limpio', (await evaluate("document.getElementById('input').value")) === '', JSON.stringify(await evaluate("document.getElementById('input').value")));

  // --- 2) pegar TEXTO puro: NO se toca (lo pega el navegador) ---
  await evaluate(`(() => {
    const dt = new DataTransfer();
    dt.setData('text/plain', 'hola');
    const target = document.getElementById('input');
    target.focus();
    const ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt });
    if (!ev.clipboardData) Object.defineProperty(ev, 'clipboardData', { value: dt });
    target.dispatchEvent(ev);
    window.__pasteText = ev.defaultPrevented;
  })()`);
  await sleep(300);
  check('pegar texto NO se intercepta', (await evaluate('window.__pasteText')) === false, String(await evaluate('window.__pasteText')));
  check('pegar texto no sube nada', uploads === 1, 'subidas=' + uploads);

  // File-drag regressions: real DOM events against the delivered frontend.
  const drag = async (kind, target = 'main', names = ['sample.zip']) => evaluate(`(() => {
    const dt = new DataTransfer();
    for (const name of ${JSON.stringify(names)}) dt.items.add(new File(['fixture'], name, {type: name.endsWith('.pdf') ? 'application/pdf' : 'application/zip'}));
    if (!dt.files.length) dt.setData('text/plain', 'selected text');
    const event = new DragEvent(${JSON.stringify(kind)}, {bubbles:true, cancelable:true, dataTransfer:dt});
    document.getElementById(${JSON.stringify(target)}).dispatchEvent(event);
    return {hidden:document.getElementById('drop-overlay').classList.contains('hidden'), prevented:event.defaultPrevented};
  })()`);
  check('text drag never shows the overlay', (await drag('dragenter', 'main', [])).hidden);
  check('ZIP drag shows the overlay', !(await drag('dragenter')).hidden);
  await evaluate("document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}))");
  check('Escape clears canceled drag', await evaluate("$('drop-overlay').classList.contains('hidden')"));
  await drag('dragenter'); await evaluate("window.dispatchEvent(new Event('blur'))");
  check('window blur clears drag', await evaluate("$('drop-overlay').classList.contains('hidden')"));
  await drag('dragenter'); await sleep(1700);
  check('missing native cancellation expires overlay', await evaluate("$('drop-overlay').classList.contains('hidden')"));
  await drag('dragenter'); const outsideDrop = await drag('drop', 'app');
  check('outside drop clears overlay and prevents navigation', outsideDrop.hidden && outsideDrop.prevented);
  check('outside drop never uploads', uploads === 1);
  await drag('dragenter'); await drag('drop', 'drop-overlay'); await sleep(400);
  check('ZIP drops through overlay exactly once', uploads === 2);
  await drag('dragenter'); await drag('drop', 'main', ['one.pdf','two.pdf']); await sleep(400);
  check('multiple PDFs upload as one batch', uploads === 3);
  check('drop leaves composer accessible', await evaluate("$('drop-overlay').classList.contains('hidden')"));

  // --- 3) pegar en el LOGIN: no se toca ---
  await evaluate(`(() => {
    document.getElementById('app').classList.add('hidden');
    document.getElementById('login-view').classList.remove('hidden');
    document.getElementById('login-pass').focus();
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array([1, 2, 3])], 'f.png', { type: 'image/png' }));
    const ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt });
    if (!ev.clipboardData) Object.defineProperty(ev, 'clipboardData', { value: dt });
    document.getElementById('login-pass').dispatchEvent(ev);
    window.__pasteLogin = ev.defaultPrevented;
  })()`);
  await sleep(300);
  check('en el login no se intercepta', (await evaluate('window.__pasteLogin')) === false, String(await evaluate('window.__pasteLogin')));
  check('en el login no sube nada', uploads === 3, 'subidas=' + uploads);

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('/tmp/hub-paste-local-check.png', Buffer.from(shot.result.data, 'base64'));
  console.log('captura: /tmp/hub-paste-local-check.png');
} finally {
  if (socket) socket.close();
  chrome.kill();
  server.close();
  try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}  // Chrome tarda en soltar el perfil
}
console.log(fails === 0 ? '\nTODO OK' : `\n${fails} FALLOS`);
process.exit(fails === 0 ? 0 : 1);
