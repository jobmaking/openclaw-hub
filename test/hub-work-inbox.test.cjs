'use strict';

// Contract tests for the "Mi trabajo" inbox. Everything here is fictional and
// self-contained: Express on a loopback port, fake links and fake UserAccess.
// No Gateway, account, real workspace data or deployment is involved.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const { mountWorkInbox } = require('../lib/work-inbox');

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;

function makeRow(key, sessionId, overrides = {}) {
  return {
    key,
    sessionId,
    label: overrides.label ?? key,
    lastActivityAt: NOW,
    lastInteractionAt: NOW,
    updatedAt: NOW,
    hasActiveRun: false,
    kind: 'session',
    ...overrides,
  };
}

function makeAccess({ agents = {}, keys = {} } = {}) {
  const known = new Map();
  for (const [user, byLink] of Object.entries(keys)) {
    known.set(user, new Map(Object.entries(byLink).map(([link, list]) => [link, new Set(list)])));
  }
  return {
    canAgent(user, agent) { return (agents[user] || []).includes(agent); },
    canKnown(user, link, key) { return known.get(user)?.get(link.id)?.has(key) === true; },
    validRow(link, key, row) { return !!row && row.key === key; },
  };
}

function makeLink(id, options = {}) {
  const calls = [];
  return {
    id,
    cfg: { gatewayAgentId: options.gatewayAgentId || 'main' },
    connected: options.connected !== false,
    calls,
    async sessions() {
      calls.push({ method: 'sessions', params: null });
      if (options.sessionsError) throw options.sessionsError;
      return typeof options.rows === 'function' ? options.rows() : options.rows || [];
    },
    async req(method, params) {
      calls.push({ method, params });
      if (method === 'sessions.describe') {
        const result = typeof options.describe === 'function' ? options.describe(params.key) : options.describe;
        if (!result) return { ok: false, payload: { error: 'missing' } };
        if (result.ok === false) return result;
        return { ok: true, payload: { session: result.session || result } };
      }
      if (method === 'artifacts.list') {
        const result = typeof options.artifacts === 'function'
          ? options.artifacts(params.sessionKey)
          : options.artifacts?.[params.sessionKey];
        if (result && result.ok === false) return result;
        return { ok: true, payload: { artifacts: Array.isArray(result) ? result : [] } };
      }
      return { ok: true, payload: {} };
    },
  };
}

async function start(t, options) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-work-inbox-test-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const clock = { now: options.now ?? NOW };

  const app = express();
  app.use(express.json());
  mountWorkInbox(app, {
    enabled: options.enabled !== false,
    requireAuth(req, res, next) {
      const user = req.get('x-test-user');
      if (!user) return res.status(401).json({ error: 'No autenticado' });
      req.user = user;
      next();
    },
    getLinks: () => options.links,
    access: options.access,
    documents: options.documents,
    sessionKind: row => row.kind,
    activityAt: row => row.updatedAt,
    observe: options.observe || (() => undefined),
    dataDir,
    now: () => clock.now,
  });

  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
  });

  const port = server.address().port;
  async function request(method, pathname, { user = 'ana', headers = {}, body } = {}) {
    const payload = body === undefined ? null : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const outgoing = http.request({
        host: '127.0.0.1',
        port,
        method,
        path: pathname,
        headers: {
          'x-test-user': user,
          ...(payload === null ? {} : {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(payload),
          }),
          ...headers,
        },
      }, response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed;
          try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
          resolve({ status: response.statusCode, body: parsed });
        });
      });
      outgoing.on('error', reject);
      if (payload !== null) outgoing.write(payload);
      outgoing.end();
    });
  }

  return {
    dataDir,
    clock,
    get: (user = 'ana') => request('GET', '/api/work-inbox', { user }),
    track: (body, requestOptions = {}) => request('POST', '/api/work-inbox/track', { ...requestOptions, body }),
  };
}

test('GET /api/work-inbox returns active work and ready deliveries', async t => {
  const activeRow = makeRow('k-active', 'sid-active', {
    label: 'Preparar informe', updatedAt: NOW - 1000, hasActiveRun: true,
  });
  const doneRow = makeRow('k-done', 'sid-done', { label: '', updatedAt: NOW - 5000 });
  const link = makeLink('alpha', {
    rows: [activeRow, doneRow],
    describe: key => key === 'k-active' ? activeRow : doneRow,
    artifacts: key => key === 'k-active' ? [
      { id: 'art-bytes', title: 'Informe final.pdf', download: { mode: 'bytes' }, runId: 'run-1', sessionKey: 'k-active', messageSeq: 4 },
      { id: 'art-url', title: 'Hoja.xlsx', download: { mode: 'url' }, runId: 'run-1', sessionKey: 'k-active', messageSeq: 5 },
    ] : [],
  });
  const app = await start(t, {
    links: [link],
    access: makeAccess({ agents: { ana: ['alpha'] }, keys: { ana: { alpha: ['k-active', 'k-done'] } } }),
    observe: (agent, key) => key === 'k-active'
      ? { connected: true, stale: false, activeRunId: 'run-1', runs: [{ runId: 'run-1', status: 'running', updatedAt: NOW - 1000 }] }
      : { connected: true, stale: false, activeRunId: null, runs: [] },
    documents: { granted: () => true, localArtifacts: () => [] },
  });

  const { status, body } = await app.get();
  assert.equal(status, 200);
  assert.equal(body.windowDays, 7);
  assert.equal(body.partial, false);
  assert.equal(body.checkedAt, NOW);
  assert.deepEqual(body.following, []);
  assert.equal(body.active.length, 1);
  assert.deepEqual(
    Object.fromEntries(['agent', 'key', 'sessionId', 'title', 'trackable', 'runId']
      .map(field => [field, body.active[0][field]])),
    {
      agent: 'alpha',
      key: 'k-active',
      sessionId: 'sid-active',
      title: 'Preparar informe',
      trackable: true,
      runId: 'run-1',
    },
  );
  assert.equal(body.deliveries.length, 2);
  assert.deepEqual(body.deliveries.map(delivery => delivery.file.id), ['art-url', 'art-bytes']);
  assert.deepEqual(body.deliveries[0].file, { id: 'art-url', title: 'Hoja.xlsx', source: 'agent' });
  assert.equal(body.deliveries[0].agent, 'alpha');
  assert.equal(body.deliveries[0].key, 'k-active');
  assert.equal(body.deliveries[0].sessionId, 'sid-active');
  assert.equal(body.deliveries[0].canDownload, true);
});

test('only recent session files with real bytes or URL downloads become deliveries', async t => {
  const recent = makeRow('k-recent', 'sid-recent', { updatedAt: NOW - 1000 });
  const old = makeRow('k-old', 'sid-old', { updatedAt: NOW - 8 * DAY });
  const cron = makeRow('k-cron', 'sid-cron', { updatedAt: NOW - 1000, kind: 'cron' });
  const artifacts = {
    'k-recent': [
      { id: 'bytes', title: 'Listo.pdf', download: { mode: 'bytes' }, messageSeq: 1 },
      { id: 'url', title: 'Listo.docx', download: { mode: 'url' }, messageSeq: 2 },
      { id: 'unsupported', title: 'No.pdf', download: { mode: 'unsupported' }, messageSeq: 3 },
      { id: 'empty-mode', title: 'Sin modo', download: {}, messageSeq: 4 },
      { id: 'no-download', title: 'Sin descarga', messageSeq: 5 },
      { id: 'foreign', title: 'Otra sesión', download: { mode: 'bytes' }, sessionKey: 'other', messageSeq: 6 },
      { id: '', title: 'Vacío', download: { mode: 'bytes' }, messageSeq: 7 },
    ],
    'k-old': [{ id: 'old', title: 'Viejo.pdf', download: { mode: 'bytes' } }],
    'k-cron': [{ id: 'cron', title: 'Cron.pdf', download: { mode: 'bytes' } }],
  };
  const link = makeLink('alpha', {
    rows: [recent, old, cron],
    describe: key => ({ 'k-recent': recent, 'k-old': old, 'k-cron': cron })[key],
    artifacts: key => artifacts[key] || [],
  });
  const app = await start(t, {
    links: [link],
    access: makeAccess({ agents: { ana: ['alpha'] }, keys: { ana: { alpha: ['k-recent', 'k-old', 'k-cron'] } } }),
    observe: () => ({ connected: true, stale: false, activeRunId: null, runs: [] }),
  });

  const { body } = await app.get();
  assert.equal(body.partial, false);
  assert.deepEqual(body.deliveries.map(delivery => delivery.file.id), ['url', 'bytes']);
  assert.equal(body.deliveries.some(delivery => ['old', 'cron', 'unsupported', 'empty-mode', 'no-download', 'foreign', '']
    .includes(delivery.file.id)), false);
});

test('duplicate file ids collapse to a single delivery', async t => {
  const row = makeRow('k-doc', 'sid-doc', { updatedAt: NOW - 1000 });
  const link = makeLink('alpha', {
    rows: [row],
    describe: () => row,
    artifacts: () => [
      { id: 'same', title: 'Nativo.pdf', download: { mode: 'bytes' }, runId: 'run-1', sessionKey: 'k-doc', messageSeq: 2 },
      { id: 'same', title: 'Nativo duplicado.pdf', download: { mode: 'url' }, runId: 'run-1', sessionKey: 'k-doc', messageSeq: 3 },
      { id: 'native-only', title: 'Otro.pdf', download: { mode: 'bytes' }, runId: 'run-1', sessionKey: 'k-doc', messageSeq: 4 },
    ],
  });
  const documents = {
    granted: () => true,
    localArtifacts: (req, target) => target.key === 'k-doc'
      ? [{ id: 'same', title: 'Local.docx', createdAt: NOW }]
      : [],
  };
  const app = await start(t, {
    links: [link],
    access: makeAccess({ agents: { ana: ['alpha'] }, keys: { ana: { alpha: ['k-doc'] } } }),
    observe: () => ({ connected: true, stale: false, activeRunId: null, runs: [] }),
    documents,
  });

  const { body } = await app.get();
  const ids = body.deliveries.map(delivery => delivery.file.id);
  assert.deepEqual([...ids].sort(), ['native-only', 'same']);
  assert.equal(new Set(ids).size, ids.length);
  const same = body.deliveries.find(delivery => delivery.file.id === 'same');
  assert.equal(body.deliveries.filter(delivery => delivery.file.id === 'same').length, 1);
  assert.match(same.file.title, /(?:Local\.docx|Nativo\.pdf|Nativo duplicado\.pdf)/);
  assert.equal(['agent', 'document'].includes(same.file.source), true);
  assert.equal(same.canDownload, true);
});

test('does not query artifacts for agents or sessions the user cannot access', async t => {
  const allowedRow = makeRow('k-allowed', 'sid-a', { updatedAt: NOW - 1000 });
  const hiddenRow = makeRow('k-hidden', 'sid-h', { updatedAt: NOW - 1000 });
  const betaRow = makeRow('k-beta', 'sid-b', { updatedAt: NOW - 1000 });
  const alpha = makeLink('alpha', {
    rows: [allowedRow, hiddenRow],
    describe: key => key === 'k-allowed' ? allowedRow : hiddenRow,
    artifacts: () => [{ id: 'x', title: 'x.pdf', download: { mode: 'bytes' } }],
  });
  const beta = makeLink('beta', {
    rows: [betaRow],
    describe: () => betaRow,
    artifacts: () => [{ id: 'y', title: 'y.pdf', download: { mode: 'bytes' } }],
  });
  const app = await start(t, {
    links: [alpha, beta],
    access: makeAccess({ agents: { ana: ['alpha'] }, keys: { ana: { alpha: ['k-allowed'] } } }),
    observe: () => ({ connected: true, stale: false, activeRunId: null, runs: [] }),
  });

  const { body } = await app.get();
  assert.equal(beta.calls.length, 0);
  assert.deepEqual(
    alpha.calls.filter(call => call.method === 'artifacts.list').map(call => call.params.sessionKey),
    ['k-allowed'],
  );
  assert.deepEqual(body.deliveries.map(delivery => delivery.file.id), ['x']);
});

test('withholds a delivery when the transcript changes during the artifact read', async t => {
  const stable = makeRow('k-reset', 'sid-old', {
    updatedAt: NOW - 1000, hasActiveRun: true, label: 'Trabajo',
  });
  let reset = false;
  let describeCount = 0;
  const link = makeLink('alpha', {
    rows: [stable],
    describe: () => {
      if (!reset) return stable;
      describeCount++;
      return describeCount === 1 ? stable : { ...stable, sessionId: 'sid-new' };
    },
    artifacts: () => [
      { id: 'old-art', title: 'Viejo.pdf', download: { mode: 'bytes' }, runId: 'run-1', sessionKey: 'k-reset', messageSeq: 1 },
    ],
  });
  const observe = () => ({
    connected: true,
    stale: false,
    activeRunId: 'run-1',
    runs: [{ runId: 'run-1', status: 'running', updatedAt: NOW - 1000 }],
  });
  const app = await start(t, {
    links: [link],
    access: makeAccess({ agents: { ana: ['alpha'] }, keys: { ana: { alpha: ['k-reset'] } } }),
    observe,
  });

  const tracked = await app.track({
    agent: 'alpha', key: 'k-reset', sessionId: 'sid-old', action: 'track', runId: 'run-1',
  }, { headers: { 'x-hub-work': '1' } });
  assert.equal(tracked.status, 200);

  reset = true;
  const { body } = await app.get();
  assert.equal(body.deliveries.length, 0);
  assert.equal(body.following.length, 1);
  assert.equal(body.following[0].status, 'unverified');
  assert.equal(link.calls.filter(call => call.method === 'artifacts.list').length, 1);
  assert.equal(body.partial, true);
});

test('failed and partial runs are never reported as missing', async t => {
  const state = {
    row: makeRow('k-state', 'sid-state', { updatedAt: NOW - 1000, hasActiveRun: true, label: 'Estado' }),
    runStatus: 'running',
    activeRunId: 'run-1',
    endedAt: 0,
  };
  const link = makeLink('alpha', {
    rows: () => [state.row],
    describe: () => state.row,
    artifacts: () => [],
  });
  const observe = () => ({
    connected: true,
    stale: false,
    activeRunId: state.activeRunId,
    runs: [{ runId: 'run-1', status: state.runStatus, updatedAt: NOW, endedAt: state.endedAt }],
  });
  const app = await start(t, {
    links: [link],
    access: makeAccess({ agents: { ana: ['alpha'] }, keys: { ana: { alpha: ['k-state'] } } }),
    observe,
  });
  assert.equal((await app.track({
    agent: 'alpha', key: 'k-state', sessionId: 'sid-state', action: 'track', runId: 'run-1',
  }, { headers: { 'x-hub-work': '1' } })).status, 200);

  state.row = { ...state.row, hasActiveRun: false, updatedAt: NOW - 60000 };
  state.runStatus = 'failed';
  state.activeRunId = null;
  state.endedAt = NOW - 60000;
  let result = await app.get();
  assert.equal(result.body.following.length, 1);
  assert.equal(result.body.following[0].status, 'interrupted');
  assert.notEqual(result.body.following[0].status, 'missing');

  state.runStatus = 'partial';
  result = await app.get();
  assert.equal(result.body.following[0].status, 'unverified');
  assert.notEqual(result.body.following[0].status, 'missing');
});

test('a failed artifact source marks the inbox partial instead of missing', async t => {
  const state = {
    row: makeRow('k-source', 'sid-source', { updatedAt: NOW - 1000, hasActiveRun: true, label: 'Fuente' }),
    active: true,
  };
  const link = makeLink('alpha', {
    rows: () => [state.row],
    describe: () => state.row,
    artifacts: () => state.active ? [] : { ok: false, payload: { error: 'gateway unavailable' } },
  });
  const observe = () => ({
    connected: true,
    stale: false,
    activeRunId: state.active ? 'run-1' : null,
    runs: [{
      runId: 'run-1',
      status: state.active ? 'running' : 'done',
      updatedAt: NOW,
      endedAt: state.active ? 0 : NOW - 60000,
    }],
  });
  const app = await start(t, {
    links: [link],
    access: makeAccess({ agents: { ana: ['alpha'] }, keys: { ana: { alpha: ['k-source'] } } }),
    observe,
  });
  assert.equal((await app.track({
    agent: 'alpha', key: 'k-source', sessionId: 'sid-source', action: 'track', runId: 'run-1',
  }, { headers: { 'x-hub-work': '1' } })).status, 200);

  state.active = false;
  state.row = { ...state.row, hasActiveRun: false };
  const { body } = await app.get();
  assert.equal(body.partial, true);
  assert.equal(body.deliveries.length, 0);
  assert.equal(body.following.length, 1);
  assert.equal(body.following[0].status, 'unverified');
  assert.notEqual(body.following[0].status, 'missing');
});

test('a successful run without files becomes missing only after the settling grace', async t => {
  const state = {
    row: makeRow('k-done-run', 'sid-run', { updatedAt: NOW - 1000, hasActiveRun: true, label: 'Entrega' }),
    status: 'running',
    activeRunId: 'run-1',
    endedAt: 0,
  };
  const link = makeLink('alpha', {
    rows: () => [state.row],
    describe: () => state.row,
    artifacts: () => [],
  });
  const observe = () => ({
    connected: true,
    stale: false,
    activeRunId: state.activeRunId,
    runs: [{ runId: 'run-1', status: state.status, updatedAt: NOW, endedAt: state.endedAt }],
  });
  const app = await start(t, {
    links: [link],
    access: makeAccess({ agents: { ana: ['alpha'] }, keys: { ana: { alpha: ['k-done-run'] } } }),
    observe,
  });
  assert.equal((await app.track({
    agent: 'alpha', key: 'k-done-run', sessionId: 'sid-run', action: 'track', runId: 'run-1',
  }, { headers: { 'x-hub-work': '1' } })).status, 200);

  state.row = { ...state.row, hasActiveRun: false };
  state.status = 'done';
  state.activeRunId = null;
  state.endedAt = NOW - 5000;
  let result = await app.get();
  assert.equal(result.body.following.length, 1);
  assert.equal(result.body.following[0].status, 'settling');

  state.endedAt = NOW - 30000;
  result = await app.get();
  assert.equal(result.body.following[0].status, 'missing');
});

test('following is opt-in and survives only while explicitly tracked', async t => {
  const active = makeRow('k-track', 'sid-track', { updatedAt: NOW - 1000, hasActiveRun: true, label: 'Seguimiento' });
  const link = makeLink('alpha', {
    rows: [active],
    describe: () => active,
    artifacts: () => [],
  });
  const observe = () => ({
    connected: true,
    stale: false,
    activeRunId: 'run-1',
    runs: [{ runId: 'run-1', status: 'running', updatedAt: NOW - 1000 }],
  });
  const app = await start(t, {
    links: [link],
    access: makeAccess({ agents: { ana: ['alpha'] }, keys: { ana: { alpha: ['k-track'] } } }),
    observe,
  });

  let result = await app.get();
  assert.deepEqual(result.body.following, []);

  const body = { agent: 'alpha', key: 'k-track', sessionId: 'sid-track', action: 'track', runId: 'run-1' };
  const tracked = await app.track(body, { headers: { 'x-hub-work': '1' } });
  assert.equal(tracked.status, 200);
  assert.deepEqual(tracked.body, { ok: true });

  result = await app.get();
  assert.equal(result.body.following.length, 1);
  assert.deepEqual(
    (({ agent, key, sessionId, title, status, runId }) => ({ agent, key, sessionId, title, status, runId }))(result.body.following[0]),
    { agent: 'alpha', key: 'k-track', sessionId: 'sid-track', title: 'Seguimiento', status: 'waiting', runId: 'run-1' },
  );

  const untracked = await app.track({ ...body, action: 'untrack' }, { headers: { 'x-hub-work': '1' } });
  assert.equal(untracked.status, 200);
  assert.deepEqual(untracked.body, { ok: true });
  result = await app.get();
  assert.deepEqual(result.body.following, []);
});

test('track endpoint rejects cross-site, untyped, unauthorized and stale-run requests', async t => {
  const active = makeRow('k-guard', 'sid-guard', { updatedAt: NOW - 1000, hasActiveRun: true, label: 'Guardia' });
  const link = makeLink('alpha', {
    rows: [active],
    describe: () => active,
    artifacts: () => [],
  });
  const observe = () => ({
    connected: true,
    stale: false,
    activeRunId: 'run-1',
    runs: [{ runId: 'run-1', status: 'running', updatedAt: NOW - 1000 }],
  });
  const app = await start(t, {
    links: [link],
    access: makeAccess({ agents: { ana: ['alpha'] }, keys: { ana: { alpha: ['k-guard'] } } }),
    observe,
  });
  const body = { agent: 'alpha', key: 'k-guard', sessionId: 'sid-guard', action: 'track', runId: 'run-1' };

  assert.equal((await app.track(body)).status, 403);
  assert.equal((await app.track(body, { headers: { 'x-hub-work': '1', 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal((await app.track(body, { headers: { 'x-hub-work': '1', 'content-type': 'text/plain' } })).status, 403);
  assert.equal((await app.track({ ...body, runId: undefined }, { headers: { 'x-hub-work': '1' } })).status, 400);
  assert.equal((await app.track({ ...body, runId: 'run-old' }, { headers: { 'x-hub-work': '1' } })).status, 409);
  assert.equal((await app.track({ ...body, key: 'k-unknown' }, { headers: { 'x-hub-work': '1' } })).status, 403);
  assert.equal((await app.track(body, { headers: { 'x-hub-work': '1' } })).status, 200);

  const result = await app.get();
  assert.equal(result.body.following.length, 1);
});

test('active entries are not trackable without a fresh connected observation', async t => {
  const active = makeRow('k-blind', 'sid-blind', { updatedAt: NOW - 1000, hasActiveRun: true, label: 'Sin observación' });
  const link = makeLink('alpha', {
    rows: [active],
    describe: () => active,
    artifacts: () => [],
  });
  const app = await start(t, {
    links: [link],
    access: makeAccess({ agents: { ana: ['alpha'] }, keys: { ana: { alpha: ['k-blind'] } } }),
    observe: () => undefined,
  });

  const { body } = await app.get();
  assert.equal(body.active.length, 1);
  assert.equal(body.active[0].trackable, false);
  assert.equal(Object.hasOwn(body.active[0], 'runId'), false);

  assert.equal((await app.track({
    agent: 'alpha', key: 'k-blind', sessionId: 'sid-blind', action: 'track', runId: 'run-1',
  }, { headers: { 'x-hub-work': '1' } })).status, 409);
});

test('disabled inbox fails closed', async t => {
  const link = makeLink('alpha', { rows: [], describe: () => null, artifacts: () => [] });
  const app = await start(t, {
    enabled: false,
    links: [link],
    access: makeAccess({ agents: { ana: ['alpha'] }, keys: { ana: { alpha: [] } } }),
    observe: () => ({ connected: true, stale: false, activeRunId: null, runs: [] }),
  });

  const { status, body } = await app.get();
  assert.equal(status, 403);
  assert.match(body.error, /no está habilitado/);
});
