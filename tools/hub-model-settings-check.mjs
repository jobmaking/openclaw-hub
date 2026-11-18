import { chromium } from 'playwright-core';
// Exercise the real server and UI against an isolated gateway, never production.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { WebSocketServer } = require('ws');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-model-settings-'));
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const models = [
  { id: 'shared', provider: 'api-a', name: 'Shared A', thinkingLevels: [{ id: 'off', label: 'off' }, { id: 'low', label: 'low' }, { id: 'high', label: 'high' }], thinkingDefault: 'low' },
  { id: 'shared', provider: 'api-b', name: 'Shared B', thinkingLevels: [{ id: 'max', label: 'Maximum' }, { id: 'ultra', label: 'ultra' }], thinkingDefault: 'max' },
  { id: 'nested/model', provider: 'api-b', name: 'Nested model', thinkingLevels: [{ id: 'off', label: 'off' }, { id: 'low', label: 'on' }], thinkingDefault: 'off' },
  { id: 'api-b/special', provider: 'api-b', name: 'Provider-prefixed id', thinkingLevels: [{ id: 'off', label: 'off' }, { id: 'ultra', label: 'ultra' }], reasoning: false, thinkingDefault: 'off' },
  { id: 'plain', provider: 'api-a', name: 'Plain model', reasoning: false, thinkingLevels: [{ id: 'off', label: 'off' }], thinkingDefault: 'off' },
  { id: 'legacy', provider: 'api-old', name: 'Legacy model' },
];
const rows = new Map(['A', 'B'].map(id => [id, { key: id, label: 'Test ' + id, classification: 'session', updatedAt: Date.now(), modelProvider: 'api-a', model: 'shared', modelOverrideSource: null, hasActiveRun: false }]));
const describe = row => {
  const model = models.find(model => model.provider === row.modelProvider && model.id === row.model);
  return { ...row, thinkingLevels: model?.thinkingLevels, thinkingDefault: model?.thinkingDefault };
};
let patchDelay = 0;
let rejectNextPatch = false;
let nextDescribeGate = null;
let nextListGate = null;
let nextHistoryGate = null;
let heldDescribes = 0;
let heldLists = 0;
let heldHistories = 0;
let historySequence = 0;
let patches = [];
const patchAuthorities = [];
let backend;
let chrome;
let socket;
const gateway = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await new Promise(resolve => gateway.once('listening', resolve));
gateway.on('connection', client => {
  let grantedScopes = [];
  client.send(JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { nonce: 'isolated-test' } }));
  client.on('message', async data => {
    const message = JSON.parse(data);
    const reply = (payload, error) => client.send(JSON.stringify({ type: 'res', id: message.id, ok: !error, ...(error ? { error: { code: 'INVALID_REQUEST', message: error } } : { payload }) }));
    const params = message.params || {};
    if (message.method === 'connect') { grantedScopes = params.scopes; return reply({ auth: { scopes: grantedScopes } }); }
    if (message.method === 'models.list') return reply({ models });
    if (message.method === 'sessions.list') {
      const sessions = [...rows.values()].map(describe);
      const gate = nextListGate; nextListGate = null;
      if (gate) { heldLists++; await gate; }
      return reply({ sessions });
    }
    if (message.method === 'sessions.describe') {
      if (!rows.has(params.key)) return reply(null, 'Session not found');
      const session = describe(rows.get(params.key));
      const gate = nextDescribeGate; nextDescribeGate = null;
      if (gate) { heldDescribes++; await gate; }
      return reply({ session });
    }
    if (message.method === 'sessions.preview') return reply({ previews: [] });
    if (message.method === 'chat.history') {
      const text = 'History ' + params.sessionKey + ' #' + (++historySequence);
      const gate = nextHistoryGate; nextHistoryGate = null;
      if (gate) { heldHistories++; await gate; }
      return reply({ messages: [{ role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() }] });
    }
    if (message.method === 'sessions.patch') {
      patches.push(params);
      patchAuthorities.push(grantedScopes);
      const delay = patchDelay; patchDelay = 0;
      if (delay) await sleep(delay);
      if (rejectNextPatch) { rejectNextPatch = false; return reply(null, 'Simulated rejection'); }
      const current = rows.get(params.key);
      if (!current) return reply(null, 'Session not found');
      const row = { ...current };
      if ('model' in params) {
        const ref = params.model ?? 'api-a/shared';
        const model = models.find(model => model.provider + '/' + model.id === ref);
        if (!model) return reply(null, 'Unknown model');
        row.modelProvider = model.provider; row.model = model.id;
        row.modelOverrideSource = params.model === null ? null : 'user';
        if (row.thinkingLevel && !model.thinkingLevels?.some(level => level.id === row.thinkingLevel)) row.thinkingLevel = model.thinkingDefault;
      }
      if ('thinkingLevel' in params) {
        if (params.thinkingLevel === null) delete row.thinkingLevel;
        else {
          if (!describe(row).thinkingLevels?.some(level => level.id === params.thinkingLevel)) return reply(null, 'Unsupported effort');
          row.thinkingLevel = params.thinkingLevel;
        }
      }
      rows.set(params.key, row);
      // Deliberately return the EFFECTIVE effort here; only describe distinguishes inheritance.
      return reply({ key: row.key, resolved: { thinkingLevel: row.thinkingLevel ?? describe(row).thinkingDefault } });
    }
    if (message.method === 'question.list') return reply({ questions: [] });
    return reply([]);
  });
});

async function freePort() {
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  return port;
}
function check(name, condition) { assert.ok(condition, name); console.log('PASS ' + name); }
async function until(fn, description) {
  for (let attempt = 0; attempt < 100; attempt++) { if (await fn()) return; await sleep(50); }
  throw new Error('Timeout: ' + description);
}

try {
  fs.writeFileSync(path.join(temporary, 'agents.json'), JSON.stringify([
    { id: 'test', name: 'Test agent', url: 'ws://127.0.0.1:' + gateway.address().port, token: 'test-only' },
    { id: 'locked', name: 'Locked agent', url: 'ws://127.0.0.1:' + gateway.address().port, token: 'test-only', lockedModel: true },
  ]));
  fs.writeFileSync(path.join(temporary, 'users.json'), JSON.stringify([{ u: 'test', p: 'isolated-test-only' }]));
  const port = await freePort();
  backend = spawn(process.execPath, [path.join(repo, 'server.js')], { env: { ...process.env, DATA_DIR: temporary, AGENTS_FILE: path.join(temporary, 'agents.json'), PORT: String(port), BIND: '127.0.0.1' }, stdio: 'ignore' });
  const base = 'http://127.0.0.1:' + port;
  await until(() => fetch(base + '/api/branding').then(response => response.ok).catch(() => false), 'backend listening');
  const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ u: 'test', p: 'isolated-test-only' }) });
  check('isolated backend login', login.ok);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const request = (url, body) => fetch(base + url, { method: body ? 'POST' : 'GET', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  let agents;
  await until(async () => { agents = await (await request('/api/agents')).json(); return agents.agents?.[0]?.models?.length === models.length; }, 'configured model catalog');
  check('provider-qualified refs prevent collisions', new Set(agents.agents[0].models.map(model => model.ref)).size === models.length);
  check('nested model ids retain provider', agents.agents[0].models.some(model => model.ref === 'api-b/nested/model'));
  check('model id may start with its own provider', agents.agents[0].models.some(model => model.ref === 'api-b/api-b/special'));
  check('gateway effort profiles survive API', agents.agents[0].models.find(model => model.ref === 'api-b/shared')?.thinkingLevels?.[0]?.label === 'Maximum');
  const unauthenticated = await fetch(base + '/api/session-settings?agent=test&key=A');
  check('settings require authentication', unauthenticated.status === 401);
  const locked = await request('/api/session-settings', { agent: 'locked', key: 'A', model: 'api-b/shared' });
  check('locked model cannot be changed', locked.status === 409);
  const effort = await (await request('/api/session-settings', { agent: 'test', key: 'A', thinkingLevel: 'high' })).json();
  check('effort patch never resets the model', effort.ok && !('model' in patches.at(-1)));
  const inherited = await (await request('/api/session-settings', { agent: 'test', key: 'A', thinkingLevel: null })).json();
  check('reset stays inherited despite effective patch response', inherited.settings?.thinkingLevel === null && inherited.settings?.thinkingDefault === 'low');
  check('settings connection cannot change global defaults', patchAuthorities.every(scopes => scopes.includes('operator.write') && !scopes.includes('operator.admin')));
  rows.get('B').hasActiveRun = true;
  const patchCountBeforeBusy = patches.length;
  const active = await request('/api/session-settings', { agent: 'test', key: 'B', thinkingLevel: 'high' });
  check('backend rejects changes during an active turn', active.status === 409 && patches.length === patchCountBeforeBusy);
  rows.get('B').hasActiveRun = false;

  const profile = path.join(temporary, 'chrome');
  chrome = await chromium.launchPersistentContext(profile, { executablePath: process.env.CHROMIUM_PATH || chromium.executablePath(), headless: true, args: ['--remote-debugging-port=0', '--disable-gpu'] });
  await until(() => fs.existsSync(path.join(profile, 'DevToolsActivePort')), 'Chrome debugging endpoint');
  const debugPort = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0];
  const targets = await (await fetch('http://127.0.0.1:' + debugPort + '/json/list')).json();
  socket = new WebSocket(targets.find(target => target.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let sequence = 0;
  const pending = new Map();
  socket.onmessage = event => { const result = JSON.parse(event.data); if (pending.has(result.id)) { pending.get(result.id)(result); pending.delete(result.id); } };
  const command = (method, params = {}) => new Promise(resolve => { const id = ++sequence; pending.set(id, resolve); socket.send(JSON.stringify({ id, method, params })); });
  const evaluate = async expression => {
    const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    assert.ok(!result.result?.exceptionDetails, JSON.stringify(result.result?.exceptionDetails));
    return result.result?.result?.value;
  };
  await command('Network.enable');
  // Keep the two 20 s background reconcilers from consuming one-shot gates
  // reserved for explicit navigation in this fixture. Product code is untouched.
  await command('Page.addScriptToEvaluateOnNewDocument', { source: `(() => { const native = window.setInterval; window.setInterval = (fn, delay, ...args) => delay === 20000 ? 0 : native(fn, delay, ...args); })();` });
  await command('Network.setCookie', { name: 'hubweb', value: cookie.slice('hubweb='.length), url: base });
  const change = (id, value) => evaluate(`(() => { const select = $( ${JSON.stringify(id)} ); select.value = ${JSON.stringify(value)}; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  for (const width of [320, 390, 820, 1280]) {
    await command('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: width <= 820 });
    await command('Emulation.setTouchEmulationEnabled', { enabled: width <= 820, maxTouchPoints: 5 });
    const previousDocument = await evaluate('performance.timeOrigin');
    await command('Page.navigate', { url: base });
    await until(() => evaluate('performance.timeOrigin !== ' + JSON.stringify(previousDocument) + ' && typeof state !== "undefined" && state.current === "A" && !!document.getElementById("provider-select") && !$("model-controls").classList.contains("hidden")'), 'new document settings controls');
    // The production list cache is valid for 4 s; these race tests need every
    // explicit navigation to reach the gateway and hit its one-shot gate.
    await evaluate(`hubFetch = ((original) => (url, options) => original(typeof url === 'string' && url.startsWith('/api/sessions?') && !url.includes('fresh=') ? url + '&fresh=1' : url, options))(hubFetch);`);
    await evaluate('hideNav()');
    await until(() => evaluate('!$("provider-select").disabled'), 'settings loaded');
    // V1.0.16 keeps a compact, readable model summary on mobile; expanding it is
    // an explicit part of the user's settings flow, not hidden zero-size selects.
    if (width <= 820) await evaluate('if ($( "model-summary" ) && !$("model-controls").classList.contains("expanded")) $("model-summary").click()');
    const geometry = await evaluate(`(() => ({ width: innerWidth, overflow: document.scrollingElement.scrollWidth > innerWidth, controls: ['provider-select', 'model-select', 'effort-select'].map(id => { const box = $(id).getBoundingClientRect(); return { width: box.width, height: box.height, right: box.right, left: box.left }; }) }))()`);
    check('responsive selectors at ' + width + 'px', geometry.width === width && !geometry.overflow && geometry.controls.every(box => box.width >= 90 && box.height >= 40 && box.left >= 0 && box.right <= width));
    if (width === 390 || width === 1280) {
      const screenshot = await command('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync('/tmp/hub-model-settings-' + width + '.png', Buffer.from(screenshot.result.data, 'base64'));
    }
  }
  for (const width of [900, 1024]) {
    await command('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: false });
    await evaluate('$("sidebar").style.setProperty("--sbw", "560px")');
    check('controls fit resized sidebar at ' + width + 'px', await evaluate('[...document.querySelectorAll(".model-controls select, .model-controls button")].every(element => { const box = element.getBoundingClientRect(); return box.left >= $("main").getBoundingClientRect().left && box.right <= innerWidth; })'));
  }
  await command('Emulation.setDeviceMetricsOverride', { width: 1280, height: 844, deviceScaleFactor: 1, mobile: false });
  await evaluate('$("sidebar").style.removeProperty("--sbw")');
  check('inherited effort shows Auto', await evaluate('$("effort-select").value === "" && /Auto/.test($("effort-select").selectedOptions[0].textContent)'));
  check('provider A selected independently of duplicate name', await evaluate('$("provider-select").value === "api-a" && $("model-select").value === "api-a/shared"'));
  // An automatic sidebar refresh can land between physical down/up events.
  await evaluate('openNav()');
  await sleep(300);
  const targetRow = await evaluate('(() => { const r = document.querySelector(".session-item[data-key=B]").getBoundingClientRect(); return { x: r.x + 70, y: r.y + r.height / 2 }; })()');
  await command('Input.dispatchMouseEvent', { type: 'mousePressed', ...targetRow, button: 'left', clickCount: 1 });
  await evaluate('renderSessions()');
  await command('Input.dispatchMouseEvent', { type: 'mouseReleased', ...targetRow, button: 'left', clickCount: 1 });
  await sleep(150);
  check('one physical click survives a sidebar refresh during the gesture', await evaluate('state.current === "B"'));
  await evaluate('selectSession("A"); hideNav()');
  await evaluate('openNav()');
  await sleep(300);
  const cancelledRow = await evaluate('(() => { const r = document.querySelector(".session-item[data-key=B]").getBoundingClientRect(); return { x: r.x + 70, y: r.y + r.height / 2 }; })()');
  await command('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [cancelledRow] });
  await evaluate('renderSessions()');
  await command('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
  await sleep(100);
  check('a cancelled touch refreshes the sidebar without opening a session', await evaluate('sessionListGesture === null && !sessionListRenderPending && state.current === "A"'));
  await command('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [cancelledRow] });
  await evaluate('renderSessions()');
  await command('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(100);
  check('one touch survives a sidebar refresh during the gesture', await evaluate('state.current === "B"'));
  await evaluate('selectSession("A"); hideNav()');
  await evaluate('modelSettings.get(rk(state.agent, state.current)).hasActiveRun = true; setRunningUI(false)');
  check('a completed turn unlocks selectors despite a stale settings snapshot', await evaluate('!$("provider-select").disabled && !$("model-select").disabled'));
  await evaluate('refreshModelSettings()');
  await evaluate('refreshModelSettings()');
  const slowDescribe = Promise.withResolvers();
  nextDescribeGate = slowDescribe.promise;
  await evaluate('(() => { window.testSettingsRead = refreshModelSettings(); })()');
  await until(() => heldDescribes > 0, 'old describe snapshot captured');
  rows.get('A').thinkingLevel = 'high';
  for (const client of gateway.clients) client.send(JSON.stringify({ type: 'event', event: 'sessions.changed', payload: {} }));
  await until(() => evaluate('$("effort-select").value === "high"'), 'new session list applied');
  slowDescribe.resolve();
  await evaluate('window.testSettingsRead');
  check('late describe cannot overwrite a newer session list', await evaluate('$("effort-select").value === "high"'));
  await request('/api/session-settings', { agent: 'test', key: 'A', thinkingLevel: 'high' });
  const slowList = Promise.withResolvers();
  nextListGate = slowList.promise;
  await evaluate('(() => { window.testSessionsRead = loadSessions(); })()');
  await until(() => heldLists > 0, 'old list snapshot captured');
  rows.get('A').thinkingLevel = 'low';
  await evaluate('refreshModelSettings()');
  slowList.resolve();
  await evaluate('window.testSessionsRead');
  check('late list cannot overwrite newer session settings', await evaluate('$("effort-select").value === "low"'));
  delete rows.get('A').thinkingLevel;
  for (const client of gateway.clients) client.send(JSON.stringify({ type: 'event', event: 'sessions.changed', payload: {} }));
  await until(() => evaluate('$("effort-select").value === ""'), 'inheritance restored after external change');
  const beforePreview = patches.length;
  await change('provider-select', 'api-b');
  check('API filtering does not silently change model', patches.length === beforePreview && await evaluate('$("model-select").value === "" && $("effort-select").disabled'));
  await evaluate('renderModels()');
  check('refresh preserves uncommitted API selection', await evaluate('$("provider-select").value === "api-b"'));
  await change('model-select', 'api-b/shared');
  await until(() => evaluate('!$("model-select").disabled && $("model-select").value === "api-b/shared"'), 'model applied');
  check('full ref and gateway-specific effort profile', patches.at(-1).model === 'api-b/shared' && await evaluate('JSON.stringify([...$("effort-select").options].map(option => option.value)) === JSON.stringify(["", "max", "ultra"])'));
  check('provider display label is preserved', await evaluate('[...$("effort-select").options].some(option => option.value === "max" && option.textContent === "Maximum")'));
  await change('effort-select', 'ultra');
  await until(() => evaluate('!$("effort-select").disabled && $("effort-select").value === "ultra"'), 'effort saved');
  await evaluate('selectSession("B")');
  await until(() => evaluate('!$("provider-select").disabled && $("provider-select").value === "api-a"'), 'session B settings');
  check('session B keeps its inherited effort', await evaluate('$("effort-select").value === ""'));
  await evaluate('selectSession("A")');
  await until(() => evaluate('!$("effort-select").disabled && $("effort-select").value === "ultra"'), 'session A restored');
  check('model and effort persist per session', await evaluate('$("model-select").value === "api-b/shared"'));
  await command('Page.navigate', { url: base });
  await until(() => evaluate('typeof state !== "undefined" && state.current === "A" && !$("effort-select").disabled && $("effort-select").value === "ultra"'), 'preferences restored after reload');
  check('reload restores saved preferences without changing inheritance', await evaluate('$("model-select").value === "api-b/shared"'));
  patchDelay = 350;
  rejectNextPatch = true;
  await change('effort-select', 'max');
  await evaluate('$("input").value = "keep this draft"; send()');
  check('send waits safely during preference save', await evaluate('$("btn-send").disabled && $("input").value === "keep this draft"'));
  await until(() => evaluate('!$("btn-send").disabled && $("effort-select").value === "ultra"'), 'rejected effort restored');
  check('failed change is visible and preserves draft', await evaluate('/Simulated rejection/.test($("model-settings-status").textContent) && $("input").value === "keep this draft"'));
  patchDelay = 350;
  await change('effort-select', 'max');
  await evaluate('selectSession("B")');
  await sleep(450);
  check('late save cannot repaint another session', await evaluate('state.current === "B" && $("provider-select").value === "api-a" && $("effort-select").value === ""'));
  await evaluate('setRunningUI(true)');
  check('active turn prevents model and effort changes', await evaluate('$("provider-select").disabled && $("model-select").disabled && $("effort-select").disabled'));
  await evaluate('setRunningUI(false)');
  rows.get('B').modelSelectionLocked = true;
  await evaluate('refreshModelSettings()');
  check('session-level model lock keeps effort independently editable', await evaluate('$("provider-select").disabled && $("model-select").disabled && $("model-reset").disabled && !$("effort-select").disabled'));
  rows.get('B').modelSelectionLocked = false;
  await evaluate('refreshModelSettings()');
  await change('model-select', 'api-a/plain');
  await until(() => evaluate('!$("model-select").disabled && $("model-select").value === "api-a/plain"'), 'plain model selected');
  check('non-reasoning model has no artificial levels', await evaluate('$("effort-select").disabled'));
  await change('provider-select', 'api-old');
  await change('model-select', 'api-old/legacy');
  await until(() => evaluate('!$("model-select").disabled && $("model-select").value === "api-old/legacy"'), 'legacy selected');
  check('missing capabilities disable effort honestly', await evaluate('$("effort-select").disabled && /disponible/i.test($("effort-select").selectedOptions[0].textContent)'));
  await evaluate('$("model-reset").click()');
  await until(() => evaluate('!$("model-select").disabled && $("model-select").value === "api-a/shared"'), 'default model restored');
  check('reset restores model inheritance', patches.at(-1).model === null && rows.get('B').modelOverrideSource === null);
  const lateHistory = Promise.withResolvers();
  nextHistoryGate = lateHistory.promise;
  const historyCount = heldHistories;
  await evaluate('(() => { window.testLateHistory = selectSession("A"); })()');
  await until(() => heldHistories > historyCount, 'old history snapshot captured');
  await evaluate('selectSession("B")');
  lateHistory.resolve();
  await evaluate('window.testLateHistory');
  check('late history cannot repaint another session', await evaluate('state.current === "B" && /History B/.test($("messages").textContent) && !/History A/.test($("messages").textContent)'));
  const lateAgent = Promise.withResolvers();
  // Reapply after any fixture document reload, and prevent queued refreshes
  // from consuming this navigation's one-shot gateway gate.
  await evaluate(`hubFetch = ((original) => (url, options) => original(typeof url === 'string' && url.startsWith('/api/sessions?') && !url.includes('fresh=') ? url + '&fresh=1' : url, options))(hubFetch);`);
  await evaluate('clearTimeout(sessionRefreshTimer); sessionRefreshTimer = null; scheduleSessionListRefresh = () => {}');
  nextListGate = lateAgent.promise;
  const listCount = heldLists;
  await evaluate('(() => { window.testLateAgent = selectAgent("locked", "A"); })()');
  await until(() => heldLists > listCount, 'old agent selection captured');
  await evaluate('selectAgent("test", "B")');
  lateAgent.resolve();
  await evaluate('window.testLateAgent');
  check('late agent selection cannot override newer navigation', await evaluate('state.agent === "test" && state.current === "B"'));
  await evaluate('selectSession("A")');
  const lateReload = Promise.withResolvers();
  nextHistoryGate = lateReload.promise;
  const reloadCount = heldHistories;
  await evaluate('(() => { window.testLateReload = reloadFinalMessages("A"); })()');
  await until(() => heldHistories > reloadCount, 'old final reload captured');
  await evaluate('selectAgent("locked", "A")');
  const currentHistory = await evaluate('$("messages").textContent');
  lateReload.resolve();
  await evaluate('window.testLateReload');
  check('late final reload cannot cross agents with equal session keys', await evaluate('state.agent === "locked" && state.current === "A" && $("messages").textContent === ' + JSON.stringify(currentHistory)));
  check('every preference patch used non-admin authority', patchAuthorities.every(scopes => !scopes.includes('operator.admin')));
  console.log('RESULTADO: TODO OK');
} finally {
  socket?.close();
  backend?.kill();
  await chrome?.close();
  for (const client of gateway.clients) client.terminate();
  await new Promise(resolve => gateway.close(resolve));
  if (backend?.exitCode === null && backend.signalCode === null) await new Promise(resolve => backend.once('exit', resolve));
  fs.rmSync(temporary, { recursive: true, force: true });
}
