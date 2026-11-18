// Real shipped UI with inert native-shaped APIs and a separately resized visual viewport.
// This reproduces keyboard geometry; it does not emulate a physical Android IME.
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
const capture = process.env.HUB_CAPTURE_DIR;
if (capture) fs.mkdirSync(capture, { recursive: true });
let checks = 0, failures = 0;
const measurements = [], errors = [], sent = [], sockets = new Set();
const check = (name, condition) => { checks++; if (!condition) failures++; console.log((condition ? 'PASS ' : 'FAIL ') + name); };
const now = Date.now();
const snapshot = { connected: true, hasActiveRun: false, updatedAt: now, runs: [{ runId: 'finished', status: 'completed', startedAt: now - 20000, updatedAt: now, items: [] }], progress: { markdown: 'Revisión de la interfaz móvil.\n\n' + 'Un paso verificable con contexto y resultado.\n'.repeat(8), plan: [{ step: 'Mantener el borrador y los controles visibles', status: 'in_progress' }] } };
const app = express(); app.use(express.json());
app.get('/api/branding', (req, res) => res.json({ name: 'Hub', version: 'fixture' }));
app.get('/api/me', (req, res) => res.json({ user: 'keyboard-fixture', name: 'Keyboard fixture' }));
app.get('/api/agents', (req, res) => res.json({ agents: [{ id: 'primary', name: 'Primary', connected: true, models: [{ id: 'model', ref: 'fixture/model', name: 'Modelo', provider: 'fixture', thinkingLevels: ['low', 'high'] }] }] }));
app.get('/api/sessions', (req, res) => res.json({ sessions: ['A', 'B'].map(key => ({ key, label: 'Conversación ' + key, updatedAt: now, hasActiveRun: false })), ownCount: 2 }));
app.get('/api/session-settings', (req, res) => res.json({ settings: { modelRef: 'fixture/model', modelProvider: 'fixture', model: 'model', thinkingLevel: 'high', thinkingLevels: ['low', 'high'] } }));
app.get('/api/history-page', (req, res) => res.json({ messages: Array.from({ length: 24 }, (_, i) => ({ id: 'message-' + i, role: i % 2 ? 'assistant' : 'user', text: 'Mensaje ' + i + ': ' + 'Contenido para comprobar la lectura sin saltos. '.repeat(4), ts: now - 24000 + i * 1000 })), sessionId: 'transcript-' + req.query.key, hasMore: false }));
app.get('/api/run-status', (req, res) => res.json({ hasActiveRun: false }));
app.get('/api/activity', (req, res) => res.json({ snapshot }));
app.get('/api/artifacts', (req, res) => res.json({ artifacts: [{ id: 'fixture-file', title: 'Entregable de prueba', downloadSupported: false }] }));
app.get('/api/queue', (req, res) => res.json({ available: true, sessionId: 'transcript-' + req.query.key, queuedCount: 0, items: [], hasMore: false }));
app.use('/api', (req, res) => res.json({}));
app.use(express.static(assets));
const server = http.createServer(app), ws = new WebSocketServer({ server, path: '/ws' });
ws.on('connection', socket => {
  sockets.add(socket); socket.on('close', () => sockets.delete(socket));
  socket.send(JSON.stringify({ type: 'hello', agents: [{ id: 'primary', connected: true }] }));
  socket.on('message', raw => { const event = JSON.parse(String(raw)); if (event.type === 'send') sent.push(event); });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || chromium.executablePath(), headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1, serviceWorkers: 'block' });
await context.addInitScript(() => {
  const values = { height: Number(new URL(location.href).searchParams.get('visualHeight')) || 844, offsetTop: 0, scale: 1 };
  for (const key of Object.keys(values)) Object.defineProperty(window.visualViewport, key, { configurable: true, get: () => values[key] });
  window.keyboardViewport = changes => { Object.assign(values, changes); window.visualViewport.dispatchEvent(new Event('resize')); window.visualViewport.dispatchEvent(new Event('scroll')); };
  window.keyboardVisible = node => {
    const rect = node.getBoundingClientRect();
    let top = visualViewport.offsetTop, bottom = top + visualViewport.height;
    for (let ancestor = node.parentElement; ancestor; ancestor = ancestor.parentElement) {
      if (!/auto|scroll|hidden|clip/.test(getComputedStyle(ancestor).overflowY)) continue;
      const box = ancestor.getBoundingClientRect();
      top = Math.max(top, box.top + ancestor.clientTop);
      bottom = Math.min(bottom, box.top + ancestor.clientTop + ancestor.clientHeight);
    }
    return rect.top >= top - 1 && rect.bottom <= bottom + 1;
  };
});
const page = await context.newPage(); page.setDefaultTimeout(6000);
page.on('pageerror', error => errors.push(error.message));
const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const viewport = async changes => { await page.evaluate(changes => window.keyboardViewport(changes), changes); await settle(); };
const draft = Array.from({ length: 18 }, (_, i) => 'Línea ' + (i + 1) + ': este texto debe seguir editable al abrir el teclado.').join('\n');
const geometry = async label => {
  const result = await page.evaluate(() => {
    const rect = id => { const r = document.getElementById(id).getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: r.height, width: r.width }; };
    const t = document.getElementById('input');
    return { innerWidth, innerHeight, visualHeight: visualViewport.height, offset: visualViewport.offsetTop, app: rect('app'), input: rect('input'), send: rect('btn-send'), composer: rect('composer'), bodyScroll: document.scrollingElement.scrollTop, editorScroll: { scrollTop: t.scrollTop, scrollHeight: t.scrollHeight, clientHeight: t.clientHeight, selectionStart: t.selectionStart, selectionEnd: t.selectionEnd, length: t.value.length } };
  });
  measurements.push({ label, ...result }); return result;
};
const fits = result => result.send.bottom <= result.offset + result.visualHeight + 1 && result.input.bottom <= result.offset + result.visualHeight + 1 && result.input.top >= result.offset - 1 && result.input.height >= 44 && result.send.height >= 44;
const screenshot = async name => { if (capture) await page.screenshot({ path: path.join(capture, name + '.png') }); };
try {
  await page.goto(base);
  await page.waitForFunction(() => typeof state !== 'undefined' && state.current === 'A' && !state.historyLoading && state.ws?.readyState === WebSocket.OPEN);
  await page.locator('#hub-progress:not(.hidden)').waitFor();
  await page.locator('#hub-artifacts:not(.hidden)').waitFor();
  await page.waitForTimeout(350); // Wait for the mobile navigation transition, not only display:visible.
  await page.locator('#input').fill(draft); await settle();
  check('mobile metrics are applied before navigation', await page.evaluate(() => innerWidth === 390 && innerHeight === 844));
  check('all three native summary panels and the model summary are present', await page.locator('#hub-activity:not(.hidden), #hub-progress:not(.hidden), #hub-artifacts:not(.hidden)').count() === 3 && await page.locator('.model-summary').isVisible());
  for (const height of [430, 340, 250]) {
    await viewport({ height, offsetTop: 0 });
    const g = await geometry('visual-' + height);
    check('layout viewport stays 844px while visual viewport becomes ' + height, g.innerHeight === 844 && g.visualHeight === height);
    check('long editor and Send stay above the keyboard at ' + height + 'px', fits(g));
    check('keyboard resize preserves the complete long draft at ' + height + 'px', await page.locator('#input').inputValue() === draft);
    if (!process.env.HUB_KEYBOARD_BASELINE) check('a naturally positioned end caret stays visible at ' + height + 'px', await page.locator('#input').evaluate(t => t.selectionStart === t.value.length && t.scrollHeight - t.clientHeight - t.scrollTop <= 4));
    await screenshot('visual-' + height);
  }
  if (!process.env.HUB_KEYBOARD_BASELINE) {
    await viewport({ height: 340, offsetTop: 45 });
    check('visual viewport panning keeps both controls inside the visible area', fits(await geometry('panned')));
    await page.evaluate(() => {
      document.querySelector('#hub-artifacts').open = true;
      document.querySelector('#hub-activity').open = true;
      document.querySelector('#hub-progress details').open = true;
    }); await settle();
    check('expanded native panels cannot push the editor behind the keyboard', fits(await geometry('expanded')));
    const reachable = await page.evaluate(() => {
      const node = document.querySelector('#hub-progress .ha-actions button'); node.scrollIntoView({ block: 'nearest' });
      return window.keyboardVisible(node);
    });
    check('expanded panel actions remain reachable by scrolling', reachable);
    await page.locator('#btn-session-overview').click(); await settle();
    await page.locator('#model-summary').click(); await settle();
    await viewport({ height: 250, offsetTop: 0 });
    check('expanded model controls alone cannot cover the editor', fits(await geometry('model-expanded')));
    await page.evaluate(() => {
      state.pendingFiles = Array.from({ length: 8 }, (_, i) => ({ id: 'attachment-' + i, name: 'Documento largo ' + i + '.txt', mimeType: 'text/plain' }));
      renderChips(); sendNotices.set(rk(state.agent, state.current), { text: 'No llegó la confirmación. Tu borrador sigue guardado. '.repeat(4), error: true }); updateComposerState();
    }); await settle();
    for (const height of [430, 340, 250]) {
      await viewport({ height });
      check('model, attachments and error together keep Send visible at ' + height + 'px', fits(await geometry('extras-' + height)));
    }
    check('the last attachment can still be removed through its scrollport', await page.locator('#chips .chip:last-child button').evaluate(node => { node.scrollIntoView({ block: 'nearest' }); return window.keyboardVisible(node); }));
    await page.locator('#chips .chip:last-child button').click();
    check('removing an attachment cannot discard typed text', await page.locator('#chips .chip').count() === 7 && await page.locator('#input').inputValue() === draft);
    await page.evaluate(() => { state.pendingFiles = []; renderChips(); sendNotices.delete(rk(state.agent, state.current)); updateComposerState(); document.querySelector('#model-controls').classList.remove('expanded'); }); await settle();
    await page.locator('#input').focus();
    await page.evaluate(() => { const t = document.querySelector('#input'); t.setSelectionRange(t.value.length, t.value.length); t.scrollTop = t.scrollHeight; });
    await viewport({ height: 430, offsetTop: 0 });
    await viewport({ height: 290 });
    check('the end-of-draft caret stays in the scrollable editor after shrinking', await page.evaluate(() => { const t = document.querySelector('#input'); return t.selectionEnd === t.value.length && t.scrollHeight - t.clientHeight - t.scrollTop <= 4; }));
    await page.keyboard.insertText('\nÚltima línea visible'); await settle();
    await geometry('typed');
    check('typing at the end keeps the new line reachable and never sends it', await page.evaluate(() => { const t = document.querySelector('#input'); return t.value.endsWith('Última línea visible') && t.scrollHeight - t.clientHeight - t.scrollTop <= 4; }) && sent.length === 0);
    await page.keyboard.press('Enter'); await settle();
    check('touch Enter inserts a newline without sending', sent.length === 0 && (await page.locator('#input').inputValue()).endsWith('\n'));
    await page.evaluate(() => { const t = document.querySelector('#input'); t.setSelectionRange(11, 29); t.scrollTop = 0; });
    await viewport({ height: 400 });
    await viewport({ height: 300 });
    check('editing earlier text preserves selection and does not jump to the end', await page.evaluate(() => { const t = document.querySelector('#input'); return t.selectionStart === 11 && t.selectionEnd === 29 && t.scrollTop < 40; }));
    await page.evaluate(() => document.querySelector('#input').dispatchEvent(new CompositionEvent('compositionstart', { data: 'あ', bubbles: true })));
    const beforeComposition = await page.locator('#input').inputValue();
    await viewport({ height: 360 });
    await page.evaluate(() => document.querySelector('#input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true })));
    check('IME resize and composition Enter do not change the draft or send', await page.locator('#input').inputValue() === beforeComposition && sent.length === 0);
    await page.evaluate(() => document.querySelector('#input').dispatchEvent(new CompositionEvent('compositionend', { data: 'あ', bubbles: true })));
    await page.addStyleTag({ content: '#input { field-sizing: fixed !important; }' });
    await page.locator('#input').fill(draft); await viewport({ height: 280 });
    check('non-field-sizing browsers obey the same visible-height limit', fits(await geometry('fallback')));
    const beforeZoom = await page.evaluate(() => ({ height: document.querySelector('#app').style.height, input: getComputedStyle(document.querySelector('#input')).maxHeight }));
    await viewport({ scale: 1.5, height: 185 });
    check('pinch zoom does not reflow or shrink the editor', await page.evaluate(previous => document.querySelector('#app').style.height === previous.height && getComputedStyle(document.querySelector('#input')).maxHeight === previous.input, beforeZoom));
    await viewport({ scale: 1, height: 340 });
    check('returning from pinch zoom reapplies the visible viewport', fits(await geometry('unzoom')));
    await page.evaluate(() => { const box = document.querySelector('#messages'); box.scrollTop = 80; state.pinned = false; });
    const readingTop = await page.locator('#messages').evaluate(node => node.scrollTop);
    await viewport({ height: 430 });
    check('opening and closing the keyboard does not force a reader to the latest message', await page.locator('#messages').evaluate((node, previous) => Math.abs(node.scrollTop - previous) < 3, readingTop));
    await page.evaluate(() => selectSession('B')); await page.waitForFunction(() => state.current === 'B' && !state.historyLoading);
    await page.locator('#input').fill('Borrador de la conversación B');
    await page.evaluate(() => { window.keyboardViewport({ height: 300 }); selectSession('A'); });
    await page.waitForFunction(() => state.current === 'A' && !state.historyLoading); await settle();
    check('a deferred viewport update cannot overwrite another conversation draft', await page.locator('#input').inputValue() === draft);
    await page.reload(); await page.waitForFunction(() => state.current === 'A' && !state.historyLoading); await settle();
    check('the complete draft survives reloading after keyboard changes', await page.locator('#input').inputValue() === draft);
    await viewport({ height: 340 });
    const q = { type: 'question', id: 'keyboard-question', agentId: 'primary', sessionKey: 'A', phase: 'pending', questions: [{ id: 'details', question: 'Describe cómo quieres continuar.', options: [], isOther: true }] };
    for (const socket of sockets) socket.send(JSON.stringify(q));
    await page.locator('#prompts .prompt-other').waitFor();
    await page.locator('#prompts .prompt-other').fill('Respuesta que también se puede seguir escribiendo.');
    for (const height of [290, 250]) {
      await viewport({ height });
      check('a question text field is not clipped by any scrollport at ' + height + 'px', await page.locator('#prompts .prompt-other').evaluate(node => { node.scrollIntoView({ block: 'nearest' }); return window.keyboardVisible(node); }));
      check('a question Send action is not clipped by any scrollport at ' + height + 'px', await page.locator('#prompts .send').evaluate(node => { node.scrollIntoView({ block: 'nearest' }); return window.keyboardVisible(node); }));
    }
    await page.evaluate(() => {
      document.querySelector('#model-controls').classList.add('expanded');
      state.pendingFiles = Array.from({ length: 8 }, (_, i) => ({ id: 'question-file-' + i, name: 'Documento ' + i + '.txt', mimeType: 'text/plain' })); renderChips();
      sendNotices.set(rk(state.agent, state.current), { text: 'Borrador protegido. '.repeat(8), error: true }); updateComposerState();
    }); await settle();
    check('question field remains fully reachable with model, attachments and error', await page.locator('#prompts .prompt-other').evaluate(node => { node.scrollIntoView({ block: 'nearest' }); return window.keyboardVisible(node); }));
    check('question Send remains fully reachable with model, attachments and error', await page.locator('#prompts .send').evaluate(node => { node.scrollIntoView({ block: 'nearest' }); return window.keyboardVisible(node); }));
    check('compacting the disabled composer preserves the whole draft and attachments', await page.locator('#input').inputValue() === draft && await page.locator('#chips .chip').count() === 8);
    for (const socket of sockets) socket.send(JSON.stringify({ ...q, phase: 'resolved', status: 'answered' }));
    await page.locator('#prompts .question').waitFor({ state: 'detached' });
    await page.evaluate(() => { state.pendingFiles = []; renderChips(); sendNotices.delete(rk(state.agent, state.current)); updateComposerState(); document.querySelector('#model-controls').classList.remove('expanded'); }); await settle();
    await page.setViewportSize({ width: 900, height: 500 }); await viewport({ height: 270 });
    check('wide touch landscape also follows the visual viewport', fits(await geometry('landscape')));
    await page.setViewportSize({ width: 390, height: 844 }); await viewport({ height: 844, offsetTop: 0 });
    check('closing the keyboard restores the full viewport without losing the draft', fits(await geometry('closed')) && await page.locator('#input').inputValue() === draft);
    const initiallyOpen = await context.newPage();
    await initiallyOpen.goto(base + '?visualHeight=300');
    await initiallyOpen.waitForFunction(() => typeof state !== 'undefined' && state.current && !state.historyLoading);
    await initiallyOpen.waitForTimeout(350);
    check('opening the app with an already reduced visual viewport needs no resize event', await initiallyOpen.evaluate(() => document.querySelector('#btn-send').getBoundingClientRect().bottom <= 301 && innerHeight === 844));
    await initiallyOpen.close();
    const desktop = await browser.newContext({ viewport: { width: 1360, height: 900 }, serviceWorkers: 'block' });
    const desktopPage = await desktop.newPage(); await desktopPage.goto(base);
    await desktopPage.waitForFunction(() => typeof state !== 'undefined' && state.current && !state.historyLoading);
    check('desktop retains its full-height layout and original editor cap', await desktopPage.evaluate(() => !document.querySelector('#app').classList.contains('viewport-fit') && getComputedStyle(document.querySelector('#input')).maxHeight === '160px' && document.querySelector('#btn-send').getBoundingClientRect().bottom <= innerHeight));
    await desktop.close();
    check('the fixed document never scrolls under the keyboard', measurements.every(g => g.bodyScroll === 0));
    check('the interaction produces no frontend exceptions', errors.length === 0);
  }
} finally {
  if (capture) fs.writeFileSync(path.join(capture, 'result.json'), JSON.stringify({ checks, failures, measurements, errors }, null, 2) + '\n');
  await browser.close(); for (const socket of sockets) socket.terminate();
  await new Promise(resolve => ws.close(resolve)); await new Promise(resolve => server.close(resolve));
}
console.log('RESULT ' + (checks - failures) + '/' + checks); if (failures) process.exitCode = 1;
