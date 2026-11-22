'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { artifactMediaKind } = require('./artifact-routes');
const DAY = 86400000;
const WINDOW = 7;
const TRACK_AGE = 30 * DAY;
const GRACE = 20000;
const ROSTER_LIMIT = 30;
const SCAN_LIMIT = 18;
const ACTIVE_LIMIT = 30;
const FILE_LIMIT = 60;
const TRACK_LIMIT = 12;
const knownId = (value, limit = 1024) => typeof value === 'string' && value.length <= limit && value.trim() === value && value.length > 0 && !/[\x00-\x1f\x7f]/u.test(value);
const plain = (value, max) => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/gu, ' ').trim().slice(0, max) : '';
const time = value => Number.isSafeInteger(value) && value > 0 && value <= 8640000000000000 ? value : 0;
const scope = (agent, key, sid) => JSON.stringify([agent, key, sid]);

function mountWorkInbox(app, { enabled, requireAuth, getLinks, access, documents, sessionKind, activityAt, observe, dataDir, now = Date.now }) {
  const prefix = '/api/work-inbox';
  const inflight = new Map();
  const rosters = new Map();
  let db, rpcPending = 0;
  const guard = (req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    if (!enabled) return res.status(403).json({ error: 'Mi trabajo no está habilitado en este Hub' });
    next();
  };
  function store() {
    if (db) return db;
    const dir = path.join(dataDir, 'work-inbox');
    fs.mkdirSync(dir, { mode: 0o700, recursive: true });
    const entry = fs.lstatSync(dir);
    if (!entry.isDirectory() || (entry.mode & 0o077)) throw new Error('Invalid work inbox directory');
    const file = path.join(dir, 'following.sqlite3');
    try {const fd=fs.openSync(file,'wx',0o600);fs.closeSync(fd);}catch(error){if(error.code!=='EEXIST')throw error;}
    const state=fs.lstatSync(file);
    if(!state.isFile()||(state.mode&0o077))throw new Error('Invalid work inbox database');
    db = new DatabaseSync(file);
    try {
      db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=1000; '+
        'CREATE TABLE IF NOT EXISTS following (account TEXT NOT NULL, agent TEXT NOT NULL, key TEXT NOT NULL, sid TEXT NOT NULL, run TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(account,agent,key,sid,run)); '+
        'CREATE INDEX IF NOT EXISTS following_age ON following(at);');
      return db;
    } catch (error) { db.close(); db = null; throw error; }
  }
  // One device cannot fan out unbounded Gateway queries by reopening the drawer.
  function rpc(call) {
    if (rpcPending >= 18) return Promise.reject(new Error('Work inbox is busy'));
    rpcPending++;
    return Promise.resolve().then(call).finally(() => { rpcPending--; });
  }
  async function batches(items, limit, fn) {
    const out = []; let i = 0;
    await Promise.all(Array.from({ length: Math.min(items.length, limit) }, async () => {
      while (i < items.length) { const n = i++; out[n] = await fn(items[n]); }
    }));
    return out;
  }
  function fast(call, wait = 3300) {
    let timer;
    return Promise.race([call, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Work inbox source timed out')), wait); })]).finally(() => clearTimeout(timer));
  }
  function roster(link) {
    if (rosters.has(link.id)) return rosters.get(link.id);
    const task = rpc(() => link.sessions()).finally(() => { if (rosters.get(link.id) === task) rosters.delete(link.id); });
    rosters.set(link.id, task);
    return task;
  }
  const admitted = (user, link, row) => knownId(row?.key) && knownId(row?.sessionId) &&
    sessionKind(row) === 'session' && access.validRow(link, row.key, row) && access.canKnown(user, link, row.key);
  const make = (link, row) => ({ agent: link.id, key: row.key, sessionId: row.sessionId,
    title: plain(row.label || row.displayName, 180) || 'Conversación sin título', updatedAt: time(activityAt(row)) });
  function observed(link, row) {
    const view = observe(link.id, row.key);
    return view?.connected === true && view.stale !== true ? view : null;
  }
  async function describe(user, link, item) {
    if (!link.connected || !access.canKnown(user, link, item.key)) return null;
    const r = await rpc(() => link.req('sessions.describe', { key: item.key }, 2200));
    const row = r?.ok && r.payload?.session;
    return admitted(user, link, row) && row.key === item.key && row.sessionId === item.sessionId ? row : null;
  }
  function fileEntry(value, item, local = false) {
    if (!knownId(value?.id) || (!local && !['bytes', 'url'].includes(value.download?.mode)) ||
        (value.sessionKey && value.sessionKey !== item.key)) return null;
    const name = plain(plain(value.fileName || value.title,1024).split(/[\\/]/u).at(-1), 180) || 'Archivo';
    const mediaKind = !local && artifactMediaKind(value.mimeType);
    return { id: value.id, title: name, source: local ? 'document' : 'agent',
      ...(mediaKind ? { mediaKind } : {}),
      ...(knownId(value.runId) && !local ? { runId: value.runId } : {}),
      ...(time(value.messageSeq) ? { order: value.messageSeq } : {}),
      ...(time(value.createdAt) && local ? { at: value.createdAt } : {}) };
  }
  async function files(req, candidate) {
    const { link, item } = candidate;
    // Bracket the metadata read with the canonical transcript, not just the reusable session key.
    const first = await describe(req.user, link, item);
    if (!first) return null;
    const target = { id: link.id, link, key: item.key, row: first };
    const local = documents?.localArtifacts(req, target) || [];
    const result = await rpc(() => link.req('artifacts.list', { sessionKey: item.key, agentId: link.cfg.gatewayAgentId || 'main', messageRole: 'assistant' }, 2700));
    const last = await describe(req.user, link, item);
    if (!last) return null;
    const validList = result?.ok && Array.isArray(result.payload?.artifacts);
    const data = [...local.map(file => fileEntry(file, item, true)),
      ...(validList ? result.payload.artifacts.map(file => fileEntry(file, item)) : [])].filter(Boolean);
    const unique = [...new Map(data.map(file => [file.id, file])).values()];
    unique.sort((a, b) => (b.at || 0) - (a.at || 0) || (b.order || 0) - (a.order || 0));
    return { files: unique, row: last, complete: Boolean(validList && !result.payload.omittedOversized && !result.payload.nextCursor) };
  }
  function followState(link, row, tracked, read, t) {
    if (!read) return 'unverified';
    if (read.files.some(file => file.runId === tracked.run)) return 'delivered';
    if (!read.complete) return 'unverified';
    const view = observed(link, row), run = view?.runs?.find(r => r.runId === tracked.run);
    if (read.row.hasActiveRun === true && view?.activeRunId === tracked.run) return 'waiting';
    if (['error', 'failed', 'aborted', 'cancelled', 'interrupted'].includes(run?.status)) return 'interrupted';
    const ended = time(run?.endedAt) || time(run?.updatedAt);
    if (['done', 'completed'].includes(run?.status) && ended && read.row.hasActiveRun === false && !run.uncertain) return t - ended < GRACE ? 'settling' : 'missing';
    return 'unverified';
  }
  async function snapshot(req) {
    const t = now(), deadline = t + 8200;
    let partial = false, more = false;
    const links = getLinks().filter(l => access.canAgent(req.user, l.id));
    const tracked = store().prepare('SELECT agent,key,sid,run FROM following WHERE account=? AND at>=? ORDER BY at DESC LIMIT ?').all(req.user, t - TRACK_AGE, TRACK_LIMIT);
    const byLink = await batches(links, 8, async link => {
      if (!link.connected || now() >= deadline) { partial = true; return []; }
      try {
        const raw = await fast(roster(link), Math.max(1, Math.min(3200, deadline - now())));
        if (!link.connected) { partial = true; return []; }
        return raw.filter(row => admitted(req.user, link, row)).map(row => ({ link, row, item: make(link, row) }));
      } catch { partial = true; return []; }
    });
    const candidates = byLink.flat().sort((a, b) => b.item.updatedAt - a.item.updatedAt);
    const tracks = new Map();
    for (const item of tracked) {
      const key = scope(item.agent, item.key, item.sid);
      if (!tracks.has(key)) tracks.set(key, []);
      tracks.get(key).push(item);
    }
    const identity = item => scope(item.agent, item.key, item.sessionId);
    const live = candidates.filter(c => c.row.hasActiveRun === true);
    const active = live.slice(0, ACTIVE_LIMIT).map(({link, row, item}) => {
      const id = observed(link, row)?.activeRunId;
      return { ...item, trackable: knownId(id), ...(knownId(id) ? { runId:id } : {}) };
    });
    const recent = candidates.filter(c => c.item.updatedAt >= t - WINDOW * DAY);
    const relevant = candidates.filter(c => tracks.has(identity(c.item)));
    const sample = new Map(relevant.map(c => [identity(c.item), c]));
    // Give each authorized agent a place before filling the remaining budget by recency.
    for (const group of byLink) {
      const best = group.filter(c => c.item.updatedAt >= t - WINDOW * DAY).sort((a, b) => b.item.updatedAt - a.item.updatedAt)[0];
      if (best && sample.size < SCAN_LIMIT) sample.set(identity(best.item), best);
    }
    for (const c of recent) if (sample.size < SCAN_LIMIT) sample.set(identity(c.item), c);
    if (recent.some(c => !sample.has(identity(c.item))) || live.length > ACTIVE_LIMIT) more = true;
    const reads = await batches([...sample.values()], 6, async c => {
      if (now() >= deadline) { partial = true; return [c, null]; }
      try {
        const read = await fast(files(req, c), Math.max(1, Math.min(4300, deadline - now())));
        if (!read?.complete) partial = true;
        return [c, read];
      } catch { partial = true; return [c, null]; }
    });
    const deliveries = [], following = [];
    for (const [{link, row, item}, read] of reads) {
      if (!access.canKnown(req.user, link, item.key)) continue;
      const list = tracks.get(identity(item)) || [];
      for (const track of list) following.push({ ...item, runId: track.run, status: followState(link, row, track, read, t) });
      if (!read) continue;
      if (read.files.length > ROSTER_LIMIT) more = true;
      for (const { runId, order, at, ...file } of read.files.slice(0, ROSTER_LIMIT)) deliveries.push({ ...item, file, canDownload:documents?.granted(req.user, link.id) === true });
    }
    if (deliveries.length > FILE_LIMIT) more = true;
    return { active:active.filter(item => candidates.some(c => c.item.key === item.key && c.item.agent === item.agent && access.canKnown(req.user, c.link, item.key))),
      deliveries:deliveries.sort((a,b)=>b.updatedAt-a.updatedAt).slice(0,FILE_LIMIT), following, partial, more, windowDays: WINDOW, checkedAt:t };
  }
  app.get(prefix, requireAuth, guard, async (req, res) => {
    try {
      let task = inflight.get(req.user);
      if (!task) {
        if (inflight.size >= 4) return res.status(503).json({error:'La bandeja está ocupada. Vuelve a intentar en unos segundos.'});
        task = snapshot(req).finally(() => inflight.delete(req.user));
        inflight.set(req.user, task);
      }
      res.json(await task);
    } catch { res.status(503).json({ error: 'No se pudo actualizar Mi trabajo' }); }
  });
  app.get(prefix + '/session', requireAuth, guard, async (req,res) => {
    const { agent, key, sessionId } = req.query;
    if (!knownId(agent,80) || ![key,sessionId].every(id => knownId(id))) return res.status(400).json({error:'Conversación inválida'});
    const link = getLinks().find(l => l.id === agent);
    if (!link || !access.canKnown(req.user,link,key)) return res.status(403).json({error:'Esta conversación no está disponible'});
    try {
      if(!await describe(req.user,link,{key,sessionId}))return res.status(409).json({error:'La conversación ha cambiado; actualiza la bandeja.'});
      res.json({sessionId});
    } catch { res.status(503).json({error:'No se pudo comprobar la conversación'}); }
  });
  app.post(prefix + '/track', requireAuth, guard, async (req, res) => {
    if (req.get('x-hub-work') !== '1' || !req.is('application/json') || req.get('sec-fetch-site') === 'cross-site') return res.status(403).json({error:'Acción no autorizada'});
    const { agent, key, sessionId, action, runId } = req.body || {};
    if (!knownId(agent,80) || ![key,sessionId,runId].every(id => knownId(id)) || !['track','untrack'].includes(action)) return res.status(400).json({error:'Seguimiento inválido'});
    const link = getLinks().find(l=>l.id===agent);
    if (!link || !access.canKnown(req.user, link, key)) return res.status(403).json({error:'Esta conversación no está disponible'});
    try {
      const args = [req.user,agent,key,sessionId,runId], db = store();
      if (action === 'untrack') {
        db.prepare('DELETE FROM following WHERE account=? AND agent=? AND key=? AND sid=? AND run=?').run(...args);
      } else {
        const row = await describe(req.user,link,{key,sessionId});
        if (!row || row.hasActiveRun !== true || observed(link,row)?.activeRunId !== runId) return res.status(409).json({error:'Este turno ya cambió. Actualiza la bandeja antes de seguirlo.'});
        const t = now(); db.exec('BEGIN IMMEDIATE');
        try {
          db.prepare('DELETE FROM following WHERE at<?').run(t - TRACK_AGE);
          const existing=db.prepare('SELECT 1 FROM following WHERE account=? AND agent=? AND key=? AND sid=? AND run=?').get(...args);
          if(!existing && db.prepare('SELECT count(*) AS n FROM following WHERE account=?').get(req.user).n>=TRACK_LIMIT){
            db.exec('ROLLBACK');return res.status(409).json({error:'Ya sigues 12 entregas. Deja de seguir alguna antes de añadir otra.'});
          }
          if(!existing)db.prepare('INSERT INTO following VALUES (?,?,?,?,?,?)').run(...args,t);
          db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
      }
      res.json({ ok:true });
    } catch { res.status(503).json({error:'No se pudo confirmar el seguimiento'}); }
  });
}

module.exports = { mountWorkInbox };
