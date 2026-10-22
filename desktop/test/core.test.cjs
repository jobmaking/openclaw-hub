'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { hubUrl, externalUrl, sameOrigin, hubDocument, microphonePermission, downloadLink, safeFilename, nextDownloadPath, restoreDownloads, writeJson, readJson, windowBounds } = require('../core.cjs');

test('microphone permission never authorizes cameras, screens, unknown media or subframes', () => {
  assert.equal(microphonePermission('media', { isMainFrame: true, mediaType: 'audio' }), true);
  assert.equal(microphonePermission('media', { isMainFrame: true, mediaTypes: ['audio'] }, true), true);
  for (const mediaType of ['video', 'unknown', undefined]) assert.equal(microphonePermission('media', { isMainFrame: true, mediaType }), false);
  for (const mediaTypes of [[], ['video'], ['audio', 'video'], ['audio', 'audio'], undefined]) assert.equal(microphonePermission('media', { isMainFrame: true, mediaTypes }, true), false);
  for (const isMainFrame of [false, undefined]) {
    assert.equal(microphonePermission('media', { isMainFrame, mediaType: 'audio' }), false);
    assert.equal(microphonePermission('media', { isMainFrame, mediaTypes: ['audio'] }, true), false);
  }
  for (const permission of ['display-capture', 'mediaKeySystem', 'camera', 'geolocation', 'unknown']) assert.equal(microphonePermission(permission, { isMainFrame: true, mediaTypes: ['audio'], mediaType: 'audio' }, true), false);
});

test('remote content cannot hand file, script or shell URLs to the desktop', () => {
  for (const value of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,test', 'ssh://root@host', 'vscode://file/etc/passwd', 'https://user:pass@host/', 'https://host/\ncommand']) assert.equal(externalUrl(value), null);
  assert.equal(externalUrl('https://example.com/file.pdf'), 'https://example.com/file.pdf');
  assert.equal(externalUrl('mailto:person@example.com'), 'mailto:person@example.com');
  assert.throws(() => hubUrl('file:///etc/passwd'));
  assert.throws(() => hubUrl('https://user:pass@host/'));
  assert.equal(sameOrigin('https://hub.example.evil/', 'https://hub.example'), false);
  assert.equal(sameOrigin('https://hub.example:444/', 'https://hub.example'), false);
});

test('file endpoints cannot replace the app document or redirect downloads outside the Hub', () => {
  const target = hubUrl('https://hub.example/');
  assert.equal(hubDocument('https://hub.example/#conversation', target), true);
  assert.equal(hubDocument('https://hub.example/index.html', target), true);
  assert.equal(hubDocument('https://hub.example/api/session-file?path=report.json', target), false);
  assert.equal(hubDocument('https://attacker.example/', target), false);
  assert.equal(hubDocument('https://user:pass@hub.example/', target), false);
  for (const suffix of ['/api/files?path=uploads/a', '/api/session-file?path=report.json', '/api/artifact-download?id=test', '/downloads/setup.exe', '/downloads/config.json']) {
    const url = target.origin + suffix;
    assert.equal(downloadLink(url, target.origin), url);
  }
  for (const value of ['https://hub.example/', 'https://hub.example/api/me', 'https://attacker.example/setup.exe', 'file:///tmp/setup.exe', 'https://user:pass@hub.example/config.json', 'not a URL']) assert.equal(downloadLink(value, target.origin), null);
});

test('download names remain inside the selected folder, including Windows paths', () => {
  for (const value of ['../../private.key', '..\\..\\private.key', '/etc/passwd', '../.config', '...']) {
    const name = safeFilename(value);
    assert.ok(name.length > 0 && !name.startsWith('.') && !name.includes('/') && !name.includes('\\'));
  }
  assert.equal(safeFilename('informe jurídico.pdf'), 'informe jurídico.pdf');
  assert.equal(safeFilename('a\u0000b.txt'), 'ab.txt');
});

test('existing files, broken symlinks and concurrent downloads are never reused', (context) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-paths-'));
  context.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  fs.writeFileSync(path.join(folder, 'informe.pdf'), 'do not overwrite');
  fs.symlinkSync(path.join(folder, 'missing'), path.join(folder, 'informe (1).pdf'));
  const reserved = new Set([path.join(folder, 'informe (2).pdf')]);
  assert.equal(nextDownloadPath(folder, '../informe.pdf', reserved), path.join(folder, 'informe (3).pdf'));
  assert.equal(fs.readFileSync(path.join(folder, 'informe.pdf'), 'utf8'), 'do not overwrite');
});

test('restart does not claim unfinished downloads completed or resumable', () => {
  const history = restoreDownloads([{ id: 'a', name: 'a.pdf', path: '/tmp/a.pdf', startedAt: 1, state: 'progressing', received: 7, total: 20, resumable: true },
    { id: 'b', name: 'b.pdf', path: '/tmp/b.pdf', startedAt: 2, state: 'completed', received: 20, total: 20 },
    { id: 'invalid', name: 'bad', path: '../../etc/passwd', startedAt: 2 }]);
  assert.equal(history.length, 2); assert.equal(history[0].state, 'interrupted'); assert.equal(history[0].resumable, false);
  assert.equal(history[1].state, 'completed'); assert.equal(restoreDownloads(null).length, 0);
});

test('preferences are atomic and private; corruption falls back safely', (context) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-settings-'));
  context.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const filename = path.join(folder, 'settings.json');
  writeJson(filename, { zoom: 1.2 }); assert.deepEqual(readJson(filename, {}), { zoom: 1.2 });
  assert.equal(fs.statSync(filename).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(filename + '.tmp'), false);
  fs.writeFileSync(filename, 'broken'); assert.deepEqual(readJson(filename, {}), {});
});

test('a removed display never strands the window off-screen', () => {
  const displays = [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }];
  assert.deepEqual(windowBounds({ x: 4000, y: 0, width: 1200, height: 800 }, displays), { width: 1200, height: 800 });
  assert.deepEqual(windowBounds({ x: 100, y: 20, width: 1200, height: 800 }, displays), { x: 100, y: 20, width: 1200, height: 800 });
});
