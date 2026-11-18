// Real frontend, inert APIs, and independently reduced visual viewport.
// Geometry is not certification of a physical Android/iOS keyboard.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { WebSocketServer } from 'ws';
const require = createRequire(import.meta.url);
const express = require('express');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const assets = process.env.HUB_ASSET_DIR || new URL('../public/', import.meta.url).pathname;
const out = process.env.HUB_CAPTURE_DIR || '/tmp/hub-mobile-focus'; fs.mkdirSync(out, { recursive: true });
const baseline = !!process.env.HUB_FOCUS_BASELINE;
const results = [], measurements = [], errors = [], mutations = [], sends = [], aborts = [], external = [];
const check = (name, ok) => { results.push({ name, ok: !!ok }); console.log((ok ? 'PASS ' : 'FAIL ') + name); };
const now = Date.now();
const snapshot = { connected: true, hasActiveRun: false, updatedAt: now,
 runs: [{ runId: 'finished', status: 'completed', startedAt: now - 20000, updatedAt: now, items: [] }],
 progress: { markdown: 'Revisión de la interfaz móvil. '.repeat(45), plan: [{ step: 'Conservar el borrador y dar espacio a la conversación', status: 'completed' }] } };
const app = express(); app.use(express.json());
app.get('/api/branding', (req, res) => res.json({ name: 'Hub', version: 'fixture' }));
app.get('/api/me', (req, res) => res.json({ user: 'mobile-focus-fixture', name: 'Fixture' }));
app.get('/api/agents', (req, res) => res.json({ agents: [{ id: 'primary', name: 'Primary', connected: true, usageEnabled: true, skillsReviewEnabled: true, voiceEnabled: true, models: [{ id: 'gpt-6-astra', ref: 'openai/gpt-6-astra', name: 'gpt-6-astra', provider: 'openai', thinkingLevels: ['low', 'medium', 'high'] }] }] }));
app.get('/api/sessions', (req, res) => res.json({ sessions: ['A', 'B'].map(key => ({ key, label: 'Desconexiones frecuentes y observación sobre STOP', updatedAt: now, hasActiveRun: false, contextTokens: 200000, totalTokens: 136000 })), ownCount: 2 }));
app.get('/api/session-settings', (req, res) => res.json({ settings: { modelRef: 'openai/gpt-6-astra', modelProvider: 'openai', model: 'gpt-6-astra', thinkingLevel: 'medium', thinkingLevels: ['low', 'medium', 'high'] } }));
app.get('/api/history-page', (req, res) => res.json({ sessionId: 'transcript-' + req.query.key, hasMore: false, messages: Array.from({ length: 20 }, (_, i) => ({ id: 'message-' + i, role: i % 2 ? 'assistant' : 'user', text: 'Observación sobre STOP. ' + 'El texto de la conversación debe conservar espacio para leer con comodidad mientras escribes. '.repeat(3), ts: now - 20000 + i * 1000 })) }));
app.get('/api/run-status', (req, res) => res.json({ hasActiveRun: false }));
app.get('/api/activity', (req, res) => res.json({ snapshot }));
app.get('/api/artifacts', (req, res) => res.json({ artifacts: [] }));
app.get('/api/queue', (req, res) => res.json({ available: true, sessionId: 'transcript-' + req.query.key, queuedCount: 0, items: [], hasMore: false }));
app.get('/api/usage', (req, res) => res.json({ agentId: 'primary', key: req.query.key, provider: 'openai', model: 'gpt-6-astra', subscription: { status: 'ready', plan: 'Team', credentialType: 'oauth', updatedAt: now, windows: [{ label: '168h', usedPercent: 9, resetAt: now + 86400000 }] }, tokens: { status: 'ready', input: 136000, output: 2000, total: 138000 } }));
app.get('/api/skill-proposals', (req, res) => res.json({ agent: 'primary', complete: true, proposals: [] }));
app.get('/api/voice/status', (req, res) => res.json({ available: true, stt: true, tts: true }));
app.use('/api', (req, res) => { if (!['GET', 'HEAD'].includes(req.method)) mutations.push(req.path); res.json({}); });
app.use(express.static(assets));
const server = http.createServer(app), ws = new WebSocketServer({ server, path: '/ws' });
ws.on('connection', socket => { socket.send(JSON.stringify({ type: 'hello', agents: [{ id: 'primary', connected: true }] })); socket.on('message', raw => { const event = JSON.parse(String(raw)); if (event.type === 'send') sends.push(event); if (event.type === 'abort') aborts.push(event); }); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || chromium.executablePath(), headless: true });
const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
function measure() {
 const rect = node => { const r = node.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height }; };
 const nodes = Object.fromEntries(['chat-header', 'messages', 'input', 'btn-send', 'composer', 'session-panels', 'model-summary', 'btn-usage'].map(id => [id, rect(document.getElementById(id))]));
 const input = document.getElementById('input');
 return { width: innerWidth, layoutHeight: innerHeight, height: visualViewport.height, offset: visualViewport.offsetTop, nodes, draft: input.value, selection: [input.selectionStart, input.selectionEnd], documentWidth: document.documentElement.scrollWidth, documentScroll: document.scrollingElement.scrollTop };
}
async function shot(page, label) { const data = await page.evaluate(measure); measurements.push({ label, ...data }); await page.screenshot({ path: path.join(out, label + '.png'), clip: { x: 0, y: data.offset, width: data.width, height: data.height } }); return data; }
try {
 for (const width of [320, 390, 844]) {
  const height = width === 844 ? 390 : 844;
  const context = await browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true, deviceScaleFactor: 1, serviceWorkers: 'block' });
  await context.route('**/*', route => { if (new URL(route.request().url()).origin === base) return route.continue(); external.push(route.request().url()); return route.abort(); });
  await context.addInitScript(({ height }) => { const values = { height, offsetTop: 0, scale: 1 }; for (const name of Object.keys(values)) Object.defineProperty(visualViewport, name, { configurable: true, get: () => values[name] }); window.setVisual = changes => { Object.assign(values, changes); visualViewport.dispatchEvent(new Event('resize')); }; }, { height });
  const page = await context.newPage(); page.setDefaultTimeout(6000); page.on('pageerror', e => errors.push(e.message));
  const viewport = async changes => { await page.evaluate(changes => window.setVisual(changes), changes); await settle(page); };
  await page.goto(base); await page.waitForFunction(() => typeof state !== 'undefined' && state.current === 'A' && !state.historyLoading && state.ws?.readyState === WebSocket.OPEN);
  await page.evaluate(() => closeNav()); await page.waitForTimeout(350);
  await page.locator('#hub-progress:not(.hidden)').waitFor();
  // Context/voice fixture metadata, without media or network operations.
  await page.evaluate(() => { document.querySelector('#ctx-meter').classList.remove('hidden'); document.querySelector('#ctx-text').textContent = 'Ctx · 68% usado'; document.querySelector('#ctx-fill').style.width = '68%'; document.querySelector('#btn-voice').classList.remove('hidden'); });
  await page.locator('#input').fill(''); await settle(page);
  const normal = await shot(page, width + '-reading');
  if (!baseline && width < 844) check('normal reading keeps model and meters ' + width, normal.nodes['model-summary'].height >= 44 && normal.nodes['btn-usage'].height >= 44);
  for (const visualHeight of width === 844 ? [300] : [430, 340, 250]) {
   await page.locator('#input').focus(); await viewport({ height: visualHeight });
   const g = await shot(page, width + '-keyboard-' + visualHeight);
   if (baseline) continue;
   check('history meets reading budget (half, or height minus 160px on tiny screens) ' + width + '/' + visualHeight, g.nodes.messages.height >= Math.min(visualHeight * .5, visualHeight - 160));
   check('editor and Send remain 44px and above keyboard ' + width + '/' + visualHeight, g.nodes.input.height >= 44 && g.nodes['btn-send'].height >= 44 && g.nodes['btn-send'].bottom <= visualHeight + 1);
   check('auxiliary cards share one 44px row ' + width + '/' + visualHeight, g.nodes['session-panels'].height >= 44 && g.nodes['session-panels'].height <= 50);
   check('metadata folded but draft focus retained ' + width + '/' + visualHeight, g.nodes['model-summary'].height === 0 && g.nodes['btn-usage'].height === 0 && await page.locator('#input').evaluate(t => document.activeElement === t));
   check('no horizontal overflow or document scroll ' + width + '/' + visualHeight, g.documentWidth <= width && g.documentScroll === 0);
  }
  if (!baseline) {
   await viewport({ height: 430 });
   const draft = Array.from({ length: 12 }, (_, i) => 'Línea ' + i + ' para conservar todo el texto.').join('\n');
   await page.locator('#input').fill(draft); await settle(page);
   const long = await shot(page, width + '-long-draft');
   check('multiline retains readable history and full draft ' + width, long.nodes.messages.height >= 150 && long.draft === draft && long.nodes.input.height >= 70);
   await page.evaluate(() => { const t = document.querySelector('#input'); t.setSelectionRange(4, 16); t.scrollTop = 0; });
   await viewport({ height: 340 });
   check('earlier selection survives compact resize ' + width, (await page.evaluate(measure)).selection.join(',') === '4,16');
   await page.locator('#btn-session-overview').click(); await settle(page);
   check('metadata opens by deliberate gesture ' + width, await page.locator('#model-summary').isVisible() && await page.locator('#btn-session-overview').getAttribute('aria-expanded') === 'true');
   await page.locator('#btn-usage').click();
   check('quota detail fits the visual viewport ' + width, await page.locator('#usage-dialog').evaluate(d => { const r = d.getBoundingClientRect(); return d.open && r.top >= visualViewport.offsetTop && r.bottom <= visualViewport.offsetTop + visualViewport.height; }));
   await page.locator('#usage-close').click();
   await page.locator('#model-summary').click(); await settle(page);
   await page.locator('#effort-select').scrollIntoViewIfNeeded();
   check('model controls preserved, not duplicated ' + width, await page.locator('#effort-select').count() === 1 && await page.locator('#effort-select').isVisible());
   await page.locator('#btn-session-overview').click(); await settle(page);
   check('closing metadata leaves no change or lost draft ' + width, await page.locator('#input').inputValue() === draft && !await page.locator('#model-summary').isVisible());
   await page.locator('#hub-progress summary').click(); await settle(page);
   await shot(page, width + '-progress');
   check('progress expands without moving offscreen controls ' + width, (await page.evaluate(measure)).nodes['btn-send'].bottom <= 341);
   await page.locator('#hub-progress .ha-actions button').first().scrollIntoViewIfNeeded();
   check('progress action reachable ' + width, await page.locator('#hub-progress .ha-actions button').first().isVisible());
   await page.locator('#hub-progress summary').click();
   await page.evaluate(() => { document.querySelector('#model-controls').classList.remove('expanded'); const box = document.querySelector('#messages'); box.scrollTop = 80; state.pinned = false; });
   await viewport({ height });
   check('keyboard close preserves reading position and draft ' + width, await page.locator('#messages').evaluate(t => Math.abs(t.scrollTop - 80) < 3) && await page.locator('#input').inputValue() === draft);
   check('full-height restores normal metadata ' + width, width === 844 || await page.locator('#model-summary').isVisible());
   await viewport({ height: 340 });
   await page.locator('#input').fill('');
   await page.evaluate(() => {
    document.querySelector('#btn-pending-questions').classList.remove('hidden');
    document.querySelector('.pending-questions-label').textContent = '2';
    document.querySelector('#btn-stop').classList.remove('hidden');
   }); await settle(page);
   await shot(page, width + '-all-actions');
   check('pending, Skills, details, microphone, STOP and Send stay hittable ' + width, await page.evaluate(() => [...(innerWidth <= 820 ? ['btn-menu'] : []), 'btn-skill-review', 'btn-pending-questions', 'btn-session-overview', 'btn-attach', 'btn-voice', 'btn-stop', 'btn-send'].every(id => {
    const node = document.getElementById(id), r = node.getBoundingClientRect(), hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return r.width >= 38 && r.height >= 40 && r.left >= 0 && r.right <= innerWidth && r.bottom <= visualViewport.height && (hit === node || node.contains(hit));
   })));
   const cdp = await context.newCDPSession(page);
   await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 28, bottom: 18, left: 0, right: 0 } }); await settle(page);
   check('compact header respects top safe area ' + width, await page.locator('#chat-header').evaluate(node => parseFloat(getComputedStyle(node).paddingTop) >= 30));
   check('composer clears the bottom safe area ' + width, (await page.evaluate(measure)).nodes['btn-send'].bottom <= 340 - 18);
   await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 0, bottom: 0, left: 0, right: 0 } }); await cdp.detach(); await settle(page);
   await page.evaluate(() => { document.querySelector('#model-summary').classList.add('hidden'); document.querySelector('#ctx-meter').classList.add('hidden'); document.querySelector('#btn-usage').hidden = true; }); await settle(page);
   check('no empty metadata menu for a restricted catalog ' + width, !await page.locator('#btn-session-overview').isVisible());
   await page.evaluate(() => {
    state.running = true;
    onQuestion({ agentId: 'primary', sessionKey: 'A', id: 'stop-layout-question', phase: 'pending', questions: [{ id: 'proceed', question: 'Pregunta sintética con turno activo', options: [{ label: 'Continuar', reply: 'continue' }] }] });
    updateComposerState();
   }); await settle(page);
   const point = await page.locator('#btn-stop').evaluate(node => { const r = node.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2; const hit = document.elementFromPoint(x, y); return { x, y, ok: !node.disabled && r.width >= 44 && r.height >= 44 && y <= visualViewport.height && (hit === node || node.contains(hit)) }; });
   check('blocking question keeps enabled STOP touchable ' + width, point.ok);
   await shot(page, width + '-question-stop');
   const before = aborts.length;
   if (point.ok) { await page.touchscreen.tap(point.x, point.y); await page.waitForTimeout(80); }
   check('one Stop gesture requests one native abort, never a chat send ' + width, aborts.length === before + 1 && sends.length === 0 && await page.locator('#input').isDisabled() && await page.locator('#btn-send').isDisabled());
   const ids = await page.locator('[id]').evaluateAll(nodes => nodes.map(n => n.id)); check('no duplicate IDs ' + width, new Set(ids).size === ids.length);
  }
  await context.close();
 }
 check('no unrequested message, setting write or external request', sends.length === 0 && mutations.length === 0 && external.length === 0);
 check('no frontend exceptions', errors.length === 0);
} finally {
 await browser.close(); for (const socket of ws.clients) socket.terminate(); await new Promise(resolve => ws.close(resolve)); await new Promise(resolve => server.close(resolve));
 fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ results, measurements, errors, mutations, sends, aborts, external }, null, 2) + '\n');
}
console.log('RESULT ' + results.filter(r => r.ok).length + '/' + results.length); if (results.some(r => !r.ok)) process.exitCode = 1;
