/* biz-web frontend — minimal chat client */
'use strict';

const $ = (id) => document.getElementById(id);
const state = {
  user: null,
  sessionScope: 'shared',
  sessionScopes: {},
  agents: [],             // [{id,name,emoji,role,connected,models[]}]
  agent: null,            // agente seleccionado (id)
  sessions: [],
  sessionsError: null,
  historyLoading: false,
  contextWindow: 262144,
  current: null,          // session key
  running: false,
  runningByKey: {},       // "agentId|sessionKey" -> bool
  runSinceByKey: {},      // "agentId|sessionKey" -> ts del lanzamiento (para no apagar un turno recien lanzado)
  lastEventByKey: {},     // "agentId|sessionKey" -> ts de la ultima senal recibida del gateway
  pendingFiles: [],
  showAll: false,
  showOthers: false,      // ver cron/subagentes/canal en vez de las sesiones propias
  filter: '',             // texto del buscador del panel lateral
  collapsed: {},         // "parentKey" -> false cuando el usuario lo ha desplegado; por defecto, plegado
  sortMode: (() => { try { return localStorage.getItem('hub.sort') || 'dia'; } catch { return 'dia'; } })(),   // 'dia' | 'recientes'
  questions: {},         // id -> registro de pregunta pendiente
  asyncQuestions: {},    // agent/session/item -> non-blocking structured choice
  approvals: {},         // id -> aprobación pendiente
  hiddenCount: 0,
  othersCount: 0,
  ownCount: 0,
  ws: null,
  streamBubble: null,
  streamText: '',
  liveTools: null,        // bloque en vivo de herramientas del turno actual
  pinned: true,           // usuario pegado al fondo del scroll (autoscroll solo si true)
  streamRenderTimer: null,
  sessionError: null,   // {msg, agentId, sessionKey} — error de la sesión actual
  errors: [],          // {id, msg, time, type} — avisos de error pendientes
};

const rk = (agentId, key) => `${agentId}|${key}`;   // clave de ejecución
// El árbol nace plegado: solo se ven las sesiones raíz. Un valor `false`
// explícito en state.collapsed marca la rama que el usuario ha desplegado.
const isTreeCollapsed = (key) => state.collapsed[key] !== false;

// Capture the request owner before awaiting it; a delayed failure must never
// be attributed to whichever session happens to be open when it returns.
async function hubFetch(input, init) {
  const url = new URL(String(input), location.href);
  let owner = { agentId: url.searchParams.get('agent') || state.agent, sessionKey: url.searchParams.get('key') || state.current };
  if (typeof init?.body === 'string') {
    try { const body = JSON.parse(init.body); owner = { agentId: body.agent || owner.agentId, sessionKey: body.key || owner.sessionKey }; } catch {}
  }
  let response;
  try { response = await window.fetch(input, init); }
  catch (error) {
    if (error.name !== 'AbortError') window.HubActivity?.reportError({ id: 'network:' + url.pathname, message: error.message || 'Sin conexión con el servidor', kind: 'connection', terminal: false }, owner);
    throw error;
  }
  const legacyProbe = url.pathname === '/api/history-page' && [404, 405].includes(response.status);
  if (!response.ok && url.pathname.startsWith('/api/') && !legacyProbe) {
    try {
      const body = await response.clone().json();
      if (body.error) window.HubActivity?.reportError(body.diagnostic || { id: 'http:' + url.pathname + ':' + response.status + ':' + body.error, message: body.error, httpStatus: response.status, code: body.code, details: body.details, terminal: false }, owner);
    } catch {}
  }
  return response;
}
// Settings are scoped by both agent and session; late responses must not repaint another chat.
const modelSettings = new Map();
const modelSettingsReads = new Map();
const modelSettingsReadVersions = new Map();
let modelSettingsReadSequence = 0;
let modelSettingsEpoch = 0;
let modelSettingsPending = null;
let modelProviderDraft = null;
let modelSettingsNotice = null;
// Navigation responses belong to one view, even if two agents share session keys.
let chatNavigationVersion = 0;
let sessionListVersion = 0;
let sessionListOperation = null;
const draftCache = new Map();
const pendingSends = new Map();
const sendNotices = new Map();
const uploadingByKey = new Map();
const questionDrafts = new Map();
const asyncQuestionDrafts = new Map();
const streamSequences = new Map();
const historyReadVersions = new Map();
let historyReadSequence = 0;
const historyPages = new Map();
const asyncTranscriptIds = new Map();
const asyncHistoryReads = new Map();
const asyncQuestionRefreshQueue = new Map();
const asyncQuestionRefreshReads = new Map();
const asyncQuestionEpochs = new Map();
const asyncQuestionInvalidations = new Set();
let deferredFinalHistory = null;
let sessionSearchMode = 'titles';
let sessionSearchVersion = 0;
let sessionSearchState = { agent: null, query: '', results: [], loading: false, error: null };
let newSessionPending = null;
const newSessionRetries = new Map();
const renameDrafts = new Map();
let renameEditing = null;
// Al cambiar de agente en móvil, mantener el cajón abierto: la auto-selección de la
// última sesión no debe cerrarlo (se consume al pasar por selectSession).
let mobileKeepNav = false;
const curAgent = () => state.agents.find(a => a.id === state.agent) || null;
// Canonical terminal observations outrank a stale list, but not a new local send
// whose admission or first native event has not arrived yet.
function isObservedIdle(agentId, key, observed = window.HubActivity?.status(agentId, key)) {
  if (!observed?.connected || observed.uncertain || observed.hasActiveRun !== false || !['completed', 'aborted', 'error'].includes(observed.status)) return false;
  const scope = rk(agentId, key);
  if (pendingSends.has(scope)) return false;
  if (window.HubQueue?.isActive(agentId, key)) return false;
  if (window.HubQueue?.hasPending(agentId, key)) return false;
  if (window.HubQueue?.hasUnconfirmed(agentId, key)) return false;
  const latest = window.HubQueue?.latestAdmission(agentId, key);
  if (latest?.runId && latest.runId !== observed.runId) return false;
  const updatedAt = typeof observed.updatedAt === 'number' ? observed.updatedAt : Date.parse(observed.updatedAt || '');
  if ((latest && !latest.runId && latest.at > updatedAt) || (state.runSinceByKey[scope] && (!Number.isFinite(updatedAt) || updatedAt < state.runSinceByKey[scope]))) return false;
  if (RUN.agent === agentId && RUN.key === key && RUN.runId && observed.runId && RUN.runId !== observed.runId) return false;
  return true;
}
const isRunning = (s) => !!s && !isObservedIdle(state.agent, s.key) && !!(state.runningByKey[rk(state.agent, s.key)] || s.hasActiveRun);
// Una sesión falló en su último turno: mostrar indicador de error
const isFailed = (s) => s ? !!s.lastRunFailed : false;

window.HubQueue?.configure({
  request: hubFetch, user: () => state.user,
  connected: () => state.ws?.readyState === WebSocket.OPEN && !!curAgent()?.connected,
  pending: (agent, key) => pendingSends.has(rk(agent, key)),
  busy: (agent, key) => !!state.runningByKey[rk(agent, key)], notice: message => toast(message),
  onSnapshot(agent, key, snapshot, observation) {
    const scope = rk(agent, key), latest = window.HubQueue?.latestAdmission(agent, key);
    const stopSettled = settleStopFromSnapshot(agent, key, snapshot, observation);
    if (snapshot.hasActiveRun === true) setRunning(agent, key, true);
    else if (snapshot.available === true && snapshot.hasActiveRun === false && !window.HubQueue?.hasPending(agent, key)
        && !window.HubQueue?.hasUnconfirmed(agent, key) && !pendingSends.has(scope)
        && (stopSettled || !latest || Date.now() - latest.at >= 2500)) {
      const wasRunning = state.runningByKey[scope];
      setRunning(agent, key, false);
      if (wasRunning && state.agent === agent && state.current === key) reloadFinalMessages(key);
    }
    if (state.agent === agent && state.current === key) updateComposerState();
  },
});

// ---------------------------------------------------------------------------
// Avisos de error persistentes en el sidebar
// ---------------------------------------------------------------------------
let ERR_ID = 0;
const reportedFailed = new Set();  // claves de sesión con error ya notificado

function addError(msg, type, diagnostic, owner = {}) {
  const id = ++ERR_ID;
  state.errors.push({ id, msg, time: Date.now(), type: type || 'error' });
  if (state.errors.length > 60) state.errors.splice(0, state.errors.length - 60);
  window.HubActivity?.reportError(diagnostic || { id: 'notice-' + String(type || 'error') + ':' + msg, message: msg, kind: type === 'conn' ? 'connection' : type, terminal: false }, { agentId: owner.agentId || state.agent, sessionKey: owner.sessionKey || state.current });
  renderErrors();
}
function clearError(id) {
  state.errors = state.errors.filter(e => e.id !== id);
  renderErrors();
}
function clearAllErrors() {
  state.errors = [];
  window.HubActivity?.clearNotices();
  renderErrors();
}
function renderErrors() {
  if (window.HubActivity) { window.HubActivity.renderNotices(); return; }
  const el = document.getElementById('s-errors');
  if (!el) return;
  el.classList.toggle('hidden', !state.errors.length);
  if (!state.errors.length) { el.classList.remove('warn', 'crit'); return; }
  const last = state.errors[state.errors.length - 1];
  el.querySelector('.s-err-icon').textContent = last.type === 'conn' ? '🔌' : '⚠️';
  el.querySelector('.s-err-count').textContent = state.errors.length;
  el.querySelector('.s-err-text').textContent =
    state.errors.length > 1
      ? `+${state.errors.length - 1} más: ${last.msg}`
      : last.msg;
  const hasCrit = state.errors.some(e => e.type !== 'conn');
  el.classList.toggle('crit', hasCrit);
  el.classList.toggle('warn', !hasCrit);
}

// ---------------------------------------------------------------------------
// Web Push: la notificación llega al SO aunque la PWA esté cerrada.
// Se pide el permiso la primera vez que entras y se guarda la suscripción en el
// servidor, por usuario (cada navegador del mismo usuario recibe igual).
// ---------------------------------------------------------------------------
let swReg = null;
function supports(feature) { return state.branding?.capabilities?.[feature] !== false; }
const pushSupported = () => supports('push') && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

async function initPush() {
  if (!pushSupported()) return;
  try {
    swReg = await navigator.serviceWorker.register('/sw.js');
  } catch (e) { console.warn('[push] service worker no registrado:', e.message); return; }
  // Sin pedir de entrada: el permiso se pide al primer aviso o desde el aviso del panel
  if (Notification.permission === 'granted') await savePushSubscription();
}

async function savePushSubscription() {
  try {
    if (!swReg) swReg = await navigator.serviceWorker.ready;
    const r = await hubFetch('/api/push-key').then(x => x.json());
    if (!r.publicKey) return;
    const appKey = urlB64ToUint8Array(r.publicKey);
    let sub = await swReg.pushManager.getSubscription();
    if (!sub) sub = await swReg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: appKey });
    const j = sub.toJSON();
    await hubFetch('/api/push-sub', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: j.endpoint, keys: j.keys }),
    });
  } catch (e) { console.warn('[push] no se pudo guardar la suscripción:', e.message); }
}

async function askPushPermission() {
  if (!pushSupported()) { toast('Este navegador no soporta notificaciones'); return; }
  try {
    const perm = await Notification.requestPermission();
    if (perm === 'granted') { toast('🔔 Avisos activados en este dispositivo'); await savePushSubscription(); }
    else toast('Notificaciones no concedidas');
  } catch { toast('No se pudo pedir el permiso'); }
}

function urlB64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}

// ---------------------------------------------------------------------------
// Boot / auth
// ---------------------------------------------------------------------------
async function applyBranding() {
  const b = await hubFetch('/api/branding').then(r => r.json()).catch(() => null);
  if (!b) return;
  state.branding = b;
  window.HubCapabilities = b.capabilities || {};
  $('btn-attach').classList.toggle('hidden', !supports('files'));
  $('btn-push-settings')?.classList.toggle('hidden', !pushSupported());
  if (b.title) document.title = b.title;
  const at = document.querySelector('meta[name="apple-mobile-web-app-title"]');
  if (at && b.manifestShort) at.setAttribute('content', b.manifestShort);
  const logo = document.querySelector('.login-logo'); if (logo && b.emoji) logo.textContent = b.emoji;
  const h1 = document.querySelector('.login-card h1'); if (h1 && b.name) h1.textContent = b.name;
  const sub = document.querySelector('.login-sub'); if (sub && b.welcomeLine) sub.textContent = b.welcomeLine;
  const brand = document.querySelector('.brand'); if (brand) brand.textContent = `${b.emoji || ''} ${b.name || ''}`.trim();
  // Chip de versión discreto en el pie del sidebar (patrón LengIA)
  const ver = $('sb-version');
  if (ver && b.version) { ver.textContent = 'v' + b.version; ver.title = 'Panel v' + b.version; ver.classList.remove('hidden'); }
}

let authenticatedOwner = null;
async function boot() {
  await applyBranding();
  const me = await hubFetch('/api/me').then(r => r.json()).catch(() => ({}));
  if (!me.user) return showLogin();
  if (authenticatedOwner && authenticatedOwner !== me.user) { location.reload(); return; }
  authenticatedOwner = me.user;
  state.user = me.user;
  state.sessionScope = me.sessionScope || 'shared';
  state.sessionScopes = me.sessionScopes || {};
  state.legacyStorageOwner = me.legacyStorageOwner === true;
  loadUserLocalState();
  $('me-name').textContent = me.user;
  $('login-view').classList.add('hidden');
  $('app').classList.remove('hidden');
  cleanDrafts();
  connectWs();
  initPush();
  await loadAgents();
}

// ---------------------------------------------------------------------------
// Persistencia local: posición (agente+sesión) y borradores del composer
// ---------------------------------------------------------------------------
const POS_KEY = 'hub.pos';
// Última sesión abierta POR AGENTE: al cambiar de agente se vuelve a dónde estabas
// (antes el cambio dejaba el chat vacío y había que rebuscar la sesión).
const LAST_KEY = 'hub.last';
let lastByAgent = {};
const userStorageKey = key => state.user ? key + '.user.' + encodeURIComponent(state.user) : key;
function userStored(key) {
  const value = localStorage.getItem(userStorageKey(key));
  return value ?? (state.legacyStorageOwner ? localStorage.getItem(key) : null);
}
function loadUserLocalState() {
  lastByAgent = {};
  try { lastByAgent = JSON.parse(userStored(LAST_KEY) || '{}') || {}; } catch {}
}
function rememberSession(agentId, key) {
  if (!agentId || !key) return;
  lastByAgent[agentId] = key;
  try { localStorage.setItem(userStorageKey(LAST_KEY), JSON.stringify(lastByAgent)); } catch {}
}
function savePos() {
  try { localStorage.setItem(userStorageKey(POS_KEY), JSON.stringify({ agent: state.agent, key: state.current })); } catch {}
  if (state.agent && state.current) rememberSession(state.agent, state.current);
}
function loadPos() {
  try { return JSON.parse(userStored(POS_KEY) || 'null'); } catch { return null; }
}
const legacyDraftKey = (agent, key) => 'hub.draft.' + rk(agent, key);
const draftKey = (agent = state.agent, key = state.current) => userStorageKey(legacyDraftKey(agent, key));
function readDraft(agent = state.agent, key = state.current) {
  if (!agent || !key) return { text: '', files: [] };
  const scope = rk(agent, key);
  if (draftCache.has(scope)) return draftCache.get(scope);
  let saved = null;
  try { saved = JSON.parse(userStored(legacyDraftKey(agent, key)) || 'null'); } catch {}
  const draft = { ...saved, text: typeof saved?.text === 'string' ? saved.text : '', files: Array.isArray(saved?.files) ? saved.files.filter(file => file?.id && typeof file.name === 'string') : [] };
  draftCache.set(scope, draft);
  return draft;
}
function writeDraft(draft, agent = state.agent, key = state.current) {
  if (!agent || !key) return;
  const saved = { ...draft, t: Date.now() };
  draftCache.set(rk(agent, key), saved);
  try {
    if (saved.text || saved.files?.length || saved.submission) localStorage.setItem(draftKey(agent, key), JSON.stringify(saved));
    else localStorage.removeItem(draftKey(agent, key));
    if (state.legacyStorageOwner) localStorage.removeItem(legacyDraftKey(agent, key));
  } catch { /* The in-memory draft remains usable when storage is unavailable. */ }
}
function saveDraft() {
  if (!state.current) return;
  writeDraft({ ...readDraft(), text: $('input').value, files: [...state.pendingFiles] });
}
function restoreDraft() {
  const draft = readDraft();
  $('input').value = draft.text;
  state.pendingFiles = [...draft.files];
  renderChips();
  autogrow();
  updateComposerState();
}
function clearDraft(agent = state.agent, key = state.current) {
  draftCache.delete(rk(agent, key));
  try { if (key) localStorage.removeItem(draftKey(agent, key)); } catch {}
  try { if (key && state.legacyStorageOwner) localStorage.removeItem(legacyDraftKey(agent, key)); } catch {}
}
function cleanDrafts() {
  try {
    const now = Date.now();
    for (const k of Object.keys(localStorage)) {
      if (!k.startsWith('hub.draft.')) continue;
      const v = JSON.parse(localStorage.getItem(k) || 'null');
      if (!v?.t || now - v.t > 7 * 864e5) localStorage.removeItem(k);
    }
  } catch {}
}

// ---------------------------------------------------------------------------
// Agentes
// ---------------------------------------------------------------------------
async function loadAgents() {
  const r = await hubFetch('/api/agents').then(r => r.json()).catch(() => null);
  if (!r || !r.agents) return;
  state.agents = r.agents;
  // A private account's filtered catalog is not a dedicated single-agent panel.
  // Keep its agent visible, especially in the empty mobile navigation drawer.
  state.singleAgent = r.agents.length === 1 && (state.sessionScopes[r.agents[0].id] || state.sessionScope) !== 'own';
  const strip = $('agent-strip');
  if (strip) strip.classList.toggle('hidden', state.singleAgent);
  if (!state.agent && r.agents.length) {
    // Restaurar donde estabas al cerrar la app (agente + sesión)
    const pos = loadPos();
    const wanted = pos && r.agents.some(a => a.id === pos.agent) ? pos.agent : r.agents[0].id;
    await selectAgent(wanted, pos?.agent === wanted ? pos.key : null);
  } else { renderAgents(); renderModels(); setGw(!!curAgent()?.connected); }
}

function renderAgents() {
  const el = $('agent-strip');
  el.innerHTML = '';
  for (const a of state.agents) {
    const d = document.createElement('button');
    d.className = 'agent-chip' + (a.id === state.agent ? ' active' : '') + (a.connected ? '' : ' off');
    d.dataset.agentId = a.id;
    d.setAttribute('aria-pressed', String(a.id === state.agent));
    d.title = a.connected ? `${a.name} — ${a.role || ''}` : `${a.name} — sin conexión${a.error ? ': ' + a.error : ''}`;
    d.innerHTML = `<span class="a-emoji">${a.emoji || '🤖'}</span><span class="a-name">${esc(a.name)}</span>`;
    const pending = questionAttentionItems().filter(item => item.agentId === a.id).length;
    if (pending) {
      const badge = document.createElement('span'); badge.className = 'a-pending'; badge.textContent = String(pending);
      badge.setAttribute('aria-label', pending + ' preguntas pendientes'); d.appendChild(badge);
      d.title += ' · ' + pending + ' pendientes';
    }
    d.addEventListener('click', () => selectAgent(a.id));
    el.appendChild(d);
  }
}

async function selectAgent(id, restoreKey = null) {
  if (state.agent === id && !restoreKey) { renderAgents(); return; }
  saveDraft();
  const navigationVersion = ++chatNavigationVersion;
  // En móvil, cambiar de agente NO debe cerrar el cajón: desde el selector interesa
  // ver la lista del agente nuevo y elegir sesión. Se conserva el estado del cajón
  // a través de la auto-selección (que en escritorio sí navega al chat).
  mobileKeepNav = isMobile() && document.body.classList.contains('nav-open');
  // Al cambiar de agente, volver a la última sesión que abriste con él.
  if (!restoreKey && id !== state.agent) restoreKey = lastByAgent[id] || null;
  state.agent = id;
  reportedFailed.clear();   // cambiar de agente: resetear notificaciones de fallo
  state.current = null;
  state.historyLoading = false;
  state.pendingFiles = [];
  renderChips();
  state.sessionsError = null;
  renderSessionsNotice();
  state.showAll = false;
  state.showOthers = false;
  state.filter = '';
  sessionSearchVersion++;
  sessionSearchState = { agent: id, query: '', results: [], loading: false, error: null };
  renderSessionSearch();
  state.streamBubble = null; state.streamText = ''; clearLiveTools();
  state.sessionError = null;
  // Limpiar barra de estado
  const rst = $('run-status');
  rst.classList.add('hidden');
  rst.classList.remove('error', 'done');
  renderAgents();
  renderModels();
  const a = curAgent();
  setGw(!!a?.connected);
  // Limpiar sesiones viejas y mostrar carga inmediatamente
  const list = $('session-list');
  list.innerHTML = '<div class="sidebar-loading">⏳ Cargando…</div>';
  state.sessions = [];
  renderEmpty();
  renderPrompts();
  let listRead = loadSessions();
  for (;;) {
    await listRead;
    if (navigationVersion !== chatNavigationVersion || state.agent !== id) return;
    if (listRead === sessionListOperation) break;
    // A live refresh may invalidate the first list before it fills the view.
    // Restore only after the newest read, without erasing the remembered chat.
    listRead = sessionListOperation;
  }
  // La sesión recordada puede no estar en la lista (borrada, o filtrada): se cae
  // a la primera si existe, y si no, se queda vacío como antes.
  let targetKey = null;
  if (restoreKey && state.sessions.some(s => s.key === restoreKey)) targetKey = restoreKey;
  else if (lastByAgent[id] && state.sessions.some(s => s.key === lastByAgent[id])) targetKey = lastByAgent[id];
  else if (state.sessions.length) targetKey = state.sessions[0].key;
  if (targetKey) await selectSession(targetKey);
  else savePos();
}

function showLogin() {
  window.HubQueue?.reset();
  $('login-view').classList.remove('hidden');
  $('app').classList.add('hidden');
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('login-error').textContent = '';
  const r = await hubFetch('/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ u: $('login-user').value.trim(), p: $('login-pass').value }),
  }).then(r => r.json()).catch(() => ({ error: 'Error de red' }));
  if (r.error) { $('login-error').textContent = r.error; return; }
  boot();
});

$('btn-logout').addEventListener('click', async () => {
  try {
    const sub = await swReg?.pushManager.getSubscription();
    if (sub) await hubFetch('/api/push-sub', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: sub.endpoint }) });
  } catch {}
  await hubFetch('/api/logout', { method: 'POST' });
  location.reload();
});

// ---------------------------------------------------------------------------
// Mobile drawer
// ---------------------------------------------------------------------------
const isMobile = () => window.matchMedia('(max-width: 820px)').matches;
function openNav() {
  if (document.body.classList.contains('nav-open')) return;
  document.body.classList.add('nav-open');
  $('scrim').classList.remove('hidden');
  $('btn-menu').setAttribute('aria-expanded', 'true');
  if (isMobile()) {
    history.pushState({ ...history.state, hubNav: true }, '');
    $('btn-nav-back').focus({ preventScroll: true });
  }
}
function hideNav() {
  document.body.classList.remove('nav-open');
  $('scrim').classList.add('hidden');
  $('btn-menu').setAttribute('aria-expanded', 'false');
  if (isMobile()) $('btn-menu').focus({ preventScroll: true });
}
function closeNav() {
  const wasOpen = document.body.classList.contains('nav-open');
  hideNav();
  if (wasOpen && history.state?.hubNav) history.back();
}
$('btn-nav-back').addEventListener('click', closeNav);
window.addEventListener('popstate', () => {
  if (history.state?.hubNav && isMobile()) {
    document.body.classList.add('nav-open');
    $('scrim').classList.remove('hidden');
    $('btn-menu').setAttribute('aria-expanded', 'true');
  } else hideNav();
});
$('btn-menu').addEventListener('click', () => {
  document.body.classList.contains('nav-open') ? closeNav() : openNav();
});
$('scrim').addEventListener('click', closeNav);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeNav(); });
window.addEventListener('resize', () => { if (!isMobile()) closeNav(); });

// Swipe: abrir desde el borde izquierdo, cerrar arrastrando el cajón
let touchX = null, touchY = null;
document.addEventListener('touchstart', (e) => {
  const t = e.touches[0]; touchX = t.clientX; touchY = t.clientY;
}, { passive: true });
document.addEventListener('touchend', (e) => {
  if (touchX === null || !isMobile()) return;
  const t = e.changedTouches[0];
  const dx = t.clientX - touchX, dy = Math.abs(t.clientY - touchY);
  if (dy < 60) {
    if (dx > 70 && touchX < 32 && !document.body.classList.contains('nav-open')) openNav();
    else if (dx < -70 && document.body.classList.contains('nav-open')) closeNav();
  }
  touchX = null;
}, { passive: true });

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------
let wsRetry = null;
let socketWasOpen = false;
// Suscripción a la sesión abierta (session.tool/observer y el evento terminal).
// Si el socket no está OPEN todavía, se guarda y se envía al abrir (onopen).
let pendingWatch = null;
function sendWatch(agentId, sessionKey) {
  const msg = JSON.stringify({ type: 'watch', agentId, sessionKey });
  pendingWatch = msg;
  const ws = state.ws;
  if (ws && ws.readyState === WebSocket.OPEN) {
    try { ws.send(msg); pendingWatch = null; } catch {}
  }
  // Si no: queda pendiente y flushPendingWatch() lo manda al abrir.
}
function flushPendingWatch() {
  const ws = state.ws;
  if (!pendingWatch || !ws || ws.readyState !== WebSocket.OPEN) return;
  try { ws.send(pendingWatch); pendingWatch = null; } catch {}
}

function connectWs() {
  if (wsRetry) { clearTimeout(wsRetry); wsRetry = null; }
  if (state.ws && (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING)) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  state.ws = ws;
  // Al reconectar no podemos afirmar qué sigue en cola: la verdad la reconstruye
  // el gateway. Mejor limpiar que dejar un contador mintiendo.
  ws.onopen = () => {
    window.HubQueue?.connection(true);
    // El 'watch' de la sesión abierta pudo perderse si selectSession corrió con
    // el socket aún CONNECTING (WebSocket.send lanza y el try del caller lo traga).
    // Sin suscripción el gateway NO emite el 'final' de esa sesión -> barra pegada.
    flushPendingWatch();
    if (state.agent && state.current) sendWatch(state.agent, state.current);
    setGw(!!curAgent()?.connected);
    if (socketWasOpen && state.agent) {
      const agent = state.agent, key = state.current;
      refreshKnownAsyncQuestions();
      loadAgents();
      loadSessions().then(() => {
        if (state.agent !== agent || state.current !== key || !key) return;
        if (state.historyLoading) selectSession(key);
        else reloadFinalMessages(key);
      });
    }
    socketWasOpen = true;
  };
  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type === 'hello' && m.user && m.user !== state.user) { location.reload(); return; }
    window.HubQueue?.consumeEvent(m);
    if (window.HubActivity?.consumeEvent(m)) return;
    // Sello de actividad REAL por sesion (delta/tool/phase/observer/usage), NO
    // cualquier mensaje: `sessions`/`agent`/`question`/`approval` llevan
    // agentId+sessionKey pero NO son señal de que el turno siga vivo — sellarlos
    // hacia que reconcileRuns() creyera para siempre "acaba de llegar algo" y
    // la barra nunca se apagaba aunque el gateway dijera hasActiveRun=false.
    if (m.agentId && m.sessionKey &&
        (m.type === 'delta' || m.type === 'tool' || m.type === 'phase' ||
         m.type === 'observer' || m.type === 'usage')) {
      state.lastEventByKey[rk(m.agentId, m.sessionKey)] = Date.now();
    }
    if (m.type === 'hello') {
      for (const agent of m.agents || []) {
        const current = state.agents.find(item => item.id === agent.id);
        if (current) current.connected = agent.connected;
      }
      setGw(!!curAgent()?.connected);
    }
    else if (m.type === 'gw') {
      if (!m.agentId || m.agentId === state.agent) setGw(m.connected);
      if (!m.connected) addError('Sin conexión con el Gateway', 'conn');
    }
    else if (m.type === 'sessions') {
      invalidateAsyncSessionQuestions(m);
      if (!m.agentId || m.agentId === state.agent) loadSessions();
    }
    else if (m.type === 'models' || m.type === 'agent') loadAgents();
    else if (m.type === 'delta') onDelta(m);
    else if (m.type === 'tool') onToolEvent(m);
    else if (m.type === 'phase') onPhaseEvent(m);
    else if (m.type === 'observer') onObserverEvent(m);
    else if (m.type === 'question') onQuestion(m);
    else if (m.type === 'async_question') onAsyncQuestion(m);
    else if (m.type === 'question_snapshot') onQuestionSnapshot(m);
    else if (m.type === 'approval') onApproval(m);
    else if (m.type === 'final' || m.type === 'aborted' || m.type === 'error') onTerminal(m);
    else if (m.type === 'send_error') {
      if (handleSendResult(m, false)) return;
      const agentName = (state.agents.find(a => a.id === m.agentId)?.name) || m.agentId;
      state.sessionError = { msg: `${agentName}: ${m.error || 'Error al enviar'}`, key: m.sessionKey, agentId: m.agentId, time: Date.now() };
      setRunning(m.agentId, m.sessionKey, false);
      addError(`${agentName}: ${m.error || 'Error al enviar'}`, 'error', m.diagnostic, m);
      if (m.agentId === state.agent && m.sessionKey === state.current) addMsg('system', '⚠️ ' + (m.error || 'Error al enviar'));
    }
    else if (m.type === 'send_accepted') {
      handleSendResult(m, true);
      // Admission is not execution; recover the actual native pending inputs.
      markQueued(m.agentId, m.sessionKey, m.runId);
    }
    else if (m.type === 'abort_result') {
      handleStopResult(m);
    }
  };
  ws.onclose = event => {
    window.HubQueue?.connection(false);
    setGw(false);
    window.HubActivity?.connection(false);
    for (const job of [...pendingSends.values()]) recoverSend(job, 'Se perdió la conexión antes de confirmar. El borrador sigue guardado.', true);
    if (event.code === 4401) { state.user = null; showLogin(); return; }
    wsRetry = setTimeout(connectWs, 2000);
  };
}

function setGw(on) {
  const connected = !!on && state.ws?.readyState === WebSocket.OPEN;
  $('gw-status').classList.toggle('on', connected);
  $('gw-status').setAttribute('aria-label', connected ? 'Conectado con el agente' : 'Sin conexión con el agente');
  $('gw-status').title = connected ? 'Conectado con el agente' : 'Sin conexión: el borrador se conserva';
  updateComposerState();
}

// ---------------------------------------------------------------------------
// Reanudar al volver a la app (movil): el SO puede matar el WS sin disparar
// onclose (socket medio-abierto) y la pagina quedaba stale -> F5 manual.
// Al hacerse visible: reconectar si el socket no esta OPEN (o estuvo oculta
// >60s) y resincronizar sesiones+historial si reconectamos o >30s fuera.
// ---------------------------------------------------------------------------
let hiddenAt = null;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { hiddenAt = Date.now(); return; }
  const awayMs = hiddenAt ? Date.now() - hiddenAt : 0;
  hiddenAt = null;
  resumeFromBackground(awayMs);
});
window.addEventListener('online', () => resumeFromBackground(0));
window.addEventListener('pageshow', (e) => { if (e.persisted) resumeFromBackground(1e9); });

function resumeFromBackground(awayMs) {
  const ws = state.ws;
  const dead = !ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING;
  // En movil el socket se queda MEDIO ABIERTO al suspender la app: el navegador
  // lo cree OPEN pero el 'final' del turno ya no llega nunca. Con 5 s fuera
  // basta para haber perdido el cierre -> reconectar es barato, no hacerlo deja
  // la barra "trabajando" para siempre. (Antes: solo >60 s.)
  const mustReconnect = dead || awayMs > 5000;
  if (mustReconnect) {
    for (const job of [...pendingSends.values()]) recoverSend(job, 'Se interrumpió la confirmación del envío. El borrador sigue guardado.', true);
    try { if (ws) { ws.onclose = null; ws.onmessage = null; ws.close(); } } catch {}
    state.ws = null;
    // Al reconectar WS, los eventos de run que ocurrieron mientras no estabas
    // ya no llegarán. Resetear toda la maquinaria para que no quede stale.
    state.runningByKey = {};
    state.running = false;
    state.sessionError = null;
    RUN.startedAt = 0;
    endRun();  // oculta la barra de estado si estaba visible
    connectWs();
  }
  // Al volver, siempre traer la verdad del gateway (hasActiveRun) y reconciliar.
  if (state.agent) {
    loadSessions();
    if (state.current) selectSession(state.current);
  }
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------
function installSessionBrowseUI() {
  const filter = $('s-filter');
  if (filter && !$('session-search-modes')) {
    const modes = document.createElement('div'); modes.id = 'session-search-modes'; modes.className = 'session-search-modes';
    modes.setAttribute('role', 'group'); modes.setAttribute('aria-label', 'Dónde buscar');
    for (const [mode, label] of [['titles', 'Títulos'], ['messages', 'Mensajes']]) {
      const button = document.createElement('button'); button.type = 'button'; button.dataset.mode = mode; button.textContent = label;
      button.addEventListener('click', () => { sessionSearchMode = mode; renderSessions(); if (mode === 'messages') searchSessionMessages(); filter.focus(); });
      modes.appendChild(button);
    }
    const results = document.createElement('div'); results.id = 'session-search-results'; results.className = 'session-search-results hidden'; results.setAttribute('aria-label', 'Resultados en mensajes');
    filter.after(modes, results);
    filter.setAttribute('aria-controls', 'session-search-results session-list');
  }
  const titles = document.querySelector('.head-titles');
  if (titles && !$('btn-rename-session')) {
    const row = document.createElement('div'); row.className = 'chat-title-row';
    const title = $('chat-title'); title.before(row); row.appendChild(title);
    const button = document.createElement('button'); button.id = 'btn-rename-session'; button.type = 'button'; button.className = 'rename-session hidden'; button.textContent = '✎';
    button.title = 'Cambiar nombre de la conversación'; button.setAttribute('aria-label', button.title); button.addEventListener('click', openRename);
    row.appendChild(button);
    const editor = document.createElement('form'); editor.id = 'session-rename-form'; editor.className = 'session-rename-form hidden';
    const input = document.createElement('input'); input.id = 'session-rename-input'; input.type = 'text'; input.maxLength = 100; input.autocomplete = 'off'; input.setAttribute('aria-label', 'Nombre de la conversación'); input.setAttribute('aria-describedby', 'session-rename-status');
    const save = document.createElement('button'); save.type = 'submit'; save.textContent = 'Guardar';
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Cancelar'; cancel.addEventListener('click', () => { renameEditing = null; renderRename(); button.focus(); });
    const status = document.createElement('div'); status.id = 'session-rename-status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    editor.append(input, save, cancel, status); titles.appendChild(editor);
    input.addEventListener('input', () => { if (renameEditing) renameDrafts.set(renameEditing, { ...renameDrafts.get(renameEditing), label: input.value, error: null }); });
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter' && (event.isComposing || event.keyCode === 229)) event.preventDefault();
      if (event.key === 'Escape' && !event.isComposing) { event.preventDefault(); cancel.click(); }
    });
    editor.addEventListener('submit', event => { event.preventDefault(); if (!event.isComposing) saveRename(); });
  }
  const controls = $('model-controls');
  if (controls && !$('model-summary')) {
    const summary = document.createElement('button'); summary.type = 'button'; summary.id = 'model-summary'; summary.className = 'model-summary'; summary.setAttribute('aria-controls', 'model-controls'); summary.setAttribute('aria-expanded', 'false');
    summary.addEventListener('click', () => { const open = !controls.classList.contains('expanded'); controls.classList.toggle('expanded', open); summary.setAttribute('aria-expanded', String(open)); });
    controls.before(summary);
  }
  const foot = document.querySelector('.sidebar-foot');
  if (foot && !$('btn-push-settings')) {
    const push = document.createElement('button'); push.type = 'button'; push.id = 'btn-push-settings'; push.title = 'Notificaciones de este dispositivo'; push.setAttribute('aria-label', push.title); push.textContent = '🔔'; push.classList.toggle('hidden', !pushSupported());
    push.addEventListener('click', () => {
      try { localStorage.removeItem('hub.push.dismissed'); } catch {}
      pushPromptShown = false; renderPushPrompt(true);
    });
    foot.insertBefore(push, $('btn-logout'));
  }
  renderSessionSearch(); renderRename(); renderModelSummary();
}

function renderModelSummary() {
  const summary = $('model-summary'), controls = $('model-controls');
  if (!summary || !controls) return;
  summary.classList.toggle('hidden', !state.current || controls.classList.contains('hidden'));
  const selected = id => $(id)?.selectedOptions?.[0]?.textContent || '';
  const provider = selected('provider-select'), model = selected('model-select'), effort = selected('effort-select');
  const text = [provider, model, effort].filter(Boolean).join(' · ');
  const primary = document.createElement('span'); primary.className = 'model-summary-primary'; primary.textContent = (controls.classList.contains('expanded') ? '▴ ' : '▾ ') + ([provider, model].filter(Boolean).join(' · ') || 'Modelo y esfuerzo');
  const detail = document.createElement('span'); detail.className = 'model-summary-detail';
  const settingsStatus = $('model-settings-status');
  detail.textContent = settingsStatus && !settingsStatus.classList.contains('hidden') ? settingsStatus.textContent : 'Esfuerzo: ' + (effort || 'Auto');
  summary.replaceChildren(primary, detail);
  summary.title = text; summary.setAttribute('aria-label', 'Ajustes de esta sesión: ' + text);
  summary.classList.toggle('error', $('model-settings-status')?.classList.contains('error'));
  summary.setAttribute('aria-expanded', String(controls.classList.contains('expanded')));
}

function renderSessionSearch() {
  const input = $('s-filter'), modes = $('session-search-modes'), box = $('session-search-results');
  if (!input || !box || !modes) return;
  if (!supports('messageSearch')) sessionSearchMode = 'titles';
  modes.classList.toggle('hidden', !supports('messageSearch'));
  const full = sessionSearchMode === 'messages';
  input.placeholder = full ? 'Buscar en todos los mensajes…' : 'Buscar título de sesión…';
  input.setAttribute('aria-label', full ? 'Buscar contenido en todas las conversaciones de este agente' : 'Filtrar títulos de las sesiones cargadas');
  input.classList.remove('hidden');
  for (const button of modes.children) button.setAttribute('aria-pressed', String(button.dataset.mode === sessionSearchMode));
  $('session-list').classList.toggle('hidden', full);
  box.classList.toggle('hidden', !full);
  if (!full) return;
  const search = sessionSearchState;
  const signature = JSON.stringify([state.agent, state.filter, search]);
  if (box.dataset.signature === signature) return;
  box.dataset.signature = signature; box.replaceChildren();
  const note = document.createElement('div'); note.className = 'session-search-note'; note.setAttribute('role', 'status');
  note.textContent = !state.filter.trim() ? 'Busca dentro de todas las conversaciones visibles de este agente.'
    : search.loading ? 'Buscando en las conversaciones…' : search.error ? search.error
    : search.agent !== state.agent || search.query !== state.filter.trim() ? 'Buscando…'
    : !search.results.length ? (search.indexing ? 'Preparando el índice; puedes volver a buscar en unos segundos.' : 'No hay mensajes que coincidan.')
    : search.results.length + (search.truncated ? ' resultados · se muestran los primeros' : ' resultados');
  box.appendChild(note);
  if (search.error || search.indexing || search.truncated) {
    const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'session-search-retry'; retry.textContent = search.error ? 'Reintentar búsqueda' : 'Actualizar búsqueda'; retry.addEventListener('click', searchSessionMessages); box.appendChild(retry);
  }
  if (search.agent !== state.agent || search.query !== state.filter.trim()) return;
  for (const hit of search.results) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'session-search-hit';
    const title = document.createElement('strong'); title.textContent = hit.label || state.sessions.find(row => row.key === hit.sessionKey)?.label || 'Conversación';
    const snippet = document.createElement('span'); snippet.className = 'search-snippet'; snippet.textContent = hit.snippet;
    const meta = document.createElement('span'); meta.className = 'search-meta'; meta.textContent = (hit.role === 'user' ? 'Tú' : AGENT_NAME(state.agent)) + (hit.timestamp ? ' · ' + new Date(hit.timestamp).toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' }) : '');
    button.append(title, snippet, meta);
    button.addEventListener('click', () => selectSession(hit.sessionKey, { label: title.textContent, anchor: { messageId: hit.messageId, sessionId: hit.sessionId } }));
    box.appendChild(button);
  }
  if (search.archivedTranscriptsExcluded) {
    const excluded = document.createElement('div'); excluded.className = 'session-search-note'; excluded.textContent = search.archivedTranscriptsExcluded + ' transcripciones archivadas no están disponibles para esta búsqueda.'; box.appendChild(excluded);
  }
}

async function searchSessionMessages() {
  if (!supports('messageSearch') || sessionSearchMode !== 'messages' || !state.agent) return;
  const agent = state.agent, query = state.filter.trim(), version = ++sessionSearchVersion;
  sessionSearchState = { agent, query, results: [], loading: !!query, error: null }; renderSessionSearch();
  if (!query) return;
  try {
    const response = await hubFetch('/api/session-search?' + new URLSearchParams({ agent, q: query }), { cache: 'no-store' });
    const result = await response.json();
    if (!response.ok || result.error || !Array.isArray(result.results)) throw new Error(result.error || 'No se pudo buscar en el historial');
    if (version !== sessionSearchVersion || state.agent !== agent || state.filter.trim() !== query) return;
    sessionSearchState = { ...result, agent, query, loading: false, error: null };
  } catch (error) {
    if (version !== sessionSearchVersion || state.agent !== agent || state.filter.trim() !== query) return;
    sessionSearchState = { agent, query, results: [], loading: false, error: error.message || 'Búsqueda no disponible' };
  }
  renderSessionSearch();
}

function openRename() {
  if (!state.current) return;
  const scope = rk(state.agent, state.current);
  if (!renameDrafts.has(scope)) renameDrafts.set(scope, { label: state.sessions.find(row => row.key === state.current)?.label || $('chat-title').textContent, error: null, saving: false });
  renameEditing = scope; renderRename(); $('session-rename-input')?.focus(); $('session-rename-input')?.select();
}

function renderRename() {
  const button = $('btn-rename-session'), form = $('session-rename-form');
  if (!button || !form) return;
  button.classList.toggle('hidden', !state.current);
  const scope = rk(state.agent, state.current), editing = renameEditing === scope;
  form.classList.toggle('hidden', !editing); button.setAttribute('aria-expanded', String(editing));
  if (!editing) return;
  const draft = renameDrafts.get(scope);
  if ($('session-rename-input').value !== draft.label) $('session-rename-input').value = draft.label;
  for (const control of form.querySelectorAll('input,button')) control.disabled = !!draft.saving;
  const status = $('session-rename-status'); status.textContent = draft.saving ? 'Guardando nombre…' : draft.error || '';
  status.classList.toggle('error', !!draft.error); form.setAttribute('aria-busy', String(!!draft.saving));
}

async function saveRename() {
  const agent = state.agent, key = state.current, scope = rk(agent, key), draft = renameDrafts.get(scope);
  if (!key || renameEditing !== scope || !draft || draft.saving) return;
  const label = $('session-rename-input').value.trim();
  if (!label || label.length > 100) { draft.error = 'Escribe un nombre de entre 1 y 100 caracteres'; renderRename(); return; }
  draft.label = label; draft.saving = true; draft.error = null; renderRename();
  try {
    const response = await hubFetch('/api/session-rename', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent, key, label }) });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error || 'No se pudo cambiar el nombre');
    renameDrafts.delete(scope);
    if (agent !== state.agent) return;
    const row = state.sessions.find(session => session.key === key); if (row) row.label = result.label || label;
    if (state.current === key) { $('chat-title').textContent = result.label || label; $('chat-title').title = result.label || label; renameEditing = null; renderRename(); $('btn-rename-session').focus(); }
    renderSessions();
  } catch (error) { draft.saving = false; draft.error = error.message || 'No se pudo cambiar el nombre'; if (state.agent === agent && state.current === key) renderRename(); }
}

function loadSessions() {
  const operation = readSessionList();
  sessionListOperation = operation;
  return operation;
}

async function readSessionList() {
  if (!state.agent) return;
  const listVersion = ++sessionListVersion;
  const agentId = state.agent;
  const settingsEpoch = modelSettingsEpoch;
  const settingsReadVersion = ++modelSettingsReadSequence;
  const url = `/api/sessions?agent=${encodeURIComponent(state.agent)}`
    + (state.showAll ? '&all=1' : '') + (state.showOthers ? '&kind=others' : '');
  const r = await hubFetch(url).then(r => r.json()).catch(() => null);
  if (agentId !== state.agent || listVersion !== sessionListVersion) return;
  if (!r || r.error || !Array.isArray(r.sessions)) {
    state.sessionsError = r?.error || 'No se pudo conectar con el servidor';
    renderSessionsNotice();
    renderSessions();
    return;
  }
  state.sessionsError = null;
  renderSessionsNotice();
  state.sessions = r.sessions;
  if (settingsEpoch === modelSettingsEpoch && !modelSettingsPending) {
    for (const session of state.sessions) {
      const scope = rk(agentId, session.key);
      if ((modelSettingsReadVersions.get(scope) || 0) > settingsReadVersion) continue;
      modelSettings.set(scope, session);
      modelSettingsReadVersions.set(scope, settingsReadVersion);
    }
  }
  state.hiddenCount = r.hiddenCount || 0;
  state.othersCount = r.othersCount || 0;
  state.ownCount = r.ownCount || 0;
  // Si la sesión actual está fallada, actualizar la barra de estado
  if (state.current) {
    const cur = state.sessions.find(s => s.key === state.current);
    if (cur && isFailed(cur) && !isRunning(cur)) {
      state.sessionError = { msg: '❌ El último turno falló', key: state.current, agentId: state.agent, time: Date.now() };
      const el = $('run-status');
      el.classList.remove('hidden', 'done');
      el.classList.add('error');
      el.querySelector('.rs-dots').style.display = 'none';
      el.querySelector('.rs-text').textContent = `⚠️ ${state.sessionError.msg}`;
    }
  }
  renderSessions();
  updateCtx();
  renderModels();
  reconcileRuns();   // el gateway ya dijo quién tiene turno activo: ajustar la barra
}

function renderSessionsNotice() {
  const notice = $('sessions-notice');
  if (!notice) return;
  notice.replaceChildren();
  notice.classList.toggle('hidden', !state.sessionsError);
  if (!state.sessionsError) return;
  const text = document.createElement('span');
  text.textContent = state.sessions.length ? 'No se pudo actualizar. Se conserva la última lista.' : 'No se pudieron cargar las sesiones.';
  text.title = state.sessionsError;
  const retry = document.createElement('button');
  retry.textContent = 'Reintentar';
  retry.addEventListener('click', () => loadSessions());
  notice.append(text, retry);
}

// ---------------------------------------------------------------------------
// Session model preferences: API -> model, with gateway-owned effort profiles.
// ---------------------------------------------------------------------------
function modelReference(model) {
  return model.ref || (model.provider ? model.provider + '/' + model.id : model.id);
}

function syncModelSelect(select, choices, value, disabled, title) {
  const signature = JSON.stringify(choices);
  // Avoid replacing an open native picker on unrelated session refreshes.
  if (select.dataset.choices !== signature) {
    select.replaceChildren(...choices.map(choice => {
      const option = document.createElement('option');
      option.value = choice.value;
      option.textContent = choice.label;
      option.disabled = !!choice.disabled;
      return option;
    }));
    select.dataset.choices = signature;
  }
  if (select.value !== value) select.value = value;
  if (select.disabled !== disabled) select.disabled = disabled;
  select.title = title;
}

function effortLabel(level) {
  if (!level) return '';
  const labels = { off: 'Sin razonamiento', minimal: 'Mínimo', low: 'Bajo', medium: 'Medio', high: 'Alto', xhigh: 'Muy alto', adaptive: 'Adaptativo', max: 'Máximo', ultra: 'Ultra' };
  return level.label && level.label !== level.id ? level.label : (labels[level.id] || level.label || level.id);
}

function renderModels() {
  const controls = $('model-controls');
  const a = curAgent();
  controls.classList.toggle('hidden', !supports('modelSettings') || !a || !state.current);
  if (!supports('modelSettings')) { renderModelSummary(); return; }
  if (!a || !state.current) return;
  const scope = rk(state.agent, state.current);
  const s = modelSettings.get(scope) || state.sessions.find(session => session.key === state.current);
  const models = a.models || [];
  const activeRef = s?.modelRef || '';
  const activeModel = models.find(model => modelReference(model) === activeRef);
  const activeProvider = s?.modelProvider || activeModel?.provider || '';
  const draft = modelProviderDraft?.scope === scope ? modelProviderDraft.provider : null;
  const provider = draft ?? activeProvider;
  const preview = provider !== activeProvider;
  // Settings describe the model, not current execution. That cached snapshot
  // may still say active after the terminal/queue events have settled the run.
  const busy = !!modelSettingsPending || state.running || stopPending.has(scope);
  const unavailable = !a.connected || !s;
  const locked = !!a.lockedModel || !!s?.modelSelectionLocked;
  const lockedNote = a.modelNote || (s?.modelSelectionLocked ? 'Modelo fijado para esta sesión' : 'Modelo fijado para este agente');
  const providers = [...new Set([...models.map(model => model.provider).filter(Boolean), ...(activeProvider ? [activeProvider] : [])])].sort((left, right) => left.localeCompare(right, 'es'));
  const providerOptions = providers.map(value => ({ value, label: value }));
  if (!provider) providerOptions.unshift({ value: '', label: 'Cargando…' });
  syncModelSelect($('provider-select'), providerOptions, provider, busy || unavailable || locked || !models.length,
    locked ? lockedNote : 'API / proveedor del modelo');
  const modelOptions = models.filter(model => model.provider === provider)
    .sort((left, right) => (left.alias || left.name || left.id).localeCompare(right.alias || right.name || right.id, 'es', { numeric: true }))
    .map(model => ({ value: modelReference(model), label: (locked && modelReference(model) === activeRef ? '🔒 ' : '') + (model.alias ? model.alias + ' · ' : '') + (model.name || model.id)
      + (model.contextWindow ? ' · ' + fmtK(model.contextWindow) : '')
      + (!preview && modelReference(model) === activeRef && !s?.modelOverrideSource ? ' · Auto' : '') }));
  if (preview) modelOptions.unshift({ value: '', label: 'Elige un modelo…', disabled: true });
  else if (!modelOptions.some(option => option.value === activeRef)) {
    modelOptions.unshift({ value: activeRef, label: (locked ? '🔒 ' : '') + (s?.model || 'Cargando…'), disabled: true });
  }
  syncModelSelect($('model-select'), modelOptions, preview ? '' : activeRef, busy || unavailable || locked || !models.length,
    locked ? lockedNote : (s?.modelOverrideSource === 'user' ? 'Modelo fijado para esta sesión: ' : 'Modelo efectivo de esta sesión: ') + activeRef);
  const levels = Array.isArray(s?.thinkingLevels) ? s.thinkingLevels : activeModel?.thinkingLevels;
  const hasEffort = Array.isArray(levels) && levels.length > 0 && !(levels.length === 1 && levels[0].id === 'off');
  const defaultLevel = s?.thinkingDefault ?? activeModel?.thinkingDefault;
  const defaultLabel = effortLabel(levels?.find(level => level.id === defaultLevel) || (defaultLevel ? { id: defaultLevel } : null));
  const effortOptions = hasEffort && !preview
    ? [{ value: '', label: 'Auto' + (defaultLabel ? ' · ' + defaultLabel : ' · del agente') }, ...levels.map(level => ({ value: level.id, label: effortLabel(level) }))]
    : [{ value: '', label: preview ? 'Elige un modelo' : Array.isArray(levels) && levels.length ? 'Sin razonamiento' : 'No disponible' }];
  const effortValue = hasEffort && !preview ? (s?.thinkingLevel || '') : '';
  if (effortValue && !effortOptions.some(option => option.value === effortValue)) effortOptions.push({ value: effortValue, label: effortValue + ' · actual', disabled: true });
  syncModelSelect($('effort-select'), effortOptions, effortValue, busy || unavailable || preview || !hasEffort,
    'Esfuerzo para esta sesión. Auto hereda el valor del agente; no muestra ni oculta el razonamiento.');
  $('model-reset').disabled = busy || unavailable || locked || (!s?.modelOverrideSource && !draft);
  controls.setAttribute('aria-busy', String(!!modelSettingsPending));
  const notice = modelSettingsNotice?.scope === scope ? modelSettingsNotice : null;
  const status = $('model-settings-status');
  const text = modelSettingsPending ? 'Guardando cambios…' : notice?.error ? notice.error
    : preview ? 'Elige un modelo para cambiar de API.' : !a.connected ? 'Sin conexión con el agente.'
    : !s ? 'Cargando ajustes…' : state.running ? 'Podrás cambiar los ajustes al terminar el turno.' : '';
  status.textContent = text;
  status.classList.toggle('hidden', !text);
  status.classList.toggle('error', !!notice?.error && !modelSettingsPending);
  renderModelSummary();
  updateComposerState();
}

async function refreshModelSettings(agentId = state.agent, key = state.current) {
  if (!supports('modelSettings') || !agentId || !key) return;
  const scope = rk(agentId, key);
  const epoch = modelSettingsEpoch;
  if (modelSettingsReads.get(scope)?.epoch === epoch) return modelSettingsReads.get(scope).promise;
  const readVersion = ++modelSettingsReadSequence;
  const promise = (async () => {
    try {
      const response = await hubFetch('/api/session-settings?agent=' + encodeURIComponent(agentId) + '&key=' + encodeURIComponent(key));
      const result = await response.json();
      if (!response.ok || !result.settings) throw new Error(result.error || 'No se pudieron leer los ajustes');
      if (epoch !== modelSettingsEpoch) return;
      if ((modelSettingsReadVersions.get(scope) || 0) > readVersion) return;
      modelSettings.set(scope, result.settings);
      modelSettingsReadVersions.set(scope, readVersion);
    } catch (error) {
      if (epoch === modelSettingsEpoch) modelSettingsNotice = { scope, error: error.message };
    } finally {
      if (modelSettingsReads.get(scope)?.epoch === epoch) modelSettingsReads.delete(scope);
      if (rk(state.agent, state.current) === scope) renderModels();
    }
  })();
  modelSettingsReads.set(scope, { epoch, promise });
  return promise;
}

async function saveModelSettings(patch) {
  if (stopPending.has(rk(state.agent, state.current))) { renderModels(); return; }
  if (!supports('modelSettings') || !state.agent || !state.current || modelSettingsPending || state.running) { renderModels(); return; }
  const agentId = state.agent, key = state.current, scope = rk(agentId, key);
  modelSettingsEpoch++;
  modelSettingsPending = { scope };
  modelSettingsNotice = null;
  renderModels();
  try {
    const response = await hubFetch('/api/session-settings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: agentId, key, ...patch }),
    });
    const result = await response.json();
    if (!response.ok || !result.ok || !result.settings) throw new Error(result.error || 'No se pudo guardar el cambio');
    modelSettings.set(scope, result.settings);
    if (modelProviderDraft?.scope === scope) modelProviderDraft = null;
    if (rk(state.agent, state.current) === scope) toast('model' in patch ? 'Modelo actualizado para esta sesión' : 'Esfuerzo actualizado para esta sesión');
  } catch (error) {
    modelSettingsNotice = { scope, error: 'No se pudo confirmar el cambio: ' + error.message };
    if (modelProviderDraft?.scope === scope) modelProviderDraft = null;
    await refreshModelSettings(agentId, key);
  } finally {
    modelSettingsPending = null;
    modelSettingsEpoch++;
    renderModels();
    // Refresh only after settling the patch, and never transplant its data to another agent.
    if (state.agent === agentId) loadSessions();
  }
}

$('provider-select').addEventListener('change', event => {
  modelProviderDraft = { scope: rk(state.agent, state.current), provider: event.target.value };
  modelSettingsNotice = null;
  renderModels();
});
$('model-select').addEventListener('change', event => {
  if (event.target.value) saveModelSettings({ model: event.target.value });
});
$('effort-select').addEventListener('change', event => saveModelSettings({ thinkingLevel: event.target.value || null }));
$('model-reset').addEventListener('click', () => {
  modelProviderDraft = null;
  saveModelSettings({ model: null });
});

// Un título que se pueda leer de un vistazo: etiqueta, o la primera frase.
function sessionTitle(s) {
  const label = String(s.label || '').trim();
  if (label && label !== 'Sin título') return label;
  if (s.snippet) return s.snippet;
  return s.kind === 'session' ? 'Sesión sin título' : 'Sin título';
}

// Cabecera de día, con ancla temporal: sin fecha, tres "miércoles" no dicen nada.
function dayLabel(ts) {
  const d = new Date(ts);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const day = new Date(d); day.setHours(0, 0, 0, 0);
  const diff = Math.round((today - day) / 864e5);
  const short = d.toLocaleDateString('es-ES', { day: '2-digit', month: 'short' }).replace('.', '');
  if (diff === 0) return 'Hoy · ' + short;
  if (diff === 1) return 'Ayer · ' + short;
  if (diff < 7) return d.toLocaleDateString('es-ES', { weekday: 'long' }) + ' ' + short;
  return d.toLocaleDateString('es-ES', d.getFullYear() === today.getFullYear()
    ? { day: '2-digit', month: 'short' }
    : { day: '2-digit', month: 'short', year: 'numeric' }).replace('.', '');
}

let sessionListGesture = null;
let sessionListRenderPending = false;
$('session-list').addEventListener('pointerdown', event => {
  if (event.button === 0) sessionListGesture = event.pointerId;
}, true);
function releaseSessionListGesture(event) {
  if (sessionListGesture === null || (event.type !== 'blur' && event.pointerId !== sessionListGesture)) return;
  sessionListGesture = null;
  // The click belongs to the original down target. Keep it attached through
  // dispatch of click, including on touch; cancelled gestures never navigate.
  setTimeout(() => {
    if (!sessionListRenderPending) return;
    sessionListRenderPending = false;
    renderSessions();
  }, 0);
}
window.addEventListener('pointerup', releaseSessionListGesture, true);
window.addEventListener('pointercancel', releaseSessionListGesture, true);
window.addEventListener('blur', releaseSessionListGesture);

function renderSessions() {
  if (sessionListGesture !== null) { sessionListRenderPending = true; return; }
  const el = $('session-list');
  el.innerHTML = '';
  const q = state.filter.trim().toLowerCase();
  const match = (s) => !q || (sessionTitle(s) + ' ' + (s.snippet || '') + ' ' + (s.label || '')).toLowerCase().includes(q);
  const byKey = new Map(state.sessions.map(s => [s.key, s]));
  const visible = new Set(state.sessions.filter(match).map(s => s.key));
  if (q) {
    for (const key of [...visible]) {
      const visited = new Set([key]);
      let parentKey = byKey.get(key)?.parentKey;
      while (parentKey && byKey.has(parentKey) && !visited.has(parentKey)) {
        visited.add(parentKey);
        visible.add(parentKey);
        parentKey = byKey.get(parentKey).parentKey;
      }
    }
  }
  const rows = state.sessions.filter(s => visible.has(s.key));

  // Árbol: cada fila cuelga de su padre si el padre está en la vista
  const children = new Map();
  const roots = [];
  for (const s of rows) {
    if (s.parentKey && visible.has(s.parentKey)) {
      if (!children.has(s.parentKey)) children.set(s.parentKey, []);
      children.get(s.parentKey).push(s);
    } else roots.push(s);
  }
  // Un hijo con el padre plegado no se pinta
  const hidden = new Set();
  const walkHide = (key) => {
    for (const child of children.get(key) || []) {
      if (hidden.has(child.key)) continue;
      hidden.add(child.key);
      walkHide(child.key);
    }
  };
  if (!q) for (const key of children.keys()) if (isTreeCollapsed(key)) walkHide(key);

  if (children.size) {
    const toolbar = document.createElement('div');
    toolbar.className = 's-tree-tools';
    const summary = document.createElement('span');
    summary.textContent = roots.length + ' principal' + (roots.length === 1 ? '' : 'es') + ' · ' + (rows.length - roots.length) + ' derivadas';
    const toggleAll = document.createElement('button');
    toggleAll.className = 'archive-toggle';
    const allCollapsed = [...children.keys()].every(key => isTreeCollapsed(key));
    toggleAll.textContent = allCollapsed ? 'Desplegar todo' : 'Plegar todo';
    toggleAll.disabled = !!q;
    toggleAll.addEventListener('click', () => {
      for (const key of children.keys()) state.collapsed[key] = !allCollapsed;
      renderSessions();
    });
    toolbar.append(summary, toggleAll);
    el.appendChild(toolbar);
  }

  // Orden: primero las raíces (fijadas y luego por actividad); cada raíz arrastra
  // a sus descendientes justo detrás, ordenados igual.
  const byRecent = (a, b) => ((b.pinned ? 1 : 0) - (a.pinned ? 1 : 0)) || ((b.updatedAt || 0) - (a.updatedAt || 0));
  const ordered = [];
  const seen = new Set();
  const push = (s, depth, parent, isLast) => {
    if (seen.has(s.key)) return;
    seen.add(s.key);
    ordered.push({ s, depth, parent, isLast: !!isLast });
    const kids = (children.get(s.key) || []).slice().sort(byRecent);
    kids.forEach((k, i) => push(k, depth + 1, s, i === kids.length - 1));
  };
  const dayOf = (s) => s.groupAt || s.updatedAt || 0;
  for (const s of roots.slice().sort(byRecent)) push(s, 0, null);
  // Restos (padres plegados cuyo ancestro no está): no perder filas por el camino
  for (const s of rows) if (!seen.has(s.key)) push(s, 0, null);

  let lastDay = '';
  const flat = state.sortMode === 'recientes';
  for (const { s, depth, isLast } of ordered) {
    const isLastChildOf = isLast && depth > 0;
    if (hidden.has(s.key)) continue;
    // Orden por días: cabecera de día y todo plano (como siempre).
    // Orden por recientes: sin cabeceras, árbol conservado y toda la lista arriba
    // por actividad — la sesión en uso nunca se pierde abajo.
    const dl = !flat && dayOf(s) ? dayLabel(dayOf(s)) : '';
    if (dl && depth === 0 && dl !== lastDay) {
      lastDay = dl;
      const h = document.createElement('div');
      h.className = 's-day';
      h.textContent = dl;
      el.appendChild(h);
    }
    const d = document.createElement('div');
    const dep = Math.min(depth, 5);
    d.className = 'session-item depth-' + dep + (depth ? ' child' : '')
      + ((children.get(s.key) || []).length ? ' has-kids' : '')
      + (isLastChildOf ? ' last' : '')
      + (s.key === state.current ? ' active' : '');
    d.style.setProperty('--ind', Math.min(depth, 5) * 14 + 'px');
    d.dataset.key = s.key;
    d.tabIndex = 0;
    d.setAttribute('role', 'link');
    d.setAttribute('aria-label', 'Abrir ' + sessionTitle(s));
    if (s.key === state.current) d.setAttribute('aria-current', 'page');
    d.title = depth ? 'Nace de: ' + (s.parentLabel || 'otra sesión') : '';
    const dot = document.createElement('span');
    dot.className = 's-dot' + (s.unread ? ' on' : '');
    if (s.unread) dot.title = 'Sin leer';
    const main = document.createElement('div');
    main.className = 's-main';
    const label = document.createElement('span');
    label.className = 's-label' + (s.unread ? ' unread' : '');
    if (s.pinned) { const p = document.createElement('span'); p.className = 's-pin'; p.textContent = '📌 '; label.appendChild(p); }
    // Indicador de error (fallo del LLM, timeout, etc.)
    if (isFailed(s)) { const f = document.createElement('span'); f.className = 's-fail'; f.textContent = '❌ '; label.appendChild(f); }
    // Marcador: esta sesión tiene una pregunta esperando tu clic (antes se escondía
    // si no la tenías abierta y el agente parecía "trabajando").
    const nAsk = Object.values(state.questions).filter(x => x.agentId === state.agent && x.sessionKey === s.key).length;
    if (nAsk) {
      const qm = document.createElement('span');
      qm.className = 's-ask'; qm.textContent = '❓ ';
      qm.title = nAsk + ' pregunta' + (nAsk === 1 ? '' : 's') + ' esperando respuesta';
      label.appendChild(qm);
    }
    label.appendChild(document.createTextNode(
      (isRunning(s) && !nAsk ? '⏳ ' : '') + sessionTitle(s)));
    main.appendChild(label);
    const sub = String(s.snippet || '').trim();
    const subEl = document.createElement('span');
    const tipo = s.kindLabel || '';
    if (depth) {
      // Expandido ya se ve quién es hijo: el "de quién nace" solo sirve plegado.
      const madre = s.parentLabel || 'otra sesión';
      const origen = tipo === 'subagente' ? '↳ subtarea de: ' + madre
        : tipo ? '↳ ' + tipo + ' de: ' + madre
        : '↳ derivada de: ' + madre;
      if (!q && s.parentKey && isTreeCollapsed(s.parentKey)) {
        subEl.className = 's-sub s-tag';
        const cola = sub && sub !== sessionTitle(s) ? sub.slice(0, 46) : '';
        subEl.textContent = origen + (cola ? ' · ' + cola : '');
      } else {
        const isSnippet = !!sub && sub !== sessionTitle(s);
        subEl.className = 's-sub' + (isSnippet ? '' : ' s-tag');
        subEl.textContent = isSnippet ? sub : (tipo || '');
      }
    } else {
      const isSnippet = !!sub && sub !== sessionTitle(s);
      subEl.className = 's-sub' + (isSnippet ? '' : ' s-tag');
      subEl.textContent = isSnippet ? sub : tipo;
    }
    if (subEl.textContent) main.appendChild(subEl);
    const meta = document.createElement('span');
    meta.className = 's-meta';
    main.appendChild(meta);
    // Columna de árbol (slot fijo en todas las filas: la columna del título no baila)
    const tw = document.createElement('span');
    tw.className = 's-tw';
    const right = document.createElement('div');
    right.className = 's-right';
    // Plegar/desplegar el árbol de esta sesión
    if ((children.get(s.key) || []).length) {
      const t = document.createElement('button');
      t.className = 's-toggle';
      const n = (children.get(s.key) || []).length;
      // Un solo glifo que rota al abrir: se ve el estado de un vistazo
      const chev = document.createElement('span');
      chev.className = 'chev'; chev.textContent = '▶';
      const expanded = !!q || !isTreeCollapsed(s.key);
      t.appendChild(chev);
      t.classList.toggle('open', expanded);
      t.title = (expanded ? 'Ocultar' : 'Mostrar') + ' ' + n + ' sesión' + (n === 1 ? '' : 'es') + ' derivada' + (n === 1 ? '' : 's');
      t.setAttribute('aria-label', t.title + ' de ' + sessionTitle(s));
      t.setAttribute('aria-expanded', String(expanded));
      t.disabled = !!q;
      const branch = document.createElement('span');
      branch.className = 's-branch';
      branch.textContent = n + ' derivada' + (n === 1 ? '' : 's') + (expanded ? '' : ' · plegadas');
      meta.appendChild(branch);
      t.addEventListener('click', (e) => {
        e.stopPropagation();
        state.collapsed[s.key] = !isTreeCollapsed(s.key);
        renderSessions();
      });
      tw.appendChild(t);
    }
    const date = document.createElement('span');
    date.className = 's-date';
    date.textContent = fmtDate(s.updatedAt);
    right.appendChild(date);
    const mobileDate = date.cloneNode(true);
    mobileDate.classList.add('s-mobile-date');
    meta.appendChild(mobileDate);
    // Botón fijar/desfijar
    const pin = document.createElement('button');
    pin.className = 's-pin-btn';
    pin.textContent = '📌';
    pin.classList.toggle('on', !!s.pinned);
    pin.title = s.pinned ? 'Desfijar sesión' : 'Fijar sesión arriba';
    pin.addEventListener('click', async (e) => {
      e.stopPropagation();
      const newPinned = !s.pinned;
      try {
        const r = await hubFetch('/api/pin', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agent: state.agent, key: s.key, pinned: newPinned }),
        }).then(r => r.json());
        if (r.error) { toast(r.error); return; }
        s.pinned = newPinned;  // optimista: actualizar inmediato sin esperar loadSessions
        pin.classList.toggle('on', newPinned);
        renderSessions();  // refresca orden (pinned arriba)
        toast(newPinned ? '📌 Fijada' : '🔓 Desfijada');
      } catch (e) { toast('Error al fijar: ' + (e.message || e)); }
    });
    right.appendChild(pin);
    const del = document.createElement('button');
    del.className = 's-del'; del.textContent = '🗑'; del.title = 'Borrar sesión';
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!supports('sessionDeletion')) return;
      if (!confirm(`¿Borrar la sesión "${sessionTitle(s)}"?`)) return;
      const agent = state.agent;
      del.disabled = true;
      try {
        const response = await hubFetch(`/api/sessions?agent=${encodeURIComponent(agent)}&key=${encodeURIComponent(s.key)}`, { method: 'DELETE' });
        const result = await response.json();
        if (!response.ok || result.error) throw new Error(result.error || 'No se pudo borrar la sesión');
        clearDraft(agent, s.key);
        if (state.agent === agent) {
          if (state.current === s.key) { state.current = null; savePos(); renderEmpty(); }
          loadSessions();
        }
      } catch (error) { toast('No se pudo borrar: ' + error.message); }
      finally { del.disabled = false; }
    });
    if (supports('sessionDeletion')) right.appendChild(del);
    d.append(tw, dot, main, right);
    d.addEventListener('click', () => selectSession(s.key));
    d.addEventListener('keydown', event => {
      if (event.target !== d || (event.key !== 'Enter' && event.key !== ' ')) return;
      event.preventDefault(); selectSession(s.key);
    });
    el.appendChild(d);
  }

  // Buscador (siempre en el DOM, solo se muestra/oculta)
  const box = document.getElementById('s-filter');
  if (box) {
    box.value = state.filter;
    box.classList.remove('hidden');
  }
  renderSessionSearch();

  // Fila de controles
  const ctrl = document.createElement('div');
  ctrl.className = 's-ctrl';
  if (state.showOthers) {
    ctrl.innerHTML = '<span class="s-other">Cron, subagentes y otras apps</span>';
  } else if (state.showAll || state.hiddenCount > 0) {
    const t = document.createElement('button');
    t.className = 'archive-toggle';
    t.textContent = state.showAll ? '‹ Ver solo las de hoy' : `🗄 Anteriores (${state.hiddenCount})`;
    t.addEventListener('click', () => { state.showAll = !state.showAll; loadSessions(); });
    ctrl.appendChild(t);
  }
  if (state.othersCount) {
    const o = document.createElement('button');
    o.className = 'archive-toggle';
    o.textContent = state.showOthers ? '‹ Volver a las sesiones' : `⚙ Otras (${state.othersCount})`;
    o.title = 'Sesiones de cron, subagentes, canales y otras apps';
    o.addEventListener('click', () => { state.showOthers = !state.showOthers; loadSessions(); });
    ctrl.appendChild(o);
  }
  // Orden: por días (agrupado, como siempre) o por recientes (todo arriba, sin grupos)
  if (!state.showOthers && state.sessions.length) {
    const ord = document.createElement('button');
    ord.className = 'archive-toggle';
    const flat = state.sortMode === 'recientes';
    ord.textContent = flat ? '↑ Recientes' : '🗓 Por días';
    ord.title = flat ? 'Todo ordenado por actividad más reciente' : 'Agrupado por días (como ahora)';
    ord.addEventListener('click', () => {
      state.sortMode = flat ? 'dia' : 'recientes';
      try { localStorage.setItem('hub.sort', state.sortMode); } catch {}
      renderSessions();
    });
    ctrl.appendChild(ord);
  }
  if (ctrl.children.length) el.appendChild(ctrl);

  if (!rows.length) {
    const hint = document.createElement('div');
    hint.className = 'sidebar-empty';
    hint.textContent = state.sessionsError ? 'Las sesiones aparecerán cuando se recupere la conexión.' : state.filter ? 'Ninguna sesión coincide.'
      : state.showOthers ? 'Sin sesiones de fondo.' : 'Sin sesiones hoy. Pulsa ＋ para empezar.';
    el.appendChild(hint);
  }
}

$('btn-new').addEventListener('click', createSession);

async function createSession() {
  if (!state.agent || newSessionPending) return;
  const agent = state.agent, navigation = chatNavigationVersion;
  saveDraft();
  const operation = { agent, id: newSessionRetries.get(agent) || newClientId() };
  newSessionRetries.set(agent, operation.id);
  newSessionPending = operation;
  const button = $('btn-new'); button.disabled = true; button.setAttribute('aria-busy', 'true');
  try {
    const response = await hubFetch('/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent, idempotencyKey: operation.id }) });
    const result = await response.json();
    if (!response.ok || result.error || !result.key) throw new Error(result.error || 'No se pudo crear la sesión');
    newSessionRetries.delete(agent);
    if (agent !== state.agent || navigation !== chatNavigationVersion) { toast('Nueva sesión creada en ' + AGENT_NAME(agent)); return; }
    state.showAll = false; state.showOthers = false; state.filter = '';
    await loadSessions();
    if (agent === state.agent && navigation === chatNavigationVersion) await selectSession(result.key, { label: result.label || 'Nueva sesión' });
  } catch (error) { if (state.agent === agent) showNewSessionFailure(error.message, agent); else toast('No se pudo crear en ' + AGENT_NAME(agent) + ': ' + error.message); }
  finally {
    if (newSessionPending === operation) newSessionPending = null;
    button.disabled = false; button.removeAttribute('aria-busy');
  }
}

function showNewSessionFailure(message, agent) {
  const notice = $('sessions-notice'); notice.classList.remove('hidden'); notice.replaceChildren();
  const text = document.createElement('span'); text.textContent = message || 'No se pudo crear la sesión';
  const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = 'Reintentar';
  retry.addEventListener('click', () => { if (state.agent === agent) createSession(); });
  notice.append(text, retry);
}

async function selectSession(key, options = {}) {
  const agentId = state.agent;
  if (state.current && state.current !== key) saveDraft();
  const navigationVersion = ++chatNavigationVersion;
  const historyVersion = ++historyReadSequence;
  historyReadVersions.set(rk(agentId, key), historyVersion);
  const questionEpoch = asyncQuestionEpochs.get(rk(agentId, key));
  state.current = key;
  window.HubActivity?.select(agentId, key);
  state.historyLoading = true;
  renameEditing = null;
  deferredFinalHistory = null;
  const page = { agentId, key, messages: [], loading: false, nextOffset: null, totalMessages: null, hasMore: false, focused: !!options.anchor, anchor: options.anchor || null };
  historyPages.set(rk(agentId, key), page);
  while (historyPages.size > 12) historyPages.delete(historyPages.keys().next().value);
  renderRename();
  modelProviderDraft = null;
  renderModels();
  refreshModelSettings(agentId, key);
  state.sessionError = null;   // error de otra sesión no aplica
  state.streamBubble = null; state.streamText = ''; clearLiveTools();   // no arrastrar stream de otra sesión
  savePos();
  restoreDraft();
  // En móvil, elegir sesión cierra el cajón — salvo cuando venimos de cambiar de
  // agente (mobileKeepNav): ahí queremos seguir viendo la lista.
  if (mobileKeepNav) mobileKeepNav = false;
  else closeNav();
  renderSessions();
  const s = state.sessions.find(x => x.key === key);
  const a = curAgent();
  $('chat-title').textContent = options.label || (s ? sessionTitle(s) : 'Conversación');
  $('chat-title').title = $('chat-title').textContent;
  $('chat-sub').textContent = a ? `${a.emoji} ${a.name}${a.role ? ' · ' + a.role : ''}` : '';
  $('composer').classList.remove('hidden');
  const box = $('messages');
  box.innerHTML = '<div class="msg system history-loading" role="status">Cargando historial…</div>';
  sendWatch(agentId, key);
  window.HubQueue?.select(agentId, key);
  renderPrompts();
  setRunningUI(isRunning(s));
  const selector = options.anchor || (hasKnownPendingAsyncQuestions(agentId, key) ? { includeQuestions: 1 } : {});
  const r = await fetchHistoryPage(agentId, key, selector);
  if (navigationVersion !== chatNavigationVersion || state.agent !== agentId || state.current !== key || historyReadVersions.get(rk(agentId, key)) !== historyVersion) return;
  if (!options.anchor && asyncQuestionEpochs.get(rk(agentId, key)) !== questionEpoch) return selectSession(key, options);
  state.historyLoading = false;
  updateComposerState();
  if (!r || r.error || !Array.isArray(r.messages)) { showHistoryFailure(r?.error); return; }
  const liveBubble = state.streamBubble;
  const liveText = state.streamText;
  const liveTools = state.liveTools;
  rememberHistoryPage(page, r, false);
  if (!page.focused) syncAsyncHistory(agentId, key, r);
  // Secuencia compartida con reloadFinalMessages (ver renderHistorySequence)
  renderHistorySequence(box, r.messages);
  renderHistoryPager(page);
  if (isRunning(s)) {
    if (liveBubble) {
      state.streamBubble = liveBubble; state.streamText = liveText;
      renderRich(liveBubble.body, liveText); setBubblePhase();
      box.appendChild(liveBubble.el);
      if (liveTools) { state.liveTools = liveTools; box.appendChild(liveTools.el); }
    } else startStreamBubble();
  }
  for (const job of pendingSends.values()) if (job.agentId === agentId && job.key === key && !job.bubble.el.isConnected) box.appendChild(job.bubble.el);
  setRunningUI(isRunning(s));
  // Si la sesión falló y no estamos en ejecución, mostrar el error en la barra
  if (isFailed(s) && !isRunning(s)) {
    state.sessionError = { msg: '❌ El último turno falló', key, agentId: state.agent, time: Date.now() };
    // Pintar error directamente en la barra de estado (sin endRun, que compara RUN.key)
    const el = $('run-status');
    el.classList.remove('hidden', 'done');
    el.classList.add('error');
    el.querySelector('.rs-dots').style.display = 'none';
    el.querySelector('.rs-text').textContent = `⚠️ ${state.sessionError.msg}`;
  } else {
    state.sessionError = null;
  }
  updateCtx();
  renderModels();
  // Suscribir la sesión en el gateway: sin esto no llegan los eventos de herramienta
  // NI el 'final' del turno (y la barra se queda "trabajando" para siempre).
  sendWatch(state.agent, key);
  if (options.anchor) focusHistoryAnchor(page, options.anchor.messageId);
  else scrollBottom(true);
  tipKeyboardOnce();
  renderPrompts();   // el aviso es de esta sesión: se pinta (o se quita el de otra)
  if (!isMobile() && !options.anchor) $('input').focus();  // un resultado exacto conserva su foco
}

function showHistoryFailure(error) {
  const box = $('messages');
  box.querySelector('.history-loading')?.remove();
  box.querySelector('.history-error')?.remove();
  const notice = document.createElement('div');
  notice.className = 'msg system history-error';
  notice.setAttribute('role', 'alert');
  const text = document.createElement('span'); text.textContent = 'No se pudo cargar el historial. Tu borrador se conserva.';
  text.title = error || 'Sin conexión';
  const retry = document.createElement('button'); retry.textContent = 'Reintentar';
  const agent = state.agent, key = state.current;
  retry.addEventListener('click', () => { if (state.agent === agent && state.current === key) selectSession(key); });
  notice.append(text, retry); box.prepend(notice);
}

async function fetchHistoryPage(agent, key, selector = {}) {
  const query = new URLSearchParams({ agent, key });
  for (const field of ['offset', 'messageId', 'sessionId', 'includeQuestions']) if (selector[field] !== undefined) query.set(field, String(selector[field]));
  try {
    const response = await hubFetch('/api/history-page?' + query, { cache: 'no-store' });
    let result;
    try { result = await response.json(); } catch { result = null; }
    // Static-fork/older servers keep working, but cannot pretend to page or open
    // a search anchor. Network/gateway failures never silently become emptiness.
    if ((response.status === 404 || response.status === 405 || (response.ok && !result?.error && !Array.isArray(result?.messages))) && selector.offset === undefined && !selector.messageId) {
      const legacy = await hubFetch('/api/history?' + new URLSearchParams({ agent, key }), { cache: 'no-store' });
      const body = await legacy.json();
      return legacy.ok ? { ...body, paginationAvailable: false, hasMore: false, nextOffset: null } : { error: body.error || 'No se pudo cargar el historial' };
    }
    if (!response.ok || !Array.isArray(result?.messages)) return { error: result?.error || 'No se pudo cargar esta página del historial' };
    return result;
  } catch (error) { return { error: error.message || 'Sin conexión con el servidor' }; }
}

function historyMessageIdentity(message) {
  return message.id ? 'id:' + message.id : JSON.stringify([message.role, message.ts, message.text || '', message.tools || [], message.tool || null]);
}
function mergeHistoryMessages(earlier, later) {
  const seen = new Set();
  return [...earlier, ...later].filter(message => { const id = historyMessageIdentity(message); if (seen.has(id)) return false; seen.add(id); return true; });
}
function rememberHistoryPage(page, result, older) {
  if (!older && !page.focused && result.sessionId) reconcileAsyncTranscript(page.agentId, page.key, result.sessionId);
  if (!older && ((page.sessionId && result.sessionId && page.sessionId !== result.sessionId) || result.windowReset)) {
    page.messages = []; page.nextOffset = null; page.totalMessages = null; page.hasMore = false;
  }
  const previousTotal = page.totalMessages;
  page.paginationAvailable = result.paginationAvailable === true;
  if (older) page.messages = mergeHistoryMessages(result.messages, page.messages);
  else if (page.messages.length && page.paginationAvailable && !page.focused) {
    const latestIds = new Set(result.messages.map(historyMessageIdentity));
    page.messages = [...page.messages.filter(message => !latestIds.has(historyMessageIdentity(message))), ...result.messages];
  } else page.messages = result.messages.slice();
  if (older || previousTotal === null || !page.nextOffset || !page.paginationAvailable) {
    page.nextOffset = Number.isSafeInteger(result.nextOffset) ? result.nextOffset : null;
    page.hasMore = result.hasMore === true && page.nextOffset !== null;
  } else if (Number.isSafeInteger(result.totalMessages) && Number.isSafeInteger(previousTotal)) {
    // Offset counts back from the current tail. Newly appended records move the
    // loaded oldest boundary; keeping its old offset would replay/skip content.
    page.nextOffset = Math.max(0, page.nextOffset + result.totalMessages - previousTotal);
  }
  page.totalMessages = Number.isSafeInteger(result.totalMessages) ? result.totalMessages : null;
  page.sessionId = result.sessionId || page.sessionId || null;
  if (result.anchor) page.anchor = result.anchor;
  page.error = null;
}

function renderHistoryPager(page) {
  const box = $('messages');
  let pager = box.querySelector('.history-pager');
  const needsPager = page.hasMore || page.loading || page.error || page.focused || page.resetSuggested || (page.paginationAvailable === false && page.messages.length >= 200);
  if (!needsPager) { pager?.remove(); return; }
  if (!pager) {
    pager = document.createElement('div'); pager.className = 'history-pager';
    const status = document.createElement('span'); status.className = 'history-page-status'; status.setAttribute('role', 'status');
    const older = document.createElement('button'); older.className = 'history-older'; older.type = 'button'; older.addEventListener('click', loadOlderHistory);
    const latest = document.createElement('button'); latest.className = 'history-present'; latest.type = 'button'; latest.textContent = 'Conversación actual'; latest.addEventListener('click', () => selectSession(state.current));
    pager.append(status, older, latest); box.prepend(pager);
  }
  const status = pager.querySelector('.history-page-status');
  status.textContent = page.error || (page.focused ? (page.anchor?.found === false ? 'El mensaje ya no está disponible en esta transcripción.' : 'Resultado de búsqueda · estás leyendo su contexto.')
    : page.paginationAvailable === false ? 'Este gateway solo ofrece la ventana reciente; no confirma el resto del historial.' : 'Hay mensajes anteriores.');
  status.classList.toggle('error', !!page.error);
  const older = pager.querySelector('.history-older'); older.textContent = page.loading ? 'Cargando anteriores…' : page.resetSuggested ? 'Actualizar historial' : page.error ? 'Reintentar anteriores' : 'Cargar mensajes anteriores';
  older.disabled = !!page.loading; older.classList.toggle('hidden', !page.hasMore && !page.error);
  pager.querySelector('.history-present').classList.toggle('hidden', !page.focused);
  pager.setAttribute('aria-busy', String(!!page.loading));
}

async function loadOlderHistory() {
  const agent = state.agent, key = state.current, scope = rk(agent, key), page = historyPages.get(scope);
  if (page?.resetSuggested) return selectSession(key);
  if (!page || page.loading || !page.hasMore || !Number.isSafeInteger(page.nextOffset)) return;
  const navigation = chatNavigationVersion, offset = page.nextOffset;
  page.loading = true; page.error = null; renderHistoryPager(page);
  const result = await fetchHistoryPage(agent, key, { offset });
  if (navigation !== chatNavigationVersion || state.agent !== agent || state.current !== key || historyPages.get(scope) !== page) return;
  page.loading = false;
  if (!result || result.error || !Array.isArray(result.messages)) { page.error = result?.error || 'No se pudo cargar el historial anterior'; renderHistoryPager(page); return; }
  if (result.windowReset || (page.sessionId && result.sessionId && page.sessionId !== result.sessionId)) {
    page.resetSuggested = true; page.error = 'La conversación cambió en el agente. Actualiza el historial para continuar.'; renderHistoryPager(page); return;
  }
  const ids = new Set(page.messages.map(historyMessageIdentity));
  const older = result.messages.filter(message => !ids.has(historyMessageIdentity(message)));
  const box = $('messages');
  const anchor = [...box.children].find(element => !element.classList.contains('history-pager') && element.getBoundingClientRect().bottom > box.getBoundingClientRect().top);
  const before = anchor?.getBoundingClientRect().top;
  const previousScroll = box.scrollTop;
  const previousHeight = box.scrollHeight;
  const wasPinned = state.pinned;
  rememberHistoryPage(page, result, true);
  const nodes = historyNodes(older);
  box.insertBefore(nodes, box.querySelector('.history-pager')?.nextSibling || box.firstChild);
  renderHistoryPager(page);
  if (anchor?.isConnected && before !== undefined) box.scrollTop += anchor.getBoundingClientRect().top - before;
  else box.scrollTop = previousScroll + box.scrollHeight - previousHeight;
  state.pinned = wasPinned; updateLatestButton();
}

function focusHistoryAnchor(page, id) {
  const box = $('messages');
  const message = [...box.querySelectorAll('[data-history-id]')].find(element => element.dataset.historyId === id);
  box.querySelectorAll('.search-anchor').forEach(element => element.classList.remove('search-anchor'));
  if (message) {
    message.classList.add('search-anchor'); message.setAttribute('tabindex', '-1');
    message.focus({ preventScroll: true });
    box.scrollTop += message.getBoundingClientRect().top - box.getBoundingClientRect().top - 50;
  }
  state.pinned = false; updateLatestButton();
}

function renderEmpty() {
  window.HubQueue?.select(null, null);
  const a = curAgent();
  $('chat-title').textContent = a ? `${a.emoji} ${a.name}` : 'Elige un agente';
  $('chat-sub').textContent = a ? (a.connected ? (a.role || '') : '⚠️ sin conexión') : '';
  $('model-controls').classList.add('hidden');
  renderModelSummary();
  $('ctx-meter').classList.add('hidden');
  $('composer').classList.add('hidden');
  renderRename();
  if (isMobile()) openNav();   // sin sesión abierta, muestra la lista
  const hint = a
    ? `<div class="big" aria-hidden="true">${a.emoji || '🤖'}</div><strong>Un nuevo punto de partida.</strong><div>${esc(a.name)}${a.role ? ' · ' + esc(a.role) : ''}<br>Abre una conversación y seguimos desde aquí.</div><button type="button" class="empty-start">＋ Nueva conversación</button>`
    : `<div class="big" aria-hidden="true">${state.branding?.emoji || '🧭'}</div><strong>Tu equipo, conectado.</strong><div>Elige un agente para empezar una conversación.</div>`;
  $('messages').innerHTML = `<div class="empty-hint">${hint}</div>`;
  $('messages').querySelector('.empty-start')?.addEventListener('click', createSession);
  updateLatestButton();
}

// ---------------------------------------------------------------------------
// Context meter
// ---------------------------------------------------------------------------
function updateCtx() {
  const s = state.sessions.find(x => x.key === state.current);
  const meter = $('ctx-meter');
  if (!s || s.totalTokens == null) { meter.classList.add('hidden'); return; }
  meter.classList.remove('hidden');
  const win = s.contextWindowTokens || state.contextWindow;
  const pct = Math.min(100, Math.round(100 * s.totalTokens / win));
  $('ctx-fill').style.width = pct + '%';
  $('ctx-fill').className = pct >= 90 ? 'danger' : pct >= 70 ? 'warn' : '';
  $('ctx-text').textContent = `${fmtK(s.totalTokens)} / ${fmtK(win)} (${pct}%)`;
  // En móvil el texto se oculta: el propio medidor lleva el aviso en el título
  $('ctx-meter').title = `Contexto ${pct}% · ${fmtK(s.totalTokens)}/${fmtK(win)} · modelo: ${s.model || '?'}`;
  $('ctx-meter').classList.toggle('warn', pct >= 70 && pct < 90);
  $('ctx-meter').classList.toggle('danger', pct >= 90);
}

// ---------------------------------------------------------------------------
// Feedback de ejecución: qué está haciendo el agente, cuánto lleva y si sigue vivo
// ---------------------------------------------------------------------------
const BASE_TITLE = 'Hub · Agentes';
const RUN = {
  agent: null, key: null, startedAt: 0, lastSignalAt: 0,
  chars: 0, hadText: false, timer: null, lastDur: 0, doneTimer: null,
  runId: null,                 // turno actual: solo se aceptan señales de ese run
  tool: null, toolTitle: '', toolAt: 0, toolCount: 0, toolIds: new Set(), headline: '', phase: '',
};

const secsSince = (t) => (t ? Math.max(0, Math.round((Date.now() - t) / 1000)) : 0);

function fmtDur(s) {
  if (s < 60) return s + ' s';
  return Math.floor(s / 60) + ' min ' + (s % 60) + ' s';
}

function startRun() {
  state.sessionError = null;   // error anterior ya no aplica
  const el = $('run-status');
  el.classList.remove('error');
  el.querySelector('.rs-dots').style.display = '';
  RUN.agent = state.agent; RUN.key = state.current;
  RUN.startedAt = Date.now(); RUN.lastSignalAt = Date.now();
  RUN.chars = 0; RUN.hadText = false;
  RUN.runId = null; RUN.tool = null; RUN.toolAt = 0; RUN.toolCount = 0; RUN.headline = '';
  RUN.toolIds.clear();
  RUN.toolTitle = ''; RUN.phase = '';
  clearTimeout(RUN.doneTimer);
  startTicker();
  renderRunStatus();
}
function startTicker() {
  if (RUN.timer) return;
  RUN.timer = setInterval(() => {
    if (!state.running || !RUN.startedAt) { stopTicker(); return; }
    renderRunStatus();
  }, 1000);
}
function stopTicker() { if (RUN.timer) { clearInterval(RUN.timer); RUN.timer = null; } }

function noteSignal(chars) {
  RUN.lastSignalAt = Date.now();
  if (chars) { RUN.chars += chars; RUN.hadText = true; RUN.headline = ''; RUN.phase = ''; }   // ya escribe: el titular sobra
}

function endRun() {
  RUN.lastDur = secsSince(RUN.startedAt);
  RUN.startedAt = 0; RUN.lastSignalAt = 0; RUN.chars = 0; RUN.hadText = false;
  // Guardar la clave ANTES de limpiar RUN.key (lo necesita sessionError)
  const runKey = RUN.key;
  RUN.agent = null; RUN.key = null;
  RUN.runId = null; RUN.tool = null; RUN.toolAt = 0; RUN.headline = '';
  RUN.toolTitle = ''; RUN.phase = '';
  stopTicker();
  const el = $('run-status');
  if (state.sessionError && state.sessionError.key === runKey) {
    // Mostrar el error en la barra en lugar de ocultarla
    el.classList.remove('hidden', 'done');
    el.classList.add('error');
    el.querySelector('.rs-dots').style.display = 'none';
    el.querySelector('.rs-text').textContent = `⚠️ ${state.sessionError.msg}`;
  } else {
    el.classList.add('hidden');
    el.classList.remove('done', 'error');
  }
  document.title = BASE_TITLE;
}

// Nombres de herramienta -> qué está haciendo, en castellano y corto.
const TOOL_LABEL = {
  read: 'leyendo', exec: 'ejecutando', process: 'proceso', write: 'escribiendo fichero',
  edit: 'editando fichero', apply_patch: 'aplicando parche',
  web_search: 'buscando en la web', web_fetch: 'leyendo una web',
  memory_search: 'buscando en memoria', memory_get: 'leyendo memoria',
  sessions_spawn: 'lanzando subagente', sessions_send: 'hablando con otro agente',
  sessions_history: 'leyendo otra sesión', image_generate: 'generando imagen',
  video_generate: 'generando vídeo', music_generate: 'generando audio',
  view_image: 'mirando una imagen', browser: 'navegando', computer: 'usando la máquina',
  automations: 'programando aviso', progress_card: 'actualizando progreso',
};
const toolLabel = (n) => TOOL_LABEL[n] || n;

// ---------------------------------------------------------------------------
// Bloques de herramientas (lo que el agente HACE), estilo OpenClaw UI:
// resumen plegable + una línea por herramienta con preview del argumento.
// ---------------------------------------------------------------------------
const TOOL_NOUN = {
  exec: null,   // se cuenta aparte como "comandos"
  read: 'Read', write: 'Write', edit: 'Edit', apply_patch: 'Patch',
  web_search: 'Web Search', web_fetch: 'Web Fetch',
  memory_search: 'Memory Search', memory_get: 'Memory Get',
  sessions_spawn: 'Subagent', sessions_send: 'Session Send', sessions_history: 'Session History',
  image_generate: 'Image', video_generate: 'Video', music_generate: 'Music',
  view_image: 'View Image', browser: 'Browser', computer: 'Computer',
  automations: 'Automations', progress_card: 'Progress', process: 'Process',
};
const toolNoun = (n) => TOOL_NOUN.hasOwnProperty(n)
  ? TOOL_NOUN[n]
  : (String(n).charAt(0).toUpperCase() + String(n).slice(1));

// Vista previa de una línea de herramienta según el argumento principal.
function toolPreview(call) {
  const a = call.args || {};
  let s = '';
  switch (call.name) {
    case 'exec': s = '$ ' + (a.command || ''); break;
    case 'read': case 'write': case 'edit': case 'apply_patch': case 'memory_get': s = a.path || ''; break;
    case 'web_search': case 'memory_search': s = a.query || ''; break;
    case 'web_fetch': s = a.url || ''; break;
    case 'sessions_spawn': s = a.label || a.task || ''; break;
    case 'sessions_send': s = a.label || a.sessionKey || ''; break;
    case 'sessions_history': s = a.sessionKey || ''; break;
    case 'image_generate': case 'video_generate': case 'music_generate': s = a.prompt || ''; break;
    case 'view_image': s = a.path || (Array.isArray(a.paths) ? a.paths.join(' ') : ''); break;
    case 'process': s = a.action || ''; break;
    default: { try { s = JSON.stringify(a); } catch { s = ''; } }
  }
  return String(s).replace(/\s+/g, ' ').trim();
}

// Resumen del bloque: "Ejecutó 22 comandos · usó View Image, Process ×7"
function toolSummary(entries) {
  const calls = entries.filter(e => e.call).map(e => e.call);
  const nExec = calls.filter(c => c.name === 'exec').length;
  const others = {};
  for (const c of calls) if (c.name !== 'exec') others[c.name] = (others[c.name] || 0) + 1;
  const bits = [];
  if (nExec) bits.push(nExec === 1 ? 'Ejecutó 1 comando' : `Ejecutó ${nExec} comandos`);
  const names = Object.entries(others)
    .map(([n, k]) => { const noun = toolNoun(n); return noun ? noun + (k > 1 ? ' ×' + k : '') : null; })
    .filter(Boolean);
  if (names.length) bits.push('usó ' + names.join(', '));
  if (!bits.length) bits.push(calls.length === 1 ? '1 herramienta' : calls.length + ' herramientas');
  return bits.join(' · ');
}

function renderToolBlock(entries) {
  const wrap = document.createElement('div');
  wrap.className = 'tool-block';
  const head = document.createElement('button');
  head.className = 'tb-head';
  head.type = 'button';
  const icon = document.createElement('span'); icon.className = 'tb-icon'; icon.textContent = '🔧';
  const sum = document.createElement('span'); sum.className = 'tb-summary'; sum.textContent = toolSummary(entries);
  const chev = document.createElement('span'); chev.className = 'tb-chev'; chev.textContent = '›';
  head.append(icon, sum, chev);
  const body = document.createElement('div');
  body.className = 'tb-body';
  for (const e of entries) {
    const call = e.call || { name: (e.result && e.result.name) || 'tool', args: {} };
    const line = document.createElement('div');
    line.className = 'tb-line' + (e.result && e.result.isError ? ' err' : '');
    const row = document.createElement('div'); row.className = 'tb-row';
    const name = document.createElement('span'); name.className = 'tb-name'; name.textContent = call.name;
    const prev = document.createElement('code'); prev.className = 'tb-preview'; prev.textContent = toolPreview(call);
    const st = document.createElement('span'); st.className = 'tb-status';
    if (e.result) st.textContent = e.result.isError ? '✗' : '✓';
    row.append(name, prev, st);
    line.appendChild(row);
    if (e.result && e.result.preview) {
      const res = document.createElement('div'); res.className = 'tb-result';
      res.textContent = e.result.preview;
      line.appendChild(res);
    }
    line.title = ((e.result && e.result.preview) || toolPreview(call)).slice(0, 500);
    body.appendChild(line);
  }
  head.addEventListener('click', () => wrap.classList.toggle('open'));
  wrap.append(head, body);
  return wrap;
}

// Secuencia de historial: burbujas de texto + bloques plegables de herramientas
// en orden de transcript (estilo OpenClaw UI). UN solo camino para openSession y
// reloadFinalMessages: antes divergían y el reload post-turno colapsaba las tools
// a render plano ("se peta el texto hasta F5", 2026-10-11).
function renderHistorySequence(box, messages) {
  box.replaceChildren(historyNodes(messages));
  renderKnownAsyncQuestions(box);
  renderQuestionAttention();
  window.HubActivity?.enhanceMessages(box);
}

function historyNodes(messages) {
  const fragment = document.createDocumentFragment();
  const items = [];
  let toolBuf = [];
  let toolIds = [];
  const flushTools = () => { if (toolBuf.length) { items.push({ type: 'tools', entries: toolBuf, ids: toolIds }); toolBuf = []; toolIds = []; } };
  for (const m of messages) {
    if (m.diagnostic) window.HubActivity?.reportError(m.diagnostic, { agentId: state.agent, sessionKey: state.current });
    if (m.role === 'user') {
      flushTools();
      items.push({ type: 'user', text: m.text || '', ts: m.ts, id: m.id });
    } else if (m.role === 'assistant') {
      if ((m.text && m.text.trim()) || m.asyncQuestion) { flushTools(); items.push({ type: 'assistant', text: m.text || '', ts: m.ts, id: m.id, asyncQuestion: m.asyncQuestion }); }
      if (m.tools && m.tools.length) { toolBuf.push(...m.tools.map(c => ({ call: c }))); if (m.id) toolIds.push(m.id); }
    } else if (m.role === 'toolResult' && m.tool) {
      const match = toolBuf.find(x => x.call && !x.result && (!m.tool.id || x.call.id === m.tool.id));
      if (match) match.result = m.tool;
      else toolBuf.push({ call: { name: m.tool.name, args: {} }, result: m.tool });
      if (m.id) toolIds.push(m.id);
    }
  }
  flushTools();
  for (const it of items) {
    if (it.type === 'tools') {
      const block = renderToolBlock(it.entries);
      block.dataset.historyKey = it.entries.map(entry => entry.call?.id || entry.result?.id || entry.call?.name).join('|');
      if (it.ids?.length) block.dataset.historyId = it.ids[0];
      fragment.appendChild(block);
    } else {
      const bubble = mkBubble(it.type);
      renderRich(bubble.body, it.text, { plain: it.type === 'user' });
      if (it.asyncQuestion) {
        const question = rememberAsyncQuestion(state.agent, state.current, it.asyncQuestion);
        if (question) bubble.body.appendChild(asyncQuestionCard(question));
      }
      const meta = document.createElement('div'); meta.className = 'meta';
      if (it.ts) meta.textContent = new Date(it.ts).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
      if (it.id) bubble.el.dataset.historyId = it.id;
      bubble.el.appendChild(meta); fragment.appendChild(bubble.el);
    }
  }
  window.HubActivity?.enhanceMessages(fragment);
  return fragment;
}

// Quita del DOM el bloque de herramientas en vivo (si existe) y limpia el estado.
// Sin esto, tras abort/final quedaba el residuo "N herramientas en marcha".
function clearLiveTools() {
  const lt = state.liveTools;
  state.liveTools = null;
  if (lt && lt.el && lt.el.parentNode) { try { lt.el.remove(); } catch {} }
}

// Fases que anuncia el gateway antes de que haya nada que enseñar.
const PHASE_LABEL = {
  preparing_workspace: 'preparando el espacio de trabajo',
  preparing_context: 'preparando el contexto',
  starting_model: 'arrancando el modelo',
  finalizing: 'cerrando el turno',
  compacting: 'resumiendo el contexto',
};

function onPhaseEvent(m) {
  if (m.agentId !== state.agent || m.sessionKey !== state.current) return;
  if (!RUN.startedAt) return;
  if (RUN.runId && m.runId && m.runId !== RUN.runId) return;
  if (m.runId && !RUN.runId) RUN.runId = m.runId;
  RUN.lastSignalAt = Date.now();
  RUN.phase = m.phase;
  renderRunStatus();
}

// Una herramienta arranca o termina. Solo cuenta si es del turno que estamos viendo.
function onToolEvent(m) {
  if (m.agentId !== state.agent || m.sessionKey !== state.current) return;
  if (RUN.runId && m.runId && m.runId !== RUN.runId) return;   // otro turno
  if (!RUN.startedAt) return;                                   // no hay turno activo
  if (m.runId && !RUN.runId) RUN.runId = m.runId;
  RUN.lastSignalAt = Date.now();
  RUN.headline = '';                                            // el titular queda viejo
  RUN.phase = '';                                               // ya pasó a herramientas
  if (m.phase === 'start' || m.phase === 'update') {
    if (m.phase === 'start' && (!m.callId || !RUN.toolIds.has(m.callId))) { RUN.toolCount++; RUN.toolAt = Date.now(); if (m.callId) RUN.toolIds.add(m.callId); }
    RUN.tool = m.toolName;
    // El título puede traer markdown del plan del modelo: una línea, sin adornos.
    RUN.toolTitle = String(m.title || '').replace(/\s+/g, ' ').trim();
  } else if (RUN.tool === m.toolName) {
    RUN.tool = null; RUN.toolAt = 0; RUN.toolTitle = '';
  }
  liveToolEvent(m);
  renderRunStatus();
}

function onObserverEvent(m) {
  if (m.agentId !== state.agent || m.sessionKey !== state.current) return;
  if (!RUN.startedAt || (RUN.runId && m.runId && m.runId !== RUN.runId)) return;
  RUN.headline = m.headline;
  renderRunStatus();
}

// Barra de estado: se actualiza cada segundo mientras el agente trabaja.
function renderRunStatus() {
  const el = $('run-status');
  const waiting = Object.values(state.questions).some(question =>
    question.agentId === state.agent && (!question.sessionKey || question.sessionKey === state.current));
  if (waiting) {
    el.classList.remove('hidden', 'done', 'error');
    el.classList.add('waiting');
    el.querySelector('.rs-dots').style.display = 'none';
    el.querySelector('.rs-text').textContent = '❓ Esperando tu respuesta';
    document.title = '❓ Esperando respuesta · Hub';
    return;
  }
  if (el.classList.contains('waiting')) {
    el.classList.remove('waiting');
    if (!state.running || !RUN.startedAt) { el.classList.add('hidden'); document.title = BASE_TITLE; }
  }
  if (!state.running || !RUN.startedAt) return;
  const secs = secsSince(RUN.startedAt), idle = secsSince(RUN.lastSignalAt);
  let phase;
  const observed = window.HubActivity?.status(state.agent, state.current);
  if ((observed?.active || observed?.uncertain) && observed.label) {
    phase = observed.label;
  } else if (RUN.tool) {
    const t = secsSince(RUN.toolAt);
    const label = toolLabel(RUN.tool);
    const extra = RUN.toolTitle ? ' — ' + RUN.toolTitle : (label === RUN.tool ? ' (' + RUN.tool + ')' : '');
    phase = `🔧 ${label}${extra}${t >= 5 ? ' (' + t + ' s)' : ''}`;   // el contador solo si tarda
  } else if (RUN.phase && PHASE_LABEL[RUN.phase]) {
    phase = PHASE_LABEL[RUN.phase] + '…';
  } else if (RUN.headline) {
    phase = RUN.headline;
  } else if (!RUN.hadText) {
    phase = 'Enviado · esperando un evento del agente';
  } else if (idle < 3) {
    phase = 'Escribiendo…';
  } else if (idle < 20) {
    phase = 'Respuesta en curso · esperando más contenido';
  } else {
    phase = `Último evento hace ${idle} s · sin nueva señal`;
  }
  const bits = [fmtDur(secs)];
  if (RUN.toolCount) bits.push(RUN.toolCount + ' herr.');
  if (RUN.chars) bits.push(fmtK(RUN.chars) + ' car.');
  if (RUN.hadText) bits.push('señal ' + idle + 's');
  el.classList.remove('hidden');
  el.querySelector('.rs-dots').style.display = '';
  el.querySelector('.rs-text').textContent = phase + ' · ' + bits.join(' · ');
  document.title = `⏳ ${secs}s · Hub`;
}

// Cierre visible: cuánto tardó, unos segundos en la barra, sin ruido permanente.
function flashDone() {
  const el = $('run-status');
  el.classList.remove('hidden');
  el.classList.add('done');
  el.querySelector('.rs-text').textContent = `✅ Listo en ${fmtDur(RUN.lastDur)}`;
  document.title = BASE_TITLE;
  clearTimeout(RUN.doneTimer);
  RUN.doneTimer = setTimeout(() => { el.classList.add('hidden'); el.classList.remove('done'); }, 6000);
}

// ---------------------------------------------------------------------------
// Messaging
// ---------------------------------------------------------------------------
function onDelta(m) {
  const streamKey = rk(m.agentId, m.sessionKey) + '|' + (m.runId || 'legacy');
  if (Number.isFinite(m.seq)) {
    if (m.seq <= (streamSequences.get(streamKey) ?? -1)) return;
    streamSequences.set(streamKey, m.seq);
    if (streamSequences.size > 300) streamSequences.delete(streamSequences.keys().next().value);
  }
  setRunning(m.agentId, m.sessionKey, true);
  if (m.agentId !== state.agent || m.sessionKey !== state.current) return;
  if (m.runId && !RUN.runId) RUN.runId = m.runId;
  noteSignal(m.replace ? Math.max(0, (m.deltaText || '').length - state.streamText.length) : (m.deltaText || '').length);
  if (!state.streamBubble) startStreamBubble();
  state.streamText = m.replace ? (m.deltaText || '') : state.streamText + (m.deltaText || '');
  scheduleStreamRender();
}

function onTerminal(m) {
  if (m.type === 'final' && !m.text && window.HubQueue) {
    const latest = window.HubQueue.latestAdmission(m.agentId, m.sessionKey);
    if (pendingSends.has(rk(m.agentId, m.sessionKey)) || (latest && Date.now() - latest.at < 2500)) {
      window.HubQueue.refresh(m.agentId, m.sessionKey, { force: true });
      return;
    }
    // A server-side observation can precede a new browser send. Its idle flag
    // never overrides admission guards or a fresh client-side reconciliation.
    if (!m.queueChecked) {
      window.HubQueue.verifyTerminal(m).then(verified => { if (verified) onTerminal({ ...m, queueChecked: true }); });
      return;
    }
  }
  if (window.HubActivity && !window.HubActivity.guardTerminal(m)) return;
  if (m.agentId === state.agent && m.sessionKey === state.current && RUN.runId && m.runId && RUN.runId !== m.runId) return;
  const rkey = rk(m.agentId, m.sessionKey);
  const isCurrent = () => m.agentId === state.agent && m.sessionKey === state.current;
  if (m.type === 'error') {
    // Native chat:error is terminal. Retried provider/tool errors arrive as
    // diagnostics/status and never finish a live run based on a timeout.
    {
      const agentName = (state.agents.find(a => a.id === m.agentId)?.name) || m.agentId;
      const errMsg = m.diagnostic?.message || m.errorMessage || 'Error del agente';
      // Guardar error de sesión ANTES de setRunning (endRun lo consulta)
      state.sessionError = { msg: `${agentName}: ${errMsg}`, key: m.sessionKey, agentId: m.agentId, time: Date.now() };
      setRunning(m.agentId, m.sessionKey, false);
      addError(`${agentName}: ${errMsg}`, 'error', m.diagnostic, m);
      if (isCurrent()) {
        if (state.streamBubble) {
          if (!state.streamText.trim()) state.streamBubble.el.remove();
          else {
            if (!selectionInStreamBubble()) renderRich(state.streamBubble.body, state.streamText);
            state.streamBubble.el.classList.remove('streaming', 'thinking');
          }
        }
        state.streamBubble = null; state.streamText = ''; clearLiveTools();
        addMsg('system', '⚠️ ' + errMsg);
      }
      loadSessions();
    }
    return;
  }
  clearTimeout(state.errTimers?.[rkey]);
  state.sessionError = null;  // final/aborted: no es error
  setRunning(m.agentId, m.sessionKey, false);
  if (!isCurrent()) { loadSessions(); return; }
  // Native idle may have settled this visible bubble before the final frame.
  const wasStreaming = !!state.streamBubble || !!(m.runId && [...$('messages').querySelectorAll('.msg.assistant')].some(node => node.dataset.runId === m.runId));
  const bubble = state.streamBubble;
  // flush: si habia un re-render throttled pendiente, pintamos el texto completo ya
  if (bubble) {
    clearTimeout(state.streamRenderTimer); state.streamRenderTimer = null;
    if (!selectionInStreamBubble()) renderRich(bubble.body, state.streamText);
  }
  state.streamBubble = null; state.streamText = ''; clearLiveTools();
  if (bubble) bubble.el.classList.remove('streaming', 'thinking');
  if (m.type === 'aborted') {
    addMsg('system', '⏹ Respuesta detenida');
  } else if (m.type === 'final' && m.text && !wasStreaming) {
    addRichMsg('assistant', m.text);
  }
  if (m.type === 'final') flashDone();
  // refresh history-backed truth after a beat (captures files/MEDIA saved by tools)
  setTimeout(() => { if (isCurrent() && !state.runningByKey[rkey]) reloadFinalMessages(m.sessionKey); }, 800);
  loadSessions();
}

async function reloadFinalMessages(key) {
  const agentId = state.agent;
  const page = historyPages.get(rk(agentId, key));
  // An exact search context is not the recent tail. Replacing it with a final
  // refresh would throw the reader away from the message they opened.
  if (page?.focused) { updateLatestButton(); return; }
  const navigationVersion = chatNavigationVersion;
  const historyVersion = ++historyReadSequence;
  historyReadVersions.set(rk(agentId, key), historyVersion);
  const questionEpoch = asyncQuestionEpochs.get(rk(agentId, key));
  const r = await fetchHistoryPage(agentId, key, hasKnownPendingAsyncQuestions(agentId, key) ? { includeQuestions: 1 } : {});
  if (navigationVersion !== chatNavigationVersion || state.agent !== agentId || state.current !== key || historyReadVersions.get(rk(agentId, key)) !== historyVersion) return;
  if (asyncQuestionEpochs.get(rk(agentId, key)) !== questionEpoch) return reloadFinalMessages(key);
  const wasLoading = state.historyLoading;
  state.historyLoading = false; updateComposerState();
  if (!r || !Array.isArray(r.messages)) { if (wasLoading) showHistoryFailure(r?.error); return; }
  syncAsyncHistory(agentId, key, r);
  if (state.runningByKey[rk(agentId, key)]) return;
  // No rehacer el DOM si el usuario esta seleccionando texto o tiene el menu
  // abierto: destruiria la seleccion a media faena.
  if (document.body.classList.contains('sel-mode') || MENU.el) return;
  const box = $('messages');
  // A late final/history update must not replace a form under the user's
  // cursor. Fetch fresh truth once they leave it or its submission settles.
  if (editingAsyncQuestion()) {
    deferredFinalHistory = { agentId, key, navigationVersion };
    return;
  }
  const wasPinned = state.pinned;
  const scrollTop = box.scrollTop;
  const expanded = new Map([...box.querySelectorAll('.tool-block')].map((block, index) => [block.dataset.historyKey || String(index), block.classList.contains('open')]));
  if (page) rememberHistoryPage(page, r, false);
  renderHistorySequence(box, page?.messages || r.messages);
  [...box.querySelectorAll('.tool-block')].forEach((block, index) => block.classList.toggle('open', !!expanded.get(block.dataset.historyKey || String(index))));
  if (page) renderHistoryPager(page);
  if (wasPinned) scrollBottom(true);
  else { box.scrollTop = scrollTop; state.pinned = false; }
  updateLatestButton();
}

function editingAsyncQuestion() {
  return !!document.activeElement?.closest('#messages .async-question[data-answered="false"][data-dismissed="false"][data-answerable="true"]')
    || !!$('messages').querySelector('.async-question[aria-busy="true"]');
}

function flushDeferredFinalHistory() {
  const refresh = deferredFinalHistory;
  if (!refresh || editingAsyncQuestion()) return;
  deferredFinalHistory = null;
  if (refresh.agentId === state.agent && refresh.key === state.current && refresh.navigationVersion === chatNavigationVersion
      && !state.runningByKey[rk(refresh.agentId, refresh.key)]) reloadFinalMessages(refresh.key);
}

$('messages').addEventListener('focusout', () => setTimeout(flushDeferredFinalHistory, 0));

function setRunning(agentId, key, on) {
  const k = rk(agentId, key);
  const changed = state.runningByKey[k] !== on;
  state.runningByKey[k] = on;
  if (on) { if (!state.runSinceByKey[k]) state.runSinceByKey[k] = Date.now(); }
  else { delete state.runSinceByKey[k]; delete state.lastEventByKey[k]; }
  if (agentId === state.agent && key === state.current && (changed || state.running !== on)) setRunningUI(on);
  if (changed) renderSessions();
}

// ---------------------------------------------------------------------------
// Anti-"se queda pillado": manda el gateway (hasActiveRun), no nuestra memoria.
// Si el gateway dice que la sesion NO tiene turno activo y aqui seguimos
// pintando "trabajando" sin senales recientes, la barra esta stale (tipico al
// entrar/salir de la app en el movil). Se apaga sola, sin F5.
// ---------------------------------------------------------------------------
const STALE_MS = 25000;
async function reconcileRuns() {
  const now = Date.now();
  const covered = new Set();
  for (const s of state.sessions || []) {
    const k = rk(state.agent, s.key);
    covered.add(k);
    if (!state.runningByKey[k] || s.hasActiveRun) continue;      // corre de verdad
    // El gateway AFIRMA que no hay turno: mandamos nosotros, no el sello local.
    // NO usar lastEventByKey aquí: eventos no-laborales (sessions/agent/…) lo
    // refrescaban sin parar y dejaban la barra encendida de por vida.
    if (now - (state.runSinceByKey[k] || 0) < STALE_MS) continue;   // turno recien lanzado
    setRunning(state.agent, s.key, false);
  }
  // La sesión ABIERTA puede no estar en la lista del sidebar (modo "Otras",
  // recorte por fecha o tope de 120 árboles). Si quedó marcada como activa y no
  // la cubrimos arriba, preguntamos al gateway por ella: sin esto la barra
  // "trabajando" se queda pegada para siempre cuando el 'final' no llegó.
  const ck = state.current ? rk(state.agent, state.current) : null;
  if (ck && !covered.has(ck) && state.runningByKey[ck]) {
    if (now - (state.runSinceByKey[ck] || 0) >= STALE_MS) {
      try {
        const r = await hubFetch(`/api/run-status?agent=${encodeURIComponent(state.agent)}&key=${encodeURIComponent(state.current)}`)
          .then(r => r.json()).catch(() => null);
        // Solo apagamos si el gateway AFIRMA que no hay turno (null = desconocido).
        if (r && r.hasActiveRun === false) {
          setRunning(state.agent, state.current, false);
        }
      } catch { /* red fallando: no tocamos el estado, ya lo hará el siguiente ciclo */ }
    }
  }
}

// Red de seguridad: con la app visible y algo marcado como activo, re-leer el
// estado del gateway cada 20 s (loadSessions termina llamando a reconcileRuns).
setInterval(() => {
  if (document.hidden) return;
  if (!Object.values(state.runningByKey).some(Boolean)) return;
  loadSessions();
}, 20000);

// La red de 20 s solo actúa si algo está marcado activo; si la sesión abierta
// quedó pillada y NO está en la lista, loadSessions no la reconcilia. Un latido
// propio para la sesión actual cierra ese hueco.
setInterval(() => {
  if (document.hidden || !state.current) return;
  const ck = rk(state.agent, state.current);
  if (state.runningByKey[ck]) reconcileRuns();
}, 20000);

function setRunningUI(on) {
  state.running = on;
  $('btn-stop').classList.toggle('hidden', !on && !window.HubQueue?.hasPending(state.agent, state.current));
  updateComposerState();
  $('gw-status').classList.toggle('busy', !!on);
  if (on) {
    if (!RUN.startedAt || RUN.key !== state.current || RUN.agent !== state.agent) startRun();
    else startTicker();
  } else {
    endRun();
  }
  renderModels();
}

// ---------------------------------------------------------------------------
// Admission protects a new send from stale idle observations. Queue size and
// removal are owned by the Gateway and recovered by HubQueue, never inferred.
function markQueued(agentId, key, runId) {
  window.HubQueue?.accepted({ agentId, sessionKey: key, runId });
}
function queueDepth() {
  return window.HubQueue?.depth(state.agent, state.current) ?? null;
}

function startStreamBubble() {
  state.streamText = '';
  state.streamBubble = mkBubble('assistant');
  state.streamBubble.el.classList.add('streaming', 'thinking');
  const dots = document.createElement('span');
  dots.className = 'dots';
  dots.innerHTML = '<i></i><i></i><i></i>';
  state.streamBubble.el.appendChild(dots);
  $('messages').appendChild(state.streamBubble.el);
  // Bloque en vivo de herramientas: se rellena con los eventos tool del WS
  // (lo que el agente hace, en tiempo real, como en OpenClaw UI).
  const tb = document.createElement('div');
  tb.className = 'tool-block live open';
  const head = document.createElement('div');
  head.className = 'tb-head';
  head.innerHTML = '<span class="tb-icon">🔧</span><span class="tb-summary">Trabajando…</span>';
  const body = document.createElement('div');
  body.className = 'tb-body';
  tb.append(head, body);
  tb.style.display = 'none';   // solo visible cuando haya herramientas
  state.liveTools = { el: tb, body, head: head.querySelector('.tb-summary'), lines: new Map(), count: 0 };
  $('messages').appendChild(tb);
  scrollBottom();
}

// Una herramienta arranca/actualiza/termina en el turno en vivo.
function liveToolEvent(m) {
  const lt = state.liveTools;
  if (!lt) return;
  const cleanTitle = String(m.title || '').replace(/\s+/g, ' ').trim();
  if (m.phase === 'start') {
    if (m.callId && lt.lines.has(m.callId)) { const existing = lt.lines.get(m.callId); if (cleanTitle) existing.prev.textContent = cleanTitle; return; }
    lt.count++;
    const key = m.callId || (m.toolName + '#' + lt.count);
    const line = document.createElement('div');
    line.className = 'tb-line running';
    const row = document.createElement('div'); row.className = 'tb-row';
    const name = document.createElement('span'); name.className = 'tb-name'; name.textContent = m.toolName;
    const prev = document.createElement('code'); prev.className = 'tb-preview'; prev.textContent = cleanTitle;
    const st = document.createElement('span'); st.className = 'tb-status'; st.textContent = '…';
    row.append(name, prev, st);
    line.appendChild(row);
    lt.body.appendChild(line);
    lt.lines.set(key, { el: line, tool: m.toolName, st, prev });
    lt.el.style.display = '';
    lt.head.textContent = lt.count + (lt.count === 1 ? ' herramienta' : ' herramientas') + ' · ' + [...lt.lines.values()].filter(item => item.el.classList.contains('running')).length + ' en curso';
    scrollBottom();
  } else {
    let rec = m.callId ? lt.lines.get(m.callId) : null;
    if (!rec) {
      for (const [, v] of [...lt.lines].reverse()) {
        if (v.tool === m.toolName && v.el.classList.contains('running')) { rec = v; break; }
      }
    }
    if (!rec) return;
    if (cleanTitle && m.phase === 'update') rec.prev.textContent = cleanTitle;
    if (m.phase === 'end') {
      rec.el.classList.remove('running');
      const ok = m.ok !== false && !m.error;
      rec.st.textContent = ok ? '✓' : '✗';
      rec.st.classList.toggle('err', !ok);
      if (m.error) rec.el.title = m.error;
      if (m.diagnostic && !rec.el.querySelector('.ha-tool-diagnostic')) {
        const details = document.createElement('button'); details.className = 'ha-button ha-tool-diagnostic'; details.type = 'button'; details.textContent = 'Ver error completo';
        details.addEventListener('click', () => { window.HubActivity?.reportError(m.diagnostic, m); window.HubActivity?.openDiagnostics(); }); rec.el.append(details);
      }
      lt.head.textContent = lt.count + (lt.count === 1 ? ' herramienta' : ' herramientas') + ' · ' + [...lt.lines.values()].filter(item => item.el.classList.contains('running')).length + ' en curso';
    }
  }
}

// Sin texto todavía -> puntos animados; con texto -> cursor de streaming.
function setBubblePhase() {
  if (!state.streamBubble) return;
  state.streamBubble.el.classList.toggle('thinking', !state.streamText);
}

const stopPending = new Map();
function finishStop(job, error) {
  const scope = rk(job.agentId, job.key);
  if (stopPending.get(scope) !== job) return false;
  clearTimeout(job.timer);
  stopPending.delete(scope);
  const text = error || 'Parada confirmada; turno inactivo y cola vacía';
  sendNotices.set(scope, { text, error: !!error });
  if (state.agent === job.agentId && state.current === job.key) {
    toast(text); updateComposerState(); renderModels();
  }
  return true;
}
function settleStopFromSnapshot(agentId, key, snapshot, observation) {
  const job = stopPending.get(rk(agentId, key));
  if (!job?.acknowledged || !Number.isFinite(observation?.requestedAt)
      || observation.requestedAt < job.acknowledgedAt || snapshot.available !== true
      || snapshot.hasActiveRun !== false || snapshot.queuedCount !== 0
      || snapshot.items?.some(item => item.state === 'queued') || pendingSends.has(rk(agentId, key))) return false;
  return finishStop(job);
}
function handleStopResult(message) {
  const job = stopPending.get(rk(message.agentId, message.sessionKey));
  if (!job || message.requestId !== job.requestId) return;
  if (!message.ok) {
    const error = message.error || 'No se pudo confirmar la parada';
    finishStop(job, error); addError(error, 'error', message.diagnostic, message);
    return;
  }
  job.acknowledged = true;
  job.acknowledgedAt = performance.now();
  // RPC acceptance is not proof that the native Codex turn has finished.
  window.HubQueue?.refresh(message.agentId, message.sessionKey, { force: true });
  loadSessions();
  updateComposerState();
}
function hasCurrentQuestion() {
  return Object.values(state.questions).some(question => forCurrentAgent(question) && (!question.sessionKey || question.sessionKey === state.current));
}
function updateComposerState() {
  const scope = rk(state.agent, state.current);
  const pending = pendingSends.has(scope);
  const stopping = stopPending.has(scope);
  const uploading = uploadingByKey.get(scope) || 0;
  const question = hasCurrentQuestion();
  const offline = state.ws?.readyState !== WebSocket.OPEN || !curAgent()?.connected;
  $('btn-send').disabled = !!modelSettingsPending || state.historyLoading || pending || stopping || !!uploading || question || offline || !state.current;
  $('btn-attach').disabled = pending || question || !state.current;
  $('input').readOnly = pending;
  $('input').disabled = question;
  $('btn-stop').classList.toggle('hidden', !stopping && !state.running && !window.HubQueue?.hasPending(state.agent, state.current));
  $('btn-stop').disabled = offline || stopping;
  $('btn-stop').title = stopping ? 'Deteniendo; esperando turno inactivo y cola vacía' : 'Parar respuesta y vaciar la cola';
  document.querySelectorAll('#chips .x').forEach(button => { button.disabled = pending; });
  const notice = sendNotices.get(scope);
  const text = stopping ? 'Deteniendo… Esperando confirmar el turno inactivo y la cola vacía.'
    : pending ? 'Enviando… El borrador está protegido hasta confirmar.'
    : uploading ? 'Subiendo ' + uploading + (uploading === 1 ? ' archivo…' : ' archivos…')
    : notice?.text || (offline && state.current ? 'Sin conexión. Tu borrador se conserva.' : '');
  const status = $('composer-status');
  if (!status) return;
  if (status.dataset.text !== text) { status.textContent = text; status.dataset.text = text; }
  status.classList.toggle('hidden', !text);
  status.classList.toggle('error', !!notice?.error && !pending && !uploading);
}
function sameSubmission(draft, attempt) {
  return draft.text === attempt.text && JSON.stringify((draft.files || []).map(file => file.id)) === JSON.stringify((attempt.files || []).map(file => file.id));
}
function newClientId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  // randomUUID requires HTTPS; getRandomValues also supports existing LAN HTTP panels.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}
function recoverSend(job, error, uncertain = false) {
  const scope = rk(job.agentId, job.key);
  clearTimeout(job.timer);
  if (pendingSends.get(scope) !== job) return;
  pendingSends.delete(scope);
  job.bubble?.el.remove();
  sendNotices.set(scope, { text: error + (uncertain ? ' Puedes reintentar el mismo envío sin duplicarlo.' : ' Corrige o vuelve a enviar cuando quieras.'), error: true });
  if (!job.wasRunning) setRunning(job.agentId, job.key, false);
  if (state.agent === job.agentId && state.current === job.key) restoreDraft();
  updateComposerState();
}
function handleSendResult(message, accepted) {
  const scope = rk(message.agentId, message.sessionKey);
  const job = pendingSends.get(scope);
  const draft = readDraft(message.agentId, message.sessionKey);
  const attempt = job || draft.submission;
  if (!attempt || (message.clientMessageId && message.clientMessageId !== attempt.id)) return false;
  if (!accepted && message.requestId && job?.requestId && message.requestId !== job.requestId) return true;
  if (!accepted) {
    state.sessionError = { msg: message.error || 'No se pudo enviar', key: message.sessionKey, agentId: message.agentId, time: Date.now() };
    if (job) recoverSend(job, message.error || 'El agente rechazó el mensaje.');
    addError(message.error || 'No se pudo enviar el mensaje', 'error', message.diagnostic, message);
    return true;
  }
  clearTimeout(job?.timer);
  pendingSends.delete(scope);
  sendNotices.delete(scope);
  if (job?.bubble) { job.bubble.el.classList.remove('pending-send'); job.bubble.meta.textContent = 'Enviado'; }
  if (sameSubmission(draft, attempt)) clearDraft(message.agentId, message.sessionKey);
  else { const updated = { ...draft }; delete updated.submission; writeDraft(updated, message.agentId, message.sessionKey); }
  if (state.agent === message.agentId && state.current === message.sessionKey) restoreDraft();
  updateComposerState();
  return true;
}

function send() {
  if (stopPending.has(rk(state.agent, state.current))) { saveDraft(); toast('Espera a confirmar la parada; el borrador se conserva'); return; }
  // Keyboard shortcuts must respect the same pending-save guard as the button.
  if (modelSettingsPending) { toast('Guardando los ajustes; el mensaje sigue en el borrador'); return; }
  if (hasCurrentQuestion()) { toast('Responde o salta la pregunta antes de enviar al chat'); return; }
  if (state.historyLoading) { toast('Cargando el chat; el mensaje sigue en el borrador'); return; }
  const scope = rk(state.agent, state.current);
  if (pendingSends.has(scope)) return;
  if (uploadingByKey.get(scope)) { toast('Espera a que termine la subida; el borrador está guardado'); return; }
  if (state.ws?.readyState !== WebSocket.OPEN || !curAgent()?.connected) {
    saveDraft(); updateComposerState(); toast('Sin conexión. El mensaje sigue en el borrador'); return;
  }
  const text = $('input').value.trim();
  if (!state.current) return;
  if (!text && !state.pendingFiles.length) return;
  saveDraft();
  const draft = readDraft();
  const id = draft.submission && sameSubmission(draft, draft.submission) ? draft.submission.id : newClientId();
  const submission = { id, text: draft.text, files: [...draft.files] };
  writeDraft({ ...draft, submission });
  const job = { ...submission, agentId: state.agent, key: state.current, requestId: newClientId(), wasRunning: isRunning(state.sessions.find(session => session.key === state.current)) || !!state.runningByKey[scope] };
  const atts = state.pendingFiles.map(f => ({ id: f.id, name: f.name, mimeType: f.mimeType }));
  // optimistic render
  const bubble = mkBubble('user');
  bubble.el.classList.add('pending-send');
  bubble.meta = document.createElement('div'); bubble.meta.className = 'meta'; bubble.meta.textContent = 'Enviando…';
  job.bubble = bubble;
  renderRich(bubble.body, text || '', { plain: true });
  for (const f of state.pendingFiles) bubble.body.appendChild(renderAttachment(f));
  bubble.el.appendChild(bubble.meta);
  $('messages').appendChild(bubble.el);
  pendingSends.set(scope, job);
  sendNotices.delete(scope);
  job.timer = setTimeout(() => recoverSend(job, 'El envío no se ha confirmado.', true), 35000);
  try { state.ws.send(JSON.stringify({ type: 'send', agentId: state.agent, sessionKey: state.current, text, attachments: atts, clientMessageId: id, requestId: job.requestId })); }
  catch { recoverSend(job, 'No se pudo conectar con el servidor.'); return; }
  setRunning(state.agent, state.current, true);
  state.pinned = true;   // el usuario acaba de enviar: quiere ver la respuesta
  scrollBottom(true);
  updateComposerState();
}

$('btn-send').addEventListener('click', send);
// Enter: en escritorio envía (Shift+Enter = salto de línea). En móvil NO: el
// teclado inserta salto de línea y se envía con el botón ➤ (Ctrl/Cmd+Enter envía igual).
const coarsePointer = () => window.matchMedia('(pointer: coarse)').matches;
function applyComposerHint() {
  $('input').placeholder = 'Escribe un mensaje…';
  if ($('composer-hint')) $('composer-hint').textContent = coarsePointer() ? '' : 'Enter para enviar · Shift + Enter para una nueva línea';
}
applyComposerHint();

// Una sola vez por navegador: explicar que en movil Enter no envia.
function tipKeyboardOnce() {
  if (!coarsePointer()) return;
  try {
    if (localStorage.getItem('hub.tip.enter')) return;
    localStorage.setItem('hub.tip.enter', '1');
  } catch { return; }
  addMsg('system', '⏎ hace salto de línea · para enviar, el botón ➤');
}

$('input').addEventListener('keydown', (e) => {
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key !== 'Enter') return;
  if (!e.metaKey && !e.ctrlKey) {
    if (coarsePointer()) return;   // móvil táctil: Enter = salto de línea
    if (e.shiftKey) return;        // escritorio: Shift+Enter = salto de línea
  }
  e.preventDefault();
  send();
});
$('input').addEventListener('input', () => { autogrow(); saveDraft(); });
function autogrow() {
  const t = $('input');
  const style = window.getComputedStyle(t);
  if (style.fieldSizing === 'content') { t.style.height = ''; return; }
  const limit = Math.max(parseFloat(style.minHeight) || 0, parseFloat(style.maxHeight) || 160);
  t.style.height = 'auto';
  t.style.height = Math.min(t.scrollHeight + 3, limit) + 'px';
}

$('btn-stop').addEventListener('click', () => {
  if (!state.current || state.ws?.readyState !== WebSocket.OPEN) { toast('Sin conexión: no se ha confirmado la parada'); return; }
  const scope = rk(state.agent, state.current);
  if (stopPending.has(scope)) return;
  const job = { agentId: state.agent, key: state.current, requestId: newClientId(), at: Date.now(), acknowledged: false };
  stopPending.set(scope, job); updateComposerState(); renderModels();
  job.timer = setTimeout(() => finishStop(job, 'La parada aún no está confirmada. Puedes volver a pulsar STOP; tu borrador se conserva.'), 20000);
  try { state.ws.send(JSON.stringify({ type: 'abort', agentId: job.agentId, sessionKey: job.key, requestId: job.requestId })); }
  catch { finishStop(job, 'No se pudo solicitar la parada'); }
  // Si el turno ya no existia (barra fantasma), el gateway no emitira 'aborted':
  // releer su estado en 3 s para que la barra no siga girando.
  setTimeout(loadSessions, 3000);
});

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------
$('btn-attach').addEventListener('click', () => $('file-input').click());
$('file-input').addEventListener('change', (e) => { uploadFiles(e.target.files); e.target.value = ''; });

const main = $('main');
['dragenter', 'dragover'].forEach(ev => main.addEventListener(ev, (e) => {
  e.preventDefault(); if (supports('files')) $('drop-overlay').classList.remove('hidden');
}));
['dragleave', 'drop'].forEach(ev => main.addEventListener(ev, (e) => {
  e.preventDefault(); if (ev === 'drop' || e.target === $('drop-overlay')) $('drop-overlay').classList.add('hidden');
}));
main.addEventListener('drop', (e) => {
  $('drop-overlay').classList.add('hidden');
  if (e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files);
});

// Pegar (Ctrl+V / ⌘V) en el panel: el TEXTO lo inserta el navegador solo, pero una
// CAPTURA o un fichero del portapapeles no lo recogía nadie -> al pegar no pasaba
// absolutamente nada (clipboard regression report: "en PC no deja pegar ni con Ctrl+V
// ni con ratón"). Se escucha en el documento entero para que también funcione con
// el foco fuera del composer (p. ej. pegar con el menú del ratón).
document.addEventListener('paste', (e) => {
  const dt = e.clipboardData;
  if (!dt) return;
  const files = [...(dt.items || [])]
    .filter((i) => i.kind === 'file')
    .map((i) => i.getAsFile())
    .filter(Boolean);
  if (!files.length) return;                       // texto puro: lo pega el navegador
  if ($('app').classList.contains('hidden')) return; // pantalla de login
  e.preventDefault();                              // si no, se cuela el HTML/base64
  if (!state.agent || !state.current) { toast('Elige una sesión para adjuntar'); return; }
  uploadFiles(files).then(uploaded => { if (uploaded) toast(files.length === 1 ? '📎 Adjunto pegado' : '📎 ' + files.length + ' adjuntos pegados'); });
});

async function uploadFiles(files) {
  if (!supports('files')) { toast('Los adjuntos no están disponibles en este asistente'); return false; }
  if (!state.agent || !state.current) { alert('Selecciona una sesión primero'); return; }
  const agent = state.agent, key = state.current, scope = rk(agent, key);
  const selected = [...files];
  if (selected.length + readDraft().files.length + (uploadingByKey.get(scope) || 0) > 6) { toast('Puedes adjuntar hasta 6 archivos por mensaje'); return; }
  if (pendingSends.has(scope)) { toast('Espera a la confirmación del envío'); return; }
  if (!selected.length) return;
  saveDraft();
  uploadingByKey.set(scope, (uploadingByKey.get(scope) || 0) + selected.length);
  updateComposerState();
  const fd = new FormData();
  for (const file of selected) fd.append('files', file);
  try {
    const response = await hubFetch('/api/upload?' + new URLSearchParams({ agent, key }), { method: 'POST', body: fd });
    const result = await response.json();
    if (!response.ok || result.error || !Array.isArray(result.files)) throw new Error(result.error || 'No se pudieron subir los archivos');
    const draft = readDraft(agent, key);
    writeDraft({ ...draft, files: [...draft.files, ...result.files] }, agent, key);
    if (state.agent === agent && state.current === key) { state.pendingFiles = [...readDraft(agent, key).files]; renderChips(); }
    return true;
  } catch (error) { toast(error.message || 'Error subiendo archivos'); return false; }
  finally {
    const remaining = (uploadingByKey.get(scope) || 0) - selected.length;
    if (remaining > 0) uploadingByKey.set(scope, remaining); else uploadingByKey.delete(scope);
    updateComposerState();
  }
}

function renderChips() {
  const el = $('chips');
  el.innerHTML = '';
  state.pendingFiles.forEach((f, i) => {
    const c = document.createElement('div');
    c.className = 'chip';
    if (String(f.mimeType || '').startsWith('image/')) {
      const img = document.createElement('img');
      img.src = '/api/files?path=uploads/' + encodeURIComponent(f.id);
      c.appendChild(img);
    } else {
      c.appendChild(document.createTextNode('📄'));
    }
    const n = document.createElement('span'); n.textContent = f.name;
    const x = document.createElement('button'); x.className = 'x'; x.textContent = '✕';
    x.setAttribute('aria-label', 'Quitar ' + f.name);
    x.disabled = pendingSends.has(rk(state.agent, state.current));
    x.addEventListener('click', () => { state.pendingFiles.splice(i, 1); saveDraft(); renderChips(); });
    c.append(n, x);
    el.appendChild(c);
  });
}

function renderAttachment(f) {
  if (f.mimeType && f.mimeType.startsWith('image/')) {
    const img = document.createElement('img');
    img.className = 'chat-img';
    img.src = '/api/files?path=uploads/' + encodeURIComponent(f.id);
    img.alt = f.name;
    img.addEventListener('click', () => lightbox(img.src));
    return img;
  }
  const a = document.createElement('a');
  a.className = 'file-card';
  a.href = '/api/files?path=uploads/' + encodeURIComponent(f.id) + '&dl=1';
  a.innerHTML = `<span class="f-icon">📄</span><span>${esc(f.name)}</span>`;
  return a;
}

// ---------------------------------------------------------------------------
// Rich text rendering (markdown-lite + MEDIA: lines)
// ---------------------------------------------------------------------------
const IMG_EXT = /\.(png|jpe?g|gif|webp|svg)$/i;
const FILE_PATH_RE = /(?<![\w./:-])(?:\/home\/(?:node|[a-zA-Z0-9_-]+)\/\.openclaw(?:-[a-zA-Z0-9_-]+)?\/workspace\/)?(?:media|uploads|tmp|reports|nas|nas_docs|docs)\/[^\s)"']+/g;

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmtSize(b) {
  if (b == null) return '';
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1048576).toFixed(1) + ' MB';
}

function fileUrl(p) {
  if (curAgent()?.fileTransport === 'gateway' && state.current && !String(p).startsWith('uploads/')) {
    return '/api/session-file?' + new URLSearchParams({ agent: state.agent, key: state.current, path: p });
  }
  const agent = state.agent ? `&agent=${encodeURIComponent(state.agent)}` : '';
  const session = state.current ? '&key=' + encodeURIComponent(state.current) : '';
  return '/api/files?path=' + encodeURIComponent(p) + agent + session;
}

function renderRich(container, text, opts = {}) {
  container.innerHTML = '';
  if (!text) return;

  // 1) Extract MEDIA: lines and file paths into attachments; keep text clean
  const attachments = [];
  const lines = text.split('\n');
  const kept = [];
  let fenced = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) { fenced = !fenced; kept.push(line); continue; }
    if (opts.plain || fenced || !supports('files')) { kept.push(line); continue; }
    const m = line.match(/^\s*MEDIA:\s*(\S+)\s*$/);
    if (m) { attachments.push(m[1]); continue; }
    // Paths inside code remain byte-for-byte source, not file cards.
    kept.push(line.split(/(`[^`\n]+`)/g).map((part, index) => index % 2 ? part : part.replace(FILE_PATH_RE, p => {
      if (FILE_WHITELIST_CHECK(p)) { attachments.push(p); return p.split('/').pop(); }
      return p;
    })).join(''));
  }
  const body = kept.join('\n');

  // 2) Texto: markdown completo para el agente; plano (pre-wrap) para el usuario
  if (opts.plain) container.appendChild(document.createTextNode(body));
  else container.appendChild(mdBlocks(body));

  // 3) attachments
  for (const p of new Set(attachments)) {
    if (IMG_EXT.test(p)) {
      const img = document.createElement('img');
      img.className = 'chat-img';
      img.src = fileUrl(p);
      img.loading = 'lazy';
      img.addEventListener('click', () => lightbox(img.src));
      container.appendChild(img);
    } else {
      const a = document.createElement('a');
      a.className = 'file-card';
      a.href = fileUrl(p) + '&dl=1';
      a.title = 'Descargar ' + p.split('/').pop();
      const name = document.createElement('span');
      name.className = 'f-name';
      name.textContent = p.split('/').pop();
      const icon = document.createElement('span');
      icon.className = 'f-icon'; icon.textContent = '📄';
      const dl = document.createElement('span');
      dl.className = 'f-size'; dl.textContent = '↓';   // icono: no se parte en pantallas estrechas
      a.append(icon, name, dl);
      container.appendChild(a);
    }
  }
  window.HubActivity?.enhanceMessages(container.closest('.msg') || container);
}

function FILE_WHITELIST_CHECK(p) {
  if (!supports('files')) return false;
  const r = String(p).replace(/^\/home\/(?:node|[a-zA-Z0-9_-]+)\/\.openclaw(?:-[a-zA-Z0-9_-]+)?\/workspace\//, '');
  return /^(media|uploads|tmp|reports|nas|nas_docs|docs)\//.test(r) && !r.includes('\\') && !r.split('/').includes('..');
}

// ---------------------------------------------------------------------------
// Markdown completo (estilo OpenClaw UI): títulos, listas anidadas, tablas,
// citas, código y separadores. Parser por bloques, tolerante a texto parcial
// (se usa también durante el streaming).
// ---------------------------------------------------------------------------
const FENCE_PH = '\u0000F';   // placeholder de bloques de código protegidos
const CODE_PH = '\u0000C';    // placeholder de código inline protegido

function mdBlocks(text) {
  const root = document.createElement('div');
  root.className = 'md';
  if (!text) return root;

  // 1) Proteger los bloques de código para que el parser no los toque
  const fences = [];
  const src = String(text).replace(/```(\w*)[ \t]*\n?([\s\S]*?)(?:```|$)/g, (m, lang, code) => {
    fences.push({ lang, code: code.replace(/\n$/, '') });
    return FENCE_PH + (fences.length - 1);
  });

  const lines = src.split('\n');
  const isBlank = (l) => !l.trim();
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Bloque de código protegido
    const fm = line.trim().match(new RegExp('^' + FENCE_PH + '(\\d+)$'));
    if (fm) {
      const f = fences[+fm[1]];
      const pre = document.createElement('pre');
      if (f.lang) pre.dataset.lang = f.lang;
      const code = document.createElement('code');
      code.textContent = f.code;
      pre.appendChild(code);
      root.appendChild(pre);
      i++; continue;
    }
    if (isBlank(line)) { i++; continue; }

    // Separador horizontal
    if (/^\s{0,3}(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      root.appendChild(document.createElement('hr'));
      i++; continue;
    }

    // Título
    const hm = line.match(/^\s{0,3}(#{1,6})\s+(.*)$/);
    if (hm) {
      const h = document.createElement('h' + Math.min(6, hm[1].length));
      inlineInto(h, hm[2].replace(/\s+#+\s*$/, ''));
      root.appendChild(h);
      i++; continue;
    }

    // Cita (recursiva: admite listas y párrafos dentro)
    if (/^\s{0,3}>/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s{0,3}>/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s{0,3}>[ \t]?/, ''));
        i++;
      }
      const bq = document.createElement('blockquote');
      bq.appendChild(mdBlocks(buf.join('\n')));
      root.appendChild(bq);
      continue;
    }

    // Tabla: línea con | seguida de separador |---|
    if (line.includes('|') && i + 1 < lines.length && lines[i + 1].includes('-')
      && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1])) {
      const rows = [line];
      i += 2;
      while (i < lines.length && lines[i].includes('|') && !isBlank(lines[i])) { rows.push(lines[i]); i++; }
      root.appendChild(buildTable(rows));
      continue;
    }

    // Lista (viñetas o numerada) con anidación por sangría
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      i = parseList(lines, i, root);
      continue;
    }

    // Párrafo: líneas normales consecutivas
    const buf = [line];
    i++;
    while (i < lines.length && !isBlank(lines[i])
      && !/^\s{0,3}#{1,6}\s/.test(lines[i])
      && !/^\s{0,3}>/.test(lines[i])
      && !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i])
      && !/^\s{0,3}(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i])
      && !lines[i].trim().startsWith(FENCE_PH)) {
      buf.push(lines[i]);
      i++;
    }
    const p = document.createElement('p');
    buf.forEach((l, k) => {
      if (k > 0) p.appendChild(document.createElement('br'));
      inlineInto(p, l);
    });
    root.appendChild(p);
  }
  return root;
}

// Recoge un bloque de lista a partir de `start` y lo añade a root.
// Devuelve el índice de la primera línea que ya no es de la lista.
function parseList(lines, start, root) {
  const itemRe = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
  const items = [];
  let i = start, baseIndent = null;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      const next = lines[i + 1];
      if (next && (itemRe.test(next) || /^\s{2,}\S/.test(next))) { i++; continue; }
      break;
    }
    const m = line.match(itemRe);
    if (m) {
      const indent = m[1].replace(/\t/g, '  ').length;
      if (baseIndent === null) baseIndent = indent;
      items.push({ indent, ordered: /\d/.test(m[2]), text: m[3], cont: [] });
      i++;
    } else if (/^\s+\S/.test(line) && items.length) {
      items[items.length - 1].cont.push(line.trim());
      i++;
    } else break;
  }
  root.appendChild(buildList(items, baseIndent ?? 0));
  return i;
}

function buildList(items, baseIndent) {
  const firstBase = items.find(x => x.indent === baseIndent);
  const list = document.createElement(firstBase && firstBase.ordered ? 'ol' : 'ul');
  let k = 0;
  while (k < items.length) {
    const it = items[k];
    if (it.indent > baseIndent) { k++; continue; }
    const li = document.createElement('li');
    inlineInto(li, it.text);
    if (it.cont.length) {
      const div = document.createElement('div');
      div.className = 'li-cont';
      inlineInto(div, it.cont.join('\n'));
      li.appendChild(div);
    }
    let childEnd = k + 1;
    while (childEnd < items.length && items[childEnd].indent > baseIndent) childEnd++;
    if (childEnd > k + 1) {
      li.appendChild(buildList(items.slice(k + 1, childEnd), items[k + 1].indent));
      k = childEnd;
    } else k++;
    list.appendChild(li);
  }
  return list;
}

function buildTable(rows) {
  const splitRow = (r) => r.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
  const head = splitRow(rows[0]);
  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const trh = document.createElement('tr');
  for (const c of head) { const th = document.createElement('th'); inlineInto(th, c); trh.appendChild(th); }
  thead.appendChild(trh); table.appendChild(thead);
  const tbody = document.createElement('tbody');
  for (const r of rows.slice(1)) {
    const tr = document.createElement('tr');
    const cells = splitRow(r);
    for (let c = 0; c < head.length; c++) {
      const td = document.createElement('td');
      inlineInto(td, cells[c] || '');
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  return table;
}

// Inline: negrita, cursiva, tachado, código, enlaces y URLs sueltas.
function inlineInto(el, text) {
  const codes = [];
  let s = String(text).replace(/`([^`]+)`/g, (m, c) => { codes.push(c); return CODE_PH + (codes.length - 1) + CODE_PH; });

  const re = /(\*\*[^*]+\*\*|__[^_]+__|\*[^*\n]+\*|_[^_\n]+_|~~[^~]+~~|\[[^\]]+\]\([^)\s]+\)|https?:\/\/[^\s<"')\]]+)/g;
  let last = 0, m;
  const pushText = (t) => { if (t) el.appendChild(document.createTextNode(t)); };
  while ((m = re.exec(s))) {
    pushText(s.slice(last, m.index));
    const t = m[0];
    let mm;
    if ((mm = t.match(/^\*\*([^*]+)\*\*$/) || t.match(/^__([^_]+)__$/))) {
      const b = document.createElement('b'); inlineInto(b, mm[1]); el.appendChild(b);
    } else if ((mm = t.match(/^\*([^*\n]+)\*$/) || t.match(/^_([^_\n]+)_$/))) {
      const em = document.createElement('em'); inlineInto(em, mm[1]); el.appendChild(em);
    } else if ((mm = t.match(/^~~([^~]+)~~$/))) {
      const del = document.createElement('del'); del.textContent = mm[1]; el.appendChild(del);
    } else if ((mm = t.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/))) {
      const a = document.createElement('a');
      inlineInto(a, mm[1]);
      const href = mm[2];
      if (FILE_WHITELIST_CHECK(href)) { a.href = fileUrl(href) + '&dl=1'; }
      else if (/^(?:https?:|mailto:|#)/i.test(href)) { a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer'; }
      el.appendChild(a);
    } else if (/^https?:\/\//i.test(t)) {
      const a = document.createElement('a');
      a.href = t; a.target = '_blank'; a.rel = 'noopener'; a.textContent = t;
      el.appendChild(a);
    } else {
      pushText(t);
    }
    last = m.index + t.length;
  }
  pushText(s.slice(last));
  restoreCodePh(el, codes);
}

// Restaura los placeholders de código inline (también dentro de hijos).
function restoreCodePh(node, codes) {
  if (!codes.length) return;
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  const targets = [];
  while (walker.nextNode()) {
    if (walker.currentNode.nodeValue.includes(CODE_PH)) targets.push(walker.currentNode);
  }
  const re = new RegExp(CODE_PH + '(\\d+)' + CODE_PH);
  for (const tn of targets) {
    const parts = tn.nodeValue.split(re);
    const frag = document.createDocumentFragment();
    for (let k = 0; k < parts.length; k++) {
      if (k % 2 === 0) { if (parts[k]) frag.appendChild(document.createTextNode(parts[k])); }
      else { const c = document.createElement('code'); c.textContent = codes[+parts[k]] || ''; frag.appendChild(c); }
    }
    tn.parentNode.replaceChild(frag, tn);
  }
}

// ---------------------------------------------------------------------------
// Bubbles, lightbox, utils
// ---------------------------------------------------------------------------
function mkBubble(role) {
  const el = document.createElement('div');
  el.className = 'msg ' + role;
  const body = document.createElement('div');
  el.appendChild(body);
  return { el, body };
}

function addMsg(role, text) {
  const el = document.createElement('div');
  el.className = 'msg ' + role;
  el.textContent = text;
  $('messages').appendChild(el);
  scrollBottom();
}

function addRichMsg(role, text, ts) {
  const b = mkBubble(role);
  renderRich(b.body, text, { plain: role === 'user' });
  const meta = document.createElement('div');
  meta.className = 'meta';
  if (ts) meta.textContent = new Date(ts).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
  b.el.appendChild(meta);
  $('messages').appendChild(b.el);
  scrollBottom();
}

// ---------------------------------------------------------------------------
// Preguntas del agente (ask_user) y aceptaciones: lo que el bot pregunta y espera
// ---------------------------------------------------------------------------
const promptsVisible = () => Object.keys(state.questions).length + Object.keys(state.approvals).length;

function onQuestion(m) {
  if (!m.id || !Array.isArray(m.questions) && m.phase !== 'resolved') return;
  const scope = rk(m.agentId, m.id);
  if (JSON.stringify(state.questions[scope]) === JSON.stringify(m)) return;
  if (m.phase === 'resolved' || m.status && m.status !== 'pending') {
    for (const [key, item] of Object.entries(state.questions)) if (item.id === m.id && item.agentId === m.agentId) delete state.questions[key];
    forgetQuestionDraft(m.agentId, m.id);
  } else {
    state.questions[scope] = m;
  }
  renderPrompts();
  renderSessions();   // marcador ❓ en la lista
}

function onQuestionSnapshot(m) {
  if (!Array.isArray(m.ids)) return;
  const ids = new Set(m.ids);
  let changed = false;
  for (const [scope, question] of Object.entries(state.questions)) {
    if (question.agentId === m.agentId && !ids.has(question.id)) {
      delete state.questions[scope];
      forgetQuestionDraft(question.agentId, question.id);
      changed = true;
    }
  }
  if (changed) { renderPrompts(); renderSessions(); }
}

function onApproval(m) {
  const pending = (m.phase === 'pending' || m.status === 'pending');
  if (pending) state.approvals[m.id] = m;
  else delete state.approvals[m.id];
  renderPrompts();
  renderSessions();
}

// El aviso se pinta si es del agente que estás mirando, AUNQUE SEA DE OTRA SESIÓN:
// una pregunta que espera tu clic no puede esconderse porque tengas abierta otra
// (2026-10-01: el agente se quedaba bloqueado en ask_user y el panel parecía
// "trabajando"; el aviso solo se veía en la sesión que lo lanzó).
function forCurrentAgent(m) {
  if (!m.agentId) return true;
  return m.agentId === state.agent;
}

// Enlace a la sesión que origina el aviso, cuando no es la que tienes abierta.
function sessionSrcChip(item) {
  if (!item.sessionKey || item.sessionKey === state.current) return null;
  const s = state.sessions.find(x => x.key === item.sessionKey);
  const src = document.createElement('button');
  src.type = 'button';
  src.className = 'prompt-src';
  src.textContent = 'en: ' + (s ? sessionTitle(s) : 'otra sesión');
  src.title = 'Abrir la sesión que espera respuesta';
  src.addEventListener('click', () => { selectSession(item.sessionKey); });
  return src;
}

const AGENT_NAME = (id) => (state.agents.find(a => a.id === id)?.name) || id || 'agente';

function fmtCountdown(ms) {
  if (!ms) return '';
  const left = Math.round((ms - Date.now()) / 1000);
  if (left <= 0) return 'caducado';
  if (left < 60) return left + ' s';
  return Math.floor(left / 60) + ' min';
}

let pushPromptShown = false;
function renderPushPrompt(explicit = false) {
  if (pushPromptShown || !pushSupported()) return;
  if (Notification.permission !== 'default' && !explicit) return;
  try { if (!explicit && localStorage.getItem('hub.push.dismissed')) return; } catch {}
  pushPromptShown = true;
  const el = document.createElement('div');
  el.className = 'push-prompt compact-push'; el.setAttribute('role', 'region'); el.setAttribute('aria-label', 'Notificaciones de este dispositivo');
  const text = document.createElement('span');
  text.textContent = Notification.permission === 'granted' ? 'Avisos del sistema activados en este dispositivo.'
    : Notification.permission === 'denied' ? 'Notificaciones bloqueadas. Puedes permitirlas desde los ajustes del navegador.' : 'Recibe preguntas y permisos aunque cierres la app.';
  const actions = document.createElement('div');
  actions.className = 'push-actions';
  const yes = document.createElement('button');
  yes.className = 'send'; yes.textContent = 'Activar avisos';
  yes.addEventListener('click', async () => { el.remove(); await askPushPermission(); });
  const no = document.createElement('button');
  no.className = 'skip'; no.textContent = Notification.permission === 'default' ? 'Ahora no' : 'Cerrar';
  no.addEventListener('click', () => { el.remove(); try { localStorage.setItem('hub.push.dismissed', '1'); } catch {} });
  if (Notification.permission === 'default') actions.appendChild(yes);
  actions.appendChild(no); el.append(text, actions);
  // It is an optional sidebar preference, never an agent question that steals
  // the limited chat/prompt viewport or blocks the composer on a small screen.
  document.querySelector('.sidebar-foot')?.before(el);
}

function renderPrompts() {
  const box = $('prompts');
  renderPushPrompt();
  const items = [
    ...Object.values(state.approvals).filter(forCurrentAgent).map(a => ({ kind: 'approval', data: a })),
    ...Object.values(state.questions).filter(forCurrentAgent).map(q => ({ kind: 'question', data: q })),
  ].sort((x, y) => Number(y.data.sessionKey === state.current) - Number(x.data.sessionKey === state.current)
    || (x.data.createdAtMs || 0) - (y.data.createdAtMs || 0));
  const wanted = new Set();
  for (const [index, it] of items.entries()) {
    const key = it.kind + '|' + rk(it.data.agentId, it.data.id);
    wanted.add(key);
    const signature = JSON.stringify([it.data, state.current]);
    let card = [...box.children].find(child => child.dataset.promptKey === key);
    if (!card || card.dataset.signature !== signature) {
      const replacement = it.kind === 'approval' ? approvalCard(it.data) : questionCard(it.data);
      replacement.dataset.promptKey = key;
      replacement.dataset.signature = signature;
      if (card) card.replaceWith(replacement); else box.appendChild(replacement);
      card = replacement;
    }
    card.dataset.currentSession = String(!it.data.sessionKey || it.data.sessionKey === state.current);
    if (box.children[index] !== card) box.insertBefore(card, box.children[index] || null);
    if (it.kind === 'question') card.refreshQuestion?.();
  }
  for (const child of [...box.children]) if (child.dataset.promptKey && !wanted.has(child.dataset.promptKey)) child.remove();
  // Con una pregunta pendiente EN LA SESIÓN ABIERTA, el campo del chat se bloquea: si no hay
  // dos sitios donde escribir y no se sabe cuál responde a la pregunta. Una pregunta de OTRA
  // sesión se muestra con su enlace, pero no bloquea lo que estés escribiendo aquí.
  const hasQuestion = items.some(x => x.kind === 'question' && (!x.data.sessionKey || x.data.sessionKey === state.current));
  document.body.classList.toggle('prompt-open', hasQuestion);
  updateComposerState();
  renderRunStatus();
  renderQuestionAttention();
  if (items.length && state.pinned) scrollBottom();
}

function forgetQuestionDraft(agent, id) {
  const scope = rk(agent, id);
  questionDrafts.delete(scope);
  try { sessionStorage.removeItem(userStorageKey('hub.question-draft.' + scope)); } catch {}
}

function questionCard(q) {
  const scope = rk(q.agentId, q.id);
  const sensitive = q.questions.some(question => question.isSecret);
  let draft = questionDrafts.get(scope);
  if (!draft) {
    if (!sensitive) {
      try { draft = JSON.parse(sessionStorage.getItem(userStorageKey('hub.question-draft.' + scope)) || 'null'); } catch {}
    }
    draft = { picked: draft?.picked || {}, free: draft?.free || {} };
    questionDrafts.set(scope, draft);
  }
  const persist = () => {
    try {
      if (sensitive) sessionStorage.removeItem(userStorageKey('hub.question-draft.' + scope));
      else sessionStorage.setItem(userStorageKey('hub.question-draft.' + scope), JSON.stringify({ picked: draft.picked, free: draft.free }));
    } catch {}
  };
  const complete = () => {
    for (const [key, item] of Object.entries(state.questions)) if (item.agentId === q.agentId && item.id === q.id) delete state.questions[key];
    forgetQuestionDraft(q.agentId, q.id);
    renderPrompts(); renderSessions(); renderAgents();
  };
  return window.HubQuestions.create({
    request: { ...q, blocking: true }, draft, agentName: AGENT_NAME(q.agentId),
    sourceChip: sessionSrcChip(q), persist, countdown: fmtCountdown,
    settled: renderPrompts,
    submit: async answers => { await postQuestion('/api/question', { agent: q.agentId, id: q.id, answers }); complete(); },
    skip: async () => { await postQuestion('/api/question', { agent: q.agentId, id: q.id, cancel: true }); complete(); },
  });
}

async function postQuestion(endpoint, body) {
  let response;
  try {
    response = await hubFetch(endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(30000),
    });
  } catch (failure) {
    throw new Error(failure.name === 'TimeoutError' ? 'No llegó la confirmación. Tu respuesta sigue aquí para reintentar.' : 'Sin conexión. Tu respuesta sigue aquí para reintentar.');
  }
  let result;
  try { result = await response.json(); } catch { throw new Error('El servidor no confirmó la respuesta. Puedes reintentar.'); }
  if (!result || typeof result !== 'object') throw new Error('El servidor no confirmó la respuesta. Puedes reintentar.');
  if (!response.ok || result.error || result.ok !== true) throw new Error(result.error || 'El servidor no confirmó la respuesta. Puedes reintentar.');
  return result;
}

function asyncQuestionScope(agent, key, itemId, sourceSessionId) {
  return JSON.stringify([agent, key, sourceSessionId || null, itemId]);
}

// Optional Codex questions have no native cancellation RPC. A local dismissal
// must never masquerade as an answer, steer the agent or change another device.
function asyncDismissalKey() {
  return 'hub.async-dismissed.v1.' + JSON.stringify(state.user);
}

function readAsyncDismissals() {
  try {
    const saved = JSON.parse(localStorage.getItem(asyncDismissalKey()) || '[]');
    return new Set(Array.isArray(saved) ? saved.filter(scope => typeof scope === 'string' && scope.length <= 4096).slice(-300) : []);
  } catch { return new Set(); }
}

function setAsyncQuestionDismissed(question, dismissed) {
  const scopes = readAsyncDismissals();
  scopes.delete(question.scope);
  if (dismissed) scopes.add(question.scope);
  try { localStorage.setItem(asyncDismissalKey(), JSON.stringify([...scopes].slice(-300))); }
  catch { throw new Error('No se pudo guardar el cambio en este navegador. La pregunta conserva su estado anterior.'); }
  question.dismissed = dismissed;
  const saved = state.asyncQuestions[question.scope];
  if (saved) saved.dismissed = dismissed;
  renderQuestionAttention();
}

window.addEventListener('storage', event => {
  if (!state.user || event.storageArea !== localStorage || event.key !== null && event.key !== asyncDismissalKey()) return;
  const scopes = readAsyncDismissals();
  for (const question of Object.values(state.asyncQuestions)) {
    const dismissed = scopes.has(question.scope);
    if (question.dismissed === dismissed) continue;
    question.dismissed = dismissed;
    paintAsyncQuestion(question);
  }
  renderQuestionAttention();
});

function reconcileAsyncTranscript(agentId, sessionKey, sourceSessionId) {
  if (!agentId || !sessionKey || !sourceSessionId) return;
  const scope = rk(agentId, sessionKey);
  if (asyncTranscriptIds.has(scope) && asyncTranscriptIds.get(scope) !== sourceSessionId) bumpAsyncQuestionEpoch(scope);
  asyncQuestionInvalidations.delete(scope);
  asyncTranscriptIds.delete(scope); asyncTranscriptIds.set(scope, sourceSessionId);
  while (asyncTranscriptIds.size > 80) asyncTranscriptIds.delete(asyncTranscriptIds.keys().next().value);
  for (const question of Object.values(state.asyncQuestions)) {
    if (question.agentId !== agentId || question.sessionKey !== sessionKey || !question.sourceSessionId || question.sourceSessionId === sourceSessionId) continue;
    question.answerable = false;
    if (agentId === state.agent && sessionKey === state.current) paintAsyncQuestion(question);
  }
}

function syncAsyncHistory(agentId, sessionKey, result, preserveScroll = false) {
  const box = $('messages'), scrollTop = box.scrollTop, pinned = state.pinned;
  reconcileAsyncTranscript(agentId, sessionKey, result.sessionId);
  // Known questions can precede this history page. The optional snapshot carries
  // their positive native evidence; absence is never proof of an answer.
  const projections = [...(result.messages || []).map(message => message.asyncQuestion),
    ...(Array.isArray(result.asyncQuestions) ? result.asyncQuestions : [])];
  for (const projection of projections) {
    if (!projection || projection.sourceSessionId && result.sessionId && projection.sourceSessionId !== result.sessionId) continue;
    const question = rememberAsyncQuestion(agentId, sessionKey, projection);
    if (question) paintAsyncQuestion(question);
  }
  renderQuestionAttention();
  if (preserveScroll) { box.scrollTop = scrollTop; state.pinned = pinned; }
}

function bumpAsyncQuestionEpoch(scope) {
  asyncQuestionEpochs.set(scope, (asyncQuestionEpochs.get(scope) || 0) + 1);
}

function hasKnownPendingAsyncQuestions(agentId, sessionKey) {
  return Object.values(state.asyncQuestions).some(question => question.agentId === agentId && question.sessionKey === sessionKey && !question.answered && question.answerable !== false);
}

function refreshKnownAsyncQuestions() {
  const scopes = new Map();
  for (const question of Object.values(state.asyncQuestions)) {
    if (!question.answered && question.answerable !== false) scopes.set(rk(question.agentId, question.sessionKey), question);
  }
  for (const question of scopes.values()) refreshAsyncQuestionScope(question.agentId, question.sessionKey);
}

function refreshAsyncQuestionScope(agentId, sessionKey, force = false) {
  const socket = state.ws, user = state.user, scope = rk(agentId, sessionKey);
  if (!user || !agentId || !sessionKey || socket?.readyState !== WebSocket.OPEN) return;
  const running = asyncQuestionRefreshReads.get(scope);
  if (!force && running?.socket === socket && running.user === user) return;
  asyncQuestionRefreshQueue.set(scope, { agentId, sessionKey, socket, user });
  drainAsyncQuestionRefreshes();
}

function drainAsyncQuestionRefreshes() {
  // One first-page read per known conversation, coalesced and at most two in
  // flight. This never changes navigation, the composer or the loaded history.
  while (asyncQuestionRefreshReads.size < 2) {
    const next = [...asyncQuestionRefreshQueue].find(([scope]) => !asyncQuestionRefreshReads.has(scope));
    if (!next) return;
    const [scope, job] = next;
    asyncQuestionRefreshQueue.delete(scope);
    if (state.user !== job.user || state.ws !== job.socket || job.socket.readyState !== WebSocket.OPEN) continue;
    const epoch = asyncQuestionEpochs.get(scope), historyVersion = historyReadVersions.get(scope);
    const expected = asyncTranscriptIds.get(scope);
    const operation = (async () => {
      try {
        const query = new URLSearchParams({ agent: job.agentId, key: job.sessionKey, includeQuestions: '1' });
        const response = await hubFetch('/api/history-page?' + query, { cache: 'no-store', signal: AbortSignal.timeout(15000) });
        const result = await response.json();
        if (!response.ok || result?.error || !result?.sessionId || !Array.isArray(result.messages)
            || state.user !== job.user || state.ws !== job.socket || job.socket.readyState !== WebSocket.OPEN
            || asyncQuestionEpochs.get(scope) !== epoch || historyReadVersions.get(scope) !== historyVersion
            || asyncTranscriptIds.get(scope) !== expected) return;
        syncAsyncHistory(job.agentId, job.sessionKey, result, true);
      } catch { /* Missing confirmation preserves the last known state and drafts. */ }
    })();
    asyncQuestionRefreshReads.set(scope, { ...job, operation });
    operation.finally(() => {
      if (asyncQuestionRefreshReads.get(scope)?.operation === operation) asyncQuestionRefreshReads.delete(scope);
      drainAsyncQuestionRefreshes();
    });
  }
}

function invalidateAsyncSessionQuestions(message) {
  if (!message.agentId || !message.sessionKey || !['reset', 'new', 'delete'].includes(message.reason)) return;
  const known = Object.values(state.asyncQuestions).filter(question => question.agentId === message.agentId && question.sessionKey === message.sessionKey && !question.answered);
  if (!known.length) return;
  const scope = rk(message.agentId, message.sessionKey);
  bumpAsyncQuestionEpoch(scope);
  asyncQuestionInvalidations.add(scope);
  const box = $('messages'), scrollTop = box.scrollTop, pinned = state.pinned;
  for (const question of known) {
    if (message.reason !== 'delete' && message.sessionId && question.sourceSessionId === message.sessionId) continue;
    question.answerable = false;
    paintAsyncQuestion(question);
  }
  renderQuestionAttention();
  box.scrollTop = scrollTop; state.pinned = pinned;
  if (message.reason !== 'delete') refreshAsyncQuestionScope(message.agentId, message.sessionKey, true);
}

async function confirmAsyncQuestionTranscript(agentId, sessionKey, candidate) {
  const scope = rk(agentId, sessionKey);
  const candidateKey = JSON.stringify([candidate.sourceSessionId, candidate.itemId]);
  const existing = asyncHistoryReads.get(scope);
  if (existing) { existing.candidates.set(candidateKey, candidate); return; }
  const expected = asyncTranscriptIds.get(scope);
  const epoch = asyncQuestionEpochs.get(scope), user = state.user, socket = state.ws;
  const operation = fetchHistoryPage(agentId, sessionKey, { includeQuestions: 1 });
  const read = { operation, candidates: new Map([[candidateKey, candidate]]) };
  asyncHistoryReads.set(scope, read);
  try {
    const result = await operation;
    if (!result?.sessionId || !Array.isArray(result.messages) || asyncTranscriptIds.get(scope) !== expected
        || asyncQuestionEpochs.get(scope) !== epoch || state.user !== user || state.ws !== socket) return;
    syncAsyncHistory(agentId, sessionKey, result);
    for (const pending of read.candidates.values()) {
      if (pending.sourceSessionId !== result.sessionId) continue;
      const question = rememberAsyncQuestion(agentId, sessionKey, pending);
      if (question) paintAsyncQuestion(question);
    }
    renderQuestionAttention();
  } finally { if (asyncHistoryReads.get(scope) === read) asyncHistoryReads.delete(scope); }
}

function getAsyncQuestionDraft(scope) {
  if (!asyncQuestionDrafts.has(scope)) {
    let saved;
    try { saved = JSON.parse(sessionStorage.getItem(userStorageKey('hub.async-question.' + scope)) || 'null'); } catch {}
    asyncQuestionDrafts.set(scope, { picked: saved?.picked || {}, free: saved?.free || {}, answered: !!saved?.answered, answerSummary: saved?.answerSummary });
  }
  return asyncQuestionDrafts.get(scope);
}

function persistAsyncQuestion(scope) {
  const draft = asyncQuestionDrafts.get(scope);
  if (!draft) return;
  try { sessionStorage.setItem(userStorageKey('hub.async-question.' + scope), JSON.stringify({ picked: draft.picked, free: draft.free, answered: !!draft.answered, answerSummary: draft.answerSummary })); } catch {}
}

function rememberAsyncQuestion(agentId, sessionKey, asyncQuestion) {
  if (!agentId || !sessionKey || !asyncQuestion?.itemId || !Array.isArray(asyncQuestion.questions) || !asyncQuestion.questions.length) return null;
  const scope = asyncQuestionScope(agentId, sessionKey, asyncQuestion.itemId, asyncQuestion.sourceSessionId);
  const draft = getAsyncQuestionDraft(scope);
  const previous = state.asyncQuestions[scope];
  const sessionScope = rk(agentId, sessionKey), expected = asyncTranscriptIds.get(sessionScope);
  const obsolete = asyncQuestion.sourceSessionId && expected && asyncQuestion.sourceSessionId !== expected;
  const question = { ...previous, ...asyncQuestion, agentId, sessionKey, scope,
    dismissed: readAsyncDismissals().has(scope),
    answerable: asyncQuestion.answerable === true && (obsolete || asyncQuestionInvalidations.has(sessionScope)) ? false : asyncQuestion.answerable ?? previous?.answerable,
    answered: !!asyncQuestion.answered || !!previous?.answered || !!draft.answered };
  if (question.answered) { draft.answered = true; persistAsyncQuestion(scope); }
  state.asyncQuestions[scope] = question;
  return question;
}

function asyncQuestionCard(question) {
  const draft = getAsyncQuestionDraft(question.scope);
  const fields = question.questions.map((field, index) => ({
    id: String(index), question: field.title, options: (field.options || []).map(label => ({ label, reply: label })), isOther: true,
  }));
  const card = window.HubQuestions.create({
    request: { ...question, questions: fields, blocking: false }, draft,
    agentName: AGENT_NAME(question.agentId), persist: () => persistAsyncQuestion(question.scope),
    settled: () => {
      const saved = state.asyncQuestions[question.scope];
      if (saved) paintAsyncQuestion(saved);
      if (draft.dismissFocus) {
        delete draft.dismissFocus;
        const replacement = [...$('messages').querySelectorAll('[data-async-scope]')].find(node => node.dataset.asyncScope === question.scope);
        replacement?.querySelector(saved?.dismissed ? '.question-restore' : '.prompt-other, .prompt-opt')?.focus({ preventScroll: true });
      }
      setTimeout(flushDeferredFinalHistory, 0);
    },
    skip: () => { setAsyncQuestionDismissed(question, true); draft.dismissFocus = true; },
    restore: () => { setAsyncQuestionDismissed(question, false); draft.dismissFocus = true; },
    submit: async answersById => {
      const answers = fields.map(field => (answersById[field.id] || []).join('\n'));
      const result = await postQuestion('/api/async-question', { agent: question.agentId, key: question.sessionKey, itemId: question.itemId, sourceSessionId: question.sourceSessionId, answers });
      if (result.itemId !== question.itemId || result.sourceSessionId !== question.sourceSessionId) throw new Error('La confirmación no corresponde a esta pregunta. Tu respuesta se conserva.');
      const confirmedAnswers = result.alreadyAnswered ? undefined : answers;
      draft.answered = true; draft.answerSummary = confirmedAnswers;
      persistAsyncQuestion(question.scope);
      const saved = state.asyncQuestions[question.scope];
      if (saved) { saved.answered = true; saved.answers = confirmedAnswers; }
      paintAsyncQuestion(saved || { ...question, answered: true, answers: confirmedAnswers });
      renderQuestionAttention();
      if (question.agentId === state.agent) loadSessions();
    },
  });
  card.dataset.asyncItem = question.itemId;
  card.dataset.asyncScope = question.scope;
  card.dataset.asyncSignature = JSON.stringify([question.questions, question.answered || draft.answered, question.dismissed, question.answerable, question.answers, draft.answerSummary]);
  return card;
}

function paintAsyncQuestion(question) {
  if (question.agentId !== state.agent || question.sessionKey !== state.current) return;
  const box = $('messages');
  const existing = [...box.querySelectorAll('[data-async-scope]')].find(card => card.dataset.asyncScope === question.scope);
  if (!existing && question.answerable === false) return;
  const page = historyPages.get(rk(question.agentId, question.sessionKey));
  if (!existing && page?.focused && question.sourceSessionId !== page.sessionId) return;
  const replacement = asyncQuestionCard(question);
  if (existing?.dataset.asyncSignature === replacement.dataset.asyncSignature) { existing.refreshQuestion?.(); return; }
  if (existing) existing.replaceWith(replacement);
  else {
    const owner = question.sourceMessageId && [...box.querySelectorAll('[data-history-id]')].find(item => item.dataset.historyId === question.sourceMessageId);
    (owner?.querySelector('.md') || owner || box).appendChild(replacement);
  }
  if (state.pinned) scrollBottom();
}

function onAsyncQuestion(message) {
  const expected = asyncTranscriptIds.get(rk(message.agentId, message.sessionKey));
  if (message.asyncQuestion?.answerable === true && (asyncQuestionInvalidations.has(rk(message.agentId, message.sessionKey)) || expected && message.asyncQuestion.sourceSessionId !== expected)) {
    // HTTP-confirmed transcript identity outranks a delayed WebSocket frame.
    // A genuinely new transcript is admitted only after a fresh native read.
    confirmAsyncQuestionTranscript(message.agentId, message.sessionKey, message.asyncQuestion);
    return;
  }
  const question = rememberAsyncQuestion(message.agentId, message.sessionKey, message.asyncQuestion);
  if (!question) return;
  paintAsyncQuestion(question);
  renderQuestionAttention();
}

function renderKnownAsyncQuestions(box) {
  const page = historyPages.get(rk(state.agent, state.current));
  for (const question of Object.values(state.asyncQuestions)) {
    if (question.agentId !== state.agent || question.sessionKey !== state.current || question.answered || question.answerable === false) continue;
    if (page?.focused && question.sourceSessionId !== page.sessionId) continue;
    if (![...box.querySelectorAll('[data-async-scope]')].some(card => card.dataset.asyncScope === question.scope)) box.appendChild(asyncQuestionCard(question));
  }
}

function questionAttentionItems() {
  return [
    ...Object.values(state.questions).map(question => ({ ...question, kind: 'question' })),
    ...Object.values(state.approvals).map(approval => ({ ...approval, kind: 'approval' })),
    ...Object.values(state.asyncQuestions).filter(question => !question.answered && !question.dismissed && question.answerable !== false).map(question => ({ ...question, kind: 'async' })),
  ].sort((a, b) => (a.createdAtMs || 0) - (b.createdAtMs || 0));
}

let lastQuestionAnnouncement = '';
function renderQuestionAttention() {
  const items = questionAttentionItems();
  const button = $('btn-pending-questions');
  if (!button) return;
  button.classList.toggle('hidden', !items.length);
  button.querySelector('.pending-questions-label').innerHTML = String(items.length) + '<span class="pending-questions-word"> ' + (items.length === 1 ? 'pendiente' : 'pendientes') + '</span>';
  const pendingLabel = items.length === 1 ? '1 pregunta o permiso pendiente.' : items.length + ' preguntas o permisos pendientes.';
  button.setAttribute('aria-label', pendingLabel + (items.length === 1 ? ' Abrir la solicitud.' : ' Ver pendientes.'));
  button.title = pendingLabel;
  for (const chip of document.querySelectorAll('.agent-chip[data-agent-id]')) {
    const count = items.filter(item => item.agentId === chip.dataset.agentId).length;
    let badge = chip.querySelector('.a-pending');
    if (!count) { badge?.remove(); continue; }
    if (!badge) { badge = document.createElement('span'); badge.className = 'a-pending'; chip.appendChild(badge); }
    badge.textContent = String(count); badge.setAttribute('aria-label', count + (count === 1 ? ' pendiente' : ' pendientes'));
  }
  const announcement = items.length ? pendingLabel : '';
  if (announcement !== lastQuestionAnnouncement) {
    $('question-announcement').textContent = announcement || 'No quedan preguntas pendientes.';
    lastQuestionAnnouncement = announcement;
  }
  if ($('question-inbox')?.open) renderQuestionInbox(items);
}

function pendingItemKey(item) {
  return item.kind + '|' + (item.scope || rk(item.agentId, item.id));
}

function renderQuestionInbox(items = questionAttentionItems()) {
  const dialog = $('question-inbox'), list = $('question-inbox-list');
  if (!dialog || !list) return;
  if (!items.length) { dialog.close(); return; }
  const signature = JSON.stringify(items.map(item => [pendingItemKey(item), item.questions, item.presentation, item.agentId === state.agent && item.sessionKey === state.current]));
  if (list.dataset.signature === signature) return;
  const focusedKey = document.activeElement?.closest('[data-pending-key]')?.dataset.pendingKey;
  list.replaceChildren();
  for (const item of items) {
    const row = document.createElement('div'); row.setAttribute('role', 'listitem');
    const button = document.createElement('button'); button.type = 'button'; button.className = 'question-inbox-item'; button.dataset.pendingKey = pendingItemKey(item);
    const meta = document.createElement('span'); meta.className = 'question-inbox-meta';
    const name = document.createElement('span'); name.textContent = AGENT_NAME(item.agentId);
    const kind = document.createElement('span'); kind.className = 'question-inbox-kind'; kind.textContent = item.kind === 'async' ? 'Opcional' : item.kind === 'approval' ? 'Permiso' : 'Tu decisión';
    meta.append(name, kind);
    const title = document.createElement('span'); title.className = 'question-inbox-question';
    title.textContent = item.questions?.[0]?.question || item.questions?.[0]?.title || item.presentation?.commandText || 'Permiso solicitado por el agente';
    button.append(meta, title);
    const session = item.agentId === state.agent && state.sessions.find(session => session.key === item.sessionKey);
    const context = document.createElement('span'); context.className = 'question-inbox-context';
    context.textContent = item.agentId === state.agent && item.sessionKey === state.current ? 'En esta conversación' : session ? sessionTitle(session) : 'Abrir conversación';
    button.appendChild(context);
    button.addEventListener('click', () => { dialog.close(); openPendingQuestion(item).catch(() => toast('No se pudo abrir la conversación. La solicitud sigue pendiente.')); });
    row.appendChild(button); list.appendChild(row);
  }
  list.dataset.signature = signature;
  if (focusedKey) [...list.querySelectorAll('button')].find(button => button.dataset.pendingKey === focusedKey)?.focus({ preventScroll: true });
}

async function openPendingQuestion(item) {
  // Resolve again: a different client may have answered while the inbox was open.
  item = questionAttentionItems().find(candidate => pendingItemKey(candidate) === pendingItemKey(item));
  if (!item) return;
  if (item.agentId !== state.agent) await selectAgent(item.agentId, item.sessionKey || null);
  else if (item.sessionKey && (item.sessionKey !== state.current || (item.kind === 'async' && historyPages.get(rk(state.agent, state.current))?.focused))) await selectSession(item.sessionKey);
  if (isMobile()) closeNav();
  if (item.kind === 'async') renderKnownAsyncQuestions($('messages'));
  const card = item.kind === 'async'
    ? [...$('messages').querySelectorAll('[data-async-scope]')].find(node => node.dataset.asyncScope === item.scope)
    : [...$('prompts').children].find(node => node.dataset.promptKey === item.kind + '|' + rk(item.agentId, item.id));
  if (card) {
    card.tabIndex = -1;
    card.focus({ preventScroll: true });
    card.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  }
}

$('btn-pending-questions')?.addEventListener('click', () => {
  const items = questionAttentionItems();
  if (items.length === 1) { openPendingQuestion(items[0]).catch(() => toast('No se pudo abrir la conversación. La solicitud sigue pendiente.')); return; }
  if (!items.length) return;
  renderQuestionInbox(items);
  $('question-inbox').showModal();
});
$('question-inbox-close')?.addEventListener('click', () => $('question-inbox').close());
$('question-inbox')?.addEventListener('click', event => {
  if (event.target !== event.currentTarget) return;
  const rect = event.currentTarget.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) event.currentTarget.close();
});

function approvalCard(a) {
  const el = document.createElement('div');
  el.className = 'prompt approval';
  const head = document.createElement('div');
  head.className = 'prompt-head';
  head.innerHTML = `<span class="who">🔐 ${esc(AGENT_NAME(a.agentId))} pide permiso para ${esc(a.kind === 'exec' ? 'ejecutar un comando' : 'una acción')}</span>`
    + (a.expiresAtMs ? `<span class="clock" data-exp="${a.expiresAtMs}">⏳ ${fmtCountdown(a.expiresAtMs)}</span>` : '');
  const aSrc = sessionSrcChip(a);
  if (aSrc) head.insertBefore(aSrc, head.querySelector('.clock'));
  el.appendChild(head);

  const q = document.createElement('div');
  q.className = 'prompt-q';
  q.textContent = a.title || (a.kind === 'exec' ? 'El agente quiere ejecutar un comando' : 'El agente quiere hacer una acción');
  el.appendChild(q);
  if (a.detail && a.detail !== a.title) {
    const d = document.createElement('div');
    d.className = 'prompt-detail';
    d.textContent = a.detail;
    el.appendChild(d);
  }

  const actions = document.createElement('div');
  actions.className = 'prompt-actions';
  const mk = (label, decision, cls) => {
    const b = document.createElement('button');
    b.className = cls;
    b.textContent = label;
    b.addEventListener('click', async () => {
      actions.querySelectorAll('button').forEach(x => x.disabled = true);
      const r = await hubFetch('/api/approval', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent: a.agentId, id: a.id, kind: a.kind || 'exec', decision }),
      }).then(r => r.json()).catch(() => ({ error: 'sin conexión' }));
      if (r.error) { toast('No se pudo responder: ' + r.error); actions.querySelectorAll('button').forEach(x => x.disabled = false); return; }
      toast(decision === 'deny' ? '🚫 Denegado' : '✅ Permitido');
      delete state.approvals[a.id];
      renderPrompts();
    });
    return b;
  };
  const allowed = a.allowed || ['allow-once', 'allow-always', 'deny'];
  if (allowed.includes('allow-once')) actions.appendChild(mk('✔ Permitir una vez', 'allow-once', 'allow'));
  // El alcance se dice: un permiso permanente sin extensión declarada es una trampa
  if (allowed.includes('allow-always')) {
    const b = mk('Permitir siempre (este comando)', 'allow-always', 'allow ghost');
    b.title = 'Queda autorizado este comando para este agente, sin volver a preguntar';
    actions.appendChild(b);
  }
  if (allowed.includes('deny')) {
    const b = mk('✕ Denegar', 'deny', 'deny');
    b.title = 'No se ejecuta';
    actions.appendChild(b);
  }
  el.appendChild(actions);
  const tip = document.createElement('div');
  tip.className = 'prompt-hint';
  tip.textContent = 'Si no decides nada, no se ejecuta (caduca en ' + (a.expiresAtMs ? fmtCountdown(a.expiresAtMs) : 'un rato') + ').';
  el.appendChild(tip);
  return el;
}

// El contador se refresca solo, SIN repintar la tarjeta: repintarla borraría lo
// que estés escribiendo en "Otra respuesta".
setInterval(() => {
  for (const el of document.querySelectorAll('.prompt .clock')) {
    const exp = Number(el.dataset.exp || 0);
    if (exp) el.textContent = '⏳ ' + fmtCountdown(exp);
  }
}, 1000);

// ---------------------------------------------------------------------------
// Copiar / seleccionar texto de una burbuja (long-press en táctil)
// ---------------------------------------------------------------------------
// En táctil la selección nativa está desactivada en las burbujas (se seleccionaba
// lo que pillara, cabecera incluida). El long-press abre un menú: copiar el
// mensaje entero de una vez, o entrar en modo selección y ajustar los tiradores.
const MENU = { el: null, timer: null, x: 0, y: 0 };

function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), 1800);
}

function closeMsgMenu() {
  if (MENU.el) MENU.el.classList.remove('menu-target');
  MENU.el = null;
  $('msg-menu').classList.add('hidden');
  $('scrim-menu').classList.add('hidden');
}

// Texto plano de una burbuja: el cuerpo, sin hora ni adornos de streaming.
function msgText(el) {
  const body = el.querySelector(':scope > div:not(.meta)') || el;
  const content = body.cloneNode(true);
  content.querySelectorAll('.ha-block-actions').forEach(node => node.remove());
  content.querySelectorAll('br').forEach(node => node.replaceWith(document.createTextNode('\n')));
  content.querySelectorAll('td,th').forEach(node => node.append('\t'));
  content.querySelectorAll('p,pre,li,blockquote,tr,h1,h2,h3,h4,h5,h6').forEach(node => node.append('\n'));
  const t = content.textContent || '';
  return t.replace(/\n{3,}/g, '\n\n').trim();
}

async function copyText(text, okMsg) {
  try {
    await navigator.clipboard.writeText(text);
    toast(okMsg);
  } catch {
    // Fallback para contextos sin API de portapapeles
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0;';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); toast(okMsg); } catch { toast('No se pudo copiar'); }
    ta.remove();
  }
}

function openMsgMenu(el, x, y) {
  MENU.el = el;
  MENU.openedAt = Date.now();
  const m = $('msg-menu');
  m.classList.remove('hidden');
  $('scrim-menu').classList.remove('hidden');
  // Anclado a la BURBUJA, no al dedo: debajo si cabe, si no encima, y siempre a
  // más de 24px del punto de contacto (si no, el propio gesto pulsa un botón).
  const r = m.getBoundingClientRect();
  const mr = el.getBoundingClientRect();
  const gap = 10;
  let top;
  if (mr.bottom + gap > y + 24 && mr.bottom + gap + r.height <= window.innerHeight - 8) top = mr.bottom + gap;
  else if (mr.top - gap - r.height > y - 24 && mr.top - gap - r.height > 8) top = mr.top - gap - r.height;
  else top = Math.min(y + 46, window.innerHeight - r.height - 8);
  const left = Math.max(8, Math.min(x - 20, window.innerWidth - r.width - 8));
  m.style.left = left + 'px';
  m.style.top = Math.max(8, Math.min(top, window.innerHeight - r.height - 8)) + 'px';
  // Marcar el mensaje sobre el que se actúa: sin esto no se sabe a cuál se refiere
  el.classList.add('menu-target');
  if (navigator.vibrate) { try { navigator.vibrate(12); } catch {} }
}

// Modo selección: solo esa burbuja es seleccionable y se selecciona entera para
// que aparezcan los tiradores; el usuario ajusta y copia lo que quiera.
function enterSelectMode(el) {
  document.querySelectorAll('.msg.selecting').forEach(x => x.classList.remove('selecting'));
  el.classList.add('selecting');
  document.body.classList.add('sel-mode');
  const body = el.querySelector(':scope > div:not(.meta)') || el;
  try {
    const range = document.createRange();
    range.selectNodeContents(body);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  } catch {}
  const bar = $('sel-bar');
  bar.classList.remove('hidden');
  // Cerca del texto seleccionado, no perdida arriba del todo
  const place = () => {
    const br = bar.getBoundingClientRect();
    const mr = el.getBoundingClientRect();
    const above = mr.top - br.height - 10;
    const top = above > 8 ? above : Math.min(mr.bottom + 10, window.innerHeight - br.height - 8);
    bar.style.left = Math.max(8, Math.min((window.innerWidth - br.width) / 2, window.innerWidth - br.width - 8)) + 'px';
    bar.style.top = Math.max(8, Math.min(top, window.innerHeight - br.height - 8)) + 'px';
  };
  place();
  requestAnimationFrame(place);   // re-medir con el ancho real ya maquetado
}

function exitSelectMode() {
  document.body.classList.remove('sel-mode');
  document.querySelectorAll('.msg.selecting').forEach(x => x.classList.remove('selecting'));
  $('sel-bar').classList.add('hidden');
  try { window.getSelection().removeAllRanges(); } catch {}
}

// El fondo que cierra el menú aparece justo bajo el dedo: sin esta guarda, el
// propio gesto que lo abre lo cerraba al levantar (el click acababa en el fondo).
$('scrim-menu').addEventListener('click', () => {
  if (Date.now() - (MENU.openedAt || 0) < 600) return;
  closeMsgMenu();
});
$('msg-menu').addEventListener('click', (e) => {
  // El gesto que abre el menú sigue "vivo" al levantar el dedo: sin esta guarda,
  // ese mismo toque activaba el botón que quedaba debajo. El menú se coloca lejos
  // del dedo, así que basta una ventana corta.
  if (Date.now() - (MENU.openedAt || 0) < 350) return;
  const act = e.target.closest('button')?.dataset.act;
  const el = MENU.el;
  if (act === 'copy' && el) { copyText(msgText(el), '📋 Mensaje copiado'); closeMsgMenu(); }
  else if (act === 'select' && el) { closeMsgMenu(); enterSelectMode(el); }
  else closeMsgMenu();
});
$('sel-bar').addEventListener('click', (e) => {
  const act = e.target.closest('button')?.dataset.act;
  if (act === 'copy-sel') {
    const sel = String(window.getSelection() || '').trim();
    const el = document.querySelector('.msg.selecting');
    copyText(sel || (el ? msgText(el) : ''), '📋 Copiado');
    if (sel) exitSelectMode();
  } else if (act === 'done') exitSelectMode();
});
// Estando en modo selección, el resto de la pantalla solo cierra el modo al tocar
// fuera de la burbuja (para no perder la selección sin querer).
document.addEventListener('touchstart', (e) => {
  if (!document.body.classList.contains('sel-mode')) return;
  if (e.target.closest('.msg.selecting') || e.target.closest('#sel-bar')) return;
  exitSelectMode();
}, { passive: true });

// Long-press sobre una burbuja -> menú
document.addEventListener('touchstart', (e) => {
  if (!coarsePointer() || e.touches.length !== 1) return;
  if (document.body.classList.contains('sel-mode')) return;
  // Embedded question fields and controls own their native touch/edit gestures.
  // The message menu must never cover a response while its text is being edited.
  if (e.target.closest?.('.async-question, button, input, textarea, select, a, summary, [contenteditable="true"]')) return;
  const el = e.target.closest && e.target.closest('.msg');
  if (!el || !el.closest('#messages')) return;
  const t = e.touches[0];
  clearTimeout(MENU.timer);
  MENU.sx = t.clientX; MENU.sy = t.clientY;
  MENU.timer = setTimeout(() => openMsgMenu(el, t.clientX, t.clientY), 480);
}, { passive: true });

document.addEventListener('touchmove', (e) => {
  if (!MENU.timer) return;
  const t = e.touches[0];
  // Si el dedo se mueve (scroll o arrastre), no era un long-press
  if (Math.abs(t.clientX - MENU.sx) > 8 || Math.abs(t.clientY - MENU.sy) > 8) {
    clearTimeout(MENU.timer);
    MENU.timer = null;
  }
}, { passive: true });
document.addEventListener('touchend', () => { clearTimeout(MENU.timer); MENU.timer = null; }, { passive: true });
document.addEventListener('touchcancel', () => { clearTimeout(MENU.timer); MENU.timer = null; }, { passive: true });

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (document.body.classList.contains('sel-mode')) exitSelectMode();
  else closeMsgMenu();
});

function lightbox(src) {
  $('lightbox-img').src = src;
  $('lightbox').classList.remove('hidden');
}
$('lightbox').addEventListener('click', () => $('lightbox').classList.add('hidden'));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('lightbox').classList.add('hidden'); });

function scrollBottom(force) {
  const box = $('messages');
  if (!force && !state.pinned) return;   // el usuario subió a leer/seleccionar: no lo movemos
  box.scrollTop = box.scrollHeight;
  if (force) state.pinned = true;
  updateLatestButton();
}
function updateLatestButton() {
  const box = $('messages'), button = $('btn-latest');
  if (!button) return;
  const focused = historyPages.get(rk(state.agent, state.current))?.focused;
  button.classList.toggle('hidden', !state.current || (!focused && (state.pinned || box.scrollHeight - box.clientHeight < 60)));
  button.textContent = focused ? '↓ Conversación actual' : '↓ Ir al último';
}
$('btn-latest').addEventListener('click', () => {
  if (historyPages.get(rk(state.agent, state.current))?.focused) selectSession(state.current);
  else scrollBottom(true);
});
// Si el usuario sube (p.ej. para seleccionar texto en móvil), dejamos de forzar
// el autoscroll; vuelve al bajar al fondo.
$('messages').addEventListener('scroll', () => {
  const box = $('messages');
  state.pinned = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  updateLatestButton();
}, { passive: true });

// Hay una selección activa dentro de la burbuja en streaming: re-renderizar ahora
// la destruiría (renderRich hace innerHTML=''), así que aplazamos.
function selectionInStreamBubble() {
  if (!state.streamBubble) return false;
  const sel = window.getSelection();
  return !!(sel && !sel.isCollapsed && state.streamBubble.el.contains(sel.anchorNode));
}
function scheduleStreamRender() {
  if (state.streamRenderTimer) return;
  state.streamRenderTimer = setTimeout(() => {
    state.streamRenderTimer = null;
    if (!state.streamBubble) return;
    if (selectionInStreamBubble()) { scheduleStreamRender(); return; }  // reintenta luego
    renderRich(state.streamBubble.body, state.streamText);
    setBubblePhase();
    scrollBottom();
  }, 150);   // throttle: como mucho ~7 re-renders/seg durante el stream
}

// Fit the visual viewport, not the layout viewport that Android may keep behind its keyboard.
(() => {
  const vv = window.visualViewport;
  const app = $('app'), panels = $('session-panels');
  let frame = null;
  const variable = (name, value) => {
    if (app.style.getPropertyValue(name) !== value) app.style.setProperty(name, value);
  };
  const outerHeight = node => {
    const style = getComputedStyle(node);
    if (style.display === 'none' || style.position === 'absolute' || style.position === 'fixed') return 0;
    return node.getBoundingClientRect().height + (parseFloat(style.marginTop) || 0) + (parseFloat(style.marginBottom) || 0);
  };
  const fit = () => {
    frame = null;
    if (!isMobile() && !coarsePointer()) {
      app.classList.remove('viewport-fit', 'viewport-compact');
      app.style.height = ''; app.style.transform = '';
      for (const name of ['--editor-max-height', '--session-panels-max-height', '--composer-extra-max-height', '--model-settings-max-height', '--question-editor-max-height']) app.style.removeProperty(name);
      autogrow(); return;
    }
    // Preserve normal browser magnification: pinching must not reflow the whole conversation.
    if (Math.abs((vv?.scale || 1) - 1) > 0.02) return;
    const height = Math.max(1, vv?.height || window.innerHeight);
    const input = $('input');
    // Read at execution time: a queued frame may belong to a newly selected conversation.
    const tailTolerance = Math.max(6, parseFloat(getComputedStyle(input).lineHeight) || 0);
    const followCaret = document.activeElement === input && input.selectionStart === input.value.length && input.selectionEnd === input.value.length && input.scrollHeight - input.clientHeight - input.scrollTop <= tailTolerance;
    app.classList.add('viewport-fit'); app.classList.toggle('viewport-compact', height <= 540);
    app.style.height = height + 'px';
    app.style.transform = vv?.offsetTop ? `translateY(${vv.offsetTop}px)` : '';
    variable('--composer-extra-max-height', Math.max(44, Math.min(68, Math.floor(height * 0.14))) + 'px');
    variable('--model-settings-max-height', Math.max(44, Math.floor(height * 0.20)) + 'px');
    variable('--question-editor-max-height', Math.max(46, Math.min(150, Math.floor(height * 0.24))) + 'px');
    const composer = $('composer');
    const fixed = [...$('main').children].filter(node => node !== panels && node !== $('messages') && node !== composer).reduce((total, node) => total + outerHeight(node), 0);
    const historyStyle = getComputedStyle($('messages'));
    const historyPadding = (parseFloat(historyStyle.paddingTop) || 0) + (parseFloat(historyStyle.paddingBottom) || 0);
    const questionOpen = document.body.classList.contains('prompt-open');
    const reserve = questionOpen ? 0 : Math.min(48, height * 0.12);
    const composerChrome = Math.max(0, outerHeight(composer) - composer.querySelector('.composer-row').getBoundingClientRect().height);
    const editorLimit = Math.max(46, Math.min(160, Math.floor(height * 0.32), height - fixed - composerChrome - historyPadding - reserve));
    variable('--editor-max-height', Math.floor(editorLimit) + 'px');
    autogrow();
    const panelLimit = Math.max(questionOpen ? 96 : 36, Math.min(height * 0.42, height - fixed - outerHeight(composer) - historyPadding - reserve));
    variable('--session-panels-max-height', Math.floor(panelLimit) + 'px');
    if (followCaret) input.scrollTop = input.scrollHeight;
    const focused = document.activeElement;
    if (panels?.contains(focused) && focused.matches('input, textarea')) focused.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    scrollBottom();
  };
  const schedule = () => { if (frame === null) frame = requestAnimationFrame(fit); };
  vv?.addEventListener('resize', schedule); vv?.addEventListener('scroll', schedule);
  window.addEventListener('resize', schedule); window.addEventListener('orientationchange', schedule);
  $('input').addEventListener('focus', schedule);
  $('input').addEventListener('input', schedule);
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
  const observed = new WeakSet();
  const observeLayout = () => {
    for (const node of [...$('main').children].filter(node => node !== $('messages'))) {
      if (!observed.has(node)) { observer?.observe(node); observed.add(node); }
    }
    schedule();
  };
  new MutationObserver(observeLayout).observe($('main'), { childList: true });
  observeLayout();
})();

function fmtK(n) {
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(n);
}

function fmtDate(ts) {
  if (!ts) return '';
  // Dentro de un grupo de día la fecha sobra: la lleva el separador. Solo la hora.
  return new Date(ts).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
}

// ---------------------------------------------------------------------------
// Buscador de sesiones: evento único (el input vive en el DOM), con debounce
// para no destruir/redibujar la lista en cada tecla (el móvil cierra el teclado)
// ---------------------------------------------------------------------------
let filterDebounce = null;
document.addEventListener('input', (e) => {
  if (e.target.id !== 's-filter') return;
  state.filter = e.target.value;
  clearTimeout(filterDebounce);
  sessionSearchVersion++;
  filterDebounce = setTimeout(() => { if (sessionSearchMode === 'messages') searchSessionMessages(); else renderSessions(); }, 300);
}, true);

// ---------------------------------------------------------------------------
// Sidebar redimensionable (solo PC): arrastrar el borde para agrandar/achicar,
// doble clic para restablecer. El ancho se guarda en localStorage.
// ---------------------------------------------------------------------------
(function initSidebarResize() {
  const sb = $('sidebar'), rz = $('sb-resizer');
  if (!sb || !rz) return;
  const KEY = 'hub.sbw', MIN = 200, MAX = 560;
  try {
    const saved = parseInt(localStorage.getItem(KEY), 10);
    if (saved >= MIN && saved <= MAX) sb.style.setProperty('--sbw', saved + 'px');
  } catch {}
  let dragging = false;
  rz.addEventListener('pointerdown', (e) => {
    if (isMobile()) return;
    dragging = true;
    rz.classList.add('active');
    document.body.classList.add('resizing');
    try { rz.setPointerCapture(e.pointerId); } catch {}
    e.preventDefault();
  });
  rz.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const w = Math.min(MAX, Math.max(MIN, e.clientX));
    sb.style.setProperty('--sbw', w + 'px');
  });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    rz.classList.remove('active');
    document.body.classList.remove('resizing');
    try {
      const w = Math.round(sb.getBoundingClientRect().width);
      if (w >= MIN && w <= MAX) localStorage.setItem(KEY, String(w));
    } catch {}
  };
  rz.addEventListener('pointerup', end);
  rz.addEventListener('pointercancel', end);
  rz.addEventListener('dblclick', () => {
    sb.style.removeProperty('--sbw');
    try { localStorage.removeItem(KEY); } catch {}
  });
})();

window.HubActivity?.init({
  copy: copyText,
  markdown: mdBlocks,
  openSession: (agentId, key) => agentId === state.agent ? selectSession(key) : selectAgent(agentId, key),
  onClearErrors: () => { state.errors = []; },
  onState: (snapshot, observed) => {
    if (snapshot.agentId !== state.agent || snapshot.sessionKey !== state.current) return;
    if (snapshot.connected && snapshot.hasActiveRun === true && observed?.active) {
      setRunning(snapshot.agentId, snapshot.sessionKey, true);
      if (observed.runId && RUN.key === snapshot.sessionKey) RUN.runId = observed.runId;
      if (observed.startedAt && Number.isFinite(Number(observed.startedAt))) RUN.startedAt = Number(observed.startedAt);
    } else if (isObservedIdle(snapshot.agentId, snapshot.sessionKey, observed)) {
      setRunning(snapshot.agentId, snapshot.sessionKey, false);
      if (state.streamBubble) {
        clearTimeout(state.streamRenderTimer); state.streamRenderTimer = null;
        if (!state.streamText.trim()) state.streamBubble.el.remove();
        else {
          if (!selectionInStreamBubble()) renderRich(state.streamBubble.body, state.streamText);
          state.streamBubble.el.classList.remove('streaming', 'thinking');
          if (observed.runId) state.streamBubble.el.dataset.runId = observed.runId;
        }
      }
      state.streamBubble = null; state.streamText = ''; clearLiveTools();
    }
    renderRunStatus();
  },
});
installSessionBrowseUI();
boot();
