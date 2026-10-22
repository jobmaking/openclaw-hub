# Hub para Linux

## 1.0.4

- Allow microphone-only voice notes after a native consent dialog for the Hub
  origin and main frame; camera, screen and subframe requests stay blocked.
- Remember this consent per origin and make it revocable from a visible,
  accessible microphone button and the native menu, stopping an active recording
  while retaining its audio/text draft.
- Preserve the existing profile, sandbox, X11/XWayland path and file transfers.

## 1.0.3

- Prefer X11/XWayland when available for the validated native file-drop path.
  Honor explicit --ozone-platform overrides and preserve Wayland-only startup.
- Test actual GTK URI-list drags with PDF/ZIP files into Electron, including
  upload bytes and attachment chips, rather than only synthetic DOM events.
- Keep the existing profile, sandbox, downloads and web attachment limits.

## 1.0.2

- Deliver native Linux notifications for pending questions and permissions,
  including reconciled optional questions, while Hub is open or minimized.
- Restore the existing window and open a request without answering, granting
  permission or losing an unsent draft when its notification is clicked.
- Add a notification toggle and a native test action; retain explicit opt-outs.
- Deduplicate by account and transcript, withdraw resolved or expired notices,
  pause safely offline and retry failed delivery with bounded backoff.
- Keep remote content sandboxed without a desktop preload, IPC or extra socket.

## 1.0.1

- Keep the conversation and unsent draft intact when a file download fails.
- Route protected EXE/JSON files and file popups through native downloads.
- Reject HTTP errors and expired redirects instead of saving an error as a file.
- Preserve authenticated, single-GET downloads without consuming links twice.
- Add an always-available return-to-Hub action to the desktop icon.

## 1.0.0

- Desktop window with an integrated title bar, remembered size and one instance.
- Download drawer with real progress, pause, resume, cancellation and reveal.
- Native save dialogs, selectable download directory and collision-safe filenames.
- Existing Hub uploads through the file picker, drag-and-drop and clipboard.
- Find in conversation, text zoom, context menu and keyboard shortcuts.
- Isolated persistent session, sandboxed remote content and restricted desktop IPC.
- Chrome/PWA launcher retained as an alternative for Chrome Web Push.
