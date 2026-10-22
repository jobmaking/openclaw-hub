'use strict';

const bridge = window.hubDesktop;
const $ = (id) => document.getElementById(id);
let state = {}, findWasOpen = false, findTimer;
const rows = new Map();

function command(name, value) { return bridge.command(name, value).catch(() => {}); }

function bytes(value) {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const order = Math.min(3, Math.floor(Math.log(value) / Math.log(1024)));
  return new Intl.NumberFormat('es', { maximumFractionDigits: order > 1 ? 1 : 0 }).format(value / 1024 ** order) + ' ' + units[order];
}

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#i-' + name); svg.appendChild(use); return svg;
}

function makeRow(item) {
  const row = document.createElement('article'); row.className = 'download-card'; row.setAttribute('role', 'listitem'); row.dataset.id = item.id;
  const heading = document.createElement('div'); heading.className = 'file-heading';
  const fileIcon = document.createElement('span'); fileIcon.className = 'file-icon'; fileIcon.appendChild(icon('file'));
  const details = document.createElement('div'); details.className = 'file-details';
  const name = document.createElement('div'); name.className = 'file-name';
  const meta = document.createElement('div'); meta.className = 'file-meta';
  details.append(name, meta); heading.append(fileIcon, details);
  const progress = document.createElement('div'); progress.className = 'file-progress';
  progress.setAttribute('role', 'progressbar'); progress.setAttribute('aria-valuemin', '0'); progress.setAttribute('aria-valuemax', '100');
  const fill = document.createElement('span'); progress.appendChild(fill);
  const actions = document.createElement('div'); actions.className = 'file-actions';
  const pause = document.createElement('button'); pause.dataset.action = 'pause';
  const cancel = document.createElement('button'); cancel.dataset.action = 'cancel'; cancel.className = 'cancel-download'; cancel.textContent = 'Cancelar';
  const reveal = document.createElement('button'); reveal.dataset.action = 'reveal'; reveal.textContent = 'Mostrar en carpeta ↗';
  actions.append(pause, cancel, reveal); row.append(heading, progress, actions);
  const parts = { row, fileIcon, name, meta, progress, fill, pause, cancel, reveal, complete: false };
  rows.set(item.id, parts); return parts;
}

function renderDownloads(downloads) {
  const visible = new Set(downloads.map((item) => item.id));
  for (const [id, parts] of rows) if (!visible.has(id)) { parts.row.remove(); rows.delete(id); }
  const list = $('download-list');
  downloads.forEach((item, index) => {
    const parts = rows.get(item.id) || makeRow(item);
    const { row, fileIcon, name, meta, progress, fill, pause, cancel, reveal } = parts;
    if (list.children[index] !== row) list.insertBefore(row, list.children[index] || null);
    row.dataset.state = item.state; name.textContent = item.name; name.title = item.name;
    const completed = item.state === 'completed', active = item.state === 'progressing';
    if (completed !== parts.complete) { fileIcon.replaceChildren(icon(completed ? 'check' : 'file')); parts.complete = completed; }
    const percentage = item.total ? Math.min(100, Math.round(item.received / item.total * 100)) : 0;
    if (completed) meta.textContent = 'Guardado · ' + bytes(item.received);
    else if (item.state === 'cancelled') meta.textContent = 'Descarga cancelada';
    else if (item.state === 'interrupted') meta.textContent = 'Interrumpida · ' + bytes(item.received);
    else if (item.paused) meta.textContent = 'En pausa · ' + bytes(item.received) + (item.total ? ' de ' + bytes(item.total) : '');
    else meta.textContent = bytes(item.received) + (item.total ? ' de ' + bytes(item.total) + ' · ' + percentage + ' %' : '') + (item.speed ? ' · ' + bytes(item.speed) + '/s' : '');
    progress.hidden = !active; progress.classList.toggle('indeterminate', active && !item.total);
    progress.setAttribute('aria-label', 'Descarga de ' + item.name);
    if (item.total) progress.setAttribute('aria-valuenow', String(percentage)); else progress.removeAttribute('aria-valuenow');
    fill.style.width = item.total ? percentage + '%' : '';
    pause.hidden = !active && !(item.state === 'interrupted' && item.resumable);
    pause.dataset.action = item.paused || item.state === 'interrupted' ? 'resume' : 'pause';
    pause.textContent = pause.dataset.action === 'resume' ? 'Continuar' : 'Pausar';
    pause.disabled = pause.dataset.action === 'resume' && !item.resumable;
    pause.setAttribute('aria-label', pause.textContent + ' descarga de ' + item.name);
    cancel.hidden = !active && !(item.state === 'interrupted' && item.resumable);
    cancel.setAttribute('aria-label', 'Cancelar descarga de ' + item.name);
    reveal.hidden = !completed; reveal.setAttribute('aria-label', 'Mostrar ' + item.name + ' en carpeta');
  });
  $('downloads-empty').hidden = downloads.length > 0;
  $('drawer-count').textContent = downloads.length ? String(downloads.length) : '';
  $('clear-history').hidden = !downloads.some((item) => !['progressing'].includes(item.state) && !item.resumable);
}

function render(next) {
  state = next;
  document.body.classList.toggle('downloads-open', state.downloadsOpen);
  $('downloads').hidden = !state.downloadsOpen;
  $('download-toggle').setAttribute('aria-expanded', String(state.downloadsOpen));
  const count = state.downloads.filter((item) => item.state === 'progressing').length;
  $('download-count').hidden = count === 0; $('download-count').textContent = String(count);
  $('download-toggle').setAttribute('aria-label', count ? `Descargas: ${count} en curso` : 'Abrir descargas');
  $('directory-path').textContent = state.directory; $('directory-path').title = state.directory;
  $('save-mode').textContent = state.askSave ? 'Elegir ubicación en cada descarga' : 'Guardado automático';
  $('server-name').textContent = state.host;
  $('server').classList.toggle('insecure', !state.secure);
  $('server').title = (state.secure ? 'Conexión cifrada · ' : 'Conexión sin cifrar · ') + state.host;
  $('zoom-value').textContent = state.zoom + ' %'; $('app-version').textContent = state.version;
  $('status-message').textContent = state.toast || 'Archivos, capturas e ideas. Todo en la conversación.';
  $('status-message').classList.toggle('toast', Boolean(state.toast));
  const notificationLabels = { ready: 'Preguntas y permisos, también con Hub minimizado.', connecting: 'Conectando los avisos del Hub.',
    disconnected: 'Avisos en pausa: Hub está desconectado.', 'signed-out': 'Inicia sesión para recibir avisos.',
    incompatible: 'Actualiza el Hub web para recibir avisos.', 'server-disabled': 'El servidor tiene los avisos desactivados.',
    unsupported: 'El sistema no permite mostrar avisos.', error: 'No se ha podido mostrar un aviso. Revisa los ajustes de Linux.' };
  const notificationTitle = state.notifications ? 'Avisos activados. ' + (notificationLabels[state.notificationStatus] || '') : 'Avisos desactivados. Pulsa para activarlos.';
  $('notification-toggle').setAttribute('aria-pressed', String(state.notifications));
  $('notification-toggle').setAttribute('aria-label', notificationTitle); $('notification-toggle').title = notificationTitle;
  $('notification-toggle').dataset.status = state.notificationStatus;
  const microphoneTitle = state.microphone ? 'Permiso de micrófono activado. Pulsa para desactivarlo y detener la grabación.'
    : 'Permiso de micrófono desactivado. Pulsa para activarlo.';
  $('microphone-toggle').setAttribute('aria-pressed', String(state.microphone));
  $('microphone-toggle').setAttribute('aria-label', microphoneTitle); $('microphone-toggle').title = microphoneTitle;
  $('maximize').setAttribute('aria-label', state.maximized ? 'Restaurar ventana' : 'Maximizar');
  $('maximize').title = state.maximized ? 'Restaurar ventana' : 'Maximizar';
  $('maximize').querySelector('use').setAttribute('href', state.maximized ? '#i-restore' : '#i-maximize');
  $('findbar').hidden = !state.findOpen;
  if (state.findOpen && !findWasOpen) requestAnimationFrame(() => { $('find-input').focus(); $('find-input').select(); });
  findWasOpen = state.findOpen;
  $('find-result').textContent = state.findResult ? (state.findResult.total ? state.findResult.current + ' de ' + state.findResult.total : 'Sin resultados') : '';
  $('landing-title').textContent = state.loadError ? 'Volvamos a conectar.' : 'Tu equipo, siempre a mano.';
  $('landing-description').textContent = state.loadError || 'Estamos abriendo tu espacio de trabajo.';
  $('loading-indicator').hidden = !state.loading;
  $('retry').hidden = !state.loadError;
  renderDownloads(state.downloads);
}

document.addEventListener('click', (event) => {
  const action = event.target.closest('[data-command]');
  if (!action) return;
  const name = action.dataset.command;
  if (name === 'downloads') command('downloads', !state.downloadsOpen);
  else if (name === 'notifications') command('notifications', !state.notifications);
  else if (name === 'microphone') command('microphone', !state.microphone);
  else if (name === 'downloads-close') { command('downloads', false); $('download-toggle').focus(); }
  else if (name === 'find-close') command('find', false);
  else if (name === 'zoom-out') command('zoom', -1);
  else if (name === 'zoom-in') command('zoom', 1);
  else if (name === 'zoom-reset') command('zoom', 0);
  else command(name);
});

$('download-list').addEventListener('click', (event) => {
  const action = event.target.closest('[data-action]'), row = event.target.closest('[data-id]');
  if (action && row) command('download-action', { id: row.dataset.id, action: action.dataset.action });
});

function search(next = false, forward = true) { command('search', { text: $('find-input').value, next, forward }); }
$('find-input').addEventListener('input', () => { clearTimeout(findTimer); findTimer = setTimeout(() => search(), 130); });
$('find-input').addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); search(true, !event.shiftKey); } });
$('find-next').addEventListener('click', () => search(true));
$('find-prev').addEventListener('click', () => search(true, false));
bridge.onState(render); command('ready');
