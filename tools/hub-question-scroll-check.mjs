// Touch-only reachability of a blocking question below Failed/Progress panels.
// All APIs are inert and loopback-only; no account, credential or real question.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { WebSocketServer } from 'ws';

const require = createRequire(import.meta.url);
const express = require('express');
let chromium;
for (const candidate of [process.env.PLAYWRIGHT_MODULE, 'playwright-core', 'playwright-core'].filter(Boolean)) {
  try { chromium = require(candidate).chromium; break; } catch {}
}
if (!chromium) throw new Error('Set PLAYWRIGHT_MODULE to an installed playwright-core package.');
const assets = process.env.HUB_ASSET_DIR || new URL('../public/', import.meta.url).pathname;
const capture = process.env.HUB_CAPTURE_DIR;
if (capture) fs.mkdirSync(capture, { recursive: true });
const results = [], measurements = [], errors = [], forbidden = [], mutations = [], chatSends = [], replies = [];
const key = 'agent:main:question-scroll-fixture', answer = 'erp-not-open';
const now = Date.now();
const snapshot = { connected: true, hasActiveRun: false, updatedAt: now,
  runs: [{ runId: 'fixture-failure', status: 'error', startedAt: now - 20000, updatedAt: now, items: [] }],
  progress: { markdown: 'Comprobación local del formulario del ERP, sin operaciones reales.', plan: [{ step: 'Alcanzar la respuesta mediante gestos táctiles', status: 'in_progress' }] } };
const app = express(); app.use(express.json());
app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
app.get('/api/branding', (req, res) => res.json({ name: 'Hub', version: 'scroll-fixture' }));
app.get('/api/me', (req, res) => res.json({ user: 'scroll-fixture' }));
app.get('/api/agents', (req, res) => res.json({ agents: [{ id: 'primary', name: 'Primary', connected: true, models: [{ id: 'model', ref: 'fixture/model', name: 'Modelo local', provider: 'fixture', thinkingLevels: ['low', 'high'] }] }] }));
app.get('/api/sessions', (req, res) => res.json({ sessions: [{ key, label: 'Pregunta local del ERP', kind: 'session', updatedAt: now, hasActiveRun: false }], ownCount: 1 }));
app.get('/api/session-settings', (req, res) => res.json({ settings: { modelRef: 'fixture/model', modelProvider: 'fixture', model: 'model', thinkingLevel: 'high', thinkingLevels: ['low', 'high'] } }));
app.get('/api/history-page', (req, res) => res.json({ sessionId: 'scroll-transcript', hasMore: false, messages: Array.from({ length: 12 }, (_, index) => ({ id: 'message-' + index, role: 'assistant', text: 'Contenido local para conservar el historial mientras se responde. '.repeat(5), ts: now - 12000 + index * 1000 })) }));
app.get('/api/run-status', (req, res) => res.json({ hasActiveRun: false }));
app.get('/api/activity', (req, res) => res.json({ snapshot }));
app.get('/api/artifacts', (req, res) => res.json({ artifacts: [] }));
app.get('/api/queue', (req, res) => res.json({ available: true, sessionId: 'scroll-transcript', queuedCount: 0, items: [], hasMore: false }));
app.post('/api/question', (req, res) => { replies.push(req.body); res.json({ ok: true, status: 'answered' }); });
app.use('/api', (req, res) => { if (!['GET', 'HEAD'].includes(req.method)) mutations.push({ method: req.method, path: req.path }); res.json({}); });
app.use(express.static(assets));
const server = http.createServer(app), ws = new WebSocketServer({ server, path: '/ws' });
ws.on('connection', socket => {
  socket.send(JSON.stringify({ type: 'hello', agents: [{ id: 'primary', connected: true }] }));
  socket.on('message', raw => { const event = JSON.parse(String(raw)); if (event.type === 'send') chatSends.push(event); });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port;
const check = (name, ok) => { results.push({ name, ok: !!ok }); console.log((ok ? 'PASS ' : 'FAIL ') + name); };
const scenarios = [
  { id: 'mobile-360', width: 360, height: 780 },
  { id: 'mobile-390', width: 390, height: 844 },
  { id: 'keyboard-390', width: 390, height: 844, visualHeight: 340, offsetTop: 30 },
  { id: 'touch-landscape', width: 844, height: 390 },
];
const draftText = 'Borrador del chat que debe seguir intacto al responder la pregunta.\nSegunda línea conservada.';
const selection = { start: 8, end: 27 };

// Read geometry only. Neither this helper nor the gestures assign scroll positions.
function browserGeometry(selector) {
  const node = document.querySelector(selector);
  if (!node) return null;
  const rect = element => { const r = element.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
  const vv = visualViewport;
  const clip = { left: vv.offsetLeft, right: vv.offsetLeft + vv.width, top: vv.offsetTop, bottom: vv.offsetTop + vv.height };
  const ancestors = [];
  for (let parent = node.parentElement; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent), box = rect(parent);
    const clipsX = /auto|scroll|hidden|clip/.test(style.overflowX), clipsY = /auto|scroll|hidden|clip/.test(style.overflowY);
    if (!clipsX && !clipsY) continue;
    if (clipsX) { clip.left = Math.max(clip.left, box.left + parent.clientLeft); clip.right = Math.min(clip.right, box.left + parent.clientLeft + parent.clientWidth); }
    if (clipsY) { clip.top = Math.max(clip.top, box.top + parent.clientTop); clip.bottom = Math.min(clip.bottom, box.top + parent.clientTop + parent.clientHeight); }
    ancestors.push({ id: parent.id || parent.tagName.toLowerCase(), overflowY: style.overflowY, overscrollY: style.overscrollBehaviorY, ...box, scrollTop: parent.scrollTop, scrollHeight: parent.scrollHeight, clientHeight: parent.clientHeight });
  }
  const box = rect(node), x = (box.left + box.right) / 2, y = (box.top + box.bottom) / 2;
  const hit = document.elementFromPoint(x, y);
  return { box, clip, ancestors, center: { x, y }, hit: hit === node || node.contains(hit),
    visible: box.top >= clip.top - 1 && box.bottom <= clip.bottom + 1 && box.left >= clip.left - 1 && box.right <= clip.right + 1,
    disabled: !!node.disabled, layout: { width: innerWidth, height: innerHeight, visualHeight: vv.height, offsetTop: vv.offsetTop },
    documentScroll: { x: document.scrollingElement.scrollLeft, y: document.scrollingElement.scrollTop } };
}
const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
async function tap(cdp, point) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}
async function swipeQuestion(page, cdp) {
  const region = await page.evaluate(browserGeometry, '#prompts .question');
  const top = Math.max(region.box.top, region.clip.top) + 6;
  const bottom = Math.min(region.box.bottom, region.clip.bottom) - 6;
  if (bottom - top < 20) return false;
  // The card's left padding avoids the textarea's own independent text scrollport.
  const x = Math.max(region.box.left, region.clip.left) + 9;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: bottom }] });
  for (let step = 1; step <= 10; step++) {
    await new Promise(resolve => setTimeout(resolve, 18));
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: bottom - (bottom - top) * step / 10 }] });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  // Wait for touch inertia to finish before measuring/tapping; do not scroll in code.
  await page.evaluate(() => new Promise((resolve, reject) => {
    const start = performance.now(); let last = '', stableSince = start;
    const frame = () => {
      const button = document.querySelector('#prompts .send');
      const panel = document.querySelector('#session-panels');
      const r = button?.getBoundingClientRect();
      const sample = JSON.stringify([panel?.scrollTop, r?.top, r?.bottom]);
      const now = performance.now();
      if (sample !== last) { last = sample; stableSince = now; }
      if (now - stableSince >= 180) return resolve();
      if (now - start > 3000) return reject(new Error('Touch scroll did not settle'));
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }));
  return true;
}

let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || chromium.executablePath(), headless: true });
  for (const scenario of scenarios) {
    const context = await browser.newContext({ viewport: { width: scenario.width, height: scenario.height }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
    await context.route('**/*', route => {
      if (new URL(route.request().url()).origin === base) return route.continue();
      forbidden.push(route.request().url()); return route.abort();
    });
    await context.addInitScript(({ height }) => {
      const values = { height, offsetTop: 0 };
      for (const name of Object.keys(values)) Object.defineProperty(visualViewport, name, { configurable: true, get: () => values[name] });
      window.fixtureKeyboard = changes => { Object.assign(values, changes); visualViewport.dispatchEvent(new Event('resize')); visualViewport.dispatchEvent(new Event('scroll')); };
    }, scenario);
    const page = await context.newPage(); page.setDefaultTimeout(5000);
    page.on('pageerror', error => errors.push(scenario.id + ': ' + error.message));
    const cdp = await context.newCDPSession(page);
    const questionId = 'erp-scroll-' + scenario.id, samples = [];
    const observed = { metrics: false, panels: false, selected: false, long: false, reached: false, hit: false, delivery: false, settled: false, preserved: false, documentFixed: false };
    const sample = async phase => {
      const value = await page.evaluate(browserGeometry, '#prompts .send');
      samples.push({ phase, ...value }); return value;
    };
    const shot = async phase => { if (capture) await page.screenshot({ path: path.join(capture, scenario.id + '-' + phase + '.png') }); };
    try {
      await page.goto(base);
      await page.waitForFunction(expected => typeof state !== 'undefined' && state.current === expected && !state.historyLoading && state.ws?.readyState === WebSocket.OPEN, key);
      await page.evaluate(() => closeNav()); await page.waitForTimeout(260);
      await page.locator('#hub-progress:not(.hidden)').waitFor();
      await page.evaluate(({ text, selection }) => {
        const input = $('input'); input.value = text; input.setSelectionRange(selection.start, selection.end);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        state.pinned = false;
      }, { text: draftText, selection });
      await page.evaluate(({ key, questionId, answer }) => onQuestion({ agentId: 'primary', sessionKey: key, id: questionId, phase: 'pending', createdAtMs: 1, questions: [{
        id: 'erp-state', question: 'Antes de continuar con esta comprobación local, indica el estado del chat del ERP. ' +
          'Esta pregunta ficticia lleva una explicación larga para reproducir la lectura y el espacio ocupado en el móvil. ' +
          'Se revisa únicamente la interfaz de OpenClaw con Assistant; no se solicita ninguna operación de cobro ni facturación.',
        options: [{ label: 'Ya he cerrado el chat del ERP', reply: 'erp-closed' }, { label: 'No tengo el chat del ERP abierto', reply: answer }, { label: 'Tengo trabajo pendiente y no puedo cerrarlo ahora', reply: 'erp-busy' }],
        // Seed the photographed state. Submission itself must be a real touch.
        defaultAnswers: [answer], isOther: true,
      }] }), { key, questionId, answer });
      await settle(page);
      if (scenario.visualHeight) {
        await page.evaluate(({ height, offsetTop }) => window.fixtureKeyboard({ height, offsetTop }), { height: scenario.visualHeight, offsetTop: scenario.offsetTop });
        await settle(page);
      }
      const initial = await sample('initial');
      observed.metrics = initial.layout.width === scenario.width && initial.layout.height === scenario.height && initial.layout.visualHeight === (scenario.visualHeight || scenario.height) && initial.layout.offsetTop === (scenario.offsetTop || 0);
      observed.panels = await page.evaluate(() => {
        const activity = $('hub-activity'), progress = $('hub-progress');
        return activity && progress && !activity.classList.contains('hidden') && !progress.classList.contains('hidden') &&
          /Fallido/.test(activity.querySelector('summary').textContent) && progress.querySelector('summary').getAttribute('aria-label') === 'Progreso del agente' && /Progreso/.test(progress.textContent) && !activity.open && !progress.querySelector('details').open;
      });
      const chosen = () => page.evaluate(() => {
        const options = [...document.querySelectorAll('#prompts .prompt-opt')];
        return options.length === 3 && options.every((node, index) => node.getAttribute('aria-pressed') === String(index === 1));
      });
      observed.selected = await chosen() && !initial.disabled;
      observed.long = !initial.visible;
      await shot('before');
      let final = initial, swipes = 0;
      while ((!final.visible || !final.hit) && swipes < 12) {
        if (!await swipeQuestion(page, cdp)) break;
        swipes++; final = await sample('swipe-' + swipes);
      }
      observed.reached = swipes > 0 && final.visible;
      observed.hit = final.visible && final.hit && final.box.height >= 44 && final.box.width >= 44;
      const selectionPreserved = await chosen();
      const noPrematureDelivery = replies.every(reply => reply.id !== questionId) && chatSends.length === 0;
      await shot('after-swipes');
      final = await sample('before-tap');
      observed.hit = observed.hit && final.visible && final.hit && final.box.height >= 44 && final.box.width >= 44;
      if (observed.reached && observed.hit && !final.disabled) {
        // Raw coordinates only: Playwright's locator click/tap would auto-scroll.
        await tap(cdp, final.center);
        await page.waitForFunction(() => !document.querySelector('#prompts .question'));
        await page.waitForTimeout(100);
      }
      const delivered = replies.filter(reply => reply.id === questionId);
      observed.delivery = noPrematureDelivery && delivered.length === 1 && delivered[0].agent === 'primary' && !delivered[0].cancel && JSON.stringify(delivered[0].answers) === JSON.stringify({ 'erp-state': [answer] });
      observed.settled = await page.evaluate(() => !document.querySelector('#prompts .question') && !$('input').disabled && !document.body.classList.contains('prompt-open'));
      observed.preserved = selectionPreserved && await page.evaluate(({ text, selection }) => {
        const input = $('input');
        return input.value === text && readDraft().text === text && input.selectionStart === selection.start && input.selectionEnd === selection.end;
      }, { text: draftText, selection });
      const endScroll = await page.evaluate(() => ({ x: document.scrollingElement.scrollLeft, y: document.scrollingElement.scrollTop }));
      observed.documentFixed = [...samples.map(value => value.documentScroll), endScroll].every(value => value.x === 0 && value.y === 0);
      await shot('finished');
      measurements.push({ scenario, swipes, samples, delivered });
    } catch (error) {
      errors.push(scenario.id + ': ' + error.message); console.log('Scenario error ' + scenario.id + ': ' + error.message);
      measurements.push({ scenario, samples, error: error.message });
    } finally {
      const labels = {
        metrics: 'keeps the layout viewport while fitting only the visual viewport',
        panels: 'starts with folded Fallido and Progreso panels',
        selected: 'starts with only the second ERP option selected and Send enabled',
        long: 'requires scrolling to reach the end of the long question',
        reached: 'real question swipes reach Send inside every clipping ancestor',
        hit: 'the visible 44px Send center passes the actual hit test',
        delivery: 'one coordinate touch delivers exactly the chosen answer to the inert API',
        settled: 'the acknowledged question disappears and unlocks the composer',
        preserved: 'scrolling and replying preserve the chosen option, chat draft and selection',
        documentFixed: 'the fixed document never scrolls during the interaction',
      };
      for (const [name, label] of Object.entries(labels)) check(scenario.id + ': ' + label, observed[name]);
      await context.close();
    }
  }
  check('the gesture journeys produce no frontend or fixture exceptions', errors.length === 0);
  check('all traffic stays in the inert loopback fixture without chat sends or unrelated mutations', forbidden.length === 0 && mutations.length === 0 && chatSends.length === 0);
} finally {
  await browser?.close();
  for (const socket of ws.clients) socket.terminate();
  await new Promise(resolve => ws.close(resolve));
  server.closeAllConnections?.();
  await new Promise(resolve => server.close(resolve));
  if (capture) fs.writeFileSync(path.join(capture, 'result.json'), JSON.stringify({ assets, results, measurements, errors, forbidden, mutations, chatSends }, null, 2) + '\n');
}
const failures = results.filter(result => !result.ok).length;
console.log('RESULT ' + (results.length - failures) + '/' + results.length);
if (failures) process.exitCode = 1;
