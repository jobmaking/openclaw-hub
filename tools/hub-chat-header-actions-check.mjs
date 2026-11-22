// HUB chat header actions regression harness — contract 1.4.18.
// Runs the shipped public assets against inert loopback-only APIs. No production,
// account, transcript, Workshop or Document mutation is contacted or performed.
//
// Contract exercised:
//   - #chat-header[data-work-header] only with capabilities.workInbox + signed-in user
//   - .header-right exposes exactly one visible action button: #hub-chat-more
//   - #hub-chat-more opens #hub-chat-actions with Work (#btn-pending-questions),
//     Doc (#hub-documents-entry / #hub-documents-trigger) and Skill
//     (#btn-skill-review), in that order when authorised
//   - short visible labels; accessible names start with Work/Doc/Skill plus a
//     description; 44px controls; gateway light stays visible
//   - no zero counters; #hub-chat-work-count only with Work pending; the Skill
//     badge stays positive-only inside its row and the disclosure keeps a subtle
//     signal + title/aria-description
//   - no leaked Work/Doc/Skill content after permission loss, auth exit or tenant
//   - Work, Doc and Skill return focus to #hub-chat-more when closed from ⋯;
//     Escape/outside close the disclosure without touching the draft or chat
//   - #hub-chat-model is not an action; it lives in #sidebar and exposes the same
//     provider/model/effort controls, also with a compact visual viewport
//   - outside the internal HUB header, #btn-session-overview keeps its behaviour
//   - one header row at 320/390, contrast, no horizontal clipping
//
// Usage:
//   node tools/hub-chat-header-actions-check.mjs
// Optional:
//   PLAYWRIGHT_MODULE=/abs/path/to/playwright CHROMIUM_PATH=/usr/bin/google-chrome
//   HUB_ASSET_DIR=/abs/path/to/public HUB_CAPTURE_DIR=/tmp/hub-header-captures

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const express = require('express');
const { WebSocketServer } = require('ws');

const here = path.dirname(fileURLToPath(import.meta.url));
const assets = process.env.HUB_ASSET_DIR || path.join(here, '..', 'public');
const captureDir = process.env.HUB_CAPTURE_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'hub-chat-header-'));
fs.mkdirSync(captureDir, { recursive: true });

const watchedAssets = ['app.js', 'index.html', 'interface.css', 'skill-review.js', 'documents.js', 'work-inbox.css'];
function assetFingerprint() {
  const hash = crypto.createHash('sha256');
  for (const name of watchedAssets) {
    try { hash.update(name).update(fs.readFileSync(path.join(assets, name))); }
    catch { hash.update(name).update('missing'); }
  }
  return hash.digest('hex');
}
const assetsBefore = assetFingerprint();

const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');

const results = [];
const external = [];
const mutations = [];
const browserErrors = [];
const consoleErrors = [];
const check = (name, ok, detail) => {
  const entry = { name, ok: !!ok, detail };
  results.push(entry);
  const suffix = !ok && detail !== undefined ? ' — ' + safe(detail) : '';
  console.log((ok ? 'PASS ' : 'FAIL ') + name + suffix);
};
const safe = value => {
  try { return JSON.stringify(value); } catch { return String(value); }
};
const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

// ---------------------------------------------------------------------------
// Synthetic fixture data
// ---------------------------------------------------------------------------
const sessionKey = 'agent:main:dashboard:fixture-header';
const sessionId = 'fixture-header-transcript';
const longTitle = 'Planificación trimestral del equipo de operaciones';
const models = [{ id: 'fixture', ref: 'fixture/model', provider: 'fixture', name: 'Modelo sintético',
  thinkingLevels: [{ id: 'low', label: 'Bajo' }, { id: 'high', label: 'Alto' }], thinkingDefault: 'low' }];
const agentBase = { id: 'primary', name: 'Primary · Ensayo', emoji: '🧪', role: 'Producto', connected: true,
  documentsEnabled: true, skillsReviewEnabled: true, models };
const assistantAgent = { id: 'assistant', name: 'Assistant · Ensayo', emoji: '🧰', role: 'Operaciones', connected: true,
  documentsEnabled: false, skillsReviewEnabled: false, models };
const tenantAgent = { id: 'tenant-agent', name: 'Agente de cliente', emoji: '🏷️', role: 'Cliente', connected: true,
  documentsEnabled: false, skillsReviewEnabled: false, models };

const scenarios = {
  work: { user: 'fixture-header', workInbox: true, questions: 2, proposals: 2, agents: [agentBase, assistantAgent] },
  'work-calm': { user: 'fixture-header', workInbox: true, questions: 0, proposals: 2, agents: [agentBase, assistantAgent] },
  'no-work': { user: 'fixture-header', workInbox: false, questions: 0, proposals: 2, agents: [agentBase, assistantAgent] },
  zero: { user: 'fixture-header', workInbox: true, questions: 0, proposals: 0, agents: [agentBase, assistantAgent] },
  tenant: { user: 'tenant-fixture', workInbox: true, questions: 0, proposals: 0, agents: [tenantAgent], tenant: true },
  'no-model': { user: 'fixture-header', workInbox: true, questions: 0, proposals: 0, agents: [agentBase], modelSettings: false },
  'no-user': { user: null, workInbox: true, questions: 0, proposals: 0, agents: [agentBase] },
};
const scenarioOf = req => {
  const url = new URL(req.url, 'http://fixture.invalid');
  const fromQuery = url.searchParams.get('scenario');
  if (fromQuery && scenarios[fromQuery]) return fromQuery;
  const cookie = /(?:^|;\s*)hub_header_scenario=([^;]+)/.exec(req.headers.cookie || '');
  const stored = cookie ? decodeURIComponent(cookie[1]) : '';
  return scenarios[stored] ? stored : 'work';
};
const loggedOut = req => /(?:^|;\s*)hub_header_logout=1(?:;|$)/.test(req.headers.cookie || '');
const activeScenario = req => scenarios[scenarioOf(req)];
const sessionFor = scenario => ({
  key: sessionKey, label: longTitle, kind: 'session', updatedAt: Date.now() - 60000,
  hasActiveRun: false, ownCount: 1, unread: false, pinned: false,
  snippet: 'Cabecera sintética sin datos reales', agentId: scenario.agents[0].id,
});

function proposal(id, extra = {}) {
  return {
    id, name: 'fixture-' + id, title: 'Revisión sintética ' + id,
    description: 'Borrador de ensayo para comprobar la cabecera, sin contenido real.',
    kind: 'create', status: 'pending', revisionHash: 'fixture:' + id + ':r1',
    goal: 'Validar la cabecera del HUB.', evidence: 'Fixture local de Chromium.',
    content: '---\nname: fixture-' + id + '\ndescription: ensayo\n---\n\n# CONTENIDO-SINTÉTICO-' + id.toUpperCase() + '\n\n' +
      Array.from({ length: 40 }, (_, index) => (index + 1) + '. Contenido literal de prueba que debe conservarse al cerrar y abrir la cabecera.').join('\n') +
      '\nFIN-SINTÉTICO-' + id.toUpperCase() + '\n',
    diff: '--- original/SKILL.md\n+++ candidato/SKILL.md\n@@ -1,2 +1,3 @@\n-Texto anterior\n+CONTENIDO-SINTÉTICO-' + id.toUpperCase() + '\n+FIN-SINTÉTICO-' + id.toUpperCase() + '\n',
    scanStatus: 'ok', scanFindings: [], supportFiles: [], canApply: true, blockedReason: '', ...extra,
  };
}

// ---------------------------------------------------------------------------
// Loopback server
// ---------------------------------------------------------------------------
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));
app.use((req, res, next) => {
  const host = req.headers.host;
  if (!host || !/^127\.0\.0\.1:\d+$/.test(host) || req.headers.forwarded || req.headers['x-forwarded-host']) {
    return res.status(403).json({ error: 'loopback only' });
  }
  res.set('Cache-Control', 'no-store');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('X-Content-Type-Options', 'nosniff');
  const url = new URL(req.url, 'http://fixture.invalid');
  const requested = url.searchParams.get('scenario');
  if (requested && scenarios[requested] && req.method === 'GET' && url.pathname === '/') {
    res.setHeader('Set-Cookie', 'hub_header_scenario=' + encodeURIComponent(requested) + '; Path=/; SameSite=Lax');
  }
  next();
});
app.get('/api/branding', (req, res) => {
  const scenario = activeScenario(req);
  res.json({
    name: 'HUB · Ensayo', title: 'HUB · Cabecera sintética', emoji: '▤', version: 'fixture-header',
    capabilities: { files: false, push: false, voice: false, modelSettings: scenario.modelSettings !== false,
      workInbox: scenario.workInbox === true },
  });
});
app.get('/api/me', (req, res) => {
  const scenario = activeScenario(req);
  if (!scenario.user || loggedOut(req)) return res.json({});
  res.json({ user: scenario.user, name: 'Cuenta sintética', sessionScope: 'shared' });
});
app.get('/api/agents', (req, res) => {
  const scenario = activeScenario(req);
  res.json({ agents: scenario.agents.map(agent => ({
    ...agent, models: scenario.modelSettings === false ? [] : (agent.models || models),
  })) });
});
app.get('/api/sessions', (req, res) => {
  const scenario = activeScenario(req);
  const agent = scenario.agents.find(item => item.id === String(req.query.agent));
  const row = { ...sessionFor(scenario), key: sessionKey, agentId: agent?.id || scenario.agents[0].id,
    label: agent?.id === 'assistant' ? 'Conversación sintética de Assistant' : longTitle };
  res.json({ sessions: [row], total: 1, hiddenCount: 0, othersCount: 0, ownCount: 1, centralCount: 0 });
});
app.get('/api/session-settings', (req, res) => {
  if (activeScenario(req).modelSettings === false) {
    return res.status(403).json({ error: 'Modelo no disponible en el fixture', code: 'FORBIDDEN' });
  }
  res.json({ ok: true, settings: { key: sessionKey, modelRef: 'fixture/model', modelProvider: 'fixture',
    model: 'model', thinkingLevel: 'high', thinkingDefault: 'low',
    thinkingLevels: [{ id: 'low', label: 'Bajo' }, { id: 'high', label: 'Alto' }], modelSelectionLocked: false } });
});
const historyMessages = [
  { id: 'm-1', role: 'user', ts: Date.now() - 50000, text: 'Mensaje sintético de prueba de la cabecera.' },
  { id: 'm-2', role: 'assistant', ts: Date.now() - 49000, text: 'Respuesta sintética que no debe desaparecer al abrir acciones.' },
  { id: 'm-3', role: 'user', ts: Date.now() - 40000, text: 'Otro turno de ensayo, sin datos reales.' },
  { id: 'm-4', role: 'assistant', ts: Date.now() - 39000, text: 'Contenido local para comprobar el compositor y el foco.' },
];
app.get(['/api/history', '/api/history-page'], (req, res) => {
  res.json({ sessionId, messages: historyMessages, offset: 0, nextOffset: null, hasMore: false,
    totalMessages: historyMessages.length, paginationAvailable: true });
});
app.get('/api/run-status', (req, res) => res.json({ hasActiveRun: false }));
app.get('/api/activity', (req, res) => res.json({ snapshot: null }));
app.get('/api/artifacts', (req, res) => res.json({ artifacts: [] }));
app.get('/api/queue', (req, res) => res.json({ available: true, sessionId, items: [], queuedCount: 0, hasMore: false }));
app.get('/api/work-inbox', (req, res) => {
  const scenario = activeScenario(req);
  const delivery = scenario.tenant ? [] : [{
    agent: 'primary', key: sessionKey, sessionId, title: 'Conversación sintética',
    file: { id: 'fixture-file', title: 'Informe sintético.pdf', fileName: 'Informe sintético.pdf',
      sizeBytes: 2048, downloadSupported: true, download: { mode: 'bytes' } },
    canDownload: true, updatedAt: Date.now() - 120000,
  }];
  res.json({ deliveries: delivery, following: [], active: [], updatedAt: Date.now() });
});
app.get('/api/work-inbox/session', (req, res) => res.json({ sessionId, messages: historyMessages }));
app.get('/api/skill-proposals', (req, res) => {
  const scenario = activeScenario(req);
  const agentId = String(req.query.agent);
  const agent = scenario.agents.find(item => item.id === agentId);
  if (!agent || agent.skillsReviewEnabled !== true) return res.status(403).json({ error: 'Sin permiso sintético', code: 'FORBIDDEN' });
  const count = agentId === 'primary' ? scenario.proposals : 0;
  const proposals = Array.from({ length: count }, (_, index) => {
    const item = proposal(index === 0 ? 'alpha' : 'beta');
    return { id: item.id, name: item.name, title: item.title, description: item.description,
      kind: item.kind, status: item.status, revisionHash: item.revisionHash };
  });
  res.json({ agent: agentId, proposals, complete: true });
});
app.get('/api/skill-proposal', (req, res) => {
  const scenario = activeScenario(req);
  const agentId = String(req.query.agent), id = String(req.query.id);
  const agent = scenario.agents.find(item => item.id === agentId);
  if (!agent || agent.skillsReviewEnabled !== true) return res.status(403).json({ error: 'Sin permiso sintético', code: 'FORBIDDEN' });
  if (!['alpha', 'beta'].includes(id)) return res.status(404).json({ error: 'No existe', code: 'NOT_FOUND' });
  res.json({ agent: agentId, proposal: proposal(id) });
});
app.get('/api/documents', (req, res) => res.json({ documents: [], version: 1, sessionId }));
app.use('/api', (req, res, next) => {
  if (!['GET', 'HEAD'].includes(req.method)) {
    mutations.push(req.method + ' ' + req.path);
    if (req.path === '/logout') {
      res.setHeader('Set-Cookie', 'hub_header_logout=1; Path=/; SameSite=Lax');
      return res.json({ ok: true });
    }
    if (req.path === '/login') return res.json({ ok: true });
    return res.json({ ok: true });
  }
  next();
});
app.get('/api/*', (req, res) => res.json({}));
app.use(express.static(assets, { dotfiles: 'deny', redirect: false, cacheControl: false }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (socket, req) => {
  const scenario = activeScenario(req);
  if (scenario.user) {
    socket.send(JSON.stringify({ type: 'hello', user: scenario.user,
      agents: scenario.agents.map(agent => ({ id: agent.id, connected: true })) }));
  }
  if (scenario.questions > 0) {
    setTimeout(() => {
      for (let index = 0; index < scenario.questions; index++) {
        if (socket.readyState !== 1) return;
        socket.send(JSON.stringify({ type: 'question', agentId: 'primary', id: 'fixture-question-' + index,
          sessionKey, createdAtMs: Date.now(), questions: [{ id: 'choice-' + index,
            question: '¿Pregunta sintética número ' + (index + 1) + '?', options: [] }] }));
      }
    }, 120);
  }
  socket.on('message', raw => {
    try {
      const message = JSON.parse(String(raw));
      if (message.type === 'send') {
        socket.send(JSON.stringify({ type: 'send-error', agentId: message.agentId, sessionKey: message.sessionKey,
          requestId: message.requestId, clientMessageId: message.clientMessageId,
          error: 'Ensayo de cabecera: no se envían mensajes reales.' }));
      }
    } catch {}
  });
  socket.on('error', () => {});
});

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port;

// ---------------------------------------------------------------------------
// Browser helpers
// ---------------------------------------------------------------------------
async function makeContext(browser, options = {}) {
  const context = await browser.newContext({
    viewport: { width: options.width || 1440, height: options.height || 1000 },
    isMobile: !!options.isMobile, hasTouch: !!options.hasTouch,
    deviceScaleFactor: 1, locale: 'es-ES', timezoneId: 'Europe/Madrid',
    colorScheme: 'dark', reducedMotion: 'reduce', serviceWorkers: 'block',
  });
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin === base) return route.continue();
    external.push(url.href);
    return route.abort();
  });
  await context.addInitScript(({ visualHeight, visualTop }) => {
    if (!window.visualViewport) return;
    const values = { height: visualHeight || window.innerHeight, offsetTop: visualTop || 0 };
    for (const field of Object.keys(values)) {
      Object.defineProperty(window.visualViewport, field, { configurable: true, get: () => values[field] });
    }
    window.fixtureKeyboard = changes => {
      Object.assign(values, changes);
      window.visualViewport.dispatchEvent(new Event('resize'));
      window.visualViewport.dispatchEvent(new Event('scroll'));
    };
  }, { visualHeight: options.visualHeight || null, visualTop: options.visualTop || 0 });
  return context;
}

async function ready(page, scenarioName) {
  await page.goto(base + '/?scenario=' + encodeURIComponent(scenarioName), { waitUntil: 'domcontentloaded' });
  if (scenarioName === 'no-user') {
    await page.waitForFunction(() => document.querySelector('#login-view') && !document.querySelector('#login-view').classList.contains('hidden'), null, { timeout: 8000 });
    await settle(page);
    return;
  }
  await page.waitForFunction(() => typeof state !== 'undefined' && state.user && state.agent
    && !state.historyLoading && state.ws?.readyState === 1
    && document.querySelector('#app') && !document.querySelector('#app').classList.contains('hidden'), null, { timeout: 10000 });
  await page.waitForFunction(() => document.querySelector('#hub-chat-more'), null, { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(300);
  await settle(page);
}

async function geometry(page, selector) {
  return page.evaluate(sel => {
    const node = document.querySelector(sel);
    if (!node) return { present: false };
    const box = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    const vv = window.visualViewport;
    const top = vv?.offsetTop || 0, bottom = top + (vv?.height || innerHeight);
    const x = Math.min(Math.max(box.left + box.width / 2, 0), innerWidth - 1);
    const y = Math.min(Math.max(box.top + box.height / 2, 0), innerHeight - 1);
    const hit = document.elementFromPoint(x, y);
    return {
      present: true, width: box.width, height: box.height,
      left: box.left, right: box.right, top: box.top, bottom: box.bottom,
      visible: style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0 && box.width > 0 && box.height > 0,
      inViewport: box.top >= top - 1 && box.bottom <= bottom + 1 && box.left >= -1 && box.right <= innerWidth + 1,
      hit: !!hit && (hit === node || node.contains(hit)),
      disabled: !!node.disabled,
    };
  }, selector);
}

const visible = async (page, selector) => page.locator(selector).first().isVisible().catch(() => false);

async function firstVisible(page, selectors) {
  for (const selector of selectors) if (await visible(page, selector)) return selector;
  return null;
}

async function clickCenter(page, selector) {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error('No bounding box for ' + selector);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

async function menuOpen(page) {
  return page.evaluate(() => {
    const menu = document.querySelector('#hub-chat-actions');
    if (!menu || menu.hidden) return false;
    const style = getComputedStyle(menu);
    return style.display !== 'none' && style.visibility !== 'hidden' && menu.getClientRects().length > 0;
  });
}

async function openActions(page) {
  if (!await visible(page, '#hub-chat-more')) return false;
  const expanded = await page.locator('#hub-chat-more').getAttribute('aria-expanded').catch(() => null);
  if (expanded !== 'true') await clickCenter(page, '#hub-chat-more');
  await page.waitForFunction(() => {
    const menu = document.querySelector('#hub-chat-actions');
    return menu && !menu.hidden && menu.getClientRects().length > 0;
  }, null, { timeout: 3000 }).catch(() => {});
  await settle(page);
  return menuOpen(page);
}

async function closeActionsEscape(page) {
  if (await menuOpen(page)) await page.keyboard.press('Escape');
  await page.waitForFunction(() => {
    const menu = document.querySelector('#hub-chat-actions');
    return !menu || menu.hidden || menu.getClientRects().length === 0;
  }, null, { timeout: 3000 }).catch(() => {});
  await settle(page);
}

async function shot(page, name) {
  try { await page.screenshot({ path: path.join(captureDir, name + '.png') }); } catch {}
}

async function activeId(page) {
  return page.evaluate(() => document.activeElement?.id || document.activeElement?.className || document.activeElement?.tagName || '');
}

async function focusIs(page, id, timeout = 3000) {
  return page.waitForFunction(expected => document.activeElement?.id === expected, id, { timeout })
    .then(() => true).catch(() => false);
}

function shortcut(text, limit = 24) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  return { text: clean, short: clean.length <= limit };
}

// ---------------------------------------------------------------------------
// Shared assertions
// ---------------------------------------------------------------------------
async function snapshot(page) {
  return page.evaluate(() => {
    const menu = document.getElementById('hub-chat-actions');
    const more = document.getElementById('hub-chat-more');
    const header = document.getElementById('chat-header');
    const right = document.querySelector('#chat-header .header-right');
    const sidebar = document.getElementById('sidebar');
    const model = document.getElementById('hub-chat-model');
    const styleVisible = node => {
      if (!node) return false;
      const style = getComputedStyle(node);
      return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0
        && node.getClientRects().length > 0 && node.getBoundingClientRect().width > 0;
    };
    const inMenu = node => !!node && !!menu && menu.contains(node);
    const shortText = node => {
      if (!node) return '';
      const clone = node.cloneNode(true);
      clone.querySelectorAll('[id$="-count"], .pending-questions-label, .hub-sr-badge').forEach(child => child.remove());
      return clone.textContent.replace(/\s+/g, ' ').trim();
    };
    const accessible = node => [node?.getAttribute('aria-label'), node?.getAttribute('title'), shortText(node)]
      .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    const doc = ['hub-documents-trigger', 'hub-documents-entry']
      .map(id => document.getElementById(id)).find(node => node && inMenu(node) && styleVisible(node));
    const work = document.getElementById('btn-pending-questions');
    const skill = document.getElementById('btn-skill-review');
    const workCount = document.getElementById('hub-chat-work-count');
    const skillBadge = document.getElementById('hub-chat-skill-count')
      || skill?.querySelector('.hub-sr-badge') || null;
    const menuButtons = menu ? [...menu.querySelectorAll('button')].filter(styleVisible) : [];
    const directButtons = right ? [...right.querySelectorAll(':scope > button')].filter(styleVisible) : [];
    const externalButtons = right ? [...right.querySelectorAll('button')].filter(node => styleVisible(node) && !inMenu(node)) : [];
    const gw = document.getElementById('gw-status');
    return {
      menuPresent: !!menu, menuOpen: styleVisible(menu),
      more: {
        present: !!more, visible: styleVisible(more), hidden: !!more?.hidden,
        ariaExpanded: more?.getAttribute('aria-expanded') || null,
        ariaControls: more?.getAttribute('aria-controls') || null,
        ariaLabel: more?.getAttribute('aria-label') || '',
        title: more?.getAttribute('title') || '',
        ariaDescription: more?.getAttribute('aria-description') || '',
        dataSkillPending: more?.hasAttribute('data-skill-pending') || false,
        dataWarning: more?.hasAttribute('data-warning') || false,
        className: more?.className || '',
        tooltip: [more?.getAttribute('title'), more?.getAttribute('aria-description')].filter(Boolean).join(' '),
      },
      directButtons: directButtons.map(node => node.id || node.className || node.textContent.trim()),
      externalButtons: externalButtons.map(node => node.id || node.className || node.textContent.trim()),
      work: {
        present: !!work, inMenu: inMenu(work), visible: styleVisible(work),
        shortText: shortText(work), accessible: accessible(work),
        ariaDescription: work?.getAttribute('aria-description') || '',
        countText: work?.querySelector('.pending-questions-label')?.textContent?.trim() || '',
      },
      doc: {
        present: !!doc, inMenu: inMenu(doc), visible: styleVisible(doc),
        id: doc?.id || '', shortText: shortText(doc), accessible: accessible(doc),
      },
      skill: {
        present: !!skill, inMenu: inMenu(skill), visible: styleVisible(skill),
        shortText: shortText(skill), accessible: accessible(skill),
        dataCount: skill?.dataset?.count ?? null,
      },
      workCount: {
        present: !!workCount, inMenu: inMenu(workCount), insideMore: !!workCount && !!more && more.contains(workCount),
        visible: styleVisible(workCount), text: workCount?.textContent?.trim() || '',
      },
      skillBadge: {
        present: !!skillBadge, insideSkill: !!skillBadge && !!skill && skill.contains(skillBadge),
        insideMore: !!skillBadge && !!more && more.contains(skillBadge),
        visible: styleVisible(skillBadge), text: skillBadge?.textContent?.trim() || '',
      },
      menuButtons: menuButtons.map(node => node.id || node.className || node.textContent.trim()),
      menuOrder: menuButtons.map(node => node.id).filter(Boolean),
      model: {
        present: !!model, inSidebar: !!model && !!sidebar && sidebar.contains(model),
        inMenu: inMenu(model), inHeader: !!model && !!header && header.contains(model),
        hidden: !!model?.hidden, visible: styleVisible(model),
      },
      gw: { present: !!gw, visible: styleVisible(gw), label: gw?.getAttribute('aria-label') || gw?.getAttribute('title') || '' },
    };
  });
}

async function assertHeaderChrome(page, label) {
  const header = await geometry(page, '#chat-header');
  check(label + ': #chat-header is visible', header.present && header.visible, header);
  const activated = await page.locator('#chat-header[data-work-header]').count() > 0;
  check(label + ': work header activates with workInbox capability and user', activated);

  const snap = await snapshot(page);
  check(label + ': .header-right keeps exactly one visible action button (#hub-chat-more)',
    snap.externalButtons.length === 1 && snap.externalButtons[0] === 'hub-chat-more', {
      externalButtons: snap.externalButtons, directButtons: snap.directButtons,
    });
  check(label + ': #hub-chat-more is visible and named "Más acciones"',
    snap.more.visible && /Más acciones/i.test(snap.more.ariaLabel) && snap.more.ariaControls === 'hub-chat-actions', snap.more);
  const more = await geometry(page, '#hub-chat-more');
  check(label + ': #hub-chat-more is a 44px touch target', more.present && more.visible && more.height >= 43.5 && more.hit, more);
  check(label + ': gateway light stays visible in internal HUB header',
    snap.gw.visible && snap.gw.label.length > 0, snap.gw);
  return snap;
}

async function assertDisclosure(page, label, options = {}) {
  const opened = await openActions(page);
  check(label + ': #hub-chat-more opens #hub-chat-actions', opened);
  if (!opened) return null;
  if (options.workPending > 0) {
    await page.waitForFunction(expected => {
      const node = document.querySelector('#hub-chat-work-count');
      return node && !node.hidden && node.textContent.trim() === String(expected);
    }, options.workPending, { timeout: 5000 }).catch(() => {});
  }
  if (options.skillPending !== undefined) {
    await page.waitForFunction(expected => document.querySelector('#btn-skill-review')?.dataset?.count === String(expected),
      options.skillPending, { timeout: 5000 }).catch(() => {});
  }
  const snap = await snapshot(page);
  const menu = await geometry(page, '#hub-chat-actions');

  check(label + ': #hub-chat-actions stays inside the viewport', menu.visible && menu.inViewport, menu);
  check(label + ': Work action lives in the disclosure', snap.work.present && snap.work.inMenu && snap.work.visible, snap.work);
  check(label + ': Doc action lives in the disclosure', options.doc === false
    ? !snap.doc.visible
    : (snap.doc.present && snap.doc.inMenu && snap.doc.visible), snap.doc);
  check(label + ': Skill action lives in the disclosure', options.skill === false
    ? !snap.skill.visible
    : (snap.skill.present && snap.skill.inMenu && snap.skill.visible), snap.skill);
  check(label + ': model is not one of the disclosure actions', !snap.model.inMenu && !snap.menuButtons.includes('hub-chat-model'), {
    model: snap.model, menuButtons: snap.menuButtons,
  });

  if (options.doc !== false && options.skill !== false) {
    const workIndex = snap.menuOrder.indexOf('btn-pending-questions');
    const docIndex = snap.menuOrder.indexOf(snap.doc.id);
    const skillIndex = snap.menuOrder.indexOf('btn-skill-review');
    check(label + ': disclosure order is Work → Doc → Skill',
      workIndex >= 0 && docIndex > workIndex && skillIndex > docIndex,
      { order: snap.menuOrder, workIndex, docIndex, skillIndex });
  }

  const workLabel = shortcut(snap.work.shortText);
  const docLabel = shortcut(snap.doc.shortText);
  const skillLabel = shortcut(snap.skill.shortText);
  check(label + ': Work keeps a short visible label', workLabel.short && /^(work|trabajo|mi trabajo)\b/i.test(workLabel.text), workLabel);
  if (options.doc !== false) check(label + ': Doc keeps a short visible label', docLabel.short && /^(doc|documento|editar documento)\b/i.test(docLabel.text), docLabel);
  if (options.skill !== false) check(label + ': Skill keeps a short visible label', skillLabel.short && skillLabel.text.length > 0, skillLabel);

  check(label + ': Work accessible name starts with Work + description',
    /^(work|trabajo|mi trabajo)\b/i.test(snap.work.accessible) && snap.work.accessible.length > 12, snap.work.accessible);
  if (options.doc !== false) check(label + ': Doc accessible name starts with Doc + description',
    /^(doc|documento|editar documento)\b/i.test(snap.doc.accessible) && snap.doc.accessible.length > 12, snap.doc.accessible);
  if (options.skill !== false) check(label + ': Skill accessible name starts with Skill + description',
    /^(skill|skills|habilidad|habilidades)\b/i.test(snap.skill.accessible) && snap.skill.accessible.length > 12, snap.skill.accessible);

  const touchTargets = ['#btn-pending-questions'];
  if (options.doc !== false && snap.doc.id) touchTargets.push('#' + snap.doc.id);
  if (options.skill !== false) touchTargets.push('#btn-skill-review');
  for (const selector of touchTargets) {
    const box = await geometry(page, selector);
    check(label + ': ' + selector + ' is a 44px touch target',
      box.present && box.visible && box.height >= 43.5 && box.hit, box);
  }

  // Counters: Work badge only with pending Work; Skill badge positive-only.
  if (options.workPending === 0) {
    check(label + ': no zero Work counter is exposed',
      !snap.workCount.visible && !/\d/.test(snap.work.countText), snap.workCount);
  } else if (options.workPending > 0) {
    check(label + ': #hub-chat-work-count shows the positive Work count in ⋯',
      snap.workCount.visible && snap.workCount.text === String(options.workPending) && snap.workCount.insideMore, snap.workCount);
  }
  if (options.skillPending === 0) {
    check(label + ': the Skill badge is not visible at zero',
      !snap.skillBadge.visible && !/[1-9]/.test(snap.skillBadge.text), snap.skillBadge);
    check(label + ': ⋯ has no Skill pending signal at zero',
      !snap.more.dataSkillPending, snap.more);
  } else if (options.skillPending > 0) {
    check(label + ': positive Skill badge stays inside the Skill row',
      snap.skillBadge.visible && snap.skillBadge.insideSkill && snap.skillBadge.text === String(options.skillPending), snap.skillBadge);
    check(label + ': ⋯ carries a subtle Skill pending signal',
      snap.more.dataSkillPending || /skill/i.test(snap.more.className), snap.more);
  }
  if ((options.workPending || 0) > 0 || (options.skillPending || 0) > 0) {
    const hints = [options.workPending ? String(options.workPending) : '', options.skillPending ? String(options.skillPending) : ''];
    check(label + ': ⋯ title/aria-description warns about pending Work and Skill',
      hints.filter(Boolean).every(value => snap.more.tooltip.includes(value)) && /(pregunta|skill|propuesta)/i.test(snap.more.tooltip),
      snap.more.tooltip);
  }
  check(label + ': opening ⋯ does not resolve or open Skill review', !await page.locator('#skill-review-dialog[open]').count());

  return snap;
}

async function restoreMenuFocus(page, label) {
  const focus = await focusIs(page, 'hub-chat-more');
  check(label + ': closing the action returns focus to #hub-chat-more', focus, await activeId(page));
}

async function assertSingleRow(page, label, options = {}) {
  const row = await page.evaluate(() => {
    const header = document.querySelector('#chat-header');
    const titles = document.querySelector('#chat-header .head-titles');
    const right = document.querySelector('#chat-header .header-right');
    const rect = node => {
      const box = node.getBoundingClientRect();
      return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height };
    };
    const h = rect(header), t = rect(titles), r = rect(right);
    const overlap = Math.min(t.bottom, r.bottom) - Math.max(t.top, r.top);
    return {
      header: h, titles: t, right: r, overlap,
      headerOverflow: header.scrollWidth - header.clientWidth,
      innerWidth,
    };
  });
  const maxHeader = options.compact ? 66 : (options.mobile ? 72 : 88);
  check(label + ': header keeps a single row (title and ⋯ share the same band)',
    row.overlap >= 8 && row.right.height <= 52 && row.header.height <= maxHeader, row);
}

function parseColor(value) {
  const match = String(value || '').match(/rgba?\(([^)]+)\)/);
  if (!match) return null;
  const parts = match[1].split(/[ ,/]+/).filter(Boolean).map(Number);
  if (parts.length < 3 || parts.some(number => !Number.isFinite(number))) return null;
  return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
}
function luminance({ r, g, b }) {
  const channel = value => {
    const v = value / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}
function contrastRatio(foreground, background) {
  const a = luminance(foreground), b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
async function contrastOf(page, selector, fallback = '#171a21') {
  const data = await page.evaluate(({ sel, fallback }) => {
    const node = document.querySelector(sel);
    if (!node) return { present: false };
    const style = getComputedStyle(node);
    const parse = value => {
      const match = String(value || '').match(/rgba?\(([^)]+)\)/);
      if (!match) return null;
      const parts = match[1].split(/[ ,/]+/).filter(Boolean).map(Number);
      return parts.length >= 3 ? { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 } : null;
    };
    let bg = null, cursor = node;
    while (cursor) {
      const candidate = parse(getComputedStyle(cursor).backgroundColor);
      if (candidate && candidate.a >= 0.9) { bg = candidate; break; }
      cursor = cursor.parentElement;
    }
    const fallbackColor = parse(getComputedStyle(document.querySelector('#chat-header') || document.body).backgroundColor)
      || parse(fallback) || { r: 23, g: 26, b: 33, a: 1 };
    return {
      present: true,
      fg: parse(style.color),
      bg: bg || fallbackColor,
      text: node.textContent.replace(/\s+/g, ' ').trim(),
    };
  }, { sel: selector, fallback });
  if (!data.present || !data.fg) return { present: false, ...data };
  return { ...data, ratio: contrastRatio(data.fg, data.bg) };
}

async function assertContrast(page, label) {
  const more = await contrastOf(page, '#hub-chat-more');
  check(label + ': ⋯ icon contrast is at least 3:1', more.present && more.ratio >= 3, more);
  const labels = await page.evaluate(() => {
    const parse = value => {
      const match = String(value || '').match(/rgba?\(([^)]+)\)/);
      if (!match) return null;
      const parts = match[1].split(/[ ,/]+/).filter(Boolean).map(Number);
      return parts.length >= 3 ? { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 } : null;
    };
    const lum = ({ r, g, b }) => {
      const channel = value => {
        const v = value / 255;
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
      };
      return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    };
    const ratio = (f, b) => (Math.max(lum(f), lum(b)) + 0.05) / (Math.min(lum(f), lum(b)) + 0.05);
    return [...document.querySelectorAll('#hub-chat-actions button')].filter(node => {
      const style = getComputedStyle(node);
      return node.getClientRects().length > 0 && style.display !== 'none';
    }).map(node => {
      let bg = null, cursor = node;
      while (cursor) {
        const candidate = parse(getComputedStyle(cursor).backgroundColor);
        if (candidate && candidate.a >= 0.9) { bg = candidate; break; }
        cursor = cursor.parentElement;
      }
      const fg = parse(getComputedStyle(node).color);
      return { id: node.id || node.className, fg, bg, ratio: fg && bg ? ratio(fg, bg) : 0 };
    });
  });
  check(label + ': disclosure labels reach 4.5:1 contrast',
    labels.length > 0 && labels.every(item => item.ratio >= 4.5), labels);
}

async function assertNoHorizontalClipping(page, label) {
  const layout = await page.evaluate(() => {
    const header = document.querySelector('#chat-header'), title = document.querySelector('#chat-title');
    const composer = document.querySelector('#composer'), input = document.querySelector('#input');
    const rect = node => node ? node.getBoundingClientRect() : null;
    const h = rect(header), t = rect(title), c = rect(composer), i = rect(input);
    const vv = window.visualViewport;
    return {
      innerWidth, visualHeight: vv?.height || innerHeight, visualTop: vv?.offsetTop || 0,
      documentOverflow: document.documentElement.scrollWidth - innerWidth,
      headerOverflow: header ? header.scrollWidth - header.clientWidth : null,
      header: h && { left: h.left, right: h.right, top: h.top, bottom: h.bottom, width: h.width, height: h.height },
      title: t && { left: t.left, right: t.right, top: t.top, bottom: t.bottom, width: t.width, height: t.height,
        scrollWidth: title.scrollWidth, clientWidth: title.clientWidth },
      composer: c && { left: c.left, right: c.right, top: c.top, bottom: c.bottom, width: c.width, height: c.height },
      input: i && { left: i.left, right: i.right, top: i.top, bottom: i.bottom, width: i.width, height: i.height },
    };
  });
  const titleMin = layout.innerWidth <= 390 ? 40 : 110;
  const titleOk = layout.title && layout.title.width >= titleMin && layout.title.height >= 14
    && (!layout.header || layout.title.right <= layout.header.right + 1);
  const composerOk = layout.composer && layout.composer.width > 80 && layout.composer.bottom <= layout.visualTop + layout.visualHeight + 1
    && layout.input && layout.input.width > 50 && layout.input.height >= 18 && layout.input.bottom <= layout.visualTop + layout.visualHeight + 1;
  check(label + ': title keeps usable width and is not clipped by header actions', titleOk, layout);
  check(label + ': composer stays inside the visual viewport', composerOk, layout);
  check(label + ': header and document have no horizontal overflow',
    layout.documentOverflow <= 1 && (layout.headerOverflow === null || layout.headerOverflow <= 1), layout);
}

async function assertDraftAndChat(page, label, draft) {
  const value = await page.locator('#input').inputValue().catch(() => '');
  const chat = await page.locator('#messages').innerText().catch(() => '');
  check(label + ': draft survives the header interaction', value === draft, { value, draft });
  check(label + ': chat transcript is still present', /Respuesta sintética/.test(chat), chat.slice(0, 160));
}

async function assertModelInSidebar(page, label, options = {}) {
  let snap = await snapshot(page);
  check(label + ': #hub-chat-model lives in #sidebar, not in the header/disclosure',
    snap.model.present && snap.model.inSidebar && !snap.model.inMenu && !snap.model.inHeader, snap.model);

  if (options.mobile) {
    if (options.compact) {
      await closeActionsEscape(page);
    }
    const navOpen = await page.evaluate(() => document.body.classList.contains('nav-open'));
    if (!navOpen) {
      const menuButton = await geometry(page, '#btn-menu');
      check(label + ': #btn-menu is a visible 44px drawer opener', menuButton.visible && menuButton.height >= 43.5, menuButton);
      await clickCenter(page, '#btn-menu');
      await page.waitForFunction(() => document.body.classList.contains('nav-open'), null, { timeout: 3000 }).catch(() => {});
      await settle(page);
    }
    await page.locator('#hub-chat-model').scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(80);
  }

  const model = await geometry(page, '#hub-chat-model');
  check(label + ': #hub-chat-model is visible and touchable where model data exists',
    model.present && model.visible && model.height >= 43.5 && (!options.compact || model.inViewport), model);

  await clickCenter(page, '#hub-chat-model');
  await page.waitForFunction(() => document.querySelector('#session-overview')?.classList.contains('expanded')
    || document.querySelector('#model-controls')?.getClientRects().length > 0, null, { timeout: 5000 }).catch(() => {});
  await page.waitForFunction(() => !document.body.classList.contains('nav-open'), null, { timeout: 3000 }).catch(() => {});
  if (!await visible(page, '#model-controls') && await visible(page, '#model-summary')) {
    await page.locator('#model-summary').click({ timeout: 3000 }).catch(async () => clickCenter(page, '#model-summary'));
    await page.waitForTimeout(160);
  }
  await settle(page);
  const controls = await page.evaluate(() => {
    const overview = document.querySelector('#session-overview');
    const menu = document.querySelector('#hub-chat-actions');
    const summary = document.querySelector('#model-summary');
    const modelControls = document.querySelector('#model-controls');
    return {
      expanded: overview?.classList.contains('expanded') === true,
      inMenu: !!overview && !!menu && menu.contains(overview),
      navOpen: document.body.classList.contains('nav-open'),
      mainVisibility: getComputedStyle(document.querySelector('#main')).visibility,
      overviewRect: overview ? (() => { const box = overview.getBoundingClientRect(); return { width: box.width, height: box.height }; })() : null,
      summaryVisible: !!summary && summary.getClientRects().length > 0,
      summaryExpanded: summary?.getAttribute('aria-expanded') || null,
      modelControlsClass: modelControls?.className || '',
      modelControlsHidden: !!modelControls?.hidden,
      modelControlsDisplay: modelControls ? getComputedStyle(modelControls).display : null,
      controls: ['provider-select', 'model-select', 'effort-select'].map(id => {
        const node = document.getElementById(id);
        return { id, present: !!node, inside: !!node && !!overview?.contains(node),
          visible: !!node && node.getClientRects().length > 0 };
      }),
    };
  });
  check(label + ': #hub-chat-model exposes the existing provider/model/effort controls',
    controls.expanded && !controls.inMenu && controls.controls.every(control => control.present && control.inside && control.visible), controls);
  if (!controls.controls.every(control => control.visible)) await shot(page, label + '-model-controls-failure');
  const provider = await geometry(page, '#provider-select');
  check(label + ': model controls remain reachable in the current visual viewport',
    provider.present && provider.visible && (!options.compact || provider.inViewport), provider);
  if (options.compact) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);
  }
  return snap;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
let browser, page;
try {
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || chromium.executablePath(),
    headless: true,
    args: ['--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check'],
  });

  // Desktop functional run.
  const workContext = await makeContext(browser);
  page = await workContext.newPage();
  page.setDefaultTimeout(7000);
  page.on('pageerror', error => browserErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  await ready(page, 'work-calm');
  const draft = 'Borrador de cabecera que debe sobrevivir a las acciones.';
  await page.locator('#input').fill(draft);
  await assertHeaderChrome(page, 'desktop');
  const desktopActions = await assertDisclosure(page, 'desktop', { doc: true, skill: true, workPending: 0, skillPending: 2 });
  await assertSingleRow(page, 'desktop');
  await assertContrast(page, 'desktop');
  await assertNoHorizontalClipping(page, 'desktop');
  await shot(page, 'desktop-header');

  // Escape closes the disclosure, returns focus and keeps draft/chat intact.
  await closeActionsEscape(page);
  await restoreMenuFocus(page, 'desktop Escape');
  await assertDraftAndChat(page, 'desktop Escape', draft);

  // Work round trip from ⋯.
  await openActions(page);
  await clickCenter(page, '#btn-pending-questions');
  const workOpen = await page.waitForFunction(() => document.querySelector('#work-inbox')?.open === true, null, { timeout: 5000 }).then(() => true).catch(() => false);
  check('desktop: Work opens #work-inbox from the disclosure', workOpen);
  if (workOpen) {
    await assertDraftAndChat(page, 'desktop Work open', draft);
    const focusInside = await page.evaluate(() => document.querySelector('#work-inbox').contains(document.activeElement));
    check('desktop: work inbox moves focus inside the dialog', focusInside);
    const delivery = await page.locator('#work-inbox').innerText().catch(() => '');
    check('desktop: work inbox renders its synthetic delivery', /Informe sintético\.pdf/.test(delivery), delivery.slice(0, 200));
    await clickCenter(page, '#work-close');
    await page.waitForFunction(() => document.querySelector('#work-inbox')?.open === false, null, { timeout: 5000 }).catch(() => {});
    await restoreMenuFocus(page, 'desktop Work close');
    await assertDraftAndChat(page, 'desktop Work close', draft);
  }

  // Doc round trip from ⋯.
  const desktopDoc = desktopActions?.doc?.id || await firstVisible(page, ['#hub-documents-trigger', '#hub-documents-entry']);
  await openActions(page);
  if (desktopDoc) {
    await clickCenter(page, '#' + desktopDoc);
    const opened = await page.waitForFunction(() => {
      const panel = document.querySelector('#hub-documents');
      const trigger = document.querySelector('#hub-documents-trigger');
      return panel && !panel.hidden || trigger?.getAttribute('aria-expanded') === 'true';
    }, null, { timeout: 7000 }).then(() => true).catch(() => false);
    check('desktop: Doc opens the document editor from the disclosure', opened);
    await assertDraftAndChat(page, 'desktop Doc open', draft);
    if (opened) {
      const triggerText = await page.locator('#hub-documents-trigger').innerText().catch(() => '');
      check('desktop: imported document trigger keeps a short Doc label', triggerText.length > 0 && triggerText.length <= 24, triggerText);
      await shot(page, 'desktop-documents');
      const closeSelector = await firstVisible(page, ['.hd-back', '#hub-documents-trigger']);
      if (closeSelector) await clickCenter(page, closeSelector);
      const closed = await page.waitForFunction(() => {
        const panel = document.querySelector('#hub-documents');
        return !panel || panel.hidden;
      }, null, { timeout: 5000 }).then(() => true).catch(() => false);
      check('desktop: Doc returns to the chat', closed);
      await restoreMenuFocus(page, 'desktop Doc close');
      await assertDraftAndChat(page, 'desktop Doc close', draft);
    }
  } else {
    check('desktop: Doc action is available for a documents-enabled agent', false);
  }

  // Skill lifecycle and focus from ⋯.
  await openActions(page);
  await clickCenter(page, '#btn-skill-review');
  const dialogOpen = await page.waitForFunction(() => document.querySelector('#skill-review-dialog')?.open === true, null, { timeout: 5000 }).then(() => true).catch(() => false);
  check('desktop: Skill opens its review dialog from the disclosure', dialogOpen);
  if (dialogOpen) {
    await page.locator('.hub-sr-proposal[data-proposal-id="alpha"]').click();
    await page.locator('#skill-review-content').waitFor();
    const content = await page.locator('#skill-review-content').textContent();
    check('desktop: the selected skill proposal is read literally',
      /CONTENIDO-SINTÉTICO-ALPHA/.test(content) && /FIN-SINTÉTICO-ALPHA/.test(content), content?.slice(0, 120));
    await page.evaluate(() => { document.querySelector('.hub-sr-body').scrollTop = 260; });
    await shot(page, 'desktop-skills');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.querySelector('#skill-review-dialog')?.open === false, null, { timeout: 3000 }).catch(() => {});
    await restoreMenuFocus(page, 'desktop Skill close');
    await openActions(page);
    const triggerVisible = await visible(page, '#btn-skill-review');
    check('desktop: the Skill action stays accessible after closing', triggerVisible);
    await clickCenter(page, '#btn-skill-review');
    await page.waitForFunction(() => document.querySelector('#skill-review-dialog')?.open === true, null, { timeout: 4000 }).catch(() => {});
    const reopened = await page.locator('#skill-review-dialog').evaluate(node => node.open).catch(() => false);
    const alphaCount = await page.locator('.hub-sr-proposal[data-proposal-id="alpha"]').count();
    check('desktop: reopening Skill preserves the pending list and reading access', reopened && alphaCount === 1, { reopened, alphaCount });
    if (reopened && alphaCount === 1) {
      await page.locator('.hub-sr-proposal[data-proposal-id="alpha"]').click();
      await page.locator('#skill-review-content').waitFor();
      const reread = await page.locator('#skill-review-content').textContent();
      const beforeSync = await page.locator('#skill-review-dialog').evaluate(node => node.open);
      await page.evaluate(() => document.dispatchEvent(new Event('hub-skill-action-changed')));
      const afterSync = await page.locator('#skill-review-dialog').evaluate(node => node.open);
      const afterText = await page.locator('#skill-review-content').textContent();
      check('desktop: a reopened skill reading is literal and survives a header sync',
        /CONTENIDO-SINTÉTICO-ALPHA/.test(reread) && beforeSync && afterSync && afterText === reread,
        { beforeSync, afterSync, reread: reread?.slice(0, 80) });
    }
    const closeButton = await page.locator('.hub-sr-close').count();
    if (closeButton) await clickCenter(page, '.hub-sr-close');
    await restoreMenuFocus(page, 'desktop Skill close button');
  }

  // Outside click closes without trapping focus and without touching the draft.
  await openActions(page);
  const clickPoint = await page.evaluate(() => {
    const box = document.querySelector('#messages').getBoundingClientRect();
    return { x: Math.max(20, Math.min(box.left + 30, innerWidth - 20)), y: Math.max(80, Math.min(box.top + 80, innerHeight - 40)) };
  });
  await page.mouse.click(clickPoint.x, clickPoint.y);
  await page.waitForTimeout(140);
  const outsideClosed = !await menuOpen(page);
  const focusTrapped = await page.evaluate(() => document.querySelector('#hub-chat-actions')?.contains(document.activeElement));
  check('desktop: clicking outside closes the actions menu without trapping focus', outsideClosed && !focusTrapped, { outsideClosed, focusTrapped });
  await assertDraftAndChat(page, 'desktop outside click', draft);

  // Model belongs to the sidebar, never to the disclosure.
  await assertModelInSidebar(page, 'desktop');

  // Permission loss: assistant has Work but neither Documents nor Skill review.
  await page.locator('.agent-chip[data-agent-id="assistant"]').click();
  await page.waitForFunction(() => typeof state !== 'undefined' && state.agent === 'assistant' && !state.historyLoading, null, { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(400);
  await assertHeaderChrome(page, 'permission loss');
  const assistantActions = await assertDisclosure(page, 'permission loss', { doc: false, skill: false, workPending: 0, skillPending: 0 });
  if (assistantActions) {
    check('permission loss: Work remains available in the disclosure', assistantActions.work.visible && assistantActions.work.inMenu, assistantActions.work);
    check('permission loss: no Doc or Skill action is reachable', !assistantActions.doc.visible && !assistantActions.skill.visible, {
      doc: assistantActions.doc, skill: assistantActions.skill,
    });
  }
  await closeActionsEscape(page);

  // Restore primary and confirm the full disclosure comes back.
  await page.locator('.agent-chip[data-agent-id="primary"]').click();
  await page.waitForFunction(() => typeof state !== 'undefined' && state.agent === 'primary' && !state.historyLoading, null, { timeout: 8000 }).catch(() => {});
  await page.waitForFunction(() => document.querySelector('#chat-header[data-work-header]'), null, { timeout: 5000 }).catch(() => {});
  await page.waitForFunction(() => document.querySelector('#btn-skill-review')?.dataset?.count === '2', null, { timeout: 6000 }).catch(() => {});
  await openActions(page);
  const restored = await snapshot(page);
  check('permission restore: Work, Doc and Skill return after switching back',
    restored.work.visible && restored.doc.visible && restored.skill.visible, {
      work: restored.work.visible, doc: restored.doc.visible, skill: restored.skill.visible,
    });
  await closeActionsEscape(page);
  await workContext.close();

  // Full logout: login view and no top-layer leftovers.
  const logoutContext = await makeContext(browser);
  const logoutPage = await logoutContext.newPage();
  logoutPage.on('pageerror', error => browserErrors.push('logout: ' + error.message));
  await ready(logoutPage, 'work-calm');
  const logoutDraft = 'Borrador que no debe filtrarse al salir.';
  await logoutPage.locator('#input').fill(logoutDraft);
  await logoutPage.evaluate(() => document.querySelector('#btn-logout').click());
  const onLogin = await logoutPage.waitForFunction(() => document.querySelector('#login-view') && !document.querySelector('#login-view').classList.contains('hidden'), null, { timeout: 8000 }).then(() => true).catch(() => false);
  const logoutLeftovers = await logoutPage.evaluate(() => ({
    skill: !!document.querySelector('#btn-skill-review'),
    docs: !!document.querySelector('#hub-documents-trigger') && !document.querySelector('#hub-documents-trigger').hidden,
    work: document.querySelector('#work-inbox')?.open === true,
    more: !!document.querySelector('#hub-chat-more') && document.querySelector('#hub-chat-more').getClientRects().length > 0,
    model: !!document.querySelector('#hub-chat-model') && document.querySelector('#hub-chat-model').getClientRects().length > 0,
    dataHeader: !!document.querySelector('#chat-header[data-work-header]'),
    draft: document.querySelector('#input')?.value || '',
  }));
  check('logout: returns to the login view', onLogin);
  check('logout: no Work/Doc/Skill/model content survives the exit',
    !logoutLeftovers.skill && !logoutLeftovers.docs && !logoutLeftovers.work && !logoutLeftovers.more
    && !logoutLeftovers.model && !logoutLeftovers.dataHeader, logoutLeftovers);
  check('logout: the composer draft is not left visible on the login view', !logoutLeftovers.draft, logoutLeftovers.draft);
  await logoutContext.close();

  // Positive Work count and Skill tooltip signal.
  const pendingContext = await makeContext(browser);
  const pendingPage = await pendingContext.newPage();
  pendingPage.on('pageerror', error => browserErrors.push('pending: ' + error.message));
  await ready(pendingPage, 'work');
  await pendingPage.waitForFunction(() => {
    const node = document.querySelector('#hub-chat-work-count');
    return node && !node.hidden && /\b2\b/.test(node.textContent || '');
  }, null, { timeout: 7000 }).catch(() => {});
  await assertHeaderChrome(pendingPage, 'pending');
  const pendingActions = await assertDisclosure(pendingPage, 'pending', { doc: true, skill: true, workPending: 2, skillPending: 2 });
  if (pendingActions) {
    check('pending: Work label carries the positive pending text', /\b2\b/.test(pendingActions.work.countText), pendingActions.work.countText);
    check('pending: ⋯ is not a shortcut that resolves Skill review', !await pendingPage.locator('#skill-review-dialog[open]').count());
  }
  await closeActionsEscape(pendingPage);
  await restoreMenuFocus(pendingPage, 'pending Escape');
  await openActions(pendingPage);
  await clickCenter(pendingPage, '#btn-pending-questions');
  const pendingOpens = await pendingPage.waitForFunction(() => document.querySelector('#work-inbox')?.open === true, null, { timeout: 5000 }).then(() => true).catch(() => false);
  check('pending: positive Work action still opens the inbox', pendingOpens);
  if (pendingOpens) {
    await clickCenter(pendingPage, '#work-close');
    await pendingPage.waitForFunction(() => document.querySelector('#work-inbox')?.open === false, null, { timeout: 4000 }).catch(() => {});
    await restoreMenuFocus(pendingPage, 'pending Work close');
  }
  await shot(pendingPage, 'pending-header');
  await pendingContext.close();

  // -------------------------------------------------------------------------
  // Viewport matrix: 320, 390, 1440 + reduced visual height / keyboard
  // -------------------------------------------------------------------------
  for (const size of [
    { id: 'mobile-320', width: 320, height: 700, isMobile: true, hasTouch: true, mobile: true },
    { id: 'mobile-390', width: 390, height: 844, isMobile: true, hasTouch: true, mobile: true },
    { id: 'desktop-1440', width: 1440, height: 1000 },
    { id: 'keyboard-390', width: 390, height: 844, visualHeight: 340, visualTop: 30, isMobile: true, hasTouch: true, mobile: true, compact: true },
    { id: 'keyboard-320', width: 320, height: 700, visualHeight: 300, visualTop: 20, isMobile: true, hasTouch: true, mobile: true, compact: true },
  ]) {
    const context = await makeContext(browser, size);
    const tab = await context.newPage();
    tab.setDefaultTimeout(7000);
    tab.on('pageerror', error => browserErrors.push(size.id + ': ' + error.message));
    const viewDraft = 'Borrador intacto · ' + size.id;
    try {
      await ready(tab, 'work-calm');
      if (size.compact) {
        await tab.waitForFunction(() => document.querySelector('#app')?.classList.contains('viewport-compact'), null, { timeout: 5000 }).catch(() => {});
        const compact = await tab.evaluate(() => document.querySelector('#app')?.classList.contains('viewport-compact'));
        check(size.id + ': reduced visual height activates compact mode', compact);
      }
      await tab.locator('#input').fill(viewDraft);
      await assertHeaderChrome(tab, size.id);
      await assertDisclosure(tab, size.id, { doc: true, skill: true, workPending: 0, skillPending: 2 });
      await assertSingleRow(tab, size.id, size);
      await assertContrast(tab, size.id);
      await assertNoHorizontalClipping(tab, size.id);
      await shot(tab, size.id + '-header');

      await closeActionsEscape(tab);
      await restoreMenuFocus(tab, size.id + ' Escape');
      await assertDraftAndChat(tab, size.id + ' Escape', viewDraft);

      if (size.compact) {
        const ellipsis = await tab.evaluate(() => {
          const nodes = [...document.querySelectorAll('#chat-header button')].filter(node =>
            node.getClientRects().length > 0 && !document.querySelector('#hub-chat-actions')?.contains(node)
            && (node.id === 'hub-chat-more' || node.textContent.trim() === '⋯'));
          return { count: nodes.length, ids: nodes.map(node => node.id || node.textContent.trim()) };
        });
        check(size.id + ': compact header shares exactly one ⋯ control', ellipsis.count === 1, ellipsis);
      }

      await assertModelInSidebar(tab, size.id, { mobile: size.mobile, compact: size.compact });
      await closeActionsEscape(tab);

      await clickCenter(tab, '#btn-pending-questions').catch(async () => {
        await openActions(tab);
        await clickCenter(tab, '#btn-pending-questions');
      });
      const opened = await tab.waitForFunction(() => document.querySelector('#work-inbox')?.open === true, null, { timeout: 5000 }).then(() => true).catch(() => false);
      check(size.id + ': Work opens the inbox', opened);
      if (opened) {
        await shot(tab, size.id + '-work');
        await clickCenter(tab, '#work-close');
        const restored = await tab.waitForFunction(() => document.activeElement?.id === 'hub-chat-more', null, { timeout: 4000 }).then(() => true).catch(() => false);
        check(size.id + ': closing Work restores focus to ⋯', restored, await activeId(tab));
      }
    } catch (error) {
      check(size.id + ': viewport run completed without an exception', false, error.message);
      await shot(tab, size.id + '-failure');
      console.error(error.stack || error);
    } finally {
      await context.close();
    }
  }

  // -------------------------------------------------------------------------
  // Zero / inactive capability / tenant / no-model / auth scenarios
  // -------------------------------------------------------------------------
  const zeroContext = await makeContext(browser);
  const zeroPage = await zeroContext.newPage();
  zeroPage.on('pageerror', error => browserErrors.push('zero: ' + error.message));
  await ready(zeroPage, 'zero');
  await zeroPage.waitForFunction(() => document.querySelector('#chat-header[data-work-header]'), null, { timeout: 5000 }).catch(() => {});
  await assertHeaderChrome(zeroPage, 'zero');
  const zeroActions = await assertDisclosure(zeroPage, 'zero', { doc: true, skill: true, workPending: 0, skillPending: 0 });
  if (zeroActions) {
    check('zero: Work stays visible without a zero counter', !/\d/.test(zeroActions.work.countText), zeroActions.work.countText);
    check('zero: the Skill action remains available at zero pending reviews',
      zeroActions.skill.visible && zeroActions.skill.dataCount === '0', zeroActions.skill);
  }
  await closeActionsEscape(zeroPage);
  await clickCenter(zeroPage, '#hub-chat-more').catch(() => {});
  await zeroPage.waitForTimeout(60);
  await openActions(zeroPage);
  await clickCenter(zeroPage, '#btn-skill-review');
  const zeroDialog = await zeroPage.waitForFunction(() => document.querySelector('#skill-review-dialog')?.open === true, null, { timeout: 5000 }).then(() => true).catch(() => false);
  check('zero: Skill still opens its dialog without a pending count', zeroDialog);
  if (zeroDialog) {
    await zeroPage.keyboard.press('Escape');
    await zeroPage.waitForFunction(() => document.querySelector('#skill-review-dialog')?.open === false, null, { timeout: 3000 }).catch(() => {});
    await restoreMenuFocus(zeroPage, 'zero Skill close');
  }
  await zeroContext.close();

  const noWorkContext = await makeContext(browser);
  const noWorkPage = await noWorkContext.newPage();
  noWorkPage.on('pageerror', error => browserErrors.push('no-work: ' + error.message));
  await ready(noWorkPage, 'no-work');
  await noWorkPage.waitForTimeout(350);
  const noWork = await noWorkPage.evaluate(() => {
    const overview = document.querySelector('#btn-session-overview');
    const actions = document.querySelector('#hub-chat-actions');
    const header = document.querySelector('#chat-header .header-right');
    const more = document.querySelector('#hub-chat-more');
    const work = document.querySelector('#btn-pending-questions');
    return {
      dataHeader: !!document.querySelector('#chat-header[data-work-header]'),
      moreVisible: !!more && more.getClientRects().length > 0,
      workVisible: !!work && work.getClientRects().length > 0 && /Work|Mi trabajo/i.test(work.innerText || ''),
      overviewVisible: !!overview && overview.getClientRects().length > 0,
      overviewInHeader: !!overview && !!header && header.contains(overview) && !actions?.contains(overview)
        && overview.classList.contains('session-overview-toggle'),
      overviewExpanded: document.querySelector('#session-overview')?.classList.contains('expanded') === true,
      modelVisible: !!document.querySelector('#hub-chat-model') && document.querySelector('#hub-chat-model').getClientRects().length > 0,
      menuOpen: document.querySelector('#hub-chat-actions')?.hidden === false,
    };
  });
  check('no-work: capability off leaves no data-work-header', !noWork.dataHeader, noWork);
  check('no-work: no Work action or disclosure leaks without the capability',
    !noWork.moreVisible && !noWork.workVisible && !noWork.menuOpen, noWork);
  check('no-work: #btn-session-overview remains the same header control', noWork.overviewInHeader, noWork);
  await noWorkContext.close();

  // Outside the internal HUB header the compact overview toggle keeps its
  // pre-existing contract: it is the ⋯ shown when the visual viewport shrinks.
  const noWorkCompactContext = await makeContext(browser, {
    width: 390, height: 844, visualHeight: 340, visualTop: 30, isMobile: true, hasTouch: true,
  });
  const noWorkCompactPage = await noWorkCompactContext.newPage();
  noWorkCompactPage.on('pageerror', error => browserErrors.push('no-work-compact: ' + error.message));
  await ready(noWorkCompactPage, 'no-work');
  await noWorkCompactPage.waitForFunction(() => document.querySelector('#app')?.classList.contains('viewport-compact'), null, { timeout: 5000 }).catch(() => {});
  const noWorkCompact = await noWorkCompactPage.evaluate(() => ({
    compact: document.querySelector('#app')?.classList.contains('viewport-compact') === true,
    overviewVisible: !!document.querySelector('#btn-session-overview') && document.querySelector('#btn-session-overview').getClientRects().length > 0,
    moreVisible: !!document.querySelector('#hub-chat-more') && document.querySelector('#hub-chat-more').getClientRects().length > 0,
  }));
  check('no-work compact: the previous ⋯ overview control stays visible',
    noWorkCompact.compact && noWorkCompact.overviewVisible && !noWorkCompact.moreVisible, noWorkCompact);
  if (noWorkCompact.overviewVisible) {
    await clickCenter(noWorkCompactPage, '#btn-session-overview');
    await noWorkCompactPage.waitForTimeout(140);
    const expanded = await noWorkCompactPage.evaluate(() => document.querySelector('#session-overview')?.classList.contains('expanded') === true);
    check('no-work compact: #btn-session-overview still toggles the model overview', expanded);
  }
  await noWorkCompactContext.close();

  const noModelContext = await makeContext(browser);
  const noModelPage = await noModelContext.newPage();
  noModelPage.on('pageerror', error => browserErrors.push('no-model: ' + error.message));
  await ready(noModelPage, 'no-model');
  await noModelPage.waitForTimeout(350);
  const noModel = await noModelPage.evaluate(() => {
    const model = document.querySelector('#hub-chat-model');
    return {
      modelPresent: !!model,
      modelVisible: !!model && model.getClientRects().length > 0,
      moreVisible: !!document.querySelector('#hub-chat-more') && document.querySelector('#hub-chat-more').getClientRects().length > 0,
    };
  });
  check('no-model: #hub-chat-model is not offered without model/quota/context data',
    !noModel.modelVisible, noModel);
  check('no-model: the Work disclosure still works without model data', noModel.moreVisible, noModel);
  await noModelContext.close();

  const userContext = await makeContext(browser);
  const userPage = await userContext.newPage();
  userPage.on('pageerror', error => browserErrors.push('no-user: ' + error.message));
  await ready(userPage, 'no-user');
  const noUser = await userPage.evaluate(() => ({
    appHidden: document.querySelector('#app')?.classList.contains('hidden') === true,
    dataHeader: !!document.querySelector('#chat-header[data-work-header]'),
    skill: !!document.querySelector('#btn-skill-review'),
    docs: !!document.querySelector('#hub-documents-trigger') && !document.querySelector('#hub-documents-trigger').hidden,
    work: !!document.querySelector('#work-inbox')?.open,
    more: !!document.querySelector('#hub-chat-more') && document.querySelector('#hub-chat-more').getClientRects().length > 0,
    model: !!document.querySelector('#hub-chat-model') && document.querySelector('#hub-chat-model').getClientRects().length > 0,
    dialog: !!document.querySelector('#skill-review-dialog')?.open,
  }));
  check('no-user: the app stays on login with no header work state', noUser.appHidden && !noUser.dataHeader, noUser);
  check('no-user: no Work, Skill, Document or model content is exposed',
    !noUser.skill && !noUser.docs && !noUser.work && !noUser.more && !noUser.model && !noUser.dialog, noUser);
  await userContext.close();

  const tenantContext = await makeContext(browser);
  const tenantPage = await tenantContext.newPage();
  tenantPage.on('pageerror', error => browserErrors.push('tenant: ' + error.message));
  await ready(tenantPage, 'tenant');
  await tenantPage.waitForTimeout(350);
  await assertHeaderChrome(tenantPage, 'tenant');
  const tenantActions = await assertDisclosure(tenantPage, 'tenant', { doc: false, skill: false, workPending: 0, skillPending: 0 });
  if (tenantActions) {
    check('tenant: only the Work action is exposed for a client agent',
      tenantActions.work.visible && !tenantActions.doc.visible && !tenantActions.skill.visible, tenantActions);
  }
  const tenant = await tenantPage.evaluate(() => ({
    delivery: document.body.innerText.includes('Informe sintético.pdf'),
    dialog: !!document.querySelector('#skill-review-dialog')?.open,
  }));
  check('tenant: no synthetic delivery from another account is visible', !tenant.delivery, tenant);
  check('tenant: no skill dialog leaks from another account', !tenant.dialog, tenant);
  await tenantContext.close();

  check('all requests stayed loopback-only', external.length === 0, external.slice(0, 5));
  const unexpectedMutations = mutations.filter(item => item !== 'POST /logout');
  check('no document, work, skill or chat writes were performed', unexpectedMutations.length === 0, unexpectedMutations);
  check('Chromium reported no uncaught page errors', browserErrors.length === 0, browserErrors.slice(0, 5));
  if (browserErrors.length) console.log('BROWSER ERRORS', browserErrors);
  if (consoleErrors.length) console.log('CONSOLE ERRORS', consoleErrors.slice(0, 10));
} catch (error) {
  check('harness completed without an exception', false, error.message);
  console.error(error.stack || error);
  if (page && !page.isClosed()) await shot(page, 'failure').catch(() => {});
} finally {
  if (browser) await browser.close().catch(() => {});
  for (const socket of wss.clients) socket.terminate();
  await new Promise(resolve => wss.close(resolve));
  server.closeAllConnections?.();
  await new Promise(resolve => server.close(resolve));
}

const assetsAfter = assetFingerprint();
if (assetsBefore !== assetsAfter) {
  check('fixture assets stayed stable during the run', false, {
    before: assetsBefore.slice(0, 12), after: assetsAfter.slice(0, 12),
  });
}

const failed = results.filter(result => !result.ok);
console.log('Capturas sintéticas: ' + captureDir);
console.log('RESULTADO: ' + (failed.length ? failed.length + ' FALLOS' : 'TODO OK') + ' · ' + results.length + ' comprobaciones');
if (failed.length) {
  console.log('FALLOS: ' + failed.map(result => result.name).join(' | '));
  process.exitCode = 1;
}
