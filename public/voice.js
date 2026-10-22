/* Voice notes are drafts, never automatic chat sends. Audio stays on this Hub. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const scopeOf = context => JSON.stringify([context?.user, context?.agent, context?.key]);
  const validContext = context => !!(context?.user && context?.agent && context?.key);
  const clock = seconds => Math.floor(Math.max(0, seconds || 0) / 60) + ':' + String(Math.floor(Math.max(0, seconds || 0) % 60)).padStart(2, '0');
  const icon = (name) => {
    const paths = { mic: '<rect x="8" y="2" width="8" height="13" rx="4"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8"/>',
      speaker: '<path d="m11 5-6 4H2v6h3l6 4V5zm4 3a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/>', stop: '<rect x="5" y="5" width="14" height="14" rx="2"/>' };
    return '<svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true">' + paths[name] + '</svg>';
  };
  let api, current = null, enabled = false, status = null, statusRequest, selection = 0;
  let recording = null, opening = null, capture = null, captureUrl = null, captureUrlBlob = null, activeAudio = null;
  let locked = false, composerSignature = '', dbPromise = null, disposed = false;
  let hiddenStop = Promise.resolve(), pageEpoch = 0;
  const captures = new Map(), pendingVoice = new Map(), speechCache = new Map(), metadata = new WeakMap(), speechRequests = new Map();

  function database() {
    if (!dbPromise) dbPromise = new Promise((resolve, reject) => {
      if (!window.indexedDB) { reject(new Error('No hay almacenamiento de audio')); return; }
      const request = indexedDB.open('hub-voice-drafts', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('clips');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return dbPromise;
  }
  async function storedClip(scope, value, write = false) {
    try {
      const db = await database();
      return await new Promise((resolve, reject) => {
        const transaction = db.transaction('clips', write ? 'readwrite' : 'readonly');
        const store = transaction.objectStore('clips');
        const request = write ? (value ? store.put(value, scope) : store.delete(scope)) : store.get(scope);
        transaction.oncomplete = () => resolve(request.result || null);
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
    } catch { return null; } // In-memory recovery still works in private/storage-limited browsers.
  }
  function rememberClip(owner, clip) {
    const scope = scopeOf(owner);
    if (clip) captures.set(scope, clip); else captures.delete(scope);
    while (captures.size > 6) captures.delete(captures.keys().next().value);
    return storedClip(scope, clip, true);
  }
  function sameUser(owner) { return api?.context().user === owner?.user; }
  function isCurrent(owner) { return !disposed && scopeOf(current) === scopeOf(owner) && sameUser(owner); }
  function audioUrl(value) {
    try {
      const url = new URL(value, location.href);
      return url.origin === location.origin && url.pathname.startsWith('/api/voice/') && !url.username && !url.password ? url.href : null;
    } catch { return null; }
  }
  function pauseAudio() {
    if (activeAudio) { activeAudio.pause(); activeAudio = null; }
    document.querySelectorAll('.hub-voice-audio').forEach(audio => audio.pause());
  }
  function releasePreview() {
    if (captureUrl) URL.revokeObjectURL(captureUrl);
    captureUrl = null; captureUrlBlob = null;
  }
  function previewUrl(clip) {
    if (!clip?.blob) return null;
    if (captureUrlBlob !== clip.blob) { releasePreview(); captureUrl = URL.createObjectURL(clip.blob); captureUrlBlob = clip.blob; }
    return captureUrl;
  }
  function player(url, label) {
    const wrap = document.createElement('div'); wrap.className = 'voice-player';
    const audio = document.createElement('audio'); audio.className = 'hub-voice-audio'; audio.controls = true; audio.preload = 'metadata'; audio.src = url;
    audio.setAttribute('aria-label', label);
    audio.addEventListener('play', () => {
      if (recording || opening) { audio.pause(); return; }
      if (activeAudio && activeAudio !== audio) activeAudio.pause();
      document.querySelectorAll('.hub-voice-audio').forEach(other => { if (other !== audio) other.pause(); });
      activeAudio = audio;
    });
    audio.addEventListener('ended', () => { if (activeAudio === audio) activeAudio = null; });
    const speedLabel = document.createElement('label'); speedLabel.className = 'voice-speed';
    const speedText = document.createElement('span'); speedText.className = 'sr-only'; speedText.textContent = 'Velocidad de reproducción';
    const speed = document.createElement('select'); speed.setAttribute('aria-label', 'Velocidad de reproducción');
    for (const rate of [1, 1.25, 1.5, 2]) { const option = document.createElement('option'); option.value = String(rate); option.textContent = rate + '×'; speed.appendChild(option); }
    speed.addEventListener('change', () => { audio.playbackRate = Number(speed.value); });
    const error = document.createElement('span'); error.className = 'voice-error hidden'; error.setAttribute('role', 'status');
    audio.addEventListener('error', () => { error.textContent = 'No se pudo cargar el audio. Vuelve a intentarlo con conexión.'; error.classList.remove('hidden'); });
    speedLabel.append(speedText, speed); wrap.append(audio, speedLabel, error);
    return { el: wrap, audio };
  }
  function preference(user = current?.user) {
    try { return localStorage.getItem('hub.voice-replies.user.' + encodeURIComponent(user)) !== 'false'; } catch { return true; }
  }
  function setPreference(value) {
    if (!current?.user) return;
    try { localStorage.setItem('hub.voice-replies.user.' + encodeURIComponent(current.user), String(value)); } catch {}
    if (!value) { pendingVoice.clear(); pauseAudio(); }
  }
  function notice(text, error = false) {
    if (!$('voice-notice')) return;
    $('voice-notice').textContent = text || '';
    $('voice-notice').classList.toggle('hidden', !text);
    $('voice-notice').classList.toggle('voice-error', !!error);
  }
  function changed() { renderDraft(); api?.updateComposer(); }
  function draftNote(owner = current) { return validContext(owner) && sameUser(owner) ? api.readDraft(owner).voiceNote : null; }
  function busy() { return !!(isCurrent(recording?.owner) || isCurrent(opening?.owner) || capture?.transcribing || (capture?.blob && !draftNote())); }
  function renderDraft() {
    if (!api || !$('btn-voice')) return;
    const button = $('btn-voice'), panel = $('voice-draft'), preferenceRow = $('voice-preferences');
    const note = draftNote();
    button.classList.toggle('hidden', !enabled || !validContext(current));
    preferenceRow.classList.toggle('hidden', !enabled || !validContext(current) || !note);
    $('voice-replies').checked = preference();
    const active = isCurrent(recording?.owner) ? recording : null, getting = isCurrent(opening?.owner);
    button.innerHTML = icon(active ? 'stop' : 'mic');
    button.setAttribute('aria-label', active ? 'Detener grabación' : 'Grabar nota de voz');
    button.title = active ? 'Detener grabación' : 'Grabar nota de voz';
    button.classList.toggle('recording', !!active); button.setAttribute('aria-pressed', String(!!active));
    button.disabled = !active && (locked || !!getting || !!capture || !!note || !navigator.mediaDevices?.getUserMedia || !window.MediaRecorder);
    const signature = JSON.stringify([scopeOf(current), !!active, !!getting, capture?.createdAt, !!capture?.transcribing, note?.id, locked]);
    if (composerSignature === signature) return;
    composerSignature = signature;
    panel.replaceChildren();
    panel.classList.toggle('hidden', !enabled || !(active || getting || capture || note));
    if (!enabled) return;
    const head = document.createElement('div'); head.className = 'voice-draft-head';
    const title = document.createElement('span'); title.className = 'voice-draft-title';
    const actions = document.createElement('div'); actions.className = 'voice-draft-actions';
    if (active || getting) {
      const dot = document.createElement('span'); dot.className = 'voice-record-dot'; dot.setAttribute('aria-hidden', 'true');
      title.append(dot, document.createTextNode(getting ? 'Abriendo micrófono…' : 'Grabando nota'));
      const timer = document.createElement('span'); timer.id = 'voice-timer'; timer.className = 'voice-timer'; timer.textContent = '0:00 / ' + clock(status?.maxSeconds || 300);
      const stop = document.createElement('button'); stop.type = 'button'; stop.className = 'voice-primary'; stop.textContent = 'Detener'; stop.disabled = !!getting;
      stop.addEventListener('click', () => stopRecording());
      const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Cancelar'; cancel.addEventListener('click', () => discard());
      actions.append(stop, cancel); head.append(title, timer); panel.append(head, actions);
    } else if (capture || note) {
      title.textContent = (note ? 'Nota de voz' : 'Escucha tu nota') + ' · ' + clock(note?.duration || capture?.duration);
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'voice-discard'; remove.textContent = 'Descartar'; remove.disabled = locked || !!capture?.transcribing;
      remove.setAttribute('aria-label', 'Descartar nota de voz, conservando el texto'); remove.addEventListener('click', () => discard());
      head.append(title, remove); panel.appendChild(head);
      const url = audioUrl(note?.audioUrl) || previewUrl(capture);
      if (url) panel.appendChild(player(url, 'Escuchar tu nota de voz antes de enviarla').el);
      const help = document.createElement('p'); help.className = 'voice-help';
      help.textContent = note ? 'Transcripción en el mensaje: puedes editarla antes de enviar.' : 'Transcribe la nota para añadirla al mensaje. No se envía todavía.';
      panel.appendChild(help);
      if (!note && capture) {
        const transcribeButton = document.createElement('button'); transcribeButton.type = 'button'; transcribeButton.className = 'voice-primary'; transcribeButton.id = 'voice-transcribe';
        transcribeButton.textContent = capture.transcribing ? 'Transcribiendo…' : capture.failed ? 'Reintentar transcripción' : 'Transcribir'; transcribeButton.disabled = !!capture.transcribing || locked;
        transcribeButton.addEventListener('click', transcribe); panel.appendChild(transcribeButton);
      }
    }
    if (enabled && !navigator.mediaDevices?.getUserMedia) notice('El micrófono necesita una conexión HTTPS y un navegador compatible.', true);
    else if (enabled && !window.MediaRecorder) notice('Este navegador no permite grabar notas de voz. Puedes escuchar las respuestas.', true);
  }

  async function select(context, force = false) {
    if (!api) return;
    const next = validContext(context) ? { ...context } : null;
    if (!force && scopeOf(next) === scopeOf(current) && current) { current = next; renderDraft(); return; }
    stopRecording(); opening = null; pauseAudio(); releasePreview();
    for (const request of speechRequests.values()) request.abort(); speechRequests.clear();
    pendingVoice.clear(); // Opening a conversation never resumes an old automatic read.
    statusRequest?.abort();
    current = next; capture = null; enabled = false; status = null; composerSignature = ''; notice('');
    const generation = ++selection;
    renderDraft();
    if (!next || !next.voiceEnabled) return;
    const scope = scopeOf(next);
    capture = captures.get(scope) || null;
    const controller = new AbortController(); statusRequest = controller;
    const clipRead = capture ? Promise.resolve(capture) : storedClip(scope);
    const statusRead = api.fetch('/api/voice/status?' + new URLSearchParams({ agent: next.agent, key: next.key }), { cache: 'no-store', signal: controller.signal })
      .then(async response => response.ok ? response.json() : null).catch(() => null);
    const [found, availability] = await Promise.all([clipRead, statusRead]);
    if (generation !== selection || !isCurrent(next)) return;
    status = availability; enabled = availability?.enabled === true || (!availability && next.voiceEnabled === true);
    if (found?.blob instanceof Blob && Date.now() - found.createdAt < 7 * 864e5 && !draftNote()) {
      capture = found; captures.set(scope, capture);
    }
    if (draftNote()) capture = null;
    if (enabled && (!availability || availability.stt === false || availability.tts === false)) notice(!availability ? 'No se pudo comprobar la voz. Tu borrador se conserva; puedes reintentar con conexión.'
      : availability.stt === false ? 'El reconocimiento de voz no está disponible ahora. Puedes grabar y reintentar la transcripción.' : 'La voz de las respuestas no está disponible ahora. El chat sigue funcionando.');
    composerSignature = ''; changed(); refreshMessages();
  }
  async function startRecording() {
    if (disposed || !enabled || !validContext(current) || locked || capture || draftNote() || recording || opening) return;
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) { notice('El micrófono necesita HTTPS y un navegador compatible.', true); return; }
    const owner = { ...current }, ticket = { owner }; opening = ticket; pauseAudio(); notice(''); changed();
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
      if (opening !== ticket || !isCurrent(owner) || disposed) { stream.getTracks().forEach(track => track.stop()); return; }
      const format = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/webm'].find(type => MediaRecorder.isTypeSupported?.(type));
      const recorder = new MediaRecorder(stream, format ? { mimeType: format, audioBitsPerSecond: 64000 } : undefined);
      const job = { owner, stream, recorder, chunks: [], bytes: 0, startedAt: performance.now(), createdAt: Date.now(), discarded: false, stopping: false };
      job.done = new Promise(resolve => { job.resolve = resolve; });
      recording = job; opening = null;
      recorder.ondataavailable = event => {
        if (event.data?.size) { job.chunks.push(event.data); job.bytes += event.data.size; }
        if (job.bytes >= Math.min(26214400, status?.maxBytes || 26214400)) {
          if (isCurrent(owner)) notice('Has alcanzado el límite de tamaño. La grabación se ha detenido.');
          stopRecording();
        }
      };
      recorder.onstop = async () => {
        clearInterval(job.timer); stream.getTracks().forEach(track => track.stop());
        const duration = Math.min(300, Math.max(.1, (performance.now() - job.startedAt) / 1000));
        if (recording === job) recording = null;
        const blob = new Blob(job.chunks, { type: recorder.mimeType || format || 'audio/webm' });
        if (!job.discarded && blob.size) {
          const clip = { blob, duration, mime: blob.type, createdAt: job.createdAt };
          await rememberClip(owner, clip);
          if (isCurrent(owner)) { capture = clip; notice('Nota guardada como borrador. Escúchala o transcríbela.'); }
        } else if (!job.discarded && isCurrent(owner)) notice('No se recibió audio del micrófono. Revisa el dispositivo y vuelve a grabar.', true);
        job.resolve(); changed();
      };
      recorder.onerror = () => { if (isCurrent(owner)) notice('La grabación se ha interrumpido. Conservamos el audio recibido.', true); stopRecording(); };
      recorder.start(1000);
      job.timer = setInterval(() => {
        const seconds = (performance.now() - job.startedAt) / 1000;
        if (isCurrent(owner) && $('voice-timer')) $('voice-timer').textContent = clock(seconds) + ' / ' + clock(Math.min(300, status?.maxSeconds || 300));
        if (seconds >= Math.min(300, status?.maxSeconds || 300)) { if (isCurrent(owner)) notice('Límite de 5 minutos alcanzado. La nota está lista para revisar.'); stopRecording(); }
      }, 250);
      changed();
    } catch (error) {
      stream?.getTracks().forEach(track => track.stop());
      if (recording?.owner === owner) { clearInterval(recording.timer); recording.resolve(); recording = null; }
      if (opening === ticket) opening = null;
      if (isCurrent(owner)) notice(error.name === 'NotAllowedError' ? 'No hay permiso de micrófono. Actívalo para este Hub en el navegador o en el menú de la app.'
        : error.name === 'NotFoundError' ? 'No encontramos un micrófono. Conéctalo y vuelve a intentarlo.'
        : error.name === 'NotReadableError' ? 'No se puede abrir el micrófono. Revisa si otra aplicación lo está usando.' : 'No se pudo iniciar la grabación. Vuelve a intentarlo.', true);
      changed();
    }
  }
  function stopRecording(discarded = false) {
    if (opening) opening = null;
    const job = recording;
    if (!job) return Promise.resolve();
    if (discarded) job.discarded = true;
    clearInterval(job.timer);
    if (!job.stopping) {
      job.stopping = true;
      try { if (job.recorder.state !== 'inactive') job.recorder.stop(); } catch {}
      // Release the physical microphone immediately, not after an upload or DB write.
      job.stream.getTracks().forEach(track => track.stop());
    }
    return job.done;
  }
  async function discard() {
    if (locked || capture?.transcribing) return;
    const owner = current && { ...current };
    await stopRecording(true);
    if (!owner) return;
    pauseAudio(); await rememberClip(owner, null);
    if (sameUser(owner)) { const draft = { ...api.readDraft(owner) }; delete draft.voiceNote; delete draft.submission; api.writeDraft(draft, owner); }
    if (isCurrent(owner)) { capture = null; releasePreview(); composerSignature = ''; notice('Nota descartada. El texto del mensaje se conserva.'); changed(); }
  }
  async function transcribe() {
    if (!capture?.blob || capture.transcribing || locked || !current) return;
    const owner = { ...current }, clip = capture; api.saveDraft(); clip.transcribing = true; clip.failed = false; notice('Transcribiendo la nota…'); changed();
    const form = new FormData(), extension = /mp4/.test(clip.mime) ? 'm4a' : /ogg/.test(clip.mime) ? 'ogg' : 'webm';
    form.append('audio', clip.blob, 'nota-de-voz.' + extension);
    try {
      const response = await api.fetch('/api/voice/transcribe?' + new URLSearchParams({ agent: owner.agent, key: owner.key }), { method: 'POST', body: form });
      const result = await response.json();
      if (!response.ok || result.error || !result.id || !audioUrl(result.audioUrl) || !result.sessionId) throw new Error(result.error || 'No se pudo transcribir la nota.');
      if (!String(result.text || '').trim()) throw new Error('No se ha detectado voz. Escucha la nota y vuelve a grabar si hace falta.');
      if (!sameUser(owner)) return;
      // Read the latest text, including edits typed while Whisper was processing.
      if (isCurrent(owner)) api.saveDraft();
      const draft = api.readDraft(owner), text = String(result.text).trim();
      api.writeDraft({ ...draft, text: draft.text ? draft.text + (/\s$/.test(draft.text) ? '' : '\n') + text : text,
        voiceNote: { id: result.id, audioUrl: result.audioUrl, duration: Number(result.duration) || clip.duration, sessionId: result.sessionId } }, owner);
      await rememberClip(owner, null);
      if (isCurrent(owner)) { capture = null; releasePreview(); api.restoreDraft(); notice('Transcripción lista. Revisa el mensaje y pulsa Enviar.'); }
    } catch (error) {
      clip.failed = true;
      if (isCurrent(owner)) notice((error.message || 'No se pudo transcribir.') + ' Tu audio sigue aquí; puedes reintentarlo.', true);
    } finally { clip.transcribing = false; if (isCurrent(owner)) { composerSignature = ''; changed(); } }
  }

  function speechKey(owner, message) { return JSON.stringify([owner.user, owner.agent, owner.key, owner.sessionId, message.id]); }
  function speechNotice(result) {
    return [result.truncated ? 'Audio parcial · respuesta completa en texto' : '', result.omittedCode ? 'El código está en el texto' : ''].filter(Boolean).join(' · ');
  }
  function renderMessage(slot) {
    const entry = metadata.get(slot); if (!entry || !slot.isConnected && slot.dataset.ready) return;
    slot.dataset.ready = 'true'; slot.classList.toggle('hidden', !enabled || !isCurrent(entry.owner));
    if (!enabled || !isCurrent(entry.owner)) return;
    const { message, owner } = entry;
    if (message.role === 'user') {
      const url = audioUrl(message.voiceNote?.audioUrl); if (!url || slot.children.length) return;
      const label = document.createElement('span'); label.className = 'voice-message-label'; label.textContent = 'Nota de voz' + (message.voiceNote.duration ? ' · ' + clock(message.voiceNote.duration) : '');
      slot.append(label, player(url, 'Nota de voz enviada').el); return;
    }
    const cacheKey = speechKey(owner, message), cached = speechCache.get(cacheKey) || message.voiceAudio;
    const url = audioUrl(cached?.audioUrl);
    if (slot.dataset.source === (url || 'button')) return;
    slot.replaceChildren(); slot.dataset.source = url || 'button';
    if (url) {
      const playback = player(url, 'Escuchar respuesta del agente'); slot.appendChild(playback.el); entry.player = playback.audio;
      const note = speechNotice(cached); if (note) { const text = document.createElement('span'); text.className = 'voice-help'; text.textContent = note; slot.appendChild(text); }
    } else {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'voice-listen'; button.innerHTML = icon('speaker') + '<span>Escuchar</span>';
      button.setAttribute('aria-label', 'Escuchar esta respuesta en audio');
      button.addEventListener('click', () => generateSpeech(slot, true)); slot.appendChild(button);
    }
    const feedback = document.createElement('span'); feedback.className = 'voice-feedback'; feedback.setAttribute('role', 'status'); slot.appendChild(feedback); entry.feedback = feedback;
  }
  function mountMessage(bubble, message, context) {
    const owner = { ...context };
    if (!validContext(owner)) return;
    const note = message.role === 'user' && message.voiceNote;
    const response = message.role === 'assistant' && message.speakable === true && message.id && owner.sessionId && message.text?.trim()
      && !message.asyncQuestion && !message.tools?.length && message.phase !== 'commentary';
    if (!note && !response) return;
    const slot = document.createElement('div'); slot.className = 'voice-message hidden';
    metadata.set(slot, { message, owner }); bubble.el.appendChild(slot); renderMessage(slot);
  }
  function refreshMessages() { document.querySelectorAll('.voice-message').forEach(renderMessage); }
  async function generateSpeech(slot, autoplay = false, automatic = false) {
    const entry = metadata.get(slot);
    if (!entry || !isCurrent(entry.owner) || !enabled) return;
    const { owner, message } = entry, cacheKey = speechKey(owner, message);
    if (speechRequests.has(cacheKey)) return;
    if (entry.player) { if (autoplay) await entry.player.play().catch(() => { entry.feedback.textContent = 'Audio listo. Pulsa reproducir para escucharlo.'; }); return; }
    const request = new AbortController(); speechRequests.set(cacheKey, request);
    const button = slot.querySelector('button'); if (button) { button.disabled = true; button.querySelector('span').textContent = 'Preparando audio…'; }
    try {
      const response = await api.fetch('/api/voice/speech', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: request.signal,
        body: JSON.stringify({ agent: owner.agent, key: owner.key, messageId: message.id, sessionId: owner.sessionId }) });
      const result = await response.json();
      if (!response.ok || result.error || !audioUrl(result.audioUrl)) throw new Error(result.error || 'No se pudo generar la voz.');
      if (request.signal.aborted || !isCurrent(owner) || api.context().sessionId !== owner.sessionId) return;
      speechCache.set(cacheKey, result); while (speechCache.size > 100) speechCache.delete(speechCache.keys().next().value);
      // A history refresh may have rebuilt the slot while synthesis was running.
      const slots = [...document.querySelectorAll('.voice-message')].filter(node => { const item = metadata.get(node); return item && speechKey(item.owner, item.message) === cacheKey; });
      slots.forEach(node => { node.dataset.source = ''; renderMessage(node); });
      const target = slots.at(-1), targetEntry = target && metadata.get(target);
      if (autoplay && targetEntry?.player && (!automatic || preference(owner.user))) await targetEntry.player.play().catch(() => { targetEntry.feedback.textContent = 'Audio listo. Pulsa reproducir para escucharlo.'; });
    } catch (error) {
      if (error.name !== 'AbortError' && isCurrent(owner) && slot.isConnected) {
        if (entry.feedback) entry.feedback.textContent = (error.message || 'No se pudo generar la voz.') + ' Puedes reintentarlo.';
        if (button) { button.disabled = false; button.querySelector('span').textContent = 'Reintentar audio'; }
      }
    } finally { if (speechRequests.get(cacheKey) === request) speechRequests.delete(cacheKey); }
  }
  function accepted(message, attempt) {
    if (!attempt?.voiceNote?.id || !isCurrent({ user: api.context().user, agent: message.agentId, key: message.sessionKey })) return;
    if (message.runId && preference()) pendingVoice.set(message.runId, { owner: { ...current }, noteId: attempt.voiceNote.id, sessionId: attempt.voiceNote.sessionId, finalized: false, tries: 0 });
    while (pendingVoice.size > 20) pendingVoice.delete(pendingVoice.keys().next().value);
    // The accepted note is no longer a local recording, even after an uncertain retry.
    rememberClip(current, null); capture = null; releasePreview(); composerSignature = '';
    notice('');
  }
  function terminal(message) {
    const pending = pendingVoice.get(message.runId);
    if (!pending || message.agentId !== pending.owner.agent || message.sessionKey !== pending.owner.key || !isCurrent(pending.owner)) return;
    if (message.type !== 'final') { pendingVoice.delete(message.runId); return; }
    pending.finalized = true; pending.messageId = message.messageId; pending.terminalSessionId = message.sessionId;
  }
  function history(context, messages) {
    if (!isCurrent(context)) return;
    current = { ...current, sessionId: context.sessionId };
    for (const [runId, pending] of pendingVoice) {
      if (!pending.finalized || !isCurrent(pending.owner)) continue;
      if (!preference() || (pending.sessionId && pending.sessionId !== context.sessionId) || (pending.terminalSessionId && pending.terminalSessionId !== context.sessionId)) { pendingVoice.delete(runId); continue; }
      const message = messages.find(item => item.role === 'assistant' && !item.asyncQuestion && !item.tools?.length && item.text?.trim()
        && ((pending.messageId && item.id === pending.messageId) || (item.runId === runId && item.phase === 'final_answer')));
      if (message) {
        const slot = [...document.querySelectorAll('.voice-message')].find(node => metadata.get(node)?.message.id === message.id);
        if (slot && enabled) { pendingVoice.delete(runId); generateSpeech(slot, true, true); }
      } else if (++pending.tries < 3) {
        const generation = selection;
        setTimeout(() => { if (generation === selection && pendingVoice.has(runId) && isCurrent(pending.owner)) api.refreshHistory(pending.owner); }, pending.tries * 1500);
      } else {
        pendingVoice.delete(runId); notice('Respuesta disponible en texto. Puedes pulsar Escuchar para oírla.');
      }
    }
  }
  function init(adapter) {
    api = adapter;
    $('btn-voice')?.addEventListener('click', () => recording ? stopRecording() : startRecording());
    $('voice-replies')?.addEventListener('change', event => setPreference(event.target.checked));
    window.addEventListener('pagehide', () => {
      api.saveDraft(); disposed = true; enabled = false; pageEpoch++; selection++;
      // BFCache preserves this module, including requests and delayed final reads.
      // Returning must restore a draft, never resume an old automatic response.
      pendingVoice.clear(); statusRequest?.abort();
      for (const request of speechRequests.values()) request.abort(); speechRequests.clear();
      hiddenStop = Promise.allSettled([hiddenStop, stopRecording()]);
      pauseAudio(); releasePreview();
    });
    window.addEventListener('pageshow', async event => {
      if (!event.persisted || !disposed) return;
      const epoch = pageEpoch;
      await hiddenStop;
      if (epoch !== pageEpoch || !disposed) return;
      disposed = false;
      // An aborted synthesis may have left its existing button disabled. Rebuild
      // controls and Blob previews without requesting or playing any speech.
      document.querySelectorAll('.voice-message').forEach(slot => { slot.dataset.source = ''; });
      await select(api.context(), true);
      if (epoch === pageEpoch && !disposed) api.restoreDraft();
    });
    // Avoid accidentally capturing another app after switching away on a phone.
    document.addEventListener('visibilitychange', () => { if (document.hidden) stopRecording(); });
    window.addEventListener('hub-microphone-revoked', () => stopRecording());
  }
  window.HubVoice = { init, select, reset: () => select(null), renderDraft, busy, mountMessage, accepted, terminal, history,
    setLocked(value) { locked = !!value; renderDraft(); }, beforeHistoryRender: pauseAudio,
    async revokeMicrophone() { await stopRecording(); notice('Micrófono desactivado en el menú de la app. La nota se conserva.'); } };
})();
