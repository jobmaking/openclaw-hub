/* Scoped in-memory usage. Event-driven refresh only; no polling or persistence. */
(() => {
  'use strict';
  let api, owner = '', request, sequence = 0, returnFocus, snapshot, fetchedAt = 0, scheduled, refreshAfterRequest = false;
  const terminals = new Set();
  const $ = id => document.getElementById(id);
  const scope = c => JSON.stringify([c?.user, c?.agent, c?.key, c?.provider, c?.model]);
  const valid = c => !!(c?.user && c?.agent && c?.key && c?.enabled);
  const node = (tag, text, cls) => { const el = document.createElement(tag); if (text != null) el.textContent = text; if (cls) el.className = cls; return el; };
  const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const format = value => number(value) ? new Intl.NumberFormat('es-ES').format(value) : 'No disponible';
  function date(value) { if (value == null || value === '') return null; const d = new Date(value); return Number.isFinite(d.getTime()) ? d : null; }
  function stamp(section, value) {
    const d = date(value);
    section.append(node('p', d ? 'Actualizado: ' + d.toLocaleString() + (Date.now() - d.getTime() > 300000 ? ' · Datos antiguos; pulsa Actualizar.' : '') : 'Sin fecha de actualización.', 'usage-note'));
  }
  function label(w) {
    const raw = String(w.label || 'Ventana de uso');
    if (/^168\s*h(?:oras?)?$/i.test(raw)) return 'Semana';
    if (/^5\s*h(?:oras?)?$/i.test(raw)) return '5 h';
    return raw;
  }
  const windowsFor = sub => Array.isArray(sub?.windows) ? sub.windows.filter(w => w && number(w.usedPercent) && w.usedPercent <= 100) : [];
  function summary(sub, stale = false) {
    const el = $('usage-summary'); el.replaceChildren();
    const windows = windowsFor(sub);
    $('btn-usage').hidden = !valid(api.context()) || !windows.length;
    if (!windows.length) { close(); return; }
    for (const w of windows) {
      const item = node('span', null, 'usage-mini');
      item.append(node('span', label(w) + ' · ' + format(Math.round((100-w.usedPercent)*10)/10) + ' % restante'));
      const bar = node('span', null, 'usage-track'); const fill = node('span'); fill.style.width = (100-w.usedPercent)+'%'; bar.append(fill); item.append(bar);
      el.append(item);
    }
    const d = date(sub?.updatedAt);
    if (stale || sub?.status !== 'ready') el.append(node('span', 'Sin actualizar', 'usage-age'));
    else if (!d || Date.now()-d.getTime()>300000) el.append(node('span', d ? 'Antiguo' : 'Sin fecha', 'usage-age'));
  }
  function cancel() { refreshAfterRequest = false; sequence++; request?.abort(); request = null; }
  function close() { if ($('usage-dialog').open) $('usage-dialog').close(); }
  function reset() { cancel(); clearTimeout(scheduled); scheduled = null; close(); owner = ''; snapshot = null; fetchedAt = 0; terminals.clear(); summary(null); $('usage-content').replaceChildren(); $('usage-status').textContent = ''; $('btn-usage').hidden = true; }
  function sync() {
    const c = api.context(), next = scope(c), changed = next !== owner;
    if (changed || !valid(c)) {
      cancel(); clearTimeout(scheduled); scheduled = null; close(); snapshot = null; fetchedAt = 0; terminals.clear();
      $('usage-content').replaceChildren(); $('usage-status').textContent = ''; summary(null);
    }
    owner = next; $('btn-usage').hidden = !valid(c) || !windowsFor(snapshot?.subscription).length;
    if (changed && valid(c)) schedule(0);
  }
  function schedule(delay) {
    if (scheduled != null) return;
    const selected = owner;
    scheduled = setTimeout(() => { scheduled = null; if (selected === owner) { if (request) refreshAfterRequest = true; else refresh(false); } }, delay);
  }
  function terminal(m) {
    const c = api.context();
    if (!valid(c) || m.agentId !== c.agent || m.sessionKey !== c.key) return;
    const key = m.runId || 'unidentified-' + Math.floor(Date.now()/3000);
    if (terminals.has(key)) return;
    terminals.add(key); if (terminals.size > 64) terminals.delete(terminals.values().next().value);
    schedule(Math.max(600, 3000 - (Date.now()-fetchedAt)));
  }
  function section(title, data) {
    const el = node('section'); el.append(node('h3', title));
    if (data?.status !== 'ready') el.append(node('p', ({refreshing:'Actualizando en el proveedor. Pulsa Actualizar para volver a consultar.',unsupported:'Este proveedor no ofrece esta información.',unavailable:'Información no disponible.'})[data?.status] || 'Sin datos disponibles.'));
    if (data?.reason) el.append(node('p', String(data.reason), 'usage-note'));
    return el;
  }
  function render(data) {
    const body = $('usage-content'); body.replaceChildren();
    body.append(node('p', [data.provider, data.model].filter(Boolean).join(' · '), 'usage-note'));
    const sub = data.subscription, tokens = data.tokens;
    const quota = section('Cuota de suscripción', sub);
    if (sub?.plan) quota.append(node('p', 'Plan: ' + sub.plan));
    if (sub?.scope === 'agent-provider') quota.append(node('p', 'Cuenta ' + (sub.credentialType === 'oauth' ? 'OAuth' : 'token') + ' de OpenAI configurada para este agente.', 'usage-note'));
    if (windowsFor(sub).length) {
      const windows = windowsFor(sub);
      for (const w of windows) {
        const row = node('div', null, 'usage-window');
        const remaining = Math.round((100 - w.usedPercent) * 10) / 10;
        row.append(node('strong', label(w)), node('p', format(remaining) + ' % restante'));
        { const meter = node('progress'); meter.max = 100; meter.value = remaining; meter.setAttribute('aria-label', (w.label || 'Cuota') + ': porcentaje restante'); row.append(meter); }
        const resetAt = date(w.resetAt);
        const mins = resetAt ? Math.ceil((resetAt.getTime() - Date.now()) / 60000) : 0;
        row.append(node('p', resetAt ? 'Se restablece: ' + resetAt.toLocaleString() + (mins > 0 ? ' · en ' + (mins < 60 ? mins + ' min' : Math.ceil(mins / 60) + ' h') : ' · fecha alcanzada; actualiza para comprobar') : 'Restablecimiento no disponible.', 'usage-note'));
        quota.append(row);
      }
    }
    quota.append(node('p', 'Cuota de la cuenta del proveedor, compartida con sus otros usos; no es una cuota por conversación.', 'usage-note'));
    stamp(quota, sub?.updatedAt); body.append(quota);
    const usage = section('Tokens de esta conversación', tokens);
    const hasTokenValues = ['input', 'output', 'cacheRead', 'cacheWrite', 'total'].some(key => number(tokens?.[key]));
    if (tokens?.status === 'ready' || hasTokenValues) {
      const list = node('dl', null, 'usage-tokens');
      for (const [key, label] of [['input','Entrada'],['output','Salida'],['cacheRead','Caché leída'],['cacheWrite','Caché escrita'],['total','Total registrado']]) list.append(node('dt', label), node('dd', format(tokens[key])));
      usage.append(list);
      if (tokens.partial) usage.append(node('p', 'Registro parcial: pueden faltar turnos o contadores.', 'usage-note'));
    }
    usage.append(node('p', 'Acumulado registrado de esta conversación, no el contexto actual. Los tokens no se convierten en porcentaje de cuota.', 'usage-note'));
    stamp(usage, tokens?.updatedAt); body.append(usage);
  }
  async function refresh(force = false) {
    const c = api.context(); if (!valid(c) || scope(c) !== owner || request) return;
    if (!force && fetchedAt && Date.now()-fetchedAt < 2000) { schedule(2000-(Date.now()-fetchedAt)); return; }
    cancel(); const id = sequence, selected = scope(c), controller = new AbortController(); request = controller;
    const timer = setTimeout(() => controller.abort(), 12000);
    $('usage-status').textContent = 'Consultando consumo…'; $('usage-refresh').disabled = true;
    try {
      const query = new URLSearchParams({agent: c.agent, key: c.key});
      const response = await api.fetch('/api/usage?' + query, {signal: controller.signal, cache:'no-store'});
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const data = await response.json();
      if (id !== sequence || selected !== scope(api.context()) || !valid(api.context())) return;
      if (data.agentId !== c.agent || data.key !== c.key || (c.provider && data.provider && c.provider !== data.provider) || (c.model && data.model && c.model !== data.model)) throw new Error('El ámbito de los datos ha cambiado');
      // Preserve a same-scope photo during transient provider failures, never across sync/reset.
      const retained = !windowsFor(data.subscription).length && windowsFor(snapshot?.subscription).length && ['refreshing', 'unavailable'].includes(data.subscription?.status);
      if (retained) data.subscription = {...snapshot.subscription, status:data.subscription.status, reason:'Sin actualizar: se conserva la última cuota conocida.'};
      snapshot = data; fetchedAt = Date.now(); summary(data.subscription); render(data); $('usage-status').textContent = 'Consulta completada.';
    } catch (error) {
      if (id !== sequence || selected !== scope(api.context())) return;
      summary(snapshot?.subscription, true);
      $('usage-status').textContent = controller.signal.aborted ? 'Tiempo de espera agotado. Puedes volver a intentarlo.' : 'No se pudo consultar el consumo. Puedes volver a intentarlo.';
    } finally { clearTimeout(timer); if (id === sequence) { request = null; $('usage-refresh').disabled = false; if (refreshAfterRequest) { refreshAfterRequest = false; schedule(2000); } } }
  }
  window.HubUsage = {reset, sync, terminal, init(options) {
    api = options;
    $('btn-usage').addEventListener('click', () => { sync(); if (!valid(api.context()) || !windowsFor(snapshot?.subscription).length) return; returnFocus = document.activeElement; $('usage-dialog').showModal(); if (!snapshot || Date.now()-fetchedAt > 30000) refresh(); });
    $('usage-close').addEventListener('click', close);
    $('usage-refresh').addEventListener('click', () => refresh(true));
    $('usage-dialog').addEventListener('close', () => { $('usage-refresh').disabled = false; returnFocus?.focus({preventScroll:true}); });
    for (const id of ['provider-select','model-select','effort-select']) $(id)?.addEventListener('change', close, true);
    $('model-reset')?.addEventListener('click', close, true);
    window.addEventListener('pagehide', reset);
    sync();
  }};
})();
