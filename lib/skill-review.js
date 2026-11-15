'use strict';

const crypto = require('node:crypto');

const SKILL_REVIEW_ROUTES = new Set(['/skill-proposals', '/skill-proposal', '/skill-proposal-decision']);
const REVISION = /^[a-f0-9]{64}$/;
const PROPOSAL_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,255}$/;
const SUPPORT_PATH = /^(?:assets|examples|references|scripts|templates)\/(?!.*(?:^|\/)\.)(?!.*\\)[^\u0000-\u001f]+$/;

class ReviewError extends Error {
  constructor(message, status = 502, code = 'SKILL_REVIEW_FAILED') {
    super(message); this.status = status; this.code = code;
  }
}

function nativeAgent(link) { return link.cfg.gatewayAgentId || 'main'; }

function nativeError(result) {
  const error = result?.error || {};
  const message = String(error.message || 'El Gateway no confirmó la operación de Skill Workshop');
  const code = String(error.details?.code || error.code || 'GATEWAY_ERROR');
  const conflict = code === 'SKILL_PROPOSAL_REVISION_CHANGED' || /revision|changed|stale|hash|no longer pending|not pending|already applied|already rejected/i.test(message);
  const status = conflict ? 409 : /FORBIDDEN|UNAUTHORIZED|SCOPE/.test(code) ? 403
    : /NOT_FOUND/.test(code) ? 404 : /UNAVAILABLE|DISCONNECTED|TIMEOUT/.test(code) ? 503 : 502;
  return new ReviewError(message, status, code);
}

async function rpc(link, method, params) {
  const result = await link.req(method, { agentId: nativeAgent(link), ...params }, 25000);
  if (!result?.ok) throw nativeError(result);
  return result.payload;
}

function summary(item) {
  if (!item || !PROPOSAL_ID.test(item.id || '')) {
    throw new ReviewError('La lista de propuestas no contiene identidades verificables');
  }
  return { id: item.id, name: item.skillName || item.name || '', title: item.title || item.skillName || item.id,
    description: item.description || '', kind: item.kind, status: item.status,
    revisionHash: REVISION.test(item.revisionHash || '') ? item.revisionHash : null };
}

async function inspectNative(link, id) {
  let result, ownedItem;
  try { result = await rpc(link, 'skills.proposals.inspect', { proposalId: id }); }
  catch (error) {
    if (error.status === 403) throw error;
    const manifest = await rpc(link, 'skills.proposals.list', {});
    ownedItem = manifest?.proposals?.find(item => item.id === id);
    // Missing drafts are explicitly identified by the native agent-scoped
    // inventory. Preserve rejection with its recorded hash, never invent content.
    if (ownedItem?.degradedState !== 'draft-missing' || !REVISION.test(ownedItem.revisionHash || '')) throw error;
    result = { record: { id, kind: ownedItem.kind, status: ownedItem.status, title: ownedItem.title,
      description: ownedItem.description, target: { skillName: ownedItem.skillName },
      scan: { state: ownedItem.scanState || 'unknown' } }, revisionHash: ownedItem.revisionHash, content: null };
  }
  const record = result?.record;
  // Origin is optional provenance, not ownership. Native RPCs are agent-scoped;
  // require independent inventory membership when legacy provenance is absent.
  if (!record || record.id !== id || record.origin?.agentId && record.origin.agentId !== nativeAgent(link)
      || record.agentId && record.agentId !== nativeAgent(link)) {
    throw new ReviewError('La propuesta no pertenece a este agente', 403, 'FORBIDDEN');
  }
  if (!record.origin?.agentId && !record.agentId && !ownedItem) {
    const manifest = await rpc(link, 'skills.proposals.list', {});
    if (!manifest?.proposals?.some(item => item.id === id)) throw new ReviewError('La propuesta no pertenece a este agente', 403, 'FORBIDDEN');
  }
  if (!REVISION.test(result.revisionHash || '')) throw new ReviewError('La propuesta no tiene una revisión verificable');
  return result;
}

// Keep every line, including unchanged context. Linear work avoids an unbounded
// LCS allocation when an operator opens a large skill. No HTML is generated.
function instructionDiff(before, after, name) {
  const oldLines = before.split('\n'), newLines = after.split('\n');
  let prefix = 0, suffix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++;
  while (suffix < oldLines.length - prefix && suffix < newLines.length - prefix
      && oldLines[oldLines.length - suffix - 1] === newLines[newLines.length - suffix - 1]) suffix++;
  const lines = ['--- Instalada: ' + name, '+++ Propuesta: ' + name];
  lines.push(...oldLines.slice(0, prefix).map(line => '  ' + line));
  lines.push(...oldLines.slice(prefix, oldLines.length - suffix).map(line => '- ' + line));
  lines.push(...newLines.slice(prefix, newLines.length - suffix).map(line => '+ ' + line));
  if (suffix) lines.push(...oldLines.slice(-suffix).map(line => '  ' + line));
  return lines.join('\n');
}

async function proposalView(link, result, artifactPath) {
  const record = result.record;
  const name = record.target?.skillName || '';
  const content = typeof result.content === 'string' ? result.content : null;
  const files = Array.isArray(result.supportFiles) ? result.supportFiles : [];
  const manifest = Array.isArray(record.supportFiles) ? record.supportFiles : [];
  const supportFiles = manifest.map(file => ({ path: file.path, bytes: file.sizeBytes }));
  let artifactContent = null;
  if (artifactPath) {
    if (!SUPPORT_PATH.test(artifactPath) || artifactPath.split('/').some(part => !part || part.startsWith('.'))
        || !manifest.some(file => file.path === artifactPath)) {
      throw new ReviewError('Archivo ajeno a esta propuesta', 400, 'INVALID_ARTIFACT');
    }
    const artifact = files.find(file => file.path === artifactPath);
    if (typeof artifact?.content !== 'string') throw new ReviewError('No se pudo leer el archivo completo de la propuesta');
    artifactContent = artifact.content;
  }
  let blockedReason = record.status !== 'pending' ? 'Esta propuesta ya no está pendiente.' : null;
  if (content === null) blockedReason ||= 'El borrador no está disponible completo; no se puede aceptar.';
  if (manifest.some(file => !files.some(artifact => artifact.path === file.path && typeof artifact.content === 'string'))) {
    blockedReason ||= 'No están disponibles todos los archivos de apoyo; no se puede aceptar un borrador incompleto.';
  }
  if (record.scan?.critical > 0 || record.scan?.state === 'blocked') blockedReason ||= 'El análisis de seguridad contiene bloqueos críticos.';
  let current = '';
  if (record.kind === 'update') {
    try {
      const installed = await rpc(link, 'skills.workshop.read', { name });
      if (installed?.name !== name || typeof installed.content !== 'string') throw new Error('Incomplete installed skill');
      current = installed.content;
      const hash = crypto.createHash('sha256').update(current).digest('hex');
      if (record.target?.currentContentHash !== hash) {
        blockedReason ||= 'La skill instalada cambió desde que se creó esta propuesta. Solicita una revisión actualizada antes de aceptarla.';
      }
    } catch {
      current = '';
      blockedReason ||= 'No se pudo verificar la skill instalada. Actualiza la revisión antes de aceptar.';
    }
  }
  if (!['create', 'update'].includes(record.kind)) blockedReason ||= 'Tipo de propuesta no compatible.';
  return { id: record.id, name, title: record.title || name, description: record.description || '',
    kind: record.kind, status: record.status, revisionHash: result.revisionHash,
    goal: record.goal || '', evidence: record.evidence || '', content,
    diff: content === null ? '' : instructionDiff(current, content, name),
    scanStatus: record.scan?.state || 'unknown', scanFindings: record.scan?.findings || [], supportFiles,
    artifactPath: artifactPath || null, artifactContent, canApply: !blockedReason, blockedReason };
}

function mountSkillReview(app, { getLink, access, publicTenant, originAllowed }) {
  const inFlight = new Set();
  const authorize = (req, res, next) => {
    const source = ['GET', 'HEAD'].includes(req.method) ? req.query : req.body || {};
    const link = getLink(source.agent);
    if (publicTenant || !access.canReviewSkills(req.user, link?.id)) {
      return res.status(403).json({ error: 'No tienes permiso para revisar las skills compartidas de este agente', code: 'FORBIDDEN' });
    }
    req.skillLink = link; next();
  };
  const failure = (res, error, mutation = false) => {
    const uncertain = mutation && (!(error instanceof ReviewError) || error.status >= 500);
    return res.status(error.status || 503).json({
      error: uncertain ? 'No se recibió una confirmación completa. Comprueba el estado antes de decidir otra vez; la decisión no se ha repetido.' : error.message,
      code: error.code || 'GATEWAY_ERROR', ...(uncertain ? { uncertain: true } : {}),
    });
  };
  app.get('/api/skill-proposals', authorize, async (req, res) => {
    try {
      const result = await rpc(req.skillLink, 'skills.proposals.list', {});
      if (!Array.isArray(result?.proposals)) throw new ReviewError('No se pudo verificar la lista completa de propuestas');
      res.json({ agent: req.skillLink.id, proposals: result.proposals.filter(item => item.status === 'pending').map(summary), complete: true });
    } catch (error) { failure(res, error); }
  });
  app.get('/api/skill-proposal', authorize, async (req, res) => {
    const id = req.query.id;
    if (typeof id !== 'string' || !PROPOSAL_ID.test(id) || req.query.artifactPath !== undefined && typeof req.query.artifactPath !== 'string') {
      return res.status(400).json({ error: 'Falta una propuesta válida', code: 'INVALID_REQUEST' });
    }
    try {
      const inspected = await inspectNative(req.skillLink, id);
      res.json({ agent: req.skillLink.id, proposal: await proposalView(req.skillLink, inspected, req.query.artifactPath) });
    } catch (error) { failure(res, error); }
  });
  app.post('/api/skill-proposal-decision', authorize, async (req, res) => {
    if (!originAllowed(req)) return res.status(403).json({ error: 'Origen no permitido', code: 'FORBIDDEN' });
    const { id, revisionHash, decision } = req.body || {};
    if (typeof id !== 'string' || !PROPOSAL_ID.test(id) || typeof revisionHash !== 'string' || !REVISION.test(revisionHash)
        || !['apply', 'reject'].includes(decision)) return res.status(400).json({ error: 'Decisión o revisión inválida', code: 'INVALID_REQUEST' });
    const identity = JSON.stringify([req.skillLink.id, id]);
    if (inFlight.has(identity)) return res.status(409).json({ error: 'Ya hay una decisión en curso para esta propuesta', code: 'DECISION_IN_PROGRESS' });
    inFlight.add(identity);
    let dispatched = false;
    try {
      const inspected = await inspectNative(req.skillLink, id);
      if (inspected.record.status !== 'pending' || inspected.revisionHash !== revisionHash) {
        throw new ReviewError('La propuesta cambió. Revisa la versión actual y confirma de nuevo.', 409, 'REVISION_CONFLICT');
      }
      if (decision === 'apply') {
        const view = await proposalView(req.skillLink, inspected);
        if (!view.canApply) throw new ReviewError(view.blockedReason, 409, 'PROPOSAL_BLOCKED');
      }
      dispatched = true;
      await rpc(req.skillLink, 'skills.proposals.' + decision, { proposalId: id, expectedRevisionHash: revisionHash,
        reason: 'Decisión explícita desde el HUB' });
      // Read back the durable lifecycle state; an RPC acknowledgement alone is
      // not proof that a skill was applied. Never repeat a mutation on timeout.
      const confirmed = await rpc(req.skillLink, 'skills.proposals.list', {});
      const expected = decision === 'apply' ? 'applied' : 'rejected';
      if (!Array.isArray(confirmed?.proposals) || confirmed.proposals.find(item => item.id === id)?.status !== expected) {
        throw new Error('Unconfirmed native lifecycle state');
      }
      res.json({ ok: true, agent: req.skillLink.id, id, status: expected });
    } catch (error) { failure(res, error, dispatched); }
    finally { inFlight.delete(identity); }
  });
}

module.exports = { mountSkillReview, SKILL_REVIEW_ROUTES, instructionDiff };
