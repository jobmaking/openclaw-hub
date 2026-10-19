# OpenClaw HUB for Linux (optional)

A sandboxed Electron client for an existing Hub server, with a persistent login,
native uploads, download management and Linux notifications. The client does not
start a Hub server, run models or bypass server permissions. Its version is
independent of the server version. Windows/macOS builds are not included or tested.

## Install

Requirements: a Linux graphical session, Node.js22.12+ and npm, Internet access
for the pinned Electron runtime, and standard Electron Linux system libraries.
On Ubuntu/Debian these include GTK3, NSS, ALSA and X11 libraries. Use your system
package manager if Electron reports a missing library.

From the source tree:

```bash
bash desktop/install.sh
```

Run as your normal user, without sudo. Open **OpenClaw HUB** from the applications
menu, or run `~/.local/bin/openclaw-hub-desktop`. It connects to
`http://127.0.0.1:18900/` by default. Start the web server separately or configure
the address of your existing Hub. Log in using that Hub's normal account; the
client ships no account, password, gateway token or copied browser session.

The installer requires Chromium sandbox support. Where Linux restricts user
namespaces it reuses an existing trusted, root-owned SUID Chrome/Chromium helper,
if available. It does not run sudo or change AppArmor, kernel settings or sudoers.
If no usable sandbox is available, resolve that with your system administrator;
never use `--no-sandbox` or run the app as root. Releases/profiles are preserved.

## Choose your Hub server

Create `~/.config/openclaw-hub-desktop/config.env` privately:

```bash
mkdir -p -m 700 ~/.config/openclaw-hub-desktop
printf '%s\n' 'HUB_URL=https://hub.example.com/' > ~/.config/openclaw-hub-desktop/config.env
chmod 600 ~/.config/openclaw-hub-desktop/config.env
```

Replace the example with your real Hub URL. Use HTTPS for remote servers; do not
put credentials in the URL. This is a local shell configuration file: do not
source a config supplied by someone you do not trust. Close and reopen the app
after changing it. Each configured installation uses one persistent profile;
switching to a different server does not migrate its accounts or conversations.

For temporary launch configuration without a config file:

```bash
HUB_URL=https://hub.example.com/ ~/.local/bin/openclaw-hub-desktop
```

A saved config takes precedence over this temporary variable. An already-open
single-instance client keeps its current server until closed/reopened.

## Files and notifications

- Attach using the file picker, drag-and-drop or Ctrl+V for screenshots. Attaching
  does not send automatically; review and press Send. Server limits still apply.
- Downloads have progress, pause/resume, cancellation and reveal-in-folder. Choose
  a folder or enable a native save dialog from the menu. Filename collisions do
  not overwrite existing files. Failed/expired file links preserve chat and draft.
- Downloaded EXE/JSON files are not executed inside chat. The client does not widen
  access to the gateway filesystem; prefer native deliverables for remote agents.
- The bell enables native pending-question/permission notifications while the app
  is open, including minimized. Clicking opens the request, never answers or grants
  permission. The menu offers a test notification. No delivery is promised while
  the app is closed; browser/PWA Web Push is a separate alternative.
- Ctrl+O attaches, Ctrl+J opens downloads, Ctrl+F finds, Ctrl+R reloads, Ctrl+Q quits.
- Downloads go to the system Downloads/Hub folder by default. Uninstalling does
  not remove downloaded files.

## Browser alternative

```bash
~/.local/bin/openclaw-hub-desktop --browser
```

Requires Chrome/Chromium. Uses a separate persistent browser profile and your
configured server. `HUB_CHROME` selects a browser and `HUB_PROFILE` overrides its
profile path. No Chrome/Chromium runtime is bundled in the source ZIP.

## Data, updates and uninstall

- Releases: `~/.local/share/openclaw-hub-desktop/releases/`; `current` selects one.
- Native login/preferences: `~/.config/openclaw-hub-desktop/native/`.
- Browser alternative: `~/.config/openclaw-hub-desktop/chrome/`.
- Log: `~/.local/state/openclaw-hub-desktop/native.log` (keep private).
- Launcher: `~/.local/bin/openclaw-hub-desktop`; `--version` prints the client version.

The community client's paths are separate from an existing `hub-desktop` install.
XDG_DATA_HOME/XDG_CONFIG_HOME/XDG_STATE_HOME are honored. `HUB_BIN_DIR` overrides
the launcher directory for managed/isolated installations. `HUB_USER_DATA_DIR`
isolates a native test profile. Profiles must not be committed or shared in issues.

To update, close the client with no active transfers, install the reviewed new
source, then reopen. Earlier releases remain for rollback; changing `current`
does not replace a process that is already running.

```bash
bash desktop/uninstall.sh
# Also move the login/config profile to the desktop trash:
bash desktop/uninstall.sh --purge
```

Requires `gio`; uses trash rather than deleting user data. Downloaded files remain.

## Development checks

```bash
npm ci --prefix desktop
node desktop/node_modules/electron/install.js
npm test --prefix desktop
xvfb-run -a -s '-screen 0 1440x1000x24' node desktop/test/desktop-check.cjs
```

The GUI suite uses the actual frontend against a local fixture, temporary profiles
and inert downloads. It checks uploads, clipboard, downloads/hashes, errors without
navigation, persistence and renderer sandboxing. No production accounts or model
calls are required. On restricted Ubuntu hosts, the development runtime may need
the same trusted system sandbox helper as the installer; never disable sandboxing.

Notifications can be tested on a private D-Bus/X display with a real EWMH window
manager (Openbox), `python3-dbus`, `python3-gi` and `gdbus`:

```bash
xvfb-run -a -s '-screen 0 1440x1000x24' env \
  HUB_DESKTOP_TEST_WM=/usr/bin/openbox node desktop/test/notifications-check.cjs
```

Tests isolate profiles and notifications from your desktop. Passing them does not
certify every Linux distribution, compositor or notification service.
