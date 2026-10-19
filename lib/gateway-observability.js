'use strict';

// A bounded metadata projection, not a second transcript or an agent simulator.
// Only Gateway facts can finish a run; transport loss and recoverable errors cannot.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const MAX_TEXT = 65536;
const MAX_SESSIONS = 120;
const MAX_RUNS = 8;
const MAX_ITEMS = 80;
const MAX_DIAGNOSTICS = 20;
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_SESSION_BYTES = 1024 * 1024;
const TERMINAL = new Set(['completed', 'aborted', 'error']);
const SECRET_KEY = /^(?:authorization|proxy[-_]?authorization|x[-_]?api[-_]?key|api[-_]?key|token|access[-_]?token|refresh[-_]?token|id[-_]?token|secret|client[-_]?secret|password|passwd|cookie|set[-_]?cookie|credential|credentials|private[-_]?key)$/i;
const record = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const finite = value => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const text = value => typeof value === 'string' && value.trim() ? value : undefined;
const clone = value => JSON.parse(JSON.stringify(value));
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);

function createRedactor(secrets = []) {
  const known = [...new Set(secrets.filter(value => typeof value === 'string' && value.length >= 8))].sort((a, b) => b.length - a.length);
  function redactString(value) {
    let safe = String(value);
    for (const secret of known) safe = safe.split(secret).join('[redacted]');
    safe = safe
      .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[redacted private key]')
      .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/_=.~-]+/gi, '$1 [redacted]')
      .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{16,}|xox[baprs]-[A-Za-z0-9-]{12,})\b/g, '[redacted]')
      .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted]')
      .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[redacted]@')
      .replace(/([?&](?:key|token|api[-_]?key|access[-_]?token|signature|sig|auth|password)=)[^&#\s"']+/gi, '$1[redacted]')
      .replace(/(^\s*(?:set[-_])?cookie\s*:\s*)[^\r\n]+/gmi, '$1[redacted]')
      .replace(/(\b(?:[a-z0-9]+[_-])*(?:api[-_]?key|access[-_]?token|refresh[-_]?token|client[-_]?secret|password|passwd|authorization|cookie|token|secret)\b["']?\s*[=:]\s*)"(?:\\.|[^"\\])*"/gi, '$1"[redacted]"')
      .replace(/(\b(?:[a-z0-9]+[_-])*(?:api[-_]?key|access[-_]?token|refresh[-_]?token|client[-_]?secret|password|passwd|authorization|cookie|token|secret)\b["']?\s*[=:]\s*)'(?:\\.|[^'\\])*'/gi, "$1'[redacted]'")
      .replace(/\b((?:[a-z0-9]+[_-])*(?:api[-_]?key|access[-_]?token|refresh[-_]?token|client[-_]?secret|password|passwd|authorization|cookie|token|secret)\b["']?\s*[=:]\s*["']?)(?:Bearer\s+)?[^\s,"';}\r\n]+/gi, '$1[redacted]');
    if (safe.length > MAX_TEXT) safe = safe.slice(0, MAX_TEXT) + '\n[Diagnostic exceeded the 65536-character metadata limit]';
    return safe;
  }
  function safe(value, depth = 0, seen = new Set()) {
    if (typeof value === 'string') return redactString(value);
    if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
    if (value === undefined) return undefined;
    if (depth > 8) return '[nested diagnostic limit]';
    if (typeof value !== 'object') return undefined;
    if (seen.has(value)) return '[circular cause]';
    seen.add(value);
    if (value instanceof Error) {
      const output = safe({ ...value, name: value.name, message: value.message, ...(value.cause ? { cause: value.cause } : {}) }, depth, seen);
      seen.delete(value); return output;
    }
    const output = Array.isArray(value) ? [] : {};
    for (const [key, item] of Object.entries(value).slice(0, 100)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) continue;
      output[key] = SECRET_KEY.test(key) ? '[redacted]' : safe(item, depth + 1, seen);
    }
    seen.delete(value);
    return output;
  }
  return { text: redactString, safe };
}

function diagnosticFrom(value, context = {}, redactor = createRedactor()) {
  const source = value instanceof Error ? value : record(value);
  const nested = record(source.error);
  // A failed tool commonly puts its explanation in result.content, not `error`.
  // This path is used only for diagnostics; ordinary tool output is not stored.
  const result = record(source.result);
  const resultError = record(result.error);
  const detail = { ...record(resultError.details), ...record(result.details), ...record(nested.details), ...record(source.details), ...record(source.errorDetail), ...record(source.errorObservation) };
  for (const field of ['reason', 'expected', 'received', 'attempt', 'maxAttempts', 'timeoutPhase', 'providerStarted', 'stopReason', 'executionSettled', 'fallbackExhaustedFailure', 'livenessState', 'method']) if (source[field] !== undefined) detail[field] = source[field];
  const candidates = [source, nested, record(source.errorDetail), record(source.errorObservation), resultError, result, detail];
  const pick = (...keys) => {
    for (const candidate of candidates) for (const key of keys) if (candidate[key] !== undefined && candidate[key] !== null && candidate[key] !== '') return candidate[key];
    return undefined;
  };
  const resultBlocks = Array.isArray(source.result) ? source.result : result.content;
  const resultText = typeof source.result === 'string' ? source.result : Array.isArray(resultBlocks) ? resultBlocks.filter(part => typeof part?.text === 'string').map(part => part.text).join('\n') : undefined;
  const rawMessage = typeof value === 'string' ? value : text(source.errorMessage) || text(source.message) || text(source.error) || text(nested.message) || text(resultError.message) || text(result.message) || text(result.error) || text(resultText) || text(detail.aggregated) || text(detail.error) || text(record(detail.error).message) || text(source.toolErrorSummary) || text(source.summary) || text(detail.providerErrorMessagePreview) || text(source.reason) || context.message || 'Gateway operation failed';
  const diagnostic = {
    message: redactor.text(rawMessage),
    at: finite(context.at) ?? Date.now(),
    terminal: context.terminal === true,
    ...(text(context.runId) || text(pick('runId', 'run_id')) ? { runId: context.runId || pick('runId', 'run_id') } : {}),
    ...(text(context.itemId) ? { itemId: context.itemId } : {}),
  };
  for (const [target, keys] of Object.entries({ code: ['code', 'errorCode'], kind: ['errorKind', 'kind', 'providerRuntimeFailureKind'], provider: ['provider'], model: ['model'], requestId: ['requestId', 'request_id'], retryable: ['retryable'], retryAfterMs: ['retryAfterMs', 'retry_after_ms'] })) {
    const selected = pick(...keys);
    if (selected !== undefined) diagnostic[target] = redactor.safe(selected);
  }
  const httpStatus = Number(pick('httpStatus', 'statusCode', 'status'));
  if (diagnostic.requestId === undefined && text(context.requestId)) diagnostic.requestId = redactor.text(context.requestId);
  if (Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599) diagnostic.httpStatus = httpStatus;
  const cause = source.cause ?? nested.cause ?? resultError.cause ?? result.cause;
  if (cause !== undefined) diagnostic.cause = redactor.safe(cause);
  if (Object.keys(detail).length) diagnostic.details = redactor.safe(detail);
  if (String(rawMessage).length > MAX_TEXT) diagnostic.truncated = true;
  // The message remains complete up to the explicit text limit. Pathological
  // nested diagnostics have a separate, explicit metadata bound.
  if (Buffer.byteLength(JSON.stringify(diagnostic)) > 384 * 1024) {
    for (const field of ['cause', 'details']) if (diagnostic[field] !== undefined) diagnostic[field] = { preview: JSON.stringify(diagnostic[field]).slice(0, 16384), note: 'Nested diagnostic exceeded metadata budget' };
    diagnostic.truncated = true;
  }
  // Lifecycle and terminal chat can project the same failure using different
  // kind/detail fields. Keep one notice and enrich it instead of doubling it.
  diagnostic.id = hash({ runId: diagnostic.runId, itemId: diagnostic.itemId, requestId: diagnostic.requestId, provider: diagnostic.provider, code: diagnostic.code, message: diagnostic.message });
  return diagnostic;
}

function gatewayRpcError(response, fallback = 'Gateway operation failed') {
  const error = record(response?.error || response);
  return Object.assign(new Error(text(error.message) || fallback), error);
}

class GatewayObservability {
  constructor({ dataDir, secrets = [], emit = () => {} }) {
    this.file = path.join(dataDir, 'activity-state.json');
    this.redactor = createRedactor(secrets);
    this.emit = emit;
    this.sessions = new Map();
    this.connections = new Map();
    this.seen = new Map();
    this.lastEmits = new Map();
    this.queuedEmits = new Map();
    this.load();
  }

  diagnostic(value, context) { return diagnosticFrom(value, context, this.redactor); }
  recordDiagnostic(agentId, key, error, context = {}) {
    const diagnostic = this.diagnostic(error, context);
    const session = this.getSession(agentId, key);
    if (!session) return diagnostic;
    const run = diagnostic.runId ? session.runs.find(item => item.runId === diagnostic.runId) : null;
    this.addDiagnostic(session, run, diagnostic);
    this.changed(session);
    return diagnostic;
  }
  observationError(agentId, key, error) {
    const session = this.getSession(agentId, key);
    if (!session) return;
    session.refreshError = this.recordDiagnostic(agentId, key, error, { terminal: false });
    session.stale = true;
    for (const run of session.runs) if (!TERMINAL.has(run.status)) run.uncertain = true;
    this.changed(session);
  }
  safeText(value) { return this.redactor.text(value); }
  sessionId(agentId, key) { return JSON.stringify([agentId, key]); }
  getSession(agentId, key, create = true) {
    if (!text(agentId) || !text(key) || key.length > 4096) return null;
    const id = this.sessionId(agentId, key);
    let session = this.sessions.get(id);
    if (!session && create) {
      const connection = this.connections.get(agentId);
      session = { version: 1, revision: 0, agentId, sessionKey: key, connected: connection?.connected === true, stale: connection?.connected !== true, hasActiveRun: null, activeRunId: null, updatedAt: null, runs: [], diagnostics: [], progress: null };
      this.sessions.set(id, session); this.prune();
    }
    return session;
  }
  snapshot(agentId, key) { const s = this.getSession(agentId, key); return s ? clone(s) : null; }
  revision(agentId, key) { return this.getSession(agentId, key)?.eventRevision || 0; }
  captureRevisions(agentId) {
    return new Map([...this.sessions.values()].filter(session => session.agentId === agentId).map(session => [session.sessionKey, session.eventRevision || 0]));
  }
  reconcileRows(agentId, rows, revisions) {
    for (const row of rows) {
      if (!row?.key || !this.getSession(agentId, row.key, false)) continue;
      this.reconcile(agentId, row.key, row, { revision: revisions.get(row.key) ?? 0 });
    }
  }

  changed(session, at) {
    if (finite(at) !== undefined) session.updatedAt = Math.max(session.updatedAt || 0, at);
    session.revision++;
    const id = this.sessionId(session.agentId, session.sessionKey);
    this.sessions.delete(id); this.sessions.set(id, session);
    this.prune(); this.scheduleSave();
    // Tool argument deltas/usage can be frequent. Publish at most ten metadata
    // snapshots per second per session while keeping every fact in memory.
    const delay = 100 - (Date.now() - (this.lastEmits.get(id) || 0));
    if (delay <= 0) {
      this.lastEmits.set(id, Date.now());
      this.emit(session.agentId, session.sessionKey, clone(session));
    } else if (!this.queuedEmits.has(id)) {
      const timer = setTimeout(() => {
        this.queuedEmits.delete(id);
        const current = this.sessions.get(id);
        if (current) { this.lastEmits.set(id, Date.now()); this.emit(current.agentId, current.sessionKey, clone(current)); }
      }, delay);
      timer.unref?.(); this.queuedEmits.set(id, timer);
    }
  }
  setConnection(agentId, connected, error) {
    const diagnostic = error ? this.diagnostic(error, { terminal: false }) : null;
    this.connections.set(agentId, { connected, diagnostic });
    for (const session of [...this.sessions.values()].filter(value => value.agentId === agentId)) {
      session.connected = connected; session.stale = !connected;
      session.connectionError = diagnostic;
      for (const run of session.runs) if (!TERMINAL.has(run.status)) run.uncertain = true;
      // Connection is not progress: preserve the original run/item timestamps.
      this.changed(session);
    }
  }
  run(session, runId, at, activate = true) {
    if (!text(runId)) return null;
    let run = session.runs.find(item => item.runId === runId);
    if (!run) {
      run = { runId, status: 'running', updatedAt: at, items: [], diagnostics: [] };
      session.runs.push(run);
    }
    if (activate && !run.chatSettled && !TERMINAL.has(run.status)) {
      const active = session.runs.find(item => item.runId === session.activeRunId);
      if (!active || active.runId === runId || (at || 0) >= (active.startedAt || active.updatedAt || 0)) session.activeRunId = runId;
      session.hasActiveRun = true; run.uncertain = !session.connected;
    }
    return run;
  }
  addDiagnostic(session, run, diagnostic) {
    for (const target of [session.diagnostics, run?.diagnostics].filter(Boolean)) {
      const found = target.findIndex(item => item.id === diagnostic.id);
      if (found >= 0) target[found] = { ...target[found], ...diagnostic,
        ...(target[found].details || diagnostic.details ? { details: { ...target[found].details, ...diagnostic.details } } : {}),
      };
      else target.push(diagnostic);
      if (target.length > MAX_DIAGNOSTICS) target.splice(0, target.length - MAX_DIAGNOSTICS);
    }
  }
  finish(session, run, status, at, originalEnd) {
    if (!run) return;
    run.status = status; run.endedAt = originalEnd ?? at; run.updatedAt = Math.max(run.updatedAt || 0, at); run.uncertain = false;
    for (const item of run.items) if (item.status === 'running') { item.status = 'unknown'; item.uncertain = true; }
    if (session.activeRunId === run.runId) { session.activeRunId = null; session.hasActiveRun = false; }
  }
  duplicate(agentId, key, runId, category, payload) {
    const fingerprint = Number.isSafeInteger(payload.seq)
      ? { seq: payload.seq, generation: payload.lifecycleGeneration, state: payload.state, stream: payload.stream, phase: payload.data?.phase }
      : payload;
    const id = hash([agentId, key, runId, category, fingerprint]);
    if (this.seen.has(id)) return true;
    this.seen.set(id, true);
    while (this.seen.size > 2500) this.seen.delete(this.seen.keys().next().value);
    return false;
  }

  ingest(agentId, event, payload) {
    const p = record(payload);
    const key = text(p.sessionKey) || text(p.question?.sessionKey) || text(p.approval?.sourceSessionKey);
    if (!key) return { accepted: false };
    const d = Object.keys(record(p.data)).length ? p.data : p;
    const runId = text(p.runId) || text(d.runId) || text(p.question?.runId) || text(p.approval?.runId);
    const at = finite(p.ts) ?? finite(d.ts) ?? finite(d.updatedAt) ?? finite(d.endedAt) ?? finite(d.startedAt) ?? Date.now();
    const timeSource = [p.ts, d.ts, d.updatedAt, d.endedAt, d.startedAt].some(value => finite(value) !== undefined) ? 'gateway' : 'observed';
    const stream = event === 'chat' ? 'chat' : event === 'session.tool' ? (p.stream || 'tool') : p.stream;
    // Heartbeats/ticks are transport liveness, never work performed or progress.
    if (p.isHeartbeat === true || ['heartbeat', 'tick', 'keepalive', 'ping'].includes(stream)) return { accepted: false };
    const supported = event === 'chat' || event === 'session.tool' || event === 'session.observer' || ['item', 'tool', 'thinking', 'assistant', 'run_status', 'lifecycle', 'execution', 'error', 'usage', 'plan', 'notice', 'guardian'].includes(stream);
    if (!supported) return { accepted: false };
    if (this.duplicate(agentId, key, runId, stream || event, p)) return { accepted: false, duplicate: true };
    const session = this.getSession(agentId, key);
    const isChatTerminal = event === 'chat' && ['final', 'aborted', 'error'].includes(p.state);
    const run = this.run(session, runId, at, !isChatTerminal && !(stream === 'lifecycle' && ['end', 'error'].includes(d.phase)));
    if (isChatTerminal && run?.chatSettled) return { accepted: false, duplicate: true };
    if (run?.chatSettled && !isChatTerminal) return { accepted: false, duplicate: true };
    if (run && TERMINAL.has(run.status) && !isChatTerminal) return { accepted: false, duplicate: true };
    let diagnostic;
    let firstTerminal = false;
    if (event === 'chat') {
      if (isChatTerminal) {
        if (run) { run.chatSettled = true; firstTerminal = true; }
        const status = p.state === 'final' ? (p.yielded === true ? 'waiting' : 'completed') : p.state === 'aborted' ? 'aborted' : 'error';
        if (p.state === 'error' || text(p.errorMessage)) {
          diagnostic = this.diagnostic(p, { runId, at, terminal: true }); this.addDiagnostic(session, run, diagnostic);
        }
        if (status === 'waiting') {
          if (run) { run.status = 'waiting'; run.phase = 'yielded'; run.uncertain = false; }
          if (session.activeRunId === runId) { session.activeRunId = null; session.hasActiveRun = false; }
        } else this.finish(session, run, status, at, finite(p.message?.timestamp));
      } else if (p.state === 'status' && run) {
        run.phase = text(p.phase) || run.phase;
        run.status = p.retry ? 'retrying' : 'running';
        if (p.retry) run.retry = this.redactor.safe(p.retry); else delete run.retry;
      } else if (p.state === 'delta' && run) {
        // Streaming content itself is never retained in this projection.
        if (run.phase === 'responding' && run.status === 'running') { session.eventRevision = (session.eventRevision || 0) + 1; return { accepted: true }; }
        run.phase = 'responding'; run.status = 'running'; delete run.retry;
      }
    } else if (stream === 'tool' || stream === 'item') {
      if (!run) return { accepted: false };
      const name = text(d.name) || text(d.toolName) || text(d.tool) || text(p.toolName);
      const id = text(d.toolCallId) || text(d.callId) || text(d.itemId) || text(p.toolCallId) || text(p.callId);
      if (!id || (!name && !text(d.title))) { session.eventRevision = (session.eventRevision || 0) + 1; this.changed(session, at); return { accepted: true }; }
      let item = run.items.find(value => value.id === id);
      if (!item) { item = { id, kind: text(d.kind) || 'tool', title: '', status: 'running', updatedAt: at }; run.items.push(item); }
      if (name) item.name = this.safeText(name);
      const title = text(d.title) || text(d.meta);
      if (title) item.title = this.safeText(title);
      else if (!item.title) item.title = this.safeText(name || d.kind || 'Activity');
      item.kind = text(d.kind) || item.kind;
      item.title = item.title.slice(0, 1200);
      if (item.name) item.name = item.name.slice(0, 200);
      item.phase = text(d.phase) || text(d.state) || 'start';
      item.timeSource = timeSource;
      if (finite(d.startedAt) !== undefined) item.startedAt = d.startedAt;
      else if (!item.startedAt && item.phase === 'start' && timeSource === 'gateway') item.startedAt = at;
      if (finite(d.endedAt) !== undefined) item.endedAt = d.endedAt;
      const resultDetails = record(record(d.result).details);
      // Native exec calls a normal nonzero exit "completed" at the tool level,
      // then projects a failed activity item. Match that native presentation
      // rule while the full result is still available, before the item summary.
      const commandExitFailure = ['exec', 'bash', 'process'].includes(name?.toLowerCase()) && resultDetails.status === 'completed' && resultDetails.exitReason !== 'manual-cancel' && finite(resultDetails.exitCode) !== undefined && resultDetails.exitCode !== 0;
      const failed = d.ok === false || d.isError === true || ['failed', 'error', 'blocked'].includes(d.status) || item.phase === 'error' || commandExitFailure;
      const ended = ['end', 'result', 'completed', 'failed', 'error'].includes(item.phase) || ['completed', 'failed', 'error', 'skipped'].includes(d.status);
      item.status = failed ? 'error' : ended ? (d.status === 'skipped' ? 'skipped' : 'completed') : 'running';
      if (ended && item.endedAt === undefined && timeSource === 'gateway') item.endedAt = at;
      item.updatedAt = Math.max(item.updatedAt || 0, at);
      if (failed) {
        diagnostic = this.diagnostic(d, { runId, itemId: id, at, terminal: false, message: 'Tool execution failed' });
        if (item.diagnostic) {
          const previous = item.diagnostic;
          diagnostic = { ...previous, ...diagnostic, id: previous.id,
            ...(previous.details || diagnostic.details ? { details: { ...previous.details, ...diagnostic.details } } : {}),
          };
          // The later native item has only a short summary (or no error text).
          // Preserve the complete result, and enrich one notice in either order.
          if (d.result === undefined && previous.message !== 'Tool execution failed') diagnostic.message = previous.message;
        }
        item.diagnostic = diagnostic; this.addDiagnostic(session, run, diagnostic);
      }
      if (!TERMINAL.has(run.status)) { run.status = 'running'; run.phase = item.status === 'running' ? 'tool' : run.phase; }
    } else if ((stream === 'thinking' || stream === 'assistant') && run) {
      // An actual native stream proves this phase, not its private text. Keep
      // only the transition; repeated chunks guard pending reads without
      // pretending that content-free snapshots are additional work performed.
      const phase = stream === 'thinking' ? 'thinking' : 'responding';
      if (run.phase === phase && run.status === 'running') { session.eventRevision = (session.eventRevision || 0) + 1; return { accepted: true }; }
      run.phase = phase; run.status = 'running'; delete run.retry;
    } else if (stream === 'run_status' && run) {
      run.phase = text(d.phase) || run.phase;
      run.status = d.phase === 'retrying' ? 'retrying' : /^waiting/.test(d.phase || '') ? 'waiting' : 'running';
      if (run.status === 'retrying') run.retry = this.redactor.safe({ attempt: d.attempt, maxAttempts: d.maxAttempts, reason: d.reason, retryAfterMs: d.retryAfterMs });
      else delete run.retry;
      if (d.error || d.errorMessage || d.errorObservation) { diagnostic = this.diagnostic(d, { runId, at, terminal: false }); this.addDiagnostic(session, run, diagnostic); }
    } else if (stream === 'lifecycle' && run) {
      run.phase = text(d.phase) || run.phase;
      if (finite(d.startedAt) !== undefined) run.startedAt = d.startedAt;
      if (text(d.title)) run.title = this.safeText(d.title);
      if (text(d.provider)) run.provider = this.safeText(d.provider);
      if (text(d.model)) run.model = this.safeText(d.model);
      if (d.phase === 'error') {
        const cancelled = d.aborted === true || ['aborted', 'restart', 'stop', 'rpc', 'superseded'].includes(d.stopReason) || ['cancelled', 'canceled', 'aborted', 'superseded'].includes(d.status);
        const timedOut = d.timeoutPhase !== undefined || d.stopReason === 'timeout' || ['timeout', 'timed_out'].includes(d.status);
        const definitive = d.executionSettled === true || d.fallbackExhaustedFailure === true || cancelled || timedOut || ['blocked', 'abandoned'].includes(d.livenessState);
        diagnostic = this.diagnostic(d, { runId, at, terminal: definitive }); this.addDiagnostic(session, run, diagnostic);
        if (definitive) this.finish(session, run, cancelled ? 'aborted' : 'error', at, finite(d.endedAt));
        else run.uncertain = true;
      } else if (d.phase === 'end') {
        if (d.yielded === true) { run.status = 'waiting'; run.phase = 'yielded'; if (session.activeRunId === runId) { session.activeRunId = null; session.hasActiveRun = false; } }
        else this.finish(session, run, d.aborted === true || ['aborted', 'restart', 'stop', 'rpc'].includes(d.stopReason) ? 'aborted' : 'completed', at, finite(d.endedAt));
      } else if (/waiting|approval/.test(d.phase || '')) run.status = 'waiting';
      else if (!TERMINAL.has(run.status)) run.status = 'running';
    } else if (stream === 'execution' && run) {
      if (['running', 'waiting', 'unknown'].includes(d.state)) { run.status = d.state; run.wait = this.redactor.safe(d.wait); run.uncertain = d.state === 'unknown'; }
    } else if (stream === 'error' || stream === 'notice' || stream === 'guardian') {
      if (stream === 'error' || d.level === 'error' || d.severity === 'error' || text(d.error)) {
        diagnostic = this.diagnostic(d, { runId, at, terminal: false }); this.addDiagnostic(session, run, diagnostic);
      }
    } else if (stream === 'usage' && run) {
      if (finite(d.outputTokens) !== undefined) run.outputTokens = d.outputTokens;
    } else if (stream === 'plan' && run) {
      run.plan = this.normalizePlan(d.steps);
      if (text(d.explanation)) run.planExplanation = this.safeText(d.explanation);
    } else if (event === 'session.observer') {
      const headline = text(p.headline) || text(p.summary) || text(p.text) || text(p.digest?.headline);
      if (headline) { session.headline = this.safeText(headline); if (run) run.title = session.headline; }
    }
    if (run) { run.updatedAt = Math.max(run.updatedAt || 0, at); run.timeSource = timeSource; }
    session.eventRevision = (session.eventRevision || 0) + 1;
    this.changed(session, at);
    return { accepted: true, diagnostic, firstTerminal };
  }

  normalizePlan(steps) {
    return Array.isArray(steps) ? steps.filter(step => text(step?.step) && ['pending', 'in_progress', 'completed'].includes(step.status)).slice(0, 50).map(step => ({ step: this.safeText(step.step), status: step.status })) : [];
  }
  setProgress(agentId, key, card) {
    const session = this.getSession(agentId, key);
    if (!session) return;
    const before = JSON.stringify(session.progress);
    if (card === null) session.progress = null;
    else if (card && typeof card === 'object') {
      if (finite(card.revision) !== undefined && finite(session.progress?.revision) !== undefined && card.revision < session.progress.revision) return;
      session.progress = { source: 'gateway', revision: finite(card.revision), updatedAt: finite(card.updatedAt), ...(text(card.markdown) ? { markdown: this.safeText(card.markdown) } : {}), steps: this.normalizePlan(card.steps || card.plan) };
    } else return;
    if (before === JSON.stringify(session.progress) && !session.progressError) return;
    delete session.progressError;
    this.changed(session);
  }
  progressError(agentId, key, error) {
    const session = this.getSession(agentId, key);
    if (!session) return;
    session.progressError = this.diagnostic(error, { terminal: false }); this.changed(session);
  }
  reconcile(agentId, key, row, { revision } = {}) {
    const session = this.getSession(agentId, key);
    if (!session || !row || typeof row.hasActiveRun !== 'boolean') return;
    // A read begun before a live event cannot undo that newer event.
    if (revision !== undefined && (session.eventRevision || 0) !== revision) return;
    session.stale = !session.connected; delete session.refreshError;
    session.hasActiveRun = row.hasActiveRun;
    if (!row.hasActiveRun) {
      session.activeRunId = null;
      for (const run of session.runs) if (!TERMINAL.has(run.status) && run.status !== 'waiting') { run.status = 'unknown'; run.uncertain = true; }
    } else {
      const ids = Array.isArray(row.activeRunIds) ? row.activeRunIds.filter(text) : text(row.activeRunId) ? [row.activeRunId] : [];
      for (const id of ids.slice(0, MAX_RUNS)) {
        const run = this.run(session, id, finite(row.startedAt) ?? Date.now());
        if (run && !TERMINAL.has(run.status)) { if (run.status === 'unknown') run.status = 'running'; run.uncertain = !session.connected; }
      }
      if (!ids.length && session.activeRunId) {
        const active = session.runs.find(run => run.runId === session.activeRunId);
        if (active) active.uncertain = !session.connected;
      }
    }
    this.changed(session);
  }
  recover(agentId, key, inFlight) {
    if (!inFlight || !text(inFlight.runId)) return;
    const session = this.getSession(agentId, key);
    const run = this.run(session, inFlight.runId, finite(inFlight.startedAt) ?? Date.now());
    if (!run || run.chatSettled || TERMINAL.has(run.status)) return;
    if (finite(inFlight.startedAt) !== undefined) run.startedAt = inFlight.startedAt;
    for (const event of Array.isArray(inFlight.events) ? inFlight.events.slice(-80) : []) this.ingest(agentId, 'agent', { ...event, sessionKey: key, runId: inFlight.runId });
    if (inFlight.plan) run.plan = this.normalizePlan(inFlight.plan.steps);
    run.uncertain = !session.connected; this.changed(session);
  }
  forget(agentId, key) {
    const id = this.sessionId(agentId, key);
    clearTimeout(this.queuedEmits.get(id)); this.queuedEmits.delete(id); this.lastEmits.delete(id);
    if (this.sessions.delete(id)) this.scheduleSave();
  }
  prune() {
    for (const session of this.sessions.values()) {
      if (session.runs.length > MAX_RUNS) {
        const retained = [...session.runs].sort((a, b) => (a.runId === session.activeRunId ? -1 : b.runId === session.activeRunId ? 1 : (b.updatedAt || 0) - (a.updatedAt || 0))).slice(0, MAX_RUNS);
        session.runs = retained.reverse();
      }
      for (const run of session.runs) if (run.items.length > MAX_ITEMS) run.items.splice(0, run.items.length - MAX_ITEMS);
    }
    while (this.sessions.size > MAX_SESSIONS) this.evictFirst();
  }
  evictFirst() {
    const id = this.sessions.keys().next().value;
    this.sessions.delete(id); this.lastEmits.delete(id);
    clearTimeout(this.queuedEmits.get(id)); this.queuedEmits.delete(id);
  }
  scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.save(); }, 150);
    this.saveTimer.unref?.();
  }
  save() {
    try {
      this.prune();
      for (const session of this.sessions.values()) {
        // Retain the current/most recent facts first. Long failure messages are
        // not arbitrarily clipped just to retain many older observations.
        let size = Buffer.byteLength(JSON.stringify(session));
        while (size > MAX_SESSION_BYTES) {
          const older = session.runs.findIndex(run => run.runId !== session.activeRunId);
          if (session.runs.length > 1 && older >= 0) session.runs.splice(older, 1);
          else if (session.runs[0]?.items.length > 1) session.runs[0].items.shift();
          else if (session.runs[0]?.diagnostics.length > 1) session.runs[0].diagnostics.shift();
          else if (session.diagnostics.length > 1) session.diagnostics.shift();
          else break;
          session.retentionLimited = true;
          size = Buffer.byteLength(JSON.stringify(session));
        }
      }
      let encoded = JSON.stringify({ version: 1, sessions: [...this.sessions.values()] });
      while (Buffer.byteLength(encoded) > MAX_BYTES && this.sessions.size > 1) {
        this.evictFirst();
        encoded = JSON.stringify({ version: 1, sessions: [...this.sessions.values()] });
      }
      if (Buffer.byteLength(encoded) > MAX_BYTES) return;
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const temporary = this.file + '.' + process.pid + '.tmp';
      fs.writeFileSync(temporary, encoded, { mode: 0o600 }); fs.chmodSync(temporary, 0o600); fs.renameSync(temporary, this.file);
    } catch (error) {
      if (!this.storageError) console.warn('[hub] Activity metadata could not be persisted: ' + this.safeText(error.message));
      this.storageError = true;
    }
  }
  load() {
    try {
      if (fs.statSync(this.file).size > MAX_BYTES) return;
      const state = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (state.version !== 1 || !Array.isArray(state.sessions)) return;
      for (const original of state.sessions.slice(-MAX_SESSIONS)) {
        if (!text(original?.agentId) || !text(original.sessionKey) || !Array.isArray(original.runs) || !Array.isArray(original.diagnostics)) continue;
        const session = this.redactor.safe(original);
        session.connected = false; session.stale = true;
        for (const run of session.runs) if (!TERMINAL.has(run.status)) run.uncertain = true;
        this.sessions.set(this.sessionId(session.agentId, session.sessionKey), session);
      }
      this.prune();
    } catch {}
  }
}

module.exports = { GatewayObservability, createRedactor, diagnosticFrom, gatewayRpcError };
