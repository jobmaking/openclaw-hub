#!/usr/bin/env node
// Gestión de usuarios de openclaw-hub (contraseñas hasheadas con scrypt).
//
//   node manage-users.js list
//   node manage-users.js set <usuario> [password]   (sin password = genera una)
//   node manage-users.js name <usuario> "Nombre visible"
//   node manage-users.js del <usuario>
//   node manage-users.js access <user> <agent,agent|*> <own|shared>
//   node manage-users.js scope <user> <agent> <own|shared|default>
//   node manage-users.js import <user> <agent,agent|*> <own|shared> < record.json
//
// Docker:  docker exec openclaw-hub node /app/manage-users.js list

'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || '/data';
const FILE = path.join(DATA_DIR, 'users.json');

function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `scrypt$${salt}$${crypto.scryptSync(plain, salt, 64).toString('hex')}`;
}
function load() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return []; }
}
function save(users) {
  fs.writeFileSync(FILE, JSON.stringify(users, null, 2), { mode: 0o600 });
  try { fs.chmodSync(FILE, 0o600); } catch {}
}

const [, , cmd, user, ...rest] = process.argv;
const users = load();
function policy(agents, scope) {
  if (!['own', 'shared'].includes(scope) || typeof agents !== 'string' || !agents) throw new Error('uso: <agent,agent|*> <own|shared>');
  const allowedAgents = agents === '*' ? null : [...new Set(agents.split(','))];
  if (allowedAgents?.some(id => !/^[a-zA-Z0-9_-]{1,80}$/.test(id))) throw new Error('invalid agent identifiers');
  return { allowedAgents, sessionScope: scope };
}
function applyPolicy(entry, parsed) {
  entry.sessionScope = parsed.sessionScope;
  if (parsed.allowedAgents === null) delete entry.allowedAgents; else entry.allowedAgents = parsed.allowedAgents;
}

if (cmd === 'list') {
  if (!users.length) { console.log('(sin usuarios)'); process.exit(0); }
  for (const u of users) {
    const kind = u.pw ? 'hash scrypt' : (u.p ? '⚠️ TEXTO PLANO' : '⚠️ sin password');
    console.log(`${u.u.padEnd(14)} ${String(u.name || '').padEnd(16)} ${kind}  agents=${Array.isArray(u.allowedAgents) ? u.allowedAgents.join(',') : '*'} sessions=${u.sessionScope || 'shared'} overrides=${JSON.stringify(u.sessionScopes || {})}`);
  }
} else if (cmd === 'set') {
  if (!user) { console.error('uso: set <usuario> [password]'); process.exit(1); }
  const pass = rest[0] || crypto.randomBytes(9).toString('base64url');
  let entry = users.find(x => x.u === user);
  if (!entry) { entry = { u: user, name: user }; users.push(entry); }
  entry.pw = hashPassword(pass);
  delete entry.p;
  save(users);
  console.log(`OK. usuario: ${user}  password: ${pass}`);
  console.log('Guárdala ahora: se almacena hasheada y no se puede recuperar.');
} else if (cmd === 'name') {
  const entry = users.find(x => x.u === user);
  if (!entry) { console.error('no existe:', user); process.exit(1); }
  entry.name = rest.join(' ') || entry.name;
  save(users);
  console.log('OK:', entry.u, '→', entry.name);
} else if (cmd === 'del') {
  const next = users.filter(x => x.u !== user);
  if (next.length === users.length) { console.error('no existe:', user); process.exit(1); }
  save(next);
  console.log('borrado:', user);
} else if (cmd === 'access') {
  const entry = users.find(x => x.u === user);
  if (!entry) { console.error('no existe:', user); process.exit(1); }
  applyPolicy(entry, policy(rest[0], rest[1]));
  save(users); console.log('OK: access policy updated for', user);
} else if (cmd === 'scope') {
  const entry = users.find(x => x.u === user), [agent, scope] = rest;
  if (!entry || !/^[a-zA-Z0-9_-]{1,80}$/.test(agent || '') || !['own', 'shared', 'default'].includes(scope)) throw new Error('uso: scope <user> <agent> <own|shared|default>');
  entry.sessionScopes = { ...entry.sessionScopes };
  if (scope === 'default') delete entry.sessionScopes[agent]; else entry.sessionScopes[agent] = scope;
  if (!Object.keys(entry.sessionScopes).length) delete entry.sessionScopes;
  save(users); console.log('OK: agent conversation scope updated for', user);
} else if (cmd === 'import') {
  if (!user || users.some(entry => entry.u === user)) throw new Error('Import requires a new username');
  const parsed = policy(rest[0], rest[1]);
  const source = JSON.parse(fs.readFileSync(0, 'utf8'));
  if (source.u !== user || typeof source.pw !== 'string' || !/^scrypt\$[a-f0-9]+\$[a-f0-9]{128}$/.test(source.pw)) throw new Error('A matching scrypt user record is required on stdin');
  const entry = { u: user, name: source.name || user, pw: source.pw };
  applyPolicy(entry, parsed); users.push(entry); save(users);
  console.log('OK: credential hash imported with access policy for', user);
} else if (cmd === 'legacy-storage') {
  const entry = users.find(x => x.u === user);
  if (!entry || !['on', 'off'].includes(rest[0])) throw new Error('uso: legacy-storage <user> <on|off>');
  entry.legacyStorageOwner = rest[0] === 'on'; save(users);
  console.log('OK: legacy browser storage migration', rest[0], 'for', user);
} else {
  console.log(`Uso:
  node manage-users.js list
  node manage-users.js set <usuario> [password]
  node manage-users.js name <usuario> "Nombre"
  node manage-users.js del <usuario>
  node manage-users.js access <user> <agent,agent|*> <own|shared>
  node manage-users.js scope <user> <agent> <own|shared|default>
  node manage-users.js import <user> <agent,agent|*> <own|shared> < record.json
  node manage-users.js legacy-storage <user> <on|off>`);
}
