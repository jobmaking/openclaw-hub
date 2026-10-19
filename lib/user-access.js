'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const validKey = key => typeof key === 'string' && key.length > 0 && key.length <= 1024 && !/[\u0000-\u001f]/.test(key);
const parentOf = row => row.parentSessionKey || row.spawnedBy || row.controlOwnerSessionKey || row.forkSource?.key || null;

// This is a Hub conversation boundary, not an OS/workspace sandbox for the agent.
// Only confirmed creations assign an owner. Opening, sending or listing never do.
class UserAccess {
  constructor({ dataDir, users, keyAllowed = () => true }) {
    this.users = users;
    this.keyAllowed = keyAllowed;
    this.file = path.join(dataDir, 'session-owners.json');
    this.rows = new Map();
    this.owners = Object.create(null);
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (saved.version !== 1 || !saved.owners || Array.isArray(saved.owners) || typeof saved.owners !== 'object'
          || Object.entries(saved.owners).some(([identity, owner]) => {
            let parts; try { parts = JSON.parse(identity); } catch { return true; }
            return !Array.isArray(parts) || parts.length !== 2 || !/^[a-zA-Z0-9_-]{1,80}$/.test(parts[0])
              || !validKey(parts[1]) || typeof owner !== 'string' || !owner;
          })) throw new Error('Invalid session ownership registry');
      Object.assign(this.owners, saved.owners);
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('Cannot safely load session ownership registry: ' + error.message);
    }
  }

  user(name) { return typeof name === 'string' ? this.users().find(user => user.u === name) : null; }
  validPolicy(user) {
    if (!user || Object.hasOwn(user, 'sessionScope') && !['own', 'shared'].includes(user.sessionScope)) return false;
    const scopes = user.sessionScopes;
    return scopes === undefined || scopes && typeof scopes === 'object' && !Array.isArray(scopes)
      && Object.entries(scopes).every(([agent, scope]) => /^[a-zA-Z0-9_-]{1,80}$/.test(agent) && ['own', 'shared'].includes(scope));
  }
  privateOnly(name, agent) {
    const user = this.user(name);
    if (!this.validPolicy(user)) return true;
    if (agent) return (user.sessionScopes?.[agent] || user.sessionScope || 'shared') === 'own';
    return user.sessionScope === 'own' || Object.values(user.sessionScopes || {}).includes('own');
  }
  isolationEnabled(agent) {
    return this.users().some(user => this.privateOnly(user.u, agent))
      || Object.keys(this.owners).some(identity => !agent || JSON.parse(identity)[0] === agent);
  }
  canAgent(name, agent) {
    const user = this.user(name);
    if (!this.validPolicy(user) || !agent) return false;
    if (!Object.hasOwn(user, 'allowedAgents')) return true;
    return Array.isArray(user.allowedAgents) && user.allowedAgents.every(id => typeof id === 'string' && id.length > 0)
      && user.allowedAgents.includes(agent);
  }
  identity(link, key) { return JSON.stringify([link.id, key]); }
  inScope(link, key) {
    return validKey(key) && this.keyAllowed(key) && (!key.startsWith('agent:') || key.startsWith('agent:' + (link.cfg.gatewayAgentId || 'main') + ':'));
  }
  validRow(link, key, row) {
    return row && row.key === key && this.inScope(link, key) && (!row.agentId || row.agentId === (link.cfg.gatewayAgentId || 'main'));
  }
  recordRows(link, rows) {
    this.rows.set(link.id, new Map(rows.filter(row => this.validRow(link, row?.key, row)).map(row => [row.key, row])));
  }
  knownOwner(link, key) {
    const seen = new Set(), rows = this.rows.get(link.id);
    for (let depth = 0; depth < 32; depth++) {
      if (!this.inScope(link, key) || seen.has(key)) return { valid: false };
      seen.add(key);
      const owner = this.owners[this.identity(link, key)];
      if (owner) return { valid: true, owner };
      const row = rows?.get(key);
      if (!row) return { valid: false, unknown: true };
      const parent = parentOf(row);
      if (!parent) return { valid: true, owner: null };
      key = parent;
    }
    return { valid: false };
  }
  canKnown(name, link, key) {
    if (!this.canAgent(name, link?.id) || !this.inScope(link, key)) return false;
    const result = this.knownOwner(link, key);
    return result.valid && (result.owner ? result.owner === name : !this.privateOnly(name, link.id));
  }
  async authorize(name, link, key) {
    if (!link || !this.canAgent(name, link.id) || !this.inScope(link, key)) return false;
    let current = key;
    const seen = new Set();
    let rows = this.rows.get(link.id);
    if (!rows) { rows = new Map(); this.rows.set(link.id, rows); }
    for (let depth = 0; depth < 32; depth++) {
      if (!this.inScope(link, current) || seen.has(current)) return false;
      seen.add(current);
      const owner = this.owners[this.identity(link, current)];
      if (owner) return owner === name;
      let row = rows.get(current);
      if (!row) {
        try {
          const result = await link.req('sessions.describe', { key: current }, 8000);
          if (!result.ok || !this.validRow(link, current, result.payload?.session)) return false;
          row = result.payload.session;
          rows.set(current, row);
        } catch { return false; }
      }
      const parent = parentOf(row);
      if (!parent) return !this.privateOnly(name, link.id);
      current = parent;
    }
    return false;
  }
  claim(name, link, key) {
    if (!this.canAgent(name, link.id) || !this.inScope(link, key)) throw new Error('Invalid owner or session returned by Gateway');
    // Shared-only deployments retain their existing team workflow. Ownership
    // becomes active when an own-only account is configured, never retroactively.
    if (!this.isolationEnabled(link.id)) return;
    const identity = this.identity(link, key), previous = this.owners[identity];
    if (previous && previous !== name) throw new Error('The Gateway returned a session already owned by another user');
    if (previous) return;
    const owners = { ...this.owners, [identity]: name };
    const temporary = this.file + '.' + crypto.randomUUID() + '.tmp';
    try {
      fs.writeFileSync(temporary, JSON.stringify({ version: 1, owners }, null, 2), { mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, this.file);
      this.owners = owners;
    } catch (error) {
      try { fs.unlinkSync(temporary); } catch {}
      throw error;
    }
  }
  namespaced(name, agent, value, kind) {
    return 'hub-' + kind + '-' + crypto.createHash('sha256').update(JSON.stringify([name, agent, value])).digest('hex');
  }
  canUpload(name, file, targetAgent) {
    if (!this.validPolicy(this.user(name)) || targetAgent && !this.canAgent(name, targetAgent)) return false;
    const legacyShared = () => !this.isolationEnabled() && this.users().every(user => !Object.hasOwn(user, 'allowedAgents'));
    if (!file) return legacyShared();
    if (file.owner === name) return true;
    const agents = Array.isArray(file.agents) ? file.agents : typeof file.agent === 'string' ? [file.agent] : null;
    // The source is trusted metadata, never an agent supplied with a download.
    if (agents) return agents.some(agent => (!targetAgent || agent === targetAgent)
      && this.canAgent(name, agent) && !this.isolationEnabled(agent));
    return legacyShared();
  }
}

module.exports = { UserAccess };
