# OpenClaw HUB

A self-hosted web interface for your OpenClaw agents. Bring several gateways into
one place, with streaming chat, conversation history, files and per-user access.

**Independent community project. Not an official OpenClaw product.**
This is the community preview: a standalone **web + optional Linux desktop edition**, based on Hub 1.0.34. The interface is
currently Spanish-first. A running OpenClaw gateway and its model configuration
are required; this repository does not include models, API credits or a gateway.

## Features

- Multiple agents/gateways, persistent conversations, history and search.
- Collapsible session tree; derived sessions stay folded unless expanded.
- Streaming responses, native progress, pending inputs and confirmed STOP.
- Model and reasoning controls using capabilities advertised by your gateway.
- Blocking and optional questions, tool approvals and reconnect recovery.
- Uploads, previews and authorized native deliverables.
- File drag-and-drop recovery, including the Linux desktop X11/XWayland file-drop path.
- Scrypt password hashes, signed login cookies and per-user agent/conversation access.
- Responsive layout and installable PWA; optional browser notifications.

Features depend on your gateway's capabilities. The supplied regression tests use
inert local gateways, not real models. This is not a hosted service or a sandbox
for anonymous visitors. Read [security and isolation](SECURITY.md) before sharing
access with other people.

## Quick start — Linux + Docker Compose

Prerequisites: Linux, Docker with Compose v2, and an existing OpenClaw gateway.
Host networking lets the container reach a gateway listening on host loopback.
For macOS/Windows use the [Node installation](docs/INSTALL.md) instead; the supplied
Compose recipe is Linux-only.

```bash
mkdir -m 700 data
cp examples/agents.example.json data/agents.json
cp examples/branding.example.json data/branding.json
cp .env.example .env
chmod 600 data/agents.json .env
```

Edit `data/agents.json`: replace the placeholder token with your gateway token and
check its actual WebSocket URL/port. The sample port is not auto-discovered. `id`
is a unique Hub identifier; `gatewayAgentId` is the native OpenClaw agent ID.
Leave `fileRoots.published` empty unless you explicitly want workspace-file fallback.
It does not disable authorized native deliverables.

```bash
docker compose up -d --build
docker compose logs hub
```

Open **http://127.0.0.1:18900** on the host. The first-start log contains the
generated password for **admin**. Store it privately; there is no default password.
If the gateway asks for device pairing, approve the exact device ID shown in the
log on that gateway's host. Do not disable gateway authentication or pairing.

Keep the loopback default. Remote access, HTTPS, backups, adding users and
troubleshooting: [installation guide](docs/INSTALL.md).

## Development and checks

Requires Node.js 22 or newer; Node 22 is the container baseline.

```bash
npm ci
npx playwright-core install --with-deps chromium
npm test
```

Playwright downloads a pinned Chromium for the account-boundary browser check.
On Linux, `--with-deps` may need administrator access to install browser libraries;
use `CHROMIUM_PATH` to select a compatible browser already installed.

Tests exercise the real backend against simulated local gateways: authentication,
user/session isolation, file boundaries, native question contracts and artifacts.
An isolated browser fixture also checks clipboard and drag-and-drop recovery.
They do not use production credentials or call models. CI also builds the Docker
image. Test fixture credentials and names are synthetic.

## Optional Linux desktop client

Connect to your local Hub or an existing HTTPS Hub with a separate sandboxed
desktop window, native attachments, download management and notifications:

```bash
bash desktop/install.sh
```

Open **OpenClaw HUB** in the applications menu. It connects to localhost:18900 by
default; set your own server in its private configuration. No gateway credentials
or saved login are bundled. Requires Node22.12+, npm and a Linux graphical desktop.
The installer downloads the pinned Electron runtime. The desktop client (1.0.3-community.1) is optional
and versioned separately; it does not start the server or include models.
Full setup, features and sandbox requirements: [desktop/README.md](desktop/README.md).

## Compatibility and scope

This implementation targets OpenClaw's 2026.10-era APIs; pending-input handling
was originally verified against 2026.10.3. It uses signed device handshakes and
requests protocols 2–4. Advanced features need native APIs for sessions, artifacts,
questions, progress and queue state. Other releases require verification; protocol
negotiation alone does not prove feature compatibility.

This export excludes operational data, repository history, client-specific public
hosting profiles and production-only test/deploy
scripts. `PANEL_TENANT` is deliberately rejected, not silently ignored. Use separate
Hub instances and gateways for separate trust boundaries.

## Contributing and license

See [CONTRIBUTING.md](CONTRIBUTING.md). Project code is offered under the
[MIT license](LICENSE); dependencies retain their own licenses, including MPL-2.0
for web-push. See [THIRD_PARTY.md](THIRD_PARTY.md).
`SOURCE.json` identifies the private source revision without including its history.
`MANIFEST.sha256` covers the original source package, excluding itself. Runtime
data, installed dependencies and your edits are not part of that manifest.
