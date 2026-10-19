'use strict';

// Read the frontend's reconciled, ACL-filtered attention list. This is ordinary
// page JavaScript, not a preload or a renderer-to-desktop IPC bridge. Never read
// cookies, answers, drafts, tool arguments or the contents of conversations.
function readAttention() {
  if (typeof state !== 'object' || typeof questionAttentionItems !== 'function'
      || typeof openPendingQuestion !== 'function') return { status: 'incompatible' };
  if (!state.user || !document.getElementById('app') || document.getElementById('app').classList.contains('hidden')) return { status: 'signed-out' };
  if (state.branding?.capabilities?.push === false) return { status: 'server-disabled', user: state.user };
  if (state.ws?.readyState !== 1) return { status: 'disconnected', user: state.user };
  return {
    status: 'ready', user: state.user,
    items: questionAttentionItems().slice(-300).map(item => ({
      kind: item.kind, id: item.kind === 'async' ? item.itemId : item.id,
      agentId: item.agentId, sessionKey: item.sessionKey, sourceSessionId: item.sourceSessionId,
      agentName: state.agents?.find(agent => agent.id === item.agentId)?.name || item.agentId,
      phase: item.phase, status: item.status, answered: item.answered,
      dismissed: item.dismissed, answerable: item.answerable, expiresAtMs: item.expiresAtMs,
      summary: String(item.kind === 'approval' ? item.title || 'Revisa la solicitud en Hub.'
        : item.questions?.[0]?.question || item.questions?.[0]?.title || item.questions?.[0]?.prompt || 'Hay una pregunta pendiente.').slice(0, 200),
    })),
  };
}

// Re-resolve inside the current document, after the asynchronous native read.
// A notification can open a request; it cannot answer it or grant permission.
async function openAttention(request) {
  if (typeof state !== 'object' || state.user !== request.user || state.ws?.readyState !== 1
      || state.branding?.capabilities?.push === false || document.getElementById('app')?.classList.contains('hidden')
      || typeof questionAttentionItems !== 'function' || typeof openPendingQuestion !== 'function') return false;
  const items = questionAttentionItems().filter(item => !Number.isFinite(item.expiresAtMs) || item.expiresAtMs > Date.now());
  const found = items.filter(item => request.targets.some(target => item.kind === target.kind
    && item.agentId === target.agentId && item.sessionKey === target.sessionKey
    && (item.kind === 'async' ? item.itemId === target.id && item.sourceSessionId === target.sourceSessionId : item.id === target.id)));
  if (!found.length) return false;
  if (request.targets.length > 1) {
    const button = document.getElementById('btn-pending-questions');
    if (!button) return false;
    button.click(); return true;
  }
  const item = found[0];
  await openPendingQuestion(item);
  return state.user === request.user && state.agent === item.agentId && state.current === item.sessionKey;
}

const snapshotScript = '(' + readAttention.toString() + ')()';
const openScript = request => '(' + openAttention.toString() + ')(' + JSON.stringify(request) + ')';
const cleanText = (value, limit) => typeof value === 'string'
  ? value.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit) : '';
const identifier = (value, limit) => typeof value === 'string' && value.length > 0 && value.length <= limit
  && !/[\x00-\x1f\x7f]/.test(value) ? value : null;
// Notification bodies support markup on some Linux notification servers.
const plainBody = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

function pendingItems(snapshot, now = Date.now()) {
  const result = new Map();
  if (snapshot?.status !== 'ready' || !Array.isArray(snapshot.items)) return result;
  for (const item of snapshot.items.slice(0, 300)) {
    if (!item || !['question', 'approval', 'async'].includes(item.kind)) continue;
    const id = identifier(item.id, 500), agentId = identifier(item.agentId, 200), sessionKey = identifier(item.sessionKey, 2048);
    const sourceSessionId = item.kind === 'async' ? identifier(item.sourceSessionId, 500) : null;
    if (!id || !agentId || !sessionKey || item.kind === 'async' && !sourceSessionId) continue;
    if (item.answered || item.dismissed || item.answerable === false || item.phase === 'resolved'
        || item.status && item.status !== 'pending' || Number.isFinite(item.expiresAtMs) && item.expiresAtMs <= now) continue;
    const key = JSON.stringify([item.kind, agentId, sessionKey, sourceSessionId, id]);
    result.set(key, { key, kind: item.kind, id, agentId, sessionKey, sourceSessionId,
      agentName: cleanText(item.agentName, 60) || agentId,
      summary: cleanText(item.summary, 200) || 'Revisa la solicitud en Hub.' });
  }
  return result;
}

class HubNotifications {
  constructor({ create, open, status = () => {}, failed = () => {}, now = Date.now }) {
    this.create = create; this.open = open; this.onStatus = status; this.failed = failed;
    this.status = 'connecting'; this.user = null; this.ledgers = new Map();
    this.current = new Map(); this.live = new Map(); this.sequence = 0;
    this.now = now; this.retries = new Map(); this.available = false;
  }

  setStatus(value) {
    if (value === this.status) return;
    this.status = value; this.onStatus(value);
  }

  close(key) {
    const entry = this.live.get(key);
    if (!entry) return;
    this.live.delete(key);
    try { entry.notification.close(); } catch {}
  }

  suspend(status = 'connecting') {
    this.available = false;
    this.current.clear();
    for (const key of [...this.live.keys()]) this.close(key);
    // An unavailable document is not an answer or a fresh notification scope.
    this.setStatus(status);
  }

  retryKey(user, item) { return JSON.stringify([user, item.key]); }

  updateStatus() {
    if (this.available) this.setStatus([...this.current.values()].some(item => this.retries.has(this.retryKey(this.user, item))) ? 'error' : 'ready');
  }

  retryNow() { for (const entry of this.retries.values()) entry.after = 0; }

  sync(snapshot, { enabled = true, supported = true } = {}) {
    if (!enabled || !supported) { this.suspend(enabled ? 'unsupported' : 'disabled'); return; }
    const user = identifier(snapshot?.user, 256);
    if (snapshot?.status !== 'ready' || !user) {
      if (snapshot?.status === 'signed-out') this.user = null;
      this.suspend(snapshot?.status || 'connecting'); return;
    }
    if (this.user !== user) this.suspend();
    this.user = user; this.available = true;
    if (!this.ledgers.has(user)) this.ledgers.set(user, new Set());
    const seen = this.ledgers.get(user);
    this.ledgers.delete(user); this.ledgers.set(user, seen);
    while (this.ledgers.size > 4) this.ledgers.delete(this.ledgers.keys().next().value);
    this.current = pendingItems(snapshot, this.now());
    for (const [key, entry] of this.live) if (!entry.targets.some(item => this.current.has(item.key))) this.close(key);
    this.updateStatus();
    const inFlight = new Set([...this.live.values()].flatMap(entry => entry.targets.map(item => item.key)));
    const fresh = [...this.current.values()].filter(item => !seen.has(item.key) && !inFlight.has(item.key)
      && (this.retries.get(this.retryKey(user, item))?.after || 0) <= this.now());
    // Reconnecting to many pending requests must not cause a banner storm.
    const batches = fresh.length > 3 ? [fresh] : fresh.map(item => [item]);
    for (const targets of batches) {
      const first = targets[0];
      const title = targets.length > 1 ? 'Solicitudes pendientes · Hub'
        : first.agentName + (first.kind === 'approval' ? ' pide permiso · Hub' : ' te pregunta · Hub');
      const body = targets.length > 1 ? targets.length + ' preguntas o permisos pendientes. Abre Hub para revisarlos.' : first.summary;
      const key = String(++this.sequence);
      let failureHandled = false;
      const failed = () => {
        if (failureHandled) return;
        failureHandled = true;
        this.live.delete(key);
        for (const item of targets) {
          seen.delete(item.key);
          const retryKey = this.retryKey(user, item), attempts = (this.retries.get(retryKey)?.attempts || 0) + 1;
          this.retries.delete(retryKey); this.retries.set(retryKey, { attempts, after: this.now() + Math.min(60000, 5000 * 2 ** Math.min(attempts - 1, 4)) });
        }
        while (this.retries.size > 1000) this.retries.delete(this.retries.keys().next().value);
        this.updateStatus(); this.failed();
      };
      try {
        const notification = this.create({ title, body: plainBody(body) });
        this.live.set(key, { notification, targets });
        notification.on('show', () => {
          if (this.live.get(key)?.notification !== notification || !this.available || this.user !== user) { notification.close(); return; }
          for (const item of targets) { seen.add(item.key); this.retries.delete(this.retryKey(user, item)); }
          while (seen.size > 1000) seen.delete(seen.values().next().value);
          this.updateStatus();
        });
        notification.on('click', () => {
          if (!this.available || this.user !== user) return;
          const pending = targets.filter(item => this.current.has(item.key));
          if (pending.length) Promise.resolve(this.open({ user, targets: pending })).catch(() => this.failed());
        });
        notification.on('close', () => { if (this.live.get(key)?.notification === notification) this.live.delete(key); });
        notification.on('failed', failed);
        notification.show();
      } catch { failed(); }
    }
  }
}

module.exports = { snapshotScript, openScript, pendingItems, HubNotifications };
