/* Recoverable Gateway-owned pending inputs. No browser-side execution queue. */
(() => {
  'use strict';
  const entries = new Map();
  const keyOf = (agent, key) => JSON.stringify([context.user?.() || null, agent, key]);
  let context = {}, selected = null, nodes = null, pollTimer;
  const current = (agent, key) => selected?.agent === agent && selected?.key === key;
  function entry(agent, key) {
    const scope = keyOf(agent, key);
    if (!entries.has(scope)) entries.set(scope, { user: context.user?.(), snapshot: null, error: '', stale: true, revision: 0, removing: new Set(), lastAdmission: null });
    return entries.get(scope);
  }
  function mount() {
    if (nodes) return nodes;
    const root = document.getElementById('queue-badge');
    if (!root) return null;
    root.replaceChildren();
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    const title = document.createElement('span'); title.setAttribute('role', 'status'); title.setAttribute('aria-live', 'polite');
    const hint = document.createElement('span'); hint.className = 'queue-hint'; hint.textContent = 'Ver mensajes';
    const body = document.createElement('div'); body.className = 'queue-body';
    const note = document.createElement('p'); note.className = 'queue-note';
    const list = document.createElement('ul'); list.className = 'queue-list';
    const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'queue-retry'; retry.textContent = 'Actualizar';
    retry.addEventListener('click', () => { if (selected) refresh(selected.agent, selected.key, { force: true }); });
    summary.append(title, hint); body.append(note, list, retry); details.append(summary, body); root.append(details);
    nodes = { root, details, title, hint, note, list, retry, signature: '' };
    return nodes;
  }
  function connected() { return context.connected?.() !== false; }
  function render() {
    const dom = mount(); if (!dom) return;
    if (!selected?.agent || !selected.key) { dom.root.style.display = 'none'; return; }
    const value = entry(selected.agent, selected.key), snapshot = value.snapshot;
    const items = snapshot?.items || [], unknown = value.stale || !!value.error || !connected();
    const waiting = Number.isSafeInteger(snapshot?.queuedCount) ? snapshot.queuedCount : null;
    const unavailable = snapshot && snapshot.available !== true;
    const visible = items.length > 0 || waiting > 0 || !!value.error || ((unknown || unavailable) && (value.lastAdmission || context.busy?.(selected.agent, selected.key)));
    dom.root.style.display = visible ? 'block' : 'none';
    if (!visible) {
      dom.signature = '';
      if (snapshot && !unknown && !items.length) dom.list.replaceChildren();
      return;
    }
    const heading = unknown ? 'Mensajes en espera · sin confirmar'
      : unavailable ? 'El estado de la cola no está disponible'
      : waiting > 0 ? waiting + (waiting === 1 ? ' mensaje en espera' : ' mensajes en espera')
      : snapshot.hasMore && snapshot.queuedCountLowerBound > 0 ? 'Al menos ' + snapshot.queuedCountLowerBound + ' mensajes en espera'
      : items.some(item => item.state === 'interrupted') ? 'Hay mensajes interrumpidos'
      : 'Hay mensajes pendientes de confirmar';
    if (dom.title.textContent !== heading) dom.title.textContent = heading;
    const note = unknown ? 'No se puede confirmar la cola ahora. Los mensajes mostrados pueden haber cambiado; actualiza antes de quitarlos.'
      : unavailable ? 'Este agente no permite verificar qué mensajes siguen esperando. No se muestra un contador estimado.'
      : snapshot.hasMore ? 'Se muestran los pendientes más recientes. La lectura es parcial: la cantidad indica solo los mensajes confirmados en esta vista.'
      : 'Solo puedes quitar los mensajes que todavía no hayan empezado.';
    if (dom.note.textContent !== note) dom.note.textContent = note;
    dom.retry.disabled = !!value.inflight;
    dom.root.classList.toggle('queue-uncertain', unknown || unavailable);
    const signature = JSON.stringify([items, unknown, unavailable, [...value.removing]]);
    if (signature === dom.signature) return;
    dom.signature = signature;
    const scroll = dom.list.scrollTop;
    const previous = new Map([...dom.list.children].map(row => [row.dataset.queueId, row]));
    for (const item of items) {
      let row = previous.get(item.id);
      if (!row) {
        row = document.createElement('li'); row.dataset.queueId = item.id;
        const content = document.createElement('div'); content.className = 'queue-content';
        const label = document.createElement('span'); label.className = 'queue-item-state';
        const text = document.createElement('p'); text.className = 'queue-text';
        const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'queue-remove';
        content.append(label, text); row.append(content, remove);
        remove.addEventListener('click', () => {
          const stored = row.queueItem, owner = row.queueOwner;
          if (stored && owner) removeItem(owner.agent, owner.key, stored);
        });
      }
      row.queueItem = item; row.queueOwner = { ...selected };
      if (item.runId) row.dataset.queueRunId = item.runId; else delete row.dataset.queueRunId;
      const label = item.queued ? 'En espera' : item.state === 'interrupted' ? 'Interrumpido · no se reenviará automáticamente' : 'Incorporación al turno sin confirmar';
      row.querySelector('.queue-item-state').textContent = label;
      const text = row.querySelector('.queue-text');
      if (text.textContent !== item.text) text.textContent = item.text;
      text.title = item.text;
      const button = row.querySelector('button');
      button.hidden = item.canRemove !== true;
      if (item.canRemove === true) button.dataset.remove = 'true'; else delete button.dataset.remove;
      button.textContent = value.removing.has(item.runId) ? 'Quitando…' : 'Quitar';
      button.disabled = unknown || unavailable || value.removing.has(item.runId);
      button.setAttribute('aria-label', 'Quitar este mensaje de la cola');
      dom.list.append(row); previous.delete(item.id);
    }
    for (const row of previous.values()) row.remove();
    dom.list.scrollTop = scroll;
  }
  function armPoll(delay = 3000) {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(() => {
      if (selected && !document.hidden && connected()) {
        const value = entry(selected.agent, selected.key), snapshot = value.snapshot;
        const recent = value.lastAdmission && Date.now() - value.lastAdmission.at < 15000;
        if (snapshot?.queuedCount > 0 || snapshot?.items?.some(item => item.state === 'queued')
            || context.busy?.(selected.agent, selected.key) || recent || value.error) refresh(selected.agent, selected.key);
      }
      armPoll(3000);
    }, delay);
  }
  async function refresh(agent, key, options = {}) {
    if (!agent || !key) return null;
    const value = entry(agent, key);
    if (value.inflight) {
      if (!options.force) return value.inflight;
      value.revision++; value.again = true;
      await value.inflight;
      if (value.again) { value.again = false; return refresh(agent, key); }
      return value.inflight || value.snapshot;
    }
    const revision = value.revision, requestedAt = performance.now();
    value.inflight = (async () => {
      try {
        const response = await (context.request || fetch)('/api/queue?' + new URLSearchParams({ agent, key }), { cache: 'no-store', signal: AbortSignal.timeout(20000) });
        const snapshot = await response.json();
        if (!response.ok || snapshot.error) throw new Error(snapshot.error || 'No se puede confirmar la cola');
        if (revision !== value.revision || value.user !== context.user?.()) return null;
        value.snapshot = snapshot; value.error = ''; value.stale = !connected();
        if (current(agent, key)) render();
        context.onSnapshot?.(agent, key, snapshot, { requestedAt });
        return snapshot;
      } catch (error) {
        if (revision !== value.revision) return null;
        value.error = error.message; value.stale = true;
        if (current(agent, key)) render();
        return null;
      } finally {
        value.inflight = null;
        if (current(agent, key)) render();
      }
    })();
    if (current(agent, key)) render();
    return value.inflight;
  }
  function schedule(agent, key) {
    if (!agent || !key || !current(agent, key)) return;
    const value = entry(agent, key);
    value.revision++; clearTimeout(value.timer);
    value.timer = setTimeout(() => refresh(agent, key, { force: true }), 120);
  }
  async function removeItem(agent, key, item) {
    const value = entry(agent, key), snapshot = value.snapshot;
    if (!current(agent, key) || value.stale || value.error || !connected() || !snapshot?.sessionId || !item.canRemove || value.removing.has(item.runId)) return;
    value.removing.add(item.runId); render();
    try {
      const response = await (context.request || fetch)('/api/queue/remove', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent, key, sessionId: snapshot.sessionId, runId: item.runId }), signal: AbortSignal.timeout(20000) });
      const result = await response.json();
      if (!response.ok || result.error) throw new Error(result.error || 'No se pudo quitar el mensaje');
      if (current(agent, key)) context.notice?.(result.removed ? 'Mensaje quitado de la cola' : 'Este mensaje ya no seguía esperando. No se ha detenido el turno activo.');
    } catch (error) {
      if (current(agent, key)) context.notice?.(error.message);
    } finally {
      value.removing.delete(item.runId);
      await refresh(agent, key, { force: true });
      if (current(agent, key)) render();
    }
  }
  window.HubQueue = {
    configure(options) { context = options; armPoll(); },
    reset() {
      for (const value of entries.values()) { value.revision++; clearTimeout(value.timer); }
      entries.clear(); selected = null;
      if (nodes) { nodes.root.style.display = 'none'; nodes.list.replaceChildren(); nodes.signature = ''; }
    },
    select(agent, key) {
      const changed = !current(agent, key); selected = { agent, key };
      if (changed && nodes) { nodes.details.open = false; nodes.signature = ''; }
      if (agent && key) { entry(agent, key).stale = true; render(); refresh(agent, key, { force: true }); }
      else render();
      if (entries.size > 80) for (const [scope, value] of entries) {
        if (entries.size <= 80) break;
        if (scope !== keyOf(agent, key) && !value.inflight && !value.removing.size) { clearTimeout(value.timer); entries.delete(scope); }
      }
    },
    refresh,
    accepted(message) {
      if (!message.agentId || !message.sessionKey) return;
      const value = entry(message.agentId, message.sessionKey);
      if (value.lastAdmission?.runId !== message.runId || !message.runId) value.lastAdmission = { runId: message.runId || null, at: Date.now() };
      schedule(message.agentId, message.sessionKey);
    },
    connection(on) {
      for (const value of entries.values()) { value.stale = true; value.revision++; }
      render();
      if (on && selected?.agent && selected.key) refresh(selected.agent, selected.key, { force: true });
    },
    consumeEvent(message) {
      if (message.type === 'gw' && (!message.agentId || message.agentId === selected?.agent)) { this.connection(message.connected); return; }
      if (['sessions', 'queue_changed', 'final', 'aborted', 'error'].includes(message.type)) {
        if (message.agentId && message.agentId !== selected?.agent) return;
        schedule(selected?.agent, message.sessionKey || selected?.key);
      }
    },
    hasPending(agent, key) {
      const snapshot = entries.get(keyOf(agent, key))?.snapshot;
      return snapshot?.queuedCount > 0 || !!snapshot?.items?.some(item => item.queued === true)
        || !!(snapshot?.hasMore && snapshot.nativeQueuedCount > 0);
    },
    hasUnconfirmed(agent, key) {
      const snapshot = entries.get(keyOf(agent, key))?.snapshot;
      return !!snapshot?.items?.some(item => item.state === 'queued' && item.queued !== true)
        || !!(snapshot?.hasMore && snapshot.queuedCountExact === false);
    },
    isActive(agent, key) { const value = entries.get(keyOf(agent, key)); return !value?.stale && !value?.error && value?.snapshot?.hasActiveRun === true; },
    latestAdmission(agent, key) { return entries.get(keyOf(agent, key))?.lastAdmission || null; },
    depth(agent, key) { const value = entries.get(keyOf(agent, key)); return value && !value.stale && !value.error ? value.snapshot?.queuedCount ?? null : null; },
    async verifyTerminal(message) {
      const value = entry(message.agentId, message.sessionKey), admission = value.lastAdmission;
      if (context.pending?.(message.agentId, message.sessionKey) || (admission && Date.now() - admission.at < 2500)) return false;
      const snapshot = await refresh(message.agentId, message.sessionKey, { force: true });
      if (context.pending?.(message.agentId, message.sessionKey) || value.lastAdmission !== admission) return false;
      return snapshot?.available === true && snapshot.hasActiveRun === false && snapshot.queuedCount === 0
        && !snapshot.items?.some(item => item.state === 'queued');
    },
  };
  document.addEventListener('visibilitychange', () => { if (!document.hidden && selected?.key) refresh(selected.agent, selected.key, { force: true }); });
})();
