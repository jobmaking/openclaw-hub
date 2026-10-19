// Real HTTP routes, authenticated session checks and a native-style media server.
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const express = require('express');
const { diagnosticFrom, createRedactor } = require('../lib/gateway-observability');
let mountArtifactRoutes;
try { ({ mountArtifactRoutes } = require(process.env.HUB_ARTIFACT_MODULE || '../lib/artifact-routes')); } catch {}
let count = 0, failures = 0;
const calls = [];
const check = async (name, fn) => { count++; try { await fn(); console.log('PASS ' + name); } catch (error) { failures++; console.log('FAIL ' + name + ' · ' + error.message); } };
const content = Buffer.from('Vídeo o documento remoto, datos originales áéí.');
let externalCalls = 0, lastHeaders;
const media = http.createServer((req, res) => {
  lastHeaders = req.headers;
  if (req.url.startsWith('/external')) { externalCalls++; res.end('not allowed'); return; }
  if (req.url.startsWith('/api/artifacts/download/redirect')) { res.writeHead(302, { Location: '/external' }); res.end(); return; }
  if (!req.url.startsWith('/api/artifacts/download/') && !req.url.startsWith('/__openclaw__/media/')) { res.writeHead(404); res.end(); return; }
  const range = req.headers.range;
  if (range) { res.writeHead(206, { 'Content-Type': 'application/octet-stream', 'Content-Range': 'bytes 0-7/' + content.length, 'Content-Length': 8, 'Accept-Ranges': 'bytes' }); res.end(content.subarray(0, 8)); return; }
  res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': content.length }); res.end(content);
});
media.listen(0, '127.0.0.1'); await once(media, 'listening');
const cfg = { id: 'bu', gatewayAgentId: 'main', url: 'ws://127.0.0.1:' + media.address().port + '/ws', token: 'native-owner-credential-should-never-leak' };
let behavior = 'normal';
const link = { cfg, async req(method, params) {
  calls.push({ method, params });
  if (method === 'sessions.describe') return behavior === 'denied' ? { ok: false, error: { code: 'FORBIDDEN', message: 'No access' } } : { ok: true, payload: { session: { key: params.key, agentId: 'main' } } };
  if (method === 'artifacts.list') {
    if (behavior === 'old-gateway') return { ok: false, error: { code: 'INVALID_REQUEST', message: 'Unsupported messageRole', details: { authorization: 'Bearer ' + cfg.token } } };
    return { ok: true, payload: { artifacts: [{ id: 'bytes', title: 'Informe áé.txt', mimeType: 'text/plain', sizeBytes: content.length, download: { mode: 'bytes' } }, { id: 'unsupported', title: 'Referencia', download: { mode: 'unsupported' } }] } };
  }
  if (method === 'artifacts.download') {
    const artifact = { id: params.artifactId, title: 'Informe áé.txt', mimeType: 'text/plain', sizeBytes: content.length, download: { mode: 'bytes' } };
    if (params.artifactId === 'unsupported') return { ok: false, error: { code: 'INVALID_REQUEST', message: 'artifact download is unsupported', details: { type: 'artifact_download_unsupported' } } };
    if (params.artifactId === 'invalid-bytes') return { ok: true, payload: { artifact, encoding: 'base64', data: 'not-base64!!' } };
    if (params.artifactId === 'invalid-padding') return { ok: true, payload: { artifact, encoding: 'base64', data: 'AA=A' } };
    if (params.artifactId === 'large-bytes') { const large = Buffer.alloc(8 * 1024 * 1024, 65); return { ok: true, payload: { artifact: { ...artifact, sizeBytes: large.length }, encoding: 'base64', data: large.toString('base64') } }; }
    if (params.artifactId === 'incomplete') return { ok: true, payload: { artifact: { ...artifact, sizeBytes: content.length + 1 }, encoding: 'base64', data: content.toString('base64') } };
    if (params.artifactId === 'active-html') return { ok: true, payload: { artifact: { ...artifact, mimeType: 'text/html' }, encoding: 'base64', data: content.toString('base64') } };
    if (params.artifactId.startsWith('url')) return { ok: true, payload: { artifact: { ...artifact, download: { mode: 'url' } }, url: params.artifactId === 'url-external' ? 'http://127.0.0.1:1/external' : params.artifactId === 'url-wrong-path' ? '/api/config' : params.artifactId === 'url-redirect' ? '/api/artifacts/download/redirect' : '/api/artifacts/download/exact-connection/exact-resource?ticket=short-lived' } };
    return { ok: true, payload: { artifact, encoding: 'base64', data: content.toString('base64') } };
  }
  if (method === 'sessions.files.get') {
    const raw = behavior === 'too-large' ? 'x'.repeat(256 * 1024 + 1) : content.toString('utf8');
    return { ok: true, payload: { file: { path: params.path, workspacePath: behavior === 'private-alias' ? 'private/ACCESS.md' : params.path, name: 'Informe áé.txt', mimeType: 'text/plain', size: Buffer.byteLength(raw), previewKind: 'text', contentEncoding: 'utf8', content: raw } } };
  }
  return { ok: false, error: { message: 'Unknown method' } };
} };
const app = express(); app.use((req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
if (mountArtifactRoutes) mountArtifactRoutes(app, { getLink: id => id === 'bu' ? link : null, agents: [cfg], requireAuth: (req, res, next) => req.headers.cookie === 'fixture=authenticated' ? next() : res.status(401).json({ error: 'Unauthorized' }), diagnosticFromError: (error, context) => diagnosticFrom(error, context, createRedactor([cfg.token])) });
app.use((req, res) => res.status(404).json({ error: 'Route unavailable' }));
const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
const base = 'http://127.0.0.1:' + server.address().port;
const key = 'agent:main:dashboard:artifacts';
const get = (route, params = {}, headers = {}) => fetch(base + route + '?' + new URLSearchParams({ agent: 'bu', key, ...params }), { headers: { Cookie: 'fixture=authenticated', ...headers }, redirect: 'manual' });
try {
  await check('artifact routes are part of the release', () => assert.equal(typeof mountArtifactRoutes, 'function'));
  await check('downloads require Hub authentication', async () => assert.equal((await fetch(base + '/api/artifacts?agent=bu&key=' + encodeURIComponent(key))).status, 401));
  await check('unknown agents are refused before RPC', async () => { const before = calls.length; assert.equal((await get('/api/artifacts', { agent: 'foreign' })).status, 400); assert.equal(calls.length, before); });
  await check('foreign Gateway agent sessions are refused before RPC', async () => { const before = calls.length; assert.equal((await get('/api/artifacts', { key: 'agent:foreign:main' })).status, 403); assert.equal(calls.length, before); });
  await check('current Gateway session permission gates every read', async () => { behavior = 'denied'; assert.equal((await get('/api/artifacts')).status, 403); behavior = 'normal'; });
  await check('artifact listing is assistant-only, explicit and scoped', async () => {
    const response = await get('/api/artifacts'); assert.equal(response.status, 200); const value = await response.json();
    assert.equal(value.artifacts[0].downloadSupported, true); assert.equal(value.artifacts[1].downloadSupported, false);
    assert.deepEqual(calls.at(-1), { method: 'artifacts.list', params: { sessionKey: key, agentId: 'main', messageRole: 'assistant' } });
    assert.equal(JSON.stringify(value).includes(cfg.token), false);
  });
  await check('base64 transport returns original complete bytes and Unicode name', async () => {
    const response = await get('/api/artifact-download', { id: 'bytes' }); assert.equal(response.status, 200); assert.deepEqual(Buffer.from(await response.arrayBuffer()), content);
    assert.match(response.headers.get('content-disposition'), /filename\*=UTF-8''Informe%20%C3%A1%C3%A9.txt/); assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(calls.at(-1).params.transport, 'http'); assert.equal(calls.at(-1).params.messageRole, 'assistant');
  });
  await check('active HTML is attachment/octet-stream, never executable same-origin', async () => { const response = await get('/api/artifact-download', { id: 'active-html' }); assert.equal(response.headers.get('content-type'), 'application/octet-stream'); assert.match(response.headers.get('content-disposition'), /^attachment/); assert.match(response.headers.get('content-security-policy'), /sandbox/); await response.arrayBuffer(); });
  await check('corrupt base64 is a readable failure, not a fake download', async () => { const response = await get('/api/artifact-download', { id: 'invalid-bytes' }); assert.equal(response.status, 502); assert.match((await response.json()).error, /inválidos/); });
  await check('invalid base64 padding cannot hide incomplete data', async () => { const response = await get('/api/artifact-download', { id: 'invalid-padding' }); assert.equal(response.status, 502); });
  await check('large native base64 transfer is complete without regex recursion', async () => { const response = await get('/api/artifact-download', { id: 'large-bytes' }); assert.equal(response.status, 200); assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.alloc(8 * 1024 * 1024, 65)); });
  await check('incomplete file transfer is refused', async () => { const response = await get('/api/artifact-download', { id: 'incomplete' }); assert.equal(response.status, 502); assert.match((await response.json()).error, /incompleto/); });
  await check('native unsupported-download details are preserved', async () => { const response = await get('/api/artifact-download', { id: 'unsupported' }); assert.equal(response.status, 400); assert.equal((await response.json()).diagnostic.details.type, 'artifact_download_unsupported'); });
  await check('signed native HTTP transport preserves bytes and never sends owner credential', async () => { const response = await get('/api/artifact-download', { id: 'url-file' }); assert.equal(response.status, 200); assert.deepEqual(Buffer.from(await response.arrayBuffer()), content); assert.equal(lastHeaders.authorization, undefined); assert.equal(lastHeaders.cookie, undefined); });
  await check('single native byte ranges remain real 206 responses', async () => { const response = await get('/api/artifact-download', { id: 'url-file' }, { Range: 'bytes=0-7' }); assert.equal(response.status, 206); assert.deepEqual(Buffer.from(await response.arrayBuffer()), content.subarray(0, 8)); assert.equal(response.headers.get('content-range'), 'bytes 0-7/' + content.length); });
  await check('multiple ranges are refused explicitly', async () => assert.equal((await get('/api/artifact-download', { id: 'url-file' }, { Range: 'bytes=0-1,3-4' })).status, 416));
  await check('foreign HTTP URLs cannot turn the Hub into an arbitrary proxy', async () => { const response = await get('/api/artifact-download', { id: 'url-external' }); assert.equal(response.status, 502); assert.match((await response.json()).error, /mismo origen/); });
  await check('signed downloads cannot target unrelated Gateway API routes', async () => assert.equal((await get('/api/artifact-download', { id: 'url-wrong-path' })).status, 502));
  await check('HTTP redirects are not followed to other resources', async () => { assert.equal((await get('/api/artifact-download', { id: 'url-redirect' })).status, 502); assert.equal(externalCalls, 0); });
  await check('older Gateway rejects the real filter visibly, no unfiltered fallback', async () => { behavior = 'old-gateway'; const before = calls.length; const response = await get('/api/artifacts'); assert.equal(response.status, 400); const value = await response.json(); assert.match(value.error, /Unsupported messageRole/); assert.equal(value.diagnostic.details.authorization, '[redacted]'); assert.equal(JSON.stringify(value).includes(cfg.token), false); assert.equal(calls.slice(before).filter(item => item.method === 'artifacts.list').length, 1); behavior = 'normal'; });
  await check('remote published text uses the current session reader without a mount', async () => {
    const response = await get('/api/session-file', { path: 'reports/Informe áé.txt' }); assert.equal(response.status, 200); assert.deepEqual(Buffer.from(await response.arrayBuffer()), content);
    assert.deepEqual(calls.at(-1), { method: 'sessions.files.get', params: { sessionKey: key, agentId: 'main', path: 'reports/Informe áé.txt' } });
  });
  for (const forbidden of ['private/ACCESS.md', '../reports/file.txt', 'reports/../private/secret', '/etc/passwd', 'reports\\secret']) await check('nonpublished remote path refused: ' + forbidden, async () => { const response = await get('/api/session-file', { path: forbidden }); assert.equal(response.status, 403); });
  await check('canonical alias to private content is refused', async () => { behavior = 'private-alias'; assert.equal((await get('/api/session-file', { path: 'reports/link.txt' })).status, 403); behavior = 'normal'; });
  await check('explicit mounted/published policy is never widened by fallback', async () => { cfg.fileRoots = []; assert.equal((await get('/api/session-file', { path: 'reports/file.txt' })).status, 403); delete cfg.fileRoots; });
  await check('remote preview limit never silently truncates a download', async () => { behavior = 'too-large'; const response = await get('/api/session-file', { path: 'reports/large.txt' }); assert.equal(response.status, 422); assert.match((await response.json()).error, /completo/); behavior = 'normal'; });
} finally { await new Promise(resolve => server.close(resolve)); await new Promise(resolve => media.close(resolve)); }
console.log('RESULT ' + (count - failures) + '/' + count + ' passed'); process.exitCode = failures ? 1 : 0;
