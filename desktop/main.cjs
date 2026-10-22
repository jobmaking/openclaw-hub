'use strict';

const { app, BrowserWindow, WebContentsView, Menu, dialog, ipcMain, session, shell, screen, Notification } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');
const { hubUrl, externalUrl, sameOrigin, hubDocument, microphonePermission, downloadLink, nextDownloadPath, readJson, writeJson, restoreDownloads, windowBounds } = require('./core.cjs');
const { snapshotScript, openScript, pendingItems, HubNotifications } = require('./notifications.cjs');
const version = require('./package.json').version;

app.setName('Hub');
app.setDesktopName('openclaw-hub.desktop');
app.commandLine.appendSwitch('class', 'Hub');
app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
if (process.env.HUB_USER_DATA_DIR) app.setPath('userData', path.resolve(process.env.HUB_USER_DATA_DIR));
else app.setPath('userData', path.join(app.getPath('appData'), 'openclaw-hub-desktop', 'native'));

let target;
try { target = hubUrl(process.env.HUB_URL || 'http://127.0.0.1:18900/'); }
catch (error) { dialog.showErrorBox('Hub', error.message); app.exit(1); }

if (!app.requestSingleInstanceLock()) { app.quit(); }
else {
  let win, view, settings, records, settingsFile, historyFile, hubSession;
  let shellReady = false, quitting = false, downloadsOpen = process.argv.includes('--downloads');
  let loading = true, loadError = '', findOpen = false, findResult = null, toast = '';
  let flushTimer, toastTimer, windowTimer, progressTimer;
  let notifier, notificationTimer, notificationRead = false, notificationEpoch = 0;
  let microphonePrompt = null, microphoneEpoch = 0;
  const otherNotifications = new Set();
  const items = new Map(), reserved = new Set(), previousBytes = new Map();
  const downloadIntents = new Map(), downloadRequests = new Map();
  const shellFile = path.join(__dirname, 'shell.html');
  const shellUrl = pathToFileURL(shellFile).href;
  const icon = fs.existsSync(path.join(__dirname, 'icon.png')) ? path.join(__dirname, 'icon.png')
    : path.join(__dirname, '../public/icons/hub-v2/icon-512.png');

  function saveSettings() {
    try { writeJson(settingsFile, settings); }
    catch { tell('No se han podido guardar las preferencias.'); }
  }

  function saveHistory() {
    clearTimeout(flushTimer); flushTimer = null;
    // Never persist signed URLs, cookies, credentials or response headers.
    try { writeJson(historyFile, records.slice(0, 100).map(({ id, name, path: filename, state, received, total, startedAt }) =>
      ({ id, name, path: filename, state, received, total, startedAt }))); }
    catch { tell('No se ha podido guardar el historial de descargas.'); }
  }

  function publicState() {
    return {
      version, host: target.host, secure: target.protocol === 'https:', loading, loadError,
      maximized: Boolean(win?.isMaximized()), downloadsOpen, findOpen, findResult, toast,
      minimized: Boolean(win?.isMinimized()), focused: Boolean(win?.isFocused()),
      notifications: Boolean(settings?.notifications), notificationsSupported: Notification.isSupported(),
      notificationStatus: notifier?.status || 'connecting',
      microphone: settings?.microphone === true,
      zoom: Math.round((settings?.zoom || 1) * 100), askSave: Boolean(settings?.askSave),
      directory: settings?.directory || '',
      downloads: (records || []).slice(0, 100).map(({ id, name, state, received, total, paused, resumable, speed }) =>
        ({ id, name, state, received, total, paused, resumable, speed })),
    };
  }

  function publish() {
    if (shellReady && win && !win.isDestroyed()) win.webContents.send('hub:state', publicState());
    if (!win || win.isDestroyed()) return;
    const active = (records || []).filter((entry) => entry.state === 'progressing');
    if (!active.length) win.setProgressBar(-1);
    else {
      const total = active.reduce((sum, entry) => sum + entry.total, 0);
      const received = active.reduce((sum, entry) => sum + entry.received, 0);
      win.setProgressBar(total ? Math.min(.99, received / total) : 2, { mode: active.every((entry) => entry.paused) ? 'paused' : 'normal' });
    }
  }

  function tell(message) {
    toast = message; publish(); clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast = ''; publish(); }, 6000);
  }

  function layout() {
    if (!win || !view || win.isDestroyed()) return;
    const { width, height } = win.getContentBounds();
    const top = 56 + (findOpen ? 42 : 0);
    view.setBounds({ x: 0, y: top, width: Math.max(0, width - (downloadsOpen ? 360 : 0)), height: Math.max(0, height - top - 28) });
  }

  function showDownloads(value = true) { downloadsOpen = value; layout(); publish(); }

  function focusHub() {
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show(); win.focus();
    if (!view.webContents.isDestroyed()) view.webContents.focus();
  }

  function nativeNotice(options, clicked = () => {}) {
    if (!settings.notifications) { tell('Activa las notificaciones desde la campana de Hub.'); return; }
    if (!Notification.isSupported()) { tell('Este escritorio no permite mostrar notificaciones.'); return; }
    const notification = new Notification({ ...options, icon });
    otherNotifications.add(notification);
    notification.on('close', () => otherNotifications.delete(notification));
    notification.on('failed', () => { otherNotifications.delete(notification); tell('Linux no ha podido mostrar el aviso. Revisa las notificaciones de Hub en los ajustes del sistema.'); });
    notification.on('click', () => { focusHub(); clicked(); });
    notification.show();
  }

  async function readNotificationSnapshot() {
    const epoch = notificationEpoch;
    if (quitting || loading || loadError || !view || view.webContents.isDestroyed()
        || !hubDocument(view.webContents.getURL(), target)) return null;
    const result = await view.webContents.executeJavaScript(snapshotScript).catch(() => null);
    return epoch === notificationEpoch && !quitting && !view.webContents.isDestroyed()
      && hubDocument(view.webContents.getURL(), target) ? result : null;
  }

  async function syncNotifications() {
    if (notificationRead || quitting) return;
    const options = { enabled: settings.notifications, supported: Notification.isSupported() };
    if (!options.enabled || !options.supported) { notifier.sync(null, options); return; }
    notificationRead = true;
    const epoch = notificationEpoch;
    try {
      const snapshot = await readNotificationSnapshot();
      if (epoch === notificationEpoch && !quitting) notifier.sync(snapshot, { ...options, enabled: settings.notifications });
    } finally { notificationRead = false; }
  }

  async function openNotification(request) {
    if (!settings.notifications || quitting) return;
    const epoch = notificationEpoch, snapshot = await readNotificationSnapshot();
    if (epoch !== notificationEpoch || !settings.notifications || snapshot?.user !== request.user || snapshot?.status !== 'ready') return;
    const pending = pendingItems(snapshot);
    const targets = request.targets.filter(item => pending.has(item.key));
    if (!targets.length) { tell('Esta solicitud ya no está pendiente.'); return; }
    focusHub();
    const opened = await view.webContents.executeJavaScript(openScript({ user: request.user, targets }), true).catch(() => false);
    if (!opened && epoch === notificationEpoch) tell('No se ha podido abrir esa solicitud. Revisa los pendientes del Hub.');
  }

  function setNotifications(enabled) {
    settings.notifications = Boolean(enabled); notificationEpoch++; saveSettings();
    if (settings.notifications) notifier.retryNow();
    if (!settings.notifications) {
      notifier.suspend('disabled');
      for (const notification of otherNotifications) notification.close();
      otherNotifications.clear();
    }
    syncNotifications(); publish();
    tell(settings.notifications ? 'Avisos activados mientras Hub siga abierto, también minimizado.' : 'Avisos del escritorio desactivados.');
  }

  function testNotification() {
    nativeNotice({ title: 'Aviso de prueba · Hub', body: 'Las notificaciones del escritorio funcionan. Puedes dejar Hub minimizado.' });
  }

  async function openExternal(value) {
    const url = externalUrl(value);
    if (!url) { tell('Este tipo de enlace no se abre desde Hub.'); return; }
    try { await shell.openExternal(url); } catch { tell('No se ha podido abrir el navegador.'); }
  }

  function downloadFile(value) {
    const url = downloadLink(value, target);
    if (!url) { tell('Este enlace no es un archivo descargable del Hub.'); return; }
    // Use one authenticated GET, not a preflight that could consume a signed link.
    const intent = { reported: false };
    const queue = downloadIntents.get(url) || [];
    queue.push(intent); downloadIntents.set(url, queue);
    intent.timer = setTimeout(() => {
      const waiting = downloadIntents.get(url);
      if (!waiting?.includes(intent)) return;
      waiting.splice(waiting.indexOf(intent), 1);
      if (!waiting.length) downloadIntents.delete(url);
      tell('No se ha podido iniciar la descarga. Vuelve a intentarlo desde el chat.');
    }, 30000);
    intent.timer.unref();
    try { view.webContents.downloadURL(url); }
    catch {
      clearTimeout(intent.timer); queue.splice(queue.indexOf(intent), 1);
      if (!queue.length) downloadIntents.delete(url);
      tell('No se ha podido iniciar la descarga. El chat sigue disponible.');
    }
  }

  function followLink(url) {
    if (downloadLink(url, target)) downloadFile(url);
    else if (sameOrigin(url, target.origin) && new URL(url).pathname.startsWith('/api/')) tell('Este enlace no se abre como una página. El chat sigue disponible.');
    else openExternal(url);
  }

  function setZoom(value) {
    settings.zoom = Math.max(.8, Math.min(1.6, Math.round(value * 10) / 10));
    view.webContents.setZoomFactor(settings.zoom); saveSettings(); publish();
  }

  function setWindowSize(preset) {
    if (!['compact', 'wide'].includes(preset)) return;
    const area = screen.getDisplayMatching(win.getBounds()).workArea;
    if (win.isMaximized()) win.unmaximize();
    win.setSize(Math.max(860, Math.min(area.width, preset === 'compact' ? 1000 : 1360)),
      Math.max(580, Math.min(area.height, preset === 'compact' ? 740 : 900)));
  }

  async function attach() {
    if (loading || loadError || !sameOrigin(view.webContents.getURL(), target.origin)) return;
    const result = await view.webContents.executeJavaScript(`(() => {
      const app = document.getElementById('app');
      const button = document.getElementById('btn-attach');
      if (!app || app.classList.contains('hidden')) return 'login';
      if (!button || button.disabled) return 'session';
      button.click(); return 'ok';
    })()`, true).catch(() => 'error');
    if (result === 'login') tell('Inicia sesión para adjuntar archivos.');
    else if (result === 'session') tell('Abre una conversación para adjuntar archivos.');
    else if (result !== 'ok') tell('No se ha podido abrir el selector de archivos.');
    view.webContents.focus();
  }

  function setFind(value) {
    findOpen = value;
    if (!value) { view.webContents.stopFindInPage('clearSelection'); findResult = null; view.webContents.focus(); }
    layout(); publish();
    if (value) win.webContents.focus();
  }

  function findText(value) {
    if (!findOpen || typeof value?.text !== 'string' || value.text.length > 1000) return;
    if (!value.text) { view.webContents.stopFindInPage('clearSelection'); findResult = null; publish(); return; }
    // Electron's findNext=true starts a new search; false continues it.
    view.webContents.findInPage(value.text, { forward: value.forward !== false, findNext: !value.next });
  }

  async function chooseDirectory() {
    const result = await dialog.showOpenDialog(win, { title: 'Carpeta de descargas de Hub', defaultPath: settings.directory,
      buttonLabel: 'Usar esta carpeta', properties: ['openDirectory', 'createDirectory'] });
    if (result.canceled || !result.filePaths[0]) return;
    try {
      fs.accessSync(result.filePaths[0], fs.constants.W_OK);
      settings.directory = result.filePaths[0]; saveSettings(); publish();
    } catch { tell('No tienes permiso para guardar archivos en esa carpeta.'); }
  }

  async function openDirectory() {
    try {
      fs.mkdirSync(settings.directory, { recursive: true });
      const error = await shell.openPath(settings.directory);
      if (error) tell('No se ha podido abrir la carpeta.');
    } catch { tell('No se ha podido abrir la carpeta.'); }
  }

  function nativeMenu() {
    Menu.buildFromTemplate([
      { label: 'Adjuntar archivos…', accelerator: 'CommandOrControl+O', click: attach },
      { label: 'Descargas', accelerator: 'CommandOrControl+J', click: () => showDownloads() },
      { label: 'Buscar en la conversación', accelerator: 'CommandOrControl+F', click: () => setFind(true) },
      { type: 'separator' },
      { label: 'Tamaño del texto', submenu: [
        { label: 'Aumentar', accelerator: 'CommandOrControl+Plus', click: () => setZoom(settings.zoom + .1) },
        { label: 'Reducir', accelerator: 'CommandOrControl+-', click: () => setZoom(settings.zoom - .1) },
        { label: 'Restablecer', accelerator: 'CommandOrControl+0', click: () => setZoom(1) },
      ] },
      { label: 'Tamaño de ventana', submenu: [
        { label: 'Compacta', click: () => setWindowSize('compact') },
        { label: 'Amplia', click: () => setWindowSize('wide') },
      ] },
      { label: 'Recargar Hub', accelerator: 'CommandOrControl+R', click: loadHub },
      { label: 'Abrir Hub en el navegador', click: () => openExternal(target.href) },
      { type: 'separator' },
      { label: 'Notificaciones de preguntas y permisos', type: 'checkbox', checked: settings.notifications,
        click: (item) => setNotifications(item.checked) },
      { label: 'Probar notificación', enabled: settings.notifications && Notification.isSupported(), click: testNotification },
      { label: 'Permitir micrófono para notas de voz', type: 'checkbox', checked: settings.microphone === true,
        click: item => setMicrophone(item.checked) },
      { type: 'separator' },
      { label: 'Preguntar dónde guardar cada archivo', type: 'checkbox', checked: settings.askSave,
        click: (item) => { settings.askSave = item.checked; saveSettings(); publish(); } },
      { label: 'Cambiar carpeta de descargas…', click: chooseDirectory },
      { type: 'separator' },
      { label: 'Atajos de teclado', click: () => dialog.showMessageBox(win, { type: 'info', title: 'Atajos de Hub',
        message: 'Todo a mano', detail: 'Ctrl + O   Adjuntar archivos\nCtrl + J   Ver descargas\nCtrl + F   Buscar en la conversación\nCtrl + + / −   Tamaño del texto\nCtrl + 0   Restablecer tamaño\nCtrl + R   Recargar\nCtrl + Q   Salir\n\nTambién puedes arrastrar archivos al chat o pegar una captura con Ctrl + V.' }) },
      { label: `Acerca de Hub ${version}`, click: () => dialog.showMessageBox(win, { type: 'info', title: 'Hub',
        message: 'Tu equipo de agentes. Un solo espacio.', detail: `Hub para Linux · ${version}\nDescargas y adjuntos integrados en tu escritorio.\n\nLas notificaciones de la app requieren que siga abierta. La alternativa Chrome/PWA conserva Web Push.` }) },
      { type: 'separator' },
      { label: 'Salir', accelerator: 'CommandOrControl+Q', click: () => win.close() },
    ]).popup({ window: win });
  }

  function keyHandler(event, input) {
    if (input.type !== 'keyDown') return;
    const control = input.control || input.meta;
    const key = input.key.toLowerCase();
    if (key === 'escape' && findOpen) { event.preventDefault(); setFind(false); return; }
    if (!control || input.alt) return;
    const commands = { o: attach, j: () => showDownloads(!downloadsOpen), f: () => setFind(true),
      r: loadHub, q: () => win.close(), w: () => win.close(), '0': () => setZoom(1), '+': () => setZoom(settings.zoom + .1),
      '=': () => setZoom(settings.zoom + .1), '-': () => setZoom(settings.zoom - .1) };
    if (commands[key]) { event.preventDefault(); commands[key](); }
  }

  function loadHub() {
    loading = true; loadError = ''; view.setVisible(false); publish();
    view.webContents.loadURL(target.href).catch(() => {
      if (!loadError) { loading = false; loadError = 'No se ha podido conectar con Hub. Comprueba la conexión y vuelve a intentarlo.'; publish(); }
    });
  }

  function bindDownloads() {
    // A failed file request must never render JSON in place of the conversation,
    // nor be saved as a successful EXE/JSON download. Scope these hooks to native
    // download intents; regular API calls and inline images retain their behavior.
    const filter = { urls: ['http://*/*', 'https://*/*'] };
    const report = (intent, message) => {
      if (!intent.reported) { intent.reported = true; tell(message); }
    };
    const reject = (details, intent, callback, message) => {
      callback({ cancel: true }); report(intent, message);
    };
    hubSession.webRequest.onBeforeRequest(filter, (details, callback) => {
      let intent = downloadRequests.get(details.id);
      if (!intent && details.webContentsId === view.webContents.id && details.method === 'GET') {
        const queue = downloadIntents.get(details.url);
        if (queue?.length) {
          intent = queue.shift(); clearTimeout(intent.timer);
          if (!queue.length) downloadIntents.delete(details.url);
          downloadRequests.set(details.id, intent);
        } else if (details.resourceType === 'other' && downloadLink(details.url, target)) {
          // Native <a download> requests do not emit will-navigate/windowOpen.
          intent = { reported: false }; downloadRequests.set(details.id, intent);
        }
      }
      if (intent && !downloadLink(details.url, target)) {
        reject(details, intent, callback, 'La descarga ha redirigido fuera del archivo del Hub. Vuelve a abrir el enlace desde el chat.'); return;
      }
      callback({});
    });
    hubSession.webRequest.onHeadersReceived(filter, (details, callback) => {
      const intent = downloadRequests.get(details.id);
      if (intent) {
        const status = details.statusCode;
        if (status < 200 || status >= 400) {
          const reason = { 401: 'La sesión ha caducado; vuelve a iniciar sesión.', 403: 'El archivo no está publicado o no tienes acceso.',
            404: 'El archivo ya no está disponible.', 429: 'Hay demasiados intentos; espera un momento.' }[status] || 'Vuelve a intentarlo desde el chat.';
          reject(details, intent, callback, `No se ha podido descargar (${status}). ${reason}`); return;
        }
        if (status >= 200 && status < 300) {
          const header = (name) => Object.entries(details.responseHeaders || {}).find(([key]) => key.toLowerCase() === name)?.[1]?.[0] || '';
          if (!new URL(details.url).pathname.startsWith('/api/') && /text\/html/i.test(header('content-type'))
            && !/attachment|filename\*?\s*=/i.test(header('content-disposition')) && !/\.html?$/i.test(new URL(details.url).pathname)) {
            reject(details, intent, callback, 'Este enlace es una página web; se abrirá en el navegador.'); openExternal(details.url); return;
          }
        }
        const location = Object.entries(details.responseHeaders || {}).find(([key]) => key.toLowerCase() === 'location')?.[1]?.[0];
        if (status >= 300 && status < 400 && location) {
          let redirect;
          try { redirect = downloadLink(new URL(location, details.url).href, target); } catch {}
          if (!redirect) { reject(details, intent, callback, 'El enlace de descarga ha caducado o redirige a otra página. El chat sigue disponible.'); return; }
        }
      }
      callback({ responseHeaders: details.responseHeaders });
    });
    hubSession.webRequest.onCompleted(filter, (details) => downloadRequests.delete(details.id));
    hubSession.webRequest.onErrorOccurred(filter, (details) => {
      const intent = downloadRequests.get(details.id); downloadRequests.delete(details.id);
      if (intent && details.error !== 'net::ERR_ABORTED') report(intent, 'La descarga no se ha podido completar. Comprueba la conexión y vuelve a intentarlo desde el chat.');
    });
    hubSession.on('will-download', (event, item, contents) => {
      if (!contents || contents.id !== view.webContents.id) { event.preventDefault(); return; }
      // Chromium can emit will-download even after the response was rejected.
      if (item.getState() === 'interrupted' || item.getState() === 'cancelled') { event.preventDefault(); return; }
      let destination;
      try {
        fs.mkdirSync(settings.directory, { recursive: true });
        destination = nextDownloadPath(settings.directory, item.getFilename(), reserved);
        if (settings.askSave) {
          destination = dialog.showSaveDialogSync(win, { title: 'Guardar archivo de Hub', defaultPath: destination,
            buttonLabel: 'Guardar', properties: ['showOverwriteConfirmation', 'createDirectory'] });
          if (!destination) { event.preventDefault(); return; }
          if (reserved.has(destination)) { event.preventDefault(); tell('Ya hay una descarga guardándose con ese nombre.'); return; }
        }
        fs.accessSync(path.dirname(destination), fs.constants.W_OK);
        item.setSavePath(destination);
      } catch {
        event.preventDefault(); tell('No se puede guardar el archivo. Elige otra carpeta en el menú.'); return;
      }
      const entry = { id: randomUUID(), name: path.basename(destination), path: destination,
        startedAt: Date.now(), state: 'progressing', received: 0, total: item.getTotalBytes(), paused: false, resumable: false, speed: 0 };
      records.unshift(entry); items.set(entry.id, item); reserved.add(destination);
      saveHistory(); showDownloads();
      item.on('updated', (_event, state) => {
        entry.state = state; entry.received = item.getReceivedBytes(); entry.total = item.getTotalBytes();
        entry.paused = item.isPaused(); entry.resumable = item.canResume();
        const previous = previousBytes.get(entry.id) || { bytes: 0, time: entry.startedAt };
        const now = Date.now();
        if (now - previous.time >= 400) {
          entry.speed = entry.paused ? 0 : Math.max(0, (entry.received - previous.bytes) * 1000 / (now - previous.time));
          previousBytes.set(entry.id, { bytes: entry.received, time: now });
        }
        clearTimeout(progressTimer); progressTimer = setTimeout(publish, 100);
        if (!flushTimer) flushTimer = setTimeout(() => { flushTimer = null; saveHistory(); }, 1500);
      });
      item.once('done', (_event, state) => {
        entry.state = state; entry.received = item.getReceivedBytes(); entry.total = item.getTotalBytes();
        entry.paused = false; entry.resumable = false; entry.speed = 0;
        items.delete(entry.id); reserved.delete(destination); previousBytes.delete(entry.id);
        // A header rejection can create a transient empty item. Remove only its
        // interrupted record; never cancel a valid retry or delete a saved file.
        if (state === 'interrupted' && !entry.received && !entry.total) records = records.filter((record) => record.id !== entry.id);
        saveHistory(); publish();
        if (state === 'completed' && settings.notifications && Notification.isSupported() && (!win.isFocused() || win.isMinimized())) {
          nativeNotice({ title: 'Descarga completada · Hub', body: entry.name }, () => showDownloads());
        }
      });
    });
  }

  function bindPermissions() {
    const allowed = (contents, permission, origin, details = {}) => Boolean(contents && view
      && contents.id === view.webContents.id && sameOrigin(origin, target.origin)
      && details.isMainFrame !== false && ['clipboard-sanitized-write', 'fullscreen'].includes(permission));
    const hubFrame = (contents, origin, details = {}) => Boolean(contents && view && !contents.isDestroyed()
      && contents.id === view.webContents.id && hubDocument(contents.getURL(), target)
      && sameOrigin(origin, target.origin) && details.isMainFrame === true
      && (!details.requestingUrl || hubDocument(details.requestingUrl, target)));
    hubSession.setPermissionCheckHandler((contents, permission, origin, details) => {
      if (permission === 'media') return hubFrame(contents, origin, details) && microphonePermission(permission, details)
        && settings.microphoneOrigin === target.origin && settings.microphone === true;
      return permission === 'notifications' ? Boolean(settings.notifications && contents?.id === view?.webContents.id && sameOrigin(origin, target.origin) && details.isMainFrame !== false)
        : allowed(contents, permission, origin, details);
    });
    hubSession.setPermissionRequestHandler(async (contents, permission, callback, details) => {
      if (permission === 'media') {
        const origin = details.requestingUrl || contents?.getURL();
        if (!hubFrame(contents, origin, details) || !microphonePermission(permission, details, true)) { callback(false); return; }
        const granted = typeof settings.microphone === 'boolean' ? settings.microphone : await requestMicrophoneConsent();
        callback(Boolean(granted && settings.microphone === true && hubFrame(contents, origin, details))); return;
      }
      if (permission !== 'notifications') { callback(allowed(contents, permission, details.requestingUrl || contents.getURL(), details)); return; }
      if (!contents || contents.id !== view.webContents.id || !sameOrigin(details.requestingUrl || contents.getURL(), target.origin) || details.isMainFrame === false) { callback(false); return; }
      if (typeof settings.notifications === 'boolean') { callback(settings.notifications); return; }
      const result = await dialog.showMessageBox(win, { type: 'question', title: 'Avisos de Hub', message: '¿Permitir avisos de Hub en el escritorio?',
        detail: 'Podrás recibir avisos mientras la app siga abierta, también si está minimizada.', buttons: ['Permitir', 'Ahora no'], defaultId: 0, cancelId: 1 });
      settings.notifications = result.response === 0; saveSettings(); callback(settings.notifications);
    });
  }

  async function requestMicrophoneConsent() {
    if (microphonePrompt) return microphonePrompt;
    const epoch = microphoneEpoch;
    microphonePrompt = (async () => {
      try {
        const result = await dialog.showMessageBox(win, { type: 'question', title: 'Micrófono de Hub',
          message: '¿Permitir el micrófono para las notas de voz?',
          detail: `${target.origin}\n\nSolo se usa al pulsar Grabar en este Hub. No da acceso a la cámara ni a la pantalla. Puedes retirar el permiso desde el botón de micrófono de la barra superior o desde el menú.`,
          buttons: ['Permitir micrófono', 'Ahora no'], defaultId: 1, cancelId: 1, noLink: true });
        if (epoch !== microphoneEpoch || win.isDestroyed()) return false;
        settings.microphone = result.response === 0; settings.microphoneOrigin = target.origin; saveSettings(); publish();
        return settings.microphone;
      } catch { return false; }
      finally { microphonePrompt = null; }
    })();
    return microphonePrompt;
  }

  async function setMicrophone(enabled) {
    microphoneEpoch++;
    if (enabled) {
      settings.microphone = null;
      const allowed = await requestMicrophoneConsent();
      tell(allowed ? 'Micrófono permitido solo al grabar notas de voz en este Hub.' : 'Micrófono desactivado. Puedes activarlo desde la barra superior o el menú.');
    } else {
      settings.microphone = false; settings.microphoneOrigin = target.origin; saveSettings(); publish();
      // Stop an in-flight capture before its view can request another one; its
      // local note is retained by the web draft store, not discarded on revoke.
      if (view && !view.webContents.isDestroyed() && hubDocument(view.webContents.getURL(), target)) {
        await view.webContents.executeJavaScript('window.HubVoice?.revokeMicrophone?.()', true).catch(() => {});
      }
      tell('Micrófono desactivado. Tu nota y el texto del borrador se conservan.');
    }
  }

  async function downloadAction(value) {
    if (!value || typeof value.id !== 'string') return;
    const entry = records.find((record) => record.id === value.id);
    if (!entry) return;
    const item = items.get(entry.id);
    try {
      if (value.action === 'pause' && item && entry.state === 'progressing') { item.pause(); entry.paused = true; entry.resumable = item.canResume(); publish(); }
      if (value.action === 'resume' && item && item.canResume()) { item.resume(); entry.paused = false; publish(); }
      if (value.action === 'cancel' && item) item.cancel();
      if (value.action === 'reveal' && entry.state === 'completed') {
        if (fs.existsSync(entry.path)) shell.showItemInFolder(entry.path);
        else tell('El archivo se ha movido o eliminado.');
      }
    } catch { tell('No se ha podido completar esa acción.'); }
  }

  app.on('second-instance', (_event, argv) => {
    if (!win) return;
    if (win.isMinimized()) win.restore(); win.show(); win.focus();
    if (argv.includes('--downloads')) showDownloads();
  });

  app.whenReady().then(() => {
    const data = app.getPath('userData'); fs.mkdirSync(data, { recursive: true, mode: 0o700 });
    settingsFile = path.join(data, 'settings.json'); historyFile = path.join(data, 'downloads.json');
    const rawSettings = readJson(settingsFile, {});
    const saved = rawSettings && typeof rawSettings === 'object' && !Array.isArray(rawSettings) ? rawSettings : {};
    settings = {
      directory: typeof saved.directory === 'string' && path.isAbsolute(saved.directory) ? saved.directory : path.join(app.getPath('downloads'), 'Hub'),
      askSave: Boolean(saved.askSave), zoom: Number.isFinite(saved.zoom) ? Math.max(.8, Math.min(1.6, saved.zoom)) : 1,
      window: saved.window, maximized: Boolean(saved.maximized),
      notifications: saved.notifications !== false,
      microphone: saved.microphoneOrigin === target.origin && typeof saved.microphone === 'boolean' ? saved.microphone : null,
      microphoneOrigin: target.origin,
    };
    records = restoreDownloads(readJson(historyFile, []));
    Menu.setApplicationMenu(null);
    win = new BrowserWindow({ ...windowBounds(settings.window, screen.getAllDisplays()), minWidth: 860, minHeight: 580,
      title: 'Hub', icon, backgroundColor: '#121419', frame: false, show: false, autoHideMenuBar: true,
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, devTools: false },
    });
    hubSession = session.fromPartition('persist:hub');
    view = new WebContentsView({ webPreferences: { session: hubSession, sandbox: true, contextIsolation: true,
      nodeIntegration: false, webSecurity: true, allowRunningInsecureContent: false, webviewTag: false, navigateOnDragDrop: false, devTools: false,
      backgroundThrottling: false } });
    view.setBackgroundColor('#121419'); view.setVisible(false); win.contentView.addChildView(view);
    view.webContents.setZoomFactor(settings.zoom);
    notifier = new HubNotifications({ create: options => new Notification({ ...options, icon }), open: openNotification,
      status: () => publish(), failed: () => tell('Linux no ha podido mostrar el aviso. Usa «Probar notificación» y revisa los ajustes de notificaciones del sistema.') });
    notificationTimer = setInterval(syncNotifications, 1000); notificationTimer.unref();
    view.webContents.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) { notificationEpoch++; notifier.suspend(); }
    });
    bindPermissions(); bindDownloads();
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event) => event.preventDefault());
    win.webContents.on('will-redirect', (event) => event.preventDefault());
    win.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    win.webContents.session.setPermissionCheckHandler(() => false);
    view.webContents.setWindowOpenHandler(({ url }) => { followLink(url); return { action: 'deny' }; });
    view.webContents.on('will-navigate', (event, url) => {
      if (!hubDocument(url, target)) { event.preventDefault(); followLink(url); }
    });
    view.webContents.on('will-redirect', (event, url) => {
      if (!hubDocument(url, target)) {
        event.preventDefault(); tell('Se ha bloqueado una redirección fuera del chat. Puedes volver al HUB desde su icono.');
        if (loading) { loading = false; loadError = 'Hub ha redirigido a otra página. Vuelve a intentarlo o ábrelo en el navegador.'; publish(); }
      }
    });
    view.webContents.on('will-attach-webview', (event) => event.preventDefault());
    view.webContents.on('did-finish-load', () => {
      if (!hubDocument(view.webContents.getURL(), target)) {
        loading = false; loadError = 'Esta página no es el chat. Pulsa «Volver a intentar» para recuperar Hub.'; view.setVisible(false); publish(); return;
      }
      loading = false; loadError = ''; view.setVisible(true); publish(); view.webContents.focus();
      // Chrome Web Push is unavailable here. Its controls must not claim that
      // notifications work with Electron closed; use the native shell instead.
      view.webContents.insertCSS('#btn-push-settings,.push-prompt{display:none!important}').catch(() => {});
      syncNotifications();
    });
    view.webContents.on('did-fail-load', (_event, code, _description, _url, mainFrame) => {
      if (!mainFrame || code === -3) return;
      loading = false; loadError = 'No se ha podido conectar con Hub. Comprueba la conexión y vuelve a intentarlo.';
      view.setVisible(false); publish();
    });
    view.webContents.on('render-process-gone', () => { notificationEpoch++; notifier.suspend(); loading = false; loadError = 'La vista de Hub se ha cerrado. Pulsa «Volver a intentar» para recuperarla.'; view.setVisible(false); publish(); });
    view.webContents.on('found-in-page', (_event, result) => { findResult = { current: result.activeMatchOrdinal, total: result.matches }; publish(); });
    view.webContents.on('context-menu', (_event, params) => {
      const template = [];
      if (params.selectionText) template.push({ label: 'Copiar', click: () => view.webContents.copy() });
      if (params.isEditable) template.push({ label: 'Cortar', click: () => view.webContents.cut() },
        { label: 'Pegar', click: () => view.webContents.paste() }, { label: 'Seleccionar todo', click: () => view.webContents.selectAll() });
      if (params.linkURL && externalUrl(params.linkURL)) template.push({ label: 'Abrir enlace en el navegador', click: () => openExternal(params.linkURL) });
      if (downloadLink(params.linkURL, target)) template.push({ label: 'Descargar archivo', click: () => downloadFile(params.linkURL) });
      if (params.mediaType === 'image' && sameOrigin(params.srcURL, target.origin)) {
        template.push({ label: 'Guardar imagen', click: () => downloadFile(params.srcURL) });
        template.push({ label: 'Copiar imagen', click: () => view.webContents.copyImageAt(params.x, params.y) });
      }
      if (template.length) Menu.buildFromTemplate(template).popup({ window: win });
    });
    view.webContents.on('before-input-event', keyHandler); win.webContents.on('before-input-event', keyHandler);
    win.on('resize', () => { layout(); publish(); rememberWindow(); });
    win.on('move', rememberWindow); win.on('maximize', () => { publish(); rememberWindow(); });
    win.on('unmaximize', () => { publish(); rememberWindow(); });
    for (const event of ['minimize', 'restore', 'focus', 'blur']) win.on(event, publish);
    function rememberWindow() {
      clearTimeout(windowTimer); windowTimer = setTimeout(() => {
        if (win.isDestroyed() || win.isMinimized()) return;
        settings.window = win.getNormalBounds(); settings.maximized = win.isMaximized(); saveSettings();
      }, 500);
    }
    win.on('close', (event) => {
      if (quitting) return;
      if (items.size) {
        const answer = dialog.showMessageBoxSync(win, { type: 'question', title: 'Descargas en curso',
          message: 'Hay descargas en curso.', detail: 'Si cierras Hub ahora, se interrumpirán.',
          buttons: ['Seguir descargando', 'Cerrar Hub'], defaultId: 0, cancelId: 0 });
        if (answer === 0) { event.preventDefault(); return; }
      }
      quitting = true; clearTimeout(windowTimer); clearInterval(notificationTimer); notificationEpoch++; notifier.suspend('closed');
      for (const notification of otherNotifications) notification.close();
      otherNotifications.clear();
      settings.window = win.getNormalBounds(); settings.maximized = win.isMaximized(); saveSettings(); saveHistory();
      if (!view.webContents.isDestroyed()) view.webContents.close();
    });
    win.on('closed', () => app.quit());
    win.webContents.on('did-finish-load', () => { shellReady = true; publish(); });
    win.once('ready-to-show', () => { if (settings.maximized) win.maximize(); win.show(); layout(); });
    ipcMain.handle('hub:command', async (event, name, value) => {
      if (event.sender.id !== win.webContents.id || event.senderFrame?.url !== shellUrl) throw new Error('Forbidden');
      try {
        switch (name) {
          case 'ready': publish(); break;
          case 'minimize': win.minimize(); break;
          case 'maximize': win.isMaximized() ? win.unmaximize() : win.maximize(); break;
          case 'close': win.close(); break;
          case 'downloads': showDownloads(value !== false); break;
          case 'folder': await openDirectory(); break;
          case 'choose-folder': await chooseDirectory(); break;
          case 'attach': await attach(); break;
          case 'menu': nativeMenu(); break;
          case 'notifications': setNotifications(value); break;
          case 'microphone': await setMicrophone(value === true); break;
          case 'notifications-test': testNotification(); break;
          case 'reload': loadHub(); break;
          case 'zoom': if ([-1, 0, 1].includes(value)) setZoom(value === 0 ? 1 : settings.zoom + value * .1); break;
          case 'window-size': setWindowSize(value); break;
          case 'find': setFind(value !== false); break;
          case 'search': findText(value); break;
          case 'download-action': await downloadAction(value); break;
          case 'clear-downloads': records = records.filter((entry) => items.has(entry.id)); saveHistory(); publish(); break;
          default: throw new Error('Unknown command');
        }
        return { ok: true };
      } catch { tell('No se ha podido completar esa acción.'); return { ok: false }; }
    });
    layout(); win.loadFile(shellFile); loadHub();
  }).catch((error) => { dialog.showErrorBox('Hub', 'No se ha podido iniciar la aplicación.\n' + error.message); app.exit(1); });
}
