'use strict';

// Gateway-owned input custody, not a second queue. Verified against OpenClaw
// 2026.10.3: a pending state alone is not proof of an executable queued turn.
const validString = (value, max) => typeof value === 'string' && !!value.trim() && value.length <= max && !/[\u0000-\u001f]/.test(value);
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const rpcError = (response, fallback) => Object.assign(new Error(response?.error?.message || fallback), { code: response?.error?.code || 'UNAVAILABLE' });

async function readMessageQueue(link, key, options = {}) {
  const agentId = link.cfg.gatewayAgentId || 'main';
  const runIds = [...new Set(options.runIds || [])].filter(id => validString(id, 256)).slice(0, 50);
  const params = { sessionKey: key, agentId, limit: 20, maxChars: 8192, maxBytes: 8192,
    ...(runIds.length ? { inputRunIds: runIds } : {}) };
  const first = await link.req('chat.history', params, 10000);
  if (!first.ok) throw rpcError(first, 'No se pudo consultar la cola');
  let current = first.payload || {};
  const sessionId = current.sessionId || null;
  let pending = current.pendingInputs;
  const supported = !!pending && Array.isArray(pending.items) && count(pending.queuedCount) !== null;
  const items = new Map();
  const add = page => { for (const item of page?.items || []) if (item && validString(item.id, 256)) items.set(item.id, item); };
  add(pending);
  let before = count(pending?.nextBefore), pages = 1;
  const seen = new Set();
  while (before && pages < (options.maxPages || 5) && !seen.has(before)) {
    seen.add(before);
    const next = await link.req('chat.history', { ...params, pendingBefore: before }, 10000);
    if (!next.ok) throw rpcError(next, 'No se pudieron consultar todos los pendientes');
    if (next.payload?.sessionId !== sessionId) throw Object.assign(new Error('La conversación ha cambiado. Vuelve a abrirla.'), { code: 'SESSION_CHANGED' });
    add(next.payload?.pendingInputs);
    before = count(next.payload?.pendingInputs?.nextBefore); pages++;
  }
  if (pages > 1) {
    // Paging is not atomic. Reconcile displayed executable IDs against fresh,
    // exact receipts instead of leaving a completed older page cancellable.
    const known = [...new Set([...runIds, ...[...items.values()].filter(item => item.queued === true).map(item => item.runId)])].filter(id => validString(id, 256));
    const receipts = new Map();
    for (let offset = 0; offset < Math.max(known.length, 1); offset += 50) {
      const batch = known.slice(offset, offset + 50);
      const refreshed = await link.req('chat.history', { ...params, ...(batch.length ? { inputRunIds: batch } : {}) }, 10000);
      if (!refreshed.ok) throw rpcError(refreshed, 'No se pudo confirmar la cola');
      if (refreshed.payload?.sessionId !== sessionId) throw Object.assign(new Error('La conversación ha cambiado. Vuelve a abrirla.'), { code: 'SESSION_CHANGED' });
      current = refreshed.payload || {}; pending = current.pendingInputs;
      for (const receipt of current.inputReceipts || []) receipts.set(receipt.runId, receipt);
    }
    for (const [id, item] of items) {
      const receipt = receipts.get(item.runId);
      if (receipt?.state === 'consumed' || receipt?.cancelled) items.delete(id);
      else if (item.queued && receipt?.queued !== true) items.set(id, { ...item, queued: false });
    }
    // A new head can insert an unseen gap ahead of the original pages. Do not
    // call that merged view complete until a subsequent read covers it.
    const refreshedCursor = count(pending?.nextBefore);
    if (refreshedCursor && pending?.items?.some(item => !items.has(item.id))) before = refreshedCursor;
    add(pending);
  }
  // queuedCount counts cancellation identities, including an adopted follow-up
  // until it settles. Only unconsumed pending inputs prove that it still waits.
  const nativeQueuedCount = count(pending?.queuedCount);
  const available = supported && !!pending && Array.isArray(pending.items) && nativeQueuedCount !== null;
  const hasMore = !!before;
  const queuedCountExact = available && (!hasMore || nativeQueuedCount === 0);
  const normalize = options.normalizeContent || (content => ({ text: typeof content === 'string' ? content : '' }));
  const projected = [...items.values()].filter(item => item.state !== 'cancelled').map(item => {
    const queued = item.state === 'queued' && item.queued === true && nativeQueuedCount !== 0;
    const text = normalize(item.message?.content).text || '';
    const runId = validString(item.runId, 256) ? item.runId : null;
    return { id: item.id, runId, acceptedAt: Number.isFinite(item.acceptedAt) ? item.acceptedAt : 0,
      state: item.state === 'interrupted' ? 'interrupted' : 'queued', queued,
      text: text.slice(0, 8192) || 'Mensaje con adjuntos', canRemove: available && queued && !!runId && !!sessionId };
  }).sort((a, b) => a.acceptedAt - b.acceptedAt || a.id.localeCompare(b.id));
  const info = current.sessionInfo;
  const waiting = projected.filter(item => item.queued).length;
  return { available, sessionId, queuedCount: queuedCountExact ? waiting : null,
    queuedCountExact, queuedCountLowerBound: available ? waiting : null, nativeQueuedCount,
    items: projected, hasMore, total: count(pending?.total),
    hasActiveRun: typeof info?.hasActiveRun === 'boolean' ? info.hasActiveRun : null,
    activeRunIds: Array.isArray(info?.activeRunIds) ? info.activeRunIds.filter(id => validString(id, 256)).slice(0, 50) : [],
    inputReceipts: Array.isArray(current.inputReceipts) ? current.inputReceipts : [], checkedAt: Date.now() };
}

function mountMessageQueue(app, options) {
  const { getLink, requireAuth } = options;
  function fail(res, error, fallback) {
    const code = error?.code;
    const status = ['FORBIDDEN', 'PERMISSION_DENIED', 'UNAUTHORIZED'].includes(code) ? 403
      : code === 'SESSION_CHANGED' ? 409 : code === 'INVALID_REQUEST' ? 400 : 502;
    const diagnostic = options.diagnosticFromError?.(error, { message: fallback, terminal: false });
    return res.status(status).json({ error: diagnostic?.message || fallback, ...(code ? { code } : {}), ...(diagnostic ? { diagnostic } : {}) });
  }
  async function target(req, res, source) {
    const link = getLink(source.agent);
    if (!link || !validString(source.key, 1024)) { res.status(400).json({ error: 'Agente o sesión inválidos' }); return null; }
    const key = source.key, owner = link.cfg.gatewayAgentId || 'main';
    if (key.startsWith('agent:') && !key.startsWith('agent:' + owner + ':')) { res.status(403).json({ error: 'La sesión no pertenece a este agente' }); return null; }
    if (options.authorizeSession && !await options.authorizeSession(req, link, key)) { res.status(403).json({ error: 'No tienes acceso a esta sesión' }); return null; }
    return { link, key };
  }
  app.get('/api/queue', requireAuth, async (req, res) => {
    try {
      const scoped = await target(req, res, req.query); if (!scoped) return;
      res.setHeader('Cache-Control', 'no-store');
      res.json(await readMessageQueue(scoped.link, scoped.key, { normalizeContent: options.normalizeContent }));
    } catch (error) { fail(res, error, 'No se puede confirmar la cola. Vuelve a intentarlo.'); }
  });
  app.post('/api/queue/remove', requireAuth, async (req, res) => {
    try {
      const source = req.body || {};
      if (!validString(source.runId, 256) || !validString(source.sessionId, 512)) return res.status(400).json({ error: 'Falta el mensaje o la conversación exacta' });
      const scoped = await target(req, res, source); if (!scoped) return;
      const { link, key } = scoped;
      const snapshot = await readMessageQueue(link, key, { runIds: [source.runId], maxPages: 1 });
      if (snapshot.sessionId !== source.sessionId) return res.status(409).json({ error: 'La conversación ha cambiado. Vuelve a abrirla.', code: 'SESSION_CHANGED' });
      const receipt = snapshot.inputReceipts.find(item => item.runId === source.runId);
      const queued = receipt?.state === 'pending' && receipt.queued === true && !receipt.cancelled;
      if (!snapshot.available || !queued) return res.json({ ok: true, removed: false });
      // This native flag is a race guard: once consumed/started it returns
      // aborted:false rather than stopping the active turn. Never fall back to Stop.
      const result = await link.req('chat.abort', { sessionKey: key, agentId: link.cfg.gatewayAgentId || 'main',
        runId: source.runId, discardPendingInput: true }, 15000);
      if (!result.ok) throw rpcError(result, 'No se pudo quitar el mensaje');
      res.json({ ok: true, removed: result.payload?.aborted === true && result.payload?.runIds?.includes(source.runId) === true });
    } catch (error) { fail(res, error, 'No se pudo confirmar la retirada. Actualiza la cola antes de reintentarlo.'); }
  });
}

module.exports = { readMessageQueue, mountMessageQueue };
