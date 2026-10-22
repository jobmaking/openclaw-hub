'use strict';

const fs = require('node:fs');
const path = require('node:path');

function hubUrl(value) {
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('La dirección del Hub debe ser HTTP o HTTPS y no contener credenciales.');
  }
  return url;
}

function externalUrl(value) {
  try {
    if (typeof value !== 'string' || value.length > 8192 || /[\x00-\x1f\x7f]/.test(value)) return null;
    const url = new URL(value);
    if (!['https:', 'http:', 'mailto:'].includes(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch { return null; }
}

function sameOrigin(value, origin) {
  try { return new URL(value).origin === origin; } catch { return false; }
}

function hubDocument(value, target) {
  try {
    const url = new URL(value);
    return !url.username && !url.password && url.origin === target.origin
      && (url.pathname === target.pathname || url.pathname === target.pathname.replace(/\/?$/, '/') + 'index.html');
  } catch { return false; }
}

// A media permission is never a general camera/screen grant. Electron supplies
// different detail shapes for a permission check and the actual request.
function microphonePermission(permission, details = {}, request = false) {
  if (permission !== 'media' || details.isMainFrame !== true) return false;
  return request ? Array.isArray(details.mediaTypes) && details.mediaTypes.length === 1 && details.mediaTypes[0] === 'audio'
    : details.mediaType === 'audio';
}

function downloadLink(value, target) {
  const base = target instanceof URL ? target : new URL(target);
  const normalized = externalUrl(value);
  if (!normalized || !sameOrigin(normalized, base.origin) || hubDocument(normalized, base)) return null;
  const url = new URL(normalized);
  // File endpoints are explicit; other APIs must not be exported as downloads.
  // Non-API paths may be opaque download links with no filename/extension.
  if (url.pathname.startsWith('/api/') && !['/api/files', '/api/session-file', '/api/artifact-download'].includes(url.pathname)) return null;
  return normalized;
}

function safeFilename(value) {
  const base = path.basename(String(value || '').replaceAll('\\', '/'));
  return base.replace(/[\x00-\x1f\x7f]/g, '').replace(/^\.+/, '').replace(/[. ]+$/, '').slice(0, 180) || 'archivo';
}

function occupied(filename) {
  try { fs.lstatSync(filename); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function nextDownloadPath(directory, name, reserved = new Set()) {
  const clean = safeFilename(name);
  const extension = path.extname(clean);
  const stem = clean.slice(0, clean.length - extension.length);
  for (let suffix = 0; suffix < 10000; suffix++) {
    const candidate = path.join(directory, suffix ? `${stem} (${suffix})${extension}` : clean);
    if (!reserved.has(candidate) && !occupied(candidate)) return candidate;
  }
  throw new Error('Hay demasiados archivos con el mismo nombre. Elige otra carpeta.');
}

function readJson(filename, fallback) {
  try { return JSON.parse(fs.readFileSync(filename, 'utf8')); } catch { return fallback; }
}

function writeJson(filename, value) {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = filename + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, filename);
}

function restoreDownloads(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((entry) => entry && typeof entry.id === 'string' && typeof entry.path === 'string'
    && path.isAbsolute(entry.path) && typeof entry.name === 'string' && Number.isFinite(entry.startedAt))
    .slice(0, 100).map((entry) => ({
      id: entry.id, path: entry.path, name: entry.name, startedAt: entry.startedAt,
      received: Math.max(0, Number(entry.received) || 0), total: Math.max(0, Number(entry.total) || 0),
      state: ['completed', 'cancelled', 'interrupted'].includes(entry.state) ? entry.state : 'interrupted',
      paused: false, resumable: false, speed: 0,
    }));
}

function windowBounds(saved, displays) {
  const fallback = { width: 1360, height: 900 };
  if (!saved || !Number.isFinite(saved.width) || !Number.isFinite(saved.height)) return fallback;
  const bounds = {
    width: Math.max(860, Math.min(3840, Math.round(saved.width))),
    height: Math.max(580, Math.min(2160, Math.round(saved.height))),
  };
  if (Number.isFinite(saved.x) && Number.isFinite(saved.y) && displays.some(({ workArea: area }) =>
    saved.x + bounds.width > area.x + 120 && saved.x < area.x + area.width - 120
    && saved.y >= area.y && saved.y < area.y + area.height - 80)) {
    bounds.x = Math.round(saved.x); bounds.y = Math.round(saved.y);
  }
  return bounds;
}

module.exports = { hubUrl, externalUrl, sameOrigin, hubDocument, microphonePermission, downloadLink, safeFilename, nextDownloadPath, readJson, writeJson, restoreDownloads, windowBounds };
