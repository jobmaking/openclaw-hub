'use strict';
const { createHash } = require('node:crypto');
const valid = (v, max = 1024) => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);
const count = v => Number.isSafeInteger(v) && v >= 0 ? v : null;
const stamp = v => typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
// Model IDs, not labels or auth/profile IDs. Never forward arbitrary native strings.
const modelId = v => typeof v === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/+-]{0,159}$/.test(v) ? v : null;
const emptyTokens = reason => ({ status: 'unavailable', input: null, output: null, cacheRead: null, cacheWrite: null, total: null, updatedAt: null, partial: true, reason });
const subscription = (status = 'unavailable', reason = 'La cuota de suscripción no está disponible.') => ({
  status, plan: null, windows: [], updatedAt: null, shared: true, scope: null, credentialType: null, reason });
// usage.status is ambient and unscoped: never use it here. models.authStatus is
// agent-scoped and its provider usage is suitable only for the provider's OAuth/
// token subscription, never for API-key billing or an explicit unknown profile.
function projectSubscription(payload, row) {
  if (row.authProfileId || row.authProfileOverride) return subscription('unavailable', 'La conversación usa una credencial explícita cuya cuota no se puede vincular con seguridad.');
  if (row.modelProvider !== 'openai') return subscription('unsupported', 'Este proveedor no ofrece cuota de suscripción OpenAI.');
  const provider = Array.isArray(payload?.providers) ? payload.providers.find(p => p?.provider === 'openai') : null;
  if (!provider) return subscription();
  const profiles = Array.isArray(provider.profiles) ? provider.profiles : [];
  const credentialType = profiles.some(p => p?.type === 'oauth') ? 'oauth' : profiles.some(p => p?.type === 'token') ? 'token' : null;
  if (!credentialType) return subscription('unsupported', 'La credencial actual no es una suscripción OAuth/token.');
  const usage = provider.usage;
  if (!usage || usage.providerId !== 'openai') return subscription('refreshing', 'El gateway está actualizando la cuota OpenAI; vuelve a consultar en unos segundos.');
  const windows = Array.isArray(usage.windows) ? usage.windows.slice(0, 8).map(w => ({
    label: typeof w?.label === 'string' && w.label.length <= 60 ? w.label : null,
    usedPercent: typeof w?.usedPercent === 'number' && Number.isFinite(w.usedPercent) && w.usedPercent >= 0 && w.usedPercent <= 100 ? w.usedPercent : null,
    resetAt: stamp(w?.resetAt)
  })) : [];
  return { status: 'ready', plan: typeof usage.plan === 'string' && /^[a-zA-Z0-9 ._+-]{1,60}$/.test(usage.plan) ? usage.plan : null,
    windows, updatedAt: stamp(payload.ts), shared: true, scope: 'agent-provider', credentialType, reason: null };
}
function identity(row) {
  return createHash('sha256').update(JSON.stringify([row.sessionId, row.updatedAt, row.modelProvider, row.model,
    row.providerOverride, row.modelOverride, row.authProfileOverride, row.authProfileId, row.thinkingLevel])).digest('hex');
}
function projectTokens(payload, key, agentId, row, now) {
  const entries = payload?.sessions;
  if (!Array.isArray(entries) || entries.length !== 1) return emptyTokens('No hay un registro único de consumo para esta conversación.');
  const entry = entries[0];
  if (entry.key !== key || entry.agentId !== agentId || !row.sessionId || entry.sessionId !== row.sessionId
      || entry.scope !== 'instance') return emptyTokens('No se pudo verificar el ámbito del consumo.');
  if (!entry.usage || entry.computing) return { ...emptyTokens('El gateway está calculando el consumo registrado.'), status: 'refreshing' };
  const u = entry.usage;
  const updatedAt = stamp(payload.updatedAt) ?? stamp(u.computedAt);
  if (updatedAt && updatedAt > now + 60000) return emptyTokens('El registro de consumo tiene una fecha no válida.');
  const stale = !updatedAt || now - updatedAt > 120000;
  const values = { input: count(u.input), output: count(u.output), cacheRead: count(u.cacheRead), cacheWrite: count(u.cacheWrite), total: count(u.totalTokens) };
  const cache = payload.cacheStatus?.status;
  if (cache && !['fresh', 'partial', 'stale', 'refreshing'].includes(cache)) return emptyTokens('Estado de consumo no compatible.');
  const partial = Object.values(values).some(v => v === null) || cache !== 'fresh';
  return { status: stale || ['stale', 'refreshing'].includes(cache) ? 'refreshing' : 'ready', ...values, updatedAt, partial,
    reason: stale ? 'Mostrando la última foto registrada mientras el gateway actualiza el consumo.' : partial ? 'Datos parciales del consumo registrado; pueden faltar registros pendientes.' : null };
}
function mountUsageRoutes(app, { getLink, requireAuth, access, publicTenant, now = Date.now, ttlMs = 5000, maxEntries = 128 }) {
  // Cache is bounded and contains ONLY projected token counts, never native payloads.
  const cache = new Map();
  const readSubscription = async (link, row) => {
    // Some compatible gateways omit methods from the advertised feature list.
    // Attempt the read-only RPC; unsupported methods fail closed below.
    try {
      const result = await link.req('models.authStatus', { agentId: link.cfg.gatewayAgentId || 'main' }, 15000);
      return result.ok ? projectSubscription(result.payload, row) : subscription();
    } catch { return subscription(); }
  };
  const readTokens = (link, key, row) => {
    const agentId = link.cfg.gatewayAgentId || 'main';
    const id = JSON.stringify([link.id, key, identity(row)]);
    const old = cache.get(id);
    if (old && old.link === link && old.expires > now()) return old.promise;
    if (cache.size >= maxEntries) cache.delete(cache.keys().next().value);
    const value = { link, expires: now() + ttlMs };
    value.promise = (async () => {
      // Advertised methods are not exhaustive in every compatible build.
      try {
        const result = await link.req('sessions.usage', { key, agentId, range: 'all', groupBy: 'instance', limit: 1, includeContextWeight: false }, 15000);
        if (!result.ok) return emptyTokens('El consumo registrado no está disponible.');
        return projectTokens(result.payload, key, agentId, row, now());
      } catch { return emptyTokens('El consumo registrado no está disponible.'); }
    })();
    cache.set(id, value);
    return value.promise;
  };
  app.get('/api/usage', requireAuth, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const deny = () => res.status(403).json({ error: 'No tienes acceso a este recurso', code: 'FORBIDDEN' });
    if (publicTenant) return deny();
    const { agent: agentId, key } = req.query;
    if (!valid(agentId, 80) || !valid(key)) return res.status(400).json({ error: 'Agente o conversación no válidos' });
    const link = getLink(agentId);
    if (!link || !access.canAgent(req.user, link.id)) return deny();
    let authorized;
    try { authorized = await access.authorize(req.user, link, key); } catch { return deny(); }
    if (!authorized) return deny();
    const response = { agentId: link.id, key, provider: null, model: null, subscription: subscription(), tokens: emptyTokens('El consumo registrado no está disponible.') };
    try {
      // Fresh description on EVERY request: never reuse settings/account identity.
      const described = await link.req('sessions.describe', { key }, 8000);
      if (!described.ok) return res.json(response);
      const row = described.payload?.session;
      if (!access.validRow(link, key, row)) return deny();
      response.provider = modelId(row.modelProvider);
      response.model = modelId(row.model);
      response.tokens = await readTokens(link, key, row);
      response.subscription = await readSubscription(link, row);
      // A switch/reset while usage was in flight must not publish an old snapshot.
      const check = await link.req('sessions.describe', { key }, 8000);
      if (!check.ok || !access.validRow(link, key, check.payload?.session) || identity(check.payload.session) !== identity(row)) {
        response.provider = null; response.model = null;
        response.tokens = emptyTokens('La conversación cambió; actualiza para consultar su consumo.');
        response.subscription = subscription('unavailable', 'La conversación cambió; actualiza para consultar su cuota.');
      }
      return res.json(response);
    } catch { response.tokens = emptyTokens('El consumo registrado no está disponible.'); return res.json(response); }
  });
}
module.exports = { mountUsageRoutes, projectTokens, projectSubscription };
