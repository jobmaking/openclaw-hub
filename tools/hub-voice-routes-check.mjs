// Authenticated HTTP contract, exact native transcript identities and engine locality.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const express = require('express');
const { VoiceRoutes, spokenText, readConfig, phaseOf } = require('../lib/voice-routes');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-voice-contract-'));
const sessionKey = 'agent:main:dashboard:voice-contract';
const token = 'synthetic-voice-node-credential-not-a-real-secret';
let checks = 0, failures = 0, activeSession = 'transcript-1', denied = false, inferenceDelay = 0;
let workerStatus = 200, transcript = { text: 'Hola.\nEsta es una nota de voz.', language: 'es', duration: 3.2 };
let speechCalls = 0, transcribeCalls = 0, describeCalls = 0, rawMessages = [], foreignNodeCalls = 0;
const mp3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(1024, 74)]);
const nativeCalls = [], bodies = [];
const check = async (name, fn) => {
  checks++;
  try { await fn(); console.log('PASS ' + name); }
  catch (error) { failures++; console.log('FAIL ' + name + ' · ' + error.message); }
};
const listen = async server => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return 'http://127.0.0.1:' + server.address().port; };
const engine = http.createServer(async (req, res) => {
  assert.equal(req.headers.authorization, 'Bearer ' + token);
  if (req.url === '/health') { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ available: true, stt: true, tts: true })); }
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks); bodies.push({ route: req.url, body });
  if (req.url === '/transcribe') {
    transcribeCalls++;
    if (inferenceDelay) await new Promise(resolve => setTimeout(resolve, inferenceDelay));
    res.statusCode = workerStatus; res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify(workerStatus === 200 ? transcript : { error: { code: 'no_speech', message: token } }));
  }
  if (req.url === '/speech') {
    speechCalls++; await new Promise(resolve => setTimeout(resolve, inferenceDelay || 25));
    res.setHeader('Content-Type', 'audio/mpeg'); return res.end(mp3);
  }
  res.writeHead(404).end();
});
const alternate = http.createServer((req, res) => { foreignNodeCalls++; res.end('{}'); });
const engineUrl = await listen(engine), alternateUrl = await listen(alternate);
fs.writeFileSync(path.join(root, 'voice.json'), JSON.stringify({ version: 1, nodes: {
  primary: { url: engineUrl, token }, independent: { url: alternateUrl, token },
}, agents: { bu: 'primary', assistant: 'independent' } }));
const makeLink = id => ({ id, cfg: { gatewayAgentId: 'main' }, async req(method, params) {
  nativeCalls.push({ method, params });
  if (method === 'sessions.describe') { describeCalls++; return denied ? { ok: false, error: { code: 'FORBIDDEN' } }
    : { ok: true, payload: { session: { key: params.key, agentId: 'main', sessionId: activeSession } } }; }
  if (method === 'chat.history') return { ok: true, payload: { sessionId: params.sessionId === 'foreign-transcript' ? activeSession : params.sessionId || activeSession,
    messages: rawMessages } };
  throw new Error('Unexpected RPC');
} });
const links = { bu: makeLink('bu'), assistant: makeLink('assistant'), disabled: makeLink('disabled') };
const options = { dataDir: root, getLink: id => links[id], authorizeSession: async (req, link, key) => req.user !== 'no-access',
  requireAuth: (req, res, next) => { if (!req.headers['x-test-user']) return res.status(401).json({ error: 'authentication required' }); req.user = req.headers['x-test-user']; next(); } };
const voice = new VoiceRoutes(options);
const app = express(); app.use(express.json()); voice.mount(app);
const server = http.createServer(app), base = await listen(server);
const url = (route, query = {}) => base + route + '?' + new URLSearchParams({ agent: 'bu', key: sessionKey, ...query });
const get = (route, query = {}, user = 'alice', headers = {}) => fetch(url(route, query), { headers: { ...(user ? { 'x-test-user': user } : {}), ...headers } });
const post = (route, body = {}, user = 'alice') => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-test-user': user },
  body: JSON.stringify({ agent: 'bu', key: sessionKey, ...body }) });
const transcribe = (query = {}, type = 'audio/webm', user = 'alice') => {
  const form = new FormData(); form.append('audio', new Blob([Buffer.from('synthetic-audio-fixture')], { type }), 'voice.webm');
  return fetch(url('/api/voice/transcribe', query), { method: 'POST', headers: { 'x-test-user': user }, body: form });
};
let note;
try {
  await check('no credentials or configuration enables no engine', () => {
    assert.deepEqual(readConfig('/does-not-exist', false), { nodes: {}, agents: {}, invalid: false });
    assert.equal(new VoiceRoutes({ ...options, disabled: true }).node('bu'), null);
  });
  await check('node egress stays loopback and rejects embedded credentials', () => {
    const config = path.join(root, 'bad.json');
    for (const value of ['http://outside.invalid:8898', 'http://name:password@127.0.0.1:8898']) {
      fs.writeFileSync(config, JSON.stringify({ version: 1, nodes: { bad: { url: value, token } }, agents: { bu: 'bad' } }));
      assert.equal(readConfig(config, false).invalid, true);
    }
  });
  await check('all voice status reads require authentication', async () => assert.equal((await get('/api/voice/status', {}, null)).status, 401));
  await check('unknown agents and foreign agent keys fail before inference', async () => {
    assert.equal((await get('/api/voice/status', { agent: 'missing' })).status, 400);
    assert.equal((await get('/api/voice/status', { key: 'agent:foreign:dashboard:any' })).status, 403);
    assert.equal(foreignNodeCalls, 0);
  });
  await check('native current permissions gate status, not just cached session ACL', async () => {
    denied = true; assert.equal((await get('/api/voice/status')).status, 403); denied = false;
    assert.equal((await get('/api/voice/status', {}, 'no-access')).status, 403);
  });
  await check('status reveals capabilities but no engine URL or token', async () => {
    const body = await (await get('/api/voice/status')).json();
    assert.deepEqual(body, { enabled: true, available: true, stt: true, tts: true, maxSeconds: 300, maxBytes: 26214400 });
    assert.equal(JSON.stringify(body).includes(token), false); assert.equal(foreignNodeCalls, 0);
  });
  await check('unconfigured agents do not inherit another PC engine', async () => {
    assert.equal((await (await get('/api/voice/status', { agent: 'disabled' })).json()).enabled, false);
    assert.equal((await transcribe({ agent: 'disabled' })).status, 503); assert.equal(foreignNodeCalls, 0);
  });
  await check('voice upload rejects active/non-audio documents', async () => {
    const before = transcribeCalls; assert.equal((await transcribe({}, 'text/html')).status, 415); assert.equal(transcribeCalls, before);
  });
  await check('browser audio becomes an editable transcript plus private original', async () => {
    const response = await transcribe(); assert.equal(response.status, 200); note = await response.json();
    assert.equal(note.text, transcript.text); assert.equal(note.sessionId, activeSession); assert.equal(note.duration, 3.2);
    assert.match(note.audioUrl, /^\/api\/voice\/audio\?/); assert.equal(foreignNodeCalls, 0);
    assert.equal(fs.statSync(path.join(root, 'voice', note.id + '.audio')).mode & 0o777, 0o600);
  });
  await check('silence errors do not publish provider details or credentials', async () => {
    workerStatus = 422; const response = await transcribe(); assert.equal(response.status, 422);
    const body = await response.text(); assert.match(body, /detectado voz/); assert.equal(body.includes(token), false); workerStatus = 200;
  });
  await check('recordings cannot be downloaded across accounts or conversations', async () => {
    assert.equal((await get('/api/voice/audio', { id: note.id }, 'bob')).status, 403);
    assert.equal((await get('/api/voice/audio', { id: note.id, key: sessionKey + '-other' })).status, 403);
  });
  await check('original audio supports real browser byte ranges and nosniff', async () => {
    const response = await get('/api/voice/audio', { id: note.id }, 'alice', { Range: 'bytes=0-7' });
    assert.equal(response.status, 206); assert.equal((await response.arrayBuffer()).byteLength, 8);
    assert.equal(response.headers.get('content-type'), 'audio/webm'); assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  });
  await check('definite rejection unlocks an unsent note but uncertain and accepted receipts remain protected', async () => {
    const prepared = await voice.prepareSend('alice', links.bu, sessionKey, note.id, 'rejected-run');
    await assert.rejects(voice.prepareSend('alice', links.bu, sessionKey, note.id, 'other-attempt'), /ya se ha enviado/);
    voice.rejectSend(prepared, 'unrelated-run'); assert.equal(prepared.runId, 'rejected-run');
    voice.rejectSend(prepared, 'rejected-run'); assert.equal(prepared.runId, undefined);
    assert.equal((await voice.prepareSend('alice', links.bu, sessionKey, note.id, 'native-run-1')).id, note.id);
  });
  await check('native admission receipts bind notes without transcript text matching', async () => {
    const prepared = await voice.prepareSend('alice', links.bu, sessionKey, note.id, 'native-run-1'); voice.commitSend(prepared, 'native-run-1');
    const raw = { role: 'user', content: 'Texto editado después de transcribir.', idempotencyKey: 'native-run-1:user', __openclaw: { id: 'user-1' } };
    rawMessages.push(raw);
    const view = voice.decorateMessage('alice', 'bu', sessionKey, raw, activeSession, rawMessages);
    assert.equal(view.voiceNote.id, note.id);
    assert.equal(voice.decorateMessage('alice', 'bu', sessionKey, { ...raw, idempotencyKey: 'another-run:user', __openclaw: { id: 'other-user' } }, activeSession).voiceNote, undefined);
    assert.equal(voice.decorateMessage('bob', 'bu', sessionKey, raw, activeSession).voiceNote, undefined);
    await assert.rejects(voice.prepareSend('alice', links.bu, sessionKey, note.id, 'different-run'), /ya se ha enviado/);
    assert.equal((await voice.prepareSend('alice', links.bu, sessionKey, note.id, 'native-run-1')).id, note.id);
    voice.rejectSend(prepared, 'native-run-1'); assert.equal(prepared.accepted, true); assert.equal(prepared.runId, 'native-run-1');
  });
  await check('published original rechecks the exact native transcript message', async () => {
    assert.equal((await get('/api/voice/audio', { id: note.id })).status, 200);
    const saved = rawMessages; rawMessages = []; assert.equal((await get('/api/voice/audio', { id: note.id })).status, 404); rawMessages = saved;
  });
  await check('speech cannot synthesize user-supplied text or a different transcript', async () => {
    assert.equal((await post('/api/voice/speech', { messageId: 'missing', sessionId: activeSession, text: 'Arbitrary attacker content' })).status, 404);
    assert.equal((await post('/api/voice/speech', { messageId: 'user-1', sessionId: activeSession })).status, 422);
    assert.equal((await post('/api/voice/speech', { messageId: 'user-1', sessionId: 'foreign-transcript' })).status, 409);
  });
  const assistant = { role: 'assistant', content: [{ type: 'text', text: 'Esta es la respuesta.\n```bash\necho private-command\n```', textSignature: JSON.stringify({ v: 1, phase: 'final_answer' }) }],
    __openclaw: { id: 'answer-1', runId: 'native-run-1' }, stopReason: 'stop' };
  rawMessages.push(assistant);
  await check('only native final-phase metadata enables automatic answer identity', () => {
    const view = voice.decorateMessage('alice', 'bu', sessionKey, assistant, activeSession, rawMessages);
    assert.equal(view.phase, 'final_answer'); assert.equal(view.runId, 'native-run-1'); assert.equal(view.speakable, true);
    assert.equal(phaseOf({ content: [{ type: 'text', text: 'Progress', textSignature: '{"v":1,"phase":"commentary"}' }] }), 'commentary');
  });
  await check('commentary, failed messages and tools cannot become speech', async () => {
    const commentary = { ...assistant, phase: 'commentary', __openclaw: { id: 'commentary-1' } };
    rawMessages.push(commentary);
    assert.equal((await post('/api/voice/speech', { messageId: 'commentary-1', sessionId: activeSession })).status, 422);
    const failed = { ...assistant, errorMessage: 'failed' }; assert.equal(voice.decorateMessage('alice', 'bu', sessionKey, failed, activeSession).speakable, false);
  });
  let spoken;
  await check('parallel speech requests deduplicate and only read native answer text', async () => {
    const before = speechCalls;
    const responses = await Promise.all([post('/api/voice/speech', { messageId: 'answer-1', sessionId: activeSession, text: 'Wrong browser text' }), post('/api/voice/speech', { messageId: 'answer-1', sessionId: activeSession })]);
    assert.deepEqual(responses.map(response => response.status), [200, 200]);
    const [first, second] = await Promise.all(responses.map(response => response.json())); spoken = first;
    assert.equal(first.id, second.id); assert.equal(speechCalls, before + 1); assert.equal(first.omittedCode, true);
    const sent = JSON.parse(bodies.findLast(body => body.route === '/speech').body.toString());
    assert.match(sent.text, /Esta es la respuesta/); assert.equal(sent.text.includes('private-command'), false); assert.equal(sent.text.includes('Wrong browser text'), false);
  });
  await check('cached spoken audio is persisted and native-message revalidated', async () => {
    const response = await get('/api/voice/audio', { id: spoken.id }); assert.equal(response.status, 200); assert.deepEqual(Buffer.from(await response.arrayBuffer()), mp3);
    const before = speechCalls; assert.equal((await (await post('/api/voice/speech', { messageId: 'answer-1', sessionId: activeSession })).json()).id, spoken.id); assert.equal(speechCalls, before);
    const reopened = new VoiceRoutes(options); assert.equal(reopened.decorateMessage('alice', 'bu', sessionKey, assistant, activeSession).voiceAudio.id, spoken.id);
  });
  await check('editing a native answer invalidates its previous audio', async () => {
    const original = assistant.content; assistant.content = [{ type: 'text', text: 'Contenido nuevo.' }];
    assert.equal((await get('/api/voice/audio', { id: spoken.id })).status, 409); assistant.content = original;
  });
  await check('legacy final correlation needs exact run, text and a unique message', () => {
    const legacy = { role: 'assistant', content: 'Respuesta final antigua', __openclaw: { id: 'legacy-1', runId: 'legacy-run' } };
    voice.observeFinal('bu', { state: 'final', sessionKey, runId: 'legacy-run', message: { content: legacy.content } });
    assert.equal(voice.decorateMessage('alice', 'bu', sessionKey, legacy, activeSession, [legacy]).phase, 'final_answer');
    assert.equal(voice.decorateMessage('alice', 'bu', sessionKey, legacy, activeSession, [legacy, legacy]).phase, undefined);
    assert.equal(voice.decorateMessage('alice', 'bu', sessionKey, { ...legacy, __openclaw: { id: 'legacy-2', runId: 'foreign-run' } }, activeSession, [legacy]).phase, undefined);
  });
  await check('spoken long answers explicitly report partial audio', () => {
    const value = spokenText('Una frase completa. '.repeat(700)); assert.equal(value.truncated, true); assert.ok(value.text.length <= 6000); assert.ok(value.totalChars > value.spokenChars);
    assert.match(value.text, /respuesta completa/);
  });
  await check('a reset during transcription never binds audio to the new conversation', async () => {
    inferenceDelay = 60; const before = voice.entries.size, beforeCalls = transcribeCalls;
    const pending = transcribe();
    for (let i = 0; i < 50 && transcribeCalls === beforeCalls; i++) await new Promise(resolve => setTimeout(resolve, 5));
    activeSession = 'transcript-2'; const response = await pending; assert.equal(response.status, 409); assert.equal(voice.entries.size, before); inferenceDelay = 0;
  });
  await check('no operation silently calls the other PC engine', () => assert.equal(foreignNodeCalls, 0));
} finally {
  server.closeAllConnections(); engine.closeAllConnections(); alternate.closeAllConnections();
  await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => engine.close(resolve)), new Promise(resolve => alternate.close(resolve))]);
  fs.rmSync(root, { recursive: true, force: true });
}
console.log(`VOICE CONTRACT ${checks - failures}/${checks} passed`);
if (failures) process.exitCode = 1;
