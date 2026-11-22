'use strict';

// Server-attested identity for messages the Hub forwards to an agent.
//
// The Hub authenticates the human (scrypt password + signed httpOnly cookie)
// and owns the session-ownership registry. The Gateway's `chat.send` has no
// sender field, so the attestation travels as the first line of the message.
// The Hub scrubs any imitation of that line from user-authored text, so the
// first matching line can only have been produced here.
const HEADER_RE = /^\[HUB · identidad verificada por el servidor del panel tras login: [^\]\n]{1,80} · [^\]\n]{1,120}\]$/u;
const MARKER_RE = /\[\s*HUB\s*[·•]\s*identidad\s+verificada/giu;
const SCRUBBED = '[HUB·identidad-no-verificada';

const clean = (value, max) => String(value ?? '')
  .replace(/[\u0000-\u001f\u007f]/g, ' ')
  .replace(/[[\]]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, max);

function header(user, name) {
  return `[HUB · identidad verificada por el servidor del panel tras login: ${clean(user, 80)} · ${clean(name || user, 120)}]`;
}

// Neutralize user-typed copies of the server marker. The original wording is
// replaced, not removed, so nobody can hide one marker inside another.
function scrub(text) {
  return String(text ?? '').replace(MARKER_RE, SCRUBBED);
}

function decorate(text, user, name) {
  const body = scrub(text);
  // Slash commands must remain the first characters for Gateway command
  // parsing. They are control-plane input, not an agent conversation turn.
  if (body.trimStart().startsWith('/')) return body;
  return body ? `${header(user, name)}\n${body}` : header(user, name);
}

function strip(text) {
  const value = String(text ?? '');
  const newline = value.indexOf('\n');
  const first = newline === -1 ? value : value.slice(0, newline);
  if (!HEADER_RE.test(first)) return value;
  return newline === -1 ? '' : value.slice(newline + 1);
}

module.exports = { header, scrub, decorate, strip, HEADER_RE };
