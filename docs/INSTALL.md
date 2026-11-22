# Installation and operations

## Connect an existing gateway

`data/agents.json` is an array. Each entry requires `id`, `name`, `url`, `token`;
use `gatewayAgentId` when several native agents share a gateway (usually `main`
for the default agent). Optional fields include `emoji`, `role`, `lockedModel`
and `modelNote`. Never commit this file.

The Hub keeps a persistent signed device identity per configured agent. Complete
pairing on the gateway host using the exact approval command/ID printed in the
Hub log (commonly `openclaw devices approve <request-id>`). Use that host's correct
OpenClaw profile. If an approval is stale, retry connection and check the new ID.
The main connection requests `operator.read`, `operator.write`, `operator.admin`;
the model-settings connection deliberately uses only read/write scopes. Do not
turn an admin-connected Hub into an untrusted public agent service.

No workspace or Docker socket is mounted. Native deliverables work when supported
by the gateway. Arbitrary workspace downloads require explicitly configured roots
and filesystem mounts; the example disables that fallback. Do not mount a complete
home directory or credentials folder to make file links work.

Restart the Hub after changing the catalog, branding or users:

```bash
docker compose restart hub
```

## Users

Generate a new password (shown once in the command output):

```bash
docker compose exec hub node manage-users.js set colleague
docker compose exec hub node manage-users.js access colleague assistant own
docker compose restart hub
```

Replace `assistant` with your actual Hub agent identifier. Restrict access before
sharing the generated login. `own` confines conversations to ones created by that
user and their native children; `shared` permits shared conversations within the
allowed agents. Existing legacy conversations do not become owned by opening them.
For per-agent overrides use `scope colleague assistant own` or `default` to remove
the override. Keep `session-owners.json`: it is part of access-control state.

Use `set admin` to reset the administrator password. Do not pass passwords as
command-line arguments or paste their output into issues. This installation has
no self-service signup, password recovery or SSO.

User isolation covers Hub routes, not the agent's underlying memory, tools or
workspace. A shared agent can still access its own shared resources.

## Optional local voice

The voice UI is off until `data/voice.json` exists (mode `0600`). It is a JSON
document with `version: 1`, a `nodes` map and an `agents` map:

```json
{
  "version": 1,
  "nodes": {
    "local": {
      "url": "http://127.0.0.1:8898",
      "token": "REPLACE_WITH_AT_LEAST_32_RANDOM_CHARACTERS",
      "voice": "ef_dora"
    }
  },
  "agents": { "assistant": "local" }
}
```

`url` must be loopback HTTP. The referenced service must implement
`GET /health` → `{available,stt,tts}`, `POST /transcribe` with audio bytes →
`{text,duration,language?}`, and `POST /speech` with `{text,voice}` → MP3. The
service, Whisper/Kokoro models and GPU runtime are **not included**. Do not
publish the token or expose the voice port. An unconfigured agent gets no voice
controls and never falls back to another node. Keep `data/voice/` private with the
rest of `data/`.

## Node.js without Docker

Node 22.13 or newer is required. Follow the same `data/` setup and gateway editing in the
README, then:

```bash
npm ci
npm start
```

The default Node data directory is `./data` and binding is `127.0.0.1:18900`.
The `.env` file is read by Docker Compose, **not** automatically by Node. For
direct Node operation set environment variables in your shell/service manager.
When managing users directly, set `DATA_DIR` to the absolute data directory:

```bash
DATA_DIR="$PWD/data" node manage-users.js set colleague
```

## Work, files and media

Use **⋯ → Work** to see pending requests, active conversations, deliveries you
follow and files from conversations you can already access. **Entregables** on
each chat also opens authorized media. The viewer fits or enlarges images and
plays video only when requested. It never rewrites the source attachment.

The native gateway must report a supported media type. Preview supports PNG,
JPEG, GIF, WebP and AVIF (up to 24 MiB), plus MP4 and WebM (up to 128 MiB). The
browser or desktop client must support the codec; MP4 with H.264/AAC is a good
starting point. The original remains available through the download route when
authorized. No FFmpeg, transcoding service or external viewer is needed at runtime.

## Optional Documents

The editor is off by default. On a trusted installation, the operator can create
`data/documents-policy.json` with mode `0600`. Replace the example user and agent IDs
with IDs from that installation. Grants do not bypass conversation permissions.

~~~json
{"version":1,"enabled":true,"grants":{"colleague":["assistant"]}}
~~~

Open **⋯ → Doc**. **Guardar documento** or **Guardar copia** performs the first
save. **Cancelar** discards an unsaved draft; **← Chat** keeps it in that tab.
Compatible Markdown, plain text and simple Word attachments can be copied into
the editor without changing the original. Model-assisted proposals also need a
gateway with isolated document model-run support; ordinary editing does not.
Back up the complete private data directory, including the document SQLite store.
To revoke reading as well as editing, remove the relevant grant.

## Optional skill review and usage

Skill review is disabled unless the user record in private `data/users.json`
explicitly has `canReviewSkills: true`. Preserve its password hash and existing
policies when editing; use an explicit `allowedAgents` list and restart the Hub
after a controlled configuration change. Both shared and own-conversation users
can receive this privilege, but skill decisions change the agent globally.
The gateway must support the native Workshop review APIs. Never grant gateway
admin privileges just to bypass a rejected request.

Context consumption, conversation token totals and provider subscription quotas
are different metrics. Quotas use the OpenAI OAuth/token account configured for
the selected agent; API-key billing and other accounts are not inferred. Only
valid native quota windows show inline bars. API-key balance integrations are not
included in this edition. No percentage means no quota bar;
unknown, partial and old token records are not replaced by guessed zeroes.
In this version the quota button is also the only entry to token details: when
there is no valid quota window, the separate token detail is not accessible in
the UI, even if the native token API can return counters.
Gateway API support is required; missing support is not repaired by updating
or replacing your gateway automatically.

## Remote access and HTTPS

The simplest remote setup retains loopback binding and uses an SSH tunnel:

```bash
ssh -N -L 18900:127.0.0.1:18900 user@your-hub-host
```

Then open localhost:18900 on your computer. For a domain, terminate HTTPS at a
trusted reverse proxy, proxy WebSocket upgrades, strip client-supplied forwarded
headers and overwrite them with correct values. Set `BEHIND_PROXY=1` only behind
that proxy and prevent direct untrusted access to the Hub listener. The proxy must
be able to reach the loopback listener; a separate bridged container cannot use its
own localhost to reach the host. Do not bind `0.0.0.0` just to bypass proxy setup.

HTTPS or localhost is required for PWA/browser notifications. Set `VAPID_SUBJECT`
to your contact page or mailto address before enabling push. Push delivery uses
the browser's push provider; no analytics or hosted model endpoint is configured
by the Hub. Model requests go through your own gateways.

## Persistent data and updates

Back up **the complete `data/` directory privately**, including users, cookie
secret, device identities, session owners, uploads and push credentials. It contains
secrets and must not go into Git or issue attachments. For a simple coherent backup,
stop the Hub, copy/encrypt data to protected storage, then start it again. Back up
your OpenClaw gateway separately: Hub data is not a gateway conversation backup.

Before upgrading, keep a private data backup and the previous image/source version.
Preserve your catalog and user records. Build and test the new source, then run
`docker compose up -d --build`; verify login and a disposable real conversation on
your own gateway. Never replace `data/` with someone else's example or installation.

## Troubleshooting

- Exit at startup: validate `data/agents.json`, required fields and URL/token.
- Disconnected agent: confirm the URL is reachable from the Hub, token, correct
  native agent ID and device pairing. `127.0.0.1` refers to the Hub host in the
  supplied host-network recipe, not to a separate server.
- Missing advanced feature: check OpenClaw version/API availability. Do not treat
  mocked tests as proof of support in a different gateway release.
- Unavailable file: prefer native artifacts; do not broaden private mounts blindly.
- No login: find the first-start password in your private logs or reset it with
  the user-management command. Never delete all of `data/` to reset a password.
