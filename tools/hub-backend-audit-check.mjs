// Isolated contract checks: real hub backend + an inert, simulated Gateway.
// No production credentials, sessions, model calls, or network endpoints are used.
// The pre-audit backend failed these contracts; all checks must now stay green.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { WebSocket, WebSocketServer } = require('ws');
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverFile = path.join(repo, 'server.js');
const serverHash = crypto.createHash('sha256').update(fs.readFileSync(serverFile)).digest('hex').slice(0, 12);
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-backend-audit-'));
const dataDir = path.join(temporary, 'data');
const workspace = path.join(temporary, 'workspace');
const mappedWorkspace = path.join(temporary, 'mapped-workspace');
const publishedWorkspace = path.join(temporary, 'published-workspace');
const normalizedWorkspace = path.join(temporary, 'normalized-workspace');
const nasVolume = path.join(temporary, 'nas-volume');
const key = 'agent:main:dashboard:isolated-backend-audit';
const requests = [];
const admissions = new Map();
const gatewayClients = new Set();
const browserClients = new Set();
const results = [];
const extraBackends = new Set();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let abortBehavior = 'normal';
let backend;
let backendLogs = '';
let cookie;
let base;
let socketUrl;
let browser;

async function until(predicate, description, timeoutMs = 7000) {
  const deadline = Date.now() + timeoutMs;
  do {
    const result = await predicate();
    if (result) return result;
    if (backend && backend.exitCode !== null) throw new Error('Backend exited: ' + backendLogs.slice(-2000));
    await sleep(20);
  } while (Date.now() < deadline);
  throw new Error('Timeout: ' + description);
}

async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log('PASS ' + name);
  } catch (error) {
    results.push({ name, ok: false });
    console.log('FAIL ' + name + ': ' + error.message);
  }
}

async function unusedPort() {
  const listener = http.createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  return port;
}

const gateway = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await once(gateway, 'listening');
gateway.on('connection', socket => {
  const client = { socket, scopes: [] };
  gatewayClients.add(client);
  socket.on('close', () => gatewayClients.delete(client));
  socket.send(JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { nonce: 'isolated-audit' } }));
  socket.on('message', data => {
    const frame = JSON.parse(data);
    const params = frame.params || {};
    requests.push({ method: frame.method, params, scopes: [...client.scopes] });
    const reply = (payload, error) => socket.send(JSON.stringify({ type: 'res', id: frame.id, ok: !error,
      ...(error ? { error } : { payload }) }));
    const row = {
      key, agentId: 'main', classification: 'session', label: 'Inert audit fixture',
      updatedAt: Date.now(), hasActiveRun: false, modelProvider: 'fixture', model: 'inert',
      thinkingLevels: [{ id: 'off', label: 'Off' }], thinkingDefault: 'off',
    };
    switch (frame.method) {
      case 'connect':
        client.scopes = params.scopes || [];
        return reply({
          type: 'hello-ok', protocol: 3,
          auth: { scopes: client.scopes },
          features: { methods: ['chat.send', 'chat.abort', 'sessions.abort'], events: ['chat'] },
        });
      case 'models.list':
        return reply({ models: [{ id: 'inert', provider: 'fixture', name: 'No inference', thinkingLevels: row.thinkingLevels, thinkingDefault: 'off' }] });
      case 'question.list': return reply({ questions: [] });
      case 'exec.approval.list':
      case 'plugin.approval.list': return reply([]);
      case 'sessions.list': return reply({ sessions: [row] });
      case 'sessions.describe': return reply({ session: row });
      case 'sessions.preview': return reply({ previews: [] });
      case 'sessions.messages.subscribe': return reply({ subscriptionId: 'inert-audit' });
      case 'chat.history': return reply({ messages: [] });
      case 'chat.send': {
        if (params.message === 'inert rejection fixture') return reply(null, { code: 'INVALID_REQUEST', message: 'Fixture rejected the message' });
        // Emulate the Gateway's durable idempotency contract, without executing anything.
        const id = String(params.idempotencyKey || '');
        if (!admissions.has(id)) admissions.set(id, { runId: 'fixture-run-' + admissions.size, status: 'started' });
        if (params.message === 'inert delayed disconnect fixture') return setTimeout(() => reply(admissions.get(id)), 100);
        return reply(admissions.get(id));
      }
      case 'chat.abort': return reply({ ok: true, aborted: true, runIds: [] });
      case 'sessions.abort':
        if (abortBehavior === 'unsupported') return reply(null, { code: 'INVALID_REQUEST', message: 'unknown method: sessions.abort' });
        if (abortBehavior === 'denied') return reply(null, { code: 'FORBIDDEN', message: 'Fixture denied Stop' });
        if (abortBehavior === 'invalid') return reply(null, { code: 'INVALID_REQUEST', message: 'Invalid session for sessions.abort' });
        if (abortBehavior === 'unavailable') return reply(null, { code: 'UNAVAILABLE', message: 'Fixture temporarily unavailable' });
        if (abortBehavior === 'timeout') return;
        return reply({ ok: true, aborted: true, runIds: [] });
      default: return reply({});
    }
  });
});

async function connectBrowser(origin = base) {
  const socket = new WebSocket(socketUrl, { origin, headers: { Cookie: cookie } });
  const messages = [];
  browserClients.add(socket);
  socket.on('close', () => browserClients.delete(socket));
  socket.on('message', data => {
    try { messages.push(JSON.parse(data)); } catch {}
  });
  await once(socket, 'open');
  await until(() => messages.some(message => message.type === 'hello'), 'browser hello');
  return { socket, messages };
}

async function sendAndAck(client, envelope) {
  const offset = client.messages.length;
  client.socket.send(JSON.stringify(envelope));
  return until(() => client.messages.slice(offset).find(message =>
    message.sessionKey === key && (message.type === 'send_accepted' || message.type === 'send_error')),
  'send acknowledgement');
}

async function browserProbe(options = {}) {
  return new Promise((resolve, reject) => {
    const settings = { headers: { Cookie: options.cookie ?? cookie, ...(options.headers || {}) } };
    if (options.origin !== undefined) settings.origin = options.origin;
    const socket = new WebSocket(options.url || socketUrl, settings);
    browserClients.add(socket);
    let finished = false;
    const settle = result => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.terminate();
      browserClients.delete(socket);
      resolve(result);
    };
    const timer = setTimeout(() => {
      if (socket.readyState === WebSocket.OPEN) return settle({ accepted: true });
      if (!finished) { finished = true; socket.terminate(); reject(new Error('Origin probe did not settle')); }
    }, 1000);
    socket.on('message', () => settle({ accepted: true, reason: 'received hub messages' }));
    socket.on('close', code => settle({ accepted: false, code }));
    socket.on('unexpected-response', (_request, response) => {
      response.resume();
      settle({ accepted: false, status: response.statusCode });
    });
    socket.on('error', error => {
      // A rejected HTTP upgrade normally emits unexpected-response; other errors
      // are not proof of a working Origin policy.
      if (!finished) { finished = true; clearTimeout(timer); reject(error); }
    });
  });
}

async function stopAndResult(behavior, requestId) {
  const offset = browser.messages.length;
  abortBehavior = behavior;
  try {
    browser.socket.send(JSON.stringify({ type: 'abort', agentId: 'audit', sessionKey: key, requestId }));
    return await until(() => browser.messages.slice(offset).find(message =>
      message.type === 'abort_result' && message.requestId === requestId), 'Stop acknowledgement', 20000);
  } finally { abortBehavior = 'normal'; }
}

function fileUrl(relative) {
  const url = new URL('/api/files', base);
  url.searchParams.set('agent', 'audit');
  url.searchParams.set('path', relative);
  return url;
}

async function expectDownload(relative, expected) {
  const response = await fetch(fileUrl(relative), { headers: { Cookie: cookie } });
  assert.equal(response.status, 200, 'allowed fixture should remain downloadable');
  assert.equal(await response.text(), expected);
}

async function expectBlocked(relative) {
  const response = await fetch(fileUrl(relative), { headers: { Cookie: cookie } });
  await response.arrayBuffer();
  assert.ok([400, 403, 404].includes(response.status),
    `path=${relative} returned HTTP ${response.status}, exposing an out-of-scope benign fixture`);
}

async function expectFileHeaders(relative, { type, inline, svg = false, download = false }) {
  const url = fileUrl(relative);
  if (download) url.searchParams.set('dl', '1');
  const response = await fetch(url, { headers: { Cookie: cookie } });
  await response.arrayBuffer();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type')?.split(';')[0], type);
  assert.equal(response.headers.get('content-disposition')?.split(';')[0], inline && !download ? 'inline' : 'attachment');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  const csp = response.headers.get('content-security-policy');
  if (svg) {
    assert.match(csp, /(?:^|;)\s*sandbox\s*(?:;|$)/);
    assert.match(csp, /default-src 'none'/);
    assert.doesNotMatch(csp, /allow-scripts|allow-same-origin/);
  } else assert.equal(csp, null, 'non-SVG documents, especially PDFs, keep their normal viewer');
}

try {
  fs.mkdirSync(path.join(dataDir, 'uploads'), { recursive: true });
  fs.mkdirSync(path.join(workspace, 'docs'), { recursive: true });
  fs.mkdirSync(path.join(workspace, 'not-published'), { recursive: true });
  fs.mkdirSync(path.join(mappedWorkspace, 'docs'), { recursive: true });
  fs.mkdirSync(nasVolume, { recursive: true });
  fs.mkdirSync(path.join(temporary, 'outside-workspace'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'uploads', 'allowed.txt'), 'allowed upload fixture');
  fs.writeFileSync(path.join(dataDir, 'not-published.txt'), 'benign fixture outside uploads');
  fs.writeFileSync(path.join(workspace, 'docs', 'allowed.txt'), 'allowed workspace fixture');
  fs.writeFileSync(path.join(workspace, 'not-published', 'fixture.txt'), 'benign fixture outside published folders');
  fs.writeFileSync(path.join(mappedWorkspace, 'docs', 'mapped.txt'), 'allowed prefixed volume fixture');
  fs.writeFileSync(path.join(nasVolume, 'shared.txt'), 'allowed NAS subroot fixture');
  const mimeFixtures = [
    { id: 'mime-html', name: 'inert.html', mimeType: 'text/html', type: 'application/octet-stream', inline: false },
    { id: 'mime-xhtml', name: 'inert.xhtml', mimeType: 'application/xhtml+xml', type: 'application/octet-stream', inline: false },
    { id: 'mime-js', name: 'inert.js', mimeType: 'text/javascript', type: 'application/octet-stream', inline: false },
    { id: 'mime-appjs', name: 'inert.js', mimeType: 'application/javascript', type: 'application/octet-stream', inline: false },
    { id: 'mime-disguised', name: 'inert.png', mimeType: 'text/html', type: 'application/octet-stream', inline: false },
    { id: 'mime-unknown', name: 'inert.pdf', mimeType: 'application/octet-stream', type: 'application/octet-stream', inline: false },
    { id: 'mime-svg', name: 'inert.svg', mimeType: 'image/svg+xml', type: 'image/svg+xml', inline: true, svg: true },
    { id: 'mime-pdf', name: 'inert.pdf', mimeType: 'application/pdf', type: 'application/pdf', inline: true },
    { id: 'mime-text', name: 'inert.txt', mimeType: 'text/plain', type: 'text/plain', inline: true },
    { id: 'mime-markdown', name: 'inert.md', mimeType: 'text/markdown', type: 'text/markdown', inline: true },
    { id: 'mime-raster', name: 'inert.png', mimeType: 'image/png', type: 'image/png', inline: true },
  ];
  for (const fixture of mimeFixtures) {
    fs.writeFileSync(path.join(dataDir, 'uploads', fixture.id), 'inert MIME fixture');
    fs.writeFileSync(path.join(dataDir, 'uploads', fixture.id + '.meta.json'), JSON.stringify({ name: fixture.name, mimeType: fixture.mimeType }));
  }
  for (const extension of ['html', 'svg', 'pdf', 'png', 'md']) {
    fs.writeFileSync(path.join(workspace, 'docs', 'inert.' + extension), 'inert extension fixture');
  }
  fs.symlinkSync(nasVolume, path.join(workspace, 'nas_docs'), 'dir');
  const outsideFile = path.join(temporary, 'outside-workspace', 'fixture.txt');
  fs.writeFileSync(outsideFile, 'benign fixture outside the workspace');
  fs.symlinkSync(outsideFile, path.join(workspace, 'docs', 'outside-link.txt'));
  fs.symlinkSync(outsideFile, path.join(dataDir, 'uploads', 'outside-link.txt'));
  const publishedPath = 'agents/marketing/outbox/';
  const videoPaths = ['example-fci-reel-20261016', 'example-fci-reel-music-20261016']
    .map(directory => publishedPath + directory + '/videos/example-es-vertical.mp4');
  const customFixtures = [
    ...videoPaths.map(relative => [relative, 'authorized marketing video fixture']),
    ['agents/marketing/inbox/private-inbox-fixture.txt', 'benign marketing inbox fixture'],
    ['agents/marketing/private/private-sibling-fixture.txt', 'benign marketing private sibling fixture'],
    ['agents/marketing/outbox-private/private-lookalike-fixture.txt', 'benign lookalike sibling fixture'],
    ['private/private-root-fixture.txt', 'benign private root fixture'],
    ['media/not-explicitly-published.txt', 'benign omitted default-folder fixture'],
  ];
  for (const [relative, content] of customFixtures) {
    const target = path.join(publishedWorkspace, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  fs.symlinkSync(path.join(publishedWorkspace, 'agents/marketing/inbox/private-inbox-fixture.txt'),
    path.join(publishedWorkspace, publishedPath, 'outside-symlink.txt'));
  fs.symlinkSync(path.join(publishedWorkspace, 'private'), path.join(publishedWorkspace, publishedPath, 'outside-directory'), 'dir');
  fs.mkdirSync(path.join(normalizedWorkspace, publishedPath), { recursive: true });
  fs.writeFileSync(path.join(normalizedWorkspace, publishedPath, 'normalized-fixture.txt'), 'authorized normalized-prefix fixture');
  const invalidPublished = [
    ['empty', []], ['null', null], ['string', publishedPath], ['object', {}],
    ['empty-entry', ['']], ['absolute-root', ['/']], ['dot-root', ['.']],
    ['parent-root', ['../']], ['absolute-directory', ['/docs/']],
    ['parent-traversal', ['docs/../../private/']], ['windows-path', ['C:\\private\\']],
    ['backslash', ['agents\\marketing\\outbox\\']], ['non-string-entry', ['docs/', null]],
  ];
  const invalidRoots = invalidPublished.map(([name, published]) => {
    const root = { base: path.join(temporary, 'invalid-published-' + name), prefix: 'invalid-' + name, published };
    fs.mkdirSync(path.join(root.base, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(root.base, 'docs', 'invalid-' + name + '-fixture.txt'), 'benign invalid-policy fixture');
    return { name, root };
  });
  fs.writeFileSync(path.join(dataDir, 'agents.json'), JSON.stringify([
    { id: 'audit', name: 'Isolated audit', url: 'ws://127.0.0.1:' + gateway.address().port,
      token: 'inert-local-fixture', fileRoots: [
        { base: workspace, prefix: '' }, { base: mappedWorkspace, prefix: 'legacy-volume' },
        { base: publishedWorkspace, prefix: 'published-volume', published: ['docs/', publishedPath] },
        { base: normalizedWorkspace, prefix: 'normalized-volume', published: [' ./agents//marketing/./outbox// ', publishedPath] },
        ...invalidRoots.map(fixture => fixture.root),
      ] },
  ]));
  const salt = crypto.randomBytes(16).toString('hex');
  const password = 'local-audit-fixture-only';
  const passwordHash = `scrypt$${salt}$${crypto.scryptSync(password, salt, 64).toString('hex')}`;
  fs.writeFileSync(path.join(dataDir, 'users.json'), JSON.stringify([{ u: 'audit', pw: passwordHash }]));
  const port = await unusedPort();
  base = 'http://127.0.0.1:' + port;
  socketUrl = 'ws://127.0.0.1:' + port + '/ws';
  backend = spawn(process.execPath, [serverFile], {
    env: { ...process.env, DATA_DIR: dataDir, AGENTS_FILE: path.join(dataDir, 'agents.json'),
      BRANDING_FILE: path.join(dataDir, 'branding.json'), PORT: String(port), BIND: '127.0.0.1', BEHIND_PROXY: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const stream of [backend.stdout, backend.stderr]) stream.on('data', data => { backendLogs = (backendLogs + data).slice(-8000); });
  await until(() => fetch(base + '/api/branding').then(response => response.ok).catch(() => false), 'isolated backend startup');
  const login = await fetch(base + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ u: 'audit', p: password }),
  });
  assert.equal(login.status, 200, 'fixture login');
  cookie = login.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie, 'fixture cookie');
  await until(() => fetch(base + '/api/agents', { headers: { Cookie: cookie } })
    .then(response => response.json()).then(body => body.agents?.[0]?.connected), 'simulated Gateway connection');
  browser = await connectBrowser();
  console.log('Isolated backend audit; server sha256=' + serverHash + '; no inference or production access');

  await check('allowed uploads remain downloadable', () => expectDownload('uploads/allowed.txt', 'allowed upload fixture'));
  await check('allowed agent files remain downloadable', () => expectDownload('docs/allowed.txt', 'allowed workspace fixture'));
  await check('container workspace aliases remain downloadable', () => expectDownload('/home/node/.openclaw/workspace/docs/allowed.txt', 'allowed workspace fixture'));
  await check('fileRoots.prefix aliases remain downloadable', () => expectDownload('legacy-volume/docs/mapped.txt', 'allowed prefixed volume fixture'));
  await check('an authorized NAS subroot may itself resolve to a mounted volume', () => expectDownload('nas_docs/shared.txt', 'allowed NAS subroot fixture'));
  await check('truncated agent filenames retain their published-folder fallback', () => expectDownload('docs/…allowed.txt', 'allowed workspace fixture'));
  await check('truncated NAS filenames retain their mounted-volume fallback', () => expectDownload('nas_docs/…shared.txt', 'allowed NAS subroot fixture'));
  await check('uploads cannot traverse into DATA_DIR', () => expectBlocked('uploads/../not-published.txt'));
  await check('whitelisted agent folders cannot traverse into private siblings', () => expectBlocked('docs/../not-published/fixture.txt'));
  await check('published files cannot follow symlinks outside authorized roots', () => expectBlocked('docs/outside-link.txt'));
  await check('uploads cannot follow symlinks outside their subroot', () => expectBlocked('uploads/outside-link.txt'));
  await check('uploads never use truncated-name fallback outside uploads', () => expectBlocked('uploads/…not-published.txt'));

  for (const relative of videoPaths) {
    await check('an explicitly published marketing outbox supports ' + relative.split('/')[3], () => expectDownload(relative, 'authorized marketing video fixture'));
  }
  await check('explicit publication preserves container workspace aliases', () => expectDownload('/home/node/.openclaw/workspace/' + videoPaths[0], 'authorized marketing video fixture'));
  await check('explicit publication preserves fileRoots.prefix aliases', () => expectDownload('published-volume/' + videoPaths[1], 'authorized marketing video fixture'));
  await check('explicit publication restricts truncated-name fallback to the outbox', () => expectDownload(publishedPath + '…example-es-vertical.mp4', 'authorized marketing video fixture'));
  await check('explicit publication normalizes and deduplicates safe relative subdirectories', () => expectDownload('normalized-volume/' + publishedPath + 'normalized-fixture.txt', 'authorized normalized-prefix fixture'));
  await check('explicit publication does not silently retain omitted default directories', () => expectBlocked('published-volume/media/not-explicitly-published.txt'));
  for (const [relative] of customFixtures.filter(([relative]) => !relative.startsWith(publishedPath))) {
    await check('explicit publication excludes sibling ' + relative.split('/').at(-1), () => expectBlocked(relative));
  }
  await check('outbox paths cannot traverse to the marketing inbox', () => expectBlocked(publishedPath + '../inbox/private-inbox-fixture.txt'));
  await check('outbox files cannot escape through symlinks', () => expectBlocked(publishedPath + 'outside-symlink.txt'));
  await check('outbox directories cannot escape through symlinks', () => expectBlocked(publishedPath + 'outside-directory/private-root-fixture.txt'));
  await check('truncated filenames never search a private marketing inbox', () => expectBlocked(publishedPath + '…private-inbox-fixture.txt'));
  await check('truncated filenames never search a private workspace sibling', () => expectBlocked(publishedPath + '…private-root-fixture.txt'));
  for (const { name, root } of invalidRoots) await check('invalid published policy fails closed: ' + name, async () => {
    await expectBlocked(root.prefix + '/docs/invalid-' + name + '-fixture.txt');
    await expectBlocked(root.prefix + '/docs/…invalid-' + name + '-fixture.txt');
  });

  for (const fixture of mimeFixtures) await check('download MIME policy for ' + fixture.id, () => expectFileHeaders('uploads/' + fixture.id, fixture));
  for (const [extension, type, inline, svg] of [
    ['html', 'application/octet-stream', false, false],
    ['svg', 'image/svg+xml', true, true],
    ['pdf', 'application/pdf', true, false],
    ['png', 'image/png', true, false],
    ['md', 'text/markdown', true, false],
  ]) await check('agent extension fallback preserves safe ' + extension + ' handling', () => expectFileHeaders('docs/inert.' + extension, { type, inline, svg }));
  await check('explicit downloads remain attachments for passive content', () => expectFileHeaders('uploads/mime-pdf', { type: 'application/pdf', inline: true, download: true }));

  await check('authenticated JSON is not stored in HTTP caches', async () => {
    for (const apiPath of ['/api/agents', '/api/history?agent=audit&key=' + encodeURIComponent(key)]) {
      const response = await fetch(base + apiPath, { headers: { Cookie: cookie } });
      await response.json();
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
    }
  });

  await check('chat snapshots preserve replace and seq', async () => {
    const offset = browser.messages.length;
    const primary = [...gatewayClients].find(client => client.scopes.includes('operator.admin'));
    assert.ok(primary, 'main Gateway connection');
    for (const [index, text] of ['A', 'AB'].entries()) primary.socket.send(JSON.stringify({
      type: 'event', event: 'chat', payload: {
        state: 'delta', sessionKey: key, runId: 'fixture-stream',
        deltaText: text, replace: true, seq: index + 1,
        message: { role: 'assistant', content: [{ type: 'text', text }] },
      },
    }));
    const messages = await until(() => {
      const deltas = browser.messages.slice(offset).filter(message => message.type === 'delta');
      return deltas.length >= 2 ? deltas : null;
    }, 'snapshot passthrough');
    const actual = messages.map(message => ({ text: message.deltaText, replace: message.replace ?? null, seq: message.seq ?? null }));
    assert.deepEqual(actual, [{ text: 'A', replace: true, seq: 1 }, { text: 'AB', replace: true, seq: 2 }],
      'Gateway deltaText is a snapshot; losing replace turns A then AB into AAB');
  });

  await check('legacy incremental deltas and terminal sequence numbers survive', async () => {
    const offset = browser.messages.length;
    const primary = [...gatewayClients].find(client => client.scopes.includes('operator.admin'));
    primary.socket.send(JSON.stringify({ type: 'event', event: 'chat', payload: {
      state: 'delta', sessionKey: key, runId: 'fixture-incremental', deltaText: 'C', replace: false, seq: 3,
    } }));
    primary.socket.send(JSON.stringify({ type: 'event', event: 'chat', payload: {
      state: 'final', sessionKey: key, runId: 'fixture-incremental', seq: 4,
      message: { role: 'assistant', content: [{ type: 'text', text: 'ABC' }] },
    } }));
    const frames = await until(() => {
      const found = browser.messages.slice(offset).filter(message => message.runId === 'fixture-incremental');
      return found.length >= 2 ? found : null;
    }, 'legacy delta and terminal');
    assert.equal(frames[0].replace, false);
    assert.equal(frames[0].seq, 3);
    assert.equal(frames[1].seq, 4);
  });

  await check('STOP clears lifecycle queues through sessions.abort', async () => {
    const offset = requests.length;
    const result = await stopAndResult('normal', 'audit-stop');
    const request = requests.slice(offset).find(item => ['chat.abort', 'sessions.abort'].includes(item.method));
    assert.ok(request, 'Stop RPC was sent');
    assert.deepEqual({ method: request.method, key: request.params.key ?? null, clearQueued: request.params.clearQueued ?? null },
      { method: 'sessions.abort', key, clearQueued: true },
      'chat.abort lacks the followup/lane lifecycle cleanup promised by STOP');
    assert.equal(result.ok, true);
    assert.equal(result.queueCleared, true);
  });

  await check('old Gateway fallback reports incomplete queue cleanup', async () => {
    const offset = requests.length;
    const result = await stopAndResult('unsupported', 'audit-stop-legacy');
    assert.deepEqual(requests.slice(offset).filter(item => item.method.endsWith('.abort')).map(item => item.method), ['sessions.abort', 'chat.abort']);
    assert.equal(result.ok, true);
    assert.equal(result.queueCleared, false);
    assert.ok(result.warning, 'legacy Stop must not claim the lifecycle queues were cleared');
  });

  for (const behavior of ['denied', 'invalid', 'unavailable', 'timeout']) await check('Stop ' + behavior + ' is surfaced without a legacy fallback', async () => {
    const offset = requests.length;
    const result = await stopAndResult(behavior, 'audit-stop-' + behavior);
    assert.equal(result.ok, false);
    assert.equal(result.queueCleared, false);
    assert.ok(result.error);
    assert.deepEqual(requests.slice(offset).filter(item => item.method.endsWith('.abort')).map(item => item.method), ['sessions.abort']);
  });

  await check('foreign-Origin WebSockets are rejected with an otherwise-valid cookie', async () => {
    const outcome = await browserProbe({ origin: 'https://foreign-origin.invalid' });
    assert.equal(outcome.accepted, false, JSON.stringify(outcome));
  });

  await check('explicit null Origin is rejected', async () => {
    assert.equal((await browserProbe({ origin: 'null' })).accepted, false);
  });

  await check('tooling without Origin remains allowed', async () => {
    assert.equal((await browserProbe()).accepted, true);
  });

  await check('untrusted forwarded headers cannot authorize a foreign Origin', async () => {
    const outcome = await browserProbe({ origin: 'https://foreign-origin.invalid',
      headers: { 'x-forwarded-host': 'foreign-origin.invalid', 'x-forwarded-proto': 'https' } });
    assert.equal(outcome.accepted, false);
  });

  await check('a malformed auth cookie is rejected without crashing the backend', async () => {
    const outcome = await browserProbe({ origin: base, cookie: 'hubweb=%' });
    assert.equal(outcome.accepted, false);
    assert.ok(outcome.code === 4401 || [401, 403].includes(outcome.status), 'expected a deliberate auth rejection');
    assert.equal((await fetch(base + '/api/agents', { headers: { Cookie: cookie } })).status, 200);
  });

  await check('malformed unrelated cookies do not invalidate the signed session', async () => {
    assert.equal((await browserProbe({ origin: base, cookie: 'unrelated=%; ' + cookie })).accepted, true);
  });

  await check('send acknowledgement correlates the client message', async () => {
    const message = { type: 'send', agentId: 'audit', sessionKey: key, text: 'inert correlation fixture',
      clientMessageId: 'audit-correlation', requestId: 'audit-correlation-attempt' };
    const acknowledgement = await sendAndAck(browser, message);
    assert.equal(acknowledgement.type, 'send_accepted');
    assert.equal(acknowledgement.clientMessageId, message.clientMessageId);
    assert.equal(acknowledgement.requestId, message.requestId);
  });

  await check('Gateway send errors preserve both correlation identifiers', async () => {
    const message = { type: 'send', agentId: 'audit', sessionKey: key, text: 'inert rejection fixture',
      clientMessageId: 'audit-rejected', requestId: 'audit-rejected-attempt' };
    const reply = await sendAndAck(browser, message);
    assert.equal(reply.type, 'send_error');
    assert.equal(reply.clientMessageId, message.clientMessageId);
    assert.equal(reply.requestId, message.requestId);
    assert.match(reply.error, /Fixture rejected/);
  });

  await check('legacy sends receive a generated message identifier', async () => {
    const reply = await sendAndAck(browser, { type: 'send', agentId: 'audit', sessionKey: key,
      text: 'inert legacy fixture', requestId: 'audit-legacy-attempt' });
    assert.equal(reply.type, 'send_accepted');
    assert.match(reply.clientMessageId, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
    assert.equal(reply.requestId, 'audit-legacy-attempt');
    const identity = JSON.stringify(['audit', 'audit', JSON.stringify([key, reply.clientMessageId])]);
    assert.equal(requests.findLast(item => item.method === 'chat.send').params.idempotencyKey, 'hub-send-' + crypto.createHash('sha256').update(identity).digest('hex'));
  });

  for (const value of ['', 'bad/message', 'x'.repeat(129), { invalid: true }]) await check('invalid clientMessageId is rejected: ' + JSON.stringify(value).slice(0, 32), async () => {
    const before = requests.filter(item => item.method === 'chat.send').length;
    const reply = await sendAndAck(browser, { type: 'send', agentId: 'audit', sessionKey: key,
      text: 'inert invalid-id fixture', clientMessageId: value, requestId: 'audit-invalid-id' });
    assert.equal(reply.type, 'send_error');
    assert.ok(Object.hasOwn(reply, 'clientMessageId'));
    assert.equal(reply.requestId, 'audit-invalid-id');
    assert.equal(requests.filter(item => item.method === 'chat.send').length, before);
  });

  await check('invalid requestId is rejected before Gateway admission', async () => {
    const before = requests.filter(item => item.method === 'chat.send').length;
    const reply = await sendAndAck(browser, { type: 'send', agentId: 'audit', sessionKey: key,
      text: 'inert invalid-request fixture', clientMessageId: 'audit-invalid-request', requestId: 'x'.repeat(129) });
    assert.equal(reply.type, 'send_error');
    assert.equal(reply.clientMessageId, 'audit-invalid-request');
    assert.ok(Object.hasOwn(reply, 'requestId'));
    assert.equal(requests.filter(item => item.method === 'chat.send').length, before);
  });

  await check('missing attachments reject the entire send rather than dropping a file', async () => {
    const before = requests.filter(item => item.method === 'chat.send').length;
    const reply = await sendAndAck(browser, { type: 'send', agentId: 'audit', sessionKey: key,
      text: 'inert missing attachment fixture', clientMessageId: 'audit-missing-file', requestId: 'audit-missing-file-attempt',
      attachments: [{ id: 'allowed.txt', mimeType: 'text/plain' }, { id: 'missing.txt', mimeType: 'text/plain' }] });
    assert.equal(reply.type, 'send_error');
    assert.equal(reply.clientMessageId, 'audit-missing-file');
    assert.equal(reply.requestId, 'audit-missing-file-attempt');
    assert.match(reply.error, /adjunto/i);
    assert.equal(requests.filter(item => item.method === 'chat.send').length, before);
  });

  await check('attachment symlinks cannot read outside uploads', async () => {
    const before = requests.filter(item => item.method === 'chat.send').length;
    const reply = await sendAndAck(browser, { type: 'send', agentId: 'audit', sessionKey: key,
      clientMessageId: 'audit-symlink-file', requestId: 'audit-symlink-file-attempt',
      attachments: [{ id: 'outside-link.txt', mimeType: 'text/plain' }] });
    assert.equal(reply.type, 'send_error');
    assert.equal(requests.filter(item => item.method === 'chat.send').length, before);
  });

  await check('malformed attachment collections are rejected without crashing', async () => {
    const reply = await sendAndAck(browser, { type: 'send', agentId: 'audit', sessionKey: key,
      text: 'inert malformed attachment fixture', clientMessageId: 'audit-invalid-files', requestId: 'audit-invalid-files-attempt',
      attachments: { id: 'allowed.txt' } });
    assert.equal(reply.type, 'send_error');
    assert.equal((await fetch(base + '/api/branding')).status, 200);
  });

  await check('valid file attachments remain attached to the simulated send', async () => {
    const reply = await sendAndAck(browser, { type: 'send', agentId: 'audit', sessionKey: key,
      clientMessageId: 'audit-valid-file', requestId: 'audit-valid-file-attempt',
      attachments: [{ id: 'allowed.txt', name: 'allowed.txt', mimeType: 'text/plain' }] });
    assert.equal(reply.type, 'send_accepted');
    const sent = requests.findLast(item => item.method === 'chat.send').params;
    assert.equal(sent.attachments.length, 1);
    assert.equal(Buffer.from(sent.attachments[0].content, 'base64').toString(), 'allowed upload fixture');
  });

  await check('malformed JSON frame shapes do not crash the backend', async () => {
    browser.socket.send('null');
    browser.socket.send('[]');
    browser.socket.send('{');
    await sleep(50);
    assert.equal((await fetch(base + '/api/agents', { headers: { Cookie: cookie } })).status, 200);
  });

  await check('closing a browser before its ACK cannot reject the server handler', async () => {
    const temporaryBrowser = await connectBrowser();
    temporaryBrowser.socket.send(JSON.stringify({ type: 'send', agentId: 'audit', sessionKey: key,
      text: 'inert delayed disconnect fixture', clientMessageId: 'audit-disconnected', requestId: 'audit-disconnected-attempt' }));
    await until(() => requests.some(item => item.method === 'chat.send' && item.params.message === 'inert delayed disconnect fixture'), 'delayed fixture admission');
    const closed = once(temporaryBrowser.socket, 'close');
    temporaryBrowser.socket.close();
    await closed;
    await sleep(200);
    assert.equal((await fetch(base + '/api/agents', { headers: { Cookie: cookie } })).status, 200);
    assert.equal(backend.exitCode, null);
  });

  await check('retry after browser reconnect admits a client message only once', async () => {
    const admittedBefore = admissions.size;
    const message = { type: 'send', agentId: 'audit', sessionKey: key, text: 'inert reconnect fixture',
      clientMessageId: 'audit-stable-retry', requestId: 'audit-retry-first' };
    const first = await sendAndAck(browser, message);
    assert.equal(first.type, 'send_accepted');
    browser.socket.close();
    await once(browser.socket, 'close');
    browser = await connectBrowser();
    const second = await sendAndAck(browser, { ...message, requestId: 'audit-retry-second' });
    assert.equal(second.type, 'send_accepted');
    assert.equal(admissions.size - admittedBefore, 1,
      'same clientMessageId became multiple Gateway admissions because the idempotencyKey changed');
    assert.equal(second.runId, first.runId, 'a retry must refer to the original run');
  });

  const proxyPort = await unusedPort();
  const proxyBase = 'http://127.0.0.1:' + proxyPort;
  const proxyUrl = 'ws://127.0.0.1:' + proxyPort + '/ws';
  const proxyBackend = spawn(process.execPath, [serverFile], {
    env: { ...process.env, DATA_DIR: dataDir, AGENTS_FILE: path.join(dataDir, 'agents.json'),
      BRANDING_FILE: path.join(dataDir, 'branding.json'), PORT: String(proxyPort), BIND: '127.0.0.1',
      BEHIND_PROXY: '1', MAX_UPLOAD_MB: '0.001' },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  extraBackends.add(proxyBackend);
  await until(() => fetch(proxyBase + '/api/branding').then(response => response.ok).catch(() => false), 'trusted-proxy backend');

  await check('trusted proxy host/protocol authorize only the matching public Origin', async () => {
    const headers = { 'x-forwarded-host': 'trusted-proxy-fixture.invalid', 'x-forwarded-proto': 'HTTPS' };
    assert.equal((await browserProbe({ url: proxyUrl, origin: 'https://trusted-proxy-fixture.invalid', headers })).accepted, true);
    assert.equal((await browserProbe({ url: proxyUrl, origin: 'https://foreign-origin.invalid', headers })).accepted, false);
    assert.equal((await browserProbe({ url: proxyUrl, origin: 'http://trusted-proxy-fixture.invalid', headers })).accepted, false);
  });

  await check('a small multipart upload still succeeds under the configured limit', async () => {
    const form = new FormData();
    form.append('files', new Blob(['inert tiny upload'], { type: 'text/plain' }), 'inert.txt');
    const response = await fetch(proxyBase + '/api/upload', { method: 'POST', headers: { Cookie: cookie }, body: form });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.files.length, 1);
    assert.equal(body.files[0].name, 'inert.txt');
    assert.equal(body.files[0].size, 17);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  });

  await check('an oversized upload returns actionable 413 JSON rather than HTML', async () => {
    const form = new FormData();
    form.append('files', new Blob(['x'.repeat(2048)], { type: 'text/plain' }), 'oversized.txt');
    const response = await fetch(proxyBase + '/api/upload', { method: 'POST', headers: { Cookie: cookie }, body: form });
    assert.equal(response.status, 413);
    assert.equal((await response.json()).error, 'Cada archivo puede ocupar hasta 0.001 MB');
    assert.equal(response.headers.get('cache-control'), 'no-store');
  });

  await check('too many files return readable 400 JSON', async () => {
    const form = new FormData();
    for (let i = 0; i < 7; i++) form.append('files', new Blob(['tiny']), 'inert-' + i + '.txt');
    const response = await fetch(proxyBase + '/api/upload', { method: 'POST', headers: { Cookie: cookie }, body: form });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /6 archivos/);
  });

  await check('malformed multipart uploads return readable 400 JSON', async () => {
    const response = await fetch(proxyBase + '/api/upload', { method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'multipart/form-data; boundary=isolated-inert-boundary' },
      body: 'incomplete inert fixture' });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /subida/);
  });
} catch (error) {
  results.push({ name: 'audit harness setup', ok: false });
  console.error('FAIL audit harness setup: ' + error.message);
} finally {
  for (const client of browserClients) client.terminate();
  for (const child of [backend, ...extraBackends].filter(Boolean)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await exited;
    }
  }
  for (const client of gatewayClients) client.socket.terminate();
  await new Promise(resolve => gateway.close(resolve));
  fs.rmSync(temporary, { recursive: true, force: true });
}

const passed = results.filter(result => result.ok).length;
const failed = results.length - passed;
console.log(`Backend audit: ${passed}/${results.length} passed; ${failed} failed`);
process.exitCode = failed ? 1 : 0;
