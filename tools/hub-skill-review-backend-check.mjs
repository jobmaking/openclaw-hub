// Real HUB backend with an inert Workshop Gateway. No production data or decisions.
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
const { WebSocketServer } = require('ws');
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-skill-review-'));
const dataDir = path.join(root, 'data'); fs.mkdirSync(dataDir);
const baseline = '---\nname: fixture\n---\n# Installed\nKeep existing instructions.\n';
const candidate = '---\nname: fixture\nstatus: proposal\n---\n# Candidate\nKeep existing instructions.\nAdd a verified procedure.\n';
const revision = 'a'.repeat(64), changedRevision = 'b'.repeat(64);
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
const nativeCalls = [], decisions = [], checks = [];
let mode = 'normal', holdDecision, backend, logs = '', base;
const proposals = new Map();
function reset() {
  mode = 'normal';
  proposals.clear();
  for (const [id, agentId, kind] of [['update-one', 'main', 'update'], ['create-one', 'main', 'create'], ['foreign-one', 'secondary', 'create']]) {
    proposals.set(id, { ownerAgentId: agentId, revisionHash: revision, content: candidate, supportFiles: [{ path: 'references/check.md', content: 'Complete support file.\n' }], record: {
      id, kind, status: 'pending', title: 'Review fixture', description: 'Synthetic skill', origin: { agentId },
      target: { skillName: 'fixture', currentContentHash: hash(baseline) },
      scan: { state: 'clean', critical: 0, findings: [] }, supportFiles: [{ path: 'references/check.md', sizeBytes: 23 }],
      goal: 'Verified procedure', evidence: 'Inert test evidence',
    } });
  }
}
reset();
const gateway = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await once(gateway, 'listening');
gateway.on('connection', socket => {
  socket.send(JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { nonce: 'skill-review-fixture' } }));
  socket.on('message', async raw => {
    const frame = JSON.parse(raw), params = frame.params || {};
    nativeCalls.push({ method: frame.method, params });
    const reply = (payload, error) => { if (socket.readyState === 1) socket.send(JSON.stringify({ type: 'res', id: frame.id, ok: !error, ...(error ? { error } : { payload }) })); };
    switch (frame.method) {
      case 'connect': return reply({ type: 'hello-ok', protocol: 4, auth: { scopes: params.scopes || [] }, features: { methods: [], events: [] } });
      case 'models.list': return reply({ models: [] });
      case 'sessions.list': return reply({ sessions: [] });
      case 'question.list': return reply({ questions: [] });
      case 'exec.approval.list': case 'plugin.approval.list': return reply([]);
      case 'skills.proposals.list':
        if (mode === 'list-error') return reply(null, { code: 'UNAVAILABLE', message: 'Synthetic list failure' });
        return reply({ proposals: [...proposals.values()].filter(p => p.ownerAgentId === params.agentId).map(p => ({
          id: p.record.id, kind: p.record.kind, status: p.record.status, title: p.record.title, skillName: 'fixture', description: 'Synthetic', revisionHash: p.revisionHash, degradedState: p.draftMissing && p.record.status === 'pending' ? 'draft-missing' : undefined,
        })), installedSkills: [] });
      case 'skills.proposals.inspect': {
        const p = proposals.get(params.proposalId);
        if (!p) return reply(null, { code: 'NOT_FOUND', message: 'Missing proposal' });
        if (p.draftMissing) return reply(null, { code: 'INVALID_REQUEST', message: 'Synthetic missing proposal draft' });
        return reply(structuredClone(p));
      }
      case 'skills.workshop.read': return reply({ name: 'fixture', content: mode === 'drift' ? baseline + 'New installed content.\n' : baseline });
      case 'skills.proposals.apply': case 'skills.proposals.reject': {
        decisions.push({ method: frame.method, params });
        const p = proposals.get(params.proposalId);
        if (params.expectedRevisionHash !== p.revisionHash) return reply(null, { code: 'INVALID_REQUEST', message: 'Proposal revision changed' });
        if (holdDecision) await holdDecision;
        if (mode === 'native-error') return reply(null, { code: 'UNAVAILABLE', message: 'Synthetic unknown result' });
        if (mode === 'false-ack') return reply({ record: { id: 'another-proposal', status: 'applied' } });
        p.record.status = frame.method.endsWith('.apply') ? 'applied' : 'rejected';
        return reply({ record: structuredClone(p.record) });
      }
      default: return reply({});
    }
  });
});
const users = [
  { u: 'manager', allowedAgents: ['primary', 'secondary'], canReviewSkills: true, sessionScope: 'shared' },
  { u: 'shared', allowedAgents: ['primary'], sessionScope: 'shared' },
  { u: 'own', allowedAgents: ['primary'], canReviewSkills: true, sessionScope: 'own' },
  { u: 'own-no-flag', allowedAgents: ['primary'], sessionScope: 'own' },
  { u: 'limited', allowedAgents: ['secondary'], canReviewSkills: true, sessionScope: 'shared' },
];
for (const user of users) { const salt = crypto.randomBytes(16).toString('hex'); user.pw = 'scrypt$' + salt + '$' + crypto.scryptSync('inert-test-password', salt, 64).toString('hex'); }
fs.writeFileSync(path.join(dataDir, 'users.json'), JSON.stringify(users));
fs.writeFileSync(path.join(dataDir, 'agents.json'), JSON.stringify([
  { id: 'primary', name: 'Primary', url: 'ws://127.0.0.1:' + gateway.address().port, token: 'inert-fixture', gatewayAgentId: 'main' },
  { id: 'secondary', name: 'Secondary', url: 'ws://127.0.0.1:' + gateway.address().port, token: 'inert-fixture', gatewayAgentId: 'secondary' },
]));
fs.writeFileSync(path.join(dataDir, 'notify.json'), JSON.stringify({ enabled: false }));
const probe = http.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
base = 'http://127.0.0.1:' + port;
const { PANEL_TENANT: ignoredTenant, ...inheritedEnvironment } = process.env;
backend = spawn(process.execPath, [path.join(repo, 'server.js')], { cwd: repo, env: { ...inheritedEnvironment, PORT: String(port), BIND: '127.0.0.1', DATA_DIR: dataDir, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' }, stdio: ['ignore', 'pipe', 'pipe'] });
backend.stdout.on('data', b => { logs += b; }); backend.stderr.on('data', b => { logs += b; });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) { const end = Date.now() + 8000; while (Date.now() < end) { const v = await fn(); if (v) return v; if (backend.exitCode !== null) throw new Error(logs.slice(-1000)); await delay(30); } throw new Error('Fixture timed out'); }
async function check(name, fn) { try { await fn(); checks.push({ name, ok: true }); console.log('PASS ' + name); } catch (e) { checks.push({ name, ok: false }); console.log('FAIL ' + name + ': ' + e.message); } }
async function login(user) { const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ u: user, p: 'inert-test-password' }) }); assert.equal(r.status, 200); return r.headers.get('set-cookie').split(';')[0]; }
async function request(cookie, route, body, extra = {}) { const r = await fetch(base + route, { headers: { Cookie: cookie || '', ...(body ? { 'content-type': 'application/json', Origin: base } : {}), ...extra }, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) }); return { status: r.status, body: await r.json(), cache: r.headers.get('cache-control') }; }
const decision = (id = 'create-one', overrides = {}) => ({ agent: 'primary', id, revisionHash: revision, decision: 'apply', ...overrides });
try {
  await until(async () => { try { return (await fetch(base + '/api/branding')).ok && nativeCalls.filter(c => c.method === 'connect').length === 2; } catch { return false; } });
  const manager = await login('manager'), shared = await login('shared'), own = await login('own'), ownNoFlag = await login('own-no-flag'), limited = await login('limited');
  await check('unauthenticated proposal reads are denied', async () => assert.equal((await request(null, '/api/skill-proposals?agent=primary')).status, 401));
  await check('shared conversation access does not grant skill publication', async () => assert.equal((await request(shared, '/api/skill-proposals?agent=primary')).status, 403));
  await check('own-scope accounts with the explicit flag can read proposals', async () => assert.equal((await request(own, '/api/skill-proposals?agent=primary')).status, 200));
  await check('own-scope accounts without the flag are denied', async () => assert.equal((await request(ownNoFlag, '/api/skill-proposals?agent=primary')).status, 403));
  await check('explicit skill privilege still respects the agent allowlist', async () => assert.equal((await request(limited, '/api/skill-proposals?agent=primary')).status, 403));
  await check('capability is explicit and agent-specific', async () => {
    const a = await request(manager, '/api/agents'), b = await request(shared, '/api/agents'), c = await request(own, '/api/agents'), d = await request(ownNoFlag, '/api/agents');
    assert.equal(a.body.agents.find(a => a.id === 'primary').skillsReviewEnabled, true);
    assert.equal(b.body.agents[0].skillsReviewEnabled, false);
    assert.equal(c.body.agents[0].skillsReviewEnabled, true);
    assert.equal(d.body.agents[0].skillsReviewEnabled, false);
  });
  await check('pending proposals from before connection are listed without opening a chat', async () => {
    const r = await request(manager, '/api/skill-proposals?agent=primary'); assert.equal(r.status, 200); assert.equal(r.body.complete, true);
    assert.deepEqual(r.body.proposals.map(p => p.id).sort(), ['create-one', 'update-one']); assert.equal(r.cache, 'no-store');
    assert.equal(nativeCalls.filter(c => c.method === 'skills.proposals.list').at(-1).params.agentId, 'main');
  });
  await check('foreign guessed proposal IDs cannot cross a shared Gateway', async () => {
    assert.equal((await request(manager, '/api/skill-proposal?agent=primary&id=foreign-one')).status, 403);
    const before = decisions.length; assert.equal((await request(manager, '/api/skill-proposal-decision', decision('foreign-one'))).status, 403); assert.equal(decisions.length, before);
  });
  await check('legacy proposals without origin require native agent inventory membership', async () => {
    delete proposals.get('create-one').record.origin; delete proposals.get('foreign-one').record.origin;
    assert.equal((await request(manager, '/api/skill-proposal?agent=primary&id=create-one')).status, 200);
    assert.equal((await request(manager, '/api/skill-proposal?agent=primary&id=foreign-one')).status, 403); reset();
  });
  await check('a missing revision does not hide other proposals or enable a decision', async () => {
    delete proposals.get('create-one').revisionHash;
    const r = await request(manager, '/api/skill-proposals?agent=primary'); assert.equal(r.status, 200);
    assert.equal(r.body.proposals.find(p => p.id === 'create-one').revisionHash, null);
    assert.equal((await request(manager, '/api/skill-proposal?agent=primary&id=create-one')).status, 502); reset();
  });
  await check('inspect returns complete literal instructions, changes and support-file manifest', async () => {
    const r = await request(manager, '/api/skill-proposal?agent=primary&id=update-one'); assert.equal(r.status, 200);
    assert.equal(r.body.proposal.content, candidate); assert.match(r.body.proposal.diff, /Installed/); assert.match(r.body.proposal.diff, /Candidate/);
    assert.equal(r.body.proposal.canApply, true); assert.equal(r.body.proposal.supportFiles[0].path, 'references/check.md'); assert.equal(decisions.length, 0);
  });
  await check('support reads select only an exact proposal artifact', async () => {
    const r = await request(manager, '/api/skill-proposal?agent=primary&id=update-one&artifactPath=references%2Fcheck.md'); assert.equal(r.body.proposal.artifactContent, 'Complete support file.\n');
    for (const p of ['../private/secret', 'references/../private', '/etc/passwd', 'references/not-listed.md']) assert.equal((await request(manager, '/api/skill-proposal?agent=primary&id=update-one&artifactPath=' + encodeURIComponent(p))).status, 400);
  });
  await check('installed drift is visible and does not silently secondary or apply a proposal', async () => {
    mode = 'drift'; const r = await request(manager, '/api/skill-proposal?agent=primary&id=update-one'); assert.equal(r.body.proposal.canApply, false);
    const before = decisions.length; assert.equal((await request(manager, '/api/skill-proposal-decision', decision('update-one'))).status, 409); assert.equal(decisions.length, before); mode = 'normal';
  });
  await check('critical scanner findings block acceptance', async () => {
    proposals.get('create-one').record.scan.critical = 1; const before = decisions.length;
    assert.equal((await request(manager, '/api/skill-proposal-decision', decision())).status, 409); assert.equal(decisions.length, before); proposals.get('create-one').record.scan.critical = 0;
  });
  await check('a stale inspected revision cannot be approved or rejected', async () => {
    proposals.get('create-one').revisionHash = changedRevision; const before = decisions.length;
    assert.equal((await request(manager, '/api/skill-proposal-decision', decision())).status, 409);
    assert.equal((await request(manager, '/api/skill-proposal-decision', decision('create-one', { decision: 'reject' }))).status, 409); assert.equal(decisions.length, before); reset();
  });
  await check('cross-origin decisions are denied without a native mutation', async () => {
    const before = decisions.length; assert.equal((await request(manager, '/api/skill-proposal-decision', decision(), { Origin: 'https://foreign.invalid' })).status, 403); assert.equal(decisions.length, before);
  });
  await check('malformed and unsupported decisions cannot become native RPC names', async () => {
    const before = decisions.length;
    for (const d of [{ decision: 'quarantine' }, { revisionHash: 'bad' }, { id: '../other' }]) assert.equal((await request(manager, '/api/skill-proposal-decision', decision('create-one', d))).status, 400);
    assert.equal(decisions.length, before);
  });
  await check('explicit accept is revision-bound and confirmed from durable native state', async () => {
    const r = await request(manager, '/api/skill-proposal-decision', decision()); assert.equal(r.status, 200); assert.equal(r.body.status, 'applied');
    const call = decisions.at(-1); assert.equal(call.method, 'skills.proposals.apply'); assert.equal(call.params.agentId, 'main'); assert.equal(call.params.expectedRevisionHash, revision);
    assert.equal((await request(manager, '/api/skill-proposal-decision', decision())).status, 409);
    const list = await request(manager, '/api/skill-proposals?agent=primary'); assert.ok(!list.body.proposals.some(p => p.id === 'create-one'));
  });
  await check('reject is explicit and leaves other pending proposals unchanged', async () => {
    const r = await request(manager, '/api/skill-proposal-decision', decision('update-one', { decision: 'reject' })); assert.equal(r.body.status, 'rejected'); assert.equal(decisions.at(-1).method, 'skills.proposals.reject');
    assert.equal(proposals.get('foreign-one').record.status, 'pending');
  });
  await check('a natively missing draft stays readable as unavailable and can only be rejected explicitly', async () => {
    reset(); proposals.get('create-one').draftMissing = true;
    const r = await request(manager, '/api/skill-proposal?agent=primary&id=create-one');
    assert.equal(r.status, 200); assert.equal(r.body.proposal.content, null); assert.equal(r.body.proposal.canApply, false);
    const before = decisions.length; assert.equal((await request(manager, '/api/skill-proposal-decision', decision())).status, 409); assert.equal(decisions.length, before);
    assert.equal((await request(manager, '/api/skill-proposal-decision', decision('create-one', { decision: 'reject' }))).body.status, 'rejected');
  });
  await check('a positive native ACK without the requested durable state never becomes success', async () => {
    reset(); mode = 'false-ack'; const r = await request(manager, '/api/skill-proposal-decision', decision());
    assert.equal(r.status, 503); assert.equal(r.body.uncertain, true); assert.notEqual(r.body.ok, true);
  });
  await check('simultaneous duplicate decisions dispatch at most once', async () => {
    reset(); let release; holdDecision = new Promise(resolve => { release = resolve; });
    const before = decisions.length, first = request(manager, '/api/skill-proposal-decision', decision()); await until(() => decisions.length === before + 1);
    const second = await request(manager, '/api/skill-proposal-decision', decision()); assert.equal(second.status, 409); release(); holdDecision = null; assert.equal((await first).body.status, 'applied'); assert.equal(decisions.length, before + 1);
  });
  await check('native unavailable response is never retried or reported as success', async () => {
    reset(); mode = 'native-error'; const before = decisions.length; const r = await request(manager, '/api/skill-proposal-decision', decision());
    assert.equal(r.status, 503); assert.notEqual(r.body.ok, true); assert.equal(r.body.uncertain, true); await delay(100); assert.equal(decisions.length, before + 1); mode = 'normal';
  });
  await check('a failed list is an explicit error, not an empty successful queue', async () => {
    mode = 'list-error'; const r = await request(manager, '/api/skill-proposals?agent=primary'); assert.equal(r.status, 503); assert.equal(r.body.proposals, undefined); mode = 'normal';
  });
  await check('route case and trailing-slash aliases preserve skill authorization', async () => {
    assert.equal((await request(shared, '/api/SKILL-PROPOSALS/?agent=primary')).status, 403); assert.equal((await request(manager, '/api/SKILL-PROPOSALS/?agent=primary')).status, 200);
  });
} finally {
  holdDecision = null; backend.kill('SIGTERM'); await Promise.race([once(backend, 'exit'), delay(2000)]);
  for (const client of gateway.clients) client.terminate(); await new Promise(resolve => gateway.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
}
const failures = checks.filter(c => !c.ok); console.log(`RESULT ${checks.length - failures.length}/${checks.length}`);
if (failures.length) process.exitCode = 1;
