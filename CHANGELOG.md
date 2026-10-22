# Changelog

## 1.0.37-community.1 — voice notes and spoken replies

- Add private voice notes: record, preview, transcribe and edit before sending;
  optional spoken replies and a Listen action for written answers.
- Route STT/TTS to the local voice service configured for each agent. No cloud
  fallback, models or worker runtime are included; voice is disabled by default.
- Include Linux desktop 1.0.4-community.1 with microphone-only native consent,
  a visible revoke control and draft preservation.
- Keep the empty mobile composer on one line with «Escribe…», including when
  microphone and STOP controls are visible.
- Recover voice drafts and controls after browser cache restoration without
  reopening the microphone or replaying old answers.

## 1.0.34-community.1 — file drag-and-drop recovery

- Clear the file-drop overlay after cancellation, leaving the window and dropping
  outside the chat; avoid intercepting unrelated drags or navigating to files.
- Include Linux desktop 1.0.3-community.1 with native file-drop compatibility.
- Include the isolated browser clipboard/drag-and-drop regression in public CI.
- Native fixtures and automated checks do not establish physical file-manager
  compatibility on every Linux desktop; user confirmation remains pending.

## 1.0.32-community.1 — collapsed session tree by default

- The sidebar session tree starts collapsed: only root sessions are visible;
  expand a branch or use “Expand all” to inspect derived sessions.
- Search still reveals matching sessions together with their ancestors.
- Preserve the published Playwright browser-test dependency and Chromium setup.
- No operational deployment, customer data or private hosting profiles are included.

## 1.0.31-community.2 — include the optional Linux desktop client

- Include desktop 1.0.2-community.1 source, installer and isolated native tests.
- Default to localhost; document custom HTTPS Hub URL without bundled credentials.
- Separate community application/config/launcher names from operational installations.
- Preserve sandbox, native downloads, notifications and per-user session persistence.
- No Windows/macOS binaries or support claim; no operational desktop update.

## 1.0.31-community.1 — initial standalone review package

- Export the web client and backend with fresh history and no operational data.
- Local-only Linux Docker recipe, Node installation guide and example configuration.
- Generic generated administrator and configurable Web Push contact.
- Omit private hosting profiles and reject their activation explicitly.
- Upgrade Multer from the deprecated 1.x line to 2.4.0 in this edition only.
- Include isolated backend, artifact, question and user-isolation regressions.
- Add CI, security guidance, MIT project license and third-party notices.

This package does not update any existing deployment.
