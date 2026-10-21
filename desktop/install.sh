#!/usr/bin/env bash
# Install an immutable, per-user release. Previous releases and profiles remain.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
APP_DIR="$DATA_HOME/openclaw-hub-desktop"
APPS_DIR="$DATA_HOME/applications"
ICON_ROOT="$DATA_HOME/icons/hicolor"
VERSION="$(cat "$ROOT/desktop/VERSION")"
RELEASE="$APP_DIR/releases/$VERSION-$(date +%Y%m%d%H%M%S)-$$"
say() { printf '  %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
[ "$(id -u)" -ne 0 ] || die 'ejecútalo como tu usuario, no como root'
command -v node >/dev/null 2>&1 || die 'necesitas Node.js 22.12 o superior'
command -v npm >/dev/null 2>&1 || die 'necesitas npm'
node -e 'const [major,minor]=process.versions.node.split(".").map(Number);process.exit(major>22||(major===22&&minor>=12)?0:1)' || die 'necesitas Node.js 22.12 o superior'
node -e 'const fs=require("node:fs");const p=process.argv[1];process.exit(require(p+"/package.json").version===fs.readFileSync(p+"/VERSION","utf8").trim()?0:1)' "$ROOT/desktop" || die 'VERSION y package.json no coinciden'
if [ -e "$APP_DIR/current" ] && [ ! -L "$APP_DIR/current" ]; then die 'current existe y no es un enlace; no se ha tocado'; fi
mkdir -p "$RELEASE" "$APPS_DIR" "${HUB_BIN_DIR:-$HOME/.local/bin}"
for filename in package.json package-lock.json VERSION CHANGELOG.md main.cjs core.cjs notifications.cjs preload.cjs shell.html shell.css shell.js; do
  install -m 644 "$ROOT/desktop/$filename" "$RELEASE/$filename"
done
install -m 644 "$ROOT/public/icons/hub-v2/icon-512.png" "$RELEASE/icon.png"
say "Preparando Hub $VERSION…"
npm ci --prefix "$RELEASE" --omit=dev --no-audit --no-fund
# Electron 44 installs its executable explicitly, with upstream checksum checks.
node "$RELEASE/node_modules/electron/install.js"
[ -x "$RELEASE/node_modules/electron/dist/electron" ] || die 'no se ha instalado el motor de escritorio'
# Reuse a trusted system Chromium SUID helper where Ubuntu restricts userns.
# The bundled, user-owned helper is kept; no sudo or host policy changes.
for candidate in /opt/google/chrome/chrome-sandbox /usr/lib/chromium/chrome-sandbox /usr/lib/chromium-browser/chrome-sandbox; do
  if [ -u "$candidate" ] && [ -x "$candidate" ] && [ "$(stat -c %u "$candidate")" = 0 ]; then
    mv "$RELEASE/node_modules/electron/dist/chrome-sandbox" "$RELEASE/node_modules/electron/dist/chrome-sandbox.bundled"
    ln -s "$candidate" "$RELEASE/node_modules/electron/dist/chrome-sandbox"
    break
  fi
done
node --check "$RELEASE/main.cjs"
node --check "$RELEASE/notifications.cjs"
install -m 755 "$ROOT/desktop/openclaw-hub-desktop" "$APP_DIR/openclaw-hub-desktop"
install -m 755 "$ROOT/desktop/openclaw-hub-browser" "$APP_DIR/openclaw-hub-browser"
ln -s "$RELEASE" "$APP_DIR/current.next.$$"
mv -Tf "$APP_DIR/current.next.$$" "$APP_DIR/current"
install -Dm644 "$ROOT/public/icons/hub-v2/icon-512.png" "$ICON_ROOT/512x512/apps/openclaw-hub.png"
install -Dm644 "$ROOT/public/icons/hub-v2/icon-192.png" "$ICON_ROOT/192x192/apps/openclaw-hub.png"
install -Dm644 "$ROOT/public/icons/hub-v2/favicon-32.png" "$ICON_ROOT/32x32/apps/openclaw-hub.png"
cat >"$APPS_DIR/openclaw-hub.desktop" <<EOF
[Desktop Entry]
Type=Application
Version=1.0
Name=OpenClaw HUB
GenericName=OpenClaw HUB de agentes
Comment=Tu equipo de agentes, archivos y conversaciones
Exec="$APP_DIR/openclaw-hub-desktop"
Icon=openclaw-hub
Terminal=false
Categories=Network;InstantMessaging;
Keywords=hub;agentes;chat;ia;archivos;
StartupNotify=true
StartupWMClass=Hub
X-GNOME-UsesNotifications=true
Actions=Downloads;Browser;

[Desktop Action Downloads]
Name=Descargas
Exec="$APP_DIR/openclaw-hub-desktop" --downloads

[Desktop Action Browser]
Name=Abrir versión navegador
Exec="$APP_DIR/openclaw-hub-browser"
EOF
cat >"$APPS_DIR/openclaw-hub-browser.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=OpenClaw HUB (navegador)
Exec="$APP_DIR/openclaw-hub-browser"
Icon=openclaw-hub
Terminal=false
NoDisplay=true
StartupWMClass=openclaw-hub-browser
EOF
ln -sfn "$APP_DIR/openclaw-hub-desktop" "${HUB_BIN_DIR:-$HOME/.local/bin}/openclaw-hub-desktop"
if command -v desktop-file-validate >/dev/null 2>&1; then desktop-file-validate "$APPS_DIR/openclaw-hub.desktop"; fi
if command -v update-desktop-database >/dev/null 2>&1; then update-desktop-database "$APPS_DIR" >/dev/null 2>&1 || true; fi
if command -v gtk-update-icon-cache >/dev/null 2>&1; then gtk-update-icon-cache -f -t "$ICON_ROOT" >/dev/null 2>&1 || true; fi
say "Versión: $VERSION"
say "App: $APP_DIR/openclaw-hub-desktop"
say 'Sesión de Chrome anterior conservada; la app usa un perfil independiente.'
printf '\nListo. Abre «Hub» en el menú de aplicaciones.\n'
