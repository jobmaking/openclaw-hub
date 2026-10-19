'use strict';

// Real Electron, real Hub frontend and the Linux notification D-Bus protocol.
// A private bus, fake daemon and isolated profile keep the user's session intact.
const { spawn, spawnSync } = require('node:child_process');
if (process.env.HUB_NOTIFICATION_PRIVATE_BUS !== '1') {
  const run = spawnSync('dbus-run-session', ['--', process.execPath, __filename], {
    env: { ...process.env, HUB_NOTIFICATION_PRIVATE_BUS: '1', GIO_USE_VFS: 'local', GTK_USE_PORTAL: '0',
      NO_AT_BRIDGE: '1', XDG_CURRENT_DESKTOP: 'X-Generic', XDG_SESSION_DESKTOP: 'X-Generic', XDG_SESSION_TYPE: 'x11' }, stdio: 'inherit',
  });
  process.exit(run.status ?? 1);
}

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { once } = require('node:events');
const { WebSocketServer } = require('../../node_modules/ws');
const { CDP } = require('./cdp.cjs');
const root = path.resolve(__dirname, '..');
const release = fs.realpathSync(process.env.HUB_DESKTOP_RELEASE || root);
const publicRoot = path.resolve(root, '../public');
const evidence = process.env.HUB_DESKTOP_EVIDENCE || fs.mkdtempSync(path.join(os.tmpdir(), 'hub-notifications-'));
const profile = path.join(evidence, 'profile'), journal = path.join(evidence, 'notifications.json');
fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
const checks = [], requests = [], socketMessages = [], replay = new Map();
let daemon, manager, app, local, remote, port, user = 'desktop-test', electronLog = '', daemonLog = '';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function check(label, value) { checks.push({ label, ok: Boolean(value) }); console.log((value ? 'PASS ' : 'FAIL ') + label); if (!value) throw new Error(label); }
async function until(label, read, maximum = 12000) {
  const started = Date.now();
  while (Date.now() - started < maximum) { const result = await read(); if (result) return result; await sleep(80); }
  throw new Error('Timeout: ' + label);
}
const events = () => { try { return JSON.parse(fs.readFileSync(journal, 'utf8')); } catch { return []; } };
const notices = () => events().filter(event => event.event === 'notify');
const closed = id => events().some(event => event.event === 'closed' && event.id === id);
const agents = [{ id: 'bu', name: 'Bu', emoji: '🛡️', connected: true, models: [] }, { id: 'lex', name: 'Lex', emoji: '⚖️', connected: true, models: [] }];
const fixture = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://fixture');
  requests.push({ method: request.method, path: url.pathname });
  const json = value => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(value)); };
  if (url.pathname === '/api/branding') return json({ name: 'Hub', title: 'Hub', capabilities: { push: true }, version: 'notification-fixture' });
  if (url.pathname === '/api/login') { request.resume(); response.setHeader('Set-Cookie', 'desktop-test=ok; HttpOnly; SameSite=Strict; Path=/'); return json({ ok: true }); }
  if (url.pathname === '/api/me') { const loggedIn = request.headers.cookie?.includes('desktop-test=ok'); response.statusCode = loggedIn ? 200 : 401; return json(loggedIn ? { user } : {}); }
  if (url.pathname === '/api/agents') return json({ agents });
  if (url.pathname === '/api/sessions') return json({ sessions: [{ key: 'chat-a', label: 'Conversación A' }, { key: 'chat-b', label: 'Conversación B' }] });
  if (url.pathname === '/api/history' || url.pathname === '/api/history-page') return json({ messages: [],
    sessionId: 'fixture-' + url.searchParams.get('agent') + '-' + url.searchParams.get('key'), hasMore: false, asyncQuestions: [] });
  if (url.pathname === '/api/session-settings') return json({ key: url.searchParams.get('key'), model: null, thinkingLevel: null });
  if (url.pathname.startsWith('/api/')) return json({});
  const filename = path.resolve(publicRoot, '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
  if (!filename.startsWith(publicRoot + path.sep) || !fs.existsSync(filename) || !fs.statSync(filename).isFile()) { response.writeHead(404); return response.end(); }
  response.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' })[path.extname(filename)] || 'application/octet-stream');
  fs.createReadStream(filename).pipe(response);
});
const sockets = new WebSocketServer({ server: fixture, path: '/ws' });
sockets.on('connection', socket => {
  socket.send(JSON.stringify({ type: 'hello', user, agents }));
  for (const value of replay.values()) socket.send(JSON.stringify(value));
  socket.on('message', message => socketMessages.push(JSON.parse(message)));
});
function broadcast(value, save = true) {
  if (save) {
    const key = value.type + ':' + (value.id || value.asyncQuestion?.itemId);
    if (value.phase === 'resolved' || value.asyncQuestion?.answered) replay.delete(key); else replay.set(key, value);
  }
  for (const socket of sockets.clients) if (socket.readyState === 1) socket.send(JSON.stringify(value));
}
const question = (id, extra = {}) => ({ type: 'question', agentId: 'lex', sessionKey: 'chat-b', id, phase: 'pending',
  status: 'pending', questions: [{ question: 'Pregunta Linux ' + id, options: [{ label: 'Continuar', reply: 'Continuar' }] }], ...extra });
async function native(titlePart) { return until('native notification ' + titlePart, () => notices().findLast(event => event.title.includes(titlePart) || event.body.includes(titlePart))); }
function activate(id) {
  const call = spawnSync('gdbus', ['call', '--session', '--dest', 'org.freedesktop.Notifications', '--object-path', '/org/freedesktop/Notifications', '--method', 'org.hub.NotificationTest.Activate', String(id)], { encoding: 'utf8' });
  if (call.status !== 0) throw new Error('The private notification activation failed.');
}
async function start() {
  fs.rmSync(path.join(profile, 'DevToolsActivePort'), { force: true });
  app = spawn(path.join(release, 'node_modules/electron/dist/electron'), [release, '--ozone-platform=x11', '--password-store=basic', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0'],
    { env: { ...process.env, HUB_URL: 'http://127.0.0.1:' + fixture.address().port, HUB_USER_DATA_DIR: profile }, stdio: ['ignore', 'pipe', 'pipe'] });
  app.stderr.on('data', data => { electronLog += data; });
  const activePort = path.join(profile, 'DevToolsActivePort');
  await until('Electron remote inspection', () => fs.existsSync(activePort));
  port = fs.readFileSync(activePort, 'utf8').split('\n')[0];
  const targets = await until('local shell and remote page', async () => {
    try { const list = await fetch('http://127.0.0.1:' + port + '/json/list').then(r => r.json()); return list.some(row => row.url.startsWith('file:')) && list.some(row => row.url.startsWith('http:')) ? list : null; } catch { return null; }
  });
  local = await CDP.connect(targets.find(row => row.url.startsWith('file:')).webSocketDebuggerUrl);
  remote = await CDP.connect(targets.find(row => row.url.startsWith('http:')).webSocketDebuggerUrl);
  await remote.send('Page.enable');
  await until('frontend and shell', async () => await remote.evaluate('typeof boot === "function"') && await local.evaluate('Boolean(state.version)'));
}
async function stop() {
  if (!app || app.exitCode !== null) return;
  const exited = once(app, 'exit');
  try { await local.evaluate('hubDesktop.command("close")'); } catch {}
  await Promise.race([exited, sleep(4000)]);
  if (app.exitCode === null) app.kill('SIGTERM');
  local?.close(); remote?.close();
}
async function reload() {
  await remote.send('Page.reload');
  await until('notification connection after reload', () => local.evaluate('state.notificationStatus === "ready"'));
  await sleep(1200);
}

(async () => {
  daemon = spawn('/usr/bin/python3', [path.join(__dirname, 'notification-daemon.py'), journal], { stdio: ['ignore', 'pipe', 'pipe'] });
  daemon.stderr.on('data', data => { daemonLog += data; });
  try {
    if (process.env.HUB_DESKTOP_TEST_WM) {
      const configuration = path.join(evidence, 'twmrc');
      const openbox = path.basename(process.env.HUB_DESKTOP_TEST_WM) === 'openbox';
      fs.writeFileSync(configuration, openbox ? '<openbox_config xmlns="http://openbox.org/3.4/rc"><theme><name>Clearlooks</name></theme><focus><focusNew>yes</focusNew><followMouse>no</followMouse></focus></openbox_config>' : 'RandomPlacement\nNoGrabServer\nNoTitle\n');
      manager = spawn(process.env.HUB_DESKTOP_TEST_WM, openbox ? ['--sm-disable', '--config-file', configuration] : ['-f', configuration], { stdio: ['ignore', 'ignore', 'pipe'] });
      manager.stderr.on('data', data => { daemonLog += data; });
      await sleep(300);
      if (manager.exitCode !== null) throw new Error('The isolated window manager could not start.');
    }
    await until('private notification daemon', () => events().some(event => event.event === 'ready'));
    await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
    await start();
    check('the remote page still has no Node, preload or privileged desktop bridge', await remote.evaluate('typeof require === "undefined" && typeof process === "undefined" && typeof hubDesktop === "undefined"'));
    check('desktop version matches the tested release', await local.evaluate('state.version') === fs.readFileSync(path.join(release, 'VERSION'), 'utf8').trim());
    check('Linux notifications are supported with the app sandbox enabled', await local.evaluate('state.notificationsSupported') && !electronLog.includes('No usable sandbox') && !app.spawnargs.includes('--no-sandbox'));
    await local.evaluate('hubDesktop.command("notifications-test")');
    const probe = await native('Aviso de prueba');
    check('a real D-Bus Notify request reaches the Linux notification server', probe.app === 'Hub' && probe.actions.includes('default'));
    check('no agent notification is emitted before authentication', notices().length === 1);
    await remote.evaluate('(async()=>{await fetch("/api/login",{method:"POST"});await boot();})()');
    await until('authenticated notification connection', () => local.evaluate('state.notificationStatus === "ready"'));
    check('native bell is enabled and Chrome-only push controls are hidden', await local.evaluate('document.getElementById("notification-toggle").getAttribute("aria-pressed")==="true"') && await remote.evaluate('getComputedStyle(document.getElementById("btn-push-settings")).display==="none"'));
    check('the desktop has no horizontal overflow with its notification control', await local.evaluate('document.documentElement.scrollWidth===innerWidth'));
    broadcast(question('q-1'));
    const first = await native('q-1');
    check('a question from another agent and conversation produces a native notification', first.title.includes('Lex te pregunta') && first.body.includes('q-1'));
    const count = notices().length; broadcast(question('q-1')); await sleep(1300);
    check('repeated question events do not duplicate native notices', notices().length === count);
    await remote.evaluate('document.getElementById("input").value="Borrador Linux intacto";document.getElementById("input").dispatchEvent(new Event("input",{bubbles:true}))');
    await local.evaluate('hubDesktop.command("minimize")'); await until('minimized window', () => local.evaluate('state.minimized'));
    activate(first.id);
    await until('click restores the app and opens the correct request', async () => await local.evaluate('!state.minimized && state.focused') && await remote.evaluate('state.agent==="lex" && state.current==="chat-b"'));
    check('clicking the Linux notification restores and focuses the existing app at the request', true);
    await remote.evaluate('selectAgent("bu","chat-a")');
    check('opening another agent from a notice preserves the unsent draft', await remote.evaluate('document.getElementById("input").value==="Borrador Linux intacto"'));
    broadcast(question('q-1', { phase: 'resolved', status: 'answered' }));
    await sleep(1200);
    const approval = { type: 'approval', agentId: 'bu', sessionKey: 'chat-a', id: 'a-1', phase: 'pending', status: 'pending', title: 'Permiso Linux', allowed: ['allow-once', 'deny'] };
    await local.evaluate('hubDesktop.command("minimize")');
    broadcast(approval);
    const permission = await native('Permiso Linux');
    check('a permission requested while minimized reaches Linux', permission.title.includes('pide permiso') && await local.evaluate('state.minimized'));
    activate(permission.id); await until('permission notice restores app', () => local.evaluate('!state.minimized && state.focused'));
    check('opening a permission does not erase the current composer', await remote.evaluate('document.getElementById("input").value==="Borrador Linux intacto"'));
    const optional = { type: 'async_question', agentId: 'bu', sessionKey: 'chat-a', asyncQuestion: { itemId: 'optional-1', sourceSessionId: 'fixture-bu-chat-a',
      sourceMessageId: 'message-1', answerable: true, answered: false, questions: [{ title: 'Pregunta opcional Linux', options: ['A', 'B'] }] } };
    broadcast(optional);
    const optionalNotice = await native('Pregunta opcional Linux');
    check('a reconciled optional question is notified with its real title', Boolean(optionalNotice));
    broadcast({ ...optional, asyncQuestion: { ...optional.asyncQuestion, answered: true } });
    await until('answered optional notice withdrawn', () => closed(optionalNotice.id));
    check('answering in another client withdraws the optional-question notification', true);
    const beforeIgnored = notices().length;
    broadcast(question('expired', { expiresAtMs: Date.now() - 1000 }));
    broadcast({ ...optional, asyncQuestion: { ...optional.asyncQuestion, itemId: 'old-transcript', sourceSessionId: 'obsolete-transcript' } }, false);
    await sleep(1500);
    check('expired and obsolete-transcript questions do not generate notices', notices().length === beforeIgnored);
    await local.evaluate('document.getElementById("notification-toggle").click()');
    await until('notifications disabled', () => local.evaluate('!state.notifications'));
    const beforeDisabled = notices().length; broadcast(question('disabled-1')); await sleep(1300);
    check('the native bell really disables desktop delivery', notices().length === beforeDisabled && JSON.parse(fs.readFileSync(path.join(profile, 'settings.json'))).notifications === false);
    await local.evaluate('document.getElementById("notification-toggle").click()');
    await native('disabled-1'); check('the bell can re-enable notices without clearing the profile', true);
    const beforeReload = notices().length;
    await reload();
    check('reloading the same authenticated user does not replay pending notices', notices().length === beforeReload);
    user = 'second-user'; await reload();
    check('changing accounts closes former notices and isolates the notification ledger', notices().length > beforeReload && await remote.evaluate('state.user==="second-user"'));
    await local.evaluate('hubDesktop.command("notifications",false)'); await stop();
    await start(); await until('saved disabled preference', () => local.evaluate('state.notificationStatus==="disabled"'));
    const afterRestart = notices().length; await sleep(1300);
    check('an explicit disabled preference survives a real restart', notices().length === afterRestart && await local.evaluate('!state.notifications'));
    check('preferences remain private after notification changes', (fs.statSync(path.join(profile, 'settings.json')).mode & 0o777) === 0o600);
    check('notification clicks never answer questions, grant permissions, send text or create conversations',
      !requests.some(request => request.method === 'POST' && request.path !== '/api/login') && socketMessages.every(message => message.type === 'watch'));
    console.log('RESULTADO: TODO OK · ' + checks.length + ' comprobaciones');
  } finally {
    await stop();
    for (const socket of sockets.clients) socket.terminate(); sockets.close(); fixture.closeAllConnections(); fixture.close();
    daemon?.kill('SIGTERM'); manager?.kill('SIGTERM');
    fs.writeFileSync(path.join(evidence, 'electron.log'), electronLog);
    fs.writeFileSync(path.join(evidence, 'daemon.log'), daemonLog);
    fs.writeFileSync(path.join(evidence, 'results.json'), JSON.stringify({ checks, passed: checks.filter(check => check.ok).length,
      release, evidence, notificationServer: 'isolated D-Bus fixture' }, null, 2));
    console.log('Evidencia: ' + evidence);
  }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
