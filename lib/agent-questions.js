'use strict';

// OpenClaw 2026.10 has TWO question lifecycles. question.* is blocking;
// Codex openclawAsyncDelivery is an ordinary assistant message and its answer
// is chat.send(queueMode: 'steer', replyToId), never question.resolve.
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const bounded = (value, maximum) => typeof value === 'string' && value.length <= maximum && !!value.trim();

function blockingQuestionInScope(question, gatewayAgentId = 'main') {
  if (!record(question)) return false;
  if (question.agentId && question.agentId !== gatewayAgentId) return false;
  if (typeof question.sessionKey === 'string' && question.sessionKey.startsWith('agent:')) {
    return question.sessionKey.startsWith('agent:' + gatewayAgentId + ':');
  }
  // A legacy/global question has no agent attribution. Display it once on the
  // default agent, rather than cloning it onto every link to the same gateway.
  return !!question.agentId || gatewayAgentId === 'main';
}

function normalizeBlockingQuestion(value) {
  const question = record(value) ? value : {};
  const isOther = question.isOther === true;
  return {
    id: question.questionId || question.id, header: String(question.header || '').slice(0, 64),
    question: String(question.question || ''),
    options: (Array.isArray(question.options) ? question.options : []).map(option => {
      const item = record(option) ? option : {};
      const selectedValue = typeof item.value === 'string' ? item.value : typeof item.reply === 'string' ? item.reply : String(item.label || '');
      return { label: String(item.label || ''), reply: selectedValue,
        ...(typeof item.value === 'string' ? { value: item.value } : {}),
        ...(typeof item.description === 'string' ? { description: item.description } : {}),
        ...(item.recommended ? { recommended: true } : {}),
      };
    }),
    multiSelect: question.multiSelect === true, isOther, other: isOther,
    allowEmpty: question.allowEmpty === true, isSecret: question.isSecret === true,
    ...(question.presentation === 'form' ? { presentation: 'form' } : {}),
    ...(question.answerFormat === 'lines' ? { answerFormat: 'lines' } : {}),
    ...(!question.isSecret && Array.isArray(question.defaultAnswers) ? { defaultAnswers: question.defaultAnswers.filter(answer => typeof answer === 'string').slice(0, 64) } : {}),
  };
}

function imported(message) {
  const meta = message?.__openclaw;
  if (!record(meta)) return false;
  const position = meta.transcriptPosition;
  if (record(position) && bounded(position.source, 128) && Number.isSafeInteger(position.rawSeq) && position.rawSeq >= 0) return false;
  return !!(meta.externalSource || meta.externalSessionId || meta.externalId);
}

function transcriptIdentity(message) {
  const meta = record(message?.__openclaw) ? message.__openclaw : {};
  return {
    ...(bounded(meta.id, 512) ? { id: meta.id } : {}),
    ...(Number.isSafeInteger(meta.seq) && meta.seq >= 0 ? { seq: meta.seq } : {}),
    ...(bounded(meta.replyToId, 512) ? { replyToId: meta.replyToId } : {}),
  };
}

function readAsyncQuestion(message) {
  if (!record(message) || message.role !== 'assistant') return null;
  const delivery = message.openclawAsyncDelivery;
  if (!record(delivery) || !bounded(delivery.itemId, 256) || !Array.isArray(delivery.questions)
      || delivery.questions.length < 1 || delivery.questions.length > 12) return null;
  const questions = [];
  for (const question of delivery.questions) {
    if (!record(question) || !bounded(question.title, 4096)) return null;
    const options = question.options;
    if (options != null && (!Array.isArray(options) || !options.length || options.length > 4 || !options.every(option => bounded(option, 256)))) return null;
    questions.push({ title: question.title, ...(options != null ? { options: options.slice() } : {}) });
  }
  const identity = transcriptIdentity(message);
  const canonical = identity.id && Number.isSafeInteger(identity.seq) && !imported(message);
  return {
    itemId: delivery.itemId, questions, nonBlocking: true, answered: false,
    ...(canonical ? { sourceMessageId: identity.id, sourceMessageSeq: identity.seq } : {}),
    ...(Number.isFinite(message.timestamp) ? { createdAtMs: message.timestamp } : {}),
  };
}

function asyncQuestionForTranscript(question, sourceSessionId, currentSessionId) {
  const identified = bounded(sourceSessionId, 512);
  return { ...question,
    ...(identified ? { sourceSessionId } : {}),
    // Archive identity is not an answer. Unknown/imported anchors stay visible
    // with their text fallback, but cannot steer a different current transcript.
    answerable: !question.answered && !!question.sourceMessageId && identified && sourceSessionId === currentSessionId,
  };
}

function quoteAsyncTitle(title) {
  // Match Control UI exactly: 512 UTF-8 bytes without breaking a code point.
  let bytes = 0, text = '';
  for (const codepoint of title) {
    bytes += Buffer.byteLength(codepoint, 'utf8');
    if (bytes > 512) break;
    text += codepoint;
  }
  return '> ' + text.replace(/[\r\n]/g, ' ');
}

function formatAsyncAnswer(question, answers) {
  if (!Array.isArray(answers) || answers.length !== question.questions.length
      || !answers.every(answer => bounded(answer, 4096))) throw new Error('Falta una respuesta válida para cada pregunta');
  return question.questions.map((item, index) => quoteAsyncTitle(item.title) + '\n\n' + answers[index].trim()).join('\n\n');
}

function messageText(message) {
  if (typeof message.content === 'string') return message.content;
  return Array.isArray(message.content) ? message.content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('') : '';
}

function parsesAsyncAnswer(question, text) {
  let offset = 0;
  for (let index = 0; index < question.questions.length; index++) {
    const prefix = quoteAsyncTitle(question.questions[index].title) + '\n\n';
    if (!text.startsWith(prefix, offset)) return false;
    offset += prefix.length;
    const next = question.questions[index + 1];
    const separator = next ? '\n\n' + quoteAsyncTitle(next.title) + '\n\n' : null;
    const end = separator ? text.indexOf(separator, offset) : text.length;
    if (end < offset || !text.slice(offset, end).trim() || (separator && text.includes(separator, end + separator.length))) return false;
    offset = end + (separator ? 2 : 0);
  }
  return offset === text.length;
}

function ordinaryUser(message) {
  const identity = transcriptIdentity(message), provenance = message?.provenance;
  return message?.role === 'user' && identity.id && Number.isSafeInteger(identity.seq) && !imported(message)
    && (!provenance?.kind || provenance.kind === 'external_user') && message.isHeartbeat !== true;
}

function answerEvidence(message) {
  if (!ordinaryUser(message) || !messageText(message).trim()) return null;
  const identity = transcriptIdentity(message);
  return { messageId: identity.id, seq: identity.seq, replyToId: identity.replyToId,
    ...(Number.isFinite(message.timestamp) ? { at: message.timestamp } : {}) };
}

function applyAnswer(question, evidence) {
  if (question.answered || (Number.isSafeInteger(question.sourceMessageSeq) && evidence.seq <= question.sourceMessageSeq)) return question;
  return { ...question, answered: true, answerMessageId: evidence.messageId,
    answerMessageSeq: evidence.seq,
    ...(evidence.at !== undefined ? { answeredAtMs: evidence.at } : {}) };
}

function projectAsyncQuestions(messages, initial = new Map(), linkedReplies = new Map(), quotedReplies = new Map(), { quotedThroughSeq = Infinity } = {}) {
  const questions = new Map(initial);
  let changed = false;
  for (const message of messages) {
    const question = readAsyncQuestion(message);
    if (question) {
      const previous = questions.get(question.itemId);
      let next = previous?.answered && previous.sourceMessageId === question.sourceMessageId
        ? { ...question, answered: true, answerMessageId: previous.answerMessageId,
          ...(previous.answerMessageSeq !== undefined ? { answerMessageSeq: previous.answerMessageSeq } : {}),
          ...(previous.answeredAtMs !== undefined ? { answeredAtMs: previous.answeredAtMs } : {}) } : question;
      const reply = next.sourceMessageId && linkedReplies.get(next.sourceMessageId);
      if (reply) next = applyAnswer(next, reply);
      questions.set(next.itemId, next);
      changed = true;
    }
    const evidence = answerEvidence(message);
    if (!evidence) continue;
    if (evidence.replyToId) {
      linkedReplies.set(evidence.replyToId, evidence);
      changed = true;
    } else {
      const text = messageText(message);
      // Keep only canonical, explicitly quoted replies, not ordinary chat or
      // tool output. Their older source can arrive on a later history page.
      if (!text.startsWith('> ') || Buffer.byteLength(text, 'utf8') > 256 * 1024) continue;
      quotedReplies.set(evidence.messageId, { ...quotedReplies.get(evidence.messageId), ...evidence, text });
      changed = true;
    }
  }
  if (!changed) return questions;
  // Match after collecting this page's questions, in native sequence order.
  // One quoted reply may settle only one unambiguous source, including when
  // pages arrive newest first. Never reuse it for a later same-title question.
  const replies = [...linkedReplies.values(), ...quotedReplies.values()].sort((a, b) => a.seq - b.seq);
  for (const evidence of replies) {
    // An unknown older page can contain another same-title question. A quote
    // without an anchor is conclusive only inside a fully verified prefix.
    if (evidence.matchedSourceId || evidence.checked || !evidence.replyToId && evidence.seq > quotedThroughSeq) continue;
    if (!evidence.replyToId) evidence.checked = true;
    const candidates = [...questions.values()].filter(question =>
      (!question.answered || !evidence.replyToId && Number.isSafeInteger(question.answerMessageSeq) && question.answerMessageSeq > evidence.seq)
      && (!Number.isSafeInteger(question.sourceMessageSeq) || question.sourceMessageSeq < evidence.seq)
      && (evidence.replyToId ? question.sourceMessageId === evidence.replyToId
        : question.sourceMessageId && parsesAsyncAnswer(question, evidence.text)));
    // Unquoted user messages are never a resolution. A quoted reply without an
    // anchor resolves only one unambiguous preceding question, like Control UI.
    if (candidates.length === 1) {
      const question = candidates[0];
      questions.set(question.itemId, applyAnswer(question, evidence));
      if (!evidence.replyToId && question.sourceMessageId) evidence.matchedSourceId = question.sourceMessageId;
    }
  }
  return questions;
}

class AsyncQuestionTracker {
  constructor() { this.sessions = new Map(); }
  observe(key, messages, sessionId, { completeHistory = false } = {}) {
    const scope = JSON.stringify([key, sessionId || null]);
    let state = this.sessions.get(scope);
    if (!state) state = { questions: new Map(), linkedReplies: new Map(), quotedReplies: new Map(), quotedThroughSeq: -1 };
    if (completeHistory) {
      for (const message of messages) {
        const identity = transcriptIdentity(message);
        if (!imported(message) && Number.isSafeInteger(identity.seq)) state.quotedThroughSeq = Math.max(state.quotedThroughSeq, identity.seq);
      }
    }
    const previous = state.questions;
    state.questions = projectAsyncQuestions(messages, previous, state.linkedReplies, state.quotedReplies, { quotedThroughSeq: state.quotedThroughSeq });
    const changes = [...state.questions.values()].filter(question => JSON.stringify(previous.get(question.itemId)) !== JSON.stringify(question));
    // Once an older candidate is evicted, a reloaded quote cannot rely on the
    // old completeness watermark. Already checked evidence stays conclusive;
    // an evicted/reintroduced quote needs another complete native scan.
    if (state.questions.size > 200) state.quotedThroughSeq = -1;
    while (state.questions.size > 200) state.questions.delete(state.questions.keys().next().value);
    while (state.linkedReplies.size > 400) state.linkedReplies.delete(state.linkedReplies.keys().next().value);
    let quotedBytes = [...state.quotedReplies.values()].reduce((total, reply) => total + Buffer.byteLength(reply.text, 'utf8'), 0);
    while (state.quotedReplies.size > 400 || quotedBytes > 512 * 1024) {
      const oldest = state.quotedReplies.keys().next().value;
      quotedBytes -= Buffer.byteLength(state.quotedReplies.get(oldest).text, 'utf8');
      state.quotedReplies.delete(oldest);
    }
    this.sessions.delete(scope); this.sessions.set(scope, state);
    while (this.sessions.size > 80) this.sessions.delete(this.sessions.keys().next().value);
    return { questions: state.questions, changes };
  }
  needsQuotedRecovery(key, sessionId) {
    const state = this.sessions.get(JSON.stringify([key, sessionId || null]));
    return !!state && [...state.quotedReplies.values()].some(reply => !reply.checked && reply.seq > state.quotedThroughSeq
      && [...state.questions.values()].some(question => !question.answered && question.sourceMessageId
        && (!Number.isSafeInteger(question.sourceMessageSeq) || question.sourceMessageSeq < reply.seq)
        && parsesAsyncAnswer(question, reply.text)));
  }
}

function historyAsyncQuestions(link, key, messages, sessionId, options = {}) {
  link.asyncQuestionTracker ||= new AsyncQuestionTracker();
  const projection = link.asyncQuestionTracker.observe(key, messages, sessionId, options);
  // A history read can be the first evidence of an answer whose live event was
  // lost. Update every authorized client, not only this HTTP page's caller.
  if (projection.changes.length && typeof link.publishAsyncQuestionChanges === 'function') {
    Promise.resolve(link.publishAsyncQuestionChanges(key, sessionId, projection.changes.map(question => question.itemId))).catch(() => {});
  }
  if (link.asyncQuestionTracker.needsQuotedRecovery(key, sessionId) && typeof link.recoverAsyncQuestions === 'function') {
    // The native recovery coalesces reads and requires an authorized live
    // subscription. Never promote a partial quote before that bounded scan.
    Promise.resolve(link.recoverAsyncQuestions(key)).catch(() => {});
  }
  return projection.questions;
}

function eventQuestionMessage(payload) {
  const message = payload?.message;
  if (!record(message)) return null;
  // session.message also carries its identity outside the message body.
  return { ...message, __openclaw: {
    ...(record(message.__openclaw) ? message.__openclaw : {}),
    ...(!message.__openclaw?.id && bounded(payload.messageId, 512) ? { id: payload.messageId } : {}),
    ...(!Number.isSafeInteger(message.__openclaw?.seq) && Number.isSafeInteger(payload.messageSeq) ? { seq: payload.messageSeq } : {}),
  } };
}

module.exports = { normalizeBlockingQuestion, blockingQuestionInScope, transcriptIdentity, readAsyncQuestion, formatAsyncAnswer,
  projectAsyncQuestions, AsyncQuestionTracker, historyAsyncQuestions, eventQuestionMessage, asyncQuestionForTranscript };
