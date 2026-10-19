# Contributing

Use Node 22, run `npm ci` and `npm test`, and keep changes focused. Tests use
synthetic credentials and local inert gateways, never production resources.
Preserve per-user HTTP/WebSocket authorization, device signing, confirmed queue
state and scoped file downloads. Include a regression check for substantive
behavior changes. Do not copy a real users.json, agents.json, cookies or device
identity into fixtures. Redact logs before sharing them.

In bug reports include Hub version, OpenClaw version, installation method and
reproduction steps. Do not include credentials or private conversation history.
Security-sensitive reports follow SECURITY.md.

The UI is Spanish-first; English is used for code comments and contributor docs.
Independent contributions should preserve the existing user-facing behavior.
