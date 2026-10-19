// hub-web — panel personal multi-agente sobre gateways OpenClaw.
// Un backend mantiene una conexión WS por agente (configured in agents.json)
// y multiplexa todos los navegadores. Chat + sesiones + archivos + STOP +
// contexto + selector de modelo. Sin pantallas de configuración.

'use strict';

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const WebSocket = require('ws');
const multer = require('multer');
const { GatewayObservability, gatewayRpcError } = require('./lib/gateway-observability');
const { mountSessionBrowse } = require('./lib/session-browse');
const { mountMessageQueue } = require('./lib/message-queue');
const { mountArtifactRoutes } = require('./lib/artifact-routes');
const { UserAccess } = require('./lib/user-access');
const { createPublicTenant } = require('./lib/public-tenant');
const { normalizeBlockingQuestion, blockingQuestionInScope, transcriptIdentity, readAsyncQuestion, AsyncQuestionTracker,
  historyAsyncQuestions, eventQuestionMessage, asyncQuestionForTranscript } = require('./lib/agent-questions');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PORT = parseInt(process.env.PORT || '18900', 10);
const BIND = process.env.BIND || '127.0.0.1';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PINNED_FILE = path.join(DATA_DIR, "pinned.json");
let pinnedSessions = {};
try { pinnedSessions = JSON.parse(fs.readFileSync(PINNED_FILE, "utf8")); } catch {}
function savePinned() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(PINNED_FILE, JSON.stringify(pinnedSessions, null, 2)); } catch {}
}
// notify.json es opcional (control on/off); la suscripción push NO vive ahí,
// vive en data/push-subs.json por usuario.
const NOTIFY_CFG = (() => { try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'notify.json'), 'utf8')); } catch { return {}; } })();
const AGENTS_FILE = process.env.AGENTS_FILE || path.join(DATA_DIR, 'agents.json');
const configuredUploadMb = Number(process.env.MAX_UPLOAD_MB);
const MAX_UPLOAD_MB = Number.isFinite(configuredUploadMb) && configuredUploadMb > 0 ? configuredUploadMb : 25;
const COOKIE_TTL_MS = 30 * 24 * 3600 * 1000;
const BEHIND_PROXY = process.env.BEHIND_PROXY === '1';
const SESSION_VISIBLE_DAYS = parseInt(process.env.SESSION_VISIBLE_DAYS || '0', 10); // 0 = mostrar todas
const publicTenant = createPublicTenant(process.env.PANEL_TENANT);

fs.mkdirSync(path.join(DATA_DIR, 'uploads'), { recursive: true });

// agents.json: [{ id, name, emoji, url, token, workspace? }]
let AGENTS = [];
try {
  AGENTS = JSON.parse(fs.readFileSync(AGENTS_FILE, 'utf8'));
} catch (e) {
  console.error(`[hub] No se pudo leer ${AGENTS_FILE}: ${e.message}`);
  console.error('[hub] Formato: [{"id":"assistant","name":"Assistant","emoji":"🧭","url":"ws://…/ws","token":"…"}]');
  process.exit(1);
}
if (!Array.isArray(AGENTS) || !AGENTS.length) { console.error('[hub] agents.json vacío'); process.exit(1); }
if (publicTenant) publicTenant.validateAgents(AGENTS);

// branding.json opcional por panel: { name, emoji, title, manifestName, manifestShort, welcomeLine }
// Permite que la MISMA fuente sirva el Hub multi-agente y los paneles mono-agente
// (with independent branding) cada uno con su marca, sin sed ni forks.
const BRANDING_FILE = process.env.BRANDING_FILE || path.join(DATA_DIR, 'branding.json');
let BRANDING = {
  name: 'Hub', emoji: '🧭', title: 'Hub · Agentes',
  manifestName: 'Hub — Agentes', manifestShort: 'Hub',
  welcomeLine: 'Tus agentes, en un sitio',
};
try { BRANDING = { ...BRANDING, ...JSON.parse(fs.readFileSync(BRANDING_FILE, 'utf8')) }; } catch {}

// ---------------------------------------------------------------------------
// Usuarios (scrypt) + cookies firmadas
// ---------------------------------------------------------------------------
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const hashPassword = (plain) => {
  const salt = crypto.randomBytes(16).toString('hex');
  return `scrypt$${salt}$${crypto.scryptSync(plain, salt, 64).toString('hex')}`;
};
function verifyPassword(plain, stored) {
  if (typeof stored !== 'string') return false;
  const p = stored.split('$');
  if (p.length !== 3 || p[0] !== 'scrypt') return false;
  try {
    const expected = Buffer.from(p[2], 'hex');
    return crypto.timingSafeEqual(expected, crypto.scryptSync(plain, p[1], expected.length));
  } catch { return false; }
}
const saveUsers = (u) => fs.writeFileSync(USERS_FILE, JSON.stringify(u, null, 2), { mode: 0o600 });

let USERS;
try { USERS = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch { USERS = null; }
if (publicTenant) publicTenant.validateUsers(USERS);
if (!USERS) {
  const pass = crypto.randomBytes(9).toString('base64url');
  USERS = [{ u: 'admin', pw: hashPassword(pass), name: 'Administrator' }];
  saveUsers(USERS);
  console.log('[hub] ==========================================');
  console.log(`[hub] FIRST START — user: admin  password: ${pass}`);
  console.log('[hub] ==========================================');
}
let migrated = 0;
for (const u of USERS) if (u.p && !u.pw) { u.pw = hashPassword(String(u.p)); delete u.p; migrated++; }
if (migrated) { saveUsers(USERS); console.log(`[hub] ${migrated} password(s) migradas a hash`); }
const access = new UserAccess({ dataDir: DATA_DIR, users: () => USERS,
  ...(publicTenant ? { keyAllowed: publicTenant.validKey } : {}) });

const COOKIE_SECRET = (function loadCookieSecret() {
  const f = path.join(DATA_DIR, 'cookie.secret');
  try { return fs.readFileSync(f, 'utf8'); } catch {
    const s = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(f, s, { mode: 0o600 });
    return s;
  }
})();
const signCookie = (p) => {
  const body = Buffer.from(JSON.stringify(p)).toString('base64url');
  return `${body}.${crypto.createHmac('sha256', COOKIE_SECRET).update(body).digest('base64url')}`;
};
function verifyCookie(c) {
  if (!c) return null;
  const [body, sig] = String(c).split('.');
  if (!body || !sig) return null;
  const expect = crypto.createHmac('sha256', COOKIE_SECRET).update(body).digest('base64url');
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return (!p.exp || p.exp < Date.now()) ? null : p;
  } catch { return null; }
}
function parseCookies(req) {
  const out = Object.create(null);
  (req.headers.cookie || '').split(';').forEach(c => {
    const i = c.indexOf('=');
    if (i > 0) {
      // A malformed percent escape must not escape the WebSocket connection handler.
      try { out[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim()); } catch {}
    }
  });
  return out;
}
const authUser = (req) => { const p = verifyCookie(parseCookies(req).hubweb); return p && access.user(p.u) ? p.u : null; };

const observability = new GatewayObservability({
  dataDir: DATA_DIR,
  secrets: [...AGENTS.map(agent => agent.token), COOKIE_SECRET],
  emit: (agentId, sessionKey, snapshot) => broadcast({ type: 'activity', agentId, sessionKey, snapshot }),
});

// ---------------------------------------------------------------------------
// Cliente de gateway (uno por agente)
// ---------------------------------------------------------------------------
const b64u = (b) => Buffer.from(b).toString('base64url');

class AgentLink {
  constructor(cfg, settingsOnly = false) {
    this.cfg = cfg;
    this.settingsOnly = settingsOnly;
    this.connectionWaiters = new Set();
    this.id = cfg.id;
    this.identity = this.loadIdentity();
    this.ws = null;
    this.idc = 0;
    this.pending = new Map();
    this.connected = false;
    this.backoff = 1000;
    this.lastError = null;
    this.models = [];
    this.sessionsCache = { at: 0, rows: [] };
    this.subs = new Set();   // sessionKeys suscritas a eventos de sesión (session.tool/observer)
    this.authorizedMessageSubs = new Set(); // successful native per-session authorization
    this.pendingQuestions = new Map();
    this.questionRevision = 0;
    this.questionsPull = null;
    this.asyncQuestionTracker = new AsyncQuestionTracker();
    this.asyncQuestionRecoveries = new Map();
    this.asyncQuestionRecovered = new Set();
    this.asyncQuestionRevisions = new Map();
    this.pendingApprovals = new Set();   // ids de aprobación pendientes vistos por este vínculo
    this.approvalSessions = new Map();
    this.activityRefreshes = new Map();
    this.activityRefreshedAt = new Map();
    this.progressRefreshes = new Map();
    this.progressRevisions = new Map();
  }

  loadIdentity() {
    const f = path.join(DATA_DIR, `device-${this.id}.json`);
    try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
    const kp = crypto.generateKeyPairSync('ed25519');
    const raw = kp.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
    const id = {
      deviceId: crypto.createHash('sha256').update(raw).digest('hex'),
      publicKey: raw.toString('base64url'),
      privPem: kp.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    };
    fs.writeFileSync(f, JSON.stringify(id, null, 2), { mode: 0o600 });
    return id;
  }

  // El gateway solo emite session.tool/observer a conexiones suscritas a ESA sesión.
  // Se re-suscribe al reconectar (la suscripción muere con el socket).
  ensureSub(key) {
    const k = String(key || '');
    if (!k) return Promise.resolve(false);
    this.subs.delete(k);            // reinsertar al final: orden de uso reciente
    this.subs.add(k);
    while (this.subs.size > 20) this.subs.delete(this.subs.values().next().value);
    for (const key of this.asyncQuestionRevisions.keys()) if (!this.subs.has(key)) this.asyncQuestionRevisions.delete(key);
    return this.subscribe(k);
  }

  subscribe(k) {
    if (!this.connected) return Promise.resolve(false);
    const connection = this.ws;
    // El parámetro del gateway es `key` (no `sessionKey`): con sessionKey responde INVALID_REQUEST.
    // includeApprovals: opt-in por llamada (no pegajoso) para recibir session.approval;
    // exige operator.admin o operator.approvals. La respuesta trae approvalReplay con
    // lo pendiente, autoritativo si truncated=false.
    return this.req('sessions.messages.subscribe', { key: k, ...(!publicTenant ? { includeApprovals: true } : {}) })
      .then(r => {
        if (this.ws !== connection || !this.connected) return false;
        if (!r?.ok || r.payload?.subscribed === false) { this.authorizedMessageSubs.delete(k); this.asyncQuestionRecovered.delete(k); console.log(`[${this.id}] subscribe ${k} rechazado: ${r?.error?.message || '?'}`); return false; }
        this.authorizedMessageSubs.add(k);
        for (const key of this.authorizedMessageSubs) if (!this.subs.has(key)) this.authorizedMessageSubs.delete(key);
        for (const key of this.asyncQuestionRecovered) if (!this.subs.has(key)) this.asyncQuestionRecovered.delete(key);
        const replay = r?.payload?.approvalReplay;
        if (replay && !replay.truncated) for (const a of replay.approvals || []) onApprovalEvent(this.id, { phase: 'pending', sessionKey: k, approval: a });
        // A question can be persisted after the browser's history snapshot but
        // before this native subscription commits. Only approvals have a native
        // replay; recover optional questions after authorization, and again
        // after a Gateway reconnect. Never expose provisional event contents.
        if (!publicTenant && !this.asyncQuestionRecovered.has(k)) this.recoverAsyncQuestions(k, connection);
        return true;
      })
      .catch(e => { this.authorizedMessageSubs.delete(k); this.asyncQuestionRecovered.delete(k); console.log(`[${this.id}] subscribe ${k} falló: ${e.message}`); return false; });
  }

  async recoverAsyncQuestions(key, connection = this.ws) {
    const existing = this.asyncQuestionRecoveries.get(key);
    if (existing?.connection === connection) return existing.promise;
    const active = () => this.ws === connection && this.connected && this.subs.has(key) && this.authorizedMessageSubs.has(key);
    if (!active()) return;
    const entry = { connection, needsSuccessor: false };
    entry.promise = (async () => {
      try {
        let offset = 0, sessionId, messages = [], completeHistory = false;
        // Match the answer endpoint's recoverable window (10 x 200 records).
        // Tool-heavy turns can move an unanswered question past the first page.
        // Read newest-to-oldest without publishing a partial pending projection
        // that could overlook its linked answer on a newer page.
        for (let page = 0; page < 10; page++) {
          if (!active()) return;
          const result = await this.req('chat.history', { sessionKey: key, limit: 200,
            ...(this.cfg.gatewayAgentId ? { agentId: this.cfg.gatewayAgentId } : {}),
            ...(offset ? { offset } : {}) }, 15000);
          const payload = result.payload;
          if (!result.ok || !active() || !Array.isArray(payload?.messages)
              || typeof payload.sessionId !== 'string' || !payload.sessionId.trim()
              || (sessionId !== undefined && payload.sessionId !== sessionId)) return;
          sessionId = payload.sessionId;
          messages = [...payload.messages, ...messages];
          completeHistory = payload.hasMore === false;
          if (payload.hasMore !== true) break;
          if (!Number.isSafeInteger(payload.nextOffset) || payload.nextOffset <= offset) return;
          offset = payload.nextOffset;
        }
        const questions = this.asyncQuestionTracker.observe(key, messages, sessionId, { completeHistory }).questions;
        // A quoted reply can arrive after the first page's snapshot while this
        // coalesced scan is waiting. A complete older prefix cannot certify it.
        entry.needsSuccessor = completeHistory && this.asyncQuestionTracker.needsQuotedRecovery(key, sessionId);
        // Re-read the current transcript before publication. A reset during
        // recovery must not promote an old question onto the current composer.
        const published = await this.publishAsyncQuestionChanges(key, sessionId, [...questions.keys()], true);
        if (published && active()) this.asyncQuestionRecovered.add(key);
      } catch {}
    })();
    this.asyncQuestionRecoveries.set(key, entry);
    try { await entry.promise; }
    finally { if (this.asyncQuestionRecoveries.get(key) === entry) this.asyncQuestionRecoveries.delete(key); }
    if (entry.needsSuccessor && active()) return this.recoverAsyncQuestions(key, connection);
  }

  async replayAsyncQuestionsToBrowser(browser, key, connection = this.ws) {
    const active = () => this.ws === connection && this.connected && this.subs.has(key)
      && this.authorizedMessageSubs.has(key) && browsers.has(browser) && browser.readyState === WebSocket.OPEN;
    if (!active()) return;
    try {
      // A first subscription/reconnect may still be rebuilding the shared
      // projection. Do not replay a pending cache before its answer backfill.
      const recovery = this.asyncQuestionRecoveries.get(key);
      if (recovery?.connection === connection) await recovery.promise;
      if (!active() || !this.asyncQuestionRecovered.has(key)) return;
      const revision = this.asyncQuestionRevisions.get(key);
      const result = await this.req('sessions.describe', { key }, 8000);
      const row = result.payload?.session, owner = this.cfg.gatewayAgentId || 'main';
      if (!result.ok || !active() || !row || (row.agentId && row.agentId !== owner)
          || (row.key?.startsWith('agent:') && !row.key.startsWith('agent:' + owner + ':'))
          || typeof row.sessionId !== 'string' || !row.sessionId.trim()
          || revision !== this.asyncQuestionRevisions.get(key)) return;
      // Re-read after describe: a live answer may have settled the cached card
      // during that request. Only the described CURRENT transcript is replayed.
      const questions = this.asyncQuestionTracker.observe(key, [], row.sessionId).questions;
      for (const question of questions.values()) sendAsyncQuestion(browser, {
        type: 'async_question', agentId: this.id, sessionKey: key,
        asyncQuestion: asyncQuestionForTranscript(question, row.sessionId, row.sessionId),
      });
    } catch {}
  }

  async publishAsyncQuestionChanges(key, sessionId, itemIds, currentOnly = false) {
    const connection = this.ws;
    const revision = this.asyncQuestionRevisions.get(key);
    try {
      const result = await this.req('sessions.describe', { key }, 8000);
      const row = result.payload?.session, owner = this.cfg.gatewayAgentId || 'main';
      if (!result.ok || !row || (row.agentId && row.agentId !== owner)
          || (row.key?.startsWith('agent:') && !row.key.startsWith('agent:' + owner + ':'))
          || this.ws !== connection || !this.connected || !this.subs.has(key) || !this.authorizedMessageSubs.has(key)
          || revision !== this.asyncQuestionRevisions.get(key)
          || (currentOnly && row.sessionId !== sessionId)) return;
      // A later answer may arrive while describe is in flight. Read the latest
      // projection instead of allowing an earlier pending event to reopen it.
      const latest = this.asyncQuestionTracker.observe(key, [], sessionId).questions;
      for (const itemId of itemIds) {
        const question = latest.get(itemId);
        if (question) broadcast({ type: 'async_question', agentId: this.id, sessionKey: key,
          asyncQuestion: asyncQuestionForTranscript(question, sessionId, row.sessionId) });
      }
      return true;
    } catch {}
  }

  async refreshProgress(key) {
    if (!this.connected || (this.gatewayMethods && !this.gatewayMethods.has('progressCard.get'))) return;
    if (this.progressRefreshes.has(key)) return this.progressRefreshes.get(key);
    const revision = this.progressRevisions.get(key);
    const pending = (async () => {
      try {
        const result = await this.req('progressCard.get', {
          sessionKey: key,
          ...(this.cfg.gatewayAgentId ? { agentId: this.cfg.gatewayAgentId } : {}),
        }, 8000);
        if (!result.ok) {
          if (unsupportedMethod(result, 'progressCard.get')) return;
          throw gatewayRpcError(result, 'No se pudo recuperar el progreso');
        }
        // A clear/new revision arriving during the read retires that older read.
        if (revision !== this.progressRevisions.get(key)) return;
        if (Object.prototype.hasOwnProperty.call(result.payload || {}, 'card')) observability.setProgress(this.id, key, result.payload.card);
      } catch (error) { observability.progressError(this.id, key, error); }
    })();
    this.progressRefreshes.set(key, pending);
    try { await pending; } finally {
      this.progressRefreshes.delete(key);
      if (revision !== this.progressRevisions.get(key)) this.refreshProgress(key).catch(() => {});
    }
  }

  async refreshActivity(key, force = false) {
    if (!this.connected) return observability.snapshot(this.id, key);
    if (this.activityRefreshes.has(key)) return this.activityRefreshes.get(key);
    if (!force && Date.now() - (this.activityRefreshedAt.get(key) || 0) < 4000) {
      // A native progress update already in flight must not be hidden by the
      // description cache when a browser opens the session during that update.
      if (this.progressRefreshes.has(key)) await this.progressRefreshes.get(key);
      return observability.snapshot(this.id, key);
    }
    const revision = observability.revision(this.id, key);
    const pending = (async () => {
      const [description, history, progress] = await Promise.allSettled([
        this.req('sessions.describe', { key }, 8000),
        this.req('chat.history', { sessionKey: key, limit: 1 }, 8000),
        this.refreshProgress(key),
      ]);
      // This read is only for the Gateway's recoverable activity snapshot. No
      // messages, assistant text, arguments or tool outputs enter metadata.
      if (description.status === 'fulfilled' && description.value.ok) observability.reconcile(this.id, key, description.value.payload?.session, { revision });
      else if (description.status === 'fulfilled') observability.observationError(this.id, key, gatewayRpcError(description.value, 'No se pudo verificar la actividad'));
      else observability.observationError(this.id, key, description.reason);
      if (history.status === 'fulfilled' && history.value.ok) observability.recover(this.id, key, history.value.payload?.inFlightRun);
      if (progress.status === 'rejected') observability.progressError(this.id, key, progress.reason);
      this.activityRefreshedAt.delete(key); this.activityRefreshedAt.set(key, Date.now());
      while (this.activityRefreshedAt.size > 30) this.activityRefreshedAt.delete(this.activityRefreshedAt.keys().next().value);
      return observability.snapshot(this.id, key);
    })();
    this.activityRefreshes.set(key, pending);
    try { return await pending; } finally { this.activityRefreshes.delete(key); }
  }

  // Preguntas pendientes (ask_user). No van por la suscripción de sesión: se piden.
  async pullQuestions() {
    if (publicTenant) return;
    if (!this.connected) return;
    if (this.questionsPull) return this.questionsPull;
    const revision = this.questionRevision;
    let invalidated = false;
    this.questionsPull = (async () => {
      try {
        const response = await this.req('question.list', {}, 15000);
        const questions = response.payload?.questions;
        if (!response.ok || !Array.isArray(questions)) return;
        if (revision !== this.questionRevision) { invalidated = true; return; }
        const seen = new Set();
        for (const question of questions) {
          if (!question?.id || !blockingQuestionInScope(question, this.cfg.gatewayAgentId || 'main')) continue;
          seen.add(question.id);
          onQuestionEvent(this.id, { phase: 'pending', question });
        }
        for (const id of this.pendingQuestions.keys()) {
          if (!seen.has(id)) onQuestionEvent(this.id, { phase: 'resolved', question: { id, status: 'resolved' } });
        }
      } catch {}
    })();
    try { await this.questionsPull; } finally { this.questionsPull = null; }
    // An unrelated global terminal can retire a snapshot before an unseen
    // local question reaches its cache. Recover a fresh list, do not lose it.
    if (invalidated && this.connected) return this.pullQuestions();
  }

  // Aprobaciones pendientes (exec/plugin). El gateway solo manda `session.approval` a quien
  // esté suscrito a ESA sesión: sin este repaso, una aprobación que nace en una sesión que
  // no tienes abierta no se veía en ninguna parte y el agente quedaba bloqueado con el panel
  // pareciendo "trabajando" (2026-10-01). El protocolo lo indica: tras conectar, backfill con
  // exec.approval.list y reconciliar por id con los eventos en vivo.
  async pullApprovals() {
    if (publicTenant) return;
    if (!this.connected) return;
    const seen = new Set();
    let ok = false;
    const push = (kind, item) => {
      const id = String(item?.id || '');
      if (!id) return;
      const rq = item.request || item;
      const pr = item.presentation || {};
      const sessionKey = rq.sessionKey || pr.sessionKey || item.sessionKey || null;
      if (!sessionKey || !access.inScope(this, sessionKey)) return;
      seen.add(id);
      onApprovalEvent(this.id, { phase: 'pending', approval: {
        id,
        status: item.status || 'pending',
        sourceSessionKey: sessionKey,
        createdAtMs: item.createdAtMs, expiresAtMs: item.expiresAtMs,
        presentation: {
          kind: item.approvalKind || pr.kind || kind,
          commandText: pr.commandText || rq.command || '',
          title: pr.title || '',
          warningText: pr.warningText || rq.warningText || null,
          host: pr.host || rq.host || null,
          nodeId: pr.nodeId || rq.nodeId || null,
          allowedDecisions: pr.allowedDecisions || rq.allowedDecisions || null,
        },
      }});
    };
    try {
      const r = await this.req('exec.approval.list', {}, 15000);
      // OJO: la respuesta es un ARRAY de aprobaciones, no { approvals: [...] }
      if (r.ok) { ok = true; for (const a of (Array.isArray(r.payload) ? r.payload : r.payload?.approvals || [])) push('exec', a); }
    } catch {}
    try {
      const r = await this.req('plugin.approval.list', {}, 15000);
      if (r.ok) { ok = true; for (const a of (Array.isArray(r.payload) ? r.payload : r.payload?.approvals || [])) push('plugin', a); }
    } catch {}
    if (!ok) return;   // si no hubo respuesta, no se borra nada
    // Reconciliar: lo que teníamos pendiente y ya no está, se resolvió en otro sitio.
    for (const id of this.pendingApprovals) {
      if (!seen.has(id)) {
        broadcast({ type: 'approval', agentId: this.id, id, sessionKey: this.approvalSessions.get(id)?.sessionKey || null, phase: 'resolved', status: 'resolved' });
        this.approvalSessions.delete(id);
      }
    }
    if (seen.size !== this.pendingApprovals.size) console.log(`[${this.id}] aprobaciones pendientes: ${seen.size}`);
    this.pendingApprovals = seen;
  }

  connect() {
    const ws = new WebSocket(this.cfg.url, {
      maxPayload: 64 * 1024 * 1024,
      ...(this.settingsOnly ? { headers: { 'x-openclaw-scopes': 'operator.read,operator.write' } } : {}),
    });
    this.ws = ws;
    ws.on('message', (d) => this.onMessage(d));
    ws.on('close', (closeCode, reason) => {
      if (this.connected) console.log(`[${this.id}] desconectado`);
      this.connected = false;
      this.authorizedMessageSubs.clear();
      this.asyncQuestionRecovered.clear();
      const error = Object.assign(new Error(this.lastError || 'Gateway desconectado; no se conoce el resultado de operaciones en curso'), {
        code: this.lastDiagnostic?.code || 'GATEWAY_DISCONNECTED',
        retryable: this.lastDiagnostic?.retryable ?? true,
        details: { closeCode, closeReason: observability.safeText(String(reason || '')), ...(this.lastDiagnostic ? { gateway: this.lastDiagnostic } : {}) },
      });
      for (const { rej } of this.pending.values()) rej(error);
      this.pending.clear();
      if (!this.settingsOnly) {
        observability.setConnection(this.id, false, error);
        broadcast({ type: 'agent', agentId: this.id, connected: false, diagnostic: observability.diagnostic(error, { terminal: false }) });
      }
      setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 30000);
    });
    ws.on('error', (e) => { this.lastError = observability.safeText(e.message); });
  }

  onMessage(d) {
    let m; try { m = JSON.parse(d); } catch { return; }
    if (publicTenant && m?.type === 'event' && !publicTenant.eventAllowed(m.event, m.payload, this)) return;
    if (this.settingsOnly && m.type === 'event' && m.event !== 'connect.challenge') return;
    if (m.type === 'event') {
      const p = m.payload || {};
      const key = p.sessionKey || p.question?.sessionKey || p.approval?.sourceSessionKey || p.approval?.request?.sessionKey;
      if (key && !access.inScope(this, key)) return;
    }
    if (m.type === 'event') {   // diagnóstico: qué eventos manda el gateway de verdad
      if (!this.seenEvents) this.seenEvents = new Set();
      if (!this.seenEvents.has(m.event)) {
        this.seenEvents.add(m.event);
        console.log(`[${this.id}] evento del gateway: ${m.event}`);
      }
    }
    if (m.type === 'res' && this.pending.has(m.id)) {
      const { res } = this.pending.get(m.id); this.pending.delete(m.id); res(m);
    } else if (m.type === 'event' && m.event === 'connect.challenge') {
      this.sendConnect(m.payload.nonce);
    } else if (m.type === 'event' && m.event === 'agent') {
      // La conexión que lanzó el turno recibe 'agent' con la actividad del run
      // (fases, herramientas, tokens). 'session.tool' va a las demás conexiones.
      onAgentEvent(this.id, m.payload);
    } else if (m.type === 'event' && m.event === 'chat') {
      onChatEvent(this.id, m.payload);
    } else if (m.type === 'event' && m.event === 'session.tool') {
      // sessions.subscribe admits the native tool stream globally. Project only
      // sessions this link is actually watching; do not retain unrelated output.
      if (!this.subs.has(m.payload?.sessionKey)) return;
      onToolEvent(this.id, m.payload);
    } else if (m.type === 'event' && m.event === 'session.message') {
      // Managed media can rewrite the same assistant message after chat:final.
      // Forward only invalidation metadata, never the persisted message body.
      if (m.payload?.message?.role === 'assistant') this.notifyArtifactsChanged(m.payload);
      const key = m.payload?.sessionKey;
      const owner = this.cfg.gatewayAgentId || 'main';
      // The native subscription is the permission boundary. Global message
      // events must not publish another agent's or an unwatched session's text.
      if (typeof key === 'string' && this.subs.has(key) && this.authorizedMessageSubs.has(key)
          && (!key.startsWith('agent:') || key.startsWith('agent:' + owner + ':'))
          && (!m.payload.agentId || m.payload.agentId === owner)) {
        const message = eventQuestionMessage(m.payload);
        if (message) {
          const changes = this.asyncQuestionTracker.observe(key, [message], m.payload.sessionId).changes;
          if (changes.length) this.publishAsyncQuestionChanges(key, m.payload.sessionId, changes.map(question => question.itemId));
          if (message.role === 'user' && this.asyncQuestionTracker.needsQuotedRecovery(key, m.payload.sessionId)) this.recoverAsyncQuestions(key, this.ws);
        }
      }
    } else if (m.type === 'event' && m.event === 'session.observer') {
      onObserverEvent(this.id, m.payload);
    } else if (m.type === 'event' && m.event === 'progressCard.changed') {
      const key = m.payload?.sessionKey;
      if (typeof key === 'string' && key) {
        this.progressRevisions.delete(key); this.progressRevisions.set(key, m.payload.revision);
        while (this.progressRevisions.size > 120) this.progressRevisions.delete(this.progressRevisions.keys().next().value);
        if (m.payload.revision === null) observability.setProgress(this.id, key, null);
        this.refreshProgress(key).catch(() => {});
      }
    } else if (m.type === 'event' && m.event === 'question.requested') {
      onQuestionEvent(this.id, { phase: 'pending', question: m.payload });
    } else if (m.type === 'event' && m.event === 'question.resolved') {
      onQuestionEvent(this.id, { phase: 'resolved', question: m.payload });
    } else if (m.type === 'event' && m.event === 'session.approval') {
      onApprovalEvent(this.id, m.payload);
    } else if (m.type === 'event' && m.event === 'sessions.changed') {
      this.sessionsCache.at = 0;
      const key = m.payload?.sessionKey, owner = this.cfg.gatewayAgentId || 'main';
      const lifecycle = typeof key === 'string' && (!m.payload.agentId || m.payload.agentId === owner)
        && ['reset', 'new', 'delete'].includes(m.payload.reason);
      if (lifecycle && this.subs.has(key)) {
        this.asyncQuestionRevisions.set(key, (this.asyncQuestionRevisions.get(key) || 0) + 1);
        this.asyncQuestionRecovered.delete(key);
      }
      if (m.payload?.phase === 'message') this.notifyArtifactsChanged(m.payload);
      const sessionId = m.payload?.sessionId || m.payload?.session?.sessionId;
      broadcast({ type: 'sessions', agentId: this.id,
        ...(lifecycle ? { sessionKey: key, reason: m.payload.reason,
          ...(typeof sessionId === 'string' && sessionId.trim() ? { sessionId } : {}) } : {}),
      });
    }
  }

  notifyArtifactsChanged(payload) {
    const key = payload?.sessionKey;
    if (typeof key !== 'string' || !this.subs.has(key)) return;
    broadcast({ type: 'artifacts_changed', agentId: this.id, sessionKey: key,
      ...(typeof payload.messageId === 'string' ? { messageId: payload.messageId } : {}),
      ...(typeof payload.runId === 'string' ? { runId: payload.runId } : {}),
    });
  }

  sendConnect(nonce) {
    const id = this.identity;
    const signedAt = Date.now();
    const scopes = publicTenant ? publicTenant.scopes : this.settingsOnly ? ['operator.read', 'operator.write'] : ['operator.read', 'operator.write', 'operator.admin'];
    const token = this.cfg.token;
    const payload = ['v3', id.deviceId, 'cli', 'cli', 'operator', scopes.join(','),
      String(signedAt), token, nonce, 'linux', ''].join('|');
    const signature = b64u(crypto.sign(null, Buffer.from(payload, 'utf8'), crypto.createPrivateKey(id.privPem)));
    this.pending.set('connect', {
      res: (m) => m.ok ? this.onHello(m) : this.onConnectError(m),
      rej: () => {},
    });
    this.ws.send(JSON.stringify({ type: 'req', id: 'connect', method: 'connect', params: {
      minProtocol: 2, maxProtocol: 4,
      client: { id: 'cli', version: '1.0', platform: 'linux', mode: 'cli' },
      role: 'operator', scopes, caps: this.settingsOnly || publicTenant ? [] : ['tool-events'], commands: [], permissions: {},
      auth: { token }, locale: 'es-ES', userAgent: 'hub-web/1.0',
      device: { id: id.deviceId, publicKey: id.publicKey, signature, signedAt, nonce },
    }}));
  }

  async onHello(m) {
    this.backoff = 1000;
    this.connected = true;
    this.lastError = null;
    this.lastDiagnostic = null;
    const scopes = m.payload?.auth?.scopes || [];
    if (publicTenant && (!scopes.includes('operator.read') || !scopes.includes('operator.write')
      || scopes.some(scope => !publicTenant.scopes.includes(scope)))) {
      this.connected = false;
      this.lastError = publicTenant.error;
      this.ws.close();
      return;
    }
    if (this.settingsOnly) {
      // Without admin authority, model preferences can never persist agent/global defaults.
      if (!scopes.includes('operator.read') || !scopes.includes('operator.write') || scopes.includes('operator.admin')) {
        this.connected = false;
        this.lastError = 'El gateway no permite una conexión de ajustes limitada a esta sesión';
        for (const waiter of this.connectionWaiters) waiter.reject(new Error(this.lastError));
        this.connectionWaiters.clear();
        this.ws.close();
        return;
      }
      for (const waiter of this.connectionWaiters) waiter.resolve();
      this.connectionWaiters.clear();
      return;
    }
    console.log(`[${this.id}] conectado (${scopes.join(',') || 'sin scopes'})`);
    this.gatewayMethods = Array.isArray(m.payload?.features?.methods) ? new Set(m.payload.features.methods) : null;
    this.activityRefreshedAt.clear();
    observability.setConnection(this.id, true);
    broadcast({ type: 'agent', agentId: this.id, connected: true });
    // Native chat.send sends full tool results only to tool-events recipients;
    // other turns use the sessions.subscribe registry, not messages.subscribe.
    if (!publicTenant && (!this.gatewayMethods || this.gatewayMethods.has('sessions.subscribe'))) {
      const report = error => {
        console.warn(`[${this.id}] actividad completa: ${observability.safeText(error.message)}`);
        for (const key of this.subs) observability.recordDiagnostic(this.id, key, error, { terminal: false });
      };
      this.req('sessions.subscribe', {}, 8000).then(result => {
        if (!result.ok && !unsupportedMethod(result, 'sessions.subscribe')) report(gatewayRpcError(result, 'No se pudo suscribir a la actividad completa'));
      }).catch(report);
    }
    for (const k of this.subs) { this.subscribe(k); this.refreshActivity(k).catch(() => {}); } // reconnect recovers actual activity, too
    this.pullQuestions();
    this.pullApprovals();
    if (publicTenant) return;
    try {
      let r = await this.req('models.list', { view: 'configured' }, 15000);
      // Older gateways do not accept the configured-view parameter.
      if (!r.ok && r.error?.code === 'INVALID_REQUEST' && /view|additional propert/i.test(r.error?.message || '')) {
        r = await this.req('models.list', {}, 15000);
      }
      if (r.ok) {
        this.models = (r.payload?.models || []).filter(x => x.available !== false);
        broadcast({ type: 'models', agentId: this.id });
      }
    } catch {}
  }

  onConnectError(m) {
    const err = m.error || {};
    this.lastError = observability.safeText(`${err.code}: ${err.message}`);
    this.lastDiagnostic = observability.diagnostic(err, { terminal: false });
    if (!this.settingsOnly) observability.setConnection(this.id, false, err);
    console.error(`[${this.id}] connect falló: ${this.lastError}`);
    if (err.details?.requestId) {
      console.error(`[${this.id}] ⏳ aprobar dispositivo: openclaw devices approve ${err.details.requestId}`);
    }
    setTimeout(() => { try { this.ws.close(); } catch {} }, 8000);
  }

  req(method, params = {}, timeoutMs = 30000) {
    return new Promise((res, rej) => {
      if (publicTenant && !publicTenant.validRpc(method, params)) return rej(Object.assign(new Error(publicTenant.error), { code: 'FORBIDDEN' }));
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return rej(Object.assign(new Error(`${this.id} no conectado`), { code: 'GATEWAY_DISCONNECTED', retryable: true }));
      const id = 'r' + (++this.idc);
      const to = setTimeout(() => { this.pending.delete(id); rej(Object.assign(new Error(`timeout ${method} (${this.id}); no se conoce el resultado`), { code: 'GATEWAY_TIMEOUT', method, requestId: id, retryable: true })); }, timeoutMs);
      this.pending.set(id, { res: (m) => { clearTimeout(to); res(publicTenant ? publicTenant.rpcResponse(method, m, params) : m); }, rej: error => { clearTimeout(to); rej(error); } });
      this.ws.send(JSON.stringify({ type: 'req', id, method, params }));
    });
  }

  async settingsClient() {
    if (publicTenant) return this; // Public policy admits label-only patches, never model/default changes.
    if (!this.settingsLink) {
      this.settingsLink = new AgentLink(this.cfg, true);
      this.settingsLink.connect();
    }
    const link = this.settingsLink;
    if (!link.connected) await new Promise((resolve, reject) => {
      const waiter = {
        resolve: () => { clearTimeout(timer); resolve(); },
        reject: error => { clearTimeout(timer); reject(error); },
      };
      const timer = setTimeout(() => { link.connectionWaiters.delete(waiter); reject(new Error('No se pudo conectar para guardar los ajustes')); }, 15000);
      link.connectionWaiters.add(waiter);
    });
    return link;
  }

  async sessions(force = false) {
    if (!force && Date.now() - this.sessionsCache.at < 4000) return this.sessionsCache.rows;
    const activityRevisions = observability.captureRevisions(this.id);
    const r = await this.req('sessions.list', {});
    if (!r.ok) throw gatewayRpcError(r, 'sessions.list falló');
    const rows0 = r.payload?.sessions || [];
    const owner = this.cfg.gatewayAgentId || 'main';
    let rows = rows0.filter(row => access.inScope(this, row?.key) && (!row.agentId || row.agentId === owner));
    rows.sort((a, b) => (activityAt(b) - activityAt(a)));
    this.sessionsCache = { at: Date.now(), rows };
    access.recordRows(this, rows);
    // Auto-suscripción: si una sesión tiene turno activo, el hub DEBE estar
    // suscrito para recibir su evento terminal ('final'/'aborted'/'error').
    // Sin esto, si el navegador no mandó el 'watch' (p. ej. perdió el send con el
    // socket CONNECTING, o la suscripción se desalojó por el tope de 20), el
    // 'final' no llega al panel y la barra se queda "trabajando" para siempre.
    for (const row of rows) if (row && row.hasActiveRun && row.key) this.ensureSub(row.key);
    observability.reconcileRows(this.id, rows, activityRevisions);
    return rows;
  }
}

const links = new Map();
for (const cfg of AGENTS) {
  if (!cfg.id || !cfg.url || !cfg.token) { console.error('[hub] agente mal definido:', cfg.id || '?'); continue; }
  const link = new AgentLink(cfg);
  links.set(cfg.id, link);
  link.connect();
}
const getLink = (id) => links.get(String(id || ''));

// Refresco periódico de aprobaciones pendientes: una que nazca en una sesión que nadie
// tiene abierta (o mientras el panel estaba caído) tiene que acabar viéndose igual.
setInterval(() => {
  for (const l of links.values()) {
    l.pullApprovals().catch(() => {});
    l.pullQuestions().catch(() => {});
  }
}, 45 * 1000).unref?.();

// ---------------------------------------------------------------------------
// Web Push (VAPID): la notificación llega al SO aunque la PWA esté CERRADA.
// La suscripción vive en el navegador; el servidor envía al endpoint.
// ---------------------------------------------------------------------------
const webpush = require('web-push');

function loadOrCreateVapid() {
  const f = path.join(DATA_DIR, 'vapid.json');
  try {
    const v = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (v.publicKey && v.privateKey) return v;
  } catch {}
  const v = webpush.generateVAPIDKeys();
  fs.writeFileSync(f, JSON.stringify(v, null, 2), { mode: 0o600 });
  return v;
}
const vapid = loadOrCreateVapid();
webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'https://example.com/openclaw-hub', vapid.publicKey, vapid.privateKey);

const subsFile = () => path.join(DATA_DIR, 'push-subs.json');
function loadSubs() { try { return JSON.parse(fs.readFileSync(subsFile(), 'utf8')); } catch { return {}; } }
function saveSubs(subs) { fs.writeFileSync(subsFile(), JSON.stringify(subs, null, 2), { mode: 0o600 }); }

// Enviar a todas las suscripciones de un usuario (sus dispositivos). Limpia las
// suscripciones muertas (410/404: el navegador ya no es válido).
async function pushNotify(user, payload) {
  const subs = loadSubs()[user] || [];
  if (!subs.length) return 0;
  const dead = [];
  let sent = 0;
  await Promise.allSettled(subs.map(async (s, i) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, JSON.stringify(payload), { TTL: 300 });
      sent++;
    } catch (e) {
      if (e.statusCode === 410 || e.statusCode === 404) dead.push(i);
      else console.log(`[push] ${e.statusCode || e.message}`);
    }
  }));
  if (dead.length) {
    const all = loadSubs();
    all[user] = (all[user] || []).filter((_, i) => !dead.includes(i));
    saveSubs(all);
  }
  return sent;
}

// ---------------------------------------------------------------------------
// Utilidades de transcripción
// ---------------------------------------------------------------------------
function normalizeContent(content) {
  if (typeof content === 'string') return { text: content, tools: [] };
  if (!Array.isArray(content)) return { text: '', tools: [] };
  let text = '';
  const tools = [];
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text' && typeof b.text === 'string') text += b.text;
    // Tool calls del agente: se muestran en el chat como bloques plegables
    // (estilo OpenClaw UI). args se trunca para no inflar el payload.
    else if (b.type === 'toolCall') {
      let args = b.arguments;
      try { const s = JSON.stringify(args); if (s && s.length > 600) args = JSON.parse(s.slice(0, 600) + '}'); } catch {}
      tools.push({ id: b.id || null, name: String(b.name || 'tool').slice(0, 60), args });
    }
  }
  return { text, tools };
}

// Vista previa corta del resultado de una herramienta (para el bloque plegable).
function toolResultPreview(content) {
  if (typeof content === 'string') return content.slice(0, 300);
  if (Array.isArray(content)) {
    for (const b of content) {
      if (b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string') return b.text.slice(0, 300);
    }
  }
  return '';
}

function visibilityCutoffMs() {
  if (!SESSION_VISIBLE_DAYS || SESSION_VISIBLE_DAYS < 1) return 0;
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - (SESSION_VISIBLE_DAYS - 1));
  return d.getTime();
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
const app = express();
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  const sendJson = res.json.bind(res);
  res.json = body => {
    if (res.statusCode >= 400 && body && typeof body === 'object' && body.error) {
      const source = body.diagnostic || body;
      const agentId = req.body?.agent || req.query.agent;
      const key = req.body?.key || req.query.key;
      const link = getLink(agentId);
      const gatewayAgentId = link?.cfg.gatewayAgentId || 'main';
      const scoped = typeof key === 'string' && key.length <= 1024 && (!key.startsWith('agent:') || key.startsWith('agent:' + gatewayAgentId + ':'));
      const diagnostic = req.user && link && scoped && access.canKnown(req.user, link, key) && observability.recordDiagnostic
        ? observability.recordDiagnostic(String(agentId), key, source, { terminal: false })
        : observability.diagnostic(source, { terminal: false });
      return sendJson({ ...body, error: diagnostic.message, diagnostic });
    }
    return sendJson(body);
  };
  next();
});
app.use(express.json({ limit: '2mb' }));
if (publicTenant) {
  app.use((error, req, res, next) => res.status(400).json({ error: publicTenant.error }));
  app.use(publicTenant.middleware);
}
const upload = multer({ dest: path.join(DATA_DIR, 'uploads'), limits: { fileSize: Math.max(1, Math.floor(MAX_UPLOAD_MB * 1024 * 1024)), files: 6 } });

// Se acaba de crear un aviso del agente: notificar siempre (si no hay pestaña, o
// para que la veas aunque la pestaña esté abierta pero en otra app).
// Al crear un aviso del agente: Web Push a TODOS los usuarios del panel (cada uno
// en sus dispositivos). Si alguien lo mira en la pestaña, verá la tarjeta igual.
async function onNewAlert(kind, agentId, title, sessionKey) {
  if (NOTIFY_CFG.enabled === false) return;
  const icon = kind === 'permiso' ? '🔐' : '❓';
  const body = String(title).slice(0, 160);
  const subj = kind === 'permiso' ? `${agentId} pide permiso` : `${agentId} te pregunta`;
  const who = kind === 'permiso' ? `${icon} ${subj}` : `${icon} ${subj}`;
  for (const user of Object.keys(loadSubs())) {
    const link = getLink(agentId);
    if (!access.canAgent(user, agentId) || !sessionKey || !await access.authorize(user, link, sessionKey)) continue;
    pushNotify(user, {
      title: who, body,
      icon: '/icons/hub-v2/icon-192.png', badge: '/icons/hub-v2/badge-96.png', tag: `hub-${kind}-${agentId}-${Date.now()}`,
      data: { url: '/', agent: agentId, ...(sessionKey ? { sessionKey } : {}) },
    }).catch(() => {});
  }
}


function requireAuth(req, res, next) {
  const u = authUser(req);
  if (!u) return res.status(401).json({ error: 'auth required' });
  req.user = u; next();
}

function uploadMetadata(id) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-][a-zA-Z0-9._-]{0,199}$/.test(id)) return null;
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'uploads', id + '.meta.json'), 'utf8')); } catch { return null; }
}

const fileReferencePath = raw => String(raw || '').replace(/^\/home\/(?:node|[a-zA-Z0-9_-]+)\/\.openclaw(?:-[a-zA-Z0-9_-]+)?\/workspace\//, '');
async function authorizePublishedFile(req, link, key, raw) {
  if (!access.privateOnly(req.user, link.id)) return true;
  const requested = fileReferencePath(raw);
  if (!requested || requested.startsWith('/') || requested.includes('\\') || requested.includes('\u2026') || requested.split('/').includes('..')) return false;
  // A session key alone must not expose arbitrary paths in the shared agent workspace.
  // Accept only exact file references published by its assistant, never user/tool text.
  const described = await link.req('sessions.describe', { key }, 8000);
  if (!described.ok || !access.validRow(link, key, described.payload?.session)) return false;
  const sessionId = described.payload.session.sessionId;
  let offset = 0;
  for (let page = 0; page < 10; page++) {
    const result = await link.req('chat.history', { sessionKey: key, agentId: link.cfg.gatewayAgentId || 'main', offset, limit: 200 }, 15000);
    const payload = result.payload || {};
    if (!result.ok || sessionId && payload.sessionId && payload.sessionId !== sessionId) return false;
    for (const message of payload.messages || []) {
      if (message.role !== 'assistant') continue;
      const content = typeof message.content === 'string' ? message.content : (message.content || []).filter(block => block?.type === 'text').map(block => block.text || '').join('\n');
      const references = content.matchAll(/(?<![\w./:-])(?:\/home\/(?:node|[a-zA-Z0-9_-]+)\/\.openclaw(?:-[a-zA-Z0-9_-]+)?\/workspace\/)?(?:media|tmp|reports|nas|nas_docs|docs)\/[^\s)"'<>]+/g);
      for (const match of references) if (fileReferencePath(match[0]) === requested) return true;
    }
    if (!payload.hasMore || !Number.isSafeInteger(payload.nextOffset) || payload.nextOffset <= offset) return false;
    offset = payload.nextOffset;
  }
  return false;
}

// One boundary covers every HTTP route, including reads and mutation aliases.
// Unknown restricted-user routes fail closed instead of inheriting admin access.
app.use('/api', async (req, res, next) => {
  // Match Express' case-insensitive, optional-trailing-slash route semantics.
  // Otherwise an alias can skip an ID/resource-specific check but hit its handler.
  const route = req.path.replace(/\/+$/, '').toLowerCase();
  if (['/login', '/logout', '/me', '/branding'].includes(route)) return next();
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: 'auth required' });
  req.user = user;
  const deny = () => res.status(403).json({ error: 'No tienes acceso a esta conversación o agente', code: 'FORBIDDEN' });
  try {
    if (['/agents', '/push-key', '/push-sub', '/upload'].includes(route)) return next();
    const source = ['GET', 'HEAD', 'DELETE'].includes(req.method) ? req.query : (req.body || {});
    if (route === '/files' && String(source.path || '').startsWith('uploads/')) {
      const id = String(source.path).slice('uploads/'.length);
      return access.canUpload(user, uploadMetadata(id)) && /^[a-zA-Z0-9_-][a-zA-Z0-9._-]{0,199}$/.test(id) ? next() : deny();
    }
    const link = getLink(source.agent);
    if (!link) return access.privateOnly(user) ? deny() : res.status(400).json({ error: 'agente desconocido' });
    if (!access.canAgent(user, link.id)) return deny();
    if (route === '/files' && !access.privateOnly(user, link.id) && !source.key) return next();
    if ((route === '/sessions' && ['GET', 'HEAD', 'POST'].includes(req.method)) || route === '/session-search') return next();
    if (route === '/question') {
      const id = String(source.id || '');
      let question = link.pendingQuestions.get(id);
      if (!question) {
        const result = await link.req('question.get', { id }, 8000);
        question = result.ok ? result.payload?.question : null;
        if (question && !blockingQuestionInScope(question, link.cfg.gatewayAgentId || 'main')) return deny();
      }
      if (!question || !await access.authorize(user, link, question.sessionKey)) return deny();
      return next();
    }
    if (route === '/approval') {
      const id = String(source.id || '');
      if (!link.approvalSessions.has(id)) await link.pullApprovals();
      const approval = link.approvalSessions.get(id);
      if (!approval || !await access.authorize(user, link, approval.sessionKey)) return deny();
      if (access.privateOnly(user, link.id) && source.decision === 'allow-always') return res.status(403).json({ error: 'Puedes autorizar esta ejecución, no cambiar permisos compartidos', code: 'FORBIDDEN' });
      return next();
    }
    if (typeof source.key !== 'string' || !source.key || source.key.length > 1024) return res.status(400).json({ error: 'Falta una sesión válida' });
    if (!await access.authorize(user, link, source.key)) return deny();
    if (['/files', '/session-file'].includes(route) && !await authorizePublishedFile(req, link, source.key, source.path)) return deny();
    return next();
  } catch (error) { return apiError(res, error, 'No se pudo verificar el acceso'); }
});

function apiError(res, response, fallback, status = 502) {
  const diagnostic = observability.diagnostic(response?.error || response, { terminal: false, message: fallback });
  return res.status(status).json({ error: diagnostic.message, diagnostic });
}

const sessionRouteOptions = { getLink, requireAuth, agents: AGENTS, normalizeContent, toolResultPreview,
  authorizeSession: (req, link, key) => access.authorize(req.user, link, key),
  searchSessionKeys: async (req, link) => access.isolationEnabled(link.id) ? (await link.sessions(true)).filter(row => access.canKnown(req.user, link, row.key)).map(row => row.key) : null,
  privateOnly: req => access.privateOnly(req.user, (['GET', 'HEAD', 'DELETE'].includes(req.method) ? req.query : req.body)?.agent),
  diagnosticFromError: (error, context) => observability.diagnostic(error, context) };
mountSessionBrowse(app, sessionRouteOptions);
mountMessageQueue(app, sessionRouteOptions);
mountArtifactRoutes(app, sessionRouteOptions);

const loginFails = new Map();
const tooMany = (ip) => {
  const e = loginFails.get(ip);
  if (!e) return false;
  if (Date.now() - e.first > 10 * 60 * 1000) { loginFails.delete(ip); return false; }
  return e.n >= 8;
};

app.post('/api/login', (req, res) => {
  const ip = publicTenant ? publicTenant.loginIp(req) : (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?';
  if (tooMany(ip)) return res.status(429).json({ error: 'Demasiados intentos. Espera 10 minutos.' });
  const { u, p } = req.body || {};
  const user = USERS.find(x => x.u === u);
  if (!user || !verifyPassword(String(p ?? ''), user.pw)) {
    const e = loginFails.get(ip);
    if (!e || Date.now() - e.first > 6e5) loginFails.set(ip, { n: 1, first: Date.now() }); else e.n++;
    return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
  }
  loginFails.delete(ip);
  const previousUser = authUser(req), previousCookie = parseCookies(req).hubweb;
  if (previousUser && previousUser !== user.u) for (const browser of browsers) {
    if (browser.user === previousUser && parseCookies(browser.request).hubweb === previousCookie) browser.close(4401, 'account changed');
  }
  const secure = BEHIND_PROXY || req.headers['x-forwarded-proto'] === 'https' ? ' Secure;' : '';
  const cookie = signCookie({ u: user.u, exp: Date.now() + COOKIE_TTL_MS });
  res.setHeader('Set-Cookie', `hubweb=${encodeURIComponent(cookie)}; HttpOnly;${secure} Path=/; Max-Age=${Math.floor(COOKIE_TTL_MS / 1000)}; SameSite=Lax`);
  res.json({ ok: true, user: user.u, name: user.name || user.u });
});

app.post('/api/logout', (req, res) => {
  const user = authUser(req);
  if (user) for (const browser of browsers) if (browser.user === user && parseCookies(browser.request || {}).hubweb === parseCookies(req).hubweb) browser.close(4401, 'logged out');
  res.setHeader('Set-Cookie', 'hubweb=; HttpOnly; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  const user = authUser(req), entry = access.user(user);
  res.json({ user, sessionScope: entry?.sessionScope || 'shared', sessionScopes: entry?.sessionScopes || {}, legacyStorageOwner: entry?.legacyStorageOwner === true || USERS.length === 1 && !access.privateOnly(user) });
});

// ---------------------------------------------------------------------------
// Web Push: clave pública y gestión de la suscripción del navegador
// ---------------------------------------------------------------------------
app.get('/api/push-key', requireAuth, (req, res) => res.json({ publicKey: vapid.publicKey }));

app.post('/api/push-sub', requireAuth, (req, res) => {
  const sub = req.body && req.body.endpoint ? req.body : null;
  if (!sub || typeof sub.endpoint !== 'string' || !sub.endpoint.startsWith('https://')) return res.status(400).json({ error: 'suscripción inválida' });
  const keys = sub.keys || {};
  if (typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string') return res.status(400).json({ error: 'faltan claves' });
  const all = loadSubs();
  // A push endpoint identifies a browser, not a person. Account switching must
  // transfer it, otherwise the next user can receive the previous user's text.
  for (const other of Object.keys(all)) if (other !== req.user) all[other] = all[other].filter(item => item.endpoint !== sub.endpoint);
  const list = all[req.user] = all[req.user] || [];
  if (!list.some(x => x.endpoint === sub.endpoint)) {
    list.push({ endpoint: sub.endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth }, at: Date.now() });
    if (list.length > 10) list.splice(0, list.length - 10);
  }
  saveSubs(all);
  res.json({ ok: true, count: (all[req.user] || []).length });
});

app.delete('/api/push-sub', requireAuth, (req, res) => {
  const endpoint = String((req.body || {}).endpoint || '');
  const all = loadSubs();
  const before = (all[req.user] || []).length;
  all[req.user] = (all[req.user] || []).filter(x => x.endpoint !== endpoint);
  saveSubs(all);
  res.json({ ok: true, removed: before - (all[req.user] || []).length });
});

// ---------------------------------------------------------------------------
// Responder preguntas y aceptaciones (el navegador llama aquí; el hub habla con
// el gateway). El agente se elige porque cada link tiene su propia conexión.
// ---------------------------------------------------------------------------
function linkFor(req) {
  return getLink(req.body?.agent) || null;
}

app.post('/api/question', requireAuth, async (req, res) => {
  const l = getLink(req.body?.agent);
  if (!l) return res.status(400).json({ error: 'agente desconocido' });
  const id = String(req.body?.id || '');
  if (!id) return res.status(400).json({ error: 'falta id' });
  try {
    // question.list and requested events are global on an unrestricted Gateway.
    // If the browser missed replay, recover native ownership before resolving;
    // never turn a guessed ID into a response on another panel agent.
    if (!l.pendingQuestions.has(id)) {
      const selected = await l.req('question.get', { id }, 15000);
      if (!selected.ok) return apiError(res, selected, 'No se pudo verificar la pregunta');
      if (!selected.payload?.question) return res.status(404).json({ error: 'La pregunta ya no está disponible' });
      if (!blockingQuestionInScope(selected.payload.question, l.cfg.gatewayAgentId || 'main')) return res.status(403).json({ error: 'La pregunta no pertenece a este agente', code: 'FORBIDDEN' });
    }
    let r;
    if (req.body?.cancel) {
      r = await l.req('question.resolve', { id, cancel: true, resolvedBy: req.user }, 20000);
    } else {
      // El gateway espera { answers: { <qid>: [valores] } }
      const raw = req.body?.answers || {};
      const answers = Object.create(null);
      for (const [k, v] of Object.entries(raw)) {
        const arr = (Array.isArray(v) ? v : [v]).map(x => String(x));
        // [] is a real answer when allowEmpty=true (e.g. an optional form).
        // Preserve explicit empty lines/bytes too: the Gateway validates them
        // against the stored form rather than silently changing the answer.
        answers[k] = arr;
      }
      if (!Object.keys(answers).length) return res.status(400).json({ error: 'sin respuesta' });
      // El esquema del gateway anida: params.answers.answers.<qid> = [valores]
      r = await l.req('question.resolve', { id, answers: { answers }, resolvedBy: req.user }, 20000);
    }
    if (!r.ok) return apiError(res, r, 'el gateway rechazó la respuesta');
    onQuestionEvent(l.id, { phase: 'resolved', question: { id, status: r.payload?.status || 'answered', answers: r.payload?.answers } });
    res.json({ ok: true, status: r.payload?.status || 'answered' });
  } catch (e) { apiError(res, e, 'La operación no se pudo completar'); }
});

app.post('/api/approval', requireAuth, async (req, res) => {
  const l = linkFor(req);
  if (!l) return res.status(502).json({ error: 'sin agente conectado' });
  const id = String(req.body?.id || '');
  const kind = String(req.body?.kind || 'exec');
  const decision = String(req.body?.decision || '');
  if (!id || !['allow-once', 'allow-always', 'deny'].includes(decision)) return res.status(400).json({ error: 'petición inválida' });
  try {
    // Primera respuesta gana; las demás reciben el resultado ya registrado.
    // OJO: `reviewer` solo acepta custodia de canal ({channel, accountId, senderId});
    // con un objeto de dispositivo el gateway responde "approval not found". Se omite
    // y él atribuye el revisor por la identidad de este cliente (device).
    const r = await l.req('approval.resolve', { id, kind, decision }, 25000);
    if (!r.ok) return apiError(res, r, 'el gateway rechazó la decisión');
    l.pullApprovals().catch(() => {});   // reconciliar el resto (otra pestaña pudo resolverla)
    res.json({ ok: true, applied: !!r.payload?.applied, status: r.payload?.approval?.status || decision });
  } catch (e) { apiError(res, e, 'La operación no se pudo completar'); }
});

// Keep provider-qualified identities; an id may itself contain slashes.
function modelRef(provider, id) {
  if (!id) return null;
  return provider ? provider + '/' + id : String(id);
}

function thinkingLevels(value) {
  if (!Array.isArray(value)) return null;
  const seen = new Set();
  return value.flatMap(level => {
    const id = typeof level === 'string' ? level : level?.id;
    if (typeof id !== 'string' || !id || seen.has(id)) return [];
    seen.add(id);
    return [{ id, label: typeof level?.label === 'string' ? level.label : id }];
  });
}

function sessionSettings(link, row) {
  let provider = row.modelProvider || null;
  let ref = modelRef(provider, row.model);
  const matches = link.models.filter(model => modelRef(model.provider, model.id) === ref || (!provider && model.id === row.model));
  const catalog = matches.length === 1 ? matches[0] : null;
  if (!provider && catalog) { provider = catalog.provider; ref = modelRef(provider, catalog.id); }
  return {
    key: row.key,
    hasActiveRun: row.hasActiveRun === true,
    model: row.model || null,
    modelProvider: provider,
    modelRef: ref,
    modelOverrideSource: row.modelOverrideSource || null,
    modelSelectionLocked: row.modelSelectionLocked === true,
    modelOverride: row.modelOverrideSource === 'user' ? ref : null,
    // Only the stored preference is an override. Patch.resolved contains the effective level.
    thinkingLevel: row.thinkingLevel ?? null,
    thinkingDefault: row.thinkingDefault ?? catalog?.thinkingDefault ?? null,
    thinkingLevels: thinkingLevels(row.thinkingLevels) ?? thinkingLevels(catalog?.thinkingLevels),
  };
}

async function describeSettings(link, key) {
  const result = await link.req('sessions.describe', { key });
  if (!result.ok) throw gatewayRpcError(result, 'No se pudo leer la sesión');
  if (!result.payload?.session) throw new Error('El gateway no devolvió los ajustes de la sesión');
  return sessionSettings(link, result.payload.session);
}

// Agentes + estado + catálogo de modelos
app.get('/api/agents', requireAuth, (req, res) => {
  res.json({
    agents: AGENTS.filter(a => access.canAgent(req.user, a.id)).map(a => {
      const l = getLink(a.id);
      return {
        id: a.id, name: a.name || a.id, emoji: a.emoji || '🤖',
        role: a.role || '',
        connected: !!l?.connected,
        fileTransport: Array.isArray(a.fileRoots) ? 'mounted' : 'gateway',
        error: l?.connected ? null : (l?.lastError || null),
        // Agentes con modelo fijado a propósito (decisión del dueño): sin selector
        lockedModel: !!a.lockedModel,
        modelNote: a.modelNote || null,
        models: a.lockedModel ? [] : (l?.models || []).map(m => ({
          id: m.id, name: m.name || m.id, provider: m.provider,
          ref: modelRef(m.provider, m.id),
          alias: m.alias || null, contextWindow: m.contextWindow || null,
          thinkingLevels: thinkingLevels(m.thinkingLevels),
          thinkingDefault: m.thinkingDefault ?? null,
        })),
      };
    }),
  });
});

// Clasificación de una fila de sessions.list (OpenClaw 2026.9.x): la lista trae
// cron, subagentes, canal y sesiones main mezcladas con las del panel.
function sessionKind(r) {
  // OJO con el orden: un subagente también es isBackground=true. Si se comprueba
  // 'cron' primero, los subagentes salen clasificados como programados.
  if (r.classification === 'group') return 'group';
  if (r.classification === 'main' || r.isMain) return 'main';
  if (r.classification === 'subagent' || (r.spawnDepth || 0) > 0 || r.createdVia === 'spawn') return 'subagent';
  if (r.isBackground || r.classification === 'cron' || r.createdVia === 'cron') return 'cron';
  if (r.classification === 'custom') return 'custom';
  if (r.createdVia === 'channel') return 'channel';
  return 'session';
}

const KIND_LABEL = { cron: 'programada', subagent: 'subagente', group: 'grupo', main: 'principal', custom: 'otra app', channel: 'canal' };

// Marca de actividad real de una fila. OpenClaw 2026.10.1 añade `lastActivityAt`
// (fin del último run) y `lastInteractionAt` (última entrada del usuario).`updatedAt`
// sube con CUALQUIER cambio de metadatos (fijar, renombrar, suscripción…), así que
// ordenar por él hace que sesiones viejas salten arriba. Preferimos la actividad
// real y caemos a updatedAt/createdAt solo si el gateway no la trae (compat 2026.9.x).
const activityAt = (r) => Math.max(r.lastActivityAt || 0, r.lastInteractionAt || 0, r.updatedAt || 0) || 0;

// ---------------------------------------------------------------------------
// Árbol de sesiones: las que nacieron de otra (subagentes, forks) llevan
// parentSessionKey. Se suben a la lista principal SOLO si su raíz es una sesión
// del panel: así el subagente de un cron no ensucia, pero se ve de quién cuelga.
// ---------------------------------------------------------------------------
// De qué cuelga una fila: `parentSessionKey` es lo canónico, pero el gateway no siempre lo
// rellena (25 de 28 subagentes de "bu" venían sin él). `spawnedBy`/`controlOwnerSessionKey`
// dicen quién la lanzó y sí vienen siempre.
const parentOf = (r) => r.parentSessionKey || r.spawnedBy || r.controlOwnerSessionKey || (r.forkSource && r.forkSource.key) || null;

// Ancestros, del más cercano al más lejano. Un ancestro fuera del conjunto llega
// como { key, missing: true } y corta la cadena.
function lineage(r, byKey) {
  const chain = [];
  const seen = new Set();
  let cur = r;
  while (cur && chain.length < 20) {
    const p = parentOf(cur);
    if (!p || seen.has(p)) break;
    seen.add(p);
    const pr = byKey.get(p);
    if (!pr) { chain.push({ key: p, missing: true }); break; }
    chain.push(pr);
    cur = pr;
  }
  return chain;
}

// Previews (sessions.preview): dan la primera frase de la sesión, que es lo que
// hace identificable una sesión sin título. Con caché y sin romper la lista si falla.
const previewCache = new Map();   // agentId|key -> { at, snippet }
const PREVIEW_TTL_MS = 120000;

async function attachSnippets(l, rows) {
  const now = Date.now();
  const need = rows.filter(r => {
    const c = previewCache.get(`${l.id}|${r.key}`);
    return !c || now - c.at > PREVIEW_TTL_MS;
  }).slice(0, 60);
  if (!need.length) return;
  let payload;
  try {
    const pr = await l.req('sessions.preview', { keys: need.map(r => r.key) }, 8000);
    if (!pr.ok) return;
    payload = pr.payload;
  } catch { return; }
  for (const p of payload?.previews || []) {
    if (!p || !p.key) continue;
    const items = Array.isArray(p.items) ? p.items : [];
    const usable = (i) => {
      const t = String(i?.text || '').replace(/\s+/g, ' ').trim();
      if (t.length < 8) return null;
      // Ruido interno: no identifica nada de la sesión
      if (/^\[(OpenClaw heartbeat|Subagent Task|openclaw)/i.test(t)) return null;
      if (/^<</.test(t)) return null;
      return t;
    };
    const first = items.filter(i => i && i.role === 'user').map(usable).find(Boolean)
      || items.map(usable).find(Boolean);
    // Sin puntos suspensivos de la fuente: ya los pone el CSS
    const snippet = first ? first.replace(/[.\u2026]+$/, '').slice(0, 110) : '';
    previewCache.set(`${l.id}|${p.key}`, { at: now, snippet });
  }
}

app.get('/api/sessions', requireAuth, async (req, res) => {
  const l = getLink(req.query.agent);
  if (!l) return res.status(400).json({ error: 'agente desconocido' });
  try {
    const roster = await l.sessions(req.query.fresh === '1');
    // Filter before counts, lineage, previews and pagination. No private labels
    // or missing-parent metadata may escape through an otherwise hidden tree.
    const all = roster.filter(row => access.canKnown(req.user, l, row.key));
    const byKey = new Map(all.map(r => [r.key, r]));
    const kindOf = new Map(all.map(r => [r.key, sessionKind(r)]));
    // Ancestro que ancla la fila en la lista principal = la sesión del panel de la que cuelga.
    const anchorOf = (x) => {
      for (const a of x.chain) {
        if (a.missing) return null;
        const k = kindOf.get(a.key) || sessionKind(a);
        if (k === 'session') return a;
        if (k !== 'subagent') return null;
      }
      return null;
    };
    // ¿Se sube a la lista principal? Antes se exigía que la RAÍZ de la cadena fuese una sesión del
    // panel; como casi toda sesión del panel cuelga de `agent:<x>:main`, la raíz nunca era 'session'
    // y TODOS los descendientes caían en «Otras» (2026-10-01: in the example agent, 37 de 43 subagentes con su
    // padre presente en la lista y ninguno visible). Ahora manda el ancestro más cercano: se sube si
    // el primer ancestro NO subagente es una sesión del panel; lo que cuelga de cron/canal/grupo
    // sigue fuera, que era el motivo del filtro (que el subagente de un cron no ensucie).
    const nestedInPanel = (x) => {
      for (const a of x.chain) {
        if (a.missing) return false;
        const k = kindOf.get(a.key) || sessionKind(a);
        if (k === 'session') return true;
        if (k !== 'subagent') return false;   // cron / canal / grupo / principal: no se sube
      }
      return false;
    };
    // Cada fila con su linaje: de quién cuelga y a qué sesión del panel pertenece
    const info = all.map(r => ({
      r, kind: kindOf.get(r.key), chain: lineage(r, byKey),
    }));
    const isMain = (x) => x.kind === 'session' || (x.kind === 'subagent' && nestedInPanel(x));
    const own = info.filter(isMain);
    const others = info.filter(x => !isMain(x));
    // Profundidad visible: cuántos ancestros están en la vista (0 = raíz)
    const visibleDepth = (x) => {
      let d = 0;
      for (const a of x.chain) { if (a.missing || !pageKeys.has(a.key)) break; d++; }
      return d;
    };
    const cutoff = visibilityCutoffMs();
    const wantKind = String(req.query.kind || 'session') === 'others' ? others : own;
    const sorted = [...wantKind].sort((a, b) => ((b.r.pinned ? 1 : 0) - (a.r.pinned ? 1 : 0)) || (activityAt(b.r) - activityAt(a.r)));
    // Un hijo cuenta en el día de su sesión del panel: si no, el árbol se parte entre dos
    // grupos de día y la indentación deja de entenderse.
    const dateOf = (x) => activityAt(anchorOf(x) || x.r) || 0;
    const viewKeys = new Set(sorted.map(x => x.r.key));
    const treeOf = (x) => {
      let root = x.r.key;
      for (const ancestor of x.chain) {
        if (ancestor.missing || !viewKeys.has(ancestor.key)) break;
        root = ancestor.key;
      }
      return root;
    };
    const visibleTrees = new Set(sorted.filter(x => req.query.all === '1' || !cutoff || x.r.pinned || dateOf(x) >= cutoff).map(treeOf));
    const shown = sorted.filter(x => visibleTrees.has(treeOf(x)));
    const hiddenByDate = sorted.length - shown.length;
    const pageTrees = new Set([...new Set(shown.map(treeOf))].slice(0, 120));
    const page = shown.filter(x => pageTrees.has(treeOf(x)));
    const pageKeys = new Set(page.map(x => x.r.key));
    const childCount = new Map();
    for (const x of page) {
      const parent = x.chain[0];
      if (parent && !parent.missing && pageKeys.has(parent.key)) childCount.set(parent.key, (childCount.get(parent.key) || 0) + 1);
    }
    await attachSnippets(l, page.map(x => x.r));
    res.json({
      hiddenCount: hiddenByDate,
      othersCount: others.length,
      ownCount: own.length,
      counts: info.reduce((acc, x) => { acc[x.kind] = (acc[x.kind] || 0) + 1; return acc; }, {}),
      sessions: page.map(({ r, kind, chain }) => {
        const par = chain[0] && !chain[0].missing ? chain[0] : null;
        const anchor = anchorOf({ r, chain });
        return {
          key: r.key,
          label: r.label || r.displayName || '',
          kind, kindLabel: KIND_LABEL[kind] || '',
          gwAgent: r.agentId || null,
          snippet: previewCache.get(`${l.id}|${r.key}`)?.snippet || '',
          updatedAt: r.updatedAt,
          // Actividad real (2026.10.1): lastActivityAt = fin del último run; el
          // updatedAt sube con cualquier metadato y hace "saltar" sesiones viejas.
          lastActivityAt: r.lastActivityAt || null,
          lastInteractionAt: r.lastInteractionAt || null,
          activityAt: activityAt(r),
          groupAt: (anchor || r).updatedAt || null,
          parentKey: par && pageKeys.has(par.key) ? par.key : null,
          parentLabel: par ? (par.label || par.displayName || '') : '',
          depth: visibleDepth({ chain }),
          children: childCount.get(r.key) || 0,
          unread: !!r.unread, pinned: pinnedSessions[l.id+"|"+r.key] !== undefined ? pinnedSessions[l.id+"|"+r.key] : !!r.pinned,
          hasActiveRun: !!r.hasActiveRun,
          lastRunFailed: r.status === 'failed' || !!r.abortedLastRun,
          ...sessionSettings(l, r),
          totalTokens: r.totalTokens ?? null,
          contextWindowTokens: r.contextTokens ?? null,
        };
      }),
    });
  } catch (e) { apiError(res, e, 'La operación no se pudo completar'); }
});

app.post('/api/sessions', requireAuth, async (req, res) => {
  const l = getLink(req.body?.agent);
  if (!l) return res.status(400).json({ error: 'agente desconocido' });
  // Gateways multi-agente (p.ej. gateway: main+secondary) exigen agentId explícito en sessions.create
  const agentCfg = AGENTS.find(a => a.id === String(req.body?.agent || ''));
  const gwAgentId = String(agentCfg?.gatewayAgentId || 'main');
  const idempotencyKey = req.body?.idempotencyKey;
  if (idempotencyKey !== undefined && (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{1,256}$/.test(idempotencyKey))) return res.status(400).json({ error: 'Identificador de creación inválido' });
  const identity = { idempotencyKey: access.namespaced(req.user, l.id, idempotencyKey || crypto.randomUUID(), 'create') };
  try {
    const base = String(req.body?.label || '').slice(0, 100).trim();
    let label = base || undefined;
    let r = await l.req('sessions.create', { ...(label ? { label } : {}), agentId: gwAgentId, ...identity });
    if (!r.ok && base && /label already in use/i.test(r.error?.message || '')) {
      for (let i = 2; i <= 30 && !r.ok; i++) { label = `${base} (${i})`; r = await l.req('sessions.create', { label, agentId: gwAgentId, ...identity }); }
      if (!r.ok) { label = `${base} ${new Date().toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}`; r = await l.req('sessions.create', { label, agentId: gwAgentId, ...identity }); }
    }
    if (!r.ok) return apiError(res, r, 'no se pudo crear');
    access.claim(req.user, l, r.payload?.key);
    l.sessionsCache.at = 0;
    // modelo inicial opcional
    if (req.body?.model) {
      try { const writer = await l.settingsClient(); await writer.req('sessions.patch', { key: r.payload.key, model: String(req.body.model) }); } catch {}
    }
    res.json({ key: r.payload.key, label: r.payload.entry?.label || label || 'Nueva sesión' });
  } catch (e) { apiError(res, e, 'La operación no se pudo completar'); }
});

app.delete('/api/sessions', requireAuth, async (req, res) => {
  const l = getLink(req.query.agent);
  if (!l) return res.status(400).json({ error: 'agente desconocido' });
  try {
    const r = await l.req('sessions.delete', { key: String(req.query.key || '') });
    if (!r.ok) return apiError(res, r, 'El gateway rechazó la operación');
    l.sessionsCache.at = 0;
    res.json({ ok: true });
  } catch (e) { apiError(res, e, 'La operación no se pudo completar'); }
});

app.get('/api/session-settings', requireAuth, async (req, res) => {
  const l = getLink(req.query.agent);
  if (!l) return res.status(400).json({ error: 'agente desconocido' });
  const key = String(req.query.key || '');
  if (!key) return res.status(400).json({ error: 'falta la sesión' });
  try {
    res.json({ settings: await describeSettings(l, key) });
  } catch (e) { apiError(res, e, 'La operación no se pudo completar'); }
});

// Both fields are optional; an effort-only patch must never reset the model.
app.post(['/api/model', '/api/session-settings'], requireAuth, async (req, res) => {
  const hasModel = Object.hasOwn(req.body || {}, 'model');
  const hasThinking = Object.hasOwn(req.body || {}, 'thinkingLevel');
  const agentCfg = AGENTS.find(a => a.id === String(req.body?.agent || ''));
  if (hasModel && agentCfg?.lockedModel) {
    return res.status(409).json({ error: agentCfg.modelNote || 'Este agente tiene el modelo fijado' });
  }
  const l = getLink(req.body?.agent);
  if (!l) return res.status(400).json({ error: 'agente desconocido' });
  const key = String(req.body?.key || '');
  if (!key) return res.status(400).json({ error: 'falta la sesión' });
  if (!hasModel && !hasThinking) return res.status(400).json({ error: 'faltan los ajustes' });
  const patch = { key };
  for (const field of ['model', 'thinkingLevel']) {
    if (!Object.hasOwn(req.body, field)) continue;
    const value = req.body[field];
    if (value !== null && (typeof value !== 'string' || !value.trim())) return res.status(400).json({ error: 'ajuste inválido: ' + field });
    patch[field] = value === null ? null : value.trim();
  }
  try {
    const current = await describeSettings(l, key);
    if (current.hasActiveRun) return res.status(409).json({ error: 'Espera a que termine el turno para cambiar los ajustes' });
    if (hasModel && current.modelSelectionLocked) return res.status(409).json({ error: 'El modelo de esta sesión está fijado por el agente' });
    const writer = await l.settingsClient();
    const r = await writer.req('sessions.patch', patch);
    if (!r.ok) return apiError(res, r, 'El gateway rechazó los ajustes', r.error?.code === 'INVALID_REQUEST' ? 400 : 502);
    l.sessionsCache.at = 0;
    const settings = await describeSettings(l, key);
    res.json({ ok: true, model: settings.modelRef, settings });
  } catch (e) { apiError(res, e, 'La operación no se pudo completar'); }
});

app.post("/api/pin", requireAuth, async (req, res) => {
  const l = getLink(req.body?.agent);
  if (!l) return res.status(400).json({ error: "agente desconocido" });
  const key = String(req.body?.key || "");
  const pinned = !!req.body?.pinned;
  if (!key) return res.status(400).json({ error: "falta la sesión" });
  const pk = l.id + "|" + key;
  // Guardar SIEMPRE el valor explícito (true o false). Antes solo se escribía al
  // fijar: al desfijar quedaba la entrada true y el siguiente loadSessions()
  // (eventos sessions.changed, red de seguridad, cualquier refresco) volvía a
  // fijarla sola en pocos segundos. El store manda sobre el valor del gateway en
  // los dos sentidos.
  pinnedSessions[pk] = pinned;
  savePinned();
  res.json({ ok: true, pinned });
});

app.get('/api/history', requireAuth, async (req, res) => {
  const l = getLink(req.query.agent);
  if (!l) return res.status(400).json({ error: 'agente desconocido' });
  try {
    const r = await l.req('chat.history', { sessionKey: String(req.query.key || ''), limit: 200 }, 60000);
    if (!r.ok) return apiError(res, r, 'El gateway rechazó la operación');
    const asyncQuestions = historyAsyncQuestions(l, String(req.query.key || ''), r.payload?.messages || [], r.payload?.sessionId,
      { completeHistory: r.payload?.hasMore === false && (r.payload?.offset || 0) === 0 });
    let currentSessionId;
    if ((r.payload?.messages || []).some(readAsyncQuestion)) {
      try {
        const described = await l.req('sessions.describe', { key: String(req.query.key || '') }, 8000);
        const row = described.payload?.session;
        if (described.ok && row && (!row.agentId || row.agentId === (l.cfg.gatewayAgentId || 'main'))) currentSessionId = row.sessionId;
      } catch {}
    }
    const messages = (r.payload?.messages || []).map(m => {
      const { text, tools } = normalizeContent(m.content);
      const identity = transcriptIdentity(m);
      // toolResult: no es texto de chat; se sirve como entrada de herramienta
      // (nombre, error y preview corta) para pintarlo en el bloque plegable.
      if (m.role === 'toolResult') {
        return {
          ...identity,
          role: 'toolResult', ts: m.timestamp,
          tool: {
            id: m.toolCallId || null, name: String(m.toolName || 'tool').slice(0, 60),
            isError: !!m.isError, preview: toolResultPreview(m.content),
          },
        };
      }
      const out = { ...identity, role: m.role, text, ts: m.timestamp };
      const question = readAsyncQuestion(m);
      if (question) out.asyncQuestion = asyncQuestionForTranscript(asyncQuestions.get(question.itemId) || question, r.payload?.sessionId, currentSessionId);
      if (tools.length) out.tools = tools;
      if (m.role === 'assistant' && (m.errorMessage || m.stopReason === 'error')) out.diagnostic = observability.diagnostic(m, { at: m.timestamp, terminal: true });
      return out;
    }).filter(m => m.text || (m.tools && m.tools.length) || m.tool || m.diagnostic || m.asyncQuestion || m.role === 'user');
    res.json({ messages });
  } catch (e) { apiError(res, e, 'La operación no se pudo completar'); }
});

// ¿Esta sesión tiene ahora mismo un turno activo en el gateway? El panel lo
// necesita para la sesión ABIERTA aunque no esté en la lista del sidebar
// (modo "Otras", recorte por fecha o tope de 120 árboles): sin esto la barra
// "trabajando" no se reconcilia y se queda pegada para siempre.
app.get('/api/run-status', requireAuth, async (req, res) => {
  const l = getLink(req.query.agent);
  if (!l) return res.status(400).json({ error: 'agente desconocido' });
  const key = String(req.query.key || '');
  if (!key) return res.status(400).json({ error: 'falta key' });
  const activityRevision = observability.revision(l.id, key);
  try {
    const d = await l.req('sessions.describe', { key }, 8000);
    if (!d.ok) return apiError(res, d, 'describe falló');
    // Si el gateway no expone el flag, no afirmamos nada (null = desconocido).
    const s = d.payload?.session;
    const hasActiveRun = s && typeof s.hasActiveRun === 'boolean' ? s.hasActiveRun : null;
    observability.reconcile(l.id, key, s, { revision: activityRevision });
    res.json({ hasActiveRun });
  } catch (e) { apiError(res, e, 'La operación no se pudo completar'); }
});

// Recoverable Gateway activity/progress; no transcript content or synthetic work.
app.get('/api/activity', requireAuth, async (req, res) => {
  const link = getLink(req.query.agent);
  if (!link) return res.status(400).json({ error: 'agente desconocido' });
  const key = typeof req.query.key === 'string' ? req.query.key.trim() : '';
  if (!key || key.length > 4096) return res.status(400).json({ error: 'falta key o es inválida' });
  if (key.startsWith('agent:') && !key.startsWith('agent:' + (link.cfg.gatewayAgentId || 'main') + ':')) return res.status(403).json({ error: 'La sesión no pertenece a este agente' });
  if (link.cfg.gatewayAgentId && !key.startsWith(`agent:${link.cfg.gatewayAgentId}:`)) return res.status(403).json({ error: 'La sesión no pertenece al agente de este panel' });
  try {
    link.ensureSub(key);
    const snapshot = await link.refreshActivity(key);
    res.json({ snapshot });
  } catch (error) {
    const diagnostic = observability.diagnostic(error, { terminal: false });
    res.status(502).json({ error: diagnostic.message, diagnostic, snapshot: observability.snapshot(link.id, key) });
  }
});

app.post('/api/upload', requireAuth, async (req, res, next) => {
  if (req.query.agent === undefined && req.query.key === undefined) return next();
  try {
    const link = getLink(req.query.agent), key = req.query.key;
    if (!link || typeof key !== 'string' || !await access.authorize(req.user, link, key)) return res.status(403).json({ error: 'No tienes acceso a esta conversación o agente', code: 'FORBIDDEN' });
    req.uploadScope = { agent: link.id, sessionKey: key };
    next();
  } catch (error) { apiError(res, error, 'No se pudo verificar el acceso'); }
}, upload.array('files', 6), (req, res) => {
  const files = (req.files || []).map(f => {
    const meta = { name: f.originalname, mimeType: f.mimetype || 'application/octet-stream', size: f.size };
    fs.writeFileSync(f.path + '.meta.json', JSON.stringify({ ...meta, owner: req.user, ...req.uploadScope }), { mode: 0o600 });
    return { id: path.basename(f.path), ...meta };
  });
  res.json({ files });
}, (error, req, res, next) => {
  if (res.headersSent) return next(error);
  if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'Cada archivo puede ocupar hasta ' + MAX_UPLOAD_MB + ' MB' });
  }
  const message = error instanceof multer.MulterError && ['LIMIT_FILE_COUNT', 'LIMIT_UNEXPECTED_FILE'].includes(error.code)
    ? 'Puedes adjuntar hasta 6 archivos con el campo files'
    : 'No se pudo procesar la subida; revisa los archivos y vuelve a intentarlo';
  res.status(400).json({ error: message });
});

// Ficheros: subidas propias, y adjuntos que el agente guarda en su workspace.
// El gateway emite rutas DENTRO de su contenedor (`/home/node/.openclaw/workspace/…`);
// el hub no comparte ese filesystem, así que cada agente tiene su workspace montado
// en `fileRoots` y aquí se mapea la ruta del gateway a la real (2026-10-12: los
// adjuntos daban 404 «sin workspace» porque el hub no veía ningún workspace).
// Además el gateway TRUNCA las rutas largas con `…` en el historial, así que si la
// ruta no resuelve se busca el fichero por su nombre dentro de las raíces.
const FILE_WHITELIST = ['media/', 'uploads/', 'tmp/', 'reports/', 'nas/', 'nas_docs/', 'docs/'];
const ALLOWED_EXT = null;   // sin restricción por extensión (los adjuntos varían)

// An explicit policy replaces the legacy defaults for this fileRoot. Invalid
// policies fail closed: an empty/absolute/parent path must never publish base.
function publishedSubroots(root) {
  if (!Object.hasOwn(root, 'published')) return FILE_WHITELIST;
  if (!Array.isArray(root.published)) return [];
  const normalized = [];
  for (const value of root.published) {
    if (typeof value !== 'string') return [];
    const relative = value.trim();
    if (!relative || /[\\\u0000-\u001f\u007f]/.test(relative) || path.posix.isAbsolute(relative) ||
        /^[A-Za-z]:/.test(relative) || relative.split('/').includes('..')) return [];
    const directory = path.posix.normalize(relative).replace(/\/+$/, '');
    if (!directory || directory === '.') return [];
    normalized.push(directory + '/');
  }
  return [...new Set(normalized)];
}

function pathWithin(root, target) {
  const relative = path.relative(root, target);
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

// The published subroot itself may be a mounted/symlinked NAS volume. A file
// inside it may not use a symlink (or ..) to escape that authorized volume.
function confinedFile(root, target) {
  try {
    if (!pathWithin(path.resolve(root), path.resolve(target))) return null;
    const realRoot = fs.realpathSync(root);
    const realTarget = fs.realpathSync(target);
    if (!pathWithin(realRoot, realTarget) || !fs.statSync(realTarget).isFile()) return null;
    return realTarget;
  } catch { return null; }
}

// Busca un fichero por nombre dentro de una raíz (recursivo, acotado).
// `name` puede ser un nombre exacto o una COLA (el gateway trunca con `…` y solo
// conserva el final del nombre, p.ej. "ones-CANometro-...pdf").
function findByBasename(root, name) {
  const want = name.toLowerCase();
  const stack = [root];
  let visited = 0;
  while (stack.length && visited < 8000) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      visited++;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === '.git' || e.name === 'node_modules' || e.name === '.venv') continue;
        stack.push(full);
      } else if (e.isFile()) {
        const n = e.name.toLowerCase();
        if (n === want) return full;                    // exacto: mejor
        if (want.length > 6 && n.endsWith(want)) return full;   // cola truncada
      }
    }
  }
  return null;
}

app.get('/api/files', requireAuth, (req, res) => {
  const p = String(req.query.path || '');
  let bases = [];   // raíces donde buscar, en orden
  const up = p.match(/^uploads\/(.+)/);
  if (up) { bases = [{ base: DATA_DIR, rel: 'uploads/' + up[1], published: ['uploads/'] }]; }
  else {
    const agent = AGENTS.find(a => a.id === String(req.query.agent || ''));
    const roots = (agent && Array.isArray(agent.fileRoots) ? agent.fileRoots : [])
      .map(x => (typeof x === 'string' ? { base: x, prefix: '' } : x))
      .filter(x => x && x.base);
    if (!roots.length) return res.status(404).json({ error: 'sin workspace para ese agente' });
    // La ruta puede venir con prefijo de contenedor o absoluta real: se normaliza
    // quitando el prefijo del gateway y se prueban las raíces declaradas.
    const norm = p.replace(/^\/home\/node\/\.openclaw\/workspace\/?/, '')
                  .replace(/^\/home\/[^/]+\/\.openclaw\/workspace\/?/, '')
                  .replace(/^\/+/, '');
    for (const root of roots) {
      const pre = String(root.prefix || '').replace(/^\/+|\/+$/g, '');
      const rel = pre && norm.startsWith(pre + '/') ? norm.slice(pre.length + 1) : norm;
      bases.push({ base: root.base, rel, published: publishedSubroots(root) });
    }
  }
  // 1) Normalize before selecting an allowed subroot, then enforce its realpath.
  let found = null;
  let forbidden = false;
  for (const b of bases) {
    const abs = path.resolve(b.base, String(b.rel || '').replace(/^\/+/, ''));
    const relative = path.relative(path.resolve(b.base), abs);
    const published = b.published.find(w => relative.startsWith(w));
    if (!published) { forbidden = true; continue; }
    const root = path.resolve(b.base, published);
    const hit = confinedFile(root, abs);
    if (hit) { found = hit; break; }
  }
  // 2) Ruta truncada por el gateway (`…`): buscar por la COLA del nombre dentro
  // de las carpetas conocidas de cada raíz.
  if (!found && !up) {
    const baseName = (p.split('/').pop() || '').trim();
    if (baseName.includes('\u2026')) {
      const tail = baseName.split('\u2026').pop();
      if (tail && tail.length > 6) {
        outer:
        for (const b of bases) {
          for (const w of b.published) {
            let dir;
            try { dir = fs.realpathSync(path.resolve(b.base, w)); } catch { continue; }
            const hit = findByBasename(dir, tail);
            const safe = hit && confinedFile(dir, hit);
            if (safe) { found = safe; break outer; }
          }
        }
      }
    }
  }
  if (!found) {
    if (!bases.length) return res.status(404).json({ error: 'sin workspace para ese agente' });
    if (forbidden && !p.includes('\u2026')) return res.status(403).json({ error: 'ruta no permitida' });
    return res.status(404).json({ error: 'no encontrado' });
  }
  return sendFileRes(res, found, req.query.dl === '1');
});

// Never give an uploaded HTML/JS document the authenticated application's origin.
// SVG remains embeddable as an image, but navigation to it is an opaque sandbox.
function sendFileRes(res, abs, forceDl) {
  let meta = null;
  try { meta = JSON.parse(fs.readFileSync(abs + '.meta.json', 'utf8')); } catch {}
  const ext = path.extname(meta?.name || abs).toLowerCase();
  const declared = typeof meta?.mimeType === 'string' ? meta.mimeType.split(';')[0].trim().toLowerCase() : '';
  const extensionMimes = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
    '.webp': 'image/webp', '.avif': 'image/avif', '.bmp': 'image/bmp', '.ico': 'image/x-icon',
    '.tif': 'image/tiff', '.tiff': 'image/tiff', '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown', '.markdown': 'text/markdown',
  };
  const candidate = declared || extensionMimes[ext] || '';
  const passive = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp',
    'image/x-icon', 'image/vnd.microsoft.icon', 'image/tiff', 'application/pdf', 'text/plain', 'text/markdown', 'text/x-markdown'];
  const svg = candidate === 'image/svg+xml';
  const inline = svg || passive.includes(candidate);
  res.setHeader('Content-Type', inline ? candidate : 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (svg) res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; style-src 'unsafe-inline'");
  res.setHeader('Content-Disposition', `${forceDl || !inline ? 'attachment' : 'inline'}; filename="${encodeURIComponent(meta?.name || path.basename(abs))}"`);
  res.sendFile(abs);
}

// Branding público (login + header + manifest dinámico) — una fuente, N marcas
// Versión del panel: fichero VERSION en la raíz del repo (MAJOR.MINOR.PATCH).
// Si no existe, "desconocida" — nunca inventar un número.
let PANEL_VERSION = 'desconocida';
try { PANEL_VERSION = fs.readFileSync(path.join(__dirname, 'VERSION'), 'utf8').trim() || 'desconocida'; } catch {}

app.get('/api/branding', (req, res) => res.json({ ...BRANDING, version: PANEL_VERSION,
  ...(publicTenant ? { capabilities: publicTenant.capabilities } : {}) }));
app.get('/manifest.webmanifest', (req, res) => {
  res.setHeader('Content-Type', 'application/manifest+json');
  res.setHeader('Cache-Control', 'no-cache');
  res.json({
    name: BRANDING.manifestName, short_name: BRANDING.manifestShort,
    description: BRANDING.welcomeLine, start_url: '/', display: 'standalone',
    background_color: '#0f1115', theme_color: '#0f1115', orientation: 'portrait-primary',
    icons: [
      { src: '/icons/hub-v2/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/hub-v2/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/hub-v2/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  });
});

app.use((req, res, next) => { if (!res.hasHeader('Cache-Control')) res.setHeader('Cache-Control', 'no-cache'); next(); });
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// WebSocket con los navegadores
// ---------------------------------------------------------------------------
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });
const browsers = new Set();

function messageAllowed(user, message) {
  if (!access.user(user)) return false;
  if (!message.agentId) return true;
  const link = getLink(message.agentId);
  if (!link || !access.canAgent(user, link.id)) return false;
  if (message.sessionKey) return access.canKnown(user, link, message.sessionKey);
  return ['agent', 'sessions', 'models', 'question_snapshot'].includes(message.type);
}

function browserSend(ws, message, response = false) {
  if (ws.readyState !== WebSocket.OPEN) return false;
  if (!access.user(ws.user) || ws.authExpiresAt < Date.now()) { ws.close(4401, 'auth required'); return false; }
  try {
    let value = typeof message === 'string' ? JSON.parse(message) : message;
    if (publicTenant) {
      value = publicTenant.browserMessage(value);
      if (!value) return false;
      message = value;
    }
    if (!response && !messageAllowed(ws.user, value)) return false;
    if (value.type === 'approval' && access.privateOnly(ws.user, value.agentId) && Array.isArray(value.allowed)) message = { ...value, allowed: value.allowed.filter(decision => decision !== 'allow-always') };
    ws.send(typeof message === 'string' ? message : JSON.stringify(message), () => {});
    return true;
  } catch { return false; }
}

function sendAsyncQuestion(ws, message) {
  if (ws.readyState !== WebSocket.OPEN) return false;
  const question = message.asyncQuestion;
  const scope = JSON.stringify([message.agentId, message.sessionKey, question.sourceSessionId || null,
    question.itemId, question.sourceMessageId || null]);
  const serialized = JSON.stringify(message);
  const signature = crypto.createHash('sha256').update(serialized).digest('hex');
  const versions = ws.asyncQuestionVersions ||= new Map();
  const previous = versions.get(scope);
  // Native broadcasts and directed replays share the same delivery ledger.
  // Repeated watches cannot clone a card or regress a confirmed answer.
  if (previous?.signature === signature || (previous?.answered && !question.answered)) return false;
  if (!browserSend(ws, serialized)) return false;
  versions.delete(scope); versions.set(scope, { signature, answered: question.answered === true });
  while (versions.size > 1000) versions.delete(versions.keys().next().value);
  return true;
}

function browserOriginAllowed(req) {
  if (publicTenant) return publicTenant.originAllowed(req);
  const origin = req.headers.origin;
  if (origin === undefined) return true; // Local CLI/test clients need not supply Origin.
  if (typeof origin !== 'string' || !origin || origin === 'null') return false;
  try {
    const actual = new URL(origin);
    if (!['http:', 'https:'].includes(actual.protocol) || actual.username || actual.password ||
        actual.pathname !== '/' || actual.search || actual.hash) return false;
    // Forwarded values are authoritative only on an explicitly trusted proxy deployment.
    const forwarded = name => typeof req.headers[name] === 'string' ? req.headers[name].split(',')[0].trim() : '';
    const host = (BEHIND_PROXY && forwarded('x-forwarded-host')) || req.headers.host;
    const protocol = ((BEHIND_PROXY && forwarded('x-forwarded-proto')) || (req.socket.encrypted ? 'https' : 'http')).toLowerCase();
    if (!host || !['http', 'https'].includes(protocol)) return false;
    const expected = new URL(`${protocol}://${host}`);
    if (expected.username || expected.password || expected.pathname !== '/' || expected.search || expected.hash) return false;
    return actual.origin === expected.origin;
  } catch { return false; }
}

const WS_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const validWsId = value => typeof value === 'string' && WS_REQUEST_ID.test(value);

function unsupportedMethod(result, method) {
  if (result?.ok !== false) return false;
  const error = result.error || {};
  if (['METHOD_NOT_FOUND', 'UNKNOWN_METHOD', 'NOT_IMPLEMENTED', -32601].includes(error.code)) return true;
  return error.code === 'INVALID_REQUEST' && String(error.message || '').includes(method) &&
    /\b(?:unknown|unsupported|unrecognized)\s+(?:rpc\s+)?method\b|\bmethod\b.{0,80}\b(?:not found|not supported|not implemented)\b/i.test(error.message || '');
}

function broadcast(msg) {
  for (const browser of browsers) {
    const deliver = () => msg.type === 'async_question' ? sendAsyncQuestion(browser, msg) : browserSend(browser, msg);
    if (msg.sessionKey && !messageAllowed(browser.user, msg)) {
      access.authorize(browser.user, getLink(msg.agentId), msg.sessionKey).then(allowed => { if (allowed) deliver(); }).catch(() => {});
    } else deliver();
  }
}

function onChatEvent(agentId, p) {
  if (!p || !p.sessionKey || p.isHeartbeat === true) return;
  if (p?.state === 'final' && !normalizeContent(p.message?.content).text && p.runId && p.sessionKey) {
    const link = getLink(agentId), connection = link?.ws;
    if (link) {
      // A native queued admission can emit an empty final before execution.
      // Confirm custody/activity before allowing it to finish the visible run.
      link.req('chat.history', { sessionKey: p.sessionKey, agentId: link.cfg.gatewayAgentId || 'main',
        limit: 1, inputRunIds: [p.runId] }, 10000).then(result => {
        if (link.ws !== connection || !link.connected) return;
        const receipt = result.payload?.inputReceipts?.find(item => item.runId === p.runId);
        if (!result.ok || result.payload?.sessionInfo?.hasActiveRun === true
            || (receipt?.state === 'pending' && !receipt.cancelled) || result.payload?.pendingInputs?.queuedCount > 0) {
          broadcast({ type: 'queue_changed', agentId, sessionKey: p.sessionKey });
          broadcast({ type: 'sessions', agentId });
          return;
        }
        publishChatEvent(agentId, { ...p, terminalVerified: result.payload?.sessionInfo?.hasActiveRun === false });
      }).catch(() => broadcast({ type: 'queue_changed', agentId, sessionKey: p.sessionKey }));
      return;
    }
  }
  publishChatEvent(agentId, p);
}

function publishChatEvent(agentId, p) {
  if (!p || !p.sessionKey || p.isHeartbeat === true) return;
  const activity = observability.ingest(agentId, 'chat', p);
  if (activity.duplicate) return;
  if (p.state === 'status') {
    broadcast({ type: 'phase', agentId, sessionKey: p.sessionKey, runId: p.runId,
      phase: p.phase, ...(p.retry ? { retry: p.retry } : {}), ...(Number.isSafeInteger(p.seq) ? { seq: p.seq } : {}),
    });
    return;
  }
  if (p.state === 'delta') {
    broadcast({ type: 'delta', agentId, sessionKey: p.sessionKey, runId: p.runId, deltaText: p.deltaText || '',
      ...(typeof p.replace === 'boolean' ? { replace: p.replace } : {}),
      ...(Number.isSafeInteger(p.seq) ? { seq: p.seq } : {}),
    });
  } else {
    // Un turno admite.
    const { text } = normalizeContent(p.message?.content);
    broadcast({
      type: p.state, agentId, sessionKey: p.sessionKey, runId: p.runId,
      text: text || undefined,
      errorMessage: p.errorMessage ? observability.safeText(p.errorMessage) : activity.diagnostic?.message,
      ...(activity.diagnostic ? { diagnostic: activity.diagnostic } : {}),
      ...(p.errorKind ? { errorKind: p.errorKind } : {}),
      ...(p.errorDetail ? { errorDetail: observability.redactor.safe(p.errorDetail) } : {}),
      ...(Number.isSafeInteger(p.seq) ? { seq: p.seq } : {}),
      ...(p.terminalVerified ? { terminalVerified: true } : {}),
    });
    const l = getLink(agentId);
    if (l) {
      l.sessionsCache.at = 0;
    }
    broadcast({ type: 'sessions', agentId });
  }
}

// Qué herramienta está usando el agente ahora mismo. El gateway solo lo emite a
// conexiones suscritas a esa sesión (sessions.messages.subscribe).
let toolDebug = 0;
let obsDbg = 0;
function onToolEvent(agentId, p) {
  if (!p || !p.sessionKey) return;
  const d = p.data && typeof p.data === 'object' ? p.data : p;
  const activity = observability.ingest(agentId, 'session.tool', p);
  if (activity.duplicate || p.isHeartbeat === true) return;
  if (toolDebug++ < 3) console.log(`[${agentId}] session.tool: ${observability.safeText(d.name || d.toolName || '')} ${d.phase || ''}`);
  const toolName = observability.safeText(String(d.toolName || d.tool || d.name || ''));
  if (!toolName) return;
  const nativePhase = String(d.phase || d.state || 'start');
  const phase = ['result', 'completed', 'failed', 'error'].includes(nativePhase) ? 'end' : nativePhase;
  const failed = !!activity.diagnostic || d.ok === false || d.isError === true || ['failed', 'error', 'blocked'].includes(d.status);
  broadcast({
    type: 'tool', agentId, sessionKey: p.sessionKey, runId: p.runId,
    callId: d.toolCallId || d.callId || d.itemId, phase, toolName,
    title: d.title || d.meta ? observability.safeText(String(d.title || d.meta)) : undefined,
    ok: failed ? false : undefined,
    error: activity.diagnostic?.message || (d.errorMessage ? observability.safeText(d.errorMessage) : undefined),
    ...(activity.diagnostic ? { diagnostic: activity.diagnostic } : {}),
    ...(Number.isFinite(p.ts) ? { ts: p.ts } : {}),
  });
}

// Evento 'agent': actividad del run que arrancamos nosotros.
//   stream=item       -> item (fase start/update/end) de una herramienta o comando
//   stream=run_status -> fase del run (preparing_context, starting_model…)
//   stream=usage      -> tokens de salida
function onAgentEvent(agentId, p) {
  if (!p || !p.sessionKey) return;
  const activity = observability.ingest(agentId, 'agent', p);
  if (activity.duplicate || p.isHeartbeat === true) return;
  const d = p.data || {};
  const base = { agentId, sessionKey: p.sessionKey, runId: p.runId };
  if (p.stream === 'tool') {
    // session.tool and agent/tool carry the same native shape. Projection was
    // already ingested above; emit the legacy tool frame without re-ingesting.
    const name = d.name || d.toolName;
    if (!name) return;
    const phase = ['result', 'completed', 'failed', 'error'].includes(d.phase) ? 'end' : d.phase || 'start';
    broadcast({ ...base, type: 'tool', callId: d.toolCallId || d.callId, phase, toolName: observability.safeText(name),
      ...(d.title || d.meta ? { title: observability.safeText(String(d.title || d.meta)) } : {}),
      ...(activity.diagnostic || d.isError === true || d.ok === false ? { ok: false } : {}),
      ...(activity.diagnostic ? { diagnostic: activity.diagnostic, error: activity.diagnostic.message } : {}),
    });
  } else if (p.stream === 'item') {
    if (d.kind !== 'tool') return;                 // 'command' es el mismo trabajo, duplicado
    const toolName = observability.safeText(String(d.name || ''));
    if (!toolName) return;
    broadcast({
      ...base, type: 'tool', callId: d.toolCallId || d.itemId, phase: d.phase || 'start', toolName,
      title: d.title || d.meta ? observability.safeText(String(d.title || d.meta)) : undefined,
      ...(d.status === 'failed' || d.status === 'error' ? { ok: false } : {}),
      ...(activity.diagnostic ? { diagnostic: activity.diagnostic, error: activity.diagnostic.message } : {}),
    });
  } else if (p.stream === 'run_status') {
    if (!d.phase) return;
    broadcast({ ...base, type: 'phase', phase: String(d.phase), ...(d.phase === 'retrying' ? { retry: { attempt: d.attempt, maxAttempts: d.maxAttempts, reason: d.reason, retryAfterMs: d.retryAfterMs } } : {}) });
  } else if (p.stream === 'usage') {
    if (d.outputTokens == null) return;
    broadcast({ ...base, type: 'usage', outputTokens: d.outputTokens });
  }
}

// ---------------------------------------------------------------------------
// Preguntas del agente (ask_user) y aprobaciones (exec/plugin/system-agent)
// ---------------------------------------------------------------------------
// Ambas son "el bot pregunta algo y espera respuesta". Se reemiten al navegador
// normalizadas, y se resuelven por HTTP (el navegador no habla con el gateway).
let qDbg = 0, aDbg = 0;

// Ids de avisos ya notificados por push. Sin esto (y sin declararlo) CUALQUIER
// question.requested/session.approval mataba el proceso con
// "ReferenceError: notified is not defined" y el contenedor se reiniciaba.
// El gateway reemite replays (question.list al conectar, approvalReplay de
// subscribe), así que el Set evita repetir el aviso; se poda para no crecer.
const notified = new Set();
const NOTIFIED_MAX = 500;
function markNotified(key) {
  notified.add(key);
  while (notified.size > NOTIFIED_MAX) notified.delete(notified.values().next().value);
}

function onQuestionEvent(agentId, p) {
  const q = p?.question || p;
  if (!q || !q.id) return;
  const link = getLink(agentId);
  const pending = p.phase !== 'resolved' && (!q.status || q.status === 'pending');
  if (pending && link && !blockingQuestionInScope(q, link.cfg.gatewayAgentId || 'main')) return;
  // Native resolved events contain only {id,status,answers?}. An unknown
  // terminal ID may invalidate an in-flight global list, but is not our card.
  if (!pending && link && !link.pendingQuestions.has(q.id)) { link.questionRevision++; return; }
  const notifiedKey = 'q:' + agentId + ':' + q.id;
  const previous = link?.pendingQuestions.get(q.id);
  const sessionKey = q.sessionKey || previous?.sessionKey || null;
  if (pending && !notified.has(notifiedKey)) {
    markNotified(notifiedKey);
    const first = (q.questions && q.questions[0]) || {};
    onNewAlert('pregunta', agentId, first.question || 'te pregunta algo', sessionKey).catch(() => {});
  }
  if (qDbg++ < 2) console.log(`[${agentId}] question ${p.phase}: ${q.id} (${q.status || 'pending'})`);
  const message = {
    type: 'question', phase: p.phase || 'pending', agentId,
    id: q.id, sessionKey, runId: q.runId || previous?.runId || null,
    status: q.status || (p.phase === 'resolved' ? 'answered' : 'pending'),
    createdAtMs: q.createdAtMs, expiresAtMs: q.expiresAtMs,
    answers: q.answers || null, resolvedBy: q.resolvedBy || null,
    questions: Array.isArray(q.questions) ? q.questions.map(normalizeBlockingQuestion) : [],
  };
  if (link) {
    if (pending && JSON.stringify(previous) === JSON.stringify(message)) return;
    link.questionRevision++;
    if (pending) link.pendingQuestions.set(q.id, message);
    else link.pendingQuestions.delete(q.id);
  }
  broadcast(message);
}

function onApprovalEvent(agentId, p) {
  if (!p || !p.approval) return;
  const link = getLink(agentId), a = p.approval;
  const previous = link?.approvalSessions.get(a.id);
  const sessionKey = a.sourceSessionKey || a.request?.sessionKey || a.sessionKey || p.sessionKey || previous?.sessionKey || null;
  if (!link || !sessionKey || !access.inScope(link, sessionKey)) return;
  const pending = (p.phase === 'pending' || a.status === 'pending');
  if (link && a.id) {
    if (pending) link.approvalSessions.set(a.id, { sessionKey, kind: a.presentation?.kind || null });
    else link.approvalSessions.delete(a.id);
  }
  if (!notified.has('a:' + p.approval.id)) {
    markNotified('a:' + p.approval.id);
    const pres = p.approval.presentation || {};
    if (pending) onNewAlert('permiso', agentId, pres.commandText || pres.title || 'pide permiso', sessionKey).catch(() => {});
  }
  if (aDbg++ < 3) console.log(`[${agentId}] approval ${p.phase}: ${JSON.stringify(p.approval).slice(0, 600)}`);
  const pres = a.presentation || {};
  // Campos reales del presentation (visto en vivo): kind, commandText, warningText,
  // host, nodeId, agentId, allowedDecisions
  const cmd = pres.commandText || pres.command || '';
  const parts = [];
  if (cmd && cmd !== pres.title) parts.push(cmd);
  if (pres.warningText) parts.push('⚠️ ' + pres.warningText);
  const hostLabel = pres.host === 'gateway' ? 'esta máquina' : (pres.host || '');
  if (hostLabel) parts.push('Se ejecuta en: ' + hostLabel + (pres.nodeId ? ' (' + pres.nodeId + ')' : ''));
  broadcast({
    type: 'approval', phase: p.phase || a.status || 'pending', agentId,
    id: a.id, status: a.status,
    sessionKey,
    kind: pres.kind || null,
    title: String(pres.title || pres.summary || pres.label || '').slice(0, 200),
    detail: parts.join('\n').slice(0, 600),
    allowed: Array.isArray(pres.allowedDecisions) ? pres.allowedDecisions : null,
    createdAtMs: a.createdAtMs, expiresAtMs: a.expiresAtMs,
    decision: a.decision || null, reason: a.reason || null,
    urlPath: a.urlPath || null,
  });
}

// Titular humano del turno (redactado por el modelo o un modelo utilitario).
function onObserverEvent(agentId, p) {
  if (!p || !p.sessionKey) return;
  const activity = observability.ingest(agentId, 'session.observer', p);
  if (activity.duplicate || p.isHeartbeat === true) return;
  if (obsDbg++ < 3) console.log(`[${agentId}] observer: ${Object.keys(p).join(',')}`);
  const headline = observability.safeText(String(p.headline || p.summary || p.text || p.digest?.headline || '')).trim();
  if (!headline) return;
  broadcast({ type: 'observer', agentId, sessionKey: p.sessionKey, runId: p.runId, headline });
}

wss.on('connection', (ws, req) => {
  ws.on('error', () => browsers.delete(ws));
  if (!browserOriginAllowed(req)) { ws.close(4403, 'origin not allowed'); return; }
  const u = authUser(req);
  if (!u) { ws.close(4401, 'auth required'); return; }
  ws.user = u;
  ws.request = req;
  ws.authExpiresAt = verifyCookie(parseCookies(req).hubweb)?.exp || 0;
  browsers.add(ws);
  browserSend(ws, {
    type: 'hello',
    user: u,
    agents: AGENTS.filter(a => access.canAgent(u, a.id)).map(a => ({ id: a.id, connected: !!getLink(a.id)?.connected })),
  });
  for (const link of links.values()) {
    if (!access.canAgent(u, link.id)) continue;
    (async () => {
      const visible = [];
      for (const question of link.pendingQuestions.values()) if (await access.authorize(u, link, question.sessionKey)) visible.push(question);
      browserSend(ws, { type: 'question_snapshot', agentId: link.id, ids: visible.map(question => question.id) });
      for (const question of visible) browserSend(ws, question);
      await link.pullQuestions();
    })().catch(() => {});
  }
  ws.agentId = null;
  ws.on('close', () => browsers.delete(ws));
  ws.on('message', async (d) => {
    if (!access.user(u) || ws.authExpiresAt < Date.now()) { ws.close(4401, 'auth required'); return; }
    let m; try { m = JSON.parse(d); } catch { return; }
    if (!m || typeof m !== 'object' || Array.isArray(m)) return;
    if (publicTenant && !publicTenant.validWs(m)) {
      browserSend(ws, { type: m.type === 'abort' ? 'abort_result' : 'send_error',
        agentId: publicTenant.name, sessionKey: publicTenant.validKey(m.sessionKey) ? m.sessionKey : undefined,
        requestId: validWsId(m.requestId) ? m.requestId : null,
        clientMessageId: validWsId(m.clientMessageId) ? m.clientMessageId : null,
        error: publicTenant.error, ok: false, queueCleared: false }, true);
      return;
    }
    const agentId = typeof m.agentId === 'string' ? m.agentId : '';
    const key = typeof m.sessionKey === 'string' ? m.sessionKey.trim() : '';
    const requestId = validWsId(m.requestId) ? m.requestId : null;
    const l = getLink(agentId);
    if (m.type === 'send') {
      const clientMessageId = m.clientMessageId === undefined ? crypto.randomUUID() : (validWsId(m.clientMessageId) ? m.clientMessageId : null);
      const response = { agentId, sessionKey: key, clientMessageId, requestId };
      const reject = error => {
        const diagnostic = l && access.canKnown(u, l, key)
          ? observability.recordDiagnostic(agentId, key, error, { terminal: false, requestId })
          : observability.diagnostic(error, { terminal: false, requestId });
        browserSend(ws, { type: 'send_error', ...response, error: diagnostic.message, diagnostic }, true);
      };
      try {
        if (!l) throw new Error('agente desconocido');
        if (!await access.authorize(u, l, key)) throw Object.assign(new Error('No tienes acceso a esta conversación o agente'), { code: 'FORBIDDEN' });
        if (!clientMessageId) throw new Error('clientMessageId inválido (1–128 caracteres seguros)');
        if (m.requestId != null && !requestId) throw new Error('requestId inválido (1–128 caracteres seguros)');
        if (!key) throw new Error('falta la sesión');
        if (m.text != null && typeof m.text !== 'string') throw new Error('mensaje inválido');
        const text = m.text || '';
        const attachments = m.attachments ?? [];
        if (!Array.isArray(attachments) || attachments.length > 6) throw new Error('adjuntos inválidos (máximo 6)');
        if (!text && !attachments.length) throw new Error('el mensaje está vacío');
        const atts = [];
        for (const a of attachments) {
          if (!a || typeof a !== 'object' || typeof a.id !== 'string' || !a.id || a.id.length > 200 || path.basename(a.id) !== a.id) {
            throw new Error('identificador de adjunto inválido; vuelve a subirlo');
          }
          const f = confinedFile(path.join(DATA_DIR, 'uploads'), path.join(DATA_DIR, 'uploads', a.id));
          if (!f) throw new Error('El adjunto ya no está disponible; vuelve a subirlo');
          if (!access.canUpload(u, uploadMetadata(a.id), agentId)) throw Object.assign(new Error('El adjunto pertenece a otra cuenta'), { code: 'FORBIDDEN' });
          let content;
          try { content = fs.readFileSync(f).toString('base64'); }
          catch { throw new Error('No se pudo leer el adjunto; vuelve a subirlo'); }
          atts.push({
            type: typeof a.mimeType === 'string' && a.mimeType.startsWith('image/') ? 'image' : 'file',
            mimeType: typeof a.mimeType === 'string' && a.mimeType ? a.mimeType.slice(0, 200) : 'application/octet-stream',
            fileName: typeof a.name === 'string' && a.name ? a.name.slice(0, 200) : 'file',
            content,
          });
        }
        ws.agentId = agentId;
        const r = await l.req('chat.send', {
          sessionKey: key, message: text,
          attachments: atts.length ? atts : undefined,
          idempotencyKey: access.namespaced(u, agentId, JSON.stringify([key, clientMessageId]), 'send'),
        }, 20000);
        if (!r.ok) throw gatewayRpcError(r, 'fallo al enviar');
        const runId = r.payload?.runId || null;
        l.ensureSub(key);
        browserSend(ws, { type: 'send_accepted', ...response, runId }, true);
      } catch (e) {
        reject(e);
      }
    } else if (m.type === 'watch') {
      // El navegador abre una sesión (o vuelve a ella): suscribir para ver herramientas.
      if (l && await access.authorize(u, l, key)) {
        const connection = l.ws;
        l.ensureSub(key).then(authorized => {
          if (authorized) return l.replayAsyncQuestionsToBrowser(ws, key, connection);
        }).catch(() => {});
        browserSend(ws, { type: 'activity_snapshot', agentId, sessionKey: key, snapshot: observability.snapshot(agentId, key) });
        l.refreshActivity(key).then(snapshot => browserSend(ws, { type: 'activity_snapshot', agentId, sessionKey: key, snapshot })).catch(() => {});
      }
    } else if (m.type === 'abort') {
      const response = { type: 'abort_result', agentId, sessionKey: key, requestId };
      try {
        if (!l) throw new Error('agente desconocido');
        if (!await access.authorize(u, l, key)) throw Object.assign(new Error('No tienes acceso a esta conversación o agente'), { code: 'FORBIDDEN' });
        if (!key) throw new Error('falta la sesión');
        if (m.requestId != null && !requestId) throw new Error('requestId inválido');
        let result = await l.req('sessions.abort', { key, clearQueued: true }, 15000);
        let queueCleared = result.ok === true;
        let warning;
        if (unsupportedMethod(result, 'sessions.abort')) {
          result = await l.req('chat.abort', { sessionKey: key }, 15000);
          queueCleared = false;
          warning = 'Este gateway solo permite detener el turno; no se ha confirmado la limpieza de la cola';
        }
        if (!result.ok) throw gatewayRpcError(result, 'No se pudo detener el turno');
        browserSend(ws, { ...response, ok: true, queueCleared, aborted: result.payload?.aborted === true, ...(warning ? { warning } : {}) }, true);
      } catch (error) {
        const diagnostic = l && access.canKnown(u, l, key)
          ? observability.recordDiagnostic(agentId, key, error, { terminal: false, requestId })
          : observability.diagnostic(error, { terminal: false, requestId });
        browserSend(ws, { ...response, ok: false, queueCleared: false, error: diagnostic.message, diagnostic }, true);
      }
    }
  });
});

server.listen(PORT, BIND, () => {
  console.log(`[hub] escuchando en ${BIND}:${PORT}`);
  console.log(`[hub] agentes: ${AGENTS.map(a => a.id).join(', ')}`);
});
