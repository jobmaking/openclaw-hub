/* Accessible question cards shared by blocking requests and async choices. */
(() => {
  'use strict';
  const node = (tag, className, text) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  };
  const optionValue = option => String(option.reply ?? option.value ?? option.label ?? '');
  const allowsText = question => !(question.options || []).length || question.isOther !== false;
  const freeValues = (question, value) => {
    const raw = question.isSecret || question.presentation === 'form' ? String(value || '') : String(value || '').trim();
    return raw ? question.answerFormat === 'lines' ? raw.split(/\r?\n/u) : [raw] : [];
  };
  function values(question, draft) {
    const selected = draft.picked[question.id] || [];
    const free = allowsText(question) ? freeValues(question, draft.free[question.id]) : [];
    return [...selected, ...free];
  }
  function prepareDraft(request, draft) {
    draft.picked ||= {};
    draft.free ||= {};
    for (const question of request.questions || []) {
      const valid = new Set((question.options || []).map(optionValue));
      if (!Array.isArray(draft.picked[question.id])) {
        const defaults = !question.isSecret && Array.isArray(question.defaultAnswers) ? question.defaultAnswers.map(String) : [];
        draft.picked[question.id] = defaults.filter(value => valid.has(value));
        draft.free[question.id] = allowsText(question)
          ? defaults.filter(value => !valid.has(value)).join(question.answerFormat === 'lines' ? '\n' : '') : '';
      } else {
        // Previously free text was also written into picked. Keep one source.
        draft.picked[question.id] = draft.picked[question.id].filter(value => valid.has(value));
      }
    }
  }
  function create({ request, draft, agentName, sourceChip, persist = () => {}, submit, skip, restore, settled = () => {}, countdown = () => '' }) {
    prepareDraft(request, draft);
    const async = request.blocking === false;
    const answered = !!request.answered || !!draft.answered;
    const dismissed = async && !answered && request.dismissed === true;
    const available = request.answerable !== false;
    const card = node('section', 'prompt question' + (async ? ' async-question' : ''));
    card.setAttribute('role', 'group');
    card.setAttribute('aria-label', (async ? 'Pregunta' : 'Respuesta pendiente') + ' de ' + agentName);
    if (async) { card.dataset.answered = String(answered); card.dataset.answerable = String(available); card.dataset.dismissed = String(dismissed); }
    const head = node('div', 'prompt-head');
    const symbol = node('span', 'prompt-symbol', answered ? '✓' : dismissed ? '−' : '?');
    symbol.setAttribute('aria-hidden', 'true');
    head.appendChild(symbol);
    head.appendChild(node('span', 'who', answered ? 'Respuesta enviada' : dismissed ? 'Pregunta descartada' : !available ? 'Pregunta del historial' : async ? agentName + ' te pregunta' : agentName + ' espera tu respuesta'));
    head.appendChild(node('span', 'prompt-badge', answered ? 'Confirmada' : dismissed ? 'Descartada' : !available ? 'Solo lectura' : async ? 'Opcional' : 'Tu decisión'));
    if (sourceChip) head.appendChild(sourceChip);
    if (request.expiresAtMs && !answered) {
      const clock = node('span', 'clock', countdown(request.expiresAtMs));
      clock.dataset.exp = request.expiresAtMs;
      head.appendChild(clock);
    }
    card.appendChild(head);
    const fields = [];
    for (const [index, question] of (request.questions || []).entries()) {
      const field = node('fieldset', 'prompt-fieldset');
      field.dataset.multiSelect = String(!!question.multiSelect);
      const legend = node('legend', 'prompt-q', question.question || question.title || 'Tu respuesta');
      if (question.header) legend.prepend(node('span', 'prompt-topic', question.header));
      if (request.questions.length > 1) legend.prepend(node('span', 'question-count', (index + 1) + '/' + request.questions.length + ' · '));
      field.appendChild(legend);
      if (answered) {
        const saved = request.answers?.[index] ?? draft.answerSummary?.[index];
        field.appendChild(node('div', 'prompt-answer-summary', saved || 'Respuesta confirmada. Puedes continuar en el chat.'));
        card.appendChild(field);
        continue;
      }
      if (!available || dismissed) { card.appendChild(field); continue; }
      const options = node('div', 'prompt-opts');
      const buttons = [];
      for (const option of question.options || []) {
        const button = node('button', 'prompt-opt');
        button.type = 'button';
        const mark = node('span', 'mark'); mark.setAttribute('aria-hidden', 'true');
        const copy = node('span', 'o');
        const label = node('span', 'ot', option.label || optionValue(option));
        if (option.recommended) label.appendChild(node('span', 'rec', 'Recomendado'));
        copy.appendChild(label);
        if (option.description) copy.appendChild(node('span', 'od', option.description));
        button.append(mark, copy);
        button.addEventListener('click', () => {
          if (draft.sending) return;
          const value = optionValue(option);
          if (question.multiSelect) {
            const selected = draft.picked[question.id];
            const position = selected.indexOf(value);
            if (position < 0) selected.push(value); else selected.splice(position, 1);
          } else {
            draft.picked[question.id] = [value];
            draft.free[question.id] = '';
            if (free) free.value = '';
          }
          draft.error = null;
          persist(); refresh();
        });
        buttons.push({ button, value: optionValue(option) });
        options.appendChild(button);
      }
      if (buttons.length) field.appendChild(options);
      if (question.answerFormat === 'lines') field.appendChild(node('p', 'prompt-multi', 'Escribe una respuesta por línea.'));
      else if (question.multiSelect && buttons.length) field.appendChild(node('p', 'prompt-multi', 'Puedes elegir varias opciones.'));
      let free;
      if (allowsText(question)) {
        const label = node('label', 'prompt-free-label', buttons.length ? 'O escribe tu respuesta' : 'Tu respuesta');
        free = node(question.isSecret ? 'input' : 'textarea', 'prompt-other');
        if (question.isSecret) { free.type = 'password'; free.autocomplete = 'off'; }
        else free.rows = 2;
        free.placeholder = buttons.length ? 'Otra respuesta…' : 'Escribe aquí…';
        free.setAttribute('aria-label', 'Tu respuesta: ' + (question.question || question.title || ''));
        free.value = draft.free[question.id] || '';
        free.addEventListener('input', () => {
          draft.free[question.id] = free.value;
          if (!question.multiSelect && free.value.length) draft.picked[question.id] = [];
          draft.error = null;
          persist(); refresh();
        });
        label.appendChild(free); field.appendChild(label);
      }
      fields.push({ question, buttons, free, field });
      card.appendChild(field);
    }
    if (answered) return card;
    if (dismissed) {
      card.appendChild(node('p', 'prompt-hint', 'Descartada en este navegador. No se ha enviado ninguna respuesta al agente.'));
      if (available && restore) {
        const actions = node('div', 'prompt-actions');
        const button = node('button', 'skip question-restore', 'Volver a responder'); button.type = 'button';
        const error = node('div', 'prompt-error'); error.setAttribute('role', 'alert');
        const refreshRestore = () => {
          button.disabled = !!draft.sending;
          card.setAttribute('aria-busy', String(!!draft.sending));
          error.textContent = draft.error || '';
          error.classList.toggle('hidden', !draft.error);
        };
        button.addEventListener('click', async () => {
          if (draft.sending) return;
          draft.sending = true; draft.error = null; refreshRestore();
          try { await restore(); }
          catch (failure) { draft.error = failure?.message || 'No se pudo recuperar la pregunta. Puedes reintentar.'; }
          finally { draft.sending = false; refreshRestore(); settled(); }
        });
        actions.appendChild(button); card.append(error, actions);
        card.refreshQuestion = refreshRestore;
        refreshRestore();
      }
      return card;
    }
    if (!available) {
      card.appendChild(node('p', 'prompt-hint', 'Esta pregunta ya no admite respuestas desde este historial. Puedes continuar en la conversación actual.'));
      return card;
    }
    const hint = node('p', 'prompt-hint', async
      ? 'El agente puede seguir trabajando. Descartar la oculta de tus pendientes en este navegador, sin enviar una respuesta.'
      : 'Tu respuesta se enviará al agente, sin perder lo que estabas escribiendo en el chat.');
    card.appendChild(hint);
    const error = node('div', 'prompt-error hidden');
    error.setAttribute('role', 'alert');
    card.appendChild(error);
    const actions = node('div', 'prompt-actions');
    const completion = request.questions.length > 1 ? node('span', 'prompt-completion') : null;
    if (completion) { completion.setAttribute('role', 'status'); completion.setAttribute('aria-live', 'polite'); actions.appendChild(completion); }
    const send = node('button', 'send', 'Enviar respuesta'); send.type = 'button';
    actions.appendChild(send);
    let skipButton;
    if (skip) {
      skipButton = node('button', 'skip', async ? 'Descartar' : 'Omitir'); skipButton.type = 'button';
      skipButton.title = async ? 'No responder y quitar de pendientes en este navegador' : 'Cancelar la pregunta sin responder ni autorizar';
      actions.appendChild(skipButton);
    }
    card.appendChild(actions);
    function refresh() {
      const sending = !!draft.sending;
      let validation = '';
      const validFields = request.questions.map(question => {
        const answers = values(question, draft);
        if (!answers.length) return !!question.allowEmpty;
        if (answers.some(value => question.isSecret || question.presentation === 'form' ? value.length === 0 : !value.trim())) {
          validation = 'Completa o elimina las líneas vacías para enviar.';
          return false;
        }
        if (!question.multiSelect && answers.length > 1) { validation = 'Esta pregunta admite una sola respuesta.'; return false; }
        return true;
      });
      const valid = validFields.length > 0 && validFields.every(Boolean);
      if (completion) {
        const text = validFields.filter(Boolean).length + ' de ' + validFields.length + ' respondidas';
        if (completion.textContent !== text) completion.textContent = text;
      }
      send.disabled = sending || !valid;
      send.textContent = sending ? 'Enviando…' : 'Enviar respuesta';
      card.setAttribute('aria-busy', String(sending));
      if (skipButton) skipButton.disabled = sending;
      for (const { question, buttons, free, field } of fields) {
        field.disabled = sending;
        for (const { button, value } of buttons) {
          const selected = draft.picked[question.id].includes(value);
          button.disabled = sending;
          button.classList.toggle('sel', selected);
          button.setAttribute('aria-pressed', String(selected));
        }
        if (free) free.disabled = sending;
      }
      error.textContent = draft.error || validation;
      error.classList.toggle('hidden', !draft.error && !validation);
    }
    async function perform(cancel) {
      if (draft.sending || !cancel && send.disabled) return;
      const answers = Object.fromEntries(request.questions.map(question => [question.id, values(question, draft)]));
      draft.sending = true; draft.error = null; refresh();
      try {
        const result = await (cancel ? skip() : submit(answers));
        if (result?.error) throw new Error(result.error);
      } catch (failure) {
        draft.error = failure?.message || 'No se pudo enviar. Tu respuesta sigue aquí para reintentar.';
      } finally { draft.sending = false; refresh(); settled(); }
    }
    send.addEventListener('click', () => perform(false));
    skipButton?.addEventListener('click', () => perform(true));
    card.addEventListener('keydown', event => {
      if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey) || event.isComposing || event.keyCode === 229) return;
      event.preventDefault(); perform(false);
    });
    card.refreshQuestion = refresh;
    refresh();
    return card;
  }
  window.HubQuestions = Object.freeze({ create, values, prepareDraft });
})();
