'use strict';
const crypto = require('node:crypto');
const { transcriptIdentity, readAsyncQuestion, historyAsyncQuestions, projectAsyncQuestions, formatAsyncAnswer, asyncQuestionForTranscript } = require('./agent-questions');

// Protocol verified against OpenClaw 2026.10: offset pages read older history;
// cursor is a delta token, never a pagination token. Search anchors carry both
// transcript sessionId and messageId, so old transcript hits stay exact.
function mountSessionBrowse(app, options) {
  const { getLink, requireAuth, normalizeContent, toolResultPreview } = options;
  const agents = options.agents || [];
  const config = id => agents.find(agent => agent.id === id) || getLink(id)?.cfg || {};
  const agentIdOf = id => String(config(id).gatewayAgentId || 'main');
  const validString = (value, max = 512) => typeof value === 'string' && !!value.trim() && value.length <= max && !/[\u0000-\u001f]/.test(value);
  const inScope = (key, agentId) => !String(key).startsWith('agent:') || String(key).startsWith('agent:' + agentId + ':');
  function diagnostic(error, context = {}) {
    if (typeof options.diagnosticFromError === 'function') return options.diagnosticFromError(error?.error || error, context);
    const detail = error?.error || error || {};
    // Standalone mounts never publish unknown raw provider details. Production
    // supplies its credential-aware observability normalizer for full details.
    return { message: String(detail.message || context.message || 'No se pudo completar la operación'), ...(detail.code ? { code: detail.code } : {}) };
  }
  function fail(res, error, fallback, context = {}) {
    const detail = error?.error || error || {};
    const code = detail.code;
    const status = ['FORBIDDEN', 'PERMISSION_DENIED', 'UNAUTHORIZED'].includes(code) ? 403
      : ['NOT_FOUND', 'SESSION_NOT_FOUND'].includes(code) ? 404 : code === 'INVALID_REQUEST' ? 400 : 502;
    const report = diagnostic(error, { ...context, message: fallback });
    return res.status(status).json({ error: report.message || fallback, ...(report.code ? { code: report.code } : {}), diagnostic: report, ...(report.details ? { details: report.details } : {}) });
  }
  async function checkedLink(req, res, source) {
    const id = String(source.agent || '');
    const link = getLink(id);
    if (!id || !link) { res.status(400).json({ error: 'Agente desconocido' }); return null; }
    const key = source.key;
    if (!validString(key, 1024)) { res.status(400).json({ error: 'Falta una sesión válida' }); return null; }
    const gatewayAgentId = agentIdOf(id);
    if (!inScope(key, gatewayAgentId)) { res.status(403).json({ error: 'La sesión no pertenece a este agente', code: 'FORBIDDEN' }); return null; }
    if (options.authorizeSession && !await options.authorizeSession(req, link, key)) {
      res.status(403).json({ error: 'No tienes acceso a esta sesión', code: 'FORBIDDEN' }); return null;
    }
    // The gateway remains the authority for session visibility and mutations.
    const described = await link.req('sessions.describe', { key }, 15000);
    if (!described.ok) { fail(res, described, 'No se pudo acceder a la sesión'); return null; }
    const row = described.payload?.session;
    if (!row || (row.agentId && row.agentId !== gatewayAgentId) || (row.key && !inScope(row.key, gatewayAgentId))) {
      res.status(403).json({ error: 'La sesión no pertenece a este agente', code: 'FORBIDDEN' }); return null;
    }
    return { link, key, gatewayAgentId, row };
  }
  function messageView(message, context, asyncQuestions, transcript) {
    const { text, tools } = normalizeContent(message.content);
    const identity = transcriptIdentity(message);
    if (message.role === 'toolResult') return {
      ...identity, role: 'toolResult', ts: message.timestamp,
      tool: { id: message.toolCallId || null, name: String(message.toolName || 'tool').slice(0, 60), isError: !!message.isError, preview: toolResultPreview(message.content) },
    };
    const failed = message.role === 'assistant' && (message.errorMessage || message.stopReason === 'error');
    const report = failed ? diagnostic({ ...message, message: message.errorMessage || 'El último turno falló' }, { ...context, at: message.timestamp, terminal: true }) : null;
    const question = readAsyncQuestion(message);
    return { ...identity, role: message.role, text, ts: message.timestamp,
      ...(question ? { asyncQuestion: asyncQuestionForTranscript(asyncQuestions?.get(question.itemId) || question, transcript.sourceSessionId, transcript.currentSessionId) } : {}),
      ...(tools.length ? { tools } : {}), ...(report ? { diagnostic: report, stopReason: message.stopReason || 'error' } : {}) };
  }

  app.get('/api/history-page', requireAuth, async (req, res) => {
    try {
      const target = await checkedLink(req, res, req.query);
      if (!target) return;
      const { link, key, gatewayAgentId } = target;
      const params = { sessionKey: key, agentId: gatewayAgentId, limit: 100 };
      if (req.query.offset !== undefined) {
        const value = String(req.query.offset);
        if (!/^\d{1,12}$/.test(value) || !Number.isSafeInteger(Number(value))) return res.status(400).json({ error: 'Página de historial inválida' });
        params.offset = Number(value);
      }
      if (req.query.messageId !== undefined || req.query.sessionId !== undefined) {
        if (params.offset !== undefined || !validString(req.query.messageId) || !validString(req.query.sessionId)) return res.status(400).json({ error: 'Referencia de búsqueda inválida' });
        params.messageId = req.query.messageId;
        params.sessionId = req.query.sessionId;
      }
      if (req.query.cursor !== undefined) return res.status(400).json({ error: 'El cursor de cambios no es una página de historial' });
      const result = await link.req('chat.history', params, 60000);
      if (!result.ok) return fail(res, result, 'No se pudo cargar el historial');
      const payload = result.payload || {};
      const rawMessages = Array.isArray(payload.messages) ? payload.messages : [];
      const asyncQuestions = historyAsyncQuestions(link, key, rawMessages, payload.sessionId || params.sessionId || target.row.sessionId,
        { completeHistory: !params.messageId && (params.offset || 0) === 0 && payload.hasMore === false });
      const transcript = { sourceSessionId: payload.sessionId || params.sessionId || target.row.sessionId, currentSessionId: target.row.sessionId };
      const messages = rawMessages.map(message => messageView(message, { agentId: String(req.query.agent), sessionKey: key, source: 'history' }, asyncQuestions, transcript))
        .filter(message => message.text || message.tools?.length || message.tool || message.diagnostic || message.asyncQuestion || message.role === 'user');
      const offset = Number.isSafeInteger(payload.offset) ? payload.offset : (params.offset || 0);
      const total = Number.isSafeInteger(payload.totalMessages) ? payload.totalMessages : null;
      const next = Number.isSafeInteger(payload.nextOffset) && payload.nextOffset > offset ? payload.nextOffset : null;
      const anchored = !!params.messageId;
      // Do not fabricate hasMore when an older gateway has no pagination data.
      res.json({
        messages, sessionId: payload.sessionId || params.sessionId || null, offset,
        // A reconnect may concern a question older than this first page. Return
        // the verified transcript's known projection without inventing a reply
        // from its absence, or exposing another transcript's cached questions.
        ...(req.query.includeQuestions === '1' ? {
          asyncQuestions: [...asyncQuestions.values()].map(question => asyncQuestionForTranscript(question, transcript.sourceSessionId, transcript.currentSessionId)),
        } : {}),
        // Around-message reads are context windows, not offset pages. Applying
        // their offset to the current transcript could cross a reset archive.
        nextOffset: anchored ? null : next, hasMore: !anchored && payload.hasMore === true && next !== null,
        totalMessages: total, paginationAvailable: !anchored && typeof payload.hasMore === 'boolean', windowReset: payload.windowReset === true,
        ...(anchored ? { anchor: { messageId: params.messageId, sessionId: params.sessionId, found: messages.some(message => message.id === params.messageId) }, historical: payload.sessionId !== undefined && payload.sessionId !== target.row.sessionId } : {}),
      });
    } catch (error) { fail(res, error, 'No se pudo cargar el historial'); }
  });

  // Optional Codex questions use an ordinary, correlated steer message. Never
  // accept a browser's title, reply anchor, queue mode or Gateway credentials.
  const asyncAnswerReceipts = new Map();
  const asyncAnswerPending = new Map();
  const asyncAnswerSignatures = new Map();
  app.post('/api/async-question', requireAuth, async (req, res) => {
    try {
      const source = req.body || {};
      if (!validString(source.itemId, 256) || !validString(source.sourceSessionId, 512) || !Array.isArray(source.answers) || source.answers.length < 1
          || source.answers.length > 12 || !source.answers.every(answer => typeof answer === 'string' && answer.length <= 4096 && !!answer.trim())) {
        return res.status(400).json({ error: 'Falta una respuesta válida para cada pregunta', code: 'INVALID_REQUEST' });
      }
      const target = await checkedLink(req, res, source);
      if (!target) return;
      const { link, key, gatewayAgentId, row } = target;
      if (source.sourceSessionId !== row.sessionId) return res.status(409).json({ error: 'Esta pregunta pertenece a otra versión de la conversación.', code: 'SESSION_CHANGED' });
      const transcriptId = row.sessionId;
      let offset = 0, rawMessages = [], found = false, completeHistory = false;
      // Usually the first page contains the question. Older questions remain
      // answerable after opening history; the bounded lookup fails explicitly
      // instead of trusting a stale cached or client-supplied question.
      for (let page = 0; page < 10; page++) {
        // Native history accepts sessionId only with an exact messageId anchor,
        // never with offset paging. Read current history and verify its identity.
        const result = await link.req('chat.history', { sessionKey: key, agentId: gatewayAgentId, limit: 200,
          ...(offset ? { offset } : {}) }, 15000);
        if (!result.ok) return fail(res, result, 'No se pudo verificar la pregunta');
        const payload = result.payload || {};
        if (payload.sessionId !== transcriptId) return res.status(409).json({ error: 'La conversación ha cambiado. Vuelve a abrir la pregunta.', code: 'SESSION_CHANGED' });
        const pageMessages = Array.isArray(payload.messages) ? payload.messages : [];
        rawMessages = [...pageMessages, ...rawMessages];
        completeHistory = payload.hasMore === false;
        found = pageMessages.some(message => readAsyncQuestion(message)?.itemId === source.itemId);
        if (found || payload.hasMore !== true || !Number.isSafeInteger(payload.nextOffset) || payload.nextOffset <= offset) break;
        offset = payload.nextOffset;
      }
      if (!found) return res.status(404).json({ error: 'Esta pregunta no está disponible en el historial recuperable de la sesión.', code: 'QUESTION_NOT_FOUND' });
      const question = projectAsyncQuestions(rawMessages, undefined, undefined, undefined, { quotedThroughSeq: completeHistory ? Infinity : -1 }).get(source.itemId);
      if (!question.sourceMessageId) return res.status(409).json({ error: 'Esta pregunta no tiene un mensaje nativo verificable para responder.', code: 'QUESTION_UNANCHORED' });
      const message = formatAsyncAnswer(question, source.answers);
      if (question.answered) return res.json({ ok: true, itemId: source.itemId, sourceSessionId: transcriptId, status: 'answered', alreadyAnswered: true });
      // Recheck visibility/identity immediately before admission. chat.send is
      // also bound to the actual transcript ID, so a reset cannot redirect it.
      const current = await checkedLink(req, res, source);
      if (!current) return;
      if ((row.sessionId && current.row.sessionId !== row.sessionId)
          || (transcriptId && current.row.sessionId && current.row.sessionId !== transcriptId)) {
        return res.status(409).json({ error: 'La conversación ha cambiado. Vuelve a abrir la pregunta.', code: 'SESSION_CHANGED' });
      }
      const scope = JSON.stringify([String(source.agent), key, transcriptId || null, question.itemId, question.sourceMessageId || null]);
      const signature = crypto.createHash('sha256').update(message).digest('hex');
      const receipt = asyncAnswerReceipts.get(scope);
      if (receipt) {
        if (receipt.signature !== signature) return res.status(409).json({ error: 'Ya se ha enviado una respuesta a esta pregunta.', code: 'ANSWER_ALREADY_SENT' });
        return res.json(receipt.result);
      }
      const existing = asyncAnswerPending.get(scope);
      if (existing && existing.signature !== signature) return res.status(409).json({ error: 'Hay una respuesta a esta pregunta en curso.', code: 'ANSWER_IN_FLIGHT' });
      const attempted = asyncAnswerSignatures.get(scope);
      if (attempted && attempted !== signature) return res.status(409).json({ error: 'El envío anterior no está confirmado. Reintenta la misma respuesta antes de cambiarla.', code: 'ANSWER_UNCONFIRMED' });
      let pending = existing?.promise;
      if (!pending) {
        asyncAnswerSignatures.set(scope, signature);
        while (asyncAnswerSignatures.size > 500) asyncAnswerSignatures.delete(asyncAnswerSignatures.keys().next().value);
        pending = (async () => {
          link.ensureSub?.(key);
          const result = await link.req('chat.send', { sessionKey: key, agentId: gatewayAgentId,
            ...(transcriptId ? { sessionId: transcriptId } : {}), message, deliver: false, queueMode: 'steer',
            ...(question.sourceMessageId ? { replyToId: question.sourceMessageId } : {}),
            // Stable per source question, including after an uncertain HTTP/WS
            // result. Retry the same answer; do not silently admit it twice.
            idempotencyKey: 'hub-async-' + crypto.createHash('sha256').update(scope).digest('hex'),
          }, 20000);
          if (!result.ok || ['error', 'timeout', 'failed', 'rejected'].includes(result.payload?.status)) {
            const error = result.error || { code: 'UNAVAILABLE', message: 'El gateway no confirmó el envío de la respuesta' };
            // Only explicit pre-admission validation/policy failures prove that
            // the text can safely change. A disconnect/timeout may have sent it.
            if (!result.ok && ['INVALID_REQUEST', 'FORBIDDEN', 'PERMISSION_DENIED', 'UNAUTHORIZED', 'NOT_FOUND', 'SESSION_NOT_FOUND'].includes(error.code)) {
              asyncAnswerSignatures.delete(scope);
            }
            throw Object.assign(new Error(error.message), error);
          }
          const accepted = { ok: true, itemId: question.itemId, sourceSessionId: transcriptId, status: result.payload?.status || 'accepted',
            ...(result.payload?.runId ? { runId: result.payload.runId } : {}) };
          asyncAnswerReceipts.set(scope, { signature, result: accepted });
          while (asyncAnswerReceipts.size > 500) asyncAnswerReceipts.delete(asyncAnswerReceipts.keys().next().value);
          return accepted;
        })();
        asyncAnswerPending.set(scope, { signature, promise: pending });
      }
      try { res.json(await pending); }
      finally { if (asyncAnswerPending.get(scope)?.promise === pending) asyncAnswerPending.delete(scope); }
    } catch (error) {
      if (/Falta una respuesta válida/.test(error.message || '')) return res.status(400).json({ error: error.message, code: 'INVALID_REQUEST' });
      fail(res, error, 'No se pudo enviar la respuesta');
    }
  });

  app.get('/api/session-search', requireAuth, async (req, res) => {
    const id = String(req.query.agent || '');
    const link = getLink(id);
    if (!id || !link) return res.status(400).json({ error: 'Agente desconocido' });
    const query = req.query.q;
    if (!validString(query, 4096)) return res.status(400).json({ error: 'Escribe un texto para buscar (hasta 4096 caracteres)' });
    const gatewayAgentId = agentIdOf(id);
    try {
      // scope asks the gateway for its complete visible roster, not the Hub's
      // first 120 trees. Its role/incognito/tenant visibility policy still applies.
      // Restrict the native search before ranking/limit. Filtering a global top
      // 25 afterwards can hide every result of a user with a smaller history.
      const keys = options.searchSessionKeys ? await options.searchSessionKeys(req, link) : null;
      if (Array.isArray(keys) && !keys.length) return res.json({ results: [], indexing: false, truncated: false, archivedTranscriptsExcluded: 0 });
      // Native sessionKeys is limited to 200. Search every authorized batch,
      // then merge its top hits; no unrelated session can consume the limit.
      const batches = Array.isArray(keys) ? Array.from({ length: Math.ceil(keys.length / 200) }, (_, index) => keys.slice(index * 200, index * 200 + 200)) : [null];
      const payload = { sessions: [], results: [], indexing: false, truncated: false, archivedTranscriptsExcluded: 0 };
      for (const batch of batches) {
        const result = await link.req('sessions.search', { query: query.trim(),
          ...(batch ? { agentId: gatewayAgentId, sessionKeys: batch } : { scope: { agentId: gatewayAgentId } }), limit: 25 }, 60000);
        if (!result.ok) return fail(res, result, 'No se pudo buscar en las conversaciones');
        const part = result.payload || {};
        payload.sessions.push(...(part.sessions || [])); payload.results.push(...(part.results || []));
        payload.indexing ||= part.indexing === true; payload.truncated ||= part.truncated === true;
        payload.archivedTranscriptsExcluded += part.archivedTranscriptsExcluded || 0;
      }
      payload.results.sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0));
      payload.truncated ||= payload.results.length > 25;
      payload.results = payload.results.slice(0, 25);
      const declaredRows = new Map((payload.sessions || []).map(row => [row.key, row]));
      const sessions = (payload.sessions || []).filter(row => validString(row.key, 1024) && inScope(row.key, gatewayAgentId) && (!row.agentId || row.agentId === gatewayAgentId));
      const byKey = new Map(sessions.map(row => [row.key, row]));
      const results = [];
      for (const hit of payload.results || []) {
        if (!validString(hit.sessionKey, 1024) || !inScope(hit.sessionKey, gatewayAgentId) || !validString(hit.messageId) || !validString(hit.sessionId)) continue;
        const declared = declaredRows.get(hit.sessionKey);
        if (declared?.agentId && declared.agentId !== gatewayAgentId) continue;
        if (options.authorizeSession && !await options.authorizeSession(req, link, hit.sessionKey)) continue;
        const row = byKey.get(hit.sessionKey);
        results.push({ sessionKey: hit.sessionKey, sessionId: hit.sessionId, messageId: hit.messageId,
          role: hit.role === 'user' ? 'user' : 'assistant', timestamp: Number.isFinite(hit.timestamp) ? hit.timestamp : 0,
          snippet: String(hit.snippet || ''), label: row?.label || row?.displayName || '', score: Number(hit.score) || 0 });
      }
      res.json({ results, indexing: payload.indexing === true, truncated: payload.truncated === true,
        archivedTranscriptsExcluded: options.privateOnly?.(req) ? 0 : payload.archivedTranscriptsExcluded || 0 });
    } catch (error) { fail(res, error, 'No se pudo buscar en las conversaciones'); }
  });

  app.post('/api/session-rename', requireAuth, async (req, res) => {
    const label = req.body?.label;
    if (!validString(label, 100)) return res.status(400).json({ error: 'El nombre debe tener entre 1 y 100 caracteres' });
    try {
      const target = await checkedLink(req, res, req.body || {});
      if (!target) return;
      const writer = await target.link.settingsClient();
      const result = await writer.req('sessions.patch', { key: target.key, label: label.trim() });
      if (!result.ok) return fail(res, result, 'No se pudo cambiar el nombre');
      target.link.sessionsCache.at = 0;
      res.json({ ok: true, key: target.key, label: result.payload?.entry?.label || label.trim() });
    } catch (error) { fail(res, error, 'No se pudo cambiar el nombre'); }
  });
}

module.exports = { mountSessionBrowse };
