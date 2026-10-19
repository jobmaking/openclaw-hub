// Real Hub backend, two users and an inert native-style Gateway. No production.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { WebSocket, WebSocketServer } = require('ws');
const repo = path.resolve(new URL('..', import.meta.url).pathname);
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-user-isolation-'));
const data = path.join(temporary, 'data'), workspace = path.join(temporary, 'workspace');
fs.mkdirSync(path.join(data, 'uploads'), { recursive: true });
fs.mkdirSync(path.join(workspace, 'reports'), { recursive: true });
fs.writeFileSync(path.join(workspace, 'reports/alice.txt'), 'PRIVATE-ALICE-FILE');
fs.writeFileSync(path.join(workspace, 'reports/own.txt'), 'OWN-DELIVERY');
fs.writeFileSync(path.join(data, 'uploads/legacy-upload'), 'PRIVATE-ALICE-UPLOAD');
fs.writeFileSync(path.join(data, 'uploads/legacy-upload.meta.json'), JSON.stringify({ owner: 'alice', name: 'legacy.txt' }));
const password = 'inert-local-password';
const salt = 'inert-salt';
const pw = 'scrypt$' + salt + '$' + crypto.scryptSync(password, salt, 64).toString('hex');
const mixed = process.env.HUB_TEST_MIXED_SCOPES === '1';
const bobAgents = mixed ? ['assistant', 'first', 'second'] : ['assistant'];
const users = [{ u: 'alice', name: 'Alice', pw, legacyStorageOwner: true },
  { u: 'bob', name: 'Bob', pw, allowedAgents: bobAgents,
    ...(mixed ? { sessionScope: 'shared', sessionScopes: { assistant: 'own' } } : { sessionScope: 'own' }) }];
fs.writeFileSync(path.join(data, 'users.json'), JSON.stringify(users));
const old = 'agent:main:dashboard:alice-private';
const makeRow = (key, extra = {}) => ({ key, agentId: 'main', sessionId: 'sid-' + key,
  classification: 'direct', createdVia: 'gateway', label: key === old ? 'PRIVATE-ALICE-LABEL' : 'Own conversation',
  updatedAt: Date.now(), hasActiveRun: false, modelProvider: 'fixture', model: 'inert', ...extra });
const rows = new Map([[old, makeRow(old)]]), creations = new Map();
// One native Gateway serves both Gael (main) and Ploti. Both links deliberately
// receive its full roster and event stream, so only the real Hub can separate it.
const firstLegacy = 'agent:main:dashboard:first-legacy';
const secondLegacy = 'agent:second:dashboard:second-legacy';
const sharedRows = new Map([
  [firstLegacy, makeRow(firstLegacy, { label: 'GAEL-LEGACY', hasActiveRun: true })],
  [secondLegacy, makeRow(secondLegacy, { agentId: 'second', label: 'PLOTI-LEGACY', hasActiveRun: true })],
]);
const resolvedQuestions = new Set();
const requests = [], sockets = new Set(), browsers = new Set(), results = [];
let backend, logs = '', base, own, cookieAlice, cookieBob, browserAlice, browserBob;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, duration = 6000) {
  const end = Date.now() + duration;
  while (Date.now() < end) { const value = await fn(); if (value) return value; if (backend?.exitCode != null) throw new Error(logs.slice(-2000)); await pause(25); }
  throw new Error('Timeout: ' + label);
}
async function check(name, fn) {
  try { await fn(); results.push(true); console.log('PASS ' + name); }
  catch (error) { results.push(false); console.log('FAIL ' + name + ' · ' + error.message); }
}
const gateway = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await once(gateway, 'listening');
function question(key = old) { return { id: 'question-' + key, agentId: key.split(':')[1], sessionKey: key, status: 'pending', questions: [{ questionId: 'q', question: key === old ? 'PRIVATE-ALICE-QUESTION' : 'OWN-QUESTION', options: ['Yes'] }] }; }
function approval(key = old) { return { id: 'approval-' + key, status: 'pending', request: { sessionKey: key }, presentation: { kind: 'exec', commandText: key === old ? 'PRIVATE-ALICE-APPROVAL' : 'OWN-APPROVAL', allowedDecisions: ['allow-once', 'allow-always', 'deny'] } }; }
gateway.on('connection', socket => {
  const client = { socket, agent: null }; sockets.add(client);
  socket.on('close', () => sockets.delete(client));
  socket.send(JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { nonce: 'inert-isolation' } }));
  socket.on('message', raw => {
    const frame = JSON.parse(raw), p = frame.params || {};
    requests.push({ agent: client.agent, method: frame.method, params: p });
    const reply = (payload, error) => socket.send(JSON.stringify({ type: 'res', id: frame.id, ok: !error, ...(error ? { error } : { payload }) }));
    const nativeRows = ['first', 'second'].includes(client.agent) ? sharedRows : rows;
    if (frame.method === 'connect') { client.agent = String(p.auth?.token || '').replace('inert-', ''); return reply({ type: 'hello-ok', protocol: 4, auth: { scopes: p.scopes } }); }
    if (frame.method === 'models.list') return reply({ models: [{ id: 'inert', provider: 'fixture', name: 'Inert' }] });
    if (frame.method === 'sessions.list') return reply({ sessions: [...nativeRows.values()] });
    if (frame.method === 'sessions.describe') return nativeRows.has(p.key) ? reply({ session: nativeRows.get(p.key) }) : reply(null, { code: 'NOT_FOUND', message: 'Not found' });
    if (frame.method === 'sessions.preview') return reply({ previews: (p.keys || []).map(key => ({ key, messages: [{ role: 'user', text: key === old ? 'PRIVATE-ALICE-SNIPPET' : 'Own prompt' }] })) });
    if (frame.method === 'sessions.create') {
      let key = creations.get(p.idempotencyKey);
      if (!key) { key = 'agent:' + (p.agentId || 'main') + ':dashboard:created-' + creations.size; creations.set(p.idempotencyKey, key); nativeRows.set(key, makeRow(key, { agentId: p.agentId || 'main', label: p.label || 'Own conversation' })); }
      return reply({ key, entry: nativeRows.get(key) });
    }
    if (frame.method === 'chat.history') return reply({ sessionId: nativeRows.get(p.sessionKey)?.sessionId,
      messages: [{ role: 'assistant', content: [{ type: 'text', text: p.sessionKey === old ? 'PRIVATE-ALICE-HISTORY' : 'OWN-HISTORY\nMEDIA: reports/own.txt' }], __openclaw: { id: 'message-own', seq: 1 } }], hasMore: false });
    if (frame.method === 'sessions.search') {
      if (p.sessionKeys?.length > 200) return reply(null, { code: 'INVALID_REQUEST', message: 'At most 200 sessionKeys' });
      const agentId = p.agentId || p.scope?.agentId || 'main';
      const selected = [...nativeRows.values()].filter(row => row.agentId === agentId && (!p.sessionKeys || p.sessionKeys.includes(row.key)));
      return reply({ sessions: selected, results: selected.slice(0, p.limit).map(row => ({ sessionKey: row.key, sessionId: row.sessionId, messageId: 'm-' + row.key, snippet: row.key === old ? 'PRIVATE-ALICE-SEARCH' : 'OWN-SEARCH' })) });
    }
    if (frame.method === 'question.list') return reply({ questions: client.agent === 'assistant' ? [question(), ...(own ? [question(own)] : [])].filter(item => !resolvedQuestions.has(item.id)) : [] });
    if (frame.method === 'question.get') return reply({ question: p.id === 'question-' + old ? question() : question(own) });
    if (frame.method === 'question.resolve') { resolvedQuestions.add(p.id); return reply({ status: 'answered' }); }
    if (frame.method === 'exec.approval.list') return reply(client.agent === 'assistant' ? [approval(), ...(own ? [approval(own)] : [])] : []);
    if (frame.method === 'plugin.approval.list') return reply([]);
    if (frame.method === 'approval.resolve') return reply({ applied: true, approval: { status: p.decision } });
    if (frame.method === 'artifacts.list') return reply({ artifacts: [{ id: p.sessionKey === old ? 'private-artifact' : 'own-artifact', title: 'delivery.txt', mimeType: 'text/plain', download: { mode: 'bytes' } }] });
    if (frame.method === 'artifacts.download') return p.artifactId === 'private-artifact' && p.sessionKey !== old
      ? reply(null, { code: 'NOT_FOUND', message: 'Artifact is not in this session' })
      : reply({ artifact: { title: 'delivery.txt', mimeType: 'text/plain' }, encoding: 'base64', data: Buffer.from('OWN-ARTIFACT').toString('base64') });
    if (frame.method === 'sessions.files.get') return reply({ file: { path: p.path, content: 'PRIVATE-SHARED-WORKSPACE', contentEncoding: 'utf8' } });
    if (frame.method === 'chat.send') return reply({ status: 'started', runId: 'inert-' + p.idempotencyKey });
    if (frame.method === 'sessions.patch') return reply({ entry: { ...nativeRows.get(p.key), ...p } });
    return reply({ ok: true, aborted: true, truncated: false });
  });
});
fs.writeFileSync(path.join(data, 'agents.json'), JSON.stringify((mixed ? ['assistant', 'bu', 'first', 'second'] : ['assistant', 'bu']).map(id => ({ id, name: id,
  token: 'inert-' + id, url: 'ws://127.0.0.1:' + gateway.address().port + '/ws', fileRoots: [{ base: workspace }],
  ...(['first', 'second'].includes(id) ? { gatewayAgentId: id === 'first' ? 'main' : 'second' } : {}) }))));
async function start() {
  const listener = http.createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve)); base = 'http://127.0.0.1:' + port;
  logs = ''; backend = spawn(process.execPath, [path.join(repo, 'server.js')], { cwd: repo,
    env: { ...process.env, DATA_DIR: data, PORT: String(port), BIND: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  backend.stdout.on('data', chunk => { logs += chunk; }); backend.stderr.on('data', chunk => { logs += chunk; });
  await until(async () => { try { return (await fetch(base + '/api/branding')).ok; } catch { return false; } }, 'backend started');
  await until(() => logs.includes('[assistant] conectado'), 'Gateway connected');
}
async function stop() { for (const browser of browsers) browser.terminate(); browsers.clear(); if (backend && backend.exitCode == null) { const end = once(backend, 'exit'); backend.kill(); await end; } }
async function login(u) { const response = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ u, p: password }) }); assert.equal(response.status, 200); return response.headers.get('set-cookie').split(';')[0]; }
async function api(cookie, route, params = {}, method = 'GET') {
  const url = new URL(route, base), options = { method, headers: { Cookie: cookie } };
  if (['GET', 'DELETE'].includes(method)) for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  else { options.headers['Content-Type'] = 'application/json'; options.body = JSON.stringify(params); }
  return fetch(url, options);
}
async function connect(cookie) {
  const socket = new WebSocket(base.replace('http:', 'ws:') + '/ws', { headers: { Cookie: cookie } }), messages = [];
  browsers.add(socket); socket.on('message', raw => messages.push(JSON.parse(raw)));
  await once(socket, 'open'); await until(() => messages.find(m => m.type === 'hello'), 'browser hello'); return { socket, messages };
}
function emit(event, payload, agents = ['assistant']) { for (const client of sockets) if (agents.includes(client.agent)) client.socket.send(JSON.stringify({ type: 'event', event, payload })); }
async function wsReply(client, envelope, type) {
  const offset = client.messages.length; client.socket.send(JSON.stringify(envelope));
  return until(() => client.messages.slice(offset).find(m => m.type === type), type);
}
try {
  await start(); cookieAlice = await login('alice'); cookieBob = await login('bob');
  browserAlice = await connect(cookieAlice); browserBob = await connect(cookieBob);
  await check('Bob only sees Assistant in HTTP and WebSocket catalogs', async () => {
    assert.deepEqual((await (await api(cookieBob, '/api/agents')).json()).agents.map(a => a.id), bobAgents);
    assert.deepEqual(browserBob.messages.find(m => m.type === 'hello').agents.map(a => a.id), bobAgents);
  });
  await check('No legacy conversations, snippets or counts are visible to Bob', async () => {
    const response = await (await api(cookieBob, '/api/sessions', { agent: 'assistant', all: '1' })).json();
    assert.deepEqual(response.sessions, []); assert.equal(response.ownCount, 0); assert.equal(response.othersCount, 0); assert.ok(!JSON.stringify(response).includes('PRIVATE-ALICE'));
  });
  const create = async cookie => (await (await api(cookie, '/api/sessions', { agent: 'assistant', idempotencyKey: 'same-client-identity' }, 'POST')).json()).key;
  own = await create(cookieBob); assert.ok(own);
  await check('Creation idempotency is namespaced by user, not shared', async () => { const other = await create(cookieAlice); assert.ok(other && other !== own); assert.equal(await create(cookieBob), own); });
  await check('Each account lists its own newly created conversations', async () => {
    const bob = await (await api(cookieBob, '/api/sessions', { agent: 'assistant', fresh: '1' })).json();
    assert.deepEqual(bob.sessions.map(s => s.key), [own]);
    const alice = await (await api(cookieAlice, '/api/sessions', { agent: 'assistant', fresh: '1' })).json();
    assert.ok(alice.sessions.some(s => s.key === old)); assert.ok(!alice.sessions.some(s => s.key === own));
  });
  const blocked = [
    ['GET', '/api/sessions', { agent: 'bu' }], ['POST', '/api/sessions', { agent: 'bu' }],
    ...['/api/history', '/api/history-page', '/api/session-settings', '/api/run-status', '/api/activity', '/api/artifacts'].map(route => ['GET', route, { agent: 'assistant', key: old }]),
    ['GET', '/api/artifact-download', { agent: 'assistant', key: old, id: 'private-artifact' }],
    ['DELETE', '/api/sessions', { agent: 'assistant', key: old }],
    ['POST', '/api/pin', { agent: 'assistant', key: old, pinned: true }],
    ['POST', '/api/model', { agent: 'assistant', key: old, model: 'fixture/inert' }],
    ['POST', '/api/session-rename', { agent: 'assistant', key: old, label: 'Forbidden rename' }],
    ['POST', '/api/async-question', { agent: 'assistant', key: old, itemId: 'guessed' }],
  ];
  await check('All direct legacy-session and other-agent routes reject access', async () => {
    for (const [method, route, params] of blocked) assert.equal((await api(cookieBob, route, params, method)).status, 403, method + ' ' + route);
  });
  await check('Search returns only owned hits and no private snippets', async () => {
    const response = await (await api(cookieBob, '/api/session-search', { agent: 'assistant', q: 'needle' })).json();
    assert.deepEqual(response.results.map(h => h.sessionKey), [own]); assert.ok(!JSON.stringify(response).includes('PRIVATE-ALICE'));
  });
  await check('Private histories cannot crowd out her results before the native search limit', async () => {
    const saved = rows.get(own); rows.delete(own);
    const hidden = Array.from({ length: 30 }, (_, index) => 'agent:main:dashboard:hidden-' + index);
    for (const key of hidden) rows.set(key, makeRow(key));
    rows.set(own, saved);
    try {
      const response = await (await api(cookieBob, '/api/session-search', { agent: 'assistant', q: 'needle' })).json();
      assert.deepEqual(response.results.map(hit => hit.sessionKey), [own]);
      const request = requests.findLast(r => r.method === 'sessions.search');
      assert.deepEqual(request.params.sessionKeys, [own]); assert.equal(request.params.scope, undefined);
    } finally { for (const key of hidden) rows.delete(key); }
  });
  await check('Guessed question/approval IDs cannot use an owned key as authority', async () => {
    assert.equal((await api(cookieBob, '/api/question', { agent: 'assistant', key: own, id: 'question-' + old, answers: { q: ['Yes'] } }, 'POST')).status, 403);
    assert.equal((await api(cookieBob, '/api/approval', { agent: 'assistant', key: own, id: 'approval-' + old, kind: 'exec', decision: 'allow-once' }, 'POST')).status, 403);
  });
  await check('Case and trailing-slash route aliases cannot bypass resource ownership', async () => {
    for (const route of ['/api/question/', '/api/QUESTION']) assert.equal((await api(cookieBob, route, { agent: 'assistant', key: own, id: 'question-' + old, answers: { q: ['Yes'] } }, 'POST')).status, 403, route);
    for (const route of ['/api/approval/', '/api/APPROVAL']) assert.equal((await api(cookieBob, route, { agent: 'assistant', key: own, id: 'approval-' + old, decision: 'allow-once' }, 'POST')).status, 403, route);
    for (const route of ['/api/files/', '/api/FILES', '/api/session-file/', '/api/SESSION-FILE']) assert.equal((await api(cookieBob, route, { agent: 'assistant', key: own, path: 'reports/alice.txt' })).status, 403, route);
  });
  await check('HEAD authorizes the GET query, never an unrelated request body', async () => {
    const httpResult = await new Promise((resolve, reject) => {
      const query = new URLSearchParams({ agent: 'assistant', key: old, path: 'reports/alice.txt' });
      const payload = JSON.stringify({ agent: 'assistant', key: own, path: 'reports/own.txt' });
      const request = http.request(base + '/api/files?' + query, { method: 'HEAD', headers: { Cookie: cookieBob, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
      request.on('error', reject); request.end(payload);
    });
    assert.equal(httpResult, 403);
  });
  await check('Legacy uploads cannot be read or resent by Bob', async () => {
    assert.equal((await api(cookieBob, '/api/files', { path: 'uploads/legacy-upload' })).status, 403);
    const reply = await wsReply(browserBob, { type: 'send', agentId: 'assistant', sessionKey: own, clientMessageId: 'forbidden-upload', attachments: [{ id: 'legacy-upload', name: 'legacy.txt' }] }, 'send_error');
    assert.ok(reply.error);
  });
  await check('A key of her own does not authorize shared workspace files', async () => {
    assert.equal((await api(cookieBob, '/api/files', { agent: 'assistant', key: own, path: 'reports/alice.txt' })).status, 403);
    assert.equal((await api(cookieBob, '/api/session-file', { agent: 'assistant', key: own, path: 'reports/alice.txt' })).status, 403);
  });
  await check('An assistant delivery in her transcript remains downloadable', async () => {
    const response = await api(cookieBob, '/api/files', { agent: 'assistant', key: own, path: 'reports/own.txt' }); assert.equal(response.status, 200); assert.equal(await response.text(), 'OWN-DELIVERY');
    const artifact = await api(cookieBob, '/api/artifact-download', { agent: 'assistant', key: own, id: 'own-artifact' }); assert.equal(artifact.status, 200); assert.equal(await artifact.text(), 'OWN-ARTIFACT');
    assert.equal((await api(cookieBob, '/api/artifact-download', { agent: 'assistant', key: own, id: 'private-artifact' })).status, 404);
  });
  await check('Own uploads remain readable and usable', async () => {
    const form = new FormData(); form.append('files', new Blob(['OWN-UPLOAD']), 'own.txt');
    const response = await fetch(base + '/api/upload', { method: 'POST', headers: { Cookie: cookieBob }, body: form }); assert.equal(response.status, 200);
    const file = (await response.json()).files[0]; const downloaded = await api(cookieBob, '/api/files', { path: 'uploads/' + file.id }); assert.equal(await downloaded.text(), 'OWN-UPLOAD');
    const offset = browserBob.messages.length; browserBob.socket.send(JSON.stringify({ type: 'send', agentId: 'assistant', sessionKey: own, clientMessageId: 'own-upload', attachments: [file] }));
    const reply = await until(() => browserBob.messages.slice(offset).find(m => ['send_accepted', 'send_error'].includes(m.type)), 'own send'); assert.equal(reply.type, 'send_accepted');
  });
  await check('Forbidden WS send/watch/abort have no mutating Gateway effects', async () => {
    const before = requests.length;
    const sent = await wsReply(browserBob, { type: 'send', agentId: 'assistant', sessionKey: old, text: 'DO-NOT-SEND', clientMessageId: 'forbidden-session' }, 'send_error'); assert.ok(sent.error);
    const aborted = await wsReply(browserBob, { type: 'abort', agentId: 'assistant', sessionKey: old }, 'abort_result'); assert.equal(aborted.ok, false);
    browserBob.socket.send(JSON.stringify({ type: 'watch', agentId: 'assistant', sessionKey: old })); await pause(100);
    assert.ok(!requests.slice(before).some(r => ['chat.send', 'sessions.abort', 'chat.abort', 'sessions.messages.subscribe'].includes(r.method) && (r.params.key === old || r.params.sessionKey === old)));
  });
  await check('Owned HTTP read/rename/pin/settings operations still work', async () => {
    for (const route of ['/api/history', '/api/history-page', '/api/session-settings', '/api/run-status', '/api/activity']) assert.equal((await api(cookieBob, route, { agent: 'assistant', key: own })).status, 200, route);
    for (const [route, extra] of [['/api/session-rename', { label: 'Own renamed' }], ['/api/pin', { pinned: true }], ['/api/session-settings', { thinkingLevel: null }]]) assert.equal((await api(cookieBob, route, { agent: 'assistant', key: own, ...extra }, 'POST')).status, 200, route);
  });
  await check('Verified native children inherit ownership, missing/cyclic/foreign parents do not', async () => {
    const child = 'agent:main:subagent:owned-child', bad = 'agent:main:subagent:foreign-child';
    rows.set(child, makeRow(child, { classification: 'subagent', parentSessionKey: own }));
    rows.set(bad, makeRow(bad, { classification: 'subagent', parentSessionKey: old }));
    rows.set('agent:main:cycle-A', makeRow('agent:main:cycle-A', { parentSessionKey: 'agent:main:cycle-B' }));
    rows.set('agent:main:cycle-B', makeRow('agent:main:cycle-B', { parentSessionKey: 'agent:main:cycle-A' }));
    const response = await (await api(cookieBob, '/api/sessions', { agent: 'assistant', fresh: '1' })).json(); assert.ok(response.sessions.some(s => s.key === child)); assert.ok(!response.sessions.some(s => s.key === bad));
    assert.equal((await api(cookieBob, '/api/history', { agent: 'assistant', key: child })).status, 200);
    assert.equal((await api(cookieBob, '/api/history', { agent: 'assistant', key: 'agent:main:cycle-A' })).status, 403);
  });
  await check('Live text, question and approval events never cross accounts', async () => {
    const startC = browserBob.messages.length, startJ = browserAlice.messages.length;
    emit('chat', { sessionKey: old, runId: 'private-stream', state: 'delta', deltaText: 'PRIVATE-ALICE-LIVE' });
    emit('question.requested', question());
    emit('session.approval', { phase: 'pending', approval: { ...approval(), sourceSessionKey: old } });
    emit('chat', { sessionKey: own, runId: 'own-stream', state: 'delta', deltaText: 'OWN-LIVE' }); await pause(150);
    assert.ok(!JSON.stringify(browserBob.messages).includes('PRIVATE-ALICE'));
    assert.ok(browserBob.messages.slice(startC).some(m => m.deltaText === 'OWN-LIVE'));
    assert.ok(!browserAlice.messages.slice(startJ).some(m => m.deltaText === 'OWN-LIVE'));
  });
  await check('Push subscriptions have one account owner on shared browsers', async () => {
    const sub = { endpoint: 'https://push.invalid/inert-device', keys: { p256dh: 'inert', auth: 'inert' } };
    await api(cookieAlice, '/api/push-sub', sub, 'POST'); await api(cookieBob, '/api/push-sub', sub, 'POST');
    const saved = JSON.parse(fs.readFileSync(path.join(data, 'push-subs.json'))); assert.equal(saved.alice.length, 0); assert.equal(saved.bob.length, 1);
  });
  await check('Real Chrome switches accounts without carrying sessions or drafts across users', async () => {
    for (const [cookie, key] of [[cookieAlice, old], [cookieBob, own]]) {
      const response = await api(cookie, '/api/question', { agent: 'assistant', id: 'question-' + key, answers: { q: ['Yes'] } }, 'POST');
      assert.equal(response.status, 200, 'Owners can resolve their own blocking questions');
    }
    let chromium;
    for (const candidate of ['playwright-core', process.env.PLAYWRIGHT_MODULE, path.join(os.homedir(), '.npm-global/lib/node_modules/openclaw/node_modules/playwright-core')].filter(Boolean)) {
      try { chromium = require(candidate).chromium; break; } catch {}
    }
    assert.ok(chromium, 'An installed playwright-core is required for the user boundary acceptance test');
    const chrome = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || chromium.executablePath(), headless: true });
    let phase = 'open', page;
    try {
      const context = await chrome.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
      page = await context.newPage(); page.setDefaultTimeout(8000);
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      const enter = async user => {
        phase = 'login ' + user;
        await page.locator('#login-user').fill(user); await page.locator('#login-pass').fill(password);
        await page.locator('#login-form button[type=submit]').click();
        await page.waitForFunction(expected => typeof state !== 'undefined' && state.user === expected && state.agent && state.ws?.readyState === 1, user);
      };
      await page.goto(base);
      await page.evaluate(key => {
        localStorage.setItem('hub.pos', JSON.stringify({ agent: 'assistant', key }));
        localStorage.setItem('hub.draft.assistant|' + key, JSON.stringify({ text: 'PRIVATE-ALICE-LEGACY-DRAFT', files: [], t: Date.now() }));
      }, old);
      await enter('alice');
      phase = 'restore Alice legacy session';
      await page.waitForFunction(key => state.current === key && !state.historyLoading, old);
      assert.equal(await page.locator('#input').inputValue(), 'PRIVATE-ALICE-LEGACY-DRAFT');
      await page.locator('#input').fill('PRIVATE-ALICE-BROWSER-DRAFT');
      await page.waitForFunction(() => Object.keys(localStorage).some(key => key.endsWith('.user.alice') && localStorage.getItem(key).includes('PRIVATE-ALICE-BROWSER-DRAFT')));
      await page.locator('#btn-logout').click(); await page.locator('#login-form').waitFor();
      await enter('bob');
      phase = 'open Bob session';
      assert.notEqual(await page.evaluate(() => state.current), old);
      await page.evaluate(key => selectSession(key), own);
      await page.waitForFunction(key => state.current === key && !state.historyLoading, own);
      assert.deepEqual(await page.evaluate(() => state.agents.map(agent => agent.id)), bobAgents);
      assert.ok(await page.locator('[data-agent-id="assistant"]').isVisible(), 'The only authorized agent must remain visible in the Hub');
      await page.setViewportSize({ width: 390, height: 844 });
      await page.locator('#btn-menu').click();
      assert.ok(await page.locator('[data-agent-id="assistant"]').isVisible(), 'Mobile navigation must identify Assistant for Bob');
      await page.locator('[data-agent-id="assistant"]').click();
      // closeNav() traverses browser history asynchronously. Resizing first can
      // schedule its history.back() after page.reload() and abort that request.
      await page.locator('#btn-nav-back').click();
      await page.waitForFunction(() => !history.state?.hubNav && !document.body.classList.contains('nav-open'));
      await page.setViewportSize({ width: 1440, height: 1000 });
      assert.equal(await page.locator('#input').inputValue(), '');
      assert.ok(!(await page.locator('#app').innerText()).includes('PRIVATE-ALICE'));
      phase = 'restore Bob draft';
      await page.locator('#input').fill('OWN-BOB-BROWSER-DRAFT'); await page.reload();
      await page.waitForFunction(key => state.user === 'bob' && state.current === key && !state.historyLoading, own);
      assert.equal(await page.locator('#input').inputValue(), 'OWN-BOB-BROWSER-DRAFT');
      await page.locator('#btn-logout').click(); await page.locator('#login-form').waitFor();
      await enter('alice');
      phase = 'restore Alice draft';
      await page.waitForFunction(key => state.current === key && !state.historyLoading, old);
      assert.equal(await page.locator('#input').inputValue(), 'PRIVATE-ALICE-BROWSER-DRAFT');
      assert.ok(!(await page.locator('#app').innerText()).includes('OWN-BOB-BROWSER-DRAFT'));
      assert.deepEqual(errors, []);
    } catch (error) {
      const state = await page?.evaluate(() => ({ user: window.state?.user || (typeof state !== 'undefined' ? state.user : null), current: typeof state !== 'undefined' ? state.current : null, loading: typeof state !== 'undefined' ? state.historyLoading : null, input: document.querySelector('#input')?.value, login: document.querySelector('#login-error')?.textContent })).catch(() => null);
      throw new Error(phase + ': ' + error.message + ' · ' + JSON.stringify(state));
    } finally { await chrome.close(); }
  });
  await check('Session ownership survives a Hub restart', async () => {
    await stop(); await start(); cookieBob = await login('bob');
    const response = await (await api(cookieBob, '/api/sessions', { agent: 'assistant' })).json(); assert.ok(response.sessions.some(s => s.key === own)); assert.ok(!JSON.stringify(response).includes('PRIVATE-ALICE'));
  });
  await check('Search covers more than 200 owned sessions without violating the native contract', async () => {
    const keys = [];
    try {
      for (let index = 0; index < 201; index++) {
        const response = await api(cookieBob, '/api/sessions', { agent: 'assistant', idempotencyKey: 'batch-search-' + index }, 'POST');
        assert.equal(response.status, 200); keys.push((await response.json()).key);
      }
      const before = requests.length;
      const response = await api(cookieBob, '/api/session-search', { agent: 'assistant', q: 'needle' });
      assert.equal(response.status, 200); assert.equal((await response.json()).results.length, 25);
      const search = requests.slice(before).filter(request => request.method === 'sessions.search');
      assert.equal(search.length, 2); assert.ok(search.every(request => request.params.sessionKeys.length <= 200));
      const selected = new Set(search.flatMap(request => request.params.sessionKeys));
      for (const key of keys) assert.ok(selected.has(key)); assert.ok(selected.has(own)); assert.ok(!selected.has(old));
    } finally { for (const key of keys) rows.delete(key); }
  });
  await check('Shared-only panels keep their previous team access until isolation is configured', async () => {
    const { UserAccess } = require('../lib/user-access.js');
    const directory = path.join(temporary, 'shared-only'); fs.mkdirSync(directory);
    const sharedUsers = [{ u: 'team-a' }, { u: 'team-b' }], link = { id: 'assistant', cfg: {} };
    const access = new UserAccess({ dataDir: directory, users: () => sharedUsers });
    access.recordRows(link, [makeRow(old)]); access.claim('team-a', link, old);
    assert.ok(access.canKnown('team-b', link, old)); assert.ok(access.canUpload('team-b', { owner: 'team-a' }));
    assert.equal(fs.existsSync(path.join(directory, 'session-owners.json')), false);
    sharedUsers.push({ u: 'private', allowedAgents: ['assistant'], sessionScope: 'own' });
    access.claim('private', link, own); assert.equal(access.canKnown('team-a', link, own), false);
    assert.equal(access.canKnown('private', link, old), false); assert.equal(access.canUpload('private', { owner: 'team-a' }), false);
  });
  if (mixed) await check('Mixed scope keeps Gael history and new sessions shared without weakening Assistant', async () => {
    const legacy = await (await api(cookieBob, '/api/sessions', { agent: 'first', fresh: '1' })).json();
    assert.ok(legacy.sessions.some(session => session.key === firstLegacy));
    const response = await api(cookieBob, '/api/sessions', { agent: 'first', label: 'Shared Gael conversation' }, 'POST');
    assert.equal(response.status, 200); const key = (await response.json()).key;
    assert.equal((await api(cookieAlice, '/api/history', { agent: 'first', key })).status, 200);
    const registry = JSON.parse(fs.readFileSync(path.join(data, 'session-owners.json')));
    assert.equal(registry.owners[JSON.stringify(['first', key])], undefined);
    assert.equal((await api(cookieBob, '/api/history', { agent: 'assistant', key: old })).status, 403);
    const fd = new FormData(); fd.append('files', new Blob(['GAEL-SHARED']), 'first.txt');
    const upload = await fetch(base + '/api/upload?' + new URLSearchParams({ agent: 'first', key }), { method: 'POST', headers: { Cookie: cookieBob }, body: fd });
    assert.equal(upload.status, 200); const file = (await upload.json()).files[0];
    assert.equal(await (await api(cookieAlice, '/api/files', { path: 'uploads/' + file.id })).text(), 'GAEL-SHARED');
    assert.equal((await fetch(base + '/api/upload?' + new URLSearchParams({ agent: 'assistant', key: old }), { method: 'POST', headers: { Cookie: cookieBob } })).status, 403);
    const me = await (await api(cookieBob, '/api/me')).json(); assert.deepEqual(me.sessionScopes, { assistant: 'own' });
  });
  if (mixed) await check('Shared native Gateway keeps main and second sessions, search and live events separate', async () => {
    for (const [agent, key, foreign] of [['first', firstLegacy, secondLegacy], ['second', secondLegacy, firstLegacy]]) {
      const response = await api(cookieBob, '/api/sessions', { agent, fresh: '1' });
      assert.equal(response.status, 200); const roster = (await response.json()).sessions;
      assert.ok(roster.some(session => session.key === key), agent + ' retains its native history');
      assert.ok(!roster.some(session => session.key === foreign), agent + ' must not list the other native agent');
      assert.equal((await api(cookieBob, '/api/history', { agent, key })).status, 200);
      assert.equal((await api(cookieBob, '/api/history', { agent, key: foreign })).status, 403);
      const search = await (await api(cookieBob, '/api/session-search', { agent, q: 'needle' })).json();
      assert.ok(search.results.some(hit => hit.sessionKey === key));
      assert.ok(!search.results.some(hit => hit.sessionKey === foreign));
    }
    await until(() => ['first', 'second'].every(agent => requests.some(request =>
      request.agent === agent && request.method === 'sessions.messages.subscribe')), 'each native agent subscribes to its active session');
    for (const [agent, foreign] of [['first', secondLegacy], ['second', firstLegacy]]) {
      assert.ok(!requests.some(request => request.agent === agent && request.method === 'sessions.messages.subscribe'
        && request.params.key === foreign), agent + ' must not subscribe to another native agent active run');
    }
    const client = await connect(cookieBob), offset = client.messages.length;
    for (const [key, marker] of [[firstLegacy, 'GAEL-SHARED-LIVE'], [secondLegacy, 'PLOTI-SHARED-LIVE']]) {
      // Deliver every native event to BOTH links, as a shared Gateway does.
      emit('chat', { sessionKey: key, runId: marker, state: 'delta', deltaText: marker }, ['first', 'second']);
      emit('question.requested', question(key), ['first', 'second']);
      emit('session.approval', { phase: 'pending', approval: { ...approval(key), sourceSessionKey: key } }, ['first', 'second']);
    }
    await until(() => [firstLegacy, secondLegacy].every(key => ['delta', 'question', 'approval'].every(type =>
      client.messages.slice(offset).some(message => message.type === type && message.sessionKey === key))), 'both native agents live events');
    const live = client.messages.slice(offset).filter(message => [firstLegacy, secondLegacy].includes(message.sessionKey));
    for (const [agent, key, foreign] of [['first', firstLegacy, secondLegacy], ['second', secondLegacy, firstLegacy]]) {
      for (const type of ['delta', 'question', 'approval']) {
        assert.ok(live.some(message => message.agentId === agent && message.sessionKey === key && message.type === type));
        assert.ok(!live.some(message => message.agentId === agent && message.sessionKey === foreign), agent + ' must not relabel another agent event');
      }
      const before = requests.length;
      const sent = await wsReply(client, { type: 'send', agentId: agent, sessionKey: foreign, text: 'DO-NOT-CROSS-NATIVE-AGENTS', clientMessageId: 'foreign-' + agent }, 'send_error');
      assert.ok(sent.error);
      assert.ok(!requests.slice(before).some(request => request.method === 'chat.send'));
    }
  });
  await check('Agent scopes and upload provenance fail closed and preserve existing owners', async () => {
    const { UserAccess } = require('../lib/user-access.js');
    const directory = path.join(temporary, 'mixed-scopes'); fs.mkdirSync(directory);
    const users = [{ u: 'alice' }, { u: 'bob', allowedAgents: ['assistant', 'first', 'second'], sessionScopes: { assistant: 'own' } },
      { u: 'sofi', allowedAgents: ['biz'] }];
    const access = new UserAccess({ dataDir: directory, users: () => users });
    const assistant = { id: 'assistant', cfg: {} }, first = { id: 'first', cfg: {} };
    access.recordRows(assistant, [makeRow(old)]); access.recordRows(first, [makeRow(old)]);
    assert.equal(access.canKnown('bob', assistant, old), false); assert.equal(access.canKnown('bob', first, old), true);
    access.claim('bob', first, old); assert.equal(fs.existsSync(access.file), false);
    access.claim('bob', assistant, own); assert.equal(access.canKnown('alice', assistant, own), false);
    assert.equal(access.canUpload('bob', { agents: ['first', 'second'], owner: 'alice' }), true);
    assert.equal(access.canUpload('bob', { agents: ['first'], owner: 'alice' }, 'assistant'), false);
    assert.equal(access.canUpload('bob', { agents: ['assistant'], owner: 'alice' }), false);
    assert.equal(access.canUpload('sofi', { agents: ['first'], owner: 'bob' }), false);
    assert.equal(access.canUpload('sofi', { owner: 'alice' }), false);
    assert.equal(access.canUpload('bob', { agent: 'assistant', owner: 'bob' }), true);
    users[1].sessionScopes = { assistant: 'invalid' }; assert.equal(access.canAgent('bob', 'first'), false);
    assert.equal(access.canUpload('bob', { owner: 'bob' }), false);
    users[1].sessionScopes = {};
    const shared = new UserAccess({ dataDir: path.join(temporary, 'restricted-shared'), users: () => users });
    assert.equal(shared.canUpload('sofi', { owner: 'bob' }), false);
    assert.equal(shared.canUpload('sofi', null), false);
    assert.equal(shared.canUpload('bob', { agents: ['first'], owner: 'alice' }), true);
  });
} finally {
  await stop(); for (const client of sockets) client.socket.terminate(); await new Promise(resolve => gateway.close(resolve));
  fs.rmSync(temporary, { recursive: true, force: true });
}
console.log('RESULT ' + results.filter(Boolean).length + '/' + results.length + ' passed');
process.exitCode = results.every(Boolean) ? 0 : 1;
