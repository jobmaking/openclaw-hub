#!/usr/bin/env bash
# Move app files to the trash. Keep downloads and profiles unless requested.
set -euo pipefail
DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/openclaw-hub-desktop"
ICON_ROOT="$DATA_HOME/icons/hicolor"
command -v gio >/dev/null 2>&1 || { printf 'Se necesita gio para usar la papelera.\n' >&2; exit 1; }
if [ -n "${1:-}" ] && [ "$1" != --purge ]; then printf 'Uso: %s [--purge]\n' "$0" >&2; exit 1; fi
trash_path() { if [ -e "$1" ] || [ -L "$1" ]; then gio trash -- "$1"; fi; }
trash_path "$DATA_HOME/applications/openclaw-hub.desktop"
trash_path "$DATA_HOME/applications/openclaw-hub-browser.desktop"
trash_path "$DATA_HOME/openclaw-hub-desktop"
if [ -L "${HUB_BIN_DIR:-$HOME/.local/bin}/openclaw-hub-desktop" ]; then trash_path "${HUB_BIN_DIR:-$HOME/.local/bin}/openclaw-hub-desktop"; fi
for size in 512 192 32; do trash_path "$ICON_ROOT/${size}x${size}/apps/openclaw-hub.png"; done
if command -v update-desktop-database >/dev/null 2>&1; then update-desktop-database "$DATA_HOME/applications" >/dev/null 2>&1 || true; fi
if [ "${1:-}" = --purge ]; then trash_path "$CONFIG_DIR"; fi
printf 'Hub enviado a la papelera. Tus archivos descargados no se han tocado.\n'
if [ "${1:-}" != --purge ]; then printf 'La sesión se conserva en %s\n' "$CONFIG_DIR"; fi
