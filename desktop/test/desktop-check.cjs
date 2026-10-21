'use strict';

// Real Electron + real Hub frontend against an isolated HTTP fixture. No account,
// inference, production mutation or secrets are needed for this desktop suite.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const root = path.resolve(__dirname, '..');
const publicRoot = path.resolve(root, '../public');
const evidence = process.env.HUB_DESKTOP_EVIDENCE || fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-hub-desktop-evidence-'));
fs.mkdirSync(evidence, { recursive: true });
const profile = path.join(evidence, 'profile');
const downloads = path.join(evidence, 'downloads');
fs.mkdirSync(profile, { recursive: true }); fs.mkdirSync(downloads, { recursive: true });
fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ directory: downloads }));
const marker = 'Archivo de prueba de Hub para Linux.\n';
const sample = Buffer.from(marker.repeat(100));
const large = Buffer.alloc(4 * 1024 * 1024, 72);
const executable = Buffer.from('MZ\0Hub download regression fixture; not an executable program.\n');
const jsonFile = Buffer.from('{"fixture":"Hub","download":true}\n');
const fileRequests = [];
const expectedVersion = fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim();
const uploads = [];
const checks = [];
let child, shell, guest, port;
let log = '';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function check(label, ok) { checks.push({ label, ok: Boolean(ok) }); console.log((ok ? 'PASS ' : 'FAIL ') + label); if (!ok) throw new Error(label); }
async function until(label, predicate, limit = 12000) {
  const start = Date.now();
  while (Date.now() - start < limit) { const result = await predicate(); if (result) return result; await sleep(80); }
  throw new Error('Timeout: ' + label);
}

const fixture = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://fixture');
  const json = (value, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
  if (url.pathname === '/api/branding') return json({ name: 'Hub', emoji: '🧭', version: 'fixture' });
  if (url.pathname === '/api/login') { request.resume(); response.setHeader('Set-Cookie', 'desktop-test=ok; HttpOnly; SameSite=Strict; Max-Age=3600; Path=/'); return json({ ok: true }); }
  if (url.pathname === '/api/me') return json(request.headers.cookie?.includes('desktop-test=ok') ? { user: 'desktop-test' } : {}, request.headers.cookie?.includes('desktop-test=ok') ? 200 : 401);
  if (url.pathname === '/api/agents') return json({ agents: [] });
  if (url.pathname === '/api/sessions') return json({ sessions: [{ key: 'root', label: 'Prueba de archivos', hasActiveRun: false }] });
  if (url.pathname === '/api/history-page' || url.pathname === '/api/history') return json({
    messages: [{ id: 'fixture-assistant', role: 'assistant', ts: 1, text: '## Tu espacio, conectado.\nAdjunta documentos, pega una captura y descarga los archivos que necesites.' }],
    sessionId: 'fixture-desktop-session', hasMore: false, nextOffset: null,
  });
  if (url.pathname === '/api/session-settings') return json({ key: 'root', model: null, thinkingLevel: null });
  if (url.pathname === '/api/upload') {
    const chunks = []; request.on('data', (chunk) => chunks.push(chunk)); request.on('end', () => {
      const body = Buffer.concat(chunks); uploads.push(body);
      const names = [...body.toString().matchAll(/filename="([^"]+)"/g)].map(match => match[1]);
      json({ files: names.map((name, index) => ({ id: 'test-' + uploads.length + '-' + index, name, size: body.length, mimeType: name.endsWith('.png') ? 'image/png' : 'application/octet-stream' })) });
    }); return;
  }
  if (['/api/session-file', '/api/artifact-download'].includes(url.pathname)) {
    fileRequests.push({ pathname: url.pathname, path: url.searchParams.get('path'), authenticated: request.headers.cookie?.includes('desktop-test=ok') });
    if (!request.headers.cookie?.includes('desktop-test=ok')) return json({ error: 'Inicia sesión' }, 401);
    if (url.searchParams.has('retry') && fileRequests.filter((item) => item.path === url.searchParams.get('path')).length === 1) return json({ error: 'El archivo no está en una carpeta publicada' }, 403);
    const status = Number(url.searchParams.get('status') || 200);
    if (status !== 200) return json({ error: status === 403 ? 'El archivo no está en una carpeta publicada' : 'No se puede descargar el archivo' }, status);
    if (url.searchParams.has('redirect')) {
      const location = url.searchParams.get('redirect') === 'login' ? '/' : '/api/session-file?' + new URLSearchParams({ path: 'final.json', chunked: '1' });
      response.writeHead(302, { Location: location }); return response.end();
    }
    const name = path.basename(url.searchParams.get('path') || 'entregable.json');
    const content = name.endsWith('.exe') ? executable : jsonFile;
    if (url.searchParams.has('retry') || url.searchParams.has('chunked')) {
      response.writeHead(200, { 'Content-Type': 'application/json' }); response.write(content.subarray(0, 1));
      setTimeout(() => response.end(content.subarray(1)), 25); return;
    }
    response.writeHead(200, { 'Content-Type': name.endsWith('.exe') ? 'application/x-msdownload' : 'application/json',
      'Content-Disposition': "inline; filename*=UTF-8''" + encodeURIComponent(name), 'Content-Length': content.length });
    return response.end(content);
  }
  if (url.pathname === '/api/files') { response.writeHead(200, { 'Content-Type': 'image/png' }); return response.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64')); }
  if (url.pathname === '/fixture/file' || url.pathname === '/fixture/slow' || url.pathname === '/fixture/html') {
    const slow = url.pathname.endsWith('slow');
    const buffer = slow ? large : sample;
    const name = url.searchParams.get('name') || 'informe-jurídico.txt';
    const offset = Number((request.headers.range || '').match(/bytes=(\d+)-/)?.[1] || 0);
    const headers = { 'Content-Type': 'application/octet-stream', 'Content-Length': buffer.length - offset,
      'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(name), 'Accept-Ranges': 'bytes', 'ETag': '"hub-fixture-v1"' };
    if (offset) headers['Content-Range'] = `bytes ${offset}-${buffer.length - 1}/${buffer.length}`;
    if (url.pathname === '/fixture/html') { headers['Content-Type'] = 'text/html'; headers['Content-Disposition'] = "inline; filename*=UTF-8''" + encodeURIComponent(name); }
    response.writeHead(offset ? 206 : 200, headers);
    if (!slow) return response.end(buffer);
    let position = offset;
    const timer = setInterval(() => {
      const end = Math.min(position + 65536, buffer.length); response.write(buffer.subarray(position, end)); position = end;
      if (position === buffer.length) { clearInterval(timer); response.end(); }
    }, 60);
    response.on('close', () => clearInterval(timer)); return;
  }
  if (url.pathname.startsWith('/api/')) return json({});
  const filename = path.resolve(publicRoot, '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
  if (!filename.startsWith(publicRoot + path.sep) || !fs.existsSync(filename) || !fs.statSync(filename).isFile()) { response.writeHead(404); return response.end(); }
  response.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' })[path.extname(filename)] || 'application/octet-stream');
  fs.createReadStream(filename).pipe(response);
});

class CDP {
  constructor(socket) {
    this.socket = socket; this.sequence = 0; this.pending = new Map(); this.events = [];
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject, timer } = this.pending.get(message.id); clearTimeout(timer); this.pending.delete(message.id);
        if (message.error) reject(new Error(JSON.stringify(message.error))); else resolve(message.result);
      } else this.events.push(message);
    };
  }
  static async connect(url) { const socket = new WebSocket(url); await once(socket, 'open'); return new CDP(socket); }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence; const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, 10000);
      this.pending.set(id, { resolve, reject, timer }); this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const response = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
    return response.result?.value;
  }
  close() { this.socket.close(); }
}

async function start() {
  fs.rmSync(path.join(profile, 'DevToolsActivePort'), { force: true });
  child = spawn(path.join(root, 'openclaw-hub-desktop'), ['--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1'],
    { env: { ...process.env, DBUS_SESSION_BUS_ADDRESS: 'unix:path=' + path.join(evidence, 'no-session-bus'), HUB_URL: 'http://127.0.0.1:' + fixture.address().port, HUB_USER_DATA_DIR: profile, XDG_CONFIG_HOME: path.join(evidence, 'config'), XDG_STATE_HOME: path.join(evidence, 'state') }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', (chunk) => { log += chunk.toString(); });
  await until('Electron DevTools', () => fs.existsSync(path.join(profile, 'DevToolsActivePort')) && fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]);
  port = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0];
  const targets = await until('shell and Hub targets', async () => {
    try { const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json(); return list.some((item) => item.url.startsWith('file:')) && list.some((item) => item.url.startsWith('http:')) ? list : null; } catch { return null; }
  });
  shell = await CDP.connect(targets.find((item) => item.url.startsWith('file:')).webSocketDebuggerUrl);
  guest = await CDP.connect(targets.find((item) => item.url.startsWith('http:')).webSocketDebuggerUrl);
  await guest.send('Page.enable'); await shell.send('Page.enable');
  await until('shell bridge', () => shell.evaluate('typeof hubDesktop !== "undefined" && document.getElementById("app-version").textContent === ' + JSON.stringify(expectedVersion)));
  await until('Hub loaded', () => guest.evaluate('typeof uploadFiles === "function"'));
}

async function setupChat() {
  await guest.evaluate(`(async () => {
    document.getElementById('login-view').classList.add('hidden'); document.getElementById('app').classList.remove('hidden');
    document.getElementById('composer').classList.remove('hidden');
    state.user = 'desktop-test'; state.agent = 'bu'; state.current = 'root'; state.pendingFiles = [];
    state.agents = [{id:'bu',name:'Bu',emoji:'🛡️',connected:false,role:'Builder'}];
    renderAgents(); renderChips(); updateComposerState();
    document.getElementById('chat-title').textContent = 'Prueba de archivos';
    await loadSessions(); await selectSession('root');
  })()`);
}

async function clickDownload(endpoint, name) {
  await guest.evaluate(`(() => {const a=document.createElement('a'); a.href=${JSON.stringify(endpoint + '?' + new URLSearchParams({ name }))};document.body.appendChild(a);a.click();a.remove();})()`);
}

async function downloadStates() { return shell.evaluate('state.downloads'); }
async function action(id, name) { await shell.evaluate('hubDesktop.command("download-action",' + JSON.stringify({ id, action: name }) + ')'); }

async function stop() {
  if (!child || child.exitCode !== null) return;
  const exited = once(child, 'exit');
  try { await shell.evaluate('hubDesktop.command("close")'); } catch {}
  await Promise.race([exited, sleep(3000)]);
  if (child.exitCode === null) child.kill('SIGTERM');
  shell?.close(); guest?.close();
}

(async () => {
  await new Promise((resolve) => fixture.listen(0, '127.0.0.1', resolve));
  try {
    await start();
    const debugVersion = await (await fetch('http://127.0.0.1:' + port + '/json/version')).json();
    const browserCDP = await CDP.connect(debugVersion.webSocketDebuggerUrl);
    const processInfo = await browserCDP.send('SystemInfo.getProcessInfo'); browserCDP.close();
    const renderers = processInfo.processInfo.filter(process => process.type === 'renderer');
    const statuses = renderers.map(process => fs.readFileSync('/proc/' + process.id + '/status', 'utf8'));
    check('both renderer processes have effective seccomp, NoNewPrivs and nested PID sandbox', statuses.length >= 2 && statuses.every(status => /NoNewPrivs:\s+1/.test(status) && /Seccomp:\s+2/.test(status) && status.match(/^NSpid:\s+(.+)$/m)?.[1].trim().split(/\s+/).length > 1));
    const processArgs = fs.readFileSync('/proc/' + child.pid + '/cmdline', 'utf8').split('\0');
    check('Linux launcher selects X11 before Electron starts', /(?:^|\s)--ozone-platform=x11(?:\s|$)/.test(processArgs.join(' ')) && !processArgs.join(' ').includes('--no-sandbox'));
    check('remote Hub has neither Node nor the desktop IPC bridge', await guest.evaluate('typeof require === "undefined" && typeof process === "undefined" && typeof hubDesktop === "undefined"'));
    check('desktop has no horizontal overflow', await shell.evaluate('document.documentElement.scrollWidth === innerWidth'));
    await guest.evaluate('fetch("/api/login",{method:"POST"}).then(r=>r.ok)');
    await setupChat();
    await guest.evaluate('window.downloadSentinel="draft-preserved";document.getElementById("input").value="Borrador antes de descargar"');
    for (const [status, name, popup] of [[403, 'no-publicado.exe', false], [404, 'perdido.json', true], [401, 'sesion-caducada.exe', false], [503, 'servicio.json', false]]) {
      const before = fileRequests.length;
      const count = (await downloadStates()).length;
      const href = '/api/session-file?' + new URLSearchParams({ agent: 'bu', key: 'root', path: name, status: String(status) });
      await guest.evaluate(popup ? 'window.open(' + JSON.stringify(href) + ',"_blank")' : '(() => {const a=document.createElement("a");a.href=' + JSON.stringify(href) + ';a.click();})()');
      await until('file error request ' + status, () => fileRequests.length > before);
      await until('file error feedback ' + status, async () => await shell.evaluate('state.toast.includes(' + JSON.stringify(String(status)) + ')') || await guest.evaluate('location.pathname!=="/"'));
      check('HTTP ' + status + ' file error preserves chat, draft and the same renderer', await guest.evaluate('location.pathname==="/" && window.downloadSentinel==="draft-preserved" && document.getElementById("input")?.value==="Borrador antes de descargar" && state.current==="root"') && await shell.evaluate('!state.loadError && !state.loading'));
      check('HTTP ' + status + ' error is reported without saving JSON as a successful download', (await downloadStates()).length === count && fs.readdirSync(downloads).length === 0);
    }
    const blockedArtifact = '/api/artifact-download?' + new URLSearchParams({ id: 'test', path: 'artifact-error.json', status: '403' });
    await shell.evaluate('state.toast=""');
    await guest.evaluate('(() => {const a=document.createElement("a");a.href=' + JSON.stringify(blockedArtifact) + ';a.download="artifact-error.json";document.body.append(a);a.click();a.remove();})()');
    await until('download attribute error feedback', () => shell.evaluate('state.toast.includes("403")'));
    await until('empty interrupted item removed', async () => (await downloadStates()).length === 0);
    check('artifact anchors with download attribute also reject HTTP errors without saving their JSON', fs.readdirSync(downloads).length === 0 && await guest.evaluate('window.downloadSentinel==="draft-preserved"'));
    const retryLink = '/api/session-file?' + new URLSearchParams({ path: 'reintento.json', retry: '1' });
    await shell.evaluate('state.toast=""');
    await guest.evaluate('location.href=' + JSON.stringify(retryLink));
    await until('initial retry error', () => shell.evaluate('state.toast.includes("403")'));
    await guest.evaluate('location.href=' + JSON.stringify(retryLink));
    const retry = await until('chunked retry completes', async () => (await downloadStates()).find((item) => item.state === 'completed'));
    check('the same URL can succeed immediately after 403 with no disposition or content length', fs.readFileSync(path.join(downloads, retry.name)).equals(jsonFile));
    const beforeRedirect = (await downloadStates()).map((item) => item.id);
    await guest.evaluate('location.href=' + JSON.stringify('/api/session-file?' + new URLSearchParams({ path: 'redirigir.json', redirect: 'file' })));
    const redirected = await until('safe redirect completes', async () => (await downloadStates()).find((item) => item.state === 'completed' && !beforeRedirect.includes(item.id)));
    check('same-origin file redirects preserve authentication and finish a chunked download', fs.readFileSync(path.join(downloads, redirected.name)).equals(jsonFile) && fileRequests.at(-1).authenticated);
    const completedCount = (await downloadStates()).length;
    await guest.evaluate('location.href=' + JSON.stringify('/api/session-file?' + new URLSearchParams({ path: 'caducado.exe', redirect: 'login' })));
    await until('expired redirect feedback', () => shell.evaluate('state.toast.includes("caducado")'));
    await until('expired redirect item removed', async () => (await downloadStates()).length === completedCount);
    check('redirects to a login page never save HTML as an EXE or replace the conversation', await guest.evaluate('window.downloadSentinel==="draft-preserved" && location.pathname==="/"') && !fs.existsSync(path.join(downloads, 'caducado.exe')));
    for (const [name, popup] of [['instalador.exe', false], ['configuración.json', true]]) {
      const before = fileRequests.length;
      const href = '/api/session-file?' + new URLSearchParams({ agent: 'bu', key: 'root', path: name });
      await guest.evaluate(popup ? 'window.open(' + JSON.stringify(href) + ',"_blank")' : '(() => {const a=document.createElement("a");a.href=' + JSON.stringify(href) + ';a.click();})()');
      await until('inline file downloaded ' + name, async () => (await downloadStates()).some((item) => item.name === name && item.state === 'completed'));
      check(name + ' is downloaded byte-for-byte instead of replacing the chat', fs.readFileSync(path.join(downloads, name)).equals(name.endsWith('.exe') ? executable : jsonFile) && await guest.evaluate('location.pathname==="/" && window.downloadSentinel==="draft-preserved"'));
      check(name + ' uses one authenticated GET, without consuming a link twice', fileRequests.length === before + 1 && fileRequests.at(-1).authenticated);
    }
    check('downloaded EXE is never made executable or launched', !(fs.statSync(path.join(downloads, 'instalador.exe')).mode & 0o111));
    await guest.evaluate('document.getElementById("input").value=""');
    const uploadFile = path.join(evidence, 'adjunto-de-prueba.txt'); fs.writeFileSync(uploadFile, marker);
    await guest.send('Page.setInterceptFileChooserDialog', { enabled: true });
    await shell.evaluate('document.querySelector("[data-command=attach]").click()');
    await until('native file chooser request', () => guest.events.some((event) => event.method === 'Page.fileChooserOpened'));
    const doc = await guest.send('DOM.getDocument');
    const input = await guest.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#file-input' });
    await guest.send('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [uploadFile] });
    await until('file upload', () => uploads.length === 1);
    check('desktop Attach invokes the real file input and uploads exact file bytes', uploads[0].includes(Buffer.from(marker)));
    await until('attachment chip', () => guest.evaluate('document.getElementById("chips").children.length===1'));
    check('file selected in desktop appears as a Hub attachment', true);
    await guest.send('Page.setInterceptFileChooserDialog', { enabled: false });
    const draggedFile = path.join(evidence, 'arrastrado.pdf');
    fs.writeFileSync(draggedFile, '%PDF-1.4\ndrag-drop-marker\n%%EOF');
    const dropPoint = await guest.evaluate('(() => {const r=document.getElementById("main").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()');
    const zipFile = path.join(evidence, 'documentos.zip'), secondPdf = path.join(evidence, 'segundo.pdf');
    fs.writeFileSync(zipFile, 'PK\x03\x04zip-native-marker'); fs.writeFileSync(secondPdf, '%PDF-1.4\nsecond-pdf-marker\n%%EOF');
    const origin = await guest.evaluate('({x:screenX,y:screenY})');
    const nativeSource = spawnSync('/usr/bin/python3', [path.join(__dirname, 'native-drag.py'), String(Math.round(origin.x + dropPoint.x)), String(Math.round(origin.y + dropPoint.y)), draggedFile, zipFile, secondPdf], {env: process.env, encoding:'utf8', timeout:20000});
    fs.writeFileSync(path.join(evidence, 'native-drag.log'), nativeSource.stdout + nativeSource.stderr);
    check('GTK URI-list source completes an OS-native file drop', nativeSource.status === 0);
    await until('drag upload', () => uploads.length === 2);
    check('OS-native PDF and ZIP batch uploads exact bytes', [draggedFile, zipFile, secondPdf].every(file => uploads[1].includes(fs.readFileSync(file))));
    await until('native batch chips', () => guest.evaluate('state.pendingFiles.length===4'));
    check('all dropped documents appear as separate attachment chips', await guest.evaluate('state.pendingFiles.map(file=>file.name).includes("documentos.zip")'));
    await guest.evaluate(`(async () => { const canvas=document.createElement('canvas');canvas.width=32;canvas.height=32;canvas.getContext('2d').fillRect(0,0,32,32);const blob=await new Promise(r=>canvas.toBlob(r,'image/png'));await navigator.clipboard.write([new ClipboardItem({'image/png':blob})]);document.getElementById('input').focus(); })()`);
    await guest.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'v', code: 'KeyV', modifiers: 2, windowsVirtualKeyCode: 86 });
    await guest.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'v', code: 'KeyV', modifiers: 2, windowsVirtualKeyCode: 86 });
    await until('native clipboard image upload', () => uploads.length === 3);
    check('Ctrl+V from the native image clipboard attaches a PNG', uploads[2].includes(Buffer.from('image/png')) && uploads[2].includes(Buffer.from([137, 80, 78, 71])));
    await clickDownload('/fixture/file', 'informe-jurídico.txt');
    await until('completed download', async () => (await downloadStates()).some((item) => item.name === 'informe-jurídico.txt' && item.state === 'completed'));
    check('authenticated Chromium download is saved with byte-for-byte content', fs.readFileSync(path.join(downloads, 'informe-jurídico.txt')).equals(sample));
    check('download drawer opens and shows completed status', await shell.evaluate('state.downloadsOpen && document.querySelector(".download-card[data-state=completed] .file-meta").textContent.startsWith("Guardado")'));
    await clickDownload('/fixture/file', 'informe-jurídico.txt');
    await until('duplicate download', async () => (await downloadStates()).some((item) => item.name === 'informe-jurídico (1).txt' && item.state === 'completed'));
    check('a duplicate filename never overwrites the existing file', fs.readFileSync(path.join(downloads, 'informe-jurídico (1).txt')).equals(sample));
    await clickDownload('/fixture/html', 'révision.html');
    await until('RFC5987-only HTML file', async () => (await downloadStates()).some((item) => item.name === 'révision.html' && item.state === 'completed'));
    check('opaque HTML file links with only filename*= are downloaded, not opened as pages', fs.readFileSync(path.join(downloads, 'révision.html')).equals(sample));
    await guest.evaluate(`(() => {const a=document.createElement('a');a.href=URL.createObjectURL(new Blob(['blob-download-marker'],{type:'text/plain'}));a.download='codigo-exportado.txt';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),2000);})()`);
    await until('blob download', async () => (await downloadStates()).some((item) => item.name === 'codigo-exportado.txt' && item.state === 'completed'));
    check('generated code/table Blob downloads use the same native manager', fs.readFileSync(path.join(downloads, 'codigo-exportado.txt'), 'utf8') === 'blob-download-marker');
    await clickDownload('/fixture/slow', 'archivo-grande.bin');
    const active = await until('progress update', async () => (await downloadStates()).find((item) => item.name === 'archivo-grande.bin' && item.received > 0 && item.state === 'progressing'));
    check('progress comes from actual received bytes', active.total === large.length && active.received < active.total);
    await action(active.id, 'pause');
    await until('paused state', async () => (await downloadStates()).find((item) => item.id === active.id)?.paused);
    check('native download pause is reflected in the UI', await shell.evaluate('document.querySelector(".download-card[data-state=progressing] .file-meta").textContent.startsWith("En pausa")'));
    await action(active.id, 'resume');
    await until('resumed completion', async () => (await downloadStates()).find((item) => item.id === active.id)?.state === 'completed');
    check('resume finishes with a matching full-file hash', crypto.createHash('sha256').update(fs.readFileSync(path.join(downloads, active.name))).digest('hex') === crypto.createHash('sha256').update(large).digest('hex'));
    await clickDownload('/fixture/slow', 'cancelar.bin');
    const cancel = await until('cancellable item', async () => (await downloadStates()).find((item) => item.name === 'cancelar.bin' && item.state === 'progressing'));
    await action(cancel.id, 'cancel');
    await until('cancelled state', async () => (await downloadStates()).find((item) => item.id === cancel.id)?.state === 'cancelled');
    check('cancellation is real and never presented as completed', !fs.existsSync(path.join(downloads, 'cancelar.bin')));
    await shell.evaluate('hubDesktop.command("find",true)');
    await shell.evaluate('document.getElementById("find-input").value="captura";document.getElementById("find-input").dispatchEvent(new Event("input"))');
    try { await until('find result', () => shell.evaluate('state.findResult?.total > 0')); }
    catch (error) {
      console.log('Find diagnostics:', await shell.evaluate('({findOpen:state.findOpen,findResult:state.findResult})'), await guest.evaluate('({text:document.getElementById("messages").innerText,visible:getComputedStyle(document.getElementById("messages")).display,body:document.body.innerText.slice(-400)})'));
      throw error;
    }
    check('native find locates real conversation text', true);
    await shell.evaluate('hubDesktop.command("find",false)');
    await shell.evaluate('hubDesktop.command("zoom",1)');
    await until('zoom update', async () => await guest.evaluate('Math.round(devicePixelRatio*100)===110') && await shell.evaluate('devicePixelRatio===1 && state.zoom===110'));
    check('text zoom changes only the Hub, not desktop chrome', true);
    await shell.evaluate('hubDesktop.command("zoom",0)');
    await guest.evaluate('window.open("file:///etc/passwd")');
    check('local file navigation cannot escape the Hub view', await guest.evaluate('location.protocol === "http:" && typeof hubDesktop === "undefined"'));
    const rowCount = (await downloadStates()).length;
    spawnSync('import', ['-display', process.env.DISPLAY, '-window', 'root', path.join(evidence, 'desktop-transfers.png')]);
    await shell.evaluate('hubDesktop.command("window-size","compact")');
    await until('resize', () => shell.evaluate('innerWidth === 1000'));
    check('compact desktop keeps controls and downloads inside the window', await shell.evaluate('document.documentElement.scrollWidth===innerWidth && document.getElementById("downloads").getBoundingClientRect().right===innerWidth'));
    await shell.evaluate('hubDesktop.command("window-size","wide")');
    await shell.evaluate('hubDesktop.command("downloads",false)');
    const second = spawn(path.join(root, 'openclaw-hub-desktop'), ['--downloads'], { env: { ...process.env, HUB_URL: 'http://127.0.0.1:' + fixture.address().port, HUB_USER_DATA_DIR: profile, XDG_CONFIG_HOME: path.join(evidence, 'config'), XDG_STATE_HOME: path.join(evidence, 'state') }, stdio: 'ignore' });
    const [code] = await once(second, 'exit');
    await until('single-instance activation', () => shell.evaluate('state.downloadsOpen'));
    check('a second launch reuses the existing window', code === 0);
    await stop(); await sleep(200); await start();
    check('login cookie survives a clean app restart', await guest.evaluate('fetch("/api/me").then(r=>r.json()).then(j=>j.user==="desktop-test")'));
    check('download history survives app restart without signed URLs', (await downloadStates()).length === rowCount && !fs.readFileSync(path.join(profile, 'downloads.json'), 'utf8').includes('http:'));
    await guest.send('Network.enable');
    await guest.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
    await shell.evaluate('hubDesktop.command("reload")');
    await until('offline state', () => shell.evaluate('Boolean(state.loadError) && !document.getElementById("retry").hidden'));
    check('network failure leaves a visible recovery action and usable desktop controls', true);
    await guest.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await shell.evaluate('document.getElementById("retry").click()');
    await until('retry recovery', async () => await shell.evaluate('!state.loading && !state.loadError') && await guest.evaluate('typeof uploadFiles==="function"'));
    check('the visible retry action restores the real Hub view', true);
    await shell.evaluate('hubDesktop.command("clear-downloads")');
    check('clearing the list never deletes downloaded files', fs.readFileSync(path.join(downloads, 'informe-jurídico.txt')).equals(sample) && (await downloadStates()).length === 0);
    await guest.evaluate('window.returnToHubSentinel=true');
    await shell.evaluate('document.querySelector(".app-mark").click()');
    await until('return to Hub action', () => guest.evaluate('typeof uploadFiles==="function" && !window.returnToHubSentinel'));
    check('the visible Hub icon restores the chat without restarting the app', await shell.evaluate('!state.loadError && !state.loading'));
    await stop();
    console.log('RESULTADO: TODO OK · ' + checks.length + ' comprobaciones');
  } finally {
    if (child?.exitCode === null) spawnSync('import', ['-display', process.env.DISPLAY, '-window', 'root', path.join(evidence, 'desktop-last-state.png')]);
    await stop(); fixture.closeAllConnections(); fixture.close();
    fs.writeFileSync(path.join(evidence, 'electron.log'), log);
    fs.writeFileSync(path.join(evidence, 'results.json'), JSON.stringify({ checks, passed: checks.filter((item) => item.ok).length, evidence }, null, 2));
    console.log('Evidencia: ' + evidence);
  }
})().catch((error) => { console.error(error.stack); process.exitCode = 1; });
