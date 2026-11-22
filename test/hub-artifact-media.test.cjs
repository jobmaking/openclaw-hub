'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { test } = require('node:test');
const express = require('express');
const { mountArtifactRoutes } = require('../lib/artifact-routes');

const data = Buffer.from(Array.from({ length: 96 }, (_, i) => i));
const key = 'agent:main:dashboard:media-fixture', sid = 'media-fixture-v1';
async function listen(t, server) {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  return 'http://127.0.0.1:' + server.address().port;
}

test('private media streams exact authorized attachments and supports browser byte ranges', { timeout: 12000 }, async t => {
  const upstreamRequests = [], calls = [];
  let current = sid, admitted = true, changeDuringDownload = false;
  const origin = await listen(t, http.createServer((req, res) => {
    upstreamRequests.push({ method: req.method, headers: req.headers, path: req.url });
    if (req.url.endsWith('/redirect')) { res.writeHead(302, { Location: '/elsewhere' }).end(); return; }
    if (req.url.endsWith('/unavailable')) { res.writeHead(404).end(); return; }
    const range = req.headers.range;
    if (range && !req.url.endsWith('/ignores-range')) {
      const [first, last] = range.split('=')[1].split('-');
      const start = first ? Number(first) : Math.max(0, data.length - Number(last));
      let end = first && last ? Math.min(Number(last), data.length - 1) : data.length - 1;
      if (start >= data.length || end < start) { res.writeHead(416, { 'Content-Range': 'bytes */' + data.length }).end(); return; }
      if (req.url.endsWith('/bad-range')) end--;
      res.writeHead(206, { 'Content-Type': 'application/octet-stream', 'Content-Length': end - start + 1,
        'Content-Range': 'bytes ' + start + '-' + end + '/' + data.length }).end(data.subarray(start, end + 1)); return;
    }
    res.writeHead(200, { 'Content-Type': req.url.endsWith('/wrong-type') ? 'text/html' : 'video/mp4',
      'Content-Length': req.url.endsWith('/oversized') ? 1025 : data.length }).end(data);
  }));
  const cfg = { id: 'fixture', gatewayAgentId: 'main', url: origin.replace('http:', 'ws:') + '/ws' };
  const link = { cfg, async req(method, p) {
    calls.push({ method, p });
    if (method === 'sessions.describe') return { ok: true, payload: { session: { key, agentId: 'main', sessionId: current } } };
    if (method === 'artifacts.list') return { ok: true, payload: { artifacts: [
      { id: 'image', mimeType: 'image/png', download: { mode: 'bytes' } },
      { id: 'signed', mimeType: 'video/mp4', download: { mode: 'url' } },
      { id: 'active', mimeType: 'image/svg+xml', title: 'name.png', download: { mode: 'bytes' } },
    ] } };
    assert.equal(method, 'artifacts.download');
    if (changeDuringDownload) current = 'media-fixture-v2';
    if (p.artifactId === 'not-found') return { ok: false, error: { code: 'NOT_FOUND' } };
    const { artifactId: id } = p, payload = { artifact: {
      id: id === 'wrong-id' ? 'another-id' : id, title: id === 'active' ? 'same-name.png' : 'Prueba.mp4',
      mimeType: id === 'image' ? 'image/png' : id === 'active' ? 'image/svg+xml' : 'video/mp4',
      sessionKey: id === 'wrong-session' ? 'agent:main:dashboard:other' : key,
      ...(id !== 'oversized' ? { sizeBytes: id === 'large' ? 1025 : data.length } : {}),
      download: { mode: id === 'unsupported' ? 'unsupported' : 'bytes' },
    } };
    if (['signed', 'ignores-range', 'oversized', 'unavailable', 'redirect', 'wrong-type', 'bad-range', 'wrong-origin'].includes(id)) {
      payload.url = id === 'wrong-origin' ? 'http://127.0.0.1:1/api/artifacts/download/sample' : '/api/artifacts/download/' + id;
      payload.artifact.download.mode = 'url';
    } else Object.assign(payload, { encoding: 'base64', data: data.toString('base64') });
    return { ok: true, payload };
  } };
  const options = { mediaEnabled: true, maximumBytes: 1024, getLink: id => id === cfg.id ? link : null,
    authorizeSession: (_req, _link, k) => admitted && k === key,
    requireAuth: (req, res, next) => { if (req.get('Cookie') !== 'test=member') return res.sendStatus(401); req.user = 'member'; next(); } };
  const app = express(); mountArtifactRoutes(app, options);
  const off = express(); mountArtifactRoutes(off, { ...options, mediaEnabled: false });
  const [base, disabled] = await Promise.all([listen(t, http.createServer(app)), listen(t, http.createServer(off))]);
  const get = (id, params = {}, init = {}, url = base, path = '/api/artifact-media') => fetch(url + path + '?' + new URLSearchParams({ agent: cfg.id, key, sessionId: sid, id, ...params }),
    { ...init, headers: { Cookie: 'test=member', ...init.headers }, redirect: 'error' });
  const rejected = async (response, status) => { assert.equal(response.status, status); await response.body?.cancel(); };

  await t.test('authentication, tenant and origin checks precede any gateway call', async () => {
    await rejected(await get('image', {}, { headers: { Cookie: '' } }), 401);
    await rejected(await get('image', {}, {}, disabled), 403);
    await rejected(await get('image', {}, { headers: { 'Sec-Fetch-Site': 'same-site' } }), 403);
    await rejected(await get('image', { sessionId: '' }), 400);
    const duplicated = await fetch(base+'/api/artifact-media?'+new URLSearchParams([['agent',cfg.id],['key',key],['id','image'],['sessionId',sid],['sessionId',sid]]), { headers: { Cookie: 'test=member' } });
    await rejected(duplicated, 400);
    await rejected(await get('image', { key: 'agent:foreign:dashboard:media' }), 403);
    assert.equal(calls.length, 0);
  });
  await t.test('revoked access, replaced transcript or another artifact cannot stream', async () => {
    admitted = false; await rejected(await get('signed'), 403); admitted = true;
    await rejected(await get('signed', { sessionId: 'stale' }), 409);
    await rejected(await get('wrong-id'), 404);
    await rejected(await get('wrong-session'), 404);
    await rejected(await get('not-found'), 404);
    changeDuringDownload = true; await rejected(await get('signed'), 409);
    changeDuringDownload = false; current = sid;
    assert.equal(upstreamRequests.length, 0);
  });
  await t.test('only explicitly allowed passive types are marked for display', async () => {
    const list = await get('', {}, {}, base, '/api/artifacts').then(r => r.json());
    assert.deepEqual(list.artifacts.map(a => a.mediaKind), ['image', 'video', undefined]);
    await rejected(await get('active'), 415);
    await rejected(await get('unsupported'), 415);
    const image = await get('image');
    assert.equal(image.status, 200);
    assert.equal(image.headers.get('content-type'), 'image/png');
    assert.match(image.headers.get('content-disposition'), /^inline;/);
    assert.match(image.headers.get('content-security-policy'), /^sandbox/);
    assert.equal(image.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(image.headers.get('cross-origin-resource-policy'), 'same-origin');
    assert.match(image.headers.get('cache-control'), /no-store/);
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), data);
  });
  await t.test('real 206 ranges for signed, range-ignoring and byte-only transports', async () => {
    for (const id of ['signed','ignores-range','base64']) for (const [range,start,end] of [
      ['bytes=0-1',0,1],['bytes=72-',72,95],['bytes=-8',88,95],['bytes=84-999',84,95],
    ]) {
      const response = await get(id, {}, { headers: { Range: range } });
      assert.equal(response.status, 206, id+' '+range);
      assert.equal(response.headers.get('content-range'), 'bytes '+start+'-'+end+'/96');
      assert.equal(response.headers.get('accept-ranges'), 'bytes');
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), data.subarray(start,end+1));
    }
    assert(upstreamRequests.every(r => !r.headers.authorization && !r.headers.cookie));
    assert(calls.filter(c=>c.method==='artifacts.download').every(c=>c.p.messageRole==='assistant'&&c.p.transport==='http'));
  });
  await t.test('HEAD brand/chunk metadata and unsuccessful ranges have no unexpected bytes', async () => {
    for (const id of ['signed','base64','ignores-range']) {
      const result = await get(id, {}, { method: 'HEAD' });
      assert.equal(result.status, 200); assert.equal(result.headers.get('content-length'), '96');
      assert.equal((await result.arrayBuffer()).byteLength, 0);
      const partial = await get(id, {}, { method: 'HEAD', headers: { Range: 'bytes=54-60' } });
      assert.equal(partial.status, 206); assert.equal(partial.headers.get('content-range'), 'bytes 54-60/96');
      assert.equal((await partial.arrayBuffer()).byteLength, 0);
      const end = await get(id, {}, { headers: { Range: 'bytes=96-' } });
      assert.equal(end.headers.get('content-range'), 'bytes */96'); await rejected(end, 416);
    }
    const before = calls.length;
    await rejected(await get('signed', {}, { headers: { Range: 'bytes=0-1,3-5' } }), 416);
    assert.equal(calls.length, before);
  });
  await t.test('bad or oversized upstream reads fail closed without relaying unrelated content', async () => {
    await rejected(await get('bad-range', {}, { headers: { Range: 'bytes=0-8' } }), 502);
    await rejected(await get('wrong-type'), 502);
    await rejected(await get('large'), 413);
    await rejected(await get('oversized'), 413);
    await rejected(await get('wrong-origin'), 502);
    await rejected(await get('redirect'), 502);
    assert(upstreamRequests.every(r => r.path.startsWith('/api/artifacts/download/')));
    const download = await fetch(base+'/api/artifact-download?'+new URLSearchParams({ agent:cfg.id,key,id:'image' }), { headers: { Cookie:'test=member' } });
    assert.match(download.headers.get('content-disposition'), /^attachment;/);
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), data);
  });
});
