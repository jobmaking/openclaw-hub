'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const multer = require('multer');
const { transcriptIdentity } = require('./agent-questions');

const MAX_BYTES = 25 * 1024 * 1024;
const MAX_SPEECH_CHARS = 6000;
const ID = /^[a-f0-9]{32}$/;
const AUDIO_TYPES = new Map([
  ['audio/webm', 'webm'], ['audio/ogg', 'ogg'], ['audio/mp4', 'm4a'],
  ['audio/x-m4a', 'm4a'], ['audio/m4a', 'm4a'], ['audio/wav', 'wav'],
  ['audio/x-wav', 'wav'], ['audio/mpeg', 'mp3'], ['audio/mp3', 'mp3'],
]);
const valid = (value, max = 1024) => typeof value === 'string' && !!value.trim() && value.length <= max && !/[\u0000-\u001f]/.test(value);
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const identity = (...parts) => JSON.stringify(parts);
const failure = (message, status = 400, code = 'INVALID_REQUEST') => Object.assign(new Error(message), { status, code });

function phaseOf(message) {
  if (['commentary', 'final_answer'].includes(message?.phase)) return message.phase;
  const phases = new Set();
  for (const block of Array.isArray(message?.content) ? message.content : []) {
    if (block?.type !== 'text' || typeof block.textSignature !== 'string' || !block.textSignature.startsWith('{')) continue;
    try {
      const signature = JSON.parse(block.textSignature);
      if (signature.v === 1 && ['commentary', 'final_answer'].includes(signature.phase)) phases.add(signature.phase);
    } catch {}
  }
  return phases.size === 1 ? [...phases][0] : null;
}

function authoredText(message) {
  if (typeof message?.content === 'string') return message.content;
  const blocks = (Array.isArray(message?.content) ? message.content : []).filter(block => block?.type === 'text' && typeof block.text === 'string');
  const explicit = blocks.map(block => {
    try { const value = JSON.parse(block.textSignature); return value.v === 1 ? value.phase : null; } catch { return null; }
  });
  const hasFinal = explicit.includes('final_answer');
  return blocks.filter((block, index) => !hasFinal || explicit[index] === 'final_answer').map(block => block.text).join('');
}

function spokenText(source, maximum = MAX_SPEECH_CHARS) {
  let omittedCode = false, fenced = null;
  const lines = [];
  for (const line of String(source || '').split('\n')) {
    const fence = line.match(/^\s*(`{3,}|~{3,})/);
    if (fence) {
      if (!fenced) { fenced = fence[1][0]; omittedCode = true; lines.push('El código está disponible en el texto.'); }
      else if (fence[1][0] === fenced) fenced = null;
      continue;
    }
    if (fenced || /^\s*MEDIA:\s*\S+/.test(line)) continue;
    if (/^\s*\|?.+\|.+\|?\s*$/.test(line) && line.includes('|')) {
      if (lines.at(-1) !== 'La tabla está disponible en el texto.') lines.push('La tabla está disponible en el texto.');
      continue;
    }
    lines.push(line);
  }
  let text = lines.join('\n')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/[^\s<>]+/g, '')
    .replace(/<[^>]*>/g, '')
    .replace(/^[ \t]*(?:#{1,6}\s+|>\s*|[-+*]\s+|\d+[.)]\s+)/gm, '')
    .replace(/[`*_~]/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();
  const totalChars = text.length;
  const truncated = totalChars > maximum;
  if (truncated) {
    const prefix = text.slice(0, maximum - 60);
    const end = Math.max(prefix.lastIndexOf('. '), prefix.lastIndexOf('.\n'), prefix.lastIndexOf('? '), prefix.lastIndexOf('! '));
    text = (end > maximum * 0.65 ? prefix.slice(0, end + 1) : prefix.replace(/\s+\S*$/, '')) + '\nLa respuesta completa está en el texto.';
  }
  return { text, omittedCode, truncated, totalChars, spokenChars: text.length };
}

function readConfig(filename, disabled) {
  if (disabled) return { nodes: {}, agents: {} };
  let source;
  try { source = JSON.parse(fs.readFileSync(filename, 'utf8')); }
  catch (error) { return { nodes: {}, agents: {}, invalid: error.code !== 'ENOENT' }; }
  try {
    if (source.version !== 1 || !source.nodes || !source.agents || Array.isArray(source.nodes) || Array.isArray(source.agents)) throw new Error();
    const nodes = Object.create(null), agents = Object.create(null);
    for (const [name, node] of Object.entries(source.nodes)) {
      const url = new URL(node.url);
      if (!/^[a-z0-9_-]{1,80}$/i.test(name) || url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname)
        || url.username || url.password || url.search || url.hash || url.pathname !== '/' || !valid(node.token, 256) || node.token.length < 32
        || /\s/.test(node.token) || !['ef_dora', 'em_alex', 'em_santa'].includes(node.voice || 'ef_dora')) throw new Error();
      nodes[name] = { url: url.origin, token: node.token, voice: node.voice || 'ef_dora' };
    }
    for (const [agent, node] of Object.entries(source.agents)) {
      if (!/^[a-z0-9_-]{1,80}$/i.test(agent) || typeof node !== 'string' || !Object.hasOwn(nodes, node)) throw new Error();
      agents[agent] = node;
    }
    return { nodes, agents };
  } catch { return { nodes: {}, agents: {}, invalid: true }; }
}

async function boundedBytes(response, maximum, controller) {
  const declared = Number(response.headers.get('content-length'));
  if (declared > maximum) { controller?.abort(); throw failure('El audio generado supera el límite permitido.', 413, 'AUDIO_TOO_LARGE'); }
  const chunks = []; let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > maximum) { controller?.abort(); throw failure('El audio generado supera el límite permitido.', 413, 'AUDIO_TOO_LARGE'); }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, length);
}

class VoiceRoutes {
  constructor(options) {
    this.options = options;
    this.config = readConfig(options.configFile || path.join(options.dataDir, 'voice.json'), options.disabled);
    this.directory = path.join(options.dataDir, 'voice');
    this.entries = new Map(); this.pending = new Map(); this.finals = new Map(); this.rates = new Map();
    if (Object.keys(this.config.agents).length) {
      fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      fs.chmodSync(this.directory, 0o700);
      for (const name of fs.readdirSync(this.directory)) {
        if (!/^[a-f0-9]{32}\.json$/.test(name)) continue;
        try {
          const entry = JSON.parse(fs.readFileSync(path.join(this.directory, name), 'utf8'));
          if (ID.test(entry.id) && entry.id + '.json' === name && ['input', 'speech'].includes(entry.kind)
            && valid(entry.owner) && valid(entry.agent, 80) && valid(entry.key) && valid(entry.sessionId, 512)) this.entries.set(entry.id, entry);
        } catch {}
      }
    }
  }

  node(agent) { return this.config.nodes[this.config.agents[agent]] || null; }
  audioUrl(entry) { return '/api/voice/audio?' + new URLSearchParams({ agent: entry.agent, key: entry.key, id: entry.id }); }
  publicEntry(entry) {
    return { id: entry.id, audioUrl: this.audioUrl(entry), ...(Number.isFinite(entry.duration) ? { duration: entry.duration } : {}),
      ...(entry.kind === 'speech' ? { omittedCode: !!entry.omittedCode, truncated: !!entry.truncated, spokenChars: entry.spokenChars, totalChars: entry.totalChars } : {}) };
  }
  save(entry, bytes) {
    const filename = path.join(this.directory, entry.id);
    if (bytes) {
      fs.writeFileSync(filename + '.audio.tmp', bytes, { mode: 0o600 });
      fs.renameSync(filename + '.audio.tmp', filename + '.audio');
    }
    fs.writeFileSync(filename + '.json.tmp', JSON.stringify(entry), { mode: 0o600 });
    fs.renameSync(filename + '.json.tmp', filename + '.json');
    this.entries.set(entry.id, entry);
  }
  fail(res, error, fallback) {
    if (res.headersSent || res.destroyed) return;
    const known = Number.isInteger(error?.status) && error.status >= 400 && error.status < 600;
    res.status(known ? error.status : 502).json({ error: known ? error.message : fallback, code: known ? error.code : 'VOICE_UNAVAILABLE' });
  }
  rate(user, operation) {
    const scope = identity(user, operation), now = Date.now();
    const recent = (this.rates.get(scope) || []).filter(at => at > now - 60000);
    if (recent.length >= (operation === 'transcribe' ? 12 : 30)) throw failure('Hay demasiadas peticiones de voz. Espera un momento y reintenta.', 429, 'VOICE_BUSY');
    recent.push(now); this.rates.set(scope, recent);
    if (this.rates.size > 1000) for (const [key, values] of this.rates) if (values.at(-1) < now - 60000) this.rates.delete(key);
  }
  async target(req, source, requireNode = true) {
    const link = this.options.getLink(source.agent), key = source.key;
    if (!link || !valid(key)) throw failure('Falta una conversación válida.');
    const agentId = link.cfg.gatewayAgentId || 'main';
    if (key.startsWith('agent:') && !key.startsWith('agent:' + agentId + ':')) throw failure('La conversación no pertenece a este agente.', 403, 'FORBIDDEN');
    if (this.options.authorizeSession && !await this.options.authorizeSession(req, link, key)) throw failure('No tienes acceso a esta conversación.', 403, 'FORBIDDEN');
    const node = this.node(link.id);
    if (!node && requireNode) throw failure('La voz no está configurada para este agente.', 503, 'VOICE_DISABLED');
    const described = await link.req('sessions.describe', { key }, 15000);
    if (!described.ok) throw failure('No se pudo verificar el acceso a la conversación.', ['FORBIDDEN', 'NOT_FOUND'].includes(described.error?.code) ? 403 : 502, 'VOICE_SESSION_UNAVAILABLE');
    const row = described.payload?.session;
    if (!row || row.key !== key || row.agentId && row.agentId !== agentId) throw failure('La conversación no pertenece a este agente.', 403, 'FORBIDDEN');
    if (!valid(row.sessionId, 512)) throw failure('El agente no proporciona una identidad verificable de la conversación.', 409, 'VOICE_SESSION_UNAVAILABLE');
    return { agent: link.id, link, key, agentId, sessionId: row.sessionId, node };
  }
  async worker(node, route, init = {}, timeoutMs = 180000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await (this.options.fetch || fetch)(node.url + route, { ...init, redirect: 'error', signal: controller.signal,
        headers: { ...init.headers, Authorization: 'Bearer ' + node.token } });
      if (!response.ok) {
        let code = ''; try { const body = JSON.parse((await boundedBytes(response, 16384, controller)).toString('utf8')); code = body.error?.code || body.code || ''; } catch {}
        const reports = {
          no_speech: ['No se ha detectado voz. Prueba a grabar de nuevo.', 422],
          audio_too_long: ['La nota supera los cinco minutos.', 413],
          audio_too_large: ['La nota supera los 25 MB.', 413],
          busy: ['El motor de voz está ocupado. Espera un momento y reintenta.', 429],
          timeout: ['El motor de voz ha tardado demasiado. Puedes reintentar.', 504],
        };
        const [message, status] = reports[code] || ['No se pudo procesar el audio en el PC de este agente. Puedes reintentar.', response.status === 429 ? 429 : 502];
        throw failure(message, status, 'VOICE_' + (code || 'UNAVAILABLE').toUpperCase());
      }
      const bytes = await boundedBytes(response, route === '/speech' ? 32 * 1024 * 1024 : 65536, controller);
      return { bytes, contentType: response.headers.get('content-type') || '' };
    } catch (error) {
      if (error.name === 'AbortError') throw failure('El motor de voz ha tardado demasiado. Puedes reintentar.', 504, 'VOICE_TIMEOUT');
      throw error;
    } finally { clearTimeout(timer); }
  }

  // A native final event proves finality. Legacy unphased transcripts require a
  // unique same-run, exact-text match; order or elapsed time never prove it.
  observeFinal(agent, event) {
    if (event?.state !== 'final' || !valid(event.runId, 512) || !valid(event.sessionKey)) return;
    const text = authoredText(event.message);
    if (!text.trim()) return;
    this.finals.set(identity(agent, event.sessionKey, event.runId), { digest: hash(text), at: Date.now() });
    while (this.finals.size > 500) this.finals.delete(this.finals.keys().next().value);
  }
  decorateMessage(user, agent, key, message, sessionId, allMessages = []) {
    if (!this.node(agent)) return {};
    const result = {};
    const meta = message?.__openclaw || {}, id = transcriptIdentity(message).id;
    const runId = valid(meta.runId, 512) ? meta.runId : null;
    if (message.role === 'assistant') {
      let phase = phaseOf(message);
      if (!phase && runId) {
        const final = this.finals.get(identity(agent, key, runId));
        if (final && hash(authoredText(message)) === final.digest && allMessages.filter(raw => raw.role === 'assistant'
          && raw.__openclaw?.runId === runId && hash(authoredText(raw)) === final.digest).length === 1) phase = 'final_answer';
      }
      if (runId) result.runId = runId;
      if (phase) result.phase = phase;
      result.speakable = phase !== 'commentary' && !!authoredText(message).trim() && !message.errorMessage
        && message.stopReason !== 'error' && !message.openclawAsyncDelivery && !meta.truncated
        && !(Array.isArray(message.content) && message.content.some(block => block?.type === 'toolCall'));
    }
    if (!valid(sessionId, 512)) return result;
    for (const entry of this.entries.values()) {
      if (entry.owner !== user || entry.agent !== agent || entry.key !== key || entry.sessionId !== sessionId) continue;
      if (entry.kind === 'input' && message.role === 'user' && entry.runId
        && (message.idempotencyKey === entry.runId + ':user' || meta.idempotencyKey === entry.runId + ':user'
          || runId === entry.runId || id && entry.messageId === id)) {
        if (id && entry.messageId !== id) { entry.messageId = id; this.save(entry); }
        result.voiceNote = this.publicEntry(entry);
      }
      if (entry.kind === 'speech' && message.role === 'assistant' && id && entry.messageId === id && entry.sourceHash === hash(authoredText(message))) result.voiceAudio = this.publicEntry(entry);
    }
    return result;
  }

  async prepareSend(user, link, key, noteId, runId) {
    if (noteId === undefined) return null;
    if (!ID.test(String(noteId))) throw failure('La nota de voz no es válida.');
    const entry = this.entries.get(noteId);
    if (!entry || entry.kind !== 'input' || entry.owner !== user || entry.agent !== link.id || entry.key !== key) throw failure('La nota de voz no pertenece a esta conversación.', 403, 'FORBIDDEN');
    const scoped = await this.target({ user }, { agent: link.id, key });
    if (scoped.sessionId !== entry.sessionId) throw failure('La conversación ha cambiado. Graba o transcribe la nota de nuevo.', 409, 'SESSION_CHANGED');
    if (entry.runId && entry.runId !== runId) throw failure('Esta nota de voz ya se ha enviado.', 409, 'VOICE_ALREADY_SENT');
    // Persist the deterministic receipt before native admission. An uncertain
    // transport can be retried only with that same idempotency key.
    entry.runId = runId; this.save(entry);
    return entry;
  }
  commitSend(entry, runId) {
    if (!entry) return;
    entry.runId = runId || entry.runId; entry.accepted = true; this.save(entry);
  }
  rejectSend(entry, runId) {
    // Only an explicit negative native reply proves non-admission. Timeouts
    // retain the receipt so retrying cannot create a duplicate user turn.
    if (!entry || entry.accepted || entry.runId !== runId) return;
    delete entry.runId; this.save(entry);
  }

  async exactMessage(scoped, messageId, sessionId) {
    if (!valid(messageId, 512) || !valid(sessionId, 512)) throw failure('Falta la referencia exacta del mensaje.');
    const result = await scoped.link.req('chat.history', { sessionKey: scoped.key, agentId: scoped.agentId, messageId, sessionId, limit: 30 }, 60000);
    if (!result.ok) throw failure('El mensaje ya no está disponible o no tienes acceso.', 403, 'FORBIDDEN');
    if (result.payload?.sessionId !== sessionId) throw failure('La conversación ha cambiado. Vuelve a abrir el mensaje.', 409, 'SESSION_CHANGED');
    const message = (result.payload?.messages || []).find(raw => transcriptIdentity(raw).id === messageId);
    if (!message) throw failure('El mensaje no está disponible en el historial.', 404, 'VOICE_MESSAGE_NOT_FOUND');
    return message;
  }

  mount(app) {
    const authenticated = this.options.requireAuth;
    app.get('/api/voice/status', authenticated, async (req, res) => {
      try {
        const target = await this.target(req, req.query, false);
        if (!target.node) return res.json({ enabled: false, available: false, stt: false, tts: false });
        try {
          const result = await this.worker(target.node, '/health', {}, 6000);
          const state = JSON.parse(result.bytes.toString('utf8'));
          return res.json({ enabled: true, available: state.available === true, stt: state.stt === true, tts: state.tts === true,
            maxSeconds: 300, maxBytes: MAX_BYTES });
        } catch { return res.json({ enabled: true, available: false, stt: false, tts: false, maxSeconds: 300, maxBytes: MAX_BYTES }); }
      } catch (error) { this.fail(res, error, 'No se pudo comprobar la voz de este agente.'); }
    });
    const receive = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES, files: 1, fields: 0 } }).single('audio');
    app.post('/api/voice/transcribe', authenticated, (req, res) => {
      receive(req, res, async error => {
        if (error) return this.fail(res, failure(error.code === 'LIMIT_FILE_SIZE' ? 'La nota supera los 25 MB.' : 'Adjunta una sola nota de voz.', error.code === 'LIMIT_FILE_SIZE' ? 413 : 400), 'No se pudo recibir la nota.');
        try {
          this.rate(req.user, 'transcribe');
          const scoped = await this.target(req, req.query);
          const type = String(req.file?.mimetype || '').split(';')[0].toLowerCase();
          if (!req.file?.buffer?.length || !AUDIO_TYPES.has(type)) throw failure('El formato de la nota de voz no es compatible.', 415, 'VOICE_FORMAT_UNSUPPORTED');
          const result = await this.worker(scoped.node, '/transcribe', { method: 'POST', headers: { 'Content-Type': type }, body: req.file.buffer });
          let transcript; try { transcript = JSON.parse(result.bytes.toString('utf8')); } catch { throw new Error('Invalid worker response'); }
          if (typeof transcript.text !== 'string' || !transcript.text.trim() || transcript.text.length > 50000 || transcript.text.includes('\u0000')) throw failure('No se ha detectado voz. Prueba a grabar de nuevo.', 422, 'VOICE_NO_SPEECH');
          if (!Number.isFinite(transcript.duration) || transcript.duration <= 0 || transcript.duration > 300.1) throw failure('La duración de la nota no es válida.', 422, 'VOICE_DURATION_INVALID');
          // Revalidate identity after inference: a reset during transcription
          // must not attach the old recording to the new transcript.
          const fresh = await this.target(req, req.query);
          if (fresh.sessionId !== scoped.sessionId) throw failure('La conversación ha cambiado durante la transcripción. Conserva la grabación y reintenta.', 409, 'SESSION_CHANGED');
          const entry = { id: crypto.randomBytes(16).toString('hex'), kind: 'input', owner: req.user, agent: scoped.agent, key: scoped.key,
            sessionId: scoped.sessionId, mime: type, extension: AUDIO_TYPES.get(type), duration: transcript.duration, createdAt: Date.now() };
          this.save(entry, req.file.buffer);
          res.json({ ...this.publicEntry(entry), text: transcript.text.trim(), sessionId: entry.sessionId,
            ...(typeof transcript.language === 'string' ? { language: transcript.language.slice(0, 16) } : {}) });
        } catch (error) { this.fail(res, error, 'No se pudo transcribir la nota en el PC de este agente. La grabación puede reintentarse.'); }
      });
    });
    app.post('/api/voice/speech', authenticated, async (req, res) => {
      try {
        const source = req.body || {}, scoped = await this.target(req, source);
        const message = await this.exactMessage(scoped, source.messageId, source.sessionId);
        const view = this.decorateMessage(req.user, scoped.agent, scoped.key, message, source.sessionId, [message]);
        if (message.role !== 'assistant' || !view.speakable) throw failure('Este mensaje no es una respuesta que se pueda leer.', 422, 'VOICE_NOT_SPEAKABLE');
        const sourceText = authoredText(message), sourceHash = hash(sourceText);
        const cacheKey = identity(req.user, scoped.agent, scoped.key, source.sessionId, source.messageId, sourceHash, scoped.node.voice);
        const existing = [...this.entries.values()].find(entry => entry.cacheKey === cacheKey);
        if (existing && fs.existsSync(path.join(this.directory, existing.id + '.audio'))) return res.json(this.publicEntry(existing));
        const spoken = spokenText(sourceText);
        if (!spoken.text.trim()) throw failure('La respuesta no contiene texto para leer.', 422, 'VOICE_NOT_SPEAKABLE');
        if (!this.pending.has(cacheKey)) {
          this.rate(req.user, 'speech');
          const operation = (async () => {
            const result = await this.worker(scoped.node, '/speech', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: spoken.text, voice: scoped.node.voice }) });
            if (!/^audio\/(?:mpeg|mp3)(?:;|$)/i.test(result.contentType) || result.bytes.length < 64) throw new Error('Invalid audio response');
            // A message may be edited or removed while synthesis is running.
            const current = await this.exactMessage(scoped, source.messageId, source.sessionId);
            if (hash(authoredText(current)) !== sourceHash) throw failure('La respuesta ha cambiado. Vuelve a pulsar Escuchar.', 409, 'VOICE_MESSAGE_CHANGED');
            const entry = { id: crypto.randomBytes(16).toString('hex'), kind: 'speech', owner: req.user, agent: scoped.agent, key: scoped.key,
              sessionId: source.sessionId, messageId: source.messageId, sourceHash, cacheKey, mime: 'audio/mpeg', extension: 'mp3',
              omittedCode: spoken.omittedCode, truncated: spoken.truncated, spokenChars: spoken.spokenChars, totalChars: spoken.totalChars, createdAt: Date.now() };
            this.save(entry, result.bytes); return entry;
          })();
          this.pending.set(cacheKey, operation);
          operation.finally(() => { if (this.pending.get(cacheKey) === operation) this.pending.delete(cacheKey); }).catch(() => {});
        }
        const entry = await this.pending.get(cacheKey);
        res.json(this.publicEntry(entry));
      } catch (error) { this.fail(res, error, 'No se pudo generar la voz en el PC de este agente. El texto sigue disponible.'); }
    });
    app.get('/api/voice/audio', authenticated, async (req, res) => {
      try {
        if (!ID.test(String(req.query.id))) throw failure('La nota de voz no es válida.');
        const scoped = await this.target(req, req.query), entry = this.entries.get(req.query.id);
        if (!entry || entry.owner !== req.user || entry.agent !== scoped.agent || entry.key !== scoped.key) throw failure('No tienes acceso a este audio.', 403, 'FORBIDDEN');
        if (entry.messageId) {
          const message = await this.exactMessage(scoped, entry.messageId, entry.sessionId);
          const view = this.decorateMessage(req.user, scoped.agent, scoped.key, message, entry.sessionId, [message]);
          if (!(entry.kind === 'input' ? view.voiceNote?.id === entry.id : view.voiceAudio?.id === entry.id)) throw failure('Este audio ya no corresponde al mensaje.', 409, 'VOICE_MESSAGE_CHANGED');
        } else if (entry.sessionId !== scoped.sessionId) throw failure('Esta nota pertenece a otra versión de la conversación.', 409, 'SESSION_CHANGED');
        const filename = path.join(this.directory, entry.id + '.audio');
        if (!fs.existsSync(filename)) throw failure('El audio ya no está disponible.', 404, 'VOICE_AUDIO_NOT_FOUND');
        res.setHeader('Cache-Control', 'private, no-store');
        res.setHeader('Content-Type', entry.mime);
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Content-Disposition', 'inline; filename="' + (entry.kind === 'input' ? 'nota-de-voz' : 'respuesta') + '.' + entry.extension + '"');
        res.sendFile(filename, { acceptRanges: true }, error => { if (error && !res.headersSent) this.fail(res, failure('El audio ya no está disponible.', 404), 'No se pudo abrir el audio.'); });
      } catch (error) { this.fail(res, error, 'No se pudo abrir el audio de esta conversación.'); }
    });
    app.delete('/api/voice/note', authenticated, async (req, res) => {
      try {
        const scoped = await this.target(req, req.query), entry = this.entries.get(req.query.id);
        if (!entry || entry.kind !== 'input' || entry.owner !== req.user || entry.agent !== scoped.agent || entry.key !== scoped.key || entry.runId) throw failure('La nota no es un borrador propio disponible.', 403, 'FORBIDDEN');
        for (const suffix of ['.audio', '.json']) try { fs.unlinkSync(path.join(this.directory, entry.id + suffix)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        this.entries.delete(entry.id); res.json({ ok: true });
      } catch (error) { this.fail(res, error, 'No se pudo descartar la nota de voz.'); }
    });
  }
}

module.exports = { VoiceRoutes, spokenText, phaseOf, authoredText, readConfig };
