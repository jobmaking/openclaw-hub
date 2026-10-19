/* Gateway-backed activity, diagnostics, progress and deliverable actions. */
'use strict';
(() => {
  const snapshots = new Map();
  const notices = new Map();
  const dismissed = new Set();
  const hiddenProgress = new Set();
  const artifactCache = new Map();
  let context = { agentId: null, sessionKey: null };
  let options = {};
  let navigation = 0;
  let request = null;
  let artifactRequest = null;
  let artifactReadSequence = 0;
  let artifactSignalTimer = null;
  const artifactRefreshTimers = new Set();
  let localSequence = 0;
  let renderQueued = false;
  let progressSignature = '';
  let artifactSignature = '';
  let noticeVersion = 0, renderedNoticeVersion = -1;
  let nodes = null;
  const scope = (agentId, key) => String(agentId || '') + '|' + String(key || '');
  const currentScope = () => scope(context.agentId, context.sessionKey);
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = String(text);
    return node;
  };
  const button = (text, action, label) => {
    const node = el('button', 'ha-button', text);
    node.type = 'button';
    if (label) node.setAttribute('aria-label', label);
    node.addEventListener('click', action);
    return node;
  };
  const timestamp = value => {
    const number = typeof value === 'number' ? value : Date.parse(value || '');
    return Number.isFinite(number) ? number : 0;
  };
  const clock = value => timestamp(value) ? new Date(timestamp(value)).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
  const elapsed = value => {
    const seconds = Math.max(0, Math.floor((Date.now() - timestamp(value)) / 1000));
    return seconds < 60 ? seconds + ' s' : Math.floor(seconds / 60) + ' min ' + seconds % 60 + ' s';
  };
  const labels = { running: 'En curso', retrying: 'Reintentando', waiting: 'Esperando', completed: 'Completado', aborted: 'Detenido', error: 'Fallido', unknown: 'Sin verificar' };
  const phases = { preparing_workspace: 'Preparando el espacio de trabajo', preparing_context: 'Preparando el contexto', starting_model: 'Iniciando el modelo', waiting_for_state: 'Esperando el estado del entorno', naming_worktree: 'Identificando el espacio de trabajo', creating_worktree: 'Creando el espacio de trabajo', running_setup: 'Preparando el entorno', provisioning_environment: 'Aprovisionando el entorno', memory_flushing: 'Guardando el contexto', finalizing: 'Cerrando el turno', compacting: 'Resumiendo el contexto', thinking: 'Razonando', reasoning: 'Razonando', writing: 'Generando respuesta', streaming: 'Generando respuesta', responding: 'Generando respuesta' };
  function safeJson(value) { try { return JSON.stringify(value, null, 2); } catch { return String(value); } }
  async function copy(value, success = 'Copiado') {
    if (options.copy) return options.copy(value, success);
    if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(value);
    const area = el('textarea', 'ha-copy-fallback');
    area.value = value; document.body.append(area); area.select();
    const ok = document.execCommand('copy'); area.remove();
    if (!ok) throw new Error('No se pudo copiar');
  }
  function copyButton(text, value, label) {
    return button(text, async event => {
      const node = event.currentTarget;
      try { await copy(typeof value === 'function' ? value() : value); node.textContent = 'Copiado'; }
      catch { node.textContent = 'No se pudo copiar'; }
      setTimeout(() => { if (node.isConnected) node.textContent = text; }, 1800);
    }, label);
  }
  function download(value, type, filename) {
    const url = URL.createObjectURL(new Blob([value], { type }));
    const link = el('a'); link.href = url; link.download = filename;
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function mount() {
    if (nodes || !document.getElementById('main')) return;
    const activity = el('details', 'hub-activity hidden'); activity.id = 'hub-activity';
    const summary = el('summary', 'ha-summary');
    const title = el('span', 'ha-summary-title');
    const age = el('span', 'ha-age');
    summary.append(title, age);
    const timeline = el('div', 'ha-timeline');
    activity.append(summary, timeline);
    const progress = el('section', 'hub-progress hidden'); progress.id = 'hub-progress';
    progress.setAttribute('aria-label', 'Progreso del agente');
    const artifacts = el('details', 'hub-artifacts hidden'); artifacts.id = 'hub-artifacts';
    const artifactsTitle = el('summary', '', 'Entregables');
    const artifactsBody = el('div', 'ha-artifacts-body'); artifacts.append(artifactsTitle, artifactsBody);
    const anchor = document.getElementById('prompts') || document.getElementById('composer');
    anchor.before(artifacts, activity, progress);
    const dialog = el('dialog', 'ha-diagnostics'); dialog.id = 'hub-diagnostics';
    dialog.setAttribute('aria-labelledby', 'hub-diagnostics-title');
    const header = el('header', 'ha-dialog-head');
    const heading = el('h2', '', 'Avisos y diagnósticos'); heading.id = 'hub-diagnostics-title';
    header.append(heading, button('Cerrar', () => dialog.close()));
    const diagnostics = el('div', 'ha-diagnostics-body');
    const footer = el('footer', 'ha-dialog-foot');
    footer.append(button('Descartar avisos vistos', clearNotices));
    dialog.append(header, diagnostics, footer); document.body.append(dialog);
    dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
    const sidebar = document.getElementById('s-errors');
    if (sidebar) {
      sidebar.removeAttribute('onclick'); sidebar.setAttribute('role', 'button'); sidebar.tabIndex = 0;
      sidebar.setAttribute('aria-label', 'Abrir avisos y detalles de error');
      sidebar.addEventListener('click', openDiagnostics);
      sidebar.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openDiagnostics(); } });
      const close = sidebar.querySelector('.s-err-close');
      if (close) { close.removeAttribute('onclick'); close.hidden = true; }
    }
    nodes = { activity, title, age, timeline, progress, artifacts, artifactsTitle, artifactsBody, dialog, diagnostics, sidebar };
    document.addEventListener('selectionchange', () => { if (document.getSelection()?.isCollapsed) queueRender(); });
    activity.addEventListener('focusout', queueRender);
    progress.addEventListener('focusout', queueRender);
  }
  function addDiagnostic(value, owner = {}) {
    if (!value) return;
    const diagnostic = typeof value === 'string' ? { message: value } : { ...value };
    if (!diagnostic.message) diagnostic.message = diagnostic.errorMessage || diagnostic.error || 'Error sin descripción';
    const ownerScope = scope(owner.agentId || diagnostic.agentId, owner.sessionKey || diagnostic.sessionKey);
    const id = ownerScope + '|' + (diagnostic.id || 'local-' + (++localSequence));
    if (dismissed.has(id)) return;
    const next = { ...diagnostic, id, agentId: owner.agentId || diagnostic.agentId, sessionKey: owner.sessionKey || diagnostic.sessionKey, at: diagnostic.at || Date.now() };
    const previous = notices.get(id);
    if (previous && safeJson({ ...previous, at: 0 }) === safeJson({ ...next, at: 0 })) return;
    notices.set(id, next); noticeVersion++;
    while (notices.size > 60) notices.delete(notices.keys().next().value);
    renderNotices();
  }
  function diagnosticBlock(diagnostic, owner, open = false) {
    const block = el('details', 'ha-diagnostic');
    block.dataset.diagnosticId = diagnostic.id || '';
    block.open = open;
    const summary = el('summary', '', diagnostic.message || 'Diagnóstico');
    const body = el('div', 'ha-diagnostic-content');
    const message = el('pre', 'ha-error-message', diagnostic.message || 'Sin descripción');
    body.append(message);
    const fields = [
      ['code', 'Código'], ['kind', 'Tipo'], ['provider', 'API'], ['model', 'Modelo'],
      ['httpStatus', 'HTTP'], ['retryable', 'Reintentable'], ['retryAfterMs', 'Espera (ms)'],
      ['requestId', 'Solicitud'], ['runId', 'Ejecución'], ['at', 'Fecha'], ['terminal', 'Final de ejecución'],
    ];
    const list = el('dl', 'ha-error-fields');
    for (const [key, label] of fields) if (diagnostic[key] !== undefined && diagnostic[key] !== null) {
      list.append(el('dt', '', label), el('dd', '', key === 'at' ? new Date(timestamp(diagnostic[key])).toLocaleString('es-ES') : String(diagnostic[key])));
    }
    if (owner?.agentId) list.append(el('dt', '', 'Agente'), el('dd', '', owner.agentId));
    if (owner?.sessionKey) list.append(el('dt', '', 'Sesión'), el('dd', '', owner.sessionKey));
    body.append(list);
    if (diagnostic.cause !== undefined) body.append(el('h4', '', 'Causa'), el('pre', 'ha-error-details', typeof diagnostic.cause === 'string' ? diagnostic.cause : safeJson(diagnostic.cause)));
    if (diagnostic.details !== undefined) body.append(el('h4', '', 'Detalles del gateway'), el('pre', 'ha-error-details', typeof diagnostic.details === 'string' ? diagnostic.details : safeJson(diagnostic.details)));
    const actions = el('div', 'ha-actions');
    actions.append(copyButton('Copiar diagnóstico', () => safeJson({ ...diagnostic, agentId: owner?.agentId, sessionKey: owner?.sessionKey })));
    if (owner?.sessionKey && options.openSession) actions.append(button('Abrir sesión', () => {
      nodes.dialog.close(); options.openSession(owner.agentId, owner.sessionKey);
    }));
    body.append(actions); block.append(summary, body); return block;
  }
  function renderNotices() {
    mount(); if (!nodes) return;
    if (renderedNoticeVersion === noticeVersion) return;
    renderedNoticeVersion = noticeVersion;
    const entries = [...notices.values()];
    const open = new Set([...nodes.diagnostics.querySelectorAll('details[open]')].map(node => node.dataset.diagnosticId));
    nodes.diagnostics.replaceChildren();
    if (!entries.length) nodes.diagnostics.append(el('p', 'ha-empty', 'No hay avisos pendientes.'));
    for (const entry of entries.slice().reverse()) nodes.diagnostics.append(diagnosticBlock(entry, entry, open.has(entry.id) || entries.length === 1));
    const sidebar = nodes.sidebar;
    if (!sidebar) return;
    sidebar.classList.toggle('hidden', !entries.length);
    if (entries.length) {
      const last = entries[entries.length - 1];
      sidebar.querySelector('.s-err-text').textContent = last.message;
      sidebar.querySelector('.s-err-count').textContent = String(entries.length);
      sidebar.querySelector('.s-err-icon').textContent = last.kind === 'connection' ? '🔌' : '⚠️';
      sidebar.classList.add('crit'); sidebar.title = 'Ver detalles: ' + last.message;
    }
  }
  function clearNotices() {
    for (const id of notices.keys()) dismissed.add(id);
    notices.clear(); noticeVersion++;
    while (dismissed.size > 500) dismissed.delete(dismissed.values().next().value);
    options.onClearErrors?.(); renderNotices();
  }
  function openDiagnostics() { mount(); renderNotices(); if (nodes && !nodes.dialog.open) nodes.dialog.showModal(); }
  function activeRun(snapshot) {
    return snapshot?.runs?.find(run => run.runId === snapshot.activeRunId) || snapshot?.runs?.at(-1) || null;
  }
  function status(agentId = context.agentId, sessionKey = context.sessionKey) {
    const snapshot = snapshots.get(scope(agentId, sessionKey));
    if (!snapshot) return null;
    const run = activeRun(snapshot);
    const nativeState = { connected: snapshot.connected === true, hasActiveRun: snapshot.hasActiveRun };
    if (!run) return { ...nativeState, active: snapshot.hasActiveRun === true, status: snapshot.connected === false ? 'unknown' : snapshot.hasActiveRun === true ? 'running' : 'idle', label: snapshot.connected === false ? 'Sin conexión · actividad sin verificar' : snapshot.hasActiveRun === true ? 'Turno activo · detalle no disponible' : '', uncertain: snapshot.connected === false, updatedAt: snapshot.updatedAt };
    const uncertain = snapshot.connected === false || snapshot.stale === true || run.uncertain === true;
    const item = [...(run.items || [])].reverse().find(entry => entry.status === 'running');
    const active = (snapshot.hasActiveRun === true || !!snapshot.activeRunId) && !['completed', 'aborted', 'error'].includes(run.status);
    let label;
    if (uncertain && active) label = snapshot.connected === false ? 'Sin conexión · actividad sin verificar' : 'Actividad sin verificar · última señal recibida';
    else if (!active) label = labels[run.status] || 'Estado sin verificar';
    else if (run.status === 'retrying') label = run.title || 'Reintento confirmado por el agente';
    else if (run.status === 'waiting') label = run.title || 'Esperando una acción';
    else if (item) label = (item.name ? item.name + ' · ' : '') + (item.title || labels[item.status]);
    else label = phases[run.phase] || run.title || (active ? 'Turno activo · esperando un evento del agente' : labels[run.status] || 'Estado sin verificar');
    return { ...nativeState, active, runId: run.runId, status: run.status, label, uncertain, updatedAt: run.updatedAt || snapshot.updatedAt, startedAt: run.startedAt };
  }
  function renderTimeline(snapshot) {
    const selection = document.getSelection();
    if ((!selection?.isCollapsed && nodes.timeline.contains(selection?.anchorNode)) || nodes.timeline.contains(document.activeElement)) return;
    const open = new Set([...nodes.timeline.querySelectorAll('details[open]')].map(node => node.dataset.itemId || node.dataset.diagnosticId));
    nodes.timeline.replaceChildren();
    for (const run of [...(snapshot.runs || [])].slice(-4).reverse()) {
      const section = el('section', 'ha-run');
      const head = el('div', 'ha-run-head');
      head.append(el('strong', '', labels[run.status] || run.status || 'Estado sin verificar'), el('time', '', clock(run.startedAt)));
      section.append(head);
      if (run.runId) section.append(el('code', 'ha-run-id', run.runId));
      for (const item of run.items || []) {
        const row = el('details', 'ha-item'); row.dataset.itemId = run.runId + '|' + item.id;
        row.dataset.status = item.status || 'unknown'; row.open = open.has(row.dataset.itemId);
        const summary = el('summary', 'ha-item-head');
        summary.append(el('span', 'ha-item-state', labels[item.status] || 'Sin verificar'), el('span', 'ha-item-title', (item.name ? item.name + ' · ' : '') + (item.title || item.kind || 'Actividad')), el('time', '', clock(item.startedAt || item.updatedAt)));
        const detail = el('div', 'ha-item-content');
        detail.append(el('pre', 'ha-item-description', item.title || item.name || item.kind || ''));
        if (item.startedAt) detail.append(el('p', 'ha-item-times', 'Inicio: ' + clock(item.startedAt) + (item.endedAt ? ' · Fin: ' + clock(item.endedAt) : '')));
        if (item.diagnostic) detail.append(diagnosticBlock(item.diagnostic, context));
        row.append(summary, detail); section.append(row);
      }
      for (const diagnostic of run.diagnostics || []) section.append(diagnosticBlock(diagnostic, context, open.has(diagnostic.id)));
      nodes.timeline.append(section);
    }
    if (snapshot.connectionError) nodes.timeline.append(el('p', 'ha-connection-warning', 'La conexión no permite verificar nueva actividad. ' + String(snapshot.connectionError?.message || snapshot.connectionError)));
  }
  function appendProgressMarkdown(target, markdown) {
    const pattern = /<progress\b([^>]*)>(?:\s*<\/progress>)?/gi;
    let previous = 0, match;
    const appendText = text => {
      if (!text.trim()) return;
      const content = options.markdown ? options.markdown(text) : el('div', 'ha-markdown-plain', text);
      for (const link of content.querySelectorAll?.('a') || []) {
        const href = link.getAttribute('href') || '';
        if (!/^(https?:|mailto:|\/api\/files\?)/i.test(href)) link.removeAttribute('href');
        else { link.rel = 'noopener noreferrer'; if (/^https?:/i.test(href)) link.target = '_blank'; }
      }
      target.append(content);
    };
    while ((match = pattern.exec(markdown))) {
      appendText(markdown.slice(previous, match.index));
      const parsed = new DOMParser().parseFromString('<progress ' + match[1] + '></progress>', 'text/html').querySelector('progress');
      const maximum = Number(parsed.getAttribute('max'));
      const valueText = parsed.getAttribute('value');
      const value = Number(valueText);
      if (maximum > 0 && Number.isFinite(maximum) && valueText !== null && Number.isFinite(value) && value >= 0 && value <= maximum) {
        const meter = el('progress', 'ha-progress-bar'); meter.max = maximum; meter.value = value;
        const label = parsed.getAttribute('aria-label') || value + '/' + maximum;
        meter.setAttribute('aria-label', label); target.append(meter, el('span', 'ha-progress-label', label));
      }
      previous = pattern.lastIndex;
    }
    appendText(markdown.slice(previous));
  }
  function renderProgress(snapshot) {
    const card = snapshot?.progress || activeRun(snapshot)?.progress;
    const key = currentScope();
    if (!card || (!card.markdown && !(card.steps || card.plan)?.length)) {
      hiddenProgress.delete(key); progressSignature = ''; nodes.progress.replaceChildren(); nodes.progress.classList.add('hidden'); return;
    }
    if (hiddenProgress.has(key)) { nodes.progress.classList.add('hidden'); return; }
    const signature = key + '|' + safeJson(card);
    if (signature === progressSignature) return;
    const selection = document.getSelection();
    if ((!selection?.isCollapsed && nodes.progress.contains(selection?.anchorNode)) || nodes.progress.contains(document.activeElement)) return;
    progressSignature = signature;
    const wasOpen = nodes.progress.querySelector('details')?.open || false;
    const details = el('details', 'ha-progress-card'); details.open = wasOpen;
    const summary = el('summary', '', 'Progreso del agente');
    const body = el('div', 'ha-progress-content');
    if (card.markdown) appendProgressMarkdown(body, String(card.markdown));
    const steps = card.steps || card.plan || [];
    if (steps.length) {
      const list = el('ol', 'ha-plan');
      for (const step of steps) {
        const item = el('li', '', step.step || step.text || step.title || ''); item.dataset.status = step.status;
        const icon = el('span', 'ha-step-state', step.status === 'completed' ? '✓' : step.status === 'in_progress' ? '●' : '○'); icon.setAttribute('aria-label', step.status === 'completed' ? 'Completado' : step.status === 'in_progress' ? 'En curso' : 'Pendiente'); item.prepend(icon); list.append(item);
      }
      body.append(list);
    }
    const actions = el('div', 'ha-actions');
    actions.append(copyButton('Copiar progreso', () => [card.markdown || '', ...steps.map(step => (step.status === 'completed' ? '[x] ' : '[ ] ') + (step.step || step.text || step.title || ''))].join('\n')));
    actions.append(button('Ocultar en este chat', () => { hiddenProgress.add(key); nodes.progress.classList.add('hidden'); }));
    body.append(actions); details.append(summary, body); nodes.progress.replaceChildren(details); nodes.progress.classList.remove('hidden');
    enhanceMessages(nodes.progress);
  }
  function render() {
    mount(); if (!nodes) return;
    const snapshot = snapshots.get(currentScope());
    nodes.activity.classList.toggle('hidden', !snapshot?.runs?.length);
    if (!snapshot) { nodes.progress.classList.add('hidden'); nodes.artifacts.classList.add('hidden'); return; }
    const current = status();
    nodes.title.textContent = current?.label || 'Actividad del agente';
    nodes.activity.dataset.status = current?.uncertain ? 'unknown' : current?.status || 'unknown';
    nodes.age.textContent = current?.updatedAt ? 'Último evento · ' + clock(current.updatedAt) : '';
    renderTimeline(snapshot); renderProgress(snapshot); renderArtifacts();
    options.onState?.(snapshot, current);
  }
  function queueRender() {
    if (renderQueued) return;
    renderQueued = true; requestAnimationFrame(() => { renderQueued = false; render(); });
  }
  function accept(snapshot, agentId, sessionKey) {
    if (!snapshot || !agentId || !sessionKey) return;
    const key = scope(agentId, sessionKey), existing = snapshots.get(key);
    if (existing) {
      const older = Number.isSafeInteger(existing.revision) && Number.isSafeInteger(snapshot.revision)
        ? existing.revision > snapshot.revision : timestamp(existing.updatedAt) > timestamp(snapshot.updatedAt);
      if (older) return;
    }
    snapshots.set(key, { ...snapshot, agentId, sessionKey });
    while (snapshots.size > 80) snapshots.delete(snapshots.keys().next().value);
    for (const diagnostic of snapshot.diagnostics || []) addDiagnostic(diagnostic, { agentId, sessionKey });
    for (const run of snapshot.runs || []) for (const diagnostic of run.diagnostics || []) addDiagnostic(diagnostic, { agentId, sessionKey });
    if (key === currentScope()) queueRender();
  }
  function consumeEvent(message) {
    if (message.type === 'activity' || message.type === 'activity_snapshot') { accept(message.snapshot, message.agentId, message.sessionKey); return true; }
    if (message.type === 'artifacts_changed') {
      if (message.agentId === context.agentId && message.sessionKey === context.sessionKey) {
        // A later rewrite may keep the same messageId; debounce bursts, not IDs.
        clearTimeout(artifactSignalTimer); artifactRefreshTimers.delete(artifactSignalTimer);
        artifactSignalTimer = scheduleArtifactRefresh(100, navigation);
      }
      return true;
    }
    if (message.diagnostic) addDiagnostic(message.diagnostic, message);
    if (message.type === 'gw') {
      for (const [key, snapshot] of snapshots) if (snapshot.agentId === message.agentId) snapshots.set(key, { ...snapshot, connected: !!message.connected, stale: !message.connected });
      queueRender();
    }
    if (['final', 'aborted', 'error'].includes(message.type) && message.terminal !== false && message.agentId === context.agentId && message.sessionKey === context.sessionKey) {
      clearArtifactRefreshes(); loadArtifacts(navigation);
      // A final frame is not a media persistence barrier. Native invalidation is
      // primary; this finite recovery also covers missed or legacy projections.
      for (const delay of [300, 1000, 2500]) scheduleArtifactRefresh(delay, navigation);
    }
    return false;
  }
  function clearArtifactRefreshes() {
    for (const timer of artifactRefreshTimers) clearTimeout(timer);
    artifactRefreshTimers.clear(); artifactSignalTimer = null;
  }
  function scheduleArtifactRefresh(delay, version) {
    const timer = setTimeout(() => {
      artifactRefreshTimers.delete(timer);
      if (artifactSignalTimer === timer) artifactSignalTimer = null;
      if (version === navigation) loadArtifacts(version);
    }, delay);
    artifactRefreshTimers.add(timer); return timer;
  }
  async function select(agentId, sessionKey) {
    mount(); context = { agentId, sessionKey }; const version = ++navigation;
    clearArtifactRefreshes();
    request?.abort(); artifactRequest?.abort(); progressSignature = ''; artifactSignature = '';
    if (nodes) { nodes.activity.open = false; nodes.artifacts.open = false; }
    render(); if (!agentId || !sessionKey) return;
    request = new AbortController();
    const query = new URLSearchParams({ agent: agentId, key: sessionKey });
    try {
      const response = await fetch('/api/activity?' + query, { cache: 'no-store', signal: request.signal });
      const result = await response.json();
      if (version !== navigation) return;
      if (response.ok && result.snapshot) accept(result.snapshot, agentId, sessionKey);
      else if (!response.ok) addDiagnostic(result.diagnostic || { message: result.error || 'No se pudo verificar la actividad', kind: 'connection', terminal: false }, context);
    } catch (error) {
      if (error.name !== 'AbortError' && version === navigation) connection(false);
    }
    if (version === navigation) loadArtifacts(version);
  }
  function connection(connected) {
    for (const [key, snapshot] of snapshots) snapshots.set(key, { ...snapshot, connected, stale: !connected });
    queueRender();
  }
  async function loadArtifacts(version = navigation) {
    if (window.HubCapabilities?.artifacts === false) return;
    if (version !== navigation || !context.agentId || !context.sessionKey) return;
    artifactRequest?.abort(); const controller = artifactRequest = new AbortController();
    const key = currentScope(), readSequence = ++artifactReadSequence;
    try {
      const response = await fetch('/api/artifacts?' + new URLSearchParams({ agent: context.agentId, key: context.sessionKey }), { cache: 'no-store', signal: controller.signal });
      const result = await response.json(); if (version !== navigation || key !== currentScope() || controller.signal.aborted || readSequence !== artifactReadSequence) return;
      artifactCache.set(key, { artifacts: Array.isArray(result.artifacts) ? result.artifacts : [], error: response.ok ? null : result.error });
      while (artifactCache.size > 40) artifactCache.delete(artifactCache.keys().next().value);
      renderArtifacts();
    } catch (error) { if (error.name !== 'AbortError' && version === navigation && key === currentScope() && readSequence === artifactReadSequence) { artifactCache.set(key, { artifacts: [], error: 'No se pudieron consultar los entregables' }); renderArtifacts(); } }
  }
  function renderArtifacts() {
    if (!nodes) return;
    const result = artifactCache.get(currentScope());
    const signature = currentScope() + '|' + safeJson(result);
    if (artifactSignature === signature) return;
    artifactSignature = signature;
    nodes.artifacts.classList.toggle('hidden', !result?.artifacts?.length && !result?.error);
    nodes.artifactsBody.replaceChildren(); if (!result) return;
    nodes.artifactsTitle.textContent = 'Entregables' + (result.artifacts.length ? ' · ' + result.artifacts.length : '');
    if (result.error) { nodes.artifactsBody.append(el('p', 'ha-empty', result.error), button('Reintentar', () => loadArtifacts())); return; }
    for (const artifact of result.artifacts) {
      const row = el('div', 'ha-artifact');
      const title = artifact.title || artifact.fileName || artifact.name || 'Archivo';
      row.append(el('span', 'ha-artifact-title', title));
      if (artifact.downloadSupported !== false && artifact.id) {
        const link = el('a', 'ha-button', 'Descargar');
        link.href = '/api/artifact-download?' + new URLSearchParams({ agent: context.agentId, key: context.sessionKey, id: artifact.id });
        link.setAttribute('aria-label', 'Descargar ' + title); link.download = artifact.fileName || title; row.append(link);
      } else row.append(el('span', 'ha-empty', artifact.reason || 'Descarga no disponible en el gateway'));
      nodes.artifactsBody.append(row);
    }
  }
  function enhanceMessages(root) {
    if (!root?.querySelectorAll) return;
    for (const pre of root.querySelectorAll('.msg.assistant pre, .ha-progress-content pre')) {
      if (pre.dataset.hubActions || pre.closest('.ha-diagnostic, .ha-item')) continue;
      pre.dataset.hubActions = '1';
      const source = pre.querySelector('code')?.textContent ?? pre.textContent;
      const language = pre.dataset.lang || pre.querySelector('code')?.className.match(/language-([\w+-]+)/)?.[1] || 'txt';
      const extensions = { javascript: 'js', typescript: 'ts', python: 'py', bash: 'sh', shell: 'sh', html: 'html', css: 'css', json: 'json', sql: 'sql', yaml: 'yaml', markdown: 'md' };
      const suffix = extensions[language] || (/^[a-z0-9]+$/i.test(language) ? language : 'txt');
      const actions = el('div', 'ha-block-actions');
      actions.append(copyButton('Copiar código', source), button('Descargar', () => download(source, 'text/plain;charset=utf-8', 'codigo.' + suffix), 'Descargar código'));
      pre.after(actions);
    }
    for (const table of root.querySelectorAll('.msg.assistant table, .ha-progress-content table')) {
      if (table.dataset.hubActions) continue; table.dataset.hubActions = '1';
      const rows = [...table.rows].map(row => [...row.cells].map(cell => cell.textContent));
      const csv = '\uFEFF' + rows.map(row => row.map(value => {
        const safe = /^[\s]*[=+@-]/.test(value) ? "'" + value : value;
        return '"' + safe.replace(/"/g, '""') + '"';
      }).join(',')).join('\r\n');
      const actions = el('div', 'ha-block-actions');
      actions.append(copyButton('Copiar tabla', rows.map(row => row.join('\t')).join('\n')), button('Descargar CSV', () => download(csv, 'text/csv;charset=utf-8', 'tabla.csv')));
      (table.parentElement.classList.contains('table-wrap') ? table.parentElement : table).after(actions);
    }
  }
  window.HubActivity = Object.freeze({
    init(value = {}) { options = { ...options, ...value }; mount(); render(); },
    select, consumeEvent, connection, status, enhanceMessages, openDiagnostics, clearNotices,
    reportError: addDiagnostic,
    guardTerminal(message) {
      if (message.terminal === false || message.diagnostic?.terminal === false) return false;
      const snapshot = snapshots.get(scope(message.agentId, message.sessionKey));
      return !(snapshot?.activeRunId && message.runId && snapshot.activeRunId !== message.runId);
    },
    renderNotices,
  });
})();
