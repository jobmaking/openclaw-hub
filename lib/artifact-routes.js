'use strict';
const http = require('node:http');
const https = require('node:https');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const path = require('node:path');

// File bytes stay on the authenticated Gateway transport. No SSH file reader,
// reusable credential in browser URLs, or new host filesystem mount is needed.
function mountArtifactRoutes(app, options) {
  const { getLink, requireAuth } = options;
  const maximumBytes = options.maximumBytes || 128 * 1024 * 1024;
  const previewBytes = 256 * 1024;
  const valid = (value, limit = 1024) => typeof value === 'string' && value.trim() && value.length <= limit && !/[\u0000-\u001f]/.test(value);
  const ownKey = (key, agentId) => !key.startsWith('agent:') || key.startsWith('agent:' + agentId + ':');
  const agentConfig = id => (options.agents || []).find(agent => agent.id === id) || getLink(id)?.cfg || {};
  function fail(res, value, fallback, status) {
    const error = value?.error || value || {};
    const diagnostic = options.diagnosticFromError?.(error, { terminal: false, message: error.message || fallback });
    const code = error.code;
    const resolvedStatus = status || (['FORBIDDEN', 'UNAUTHORIZED', 'PERMISSION_DENIED'].includes(code) ? 403 : ['NOT_FOUND', 'SESSION_NOT_FOUND'].includes(code) ? 404 : code === 'INVALID_REQUEST' ? 400 : 502);
    if (res.headersSent) { res.destroy(); return; }
    return res.status(resolvedStatus).json({ error: diagnostic?.message || error.message || fallback, ...(diagnostic ? { diagnostic } : {}), ...(code ? { code } : {}) });
  }
  async function target(req, res) {
    const id = req.query.agent;
    if (!valid(id, 80) || !getLink(id)) { fail(res, {}, 'Agente desconocido', 400); return; }
    const key = req.query.key;
    if (!valid(key)) { fail(res, {}, 'Falta una sesión válida', 400); return; }
    const cfg = agentConfig(id), gatewayAgentId = cfg.gatewayAgentId || 'main';
    if (!ownKey(key, gatewayAgentId)) { fail(res, {}, 'La sesión no pertenece a este agente', 403); return; }
    const link = getLink(id);
    if (options.authorizeSession && !await options.authorizeSession(req, link, key)) { fail(res, {}, 'No tienes acceso a esta sesión', 403); return; }
    const described = await link.req('sessions.describe', { key }, 15000);
    if (!described.ok) { fail(res, described, 'No se pudo verificar el acceso a la sesión'); return; }
    const row = described.payload?.session;
    if (!row || row.agentId && row.agentId !== gatewayAgentId || row.key && !ownKey(row.key, gatewayAgentId)) { fail(res, {}, 'La sesión no pertenece a este agente', 403); return; }
    return { id, key, cfg, gatewayAgentId, link };
  }
  const query = selected => ({ sessionKey: selected.key, agentId: selected.gatewayAgentId, messageRole: 'assistant' });
  const summary = artifact => ({
    id: String(artifact.id || ''), title: String(artifact.title || 'Archivo'),
    fileName: filename(artifact.title), type: artifact.type, mimeType: artifact.mimeType,
    ...(Number.isSafeInteger(artifact.sizeBytes) ? { sizeBytes: artifact.sizeBytes } : {}),
    downloadSupported: ['bytes', 'url'].includes(artifact.download?.mode),
    ...(artifact.download?.mode === 'unsupported' ? { reason: 'El gateway no ofrece una descarga de este contenido' } : {}),
  });
  function filename(value) {
    return path.basename(String(value || 'archivo').replace(/\\/g, '/')).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 180) || 'archivo';
  }
  function headers(res, name, mimeType, forceDownload = true) {
    const safe = filename(name), ascii = safe.replace(/[^\x20-\x7e]|["\\]/g, '_');
    const mime = typeof mimeType === 'string' && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(mimeType) ? mimeType : 'application/octet-stream';
    const passive = /^(?:image\/(?:png|jpe?g|gif|webp|avif)|audio\/[a-z0-9.+-]+|video\/[a-z0-9.+-]+|application\/pdf|text\/plain)$/i.test(mime);
    res.setHeader('Content-Type', passive ? mime : 'application/octet-stream');
    res.setHeader('Content-Disposition', (forceDownload || !passive ? 'attachment' : 'inline') + '; filename="' + ascii + '"; filename*=UTF-8\'\'' + encodeURIComponent(safe).replace(/['()*]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase()));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; frame-ancestors 'none'");
    res.setHeader('Referrer-Policy', 'no-referrer');
  }
  function bytes(base64, limit) {
    if (typeof base64 !== 'string' || base64.length > 4 * Math.ceil(limit / 3) || base64.length % 4 || /[^A-Za-z0-9+/=]/.test(base64)) throw new Error('El gateway devolvió bytes de archivo inválidos');
    const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
    if (base64.indexOf('=') !== (padding ? base64.length - padding : -1)) throw new Error('El gateway devolvió bytes de archivo inválidos');
    const buffer = Buffer.from(base64, 'base64');
    if (buffer.length > limit) throw new Error('El archivo supera el límite de transferencia');
    return buffer;
  }
  function safeGatewayUrl(value, cfg) {
    const base = new URL(cfg.url);
    base.protocol = base.protocol === 'wss:' ? 'https:' : base.protocol === 'ws:' ? 'http:' : base.protocol;
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) throw new Error('El gateway no ofrece un origen HTTP válido');
    const url = new URL(value, base);
    if (url.origin !== base.origin || url.username || url.password || url.hash || !/^\/(?:[^?#]*\/)?(?:api\/artifacts\/download\/|api\/chat\/media\/outgoing\/|__openclaw__\/media\/|__openclaw__\/assistant-media(?:\?|$))/.test(url.pathname)) throw new Error('El gateway no ofrece una descarga HTTP del mismo origen autorizada');
    return url;
  }
  async function transferUrl(req, res, selected, result) {
    const url = safeGatewayUrl(result.url, selected.cfg);
    if (req.headers.range && !/^bytes=(?:\d+-\d*|-\d+)$/.test(req.headers.range)) { fail(res, {}, 'Solo se admite un intervalo de bytes', 416); return; }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120000);
    const close = () => { if (!res.writableEnded) controller.abort(); };
    res.once('close', close);
    try {
      // Signed URLs are exact-resource grants bound to the existing WS client.
      // Never send the reusable Gateway token, follow redirects or proxy an
      // arbitrary external address supplied in a transcript.
      const upstream = await new Promise((resolve, reject) => {
        const outgoing = (url.protocol === 'https:' ? https : http).request(url, { method: req.method === 'HEAD' ? 'HEAD' : 'GET', headers: req.headers.range ? { Range: req.headers.range } : {}, signal: controller.signal }, resolve);
        outgoing.on('error', reject); outgoing.end();
      });
      if (![200, 206, 416].includes(upstream.statusCode)) { upstream.destroy(); throw new Error('Descarga no disponible en el gateway (HTTP ' + upstream.statusCode + ')'); }
      const size = Number(upstream.headers['content-length']);
      if (Number.isFinite(size) && size > maximumBytes) { upstream.destroy(); throw new Error('El archivo supera el límite de transferencia'); }
      res.status(upstream.statusCode);
      headers(res, result.artifact?.title, result.artifact?.mimeType || upstream.headers['content-type']);
      for (const name of ['content-length', 'content-range', 'accept-ranges']) if (upstream.headers[name] !== undefined) res.setHeader(name, upstream.headers[name]);
      let transferred = 0;
      const bounded = Readable.from((async function* () {
        for await (const chunk of upstream) { transferred += chunk.length; if (transferred > maximumBytes) throw new Error('Archivo demasiado grande'); yield chunk; }
      })());
      await pipeline(bounded, res);
    } finally { clearTimeout(timer); res.off('close', close); }
  }
  app.get('/api/artifacts', requireAuth, async (req, res) => {
    try {
      const selected = await target(req, res); if (!selected) return;
      const result = await selected.link.req('artifacts.list', query(selected), 60000);
      if (!result.ok) return fail(res, result, 'No se pudieron consultar los entregables');
      const artifacts = (result.payload?.artifacts || []).filter(artifact => valid(artifact.id)).map(summary);
      res.json({ artifacts });
    } catch (error) { fail(res, error, 'No se pudieron consultar los entregables'); }
  });
  app.get('/api/artifact-download', requireAuth, async (req, res) => {
    if (!valid(req.query.id)) return fail(res, {}, 'Identificador de archivo inválido', 400);
    try {
      const selected = await target(req, res); if (!selected) return;
      const result = await selected.link.req('artifacts.download', { ...query(selected), artifactId: req.query.id, transport: 'http' }, 60000);
      if (!result.ok) return fail(res, result, 'No se pudo descargar el archivo');
      const payload = result.payload || {};
      if (payload.artifact?.download?.mode === 'unsupported') return fail(res, {}, 'El gateway no admite la descarga de este archivo', 422);
      if (payload.encoding === 'base64' && payload.data !== undefined) {
        const content = bytes(payload.data, maximumBytes);
        if (Number.isSafeInteger(payload.artifact?.sizeBytes) && payload.artifact.sizeBytes !== content.length) throw new Error('El archivo recibido está incompleto');
        headers(res, payload.artifact?.title, payload.artifact?.mimeType); res.setHeader('Content-Length', content.length); return res.end(content);
      }
      if (payload.url) return await transferUrl(req, res, selected, payload);
      fail(res, {}, 'El gateway no devolvió un archivo descargable', 422);
    } catch (error) { fail(res, error, 'No se pudo descargar el archivo'); }
  });
  app.get('/api/session-file', requireAuth, async (req, res) => {
    try {
      const selected = await target(req, res); if (!selected) return;
      const raw = req.query.path;
      if (!valid(raw, 4096)) return fail(res, {}, 'Ruta de archivo inválida', 400);
      const relative = raw.replace(/^\/home\/(?:node|[a-zA-Z0-9_-]+)\/\.openclaw(?:-[a-zA-Z0-9_-]+)?\/workspace\//, '');
      if (relative.startsWith('/') || relative.includes('\\') || relative.split('/').includes('..') || !/^(?:media|tmp|reports|nas|nas_docs|docs)\//.test(relative)) return fail(res, {}, 'El archivo no está en una carpeta publicada', 403);
      // The session reader rejects symlink/hardlink escapes and keeps its own
      // current permission checks; do not widen a deliberately mounted policy.
      if (Array.isArray(selected.cfg.fileRoots)) return fail(res, {}, 'Este agente utiliza sus carpetas montadas para descargar archivos', 403);
      const result = await selected.link.req('sessions.files.get', { sessionKey: selected.key, agentId: selected.gatewayAgentId, path: relative }, 60000);
      if (!result.ok) return fail(res, result, 'No se pudo leer el archivo de esta sesión');
      const file = result.payload?.file;
      const canonical = file?.workspacePath || file?.path;
      if (!file || file.missing) return fail(res, {}, 'Archivo no encontrado', 404);
      if (canonical && (String(canonical).startsWith('/') || String(canonical).includes('\\') || String(canonical).split('/').includes('..') || !/^(?:media|tmp|reports|nas|nas_docs|docs)\//.test(canonical))) return fail(res, {}, 'La ruta resuelta no está publicada', 403);
      if (typeof file.content !== 'string' || !['utf8', 'base64'].includes(file.contentEncoding)) return fail(res, {}, 'El gateway no admite este archivo en el lector de sesión. Los medios entregados están en Entregables.', 422);
      const content = file.contentEncoding === 'base64' ? bytes(file.content, previewBytes) : Buffer.from(file.content, 'utf8');
      if (content.length > previewBytes || Number.isSafeInteger(file.size) && file.size !== content.length) return fail(res, {}, 'El gateway no entregó el archivo completo', 422);
      headers(res, file.name || relative.split('/').pop(), file.mimeType || 'text/plain', req.query.dl === '1');
      res.setHeader('Content-Length', content.length); res.end(content);
    } catch (error) { fail(res, error, 'No se pudo descargar el archivo de la sesión'); }
  });
}
module.exports = { mountArtifactRoutes };
