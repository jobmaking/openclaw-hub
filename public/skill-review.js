/* Skill Workshop review. All proposal text is inert; only an explicit reviewed revision may be decided. */
(() => {
  'use strict';
  if (window.HubSkillReview) return;

  const POLL_MS = 45000, REQUEST_MS = 20000;
  const terminal = new Set(['applied', 'rejected', 'quarantined', 'stale', 'superseded', 'discarded']);
  const statusLabels = { pending: 'Pendiente', staged: 'Pendiente', applied: 'Aplicada', rejected: 'Rechazada', quarantined: 'En cuarentena', stale: 'Obsoleta', superseded: 'Sustituida', discarded: 'Descartada' };
  let owner = null, trigger = null, ui = null, poll = null, denied = null, sequence = 0;
  const literal = value => value == null ? '' : typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  const pending = proposal => String(proposal.status || '').toLowerCase() === 'pending';
  const label = proposal => literal(proposal.title || proposal.name || proposal.id);
  const statusLabel = proposal => statusLabels[proposal.status] || literal(proposal.status) || 'Sin estado';
  const element = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const button = (className, text, action) => {
    const node = element('button', className, text); node.type = 'button';
    if (action) node.addEventListener('click', action);
    return node;
  };

  function context() {
    const app = typeof state !== 'undefined' ? state : window.state;
    const shell = document.getElementById('app');
    if (shell && (shell.hidden || shell.classList.contains('hidden'))) return null;
    if (!app || !app.user || !app.agent || !Array.isArray(app.agents)) return null;
    const agent = app.agents.find(item => item.id === app.agent);
    if (!agent || agent.skillsReviewEnabled !== true) return null;
    return { key: JSON.stringify([app.user, agent.id]), user: app.user, agent: agent.id,
      name: literal(agent.name || agent.id), catalog: app.agents };
  }

  function clearPoll() { clearTimeout(poll); poll = null; }
  function schedule() {
    clearPoll();
    if (owner && document.visibilityState !== 'hidden') poll = setTimeout(() => { void refresh(); }, POLL_MS);
  }
  function abortReads(scope) {
    for (const controller of scope.controllers) controller.abort();
    scope.controllers.clear();
  }
  function dispose() {
    clearPoll();
    const old = owner; owner = null;
    if (old) abortReads(old);
    closeReview(false);
    if (ui) { ui.dialog.remove(); ui = null; }
    if (trigger) { trigger.remove(); trigger = null; }
  }
  function syncScope() {
    const next = context();
    if (denied && (!next || next.key !== denied.key || next.catalog !== denied.catalog)) denied = null;
    if (!next || denied && denied.key === next.key) { if (owner || trigger || ui) dispose(); return null; }
    if (!owner || owner.key !== next.key) {
      dispose();
      owner = { ...next, generation: ++sequence, controllers: new Set(), proposals: null,
        listError: '', listRead: null, listVersion: 0, inspection: null, inspectVersion: 0,
        selection: null, action: null, notice: '', view: 'list' };
    } else { owner.name = next.name; owner.catalog = next.catalog; }
    ensureTrigger();
    if (ui) ui.agent.textContent = 'Workshop compartido · ' + owner.name;
    return owner;
  }
  function current(scope) {
    const live = context();
    if (!scope || scope !== owner || !live || live.key !== scope.key || denied && denied.key === live.key) {
      syncScope(); return false;
    }
    return true;
  }
  function forbid(scope) {
    if (!current(scope)) return;
    denied = { key: scope.key, catalog: scope.catalog };
    dispose();
  }

  function ensureTrigger() {
    const header = document.querySelector('#chat-header .header-right');
    if (!header) return;
    if (!trigger || !trigger.isConnected) {
      trigger = button('hub-sr-trigger', '', () => { void openReview(); });
      trigger.id = 'btn-skill-review'; trigger.title = 'Revisar skills';
      trigger.setAttribute('aria-haspopup', 'dialog'); trigger.setAttribute('aria-controls', 'skill-review-dialog');
      trigger.append(element('span', 'hub-sr-trigger-label', 'Skills'), element('span', 'hub-sr-badge', '…'));
      header.prepend(trigger);
    }
    renderTrigger();
  }
  function renderTrigger() {
    if (!trigger || !owner) return;
    const count = owner.proposals === null ? null : owner.proposals.filter(pending).length;
    const badge = trigger.querySelector('.hub-sr-badge');
    badge.textContent = count === null ? owner.listError ? '!' : '…' : String(count);
    trigger.dataset.error = String(!!owner.listError);
    trigger.setAttribute('aria-expanded', String(!!ui?.dialog.open));
    trigger.setAttribute('aria-label', 'Revisar skills: ' + (count === null ? 'recuento no disponible' : count + ' pendientes') + (owner.listError ? '. No se pudo actualizar; abre para ver el error.' : ''));
    trigger.title = 'Revisar skills' + (owner.listError ? ' · No se pudo actualizar' : '');
  }

  async function request(scope, path, options = {}) {
    const controller = options.controller || new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, REQUEST_MS);
    scope.controllers.add(controller);
    try {
      const response = await window.fetch(path, { method: options.body ? 'POST' : 'GET',
        credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
        headers: options.body ? { Accept: 'application/json', 'Content-Type': 'application/json' } : { Accept: 'application/json' },
        ...(options.body ? { body: JSON.stringify(options.body) } : {}) });
      let data;
      try { data = await response.json(); } catch { data = null; }
      if (!response.ok || !data || typeof data !== 'object') {
        const error = new Error(literal(data?.error) || (response.ok ? 'El servidor no devolvió una confirmación válida.' : 'No se pudo consultar el Workshop (HTTP ' + response.status + ').'));
        error.status = response.status; error.code = data?.code; throw error;
      }
      return data;
    } catch (error) {
      if (timedOut) { const timeout = new Error('Se agotó el tiempo de espera del Workshop.'); timeout.code = 'TIMEOUT'; throw timeout; }
      throw error;
    } finally { clearTimeout(timer); scope.controllers.delete(controller); }
  }
  const query = (scope, id, artifactPath) => {
    const params = new URLSearchParams({ agent: scope.agent });
    if (id !== undefined) params.set('id', id);
    if (artifactPath !== undefined) params.set('artifactPath', artifactPath);
    return params.toString();
  };
  function failure(error) { return literal(error?.message || 'No se pudo contactar con el Workshop.') + (error?.code ? ' [' + literal(error.code) + ']' : ''); }
  function validProposal(data, scope, id) {
    if (data.agent !== scope.agent || !data.proposal || data.proposal.id !== id || typeof data.proposal.revisionHash !== 'string' || !data.proposal.revisionHash) {
      throw new Error('La respuesta no corresponde al borrador y la revisión solicitados.');
    }
    return data.proposal;
  }

  function readList(scope) {
    if (!current(scope)) return Promise.resolve();
    if (scope.listRead) return scope.listRead.promise;
    const job = { version: ++scope.listVersion, controller: new AbortController(), promise: null };
    scope.listRead = job;
    renderList();
    job.promise = (async () => {
      try {
        const data = await request(scope, '/api/skill-proposals?' + query(scope), { controller: job.controller });
        if (!current(scope) || scope.listRead !== job) return;
        if (data.agent !== scope.agent || data.complete !== true || !Array.isArray(data.proposals)
          || data.proposals.some(proposal => !proposal || typeof proposal.id !== 'string' || !proposal.id)
          || new Set(data.proposals.map(proposal => proposal.id)).size !== data.proposals.length) {
          throw new Error('La lista recibida está incompleta. Se conserva el último recuento confirmado.');
        }
        scope.proposals = data.proposals; scope.listError = '';
        const selection = scope.selection;
        if (selection?.proposal && pending(selection.proposal)) {
          const listed = data.proposals.find(item => item.id === selection.id);
          if (!listed || !pending(listed) || listed.revisionHash !== selection.proposal.revisionHash) {
            selection.obsolete = true; selection.reviewedHash = null;
            selection.changeNotice = !listed || !pending(listed)
              ? 'Esta propuesta ya no figura entre los pendientes. El contenido que estás leyendo se conserva como referencia.'
              : 'Hay una revisión nueva. El contenido que estás leyendo no ha sido sustituido; vuelve a revisarlo antes de decidir.';
            renderSelectionNotice(); renderFooter();
          }
        }
      } catch (error) {
        if (!current(scope) || scope.listRead !== job || error.name === 'AbortError') return;
        if ([401, 403].includes(error.status)) { forbid(scope); return; }
        scope.listError = failure(error);
      } finally {
        if (current(scope) && scope.listRead === job) {
          scope.listRead = null; renderTrigger(); renderList(); schedule();
        }
      }
    })();
    return job.promise;
  }
  function cancelList(scope) {
    if (scope.listRead) scope.listRead.controller.abort();
    scope.listRead = null; ++scope.listVersion;
  }
  function refresh() {
    const scope = syncScope();
    if (!scope) return Promise.resolve();
    schedule();
    return readList(scope);
  }

  function ensureDialog() {
    if (ui) return;
    const dialog = element('dialog', 'hub-sr-dialog'); dialog.id = 'skill-review-dialog';
    dialog.setAttribute('aria-labelledby', 'skill-review-title');
    // Static shell only. Every server-controlled value below is assigned with textContent.
    dialog.innerHTML = '<header class="hub-sr-heading"><div><p class="hub-sr-eyebrow" id="skill-review-agent"></p><h2 id="skill-review-title">Skills en revisión</h2><p class="hub-sr-intro">Ningún cambio se aplica sin tu decisión.</p></div><button type="button" class="hub-sr-close" aria-label="Cerrar revisión de skills" title="Cerrar"><span aria-hidden="true">×</span></button></header>' +
      '<div class="hub-sr-body"><aside class="hub-sr-sidebar" aria-label="Propuestas de skills"><div class="hub-sr-list-heading"><h3>Pendientes <span id="skill-review-count"></span></h3><button type="button" class="hub-sr-refresh">Actualizar</button></div><p id="skill-review-list-status" class="hub-sr-list-status" role="status" aria-live="polite"></p><div id="skill-review-list" class="hub-sr-list" role="list"></div></aside><section id="skill-review-detail" class="hub-sr-detail" aria-label="Detalle de la propuesta"></section></div>' +
      '<footer class="hub-sr-footer"><p id="skill-review-action-message" class="hub-sr-action-message" role="status" aria-live="polite"></p><label class="hub-sr-confirm"><input id="skill-review-confirm" type="checkbox" aria-describedby="skill-review-revision"><span>He revisado este borrador y sus avisos.</span></label><div class="hub-sr-actions"><button type="button" id="skill-review-reject" class="hub-sr-reject">Rechazar</button><button type="button" id="skill-review-apply" class="hub-sr-apply">Aceptar skill</button></div></footer>';
    const find = selector => dialog.querySelector(selector);
    ui = { dialog, agent: find('#skill-review-agent'), body: find('.hub-sr-body'), list: find('#skill-review-list'),
      count: find('#skill-review-count'), listStatus: find('#skill-review-list-status'), detail: find('#skill-review-detail'),
      refresh: find('.hub-sr-refresh'), close: find('.hub-sr-close'), confirm: find('#skill-review-confirm'),
      apply: find('#skill-review-apply'), reject: find('#skill-review-reject'), actionMessage: find('#skill-review-action-message'),
      rows: new Map(), previousFocus: null };
    ui.agent.textContent = 'Workshop compartido · ' + owner.name;
    ui.close.addEventListener('click', () => closeReview(true));
    ui.refresh.addEventListener('click', () => { void refresh(); });
    ui.confirm.addEventListener('change', () => {
      const scope = syncScope(), selection = scope?.selection;
      if (!selection?.proposal || scope.action) return;
      selection.reviewedHash = ui.confirm.checked ? selection.proposal.revisionHash : null;
      renderFooter();
    });
    ui.apply.addEventListener('click', () => { void decide('apply'); });
    ui.reject.addEventListener('click', () => { void decide('reject'); });
    dialog.addEventListener('cancel', event => { event.preventDefault(); closeReview(true); });
    dialog.addEventListener('keydown', event => { if (event.key === 'Escape') event.stopPropagation(); });
    // Native dialog gestures must not reach the chat's global swipe-navigation handlers.
    for (const type of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) dialog.addEventListener(type, event => event.stopPropagation(), { passive: true });
    dialog.addEventListener('click', event => {
      if (event.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeReview(true);
    });
    document.body.append(dialog);
    renderDetail(); renderList(); renderFooter();
  }
  function fitDialog() {
    if (!ui?.dialog.open) return;
    const viewport = window.visualViewport;
    const width = viewport?.width || innerWidth, height = viewport?.height || innerHeight;
    const gap = width <= 600 || height < 480 ? 8 : 24;
    const boxWidth = Math.max(0, Math.min(1080, width - 2 * gap)), boxHeight = Math.max(0, Math.min(860, height - 2 * gap));
    const style = ui.dialog.style;
    style.setProperty('--hub-sr-left', ((viewport?.offsetLeft || 0) + (width - boxWidth) / 2) + 'px');
    style.setProperty('--hub-sr-top', ((viewport?.offsetTop || 0) + (height - boxHeight) / 2) + 'px');
    style.setProperty('--hub-sr-width', boxWidth + 'px'); style.setProperty('--hub-sr-height', boxHeight + 'px');
    ui.dialog.classList.toggle('hub-sr-compact', height < 480);
  }
  async function openReview() {
    const scope = syncScope(); if (!scope) return;
    ensureDialog();
    if (!ui.dialog.open) {
      ui.previousFocus = document.activeElement;
      renderDetail(); renderList(); renderFooter();
      ui.dialog.showModal(); fitDialog(); ui.close.focus({ preventScroll: true });
    }
    renderTrigger(); await readList(scope);
  }
  function closeReview(restoreFocus = true) {
    if (!ui) return;
    const previous = ui.previousFocus, wasOpen = ui.dialog.open, focused = document.activeElement;
    if (wasOpen) ui.dialog.close();
    if (owner) {
      owner.inspection?.controller.abort(); owner.inspection = null; ++owner.inspectVersion;
      owner.selection?.artifactController?.abort(); owner.selection = null; owner.view = 'list';
    }
    ui.detail.replaceChildren(); ui.rows.clear(); ui.list.replaceChildren();
    ui.confirm.checked = false; ui.previousFocus = null;
    if (restoreFocus && wasOpen && previous?.isConnected) previous.focus({ preventScroll: true });
    else if (!restoreFocus && focused?.isConnected && !ui.dialog.contains(focused) && focused !== trigger) focused.focus({ preventScroll: true });
    renderTrigger();
  }

  function renderView() {
    if (!ui || !owner) return;
    const detail = !!owner.selection && owner.view === 'detail';
    ui.dialog.classList.toggle('hub-sr-detail-view', detail);
    ui.dialog.classList.toggle('hub-sr-list-view', !detail);
  }
  function showInbox() {
    const scope = syncScope(); if (!scope) return;
    scope.view = 'list';
    renderView();
    ui.body.scrollTop = 0;
    const selected = scope.selection && ui.rows.get(scope.selection.id)?.firstElementChild;
    (selected || ui.refresh).focus({ preventScroll: true });
  }

  function renderList() {
    if (!ui || !owner) return;
    renderView();
    const proposals = owner.proposals?.filter(pending);
    ui.count.textContent = proposals ? String(proposals.length) : '…';
    ui.listStatus.textContent = owner.listError || (owner.listRead ? 'Actualizando…' : owner.proposals === null ? 'Consultando el Workshop…' : owner.notice);
    ui.listStatus.classList.toggle('hub-sr-error', !!owner.listError);
    ui.refresh.disabled = !!owner.listRead;
    if (proposals === undefined || proposals === null) {
      if (!ui.list.children.length) ui.list.append(element('p', 'hub-sr-empty', 'Todavía no hay un recuento confirmado.'));
      return;
    }
    if (!proposals.length) {
      ui.rows.clear();
      if (!ui.list.querySelector('.hub-sr-empty') || ui.list.childElementCount !== 1) ui.list.replaceChildren(element('p', 'hub-sr-empty', 'No hay propuestas pendientes.'));
      else ui.list.firstElementChild.textContent = 'No hay propuestas pendientes.';
      return;
    }
    for (const empty of ui.list.querySelectorAll('.hub-sr-empty')) empty.remove();
    const retained = new Set();
    proposals.forEach((proposal, index) => {
      let row = ui.rows.get(proposal.id);
      if (!row) {
        row = element('div', 'hub-sr-row'); row.setAttribute('role', 'listitem');
        const choose = button('hub-sr-proposal', '', () => { const scope = syncScope(); if (scope && !scope.action) void inspect(scope, proposal.id, { focus: true }); });
        choose.dataset.proposalId = proposal.id;
        choose.append(element('strong', 'hub-sr-proposal-title'), element('span', 'hub-sr-proposal-description'), element('span', 'hub-sr-proposal-meta'));
        row.append(choose); ui.rows.set(proposal.id, row);
      }
      const choose = row.firstElementChild;
      choose.querySelector('.hub-sr-proposal-title').textContent = label(proposal);
      choose.querySelector('.hub-sr-proposal-description').textContent = literal(proposal.description);
      choose.querySelector('.hub-sr-proposal-meta').textContent = (proposal.kind === 'update' ? 'Actualización' : proposal.kind === 'create' ? 'Nueva skill' : literal(proposal.kind) || 'Propuesta') + ' · ' + statusLabel(proposal);
      choose.setAttribute('aria-pressed', String(owner.selection?.id === proposal.id));
      choose.disabled = !!owner.action;
      retained.add(proposal.id);
      if (ui.list.children[index] !== row) ui.list.insertBefore(row, ui.list.children[index] || null);
    });
    for (const [id, row] of ui.rows) if (!retained.has(id)) { row.remove(); ui.rows.delete(id); }
  }

  function textSection(title, text, id) {
    const section = element('section', 'hub-sr-section');
    section.append(element('h4', '', title));
    const body = element('p', 'hub-sr-literal', literal(text));
    if (id) body.id = id;
    section.append(body); return section;
  }
  function fullSection(title, text, id, open) {
    const section = element('details', 'hub-sr-full'); section.open = open;
    section.append(element('summary', '', title));
    const content = element('pre', 'hub-sr-code', literal(text)); content.id = id; content.tabIndex = 0;
    section.append(content); return section;
  }
  function renderDetail() {
    if (!ui || !owner) return;
    const selection = owner.selection;
    ui.detail.replaceChildren();
    if (!selection) {
      const empty = element('div', 'hub-sr-placeholder');
      empty.append(element('span', 'hub-sr-placeholder-mark', '↗'), element('h3', '', 'Elige una propuesta'), element('p', '', 'Lee el contenido completo, los cambios y los avisos. Abrir un borrador no lo acepta ni lo rechaza.'));
      ui.detail.append(empty); renderView(); return;
    }
    const back = button('hub-sr-back', '← Volver a pendientes', showInbox);
    back.setAttribute('aria-label', 'Volver a la lista de propuestas pendientes');
    ui.detail.append(back);
    if (!selection.proposal) {
      ui.detail.append(element('p', selection.error ? 'hub-sr-error' : 'hub-sr-empty', selection.error || 'Cargando el borrador completo…'));
      if (selection.error) ui.detail.append(button('hub-sr-reinspect', 'Volver a consultar', () => { void inspect(owner, selection.id, { focus: true }); }));
      renderView(); return;
    }
    const proposal = selection.proposal;
    const heading = element('h3', 'hub-sr-detail-title', label(proposal)); heading.id = 'skill-review-detail-title'; heading.tabIndex = -1;
    const metadata = element('p', 'hub-sr-meta', (proposal.kind === 'update' ? 'Actualización' : proposal.kind === 'create' ? 'Nueva skill' : literal(proposal.kind) || 'Propuesta') + ' · ' + statusLabel(proposal)); metadata.id = 'skill-review-meta';
    const revision = element('p', 'hub-sr-revision', 'Revisión: ' + proposal.revisionHash); revision.id = 'skill-review-revision';
    ui.detail.append(heading, metadata, revision);
    if (proposal.description) ui.detail.append(element('p', 'hub-sr-description', literal(proposal.description)));
    const notice = element('div', 'hub-sr-selection-notice'); notice.id = 'skill-review-selection-notice'; notice.setAttribute('role', 'status');
    ui.detail.append(notice);
    if (proposal.goal) ui.detail.append(textSection('Objetivo', proposal.goal, 'skill-review-goal'));
    if (proposal.evidence) ui.detail.append(textSection('Evidencias', proposal.evidence, 'skill-review-evidence'));
    const scan = element('section', 'hub-sr-scan'); scan.id = 'skill-review-scan';
    const scanStatus = literal(proposal.scanStatus) || 'Sin informe';
    const clean = ['clean', 'passed', 'ok', 'safe'].includes(scanStatus.toLowerCase()) && (!proposal.scanFindings || Array.isArray(proposal.scanFindings) && !proposal.scanFindings.length);
    scan.classList.toggle('hub-sr-scan-warning', !clean);
    scan.append(element('h4', '', 'Escáner · ' + scanStatus));
    if (proposal.scanFindings && (!Array.isArray(proposal.scanFindings) || proposal.scanFindings.length)) scan.append(element('pre', 'hub-sr-literal', literal(proposal.scanFindings)));
    if (proposal.blockedReason) scan.append(element('p', 'hub-sr-blocked', literal(proposal.blockedReason)));
    else if (proposal.canApply !== true && pending(proposal)) scan.append(element('p', '', 'El Workshop no permite aplicar este borrador en su estado actual.'));
    ui.detail.append(scan);
    ui.detail.append(fullSection(typeof proposal.content === 'string' ? 'Contenido completo' : 'Contenido no disponible', typeof proposal.content === 'string' ? proposal.content : 'No se recibió el contenido completo. Este borrador no se puede aceptar.', 'skill-review-content', true));
    ui.detail.append(fullSection('Diferencias completas', proposal.diff, 'skill-review-diff', false));
    const files = element('section', 'hub-sr-section hub-sr-support'); files.append(element('h4', '', 'Archivos de apoyo'));
    const support = Array.isArray(proposal.supportFiles) ? proposal.supportFiles : [];
    if (!support.length) files.append(element('p', 'hub-sr-muted', 'Sin archivos de apoyo.'));
    for (const file of support) {
      if (typeof file.path !== 'string') continue;
      const choose = button('hub-sr-file', '', () => { void inspectArtifact(owner, selection, file.path); });
      choose.dataset.artifactPath = file.path;
      choose.append(element('span', '', file.path), element('small', '', Number.isFinite(file.bytes) ? file.bytes.toLocaleString('es-ES') + ' bytes' : 'Ver archivo'));
      files.append(choose);
    }
    const fileStatus = element('p', 'hub-sr-file-status'); fileStatus.id = 'skill-review-file-status'; fileStatus.setAttribute('role', 'status');
    const artifact = element('pre', 'hub-sr-code'); artifact.id = 'skill-review-artifact'; artifact.tabIndex = 0; artifact.hidden = true;
    files.append(fileStatus, artifact); ui.detail.append(files);
    renderSelectionNotice(); renderView();
  }
  function renderSelectionNotice() {
    if (!ui || !owner?.selection?.proposal) return;
    const selection = owner.selection, notice = ui.detail.querySelector('#skill-review-selection-notice');
    if (!notice) return;
    notice.replaceChildren();
    const message = selection.changeNotice || (selection.uncertain ? 'No hay confirmación de la última decisión. Comprueba el estado y revisa de nuevo antes de enviar otra.' : '');
    if (message) notice.append(element('p', '', message));
    if (selection.failureDetail) notice.append(element('p', 'hub-sr-failure-detail', selection.failureDetail));
    if (selection.obsolete || selection.uncertain) notice.append(button('hub-sr-reinspect', 'Volver a revisar', () => { void inspect(owner, selection.id, { focus: true }); }));
    notice.hidden = !message;
  }
  function renderFooter() {
    if (!ui || !owner) return;
    const selection = owner.selection, proposal = selection?.proposal;
    const eligible = !!proposal && pending(proposal) && !!proposal.revisionHash && !selection.obsolete && !selection.uncertain && !owner.inspection && !owner.action;
    ui.confirm.disabled = !eligible;
    ui.confirm.checked = !!proposal && selection.reviewedHash === proposal.revisionHash && eligible;
    const reviewed = eligible && ui.confirm.checked;
    ui.apply.disabled = !reviewed || proposal.canApply !== true;
    ui.reject.disabled = !reviewed;
    ui.apply.textContent = owner.action?.decision === 'apply' ? 'Aceptando…' : 'Aceptar skill';
    ui.reject.textContent = owner.action?.decision === 'reject' ? 'Rechazando…' : 'Rechazar';
    ui.actionMessage.textContent = selection?.message || (owner.action ? 'Esperando confirmación del Workshop…' : !proposal ? 'Selecciona y revisa un borrador antes de decidir.' : '');
    ui.actionMessage.classList.toggle('hub-sr-error', !!selection?.messageError);
    ui.actionMessage.classList.toggle('hub-sr-success', !!selection?.messageSuccess);
  }

  async function inspect(scope, id, options = {}) {
    if (!current(scope) || !ui?.dialog.open || scope.action) return;
    scope.inspection?.controller.abort(); scope.selection?.artifactController?.abort();
    const job = { version: ++scope.inspectVersion, controller: new AbortController() };
    scope.inspection = job; scope.notice = '';
    const selection = { id, token: job.version, proposal: null, reviewedHash: null, obsolete: false, uncertain: false,
      message: options.conflict ? 'El borrador cambió. Revisa esta versión y confirma de nuevo.' : '', messageError: !!options.conflict };
    scope.selection = selection; scope.view = 'detail';
    renderList(); renderDetail(); renderFooter();
    try {
      const data = await request(scope, '/api/skill-proposal?' + query(scope, id), { controller: job.controller });
      if (!current(scope) || scope.inspection !== job || scope.selection !== selection || !ui?.dialog.open) return;
      selection.proposal = validProposal(data, scope, id);
      if (typeof selection.proposal.diff !== 'string') throw new Error('Falta la comparación completa. No se puede decidir con una vista incompleta.');
      if (typeof selection.proposal.content !== 'string') {
        selection.proposal = { ...selection.proposal, canApply: false, blockedReason: selection.proposal.blockedReason || 'No se recibió el borrador completo; no se puede aceptar.' };
      }
      renderDetail();
      if (options.focus) {
        const heading = ui.detail.querySelector('.hub-sr-detail-title');
        heading?.focus({ preventScroll: true });
        if (ui.dialog.clientWidth < 650) ui.detail.scrollIntoView({ block: 'start', behavior: 'instant' });
      }
    } catch (error) {
      if (!current(scope) || scope.inspection !== job || error.name === 'AbortError') return;
      if ([401, 403].includes(error.status)) { forbid(scope); return; }
      selection.proposal = null; selection.error = failure(error); renderDetail();
    } finally {
      if (current(scope) && scope.inspection === job) { scope.inspection = null; renderFooter(); }
    }
  }

  async function inspectArtifact(scope, selection, artifactPath) {
    if (!current(scope) || scope.selection !== selection || !ui?.dialog.open) return;
    selection.artifactController?.abort();
    const controller = new AbortController(); selection.artifactController = controller;
    const status = ui.detail.querySelector('#skill-review-file-status'), artifact = ui.detail.querySelector('#skill-review-artifact');
    status.textContent = 'Consultando ' + artifactPath + '…'; status.classList.remove('hub-sr-error');
    artifact.hidden = true; artifact.textContent = '';
    try {
      const data = await request(scope, '/api/skill-proposal?' + query(scope, selection.id, artifactPath), { controller });
      if (!current(scope) || scope.selection !== selection || selection.artifactController !== controller || !ui?.dialog.open) return;
      const proposal = validProposal(data, scope, selection.id);
      if (proposal.revisionHash !== selection.proposal.revisionHash) {
        selection.obsolete = true; selection.reviewedHash = null; selection.changeNotice = 'El borrador cambió mientras se consultaba el archivo. Vuelve a revisar su versión actual.';
        renderSelectionNotice(); renderFooter(); throw new Error('Este archivo corresponde a otra revisión. No se mezcla con el borrador abierto.');
      }
      if (proposal.artifactPath !== artifactPath || typeof proposal.artifactContent !== 'string') throw new Error('La respuesta no contiene el archivo de apoyo solicitado.');
      artifact.textContent = proposal.artifactContent; artifact.hidden = false;
      status.textContent = artifactPath;
    } catch (error) {
      if (!current(scope) || scope.selection !== selection || selection.artifactController !== controller || error.name === 'AbortError') return;
      if ([401, 403].includes(error.status)) { forbid(scope); return; }
      status.textContent = failure(error); status.classList.add('hub-sr-error');
    }
  }

  async function reconcileUncertain(scope, selection) {
    // Read-only reconciliation never resubmits a decision or replaces the text being read.
    try {
      const data = await request(scope, '/api/skill-proposal?' + query(scope, selection.id));
      if (!current(scope) || scope.selection !== selection || !ui?.dialog.open) return;
      const proposal = validProposal(data, scope, selection.id);
      if (terminal.has(String(proposal.status).toLowerCase())) {
        selection.proposal = { ...selection.proposal, status: proposal.status, canApply: false };
        selection.message = 'Estado actual consultado: ' + statusLabel(proposal).toLowerCase() + '. La petición original no devolvió una confirmación válida.';
        const meta = ui.detail.querySelector('#skill-review-meta');
        if (meta) meta.textContent = 'Estado actual · ' + statusLabel(proposal);
      } else {
        selection.message = 'La decisión no quedó confirmada. Estado actual: ' + statusLabel(proposal).toLowerCase() + '. No se reintentará automáticamente.';
        if (proposal.revisionHash !== selection.proposal.revisionHash) selection.obsolete = true;
      }
      renderSelectionNotice(); renderFooter();
    } catch (error) {
      if (!current(scope) || scope.selection !== selection || error.name === 'AbortError') return;
      if ([401, 403].includes(error.status)) { forbid(scope); return; }
      selection.message = 'No se pudo verificar el estado. No se ha reenviado la decisión. ' + failure(error);
      renderFooter();
    }
  }

  async function decide(decision) {
    const scope = syncScope(), selection = scope?.selection, proposal = selection?.proposal;
    if (!scope || !ui?.dialog.open || !proposal || !pending(proposal) || scope.action || scope.inspection
      || selection.obsolete || selection.uncertain || selection.reviewedHash !== proposal.revisionHash
      || !ui.confirm.checked || decision === 'apply' && proposal.canApply !== true || !['apply', 'reject'].includes(decision)) return;
    const job = { id: proposal.id, revisionHash: proposal.revisionHash, decision, selection };
    scope.action = job; selection.message = 'Esperando confirmación del Workshop…';
    selection.messageError = false; selection.messageSuccess = false;
    cancelList(scope); renderList(); renderFooter();
    try {
      const data = await request(scope, '/api/skill-proposal-decision', { body: { agent: scope.agent, id: job.id, revisionHash: job.revisionHash, decision } });
      if (!current(scope) || scope.action !== job) return;
      const expected = decision === 'apply' ? 'applied' : 'rejected';
      if (data.ok !== true || data.status !== expected) throw new Error('El Workshop no confirmó la decisión y el estado esperados.');
      // Only a positive native acknowledgement is authoritative enough for immediate removal.
      if (scope.proposals) scope.proposals = scope.proposals.filter(item => item.id !== job.id || item.revisionHash !== job.revisionHash);
      scope.notice = decision === 'apply' ? 'Skill aceptada y aplicada.' : 'Propuesta rechazada.';
      if (scope.selection === selection) {
        selection.proposal = { ...proposal, status: expected, canApply: false }; selection.reviewedHash = null;
        selection.message = decision === 'apply' ? 'Skill aceptada. Ya está aplicada en el Workshop compartido.' : 'Propuesta rechazada. No se ha aplicado.';
        selection.messageSuccess = true;
        const meta = ui?.detail.querySelector('#skill-review-meta'); if (meta) meta.textContent = 'Decisión confirmada · ' + statusLabel(selection.proposal);
      }
    } catch (error) {
      if (!current(scope) || scope.action !== job) return;
      if ([401, 403].includes(error.status)) { forbid(scope); return; }
      if (scope.selection === selection) {
        selection.reviewedHash = null; selection.messageError = true;
        if (error.status === 409) {
          scope.action = null;
          selection.obsolete = true;
          selection.message = 'El borrador cambió. Consultando la revisión actual; necesitará una confirmación nueva.';
          renderFooter();
          if (ui?.dialog.open) await inspect(scope, job.id, { conflict: true, focus: false });
        } else {
          selection.uncertain = true; selection.failureDetail = failure(error);
          selection.message = 'No se confirmó la decisión y no se ha reenviado. ' + failure(error);
          renderSelectionNotice(); renderFooter();
          if (ui?.dialog.open) void reconcileUncertain(scope, selection);
        }
      }
    } finally {
      if (current(scope)) {
        if (scope.action === job) scope.action = null;
        renderTrigger(); renderList(); renderFooter();
        void readList(scope);
      }
    }
  }

  window.HubSkillReview = Object.freeze({ refresh, open: openReview, close: () => closeReview(true) });
  window.addEventListener('resize', fitDialog);
  window.visualViewport?.addEventListener('resize', fitDialog);
  window.visualViewport?.addEventListener('scroll', fitDialog);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') clearPoll(); else void refresh(); });
  window.addEventListener('pageshow', () => { void refresh(); });
  window.addEventListener('pagehide', clearPoll);
  // A disabled submit button may leave focus on body, outside the dialog tree.
  // Capture Escape there too, without invoking the chat's global Escape shortcuts.
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !ui?.dialog.open) return;
    event.preventDefault(); event.stopImmediatePropagation(); closeReview(true);
  }, true);
  // showLogin() hides the app on auth expiry. Clear top-layer content immediately,
  // even if that path cannot call the normal catalog/navigation hooks.
  const shell = document.getElementById('app');
  if (shell) new MutationObserver(() => { if (owner || trigger || ui) syncScope(); }).observe(shell, { attributes: true, attributeFilter: ['class', 'hidden'] });
  void refresh();
})();
