// Chromium against shipped assets with inert, loopback-only APIs. No real accounts or Workshop mutations.
// The standalone module's documented app hooks are supplied by this fixture; the parent integrates app.js/index.html.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { WebSocketServer } from 'ws';

const require = createRequire(import.meta.url), express = require('express');
let chromium;
for (const candidate of [process.env.PLAYWRIGHT_MODULE, 'playwright-core', 'playwright-core'].filter(Boolean)) {
  try { chromium = require(candidate).chromium; break; } catch {}
}
if (!chromium) throw new Error('Set PLAYWRIGHT_MODULE to an installed playwright-core package.');
const assets = process.env.HUB_ASSET_DIR || new URL('../public/', import.meta.url).pathname;
const captureDir = process.env.HUB_CAPTURE_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'hub-skill-review-ui-'));
fs.mkdirSync(captureDir, { recursive: true });
const results = [], requests = [], external = [], browserErrors = [], otherWrites = [], chatSends = [], releases = new Set();
const check = (name, ok) => { results.push({ name, ok: !!ok }); console.log((ok ? 'PASS ' : 'FAIL ') + name); };
const key = agent => 'agent:main:skill-review-fixture-' + agent;
let account = 'reviewer';
const catalogs = [
  { id: 'primary', name: 'Primary', emoji: '🔨', role: 'Producto', enabled: true },
  { id: 'assistant', name: 'Assistant', emoji: '🧰', role: 'Operaciones', enabled: true },
  { id: 'public', name: 'Panel público', role: 'Cliente', enabled: false },
  { id: 'disabled', name: 'Sin permiso', role: 'Lectura', enabled: false },
];
const allowed = (user, agent) => user !== 'public-user' && !!catalogs.find(item => item.id === agent)?.enabled;
const supportPath = 'references/guía con espacios.md';
const supportText = '# Referencia literal\n\n<img src=x onerror="window.__skillExecuted=true">\n<script>window.__skillExecuted=true</script>\nFIN-ARCHIVO-EXACTO\n';
function proposal(id, overrides = {}) {
  return { id, name: 'fixture-' + id, title: 'Revisión de ' + id, description: 'Borrador sintético para revisar contenido, cambios y avisos sin tocar producción.',
    kind: 'create', status: 'pending', revisionHash: 'fixture:' + id + ':r1',
    goal: 'Verificar la revisión humana explícita de cada versión.', evidence: 'Fixture de Chromium.\nLa evidencia también se muestra como texto literal.',
    content: '---\nname: fixture-' + id + '\ndescription: Ensayo aislado\n---\n\n# Contenido completo\n\n<script>window.__skillExecuted=true</script>\n<img src=x onerror="window.__skillExecuted=true">\n' +
      Array.from({ length: 65 }, (_, n) => '\n' + (n + 1) + '. Revisar sin ejecutar ni truncar: ' + 'contenido literal y verificable. '.repeat(3)).join('') + '\nCONTENIDO-FINAL-' + id + '\n',
    diff: '--- original/SKILL.md\n+++ candidato/SKILL.md\n@@ -1,2 +1,3 @@\n-Texto anterior\n+<script>window.__skillExecuted=true</script>\n+' + 'Línea de diff exacta\n+'.repeat(30) + 'DIFF-FINAL-' + id + '\n',
    scanStatus: 'warning', scanFindings: [{ severity: 'warning', message: 'Aviso de prueba: revisar el alcance antes de aplicar.' }],
    supportFiles: [{ path: supportPath, bytes: Buffer.byteLength(supportText) }], canApply: true, blockedReason: '', ...overrides };
}
const stores = new Map();
function setStore(user, agent, items) { stores.set(user + '|' + agent, new Map(items.map(item => [item.id, item]))); }
function getStore(user, agent) { return stores.get(user + '|' + agent) || new Map(); }
setStore('reviewer', 'primary', ['alpha', 'beta', 'conflict', 'uncertain', 'badack'].map(id => proposal(id)).concat(proposal('blocked', { canApply: false, blockedReason: 'Bloqueada por el escáner; solo puede rechazarse.', scanStatus: 'blocked' })));
setStore('reviewer', 'assistant', [proposal('assistant-only')]);
setStore('reviewer-two', 'primary', [proposal('other-account')]);
setStore('reviewer-two', 'assistant', [proposal('other-assistant')]);
const plans = { list: [], inspect: [], decision: [] };
function hold(type, fields = {}) {
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const began = new Promise(resolve => { started = resolve; });
  releases.add(release);
  const plan = { ...fields, gate, started };
  plans[type].push(plan);
  return { began, release: () => { release(); releases.delete(release); } };
}
function take(type, agent, id) {
  const index = plans[type].findIndex(plan => (!plan.agent || plan.agent === agent) && (!plan.id || plan.id === id));
  return index < 0 ? {} : plans[type].splice(index, 1)[0];
}
const clone = value => structuredClone(value);
const app = express(); app.use(express.json());
app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
app.get('/api/branding', (req, res) => res.json({ name: 'Hub', version: 'skill-review-fixture' }));
app.get('/api/me', (req, res) => res.json({ user: account, name: 'Revisión de skills' }));
app.get('/api/agents', (req, res) => res.json({ agents: catalogs.map(item => ({ id: item.id, name: item.name, role: item.role, emoji: item.emoji, connected: true,
  skillsReviewEnabled: allowed(account, item.id), models: [{ id: 'fixture', ref: 'fixture/model', provider: 'fixture', name: 'Modelo sintético', thinkingLevels: ['low', 'high'] }] })) }));
app.get('/api/sessions', (req, res) => res.json({ sessions: [{ key: key(req.query.agent || 'primary'), label: 'Conversación de prueba', kind: 'session', updatedAt: Date.now(), hasActiveRun: false }], ownCount: 1 }));
app.get('/api/session-settings', (req, res) => res.json({ settings: { modelRef: 'fixture/model', modelProvider: 'fixture', model: 'model', thinkingLevel: 'high', thinkingLevels: ['low', 'high'] } }));
app.get('/api/history-page', (req, res) => res.json({ messages: Array.from({ length: 12 }, (_, n) => ({ id: 'm-' + n, role: 'assistant', text: 'Historial sintético que debe mantenerse intacto al revisar skills. '.repeat(4), ts: Date.now() - 10000 + n })), sessionId: 'fixture-transcript', offset: 0, hasMore: false, totalMessages: 12 }));
app.get('/api/run-status', (req, res) => res.json({ hasActiveRun: false }));
app.get('/api/activity', (req, res) => res.json({ snapshot: null }));
app.get('/api/artifacts', (req, res) => res.json({ artifacts: [] }));
app.get('/api/queue', (req, res) => res.json({ available: true, sessionId: 'fixture-transcript', items: [], queuedCount: 0, hasMore: false }));
app.get('/api/skill-proposals', async (req, res) => {
  const user = account, agent = String(req.query.agent), plan = take('list', agent);
  requests.push({ type: 'list', user, agent }); plan.started?.();
  if (!allowed(user, agent)) return res.status(403).json({ error: 'Forbidden fixture', code: 'FORBIDDEN' });
  const items = [...getStore(user, agent).values()].filter(item => !['applied', 'rejected'].includes(item.status));
  const body = clone({ agent, proposals: items.map(({ id, name, title, description, kind, status, revisionHash }) => ({ id, name, title, description, kind, status, revisionHash })), complete: true, ...plan.body });
  if (plan.gate) await plan.gate;
  if (plan.status) return res.status(plan.status).json({ error: 'Fallo de listado sintético', code: 'SYNTHETIC_LIST' });
  res.json(body);
});
app.get('/api/skill-proposal', async (req, res) => {
  const user = account, agent = String(req.query.agent), id = String(req.query.id), artifactPath = req.query.artifactPath;
  const plan = take('inspect', agent, id);
  requests.push({ type: 'inspect', user, agent, id, artifactPath }); plan.started?.();
  if (!allowed(user, agent)) return res.status(403).json({ error: 'Forbidden fixture', code: 'FORBIDDEN' });
  const item = getStore(user, agent).get(id);
  if (!item) return res.status(404).json({ error: 'No existe este borrador', code: 'NOT_FOUND' });
  const body = clone({ agent, proposal: { ...item, ...(artifactPath !== undefined ? { artifactPath, artifactContent: supportText } : {}), ...plan.proposal } });
  if (plan.gate) await plan.gate;
  if (plan.status) return res.status(plan.status).json({ error: 'Fallo de inspección sintético', code: 'SYNTHETIC_INSPECT' });
  res.json(body);
});
app.post('/api/skill-proposal-decision', async (req, res) => {
  const user = account, { agent, id, revisionHash, decision } = req.body, item = getStore(user, agent).get(id), plan = take('decision', agent, id);
  requests.push({ type: 'decision', user, ...clone(req.body) }); plan.started?.();
  if (!allowed(user, agent)) return res.status(403).json({ error: 'Forbidden fixture', code: 'FORBIDDEN' });
  if (!item || revisionHash !== item.revisionHash) return res.status(409).json({ error: 'El borrador cambió', code: 'REVISION_CHANGED' });
  if (plan.gate) await plan.gate;
  if (plan.mode === 'conflict') {
    item.revisionHash = 'fixture:' + id + ':r2'; item.content += '\nREVISION-NUEVA-REQUIERE-REVISIÓN\n';
    return res.status(409).json({ error: 'El borrador cambió', code: 'REVISION_CHANGED' });
  }
  if (plan.mode === 'unavailable') return res.status(503).json({ error: 'No llegó confirmación nativa', code: 'GATEWAY_UNAVAILABLE' });
  if (plan.mode === 'badack') return res.json({ ok: true, status: decision === 'apply' ? 'rejected' : 'applied' });
  if (plan.mode === 'badok') return res.json({ ok: false, status: decision === 'apply' ? 'applied' : 'rejected' });
  if (plan.mode === 'lost-ack-applied') { item.status = 'applied'; item.canApply = false; return res.status(503).json({ error: 'Confirmación perdida', code: 'ACK_LOST' }); }
  item.status = decision === 'apply' ? 'applied' : 'rejected'; item.canApply = false;
  res.json({ ok: true, status: item.status });
});
app.use('/api', (req, res) => { if (!['GET', 'HEAD'].includes(req.method)) otherWrites.push(req.method + ' ' + req.path); res.json({}); });
app.get('/', (req, res) => {
  let html = fs.readFileSync(path.join(assets, 'index.html'), 'utf8');
  html = html.replace(/<script\b[^>]*src=["'][^"']*skill-review\.js[^"']*["'][^>]*><\/script>/gi, '');
  if (!/href=["'][^"']*skill-review\.css/.test(html)) html = html.replace('</head>', '<link rel="stylesheet" href="skill-review.css"></head>');
  const hook = '<script>(()=>{const load=loadAgents;loadAgents=async function(...a){try{return await load(...a)}finally{window.HubSkillReview?.refresh()}};const select=selectAgent;selectAgent=function(...a){const result=select(...a);window.HubSkillReview?.refresh();return result}})();</script><script src="skill-review.js"></script>';
  res.set('Cache-Control', 'no-store').type('html').send(html.replace('</body>', hook + '</body>'));
});
app.use(express.static(assets));
const server = http.createServer(app), wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', socket => {
  socket.send(JSON.stringify({ type: 'hello', agents: catalogs.map(item => ({ id: item.id, connected: true })) }));
  socket.on('message', data => { const message = JSON.parse(String(data)); if (['send', 'question_answer'].includes(message.type)) chatSends.push(message); });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port;
const decisionCount = () => requests.filter(item => item.type === 'decision').length;
const listCount = () => requests.filter(item => item.type === 'list').length;
const shot = (page, name) => page.screenshot({ path: path.join(captureDir, name + '.png') });
const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
async function scope(page, agent, user) {
  await page.evaluate(({ agent, user }) => { if (user) state.user = user; state.agent = agent; void window.HubSkillReview.refresh(); }, { agent, user });
}
async function idle(page) { await page.waitForFunction(() => !document.querySelector('.hub-sr-refresh')?.disabled); await settle(page); }
async function choose(page, id) {
  await page.locator('.hub-sr-proposal[data-proposal-id="' + id + '"]').click();
  await page.locator('#skill-review-content').waitFor();
  await page.waitForFunction(() => !document.querySelector('#skill-review-confirm').disabled);
}
async function ready(page) {
  await page.goto(base);
  await page.waitForFunction(() => typeof state !== 'undefined' && state.agent && !state.historyLoading && state.ws?.readyState === 1 && window.HubSkillReview);
  await page.evaluate(() => closeNav()); await page.waitForTimeout(260);
  await page.waitForFunction(() => document.querySelector('#btn-skill-review .hub-sr-badge')?.textContent === '6');
}
async function makeContext(browser, options = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block', ...options });
  await context.route('**/*', route => { if (new URL(route.request().url()).origin === base) return route.continue(); external.push(route.request().url()); return route.abort(); });
  await context.addInitScript(({ height }) => {
    const nativeFetch = window.fetch.bind(window), nativeSetTimeout = window.setTimeout.bind(window);
    window.__skillTimerDelays = [];
    window.fetch = (url, init) => nativeFetch(url, window.__skillIgnoreAbort && String(url).startsWith('/api/skill-') ? { ...init, signal: undefined } : init);
    window.setTimeout = (callback, delay, ...args) => {
      if (delay === 45000) window.__skillTimerDelays.push(delay);
      return nativeSetTimeout(callback, window.__skillFastTimeout && delay === 20000 ? 90 : delay, ...args);
    };
    const values = { height, offsetTop: 0 };
    for (const field of Object.keys(values)) Object.defineProperty(visualViewport, field, { configurable: true, get: () => values[field] });
    window.fixtureKeyboard = changes => { Object.assign(values, changes); visualViewport.dispatchEvent(new Event('resize')); visualViewport.dispatchEvent(new Event('scroll')); };
  }, { height: options.viewport?.height || 1000 });
  return context;
}
function geometry(selector) {
  const node = document.querySelector(selector); if (!node) return null;
  const box = node.getBoundingClientRect(), x = box.x + box.width / 2, y = box.y + box.height / 2;
  const hit = document.elementFromPoint(x, y), vv = visualViewport;
  return { x, y, width: box.width, height: box.height, top: box.top, bottom: box.bottom,
    hit: hit === node || node.contains(hit), visible: box.top >= vv.offsetTop - 1 && box.bottom <= vv.offsetTop + vv.height + 1 && box.left >= vv.offsetLeft - 1 && box.right <= vv.offsetLeft + vv.width + 1,
    disabled: !!node.disabled };
}
async function tap(cdp, point) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: point.x, y: point.y }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}
async function swipe(page, cdp) {
  const box = await page.locator('.hub-sr-body').boundingBox(), x = box.x + 7, from = box.y + box.height - 8, to = box.y + 8;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: from }] });
  for (let n = 1; n <= 8; n++) {
    await new Promise(resolve => setTimeout(resolve, 16));
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: from + (to - from) * n / 8 }] });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await page.waitForTimeout(160);
}

let browser, page;
try {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || chromium.executablePath(), headless: true });
  const context = await makeContext(browser); page = await context.newPage(); page.setDefaultTimeout(7000);
  page.on('pageerror', error => browserErrors.push(error.message));
  await ready(page);
  check('pending proposals created before opening are visible in the header', await page.locator('#btn-skill-review').isVisible() && await page.locator('.hub-sr-badge').innerText() === '6');
  await page.reload();
  await page.waitForFunction(() => document.querySelector('.hub-sr-badge')?.textContent === '6');
  check('a reload restores existing pending proposals without a decision', decisionCount() === 0);
  await page.locator('#input').fill('Mi borrador del chat permanece intacto.\nSegunda línea.');
  await page.evaluate(() => { state.pinned = false; $('messages').scrollTop = 80; window.__skillChatScroll = $('messages').scrollTop; });
  const chatHistory = await page.locator('#messages').innerText();
  await page.locator('#btn-skill-review').click(); await idle(page); await shot(page, 'desktop-inbox');
  await choose(page, 'alpha'); await shot(page, 'desktop-proposal');
  check('desktop keeps the pending list beside the selected proposal without a mobile back control', await page.locator('.hub-sr-sidebar').isVisible() && await page.locator('.hub-sr-detail').isVisible() && !await page.locator('.hub-sr-back').isVisible());
  check('opening a proposal is read-only and both decisions need explicit review', decisionCount() === 0 && await page.locator('#skill-review-apply').isDisabled() && await page.locator('#skill-review-reject').isDisabled() && !await page.locator('#skill-review-confirm').isChecked());
  const alpha = getStore('reviewer', 'primary').get('alpha');
  check('complete candidate and full native diff are shown byte-for-byte as inert text', await page.locator('#skill-review-content').textContent() === alpha.content && await page.locator('#skill-review-diff').textContent() === alpha.diff && !await page.evaluate(() => window.__skillExecuted));
  check('scanner warnings, evidence and exact inspected revision remain visible', (await page.locator('#skill-review-scan').textContent()).includes('Aviso de prueba') && await page.locator('#skill-review-evidence').textContent() === alpha.evidence && (await page.locator('#skill-review-revision').textContent()).includes(alpha.revisionHash));
  await page.locator('.hub-sr-file').click();
  await page.locator('#skill-review-artifact:not([hidden])').waitFor();
  check('support files are fetched by exact artifactPath and displayed literally', requests.at(-1).artifactPath === supportPath && await page.locator('#skill-review-artifact').textContent() === supportText && !await page.evaluate(() => window.__skillExecuted));
  await page.locator('#skill-review-artifact').scrollIntoViewIfNeeded(); await shot(page, 'desktop-review');
  await page.locator('#skill-review-confirm').check();
  await page.evaluate(() => { window.__skillReading = $('skill-review-content'); window.__skillReading.focus(); document.querySelector('.hub-sr-body').scrollTop = 430; window.__skillReadingScroll = document.querySelector('.hub-sr-body').scrollTop; });
  await page.evaluate(() => window.HubSkillReview.refresh());
  check('background refresh preserves the inspected DOM, focus, reading position and confirmation', await page.evaluate(() => window.__skillReading === $('skill-review-content') && document.activeElement === window.__skillReading && Math.abs(document.querySelector('.hub-sr-body').scrollTop - window.__skillReadingScroll) < 2 && $('skill-review-confirm').checked));
  await page.locator('#skill-review-apply').click();
  await page.waitForFunction(() => document.querySelector('#skill-review-action-message')?.textContent.startsWith('Skill aceptada.'));
  const applied = requests.filter(item => item.type === 'decision').at(-1);
  check('accept sends only the explicitly reviewed identity, hash and apply decision', JSON.stringify({ agent: applied.agent, id: applied.id, revisionHash: applied.revisionHash, decision: applied.decision }) === JSON.stringify({ agent: 'primary', id: 'alpha', revisionHash: alpha.revisionHash, decision: 'apply' }));
  await idle(page); await choose(page, 'beta'); await page.locator('#skill-review-confirm').check(); await page.locator('#skill-review-reject').click();
  await page.waitForFunction(() => document.querySelector('#skill-review-action-message')?.textContent.startsWith('Propuesta rechazada.'));
  const rejected = requests.filter(item => item.type === 'decision').at(-1);
  check('reject carries the inspected revision and never defaults to apply', rejected.id === 'beta' && rejected.decision === 'reject' && rejected.revisionHash === 'fixture:beta:r1');
  check('skill decisions do not touch chat history, draft, questions or navigation', await page.locator('#input').inputValue() === 'Mi borrador del chat permanece intacto.\nSegunda línea.' && await page.locator('#messages').innerText() === chatHistory && await page.evaluate(() => state.agent === 'primary' && $('messages').scrollTop === window.__skillChatScroll));
  await page.evaluate(() => { window.__skillEscapesBehindDialog = 0; document.addEventListener('keydown', event => { if (event.key === 'Escape') window.__skillEscapesBehindDialog++; }); });
  await page.keyboard.press('Escape');
  check('Escape closes the dialog and returns keyboard focus to Skills', !await page.locator('#skill-review-dialog').isVisible() && await page.evaluate(() => document.activeElement === $('btn-skill-review') && window.__skillEscapesBehindDialog === 0));
  await page.locator('#btn-skill-review').click(); await choose(page, 'blocked');
  await page.locator('#skill-review-confirm').check();
  check('a blocked draft explains why apply is unavailable but permits explicit rejection', await page.locator('#skill-review-apply').isDisabled() && await page.locator('#skill-review-reject').isEnabled() && (await page.locator('#skill-review-scan').innerText()).includes('Bloqueada por el escáner'));

  getStore('reviewer', 'primary').set('obsolete', proposal('obsolete'));
  await page.evaluate(() => window.HubSkillReview.refresh());
  getStore('reviewer', 'primary').get('obsolete').status = 'stale';
  await page.locator('.hub-sr-proposal[data-proposal-id="obsolete"]').click();
  await page.locator('#skill-review-meta').filter({ hasText: 'Obsoleta' }).waitFor();
  await settle(page);
  check('a stale native proposal is read-only, never another pending decision', await page.locator('#skill-review-confirm').isDisabled() && await page.locator('#skill-review-apply').isDisabled() && await page.locator('#skill-review-reject').isDisabled());

  getStore('reviewer', 'primary').set('incomplete', proposal('incomplete', { content: null, diff: '', canApply: false, blockedReason: 'No está disponible el borrador completo.' }));
  await page.evaluate(() => window.HubSkillReview.refresh()); await choose(page, 'incomplete'); await page.locator('#skill-review-confirm').check();
  check('an unavailable candidate shows its blocking reason, preserves an empty literal diff and cannot be accepted', await page.locator('#skill-review-apply').isDisabled() && await page.locator('#skill-review-reject').isEnabled() && (await page.locator('#skill-review-scan').innerText()).includes('No está disponible') && await page.locator('#skill-review-diff').textContent() === '');

  plans.decision.push({ id: 'conflict', mode: 'conflict' });
  await choose(page, 'conflict'); const beforeConflict = decisionCount();
  await page.locator('#skill-review-confirm').check(); await page.locator('#skill-review-apply').click();
  await page.waitForFunction(() => document.querySelector('#skill-review-content')?.textContent.includes('REVISION-NUEVA-REQUIERE-REVISIÓN'));
  await page.waitForFunction(() => !document.querySelector('#skill-review-confirm').disabled);
  check('409 re-inspects the new revision without repeating the mutation or confirmation', decisionCount() === beforeConflict + 1 && !await page.locator('#skill-review-confirm').isChecked() && await page.locator('#skill-review-apply').isDisabled() && (await page.locator('#skill-review-revision').textContent()).includes(':r2'));
  await page.locator('#skill-review-confirm').check(); await page.locator('#skill-review-apply').click();
  await page.waitForFunction(() => document.querySelector('#skill-review-action-message')?.textContent.startsWith('Skill aceptada.'));
  check('the next human click after conflict uses the freshly inspected hash', requests.filter(item => item.type === 'decision').at(-1).revisionHash === 'fixture:conflict:r2');

  await choose(page, 'uncertain'); plans.decision.push({ id: 'uncertain', mode: 'unavailable' });
  const beforeUncertain = decisionCount(), readsBeforeUncertain = requests.filter(item => item.type === 'inspect').length;
  await page.locator('#skill-review-confirm').check(); await page.locator('#skill-review-reject').click();
  await page.waitForFunction(() => document.querySelector('#skill-review-action-message')?.textContent.includes('No se reintentará automáticamente'));
  await page.waitForTimeout(220);
  check('503 performs read-only status reconciliation, never retries or invents success', decisionCount() === beforeUncertain + 1 && requests.filter(item => item.type === 'inspect').length > readsBeforeUncertain && await page.locator('#skill-review-apply').isDisabled() && await page.locator('#skill-review-reject').isDisabled() && await page.locator('.hub-sr-reinspect').isVisible() && !await page.locator('#skill-review-action-message').evaluate(node => node.classList.contains('hub-sr-success')));
  await page.locator('.hub-sr-reinspect').click(); await page.waitForFunction(() => !document.querySelector('#skill-review-confirm').disabled);
  check('after uncertainty, a new inspection still requires a fresh explicit review', !await page.locator('#skill-review-confirm').isChecked() && await page.locator('#skill-review-reject').isDisabled());
  const timeoutGate = hold('decision', { id: 'uncertain', mode: 'unavailable' });
  await page.evaluate(() => { window.__skillFastTimeout = true; });
  await page.locator('#skill-review-confirm').check(); await page.locator('#skill-review-apply').click(); await timeoutGate.began;
  await page.waitForFunction(() => document.querySelector('#skill-review-action-message')?.textContent.includes('No se reintentará automáticamente'));
  await page.evaluate(() => { window.__skillFastTimeout = false; }); timeoutGate.release();
  await page.waitForTimeout(150);
  check('a timed-out mutation also requires status review and is never automatically repeated', decisionCount() === beforeUncertain + 2 && await page.locator('#skill-review-apply').isDisabled());

  await choose(page, 'badack'); plans.decision.push({ id: 'badack', mode: 'badack' });
  await page.locator('#skill-review-confirm').check(); await page.locator('#skill-review-apply').click();
  await page.waitForFunction(() => document.querySelector('#skill-review-action-message')?.textContent.includes('No se reintentará automáticamente'));
  check('HTTP 200 and ok:true with the wrong status never claim successful application', await page.locator('#skill-review-apply').isDisabled() && !await page.locator('#skill-review-action-message').evaluate(node => node.classList.contains('hub-sr-success')) && await page.locator('.hub-sr-proposal[data-proposal-id="badack"]').count() === 1);

  await choose(page, 'badack'); plans.decision.push({ id: 'badack', mode: 'badok' });
  await page.locator('#skill-review-confirm').check(); await page.locator('#skill-review-apply').click();
  await page.waitForFunction(() => document.querySelector('#skill-review-action-message')?.textContent.includes('No se reintentará automáticamente'));
  check('the expected status without ok:true is not a positive acknowledgement', await page.locator('#skill-review-apply').isDisabled() && !await page.locator('#skill-review-action-message').evaluate(node => node.classList.contains('hub-sr-success')));

  getStore('reviewer', 'primary').set('lost-ack', proposal('lost-ack')); await page.evaluate(() => window.HubSkillReview.refresh()); await choose(page, 'lost-ack');
  plans.decision.push({ id: 'lost-ack', mode: 'lost-ack-applied' }); const beforeLostAck = decisionCount();
  await page.locator('#skill-review-confirm').check(); await page.locator('#skill-review-apply').click();
  await page.waitForFunction(() => document.querySelector('#skill-review-action-message')?.textContent.startsWith('Estado actual consultado: aplicada.'));
  check('lost acknowledgements can show the authoritative current state without claiming the original request succeeded', decisionCount() === beforeLostAck + 1 && await page.locator('#skill-review-apply').isDisabled() && !await page.locator('#skill-review-action-message').evaluate(node => node.classList.contains('hub-sr-success')) && (await page.locator('#skill-review-selection-notice').textContent()).includes('ACK_LOST'));

  await idle(page); const countBeforeError = await page.locator('.hub-sr-badge').innerText();
  plans.list.push({ status: 503 }); await page.evaluate(() => window.HubSkillReview.refresh());
  check('list errors remain visible and preserve the last authoritative pending count', await page.locator('.hub-sr-badge').innerText() === countBeforeError && await page.locator('#btn-skill-review').getAttribute('data-error') === 'true' && (await page.locator('#skill-review-list-status').innerText()).includes('SYNTHETIC_LIST') && await page.locator('.hub-sr-proposal').count() === Number(countBeforeError));
  plans.list.push({ body: { proposals: [], complete: false } }); await page.evaluate(() => window.HubSkillReview.refresh());
  check('an incomplete empty response is not evidence of zero pending proposals', await page.locator('.hub-sr-badge').innerText() === countBeforeError && (await page.locator('#skill-review-list-status').innerText()).includes('incompleta'));
  await page.evaluate(() => window.HubSkillReview.refresh());
  await choose(page, 'badack'); await page.locator('#skill-review-confirm').check();
  const oldContent = await page.locator('#skill-review-content').textContent();
  getStore('reviewer', 'primary').get('badack').revisionHash = 'fixture:badack:r2';
  getStore('reviewer', 'primary').get('badack').content += '\nCAMBIO-EN-SEGUNDO-PLANO\n';
  await page.evaluate(() => window.HubSkillReview.refresh());
  check('a changed background revision invalidates decisions without replacing the text being read', await page.locator('#skill-review-content').textContent() === oldContent && await page.locator('#skill-review-apply').isDisabled() && !await page.locator('#skill-review-confirm').isChecked() && await page.locator('.hub-sr-reinspect').isVisible());

  await idle(page); const beforeSharedRead = listCount(); const sharedRead = hold('list', { agent: 'primary' });
  await page.evaluate(() => { void window.HubSkillReview.refresh(); void window.HubSkillReview.refresh(); void window.HubSkillReview.refresh(); }); await sharedRead.began;
  check('overlapping refresh calls share a single list request rather than forming a loop', listCount() === beforeSharedRead + 1); sharedRead.release(); await idle(page);

  const beforePageshow = listCount(); await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))); await idle(page);
  check('pageshow triggers a read-only refresh', listCount() > beforePageshow);
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); });
  const hiddenReads = listCount(); await page.waitForTimeout(60);
  check('background visibility does not poll or issue a mutation', listCount() === hiddenReads);
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' }); document.dispatchEvent(new Event('visibilitychange')); }); await idle(page);
  check('foreground visibility refreshes and the scheduled interval is 45 seconds', listCount() > hiddenReads && await page.evaluate(() => window.__skillTimerDelays.includes(45000)));

  // Non-cooperative fetches deliberately ignore abort, so the generation guards, not cancellation, must protect the new scope.
  await page.evaluate(() => { window.__skillIgnoreAbort = true; });
  const lateList = hold('list', { agent: 'primary' });
  await page.evaluate(() => { void window.HubSkillReview.refresh(); }); await lateList.began;
  await scope(page, 'assistant'); await page.waitForFunction(() => document.querySelector('.hub-sr-badge')?.textContent === '1');
  lateList.release(); await page.waitForTimeout(130);
  check('late old-agent lists cannot repaint or reopen another agent review', await page.locator('.hub-sr-badge').innerText() === '1' && await page.locator('#skill-review-dialog').count() === 0);

  await scope(page, 'primary'); await page.locator('#btn-skill-review').click(); await idle(page);
  const lateInspect = hold('inspect', { agent: 'primary', id: 'badack' });
  await page.locator('.hub-sr-proposal[data-proposal-id="badack"]').click(); await lateInspect.began;
  account = 'reviewer-two'; await scope(page, 'primary', account);
  await page.waitForFunction(() => document.querySelector('.hub-sr-badge')?.textContent === '1'); lateInspect.release(); await page.waitForTimeout(130);
  await page.locator('#btn-skill-review').click(); await idle(page);
  check('late old-account inspections are discarded even when the agent id is unchanged', await page.locator('.hub-sr-proposal[data-proposal-id="other-account"]').count() === 1 && await page.locator('#skill-review-content').count() === 0 && !(await page.locator('#skill-review-dialog').innerText()).includes('badack'));

  account = 'reviewer'; await scope(page, 'primary', account); await page.locator('#btn-skill-review').click(); await idle(page); await choose(page, 'badack');
  const lateDecision = hold('decision', { agent: 'primary', id: 'badack' });
  await page.locator('#skill-review-confirm').check(); await page.locator('#skill-review-apply').click(); await lateDecision.began;
  account = 'reviewer-two'; await scope(page, 'assistant', account);
  await page.waitForFunction(() => document.querySelector('.hub-sr-badge')?.textContent === '1'); lateDecision.release(); await page.waitForTimeout(130);
  await page.locator('#btn-skill-review').click(); await idle(page);
  check('late action acknowledgements cannot remove or announce success in a new user/agent scope', await page.locator('.hub-sr-proposal[data-proposal-id="other-assistant"]').count() === 1 && !(await page.locator('#skill-review-dialog').innerText()).includes('Skill aceptada.'));

  await page.evaluate(() => { state.agents.find(agent => agent.id === state.agent).skillsReviewEnabled = false; return window.HubSkillReview.refresh(); });
  check('capability revocation closes the modal and clears every review surface', await page.locator('#btn-skill-review, #skill-review-dialog').count() === 0);
  const beforeUnauthorized = requests.length; await scope(page, 'disabled');
  check('an unauthorized agent exposes no trigger, content or API request', await page.locator('#btn-skill-review, #skill-review-dialog').count() === 0 && requests.length === beforeUnauthorized);
  await scope(page, 'primary'); await page.waitForFunction(() => document.querySelector('.hub-sr-badge')?.textContent === '1');
  plans.list.push({ agent: 'primary', status: 403 }); await page.evaluate(() => window.HubSkillReview.refresh());
  check('an authoritative 403 fails closed despite stale allowed catalog metadata', await page.locator('#btn-skill-review, #skill-review-dialog').count() === 0);
  await page.evaluate(() => loadAgents()); await page.waitForFunction(() => document.querySelector('.hub-sr-badge')?.textContent === '1'); await page.locator('#btn-skill-review').click(); await idle(page);
  await page.evaluate(() => { state.user = null; showLogin(); });
  await page.waitForFunction(() => !document.querySelector('#btn-skill-review, #skill-review-dialog'));
  check('auth expiry clears top-layer proposal content immediately without a navigation hook', await page.locator('#btn-skill-review, #skill-review-dialog').count() === 0);
  account = 'public-user'; await page.reload(); await page.waitForFunction(() => typeof state !== 'undefined' && state.user === 'public-user' && state.agent && !state.historyLoading);
  const beforePublic = requests.length; await page.evaluate(() => window.HubSkillReview.refresh());
  check('public tenants expose no skill review UI and perform no Workshop read', await page.locator('#btn-skill-review, #skill-review-dialog').count() === 0 && requests.length === beforePublic);
  await context.close();

  account = 'reviewer';
  for (const size of [ { id: 'mobile-320', width: 320, height: 700 }, { id: 'mobile-360', width: 360, height: 780 }, { id: 'mobile-390', width: 390, height: 844 }, { id: 'keyboard-320', width: 320, height: 700, visualHeight: 300, offsetTop: 30 }, { id: 'keyboard-390', width: 390, height: 844, visualHeight: 340, offsetTop: 30 }, { id: 'landscape', width: 844, height: 390 } ]) {
    const id = 'touch-' + size.id; setStore('reviewer', 'primary', [proposal(id)]);
    const mobile = await makeContext(browser, { viewport: { width: size.width, height: size.height }, isMobile: true, hasTouch: true });
    const tab = await mobile.newPage(); tab.setDefaultTimeout(7000); tab.on('pageerror', error => browserErrors.push(size.id + ': ' + error.message));
    const cdp = await mobile.newCDPSession(tab);
    try {
      await tab.goto(base); await tab.waitForFunction(() => typeof state !== 'undefined' && state.agent && !state.historyLoading && document.querySelector('.hub-sr-badge')?.textContent === '1');
      await tab.evaluate(() => { closeNav(); $('btn-pending-questions').classList.remove('hidden'); $('btn-pending-questions').querySelector('.pending-questions-label').textContent = '2'; }); await tab.waitForTimeout(270);
      const header = await tab.evaluate(geometry, '#btn-skill-review');
      check(size.id + ': Skills remains discoverable and touchable beside existing header controls', header.hit && header.visible && header.height >= 44 && await tab.locator('.hub-sr-trigger-label').innerText() === 'Skills');
      await shot(tab, size.id + '-header');
      await tap(cdp, header); await tab.locator('.hub-sr-proposal[data-proposal-id="' + id + '"]').waitFor();
      await choose(tab, id);
      check(size.id + ': selecting a skill replaces the inbox with its detail and a way back', !await tab.locator('.hub-sr-sidebar').isVisible() && await tab.locator('.hub-sr-detail').isVisible() && await tab.locator('.hub-sr-back').isVisible() && await tab.locator('.hub-sr-footer').isVisible());
      await shot(tab, size.id + '-detail');
      await tap(cdp, await tab.evaluate(geometry, '.hub-sr-back'));
      await tab.waitForFunction(() => document.querySelector('.hub-sr-dialog').classList.contains('hub-sr-list-view'));
      check(size.id + ': back restores only the pending inbox without clearing or deciding the selection', await tab.locator('.hub-sr-sidebar').isVisible() && !await tab.locator('.hub-sr-detail').isVisible() && !await tab.locator('.hub-sr-footer').isVisible() && await tab.locator('.hub-sr-proposal[data-proposal-id="' + id + '"]').getAttribute('aria-pressed') === 'true' && getStore('reviewer', 'primary').get(id).status === 'pending');
      await shot(tab, size.id + '-inbox-return');
      await choose(tab, id);
      await tab.locator('#input').evaluate((node, value) => { node.value = value; node.dispatchEvent(new Event('input', { bubbles: true })); }, 'Borrador móvil intacto · ' + size.id);
      if (size.visualHeight) { await tab.evaluate(({ height, offsetTop }) => window.fixtureKeyboard({ height, offsetTop }), { height: size.visualHeight, offsetTop: size.offsetTop }); await settle(tab); }
      await tab.evaluate(() => { window.__skillTouchesBehindDialog = 0; document.addEventListener('touchstart', () => window.__skillTouchesBehindDialog++); });
      const start = await tab.locator('.hub-sr-body').evaluate(node => node.scrollTop); await swipe(tab, cdp); await swipe(tab, cdp);
      await tab.evaluate(() => new Promise(resolve => {
        const body = document.querySelector('.hub-sr-body'); let last = body.scrollTop, stable = performance.now();
        function frame(now) { if (last !== body.scrollTop) { last = body.scrollTop; stable = now; } if (now - stable > 220) resolve(); else requestAnimationFrame(frame); }
        requestAnimationFrame(frame);
      }));
      const scrolled = await tab.locator('.hub-sr-body').evaluate(node => node.scrollTop);
      await tab.evaluate(() => { window.__skillTouchTrace = []; for (const type of ['click', 'change']) document.querySelector('.hub-sr-footer').addEventListener(type, event => window.__skillTouchTrace.push({ type, target: event.target.id || event.target.className, checked: document.querySelector('#skill-review-confirm').checked })); });
      const confirm = await tab.evaluate(geometry, '.hub-sr-confirm'); await tap(cdp, confirm);
      await tab.waitForFunction(() => document.querySelector('#skill-review-confirm').checked); await settle(tab);
      const accept = await tab.evaluate(geometry, '#skill-review-apply'), reject = await tab.evaluate(geometry, '#skill-review-reject'), close = await tab.evaluate(geometry, '.hub-sr-close');
      const bounds = await tab.evaluate(() => ({ overflow: document.documentElement.scrollWidth - innerWidth, documentX: document.scrollingElement.scrollLeft, documentY: document.scrollingElement.scrollTop, bodyHeight: document.querySelector('.hub-sr-body').clientHeight, visualHeight: visualViewport.height, offsetTop: visualViewport.offsetTop }));
      check(size.id + ': real touch scrolls the long review while footer and close stay reachable', scrolled > start && accept.hit && accept.visible && !accept.disabled && reject.hit && reject.visible && accept.height >= 44 && reject.height >= 44 && close.hit && close.visible && bounds.bodyHeight >= 50 && bounds.overflow <= 1 && bounds.documentX === 0 && bounds.documentY === 0 && bounds.visualHeight === (size.visualHeight || size.height) && bounds.offsetTop === (size.offsetTop || 0) && await tab.evaluate(() => window.__skillTouchesBehindDialog === 0));
      if (!(scrolled > start && accept.hit && accept.visible && !accept.disabled)) console.log('MOBILE GEOMETRY', size.id, { start, scrolled, confirm, accept, reject, bounds });
      await shot(tab, size.id);
      const beforeTouch = decisionCount(); await tap(cdp, accept);
      await tab.waitForFunction(() => document.querySelector('#skill-review-action-message')?.textContent.startsWith('Skill aceptada.'));
      check(size.id + ': one touch submits exactly one reviewed revision and preserves the chat draft', decisionCount() === beforeTouch + 1 && requests.filter(item => item.type === 'decision').at(-1).id === id && await tab.locator('#input').inputValue() === 'Borrador móvil intacto · ' + size.id);
    } catch (error) {
      await shot(tab, size.id + '-failure').catch(() => {});
      console.log('FAILED MOBILE GEOMETRY', size.id, await tab.evaluate(() => ({ width: innerWidth, height: innerHeight, visualHeight: visualViewport.height, dialog: document.querySelector('.hub-sr-dialog')?.getBoundingClientRect().toJSON(), body: document.querySelector('.hub-sr-body')?.getBoundingClientRect().toJSON(), trace: window.__skillTouchTrace })));
      throw error;
    } finally { await mobile.close(); }
  }
  check('proposal bodies and support contents are never placed in browser storage', await (async () => {
    const local = await makeContext(browser), tab = await local.newPage(); await tab.goto(base); await tab.waitForFunction(() => window.HubSkillReview && state.agent);
    await tab.locator('#btn-skill-review').click(); await idle(tab);
    // The previous touch proposal has already been applied, so seed a new pending inspection instead.
    getStore('reviewer', 'primary').set('storage', proposal('storage')); await tab.evaluate(() => window.HubSkillReview.refresh()); await choose(tab, 'storage');
    const safe = await tab.evaluate(() => [localStorage, sessionStorage].every(storage => Object.keys(storage).every(key => !/CONTENIDO-FINAL|DIFF-FINAL|FIN-ARCHIVO-EXACTO/.test(String(storage.getItem(key))))));
    await local.close(); return safe;
  })());
  check('all requests stayed loopback-only with no chat sends or unrelated mutations', external.length === 0 && otherWrites.length === 0 && chatSends.length === 0);
  check('Chromium reported no uncaught UI errors', browserErrors.length === 0);
  if (browserErrors.length) console.log('BROWSER ERRORS', browserErrors);
} catch (error) {
  check('fixture completed without an exception', false); console.error(error.stack || error);
  if (page && !page.isClosed()) await shot(page, 'failure').catch(() => {});
} finally {
  for (const release of releases) release();
  if (browser) await browser.close();
  for (const socket of wss.clients) socket.terminate();
  await new Promise(resolve => wss.close(resolve));
  server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve));
}
const failed = results.filter(result => !result.ok);
console.log('Capturas: ' + captureDir);
console.log('RESULTADO: ' + (failed.length ? failed.length + ' FALLOS' : 'TODO OK') + ' · ' + results.length + ' comprobaciones');
if (failed.length) process.exitCode = 1;
