// Real Hub + inert Gateway. Never uses a real question, credential or model.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { WebSocket, WebSocketServer } = require('ws');
const repo = process.env.HUB_SOURCE_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-question-contract-'));
const key = 'agent:main:question-contract', markKey = 'agent:mark:question-contract', sid = 'question-transcript';
const requests = [], sockets = new Set(), browsers = new Set(), results = [];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const question = (itemId, index, title = 'Which delivery?') => ({
  role: 'assistant', content: [{ type: 'text', text: 'Optional question with a complete text fallback.' }],
  timestamp: 1700000000000 + index, __openclaw: { id: 'source-' + itemId, seq: index, runId: 'native-run' },
  openclawAsyncDelivery: { itemId, questions: [{ title, options: ['One', 'Two'] }] },
});
const user = (id, index, text, replyToId, extra = {}) => ({
  role: 'user', content: [{ type: 'text', text }], timestamp: 1700000000000 + index,
  __openclaw: { id, seq: index, ...(replyToId ? { replyToId } : {}) }, ...extra,
});
const pending = question('native-pending', 1);
const answered = question('native-answered', 2, 'Already answered?');
const archivedSid = 'archived-question-transcript';
let messages = [pending, answered, user('reply-answered', 3, 'My custom answer', 'source-native-answered'),
  user('unrelated', 4, 'An unrelated follow-up')];
let denied = false, rotated = false, describeCalls = 0, denyAfterDescribe = false;
let sendFailure = false, sendStatus = 'in_flight', sendGate = null, historyFailure = false;
let historySessionId = sid, rotateHistoryOnOlderPage = false;
let backend, logs = '', base, cookie;
const blockingQuestions = (owner = 'main') => [{ id: 'blocking-native', agentId: owner, sessionKey: owner === 'main' ? key : markKey,
  status: 'pending', createdAtMs: 1, expiresAtMs: Date.now() + 900000, questions: [
    { questionId: 'delivery', header: 'Delivery', question: 'Pick a delivery',
      options: [{ label: 'First delivery', value: 'one' }, { label: 'Second delivery', value: 'two', description: 'Second option details' }],
      isOther: false, multiSelect: true, allowEmpty: true, defaultAnswers: ['two'], presentation: 'form' },
    { questionId: 'notes', header: 'Notes', question: 'Optional line entries', options: [], isOther: true,
      multiSelect: true, allowEmpty: true, presentation: 'form', answerFormat: 'lines', defaultAnswers: ['First line', 'Second line'] },
    { questionId: 'freeform', header: 'Free text', question: 'A required written answer', options: [], isOther: false },
  ] }, {
    id: 'blocking-secret', agentId: owner, sessionKey: owner === 'main' ? key : markKey, status: 'pending', createdAtMs: 1,
    expiresAtMs: Date.now() + 900000, questions: [{ questionId: 'credential', header: 'Credential', question: 'Supply the test credential',
      options: [], isOther: false, isSecret: true, secretStore: { name: 'CONTRACT_TEST', kind: 'secret' } }],
  }];
const foreignBlocking = owner => ({ ...blockingQuestions(owner === 'main' ? 'mark' : 'main')[0], id: 'foreign-from-' + (owner === 'main' ? 'mark' : 'main') });

async function check(name, operation) {
  try { await operation(); results.push({ name, ok: true }); console.log('PASS ' + name); }
  catch (error) { results.push({ name, ok: false }); console.log('FAIL ' + name + ': ' + error.message); }
}
async function until(predicate, description, ms = 5000) {
  const deadline = Date.now() + ms;
  do {
    const value = await predicate(); if (value) return value;
    if (backend?.exitCode != null) throw new Error('Hub exited: ' + logs.slice(-1000));
    await pause(20);
  } while (Date.now() < deadline);
  throw new Error('Timeout: ' + description);
}
const gateway = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await once(gateway, 'listening');
const broadcast = (event, payload) => { for (const socket of sockets) socket.send(JSON.stringify({ type: 'event', event, payload })); };
gateway.on('connection', socket => {
  let owner = 'main';
  sockets.add(socket); socket.on('close', () => sockets.delete(socket));
  socket.send(JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { nonce: 'inert-question-contract' } }));
  socket.on('message', raw => {
    const frame = JSON.parse(raw), p = frame.params || {};
    if (frame.method === 'connect') owner = p.auth?.token === 'inert-mark-token' ? 'mark' : 'main';
    requests.push({ method: frame.method, params: p, owner });
    const reply = (payload, error) => socket.send(JSON.stringify({ type: 'res', id: frame.id, ok: !error, ...(error ? { error } : { payload }) }));
    switch (frame.method) {
      case 'connect': return reply({ type: 'hello-ok', protocol: 3, auth: { scopes: p.scopes || [] } });
      case 'models.list': return reply({ models: [] });
      case 'question.list': return reply({ questions: [...blockingQuestions(owner), foreignBlocking(owner)] });
      case 'question.get': {
        const selected = [...blockingQuestions(owner), foreignBlocking(owner)].find(question => question.id === p.id);
        return selected ? reply({ question: selected }) : reply(null, { code: 'NOT_FOUND', message: 'Fixture has no such question' });
      }
      case 'question.resolve': {
        const answers = p.answers?.answers;
        if (!p.cancel && (!answers || Object.values(answers).some(value => !Array.isArray(value) || value.some(item => typeof item !== 'string' || item.length === 0))
            || (Object.hasOwn(answers, 'freeform') && !answers.freeform.length))) {
          return reply(null, { code: 'INVALID_REQUEST', message: 'Native validation rejects missing required answer' });
        }
        return reply({ id: p.id, status: p.cancel ? 'cancelled' : 'answered' });
      }
      case 'exec.approval.list': case 'plugin.approval.list': return reply([]);
      case 'sessions.messages.subscribe': return p.key === 'agent:main:denied-live'
        ? reply(null, { code: 'FORBIDDEN', message: 'Fixture denies subscription' }) : reply({ subscriptionId: 'question-fixture' });
      case 'sessions.describe': {
        describeCalls++;
        if (denied || (denyAfterDescribe && describeCalls > 1) || p.key === 'agent:main:denied') return reply(null, { code: 'FORBIDDEN', message: 'Fixture denies session' });
        return reply({ session: { key: p.key, agentId: owner, sessionId: rotated && describeCalls > 1 ? 'new-transcript' : sid, hasActiveRun: true } });
      }
      case 'chat.history': {
        // These selector constraints live in the installed handler, not only
        // its JSON schema. Keep the inert Gateway as strict as the real one.
        if (p.offset !== undefined && p.messageId !== undefined) return reply(null, { code: 'INVALID_REQUEST', message: 'offset and messageId cannot be used together' });
        if (p.cursor !== undefined && (p.offset !== undefined || p.messageId !== undefined)) return reply(null, { code: 'INVALID_REQUEST', message: 'cursor cannot be used with offset or messageId' });
        if (p.sessionId !== undefined && p.messageId === undefined) return reply(null, { code: 'INVALID_REQUEST', message: 'sessionId requires messageId' });
        if (historyFailure) return reply(null, { code: 'FORBIDDEN', message: 'Fixture denies history' });
        if (p.messageId && p.sessionId === archivedSid) return reply({ messages: [pending], sessionId: archivedSid, offset: 0, hasMore: false, nextOffset: null, totalMessages: 1 });
        const offset = p.offset || 0, end = Math.max(0, messages.length - offset), start = Math.max(0, end - (p.limit || 100));
        return reply({ messages: messages.slice(start, end), sessionId: rotateHistoryOnOlderPage && offset > 0 ? 'new-transcript' : historySessionId,
          offset, hasMore: start > 0, nextOffset: start ? offset + end - start : null, totalMessages: messages.length });
      }
      case 'chat.send': {
        if (sendFailure) return reply(null, { code: 'UNAVAILABLE', message: 'Fixture rejects answer' });
        const allowed = new Set(['sessionKey', 'agentId', 'sessionId', 'message', 'deliver', 'queueMode', 'replyToId', 'idempotencyKey']);
        if (Object.keys(p).some(name => !allowed.has(name))) return reply(null, { code: 'INVALID_REQUEST', message: 'Not a native chat.send field' });
        if (sendGate) { sendGate.then(() => reply({ runId: 'accepted-answer', status: sendStatus })); return; }
        return reply({ runId: 'accepted-answer', status: sendStatus });
      }
      default: return reply({});
    }
  });
});
async function api(route, body, authenticated = true) {
  const response = await fetch(base + route, { headers: { ...(authenticated ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
  let result; try { result = await response.json(); } catch { result = null; }
  return { status: response.status, body: result };
}
const countSends = () => requests.filter(request => request.method === 'chat.send').length;
try {
  const salt = crypto.randomBytes(16).toString('hex'), password = crypto.randomBytes(24).toString('base64url');
  fs.writeFileSync(path.join(temporary, 'users.json'), JSON.stringify([{ u: 'contract', pw: `scrypt$${salt}$${crypto.scryptSync(password, salt, 64).toString('hex')}` }]), { mode: 0o600 });
  fs.writeFileSync(path.join(temporary, 'notify.json'), JSON.stringify({ enabled: false }));
  fs.writeFileSync(path.join(temporary, 'agents.json'), JSON.stringify([
    { id: 'bu', gatewayAgentId: 'main', url: `ws://127.0.0.1:${gateway.address().port}`, token: 'inert-main-token' },
    { id: 'mark', gatewayAgentId: 'mark', url: `ws://127.0.0.1:${gateway.address().port}`, token: 'inert-mark-token' },
  ]));
  const listener = http.createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve)); base = 'http://127.0.0.1:' + port;
  backend = spawn(process.execPath, [path.join(repo, 'server.js')], { cwd: repo, env: { ...process.env, PORT: String(port), BIND: '127.0.0.1', DATA_DIR: temporary }, stdio: ['ignore', 'pipe', 'pipe'] });
  backend.stdout.on('data', chunk => { logs += chunk; }); backend.stderr.on('data', chunk => { logs += chunk; });
  await until(async () => { try { return (await fetch(base + '/api/branding')).ok; } catch { return false; } }, 'Hub starts');
  const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ u: 'contract', p: password }) });
  cookie = login.headers.get('set-cookie')?.split(';')[0]; assert(cookie);
  const socket = new WebSocket(base.replace('http:', 'ws:') + '/ws', { origin: base, headers: { Cookie: cookie } }), received = [];
  browsers.add(socket); socket.on('message', raw => received.push(JSON.parse(raw))); await once(socket, 'open');
  await until(() => ['bu', 'mark'].every(agent => received.some(message => message.type === 'question' && message.agentId === agent)), 'native multi-agent blocking replay');
  const blocking = () => received.find(message => message.type === 'question' && message.agentId === 'bu' && message.id === 'blocking-native');
  await check('blocking option values survive normalization independently of captions', () => {
    const q = blocking().questions[0];
    assert.deepEqual(q.options.map(option => option.reply), ['one', 'two']);
    assert.equal(q.options[1].value, 'two'); assert.equal(q.options[1].description, 'Second option details');
  });
  await check('blocking choice restrictions and form defaults survive normalization', () => {
    const q = blocking().questions[0];
    assert.equal(q.isOther, false); assert.equal(q.multiSelect, true); assert.equal(q.allowEmpty, true); assert.equal(q.presentation, 'form'); assert.deepEqual(q.defaultAnswers, ['two']);
    const lines = blocking().questions[1];
    assert.equal(lines.answerFormat, 'lines'); assert.equal(lines.isOther, true); assert.equal(lines.multiSelect, true); assert.deepEqual(lines.defaultAnswers, ['First line', 'Second line']);
    assert.equal(blocking().questions[2].options.length, 0); assert.equal(blocking().questions[2].allowEmpty, false);
  });
  await check('gateway-scoped question IDs retain both distinct agent identities', () => {
    assert(received.some(message => message.type === 'question' && message.agentId === 'bu' && message.id === 'blocking-native' && message.sessionKey === key));
    assert(received.some(message => message.type === 'question' && message.agentId === 'mark' && message.id === 'blocking-native' && message.sessionKey === markKey));
  });
  await check('a global native question list never clones a foreign agent question into this panel link', () => {
    assert(!received.some(message => message.type === 'question' && message.agentId === 'bu' && message.id === 'foreign-from-mark'));
    assert(!received.some(message => message.type === 'question' && message.agentId === 'mark' && message.id === 'foreign-from-main'));
  });
  await check('a guessed blocking question from another agent cannot be resolved through this link', async () => {
    const count = requests.filter(request => request.method === 'question.resolve').length;
    const response = await api('/api/question', { agent: 'bu', id: 'foreign-from-mark', answers: { delivery: ['two'] } });
    assert.equal(response.status, 403); assert.equal(requests.filter(request => request.method === 'question.resolve').length, count);
  });
  await check('blocking allowEmpty uses the real double-nested empty answer list', async () => {
    const result = await api('/api/question', { agent: 'bu', id: 'blocking-native', answers: { delivery: [], notes: [], freeform: ['Written response'] } });
    assert.equal(result.status, 200); assert.equal(result.body.status, 'answered');
    const sent = requests.findLast(request => request.method === 'question.resolve');
    assert.deepEqual(sent.params.answers, { answers: { delivery: [], notes: [], freeform: ['Written response'] } });
    assert.equal(sent.owner, 'main');
  });
  await check('blocking required-empty rejection remains a recoverable error', async () => {
    const result = await api('/api/question', { agent: 'bu', id: 'blocking-native', answers: { freeform: [] } });
    assert(result.status >= 400); assert.equal(result.body.diagnostic.code, 'INVALID_REQUEST');
  });
  await check('explicit empty form lines reach native validation instead of disappearing', async () => {
    const result = await api('/api/question', { agent: 'bu', id: 'blocking-native', answers: { delivery: [], notes: ['First', '', 'Last'], freeform: ['Written response'] } });
    assert(result.status >= 400); assert.deepEqual(requests.findLast(request => request.method === 'question.resolve').params.answers.answers.notes, ['First', '', 'Last']);
  });
  await check('blocking response never falls back to an unrelated configured agent', async () => {
    const count = requests.filter(request => request.method === 'question.resolve').length;
    assert.equal((await api('/api/question', { agent: 'invented', id: 'blocking-native', answers: { delivery: ['two'] } })).status, 400);
    assert.equal((await api('/api/question', { id: 'blocking-native', cancel: true })).status, 400);
    assert.equal(requests.filter(request => request.method === 'question.resolve').length, count);
  });
  await check('blocking secret flags survive and secret answer bytes are not trimmed', async () => {
    const q = received.find(message => message.type === 'question' && message.agentId === 'bu' && message.id === 'blocking-secret').questions[0];
    assert.equal(q.isSecret, true); assert(!Object.hasOwn(q, 'defaultAnswers'));
    const result = await api('/api/question', { agent: 'bu', id: 'blocking-secret', answers: { credential: ['  inert test input  '] } });
    assert.equal(result.status, 200);
    assert.deepEqual(requests.findLast(request => request.method === 'question.resolve').params.answers.answers.credential, ['  inert test input  ']);
    assert.equal((await api('/api/question', { agent: 'bu', id: 'blocking-secret', answers: { credential: ['   '] } })).status, 200);
    assert.deepEqual(requests.findLast(request => request.method === 'question.resolve').params.answers.answers.credential, ['   ']);
  });
  broadcast('question.requested', { ...foreignBlocking('main'), id: 'global-mark-live' });
  await until(() => received.some(message => message.type === 'question' && message.id === 'global-mark-live'), 'global blocking event');
  await check('global blocking requested events are attributed only to their native gateway agent', () => {
    const events = received.filter(message => message.type === 'question' && message.id === 'global-mark-live');
    assert.equal(events.length, 1); assert.equal(events[0].agentId, 'mark');
  });
  broadcast('question.resolved', { id: 'global-mark-live', status: 'answered' });
  await until(() => received.some(message => message.type === 'question' && message.id === 'global-mark-live' && message.phase === 'resolved'), 'minimal global blocking resolution');
  await check('minimal global resolved events remove only a previously owned card', () => {
    const events = received.filter(message => message.type === 'question' && message.id === 'global-mark-live' && message.phase === 'resolved');
    assert.equal(events.length, 1); assert.equal(events[0].agentId, 'mark');
  });
  const query = '?' + new URLSearchParams({ agent: 'bu', key });
  await check('paged history preserves async question identity and non-blocking semantics', async () => {
    const result = await api('/api/history-page' + query), q = result.body?.messages.find(message => message.id === 'source-native-pending')?.asyncQuestion;
    assert.equal(result.status, 200); assert.equal(q?.itemId, 'native-pending'); assert.equal(q.nonBlocking, true); assert.equal(q.sourceMessageId, 'source-native-pending'); assert.equal(q.answered, false);
    assert.equal(q.sourceSessionId, sid); assert.equal(q.answerable, true);
  });
  await check('legacy history keeps stable message identity and async question', async () => {
    const result = await api('/api/history' + query), q = result.body?.messages.find(message => message.id === 'source-native-pending')?.asyncQuestion;
    assert.equal(q?.itemId, 'native-pending'); assert.equal(q.sourceSessionId, sid); assert.equal(q.answerable, true);
  });
  await check('reload recognizes only a canonical answer linked to the source', async () => {
    const result = await api('/api/history-page' + query), q = result.body.messages.find(message => message.id === 'source-native-answered')?.asyncQuestion;
    assert.equal(q?.answered, true); assert.equal(q.answerMessageId, 'reply-answered'); assert.equal(q.answerable, false);
  });
  await check('an archived search question stays unanswered but explicitly non-answerable', async () => {
    const result = await api('/api/history-page' + query + '&' + new URLSearchParams({ messageId: 'source-native-pending', sessionId: archivedSid }));
    const q = result.body.messages[0].asyncQuestion;
    assert.equal(result.status, 200); assert.equal(result.body.historical, true); assert.equal(q.answered, false); assert.equal(q.answerable, false); assert.equal(q.sourceSessionId, archivedSid);
  });
  socket.send(JSON.stringify({ type: 'watch', agentId: 'bu', sessionKey: key }));
  await until(() => requests.some(request => request.method === 'sessions.messages.subscribe'), 'session subscription');
  const live = question('live-native', 10);
  delete live.__openclaw;
  broadcast('session.message', { sessionKey: key, sessionId: sid, messageId: 'source-live-native', messageSeq: 10, message: live });
  await pause(100);
  await check('live native async question reaches the watching browser', () => {
    const event = received.find(message => message.type === 'async_question' && message.asyncQuestion?.itemId === 'live-native');
    assert.equal(event?.sessionKey, key); assert.equal(event.asyncQuestion.nonBlocking, true); assert.equal(event.asyncQuestion.sourceMessageId, 'source-live-native'); assert.equal(event.asyncQuestion.sourceMessageSeq, 10); assert.equal(event.asyncQuestion.sourceSessionId, sid); assert.equal(event.asyncQuestion.answerable, true); assert(!JSON.stringify(event).includes('complete text fallback'));
  });
  broadcast('session.message', { agentId: 'main', sessionKey: key, sessionId: sid,
    message: user('live-unrelated', 11, 'Unrelated text') });
  await pause(60);
  await check('an unrelated live user message does not resolve an optional question', () => assert(!received.some(message => message.type === 'async_question' && message.asyncQuestion?.itemId === 'live-native' && message.asyncQuestion.answered)));
  broadcast('session.message', { agentId: 'main', sessionKey: key, sessionId: sid,
    message: user('live-answer', 12, 'A linked answer', 'source-live-native') });
  await check('a canonical live linked answer projects an answered update without its text', async () => {
    await until(() => received.some(message => message.type === 'async_question' && message.asyncQuestion?.itemId === 'live-native' && message.asyncQuestion.answered), 'live native answer');
    const event = received.findLast(message => message.type === 'async_question' && message.asyncQuestion?.itemId === 'live-native');
    assert.equal(event.asyncQuestion.answered, true); assert.equal(event.asyncQuestion.answerMessageId, 'live-answer'); assert.equal(event.asyncQuestion.answerable, false); assert(!JSON.stringify(event).includes('A linked answer'));
  });
  broadcast('session.message', { agentId: 'main', sessionKey: key, sessionId: archivedSid, message: question('live-archive', 16) });
  await check('a late native event from an archived transcript cannot become an active question', async () => {
    await until(() => received.some(message => message.type === 'async_question' && message.asyncQuestion?.itemId === 'live-archive'), 'archived live projection');
    const event = received.findLast(message => message.type === 'async_question' && message.asyncQuestion?.itemId === 'live-archive');
    assert.equal(event.asyncQuestion.sourceSessionId, archivedSid); assert.equal(event.asyncQuestion.answerable, false); assert.equal(event.asyncQuestion.answered, false);
  });
  broadcast('session.message', { sessionKey: 'agent:other:private', sessionId: 'other', message: question('private-native', 11) });
  await pause(60);
  await check('unwatched and cross-agent questions never leak into browser events', () => assert(!received.some(message => message.type === 'async_question' && message.asyncQuestion?.itemId === 'private-native')));
  socket.send(JSON.stringify({ type: 'watch', agentId: 'bu', sessionKey: 'agent:main:denied-live' }));
  await until(() => requests.some(request => request.method === 'sessions.messages.subscribe' && request.params.key === 'agent:main:denied-live'), 'denied session subscription');
  await pause(30);
  broadcast('session.message', { agentId: 'main', sessionKey: 'agent:main:denied-live', sessionId: sid, message: question('denied-native', 13) });
  broadcast('session.message', { agentId: 'mark', sessionKey: key, sessionId: sid, message: question('wrong-owner-native', 14) });
  await pause(60);
  await check('rejected native subscriptions and conflicting agent metadata do not expose questions', () => assert(!received.some(message => message.type === 'async_question' && ['denied-native', 'wrong-owner-native'].includes(message.asyncQuestion?.itemId))));
  socket.send(JSON.stringify({ type: 'watch', agentId: 'mark', sessionKey: markKey }));
  await until(() => requests.some(request => request.method === 'sessions.messages.subscribe' && request.owner === 'mark' && request.params.key === markKey), 'second gateway agent subscription');
  await pause(30);
  broadcast('session.message', { agentId: 'mark', sessionKey: markKey, sessionId: sid, message: question('mark-live', 15) });
  await check('native question events on a shared gateway retain only their owning panel agent', async () => {
    await until(() => received.some(message => message.type === 'async_question' && message.asyncQuestion?.itemId === 'mark-live'), 'second agent question');
    const events = received.filter(message => message.type === 'async_question' && message.asyncQuestion?.itemId === 'mark-live');
    assert.equal(events.length, 1); assert.equal(events[0].agentId, 'mark'); assert.equal(events[0].sessionKey, markKey);
  });
  const responseBody = { agent: 'bu', key, itemId: 'native-pending', sourceSessionId: sid, answers: ['Two'] };
  await check('async answer endpoint requires authentication', async () => assert.equal((await api('/api/async-question', responseBody, false)).status, 401));
  await check('async reply requires explicit transcript identity and never redirects an archived question', async () => {
    const count = countSends(), missing = { ...responseBody }; delete missing.sourceSessionId;
    assert.equal((await api('/api/async-question', missing)).status, 400);
    const archived = await api('/api/async-question', { ...responseBody, sourceSessionId: archivedSid });
    assert.equal(archived.status, 409); assert.equal(archived.body.code, 'SESSION_CHANGED'); assert.equal(countSends(), count);
  });
  const unanchored = question('native-unanchored', 17); delete unanchored.__openclaw; messages.push(unanchored);
  await check('a missing canonical native anchor stays visible but cannot admit an invented reply', async () => {
    const history = await api('/api/history-page' + query), q = history.body.messages.find(message => message.asyncQuestion?.itemId === 'native-unanchored')?.asyncQuestion;
    assert.equal(q?.answered, false); assert.equal(q.answerable, false); assert.equal(q.sourceSessionId, sid); assert(!Object.hasOwn(q, 'sourceMessageId'));
    const count = countSends(), result = await api('/api/async-question', { ...responseBody, itemId: 'native-unanchored', sourceMessageId: 'client-invented-anchor' });
    assert.equal(result.status, 409); assert.equal(result.body.code, 'QUESTION_UNANCHORED'); assert.equal(countSends(), count);
  });
  await check('async answer rejects invented question identity without sending', async () => {
    const count = countSends(), result = await api('/api/async-question', { ...responseBody, itemId: 'invented' });
    assert.equal(result.status, 404); assert.equal(countSends(), count);
  });
  await check('async answer checks agent and session scope before sending', async () => {
    const count = countSends();
    assert.equal((await api('/api/async-question', { ...responseBody, key: 'agent:other:hidden' })).status, 403);
    assert.equal((await api('/api/async-question', { ...responseBody, agent: 'invented-agent' })).status, 400);
    assert.equal((await api('/api/async-question', { ...responseBody, key: 'agent:main:denied' })).status, 403);
    assert.equal(countSends(), count);
  });
  await check('async answer rejects malformed answer cardinality', async () => assert.equal((await api('/api/async-question', { ...responseBody, answers: [] })).status, 400));
  await check('async answer rejects an extra answer rather than silently dropping it', async () => assert.equal((await api('/api/async-question', { ...responseBody, answers: ['One', 'Unexpected second answer'] })).status, 400));
  await check('confirmed transcript answer is idempotent and never re-sent', async () => {
    const count = countSends(), result = await api('/api/async-question', { ...responseBody, itemId: 'native-answered' });
    assert.equal(result.status, 200); assert.equal(result.body.status, 'answered'); assert.equal(countSends(), count);
  });
  await check('explicit async answer uses the native quoted text, steer and reply anchor', async () => {
    const result = await api('/api/async-question', { ...responseBody, sourceMessageId: 'forged-source', queueMode: 'interrupt' });
    assert.equal(result.status, 200); assert.equal(result.body.runId, 'accepted-answer'); assert.equal(result.body.sourceSessionId, sid);
    const sent = requests.findLast(request => request.method === 'chat.send').params;
    assert.equal(sent.message, '> Which delivery?\n\nTwo'); assert.equal(sent.replyToId, 'source-native-pending'); assert.equal(sent.queueMode, 'steer'); assert.equal(sent.deliver, false); assert.equal(sent.sessionId, sid);
    assert(!Object.hasOwn(sent, 'asyncQuestionItemId')); assert(!Object.hasOwn(sent, 'followUpMode'));
  });
  await check('current transcript verification never combines offset history with archived selectors', () => {
    const reads = requests.filter(request => request.method === 'chat.history' && request.params.limit === 200 && request.params.agentId !== undefined);
    assert(reads.length > 0);
    for (const { params } of reads) {
      assert.equal(params.agentId, params.sessionKey.startsWith('agent:mark:') ? 'mark' : 'main');
      assert(!Object.hasOwn(params, 'sessionId')); assert(!Object.hasOwn(params, 'messageId')); assert(!Object.hasOwn(params, 'cursor'));
    }
  });
  await check('retry of acknowledged async answer does not create a second admission', async () => {
    const count = countSends(), first = requests.findLast(request => request.method === 'chat.send')?.params.idempotencyKey;
    const result = await api('/api/async-question', responseBody); assert.equal(result.status, 200);
    assert(countSends() === count || requests.findLast(request => request.method === 'chat.send').params.idempotencyKey === first);
  });
  await check('a changed answer after acknowledgement is rejected without a second send', async () => {
    const count = countSends(); assert.equal((await api('/api/async-question', { ...responseBody, answers: ['One'] })).status, 409); assert.equal(countSends(), count);
  });
  await check('the same native item ID on another gateway agent has a distinct verified reply scope', async () => {
    const previous = requests.findLast(request => request.method === 'chat.send').params.idempotencyKey;
    const result = await api('/api/async-question', { ...responseBody, agent: 'mark', key: markKey });
    assert.equal(result.status, 200); const sent = requests.findLast(request => request.method === 'chat.send');
    assert.equal(sent.owner, 'mark'); assert.equal(sent.params.agentId, 'mark'); assert.equal(sent.params.sessionKey, markKey); assert.notEqual(sent.params.idempotencyKey, previous);
  });
  await check('paged history retains a later linked answer when the older question is loaded', async () => {
    const original = messages;
    try {
      messages = [question('older-answered', 1), question('older-pending', 2), ...Array.from({ length: 220 }, (_, index) => user('filler-' + index, index + 3, 'Ordinary filler')),
        user('older-answer', 223, 'Answer on the newest page', 'source-older-answered')];
      const latest = await api('/api/history-page' + query); assert.equal(latest.status, 200); assert(!latest.body.messages.some(message => message.asyncQuestion));
      const older = await api('/api/history-page' + query + '&offset=200');
      assert.equal(older.body.messages.find(message => message.id === 'source-older-answered')?.asyncQuestion?.answered, true);
      assert.equal(older.body.messages.find(message => message.id === 'source-older-pending')?.asyncQuestion?.answered, false);
      const count = countSends(), result = await api('/api/async-question', { ...responseBody, itemId: 'older-answered' });
      assert.equal(result.body.alreadyAnswered, true); assert.equal(countSends(), count);
      const sent = await api('/api/async-question', { ...responseBody, itemId: 'older-pending', answers: ['Free-form answer despite suggested options'] });
      assert.equal(sent.status, 200); assert.equal(requests.findLast(request => request.method === 'chat.send').params.replyToId, 'source-older-pending');
    } finally { messages = original; }
  });
  messages.push(question('native-concurrent', 18, 'Concurrent answer?'));
  await check('simultaneous identical replies share one admission while conflicting replies fail', async () => {
    const count = countSends(); let release;
    sendGate = new Promise(resolve => { release = resolve; });
    const body = { ...responseBody, itemId: 'native-concurrent' }, first = api('/api/async-question', body), second = api('/api/async-question', body);
    try {
      await until(() => countSends() > count, 'held concurrent admission'); await pause(40);
      const conflict = await api('/api/async-question', { ...body, answers: ['Different answer'] });
      assert.equal(conflict.status, 409); assert.equal(countSends(), count + 1);
    } finally { release(); sendGate = null; }
    const responses = await Promise.all([first, second]); assert(responses.every(response => response.status === 200)); assert.equal(countSends(), count + 1);
  });
  messages.push(question('native-failure', 20, 'Can this fail?')); sendFailure = true;
  await check('gateway rejection is never reported as an answered question', async () => {
    const result = await api('/api/async-question', { ...responseBody, itemId: 'native-failure' }); assert(result.status >= 400); assert.notEqual(result.body?.status, 'answered');
  }); sendFailure = false;
  await check('an unconfirmed response cannot be replaced by different text under the same native idempotency key', async () => {
    const count = countSends(), result = await api('/api/async-question', { ...responseBody, itemId: 'native-failure', answers: ['Changed after uncertainty'] });
    assert.equal(result.status, 409); assert.equal(result.body.code, 'ANSWER_UNCONFIRMED'); assert.equal(countSends(), count);
  });
  await check('retry after uncertainty reuses the exact native idempotency key', async () => {
    const first = requests.findLast(request => request.method === 'chat.send').params.idempotencyKey;
    const result = await api('/api/async-question', { ...responseBody, itemId: 'native-failure' });
    assert.equal(result.status, 200); assert.equal(requests.findLast(request => request.method === 'chat.send').params.idempotencyKey, first);
  });
  messages.push(question('native-status-error', 21, 'Accepted envelope but failed status?')); sendStatus = 'error';
  await check('a native error status inside an OK envelope is not reported as accepted', async () => {
    const result = await api('/api/async-question', { ...responseBody, itemId: 'native-status-error' }); assert(result.status >= 400); assert.notEqual(result.body?.ok, true);
  }); sendStatus = 'in_flight';
  describeCalls = 0; denyAfterDescribe = true;
  await check('permission revocation during answer validation prevents admission', async () => {
    const count = countSends(), result = await api('/api/async-question', { ...responseBody, itemId: 'native-status-error' });
    assert.equal(result.status, 403); assert.equal(countSends(), count);
  }); denyAfterDescribe = false;
  historyFailure = true;
  await check('history visibility failure cannot fall back to a cached optional question', async () => {
    const count = countSends(), result = await api('/api/async-question', responseBody); assert.equal(result.status, 403); assert.equal(countSends(), count);
  }); historyFailure = false;
  describeCalls = 0; rotated = true;
  await check('session reset during validation cancels the answer before mutation', async () => {
    const count = countSends(), result = await api('/api/async-question', { ...responseBody, itemId: 'native-failure' });
    assert.equal(result.status, 409); assert.equal(countSends(), count);
  }); rotated = false;
  await check('history without transcript identity cannot validate an optional answer', async () => {
    const count = countSends(); historySessionId = undefined;
    try {
      const result = await api('/api/async-question', { ...responseBody, itemId: 'native-pending' });
      assert.equal(result.status, 409); assert.equal(result.body.code, 'SESSION_CHANGED'); assert.equal(countSends(), count);
    } finally { historySessionId = sid; }
  });
  await check('a reset before the first current history page cannot reuse an old receipt', async () => {
    const count = countSends(); historySessionId = 'new-transcript';
    try {
      const result = await api('/api/async-question', responseBody);
      assert.equal(result.status, 409); assert.equal(result.body.code, 'SESSION_CHANGED'); assert.equal(countSends(), count);
    } finally { historySessionId = sid; }
  });
  await check('a reset between current offset pages prevents mixing transcript questions and answers', async () => {
    const original = messages, count = countSends(), readCount = requests.filter(request => request.method === 'chat.history').length;
    messages = [question('reset-between-pages', 1), ...Array.from({ length: 220 }, (_, index) => user('reset-filler-' + index, index + 2, 'Ordinary filler'))];
    rotateHistoryOnOlderPage = true;
    try {
      const result = await api('/api/async-question', { ...responseBody, itemId: 'reset-between-pages' });
      assert.equal(result.status, 409); assert.equal(result.body.code, 'SESSION_CHANGED'); assert.equal(countSends(), count);
      const reads = requests.filter(request => request.method === 'chat.history').slice(readCount);
      assert.equal(reads.length, 2); assert.equal(reads[1].params.offset, 200);
      assert(reads.every(request => !Object.hasOwn(request.params, 'sessionId') && !Object.hasOwn(request.params, 'messageId')));
    } finally { messages = original; rotateHistoryOnOlderPage = false; }
  });
  let contract;
  try { contract = require(path.join(repo, 'lib/agent-questions.js')); } catch {}
  await check('async formatter truncates UTF-8 titles without splitting code points', () => {
    assert(contract); const formatted = contract.formatAsyncAnswer({ questions: [{ title: '🐝'.repeat(129) + '\nOther' }] }, ['Yes']);
    assert.equal(formatted.split('\n\n')[0], '> ' + '🐝'.repeat(128));
  });
  await check('unlinked imported or internal user rows do not resolve questions', () => {
    assert(contract);
    const raw = [question('untrusted-reply', 1), user('import', 2, 'Reply', 'source-untrusted-reply', { provenance: { kind: 'inter_session' } })];
    assert.equal(contract.projectAsyncQuestions(raw).get('untrusted-reply').answered, false);
  });
  await check('canonical quoted replies without an anchor resolve only one unambiguous question', () => {
    assert(contract);
    const q = question('quoted', 1), text = contract.formatAsyncAnswer(contract.readAsyncQuestion(q), ['Custom text']);
    assert.equal(contract.projectAsyncQuestions([q, user('quoted-answer', 2, text)]).get('quoted').answered, true);
    const ambiguous = contract.projectAsyncQuestions([q, question('same-title', 2), user('ambiguous-answer', 3, text)]);
    assert.equal(ambiguous.get('quoted').answered, false); assert.equal(ambiguous.get('same-title').answered, false);
    assert.equal(contract.projectAsyncQuestions([q, user('wrong-anchor', 2, text, 'unrelated-source')]).get('quoted').answered, false);
  });
  await check('a newer-page canonical quoted reply settles its older-page question without an anchor', () => {
    const tracker = new contract.AsyncQuestionTracker(), q = question('quoted-paged', 1);
    const text = contract.formatAsyncAnswer(contract.readAsyncQuestion(q), ['A valid quoted response']);
    const reply = user('quoted-paged-answer', 3, text);
    tracker.observe(key, [reply], sid);
    assert.equal(tracker.observe(key, [q], sid).questions.get('quoted-paged').answered, false);
    assert.equal(tracker.needsQuotedRecovery(key, sid), true);
    const result = tracker.observe(key, [q, reply], sid, { completeHistory: true }).questions.get('quoted-paged');
    assert.equal(result.answered, true); assert.equal(result.answerMessageId, 'quoted-paged-answer');
    assert.equal(tracker.needsQuotedRecovery(key, sid), false);
    assert.equal(tracker.observe(key, [q], 'different-transcript').questions.get('quoted-paged').answered, false);
    assert.equal(tracker.observe(markKey, [q], sid).questions.get('quoted-paged').answered, false);
  });
  await check('three newest-first pages never provisionally confirm an ambiguous quoted answer', () => {
    const tracker = new contract.AsyncQuestionTracker();
    const first = question('quoted-three-first', 1), second = question('quoted-three-second', 8);
    const reply = user('quoted-three-answer', 10, contract.formatAsyncAnswer(contract.readAsyncQuestion(first), ['Quoted response']));
    tracker.observe(key, [reply], sid);
    assert.equal(tracker.observe(key, [second], sid).questions.get('quoted-three-second').answered, false);
    const partial = tracker.observe(key, [first], sid).questions;
    assert.equal(partial.get('quoted-three-first').answered, false); assert.equal(partial.get('quoted-three-second').answered, false);
    const complete = tracker.observe(key, [first, second, reply], sid, { completeHistory: true }).questions;
    assert.equal(complete.get('quoted-three-first').answered, false); assert.equal(complete.get('quoted-three-second').answered, false);
  });
  await check('a complete old scan cannot legitimize a later unanchored quote without fresh coverage', () => {
    const tracker = new contract.AsyncQuestionTracker(), first = question('quoted-watermark-first', 1);
    const firstReply = user('quoted-watermark-first-answer', 2, contract.formatAsyncAnswer(contract.readAsyncQuestion(first), ['First response']));
    assert.equal(tracker.observe(key, [first, firstReply], sid, { completeHistory: true }).questions.get('quoted-watermark-first').answered, true);
    const second = question('quoted-watermark-second', 8);
    const secondReply = user('quoted-watermark-second-answer', 10, contract.formatAsyncAnswer(contract.readAsyncQuestion(second), ['Second response']));
    assert.equal(tracker.observe(key, [second, secondReply], sid).questions.get('quoted-watermark-second').answered, false);
    assert.equal(tracker.needsQuotedRecovery(key, sid), true);
    assert.equal(tracker.observe(key, [first, firstReply, second, secondReply], sid, { completeHistory: true }).questions.get('quoted-watermark-second').answered, true);
  });
  await check('pruning older question cards cannot turn a verified ambiguous quote into an answer', () => {
    const tracker = new contract.AsyncQuestionTracker();
    const first = question('quoted-pruned-first', 1), second = question('quoted-pruned-second', 201);
    const between = Array.from({ length: 199 }, (_, index) => question('quoted-pruned-other-' + index, index + 2, 'Distinct question ' + index));
    const reply = user('quoted-pruned-answer', 202, contract.formatAsyncAnswer(contract.readAsyncQuestion(first), ['Ambiguous response']));
    const complete = tracker.observe(key, [first, ...between, second, reply], sid, { completeHistory: true }).questions;
    assert.equal(complete.size, 200); assert.equal(complete.has('quoted-pruned-first'), false);
    assert.equal(complete.get('quoted-pruned-second').answered, false);
    assert.equal(tracker.needsQuotedRecovery(key, sid), false);
    const later = tracker.observe(key, [question('quoted-pruned-later', 203, 'A new distinct title')], sid).questions;
    assert.equal(later.get('quoted-pruned-second').answered, false);
    tracker.observe(key, Array.from({ length: 400 }, (_, index) => user('quoted-pruned-unrelated-' + index, index + 204,
      '> Unrelated quote ' + index + '\n\nOrdinary text')), sid);
    assert.equal(tracker.needsQuotedRecovery(key, sid), false, 'Ordinary unrelated quotes do not trigger full scans');
    const reloaded = tracker.observe(key, [reply], sid).questions;
    assert.equal(reloaded.get('quoted-pruned-second').answered, false);
    assert.equal(tracker.needsQuotedRecovery(key, sid), true, 'Evicted ambiguity requires fresh complete evidence');
  });
  await check('cached quoted replies cannot resolve ambiguous, imported or wrong-anchor questions', () => {
    const q = question('quoted-cache-safe', 1), text = contract.formatAsyncAnswer(contract.readAsyncQuestion(q), ['Quoted response']);
    const ambiguous = new contract.AsyncQuestionTracker();
    ambiguous.observe(key, [user('ambiguous-paged-answer', 3, text)], sid);
    const found = ambiguous.observe(key, [q, question('quoted-cache-duplicate', 2)], sid).questions;
    assert.equal(found.get('quoted-cache-safe').answered, false); assert.equal(found.get('quoted-cache-duplicate').answered, false);
    for (const extra of [{ provenance: { kind: 'inter_session' } }, { isHeartbeat: true }]) {
      const tracker = new contract.AsyncQuestionTracker();
      tracker.observe(key, [user('untrusted-quoted-answer', 3, text, undefined, extra)], sid);
      assert.equal(tracker.observe(key, [q], sid).questions.get('quoted-cache-safe').answered, false);
    }
    const anchored = new contract.AsyncQuestionTracker();
    anchored.observe(key, [user('wrong-paged-anchor', 3, text, 'some-other-source')], sid);
    assert.equal(anchored.observe(key, [q], sid).questions.get('quoted-cache-safe').answered, false);
  });
  await check('imported, heartbeat and noncanonical user rows are not answer evidence', () => {
    assert(contract);
    for (const kind of ['imported', 'heartbeat', 'missing-identity', 'missing-sequence', 'internal']) {
      const reply = user('not-evidence', 2, 'An ordinary-looking answer', 'source-evidence');
      if (kind === 'imported') reply.__openclaw.externalSource = 'fixture-import';
      if (kind === 'heartbeat') reply.isHeartbeat = true;
      if (kind === 'missing-identity') delete reply.__openclaw.id;
      if (kind === 'missing-sequence') delete reply.__openclaw.seq;
      if (kind === 'internal') reply.provenance = { kind: 'internal_system' };
      assert.equal(contract.projectAsyncQuestions([question('evidence', 1), reply]).get('evidence').answered, false, kind);
    }
  });
  await check('late history cannot reopen an answered card or transfer it to a new transcript', () => {
    assert(contract); const tracker = new contract.AsyncQuestionTracker(), q = question('tracker', 1);
    tracker.observe(key, [user('late-answer', 3, 'Linked answer', 'source-tracker')], 'first-transcript');
    assert.equal(tracker.observe(key, [q], 'first-transcript').questions.get('tracker').answered, true);
    assert.equal(tracker.observe(key, [q], 'first-transcript').questions.get('tracker').answered, true);
    assert.equal(tracker.observe(key, [q], 'new-transcript').questions.get('tracker').answered, false);
    assert.equal(tracker.observe(markKey, [q], 'first-transcript').questions.get('tracker').answered, false);
    assert.equal(contract.asyncQuestionForTranscript(contract.readAsyncQuestion(q), 'old', 'new').answerable, false);
    const missing = question('no-source', 1); delete missing.__openclaw;
    assert.equal(contract.asyncQuestionForTranscript(contract.readAsyncQuestion(missing), sid, sid).answerable, false);
  });
  await check('blocking defaults are declared values only and are never restored into secret questions', () => {
    assert(contract);
    const form = contract.normalizeBlockingQuestion(blockingQuestions()[0].questions[0]); assert.deepEqual(form.defaultAnswers, ['two']); assert.equal(form.options[1].reply, 'two');
    const secret = contract.normalizeBlockingQuestion({ ...blockingQuestions()[1].questions[0], defaultAnswers: ['inert-default-must-not-be-restored'] });
    assert.equal(secret.isSecret, true); assert(!Object.hasOwn(secret, 'defaultAnswers'));
    assert.equal(contract.normalizeBlockingQuestion({ options: [] }).isOther, false);
    assert(!logs.includes('inert test input')); assert(!logs.includes('inert-default-must-not-be-restored'));
  });
  await check('multiple optional questions retain the official quoted order and accept free text', () => {
    assert(contract);
    const q = contract.readAsyncQuestion({ ...question('multiple', 1), openclawAsyncDelivery: { itemId: 'multiple', questions: [{ title: 'First\r\nquestion', options: ['One', 'Two'] }, { title: 'Second question' }] } });
    assert.equal(contract.formatAsyncAnswer(q, ['  Custom outside options  ', 'Written answer']), '> First  question\n\nCustom outside options\n\n> Second question\n\nWritten answer');
    const answered = contract.projectAsyncQuestions([{ ...question('multiple', 1), openclawAsyncDelivery: { itemId: 'multiple', questions: q.questions } }, user('multiple-answer', 2, contract.formatAsyncAnswer(q, ['Custom', 'Written']))]);
    assert.equal(answered.get('multiple').answered, true);
  });
  await check('unsupported async payload retains fallback rather than invented controls', () => {
    assert(contract); const raw = question('unsupported', 1); raw.openclawAsyncDelivery.questions[0].options = ['']; assert.equal(contract.readAsyncQuestion(raw), null);
  });
} finally {
  for (const browser of browsers) browser.terminate();
  if (backend && backend.exitCode === null) { const stopped = once(backend, 'exit'); backend.kill('SIGTERM'); await stopped; }
  for (const socket of sockets) socket.terminate(); await new Promise(resolve => gateway.close(resolve));
  fs.rmSync(temporary, { recursive: true, force: true });
}
const failures = results.filter(result => !result.ok).length;
console.log(`RESULTADO: ${results.length - failures}/${results.length} PASS (${failures} FAIL)`);
process.exitCode = failures ? 1 : 0;
