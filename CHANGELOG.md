# Changelog

## 1.4.20-community.1 — 2026-11-22

- Pinch to zoom a photo on mobile, or use the wheel on desktop and Linux.
  Drag a magnified image to pan. The chat and viewer controls stay in place.
- Chat thumbnails, Entregables and Work share the same viewer. **−**, **+**
  and **Ajustar** (Fit) work without gestures. Normal scrolling, explicit
  browser accessibility zoom and original downloads are preserved.
- This is a web update; the optional Linux launcher remains 1.0.8-community.1.

## 1.4.19-community.1 — 2026-11-22

- View images and play compatible videos inside the Hub on web, mobile and
  the optional Linux client, without navigating away or changing the original.
- Open Work, Doc and Skill from one chat menu. Work identifies each agent, keeps
  your place and opens recent attachments without switching conversations.
- Add the opt-in, chat-scoped Documents editor, explicit save/cancel, and
  read-only PDF, XLSX and DOCX previews with original downloads.
- Optional Linux desktop 1.0.8-community.1 adds a reload confirmation when a
  draft would be lost and keeps the separate community profile and launcher.
- Bundles only the standalone source, examples, verified renderer assets and
  local fixtures. Private hosting and API-key billing adapters are not included.

## 1.3.7-community.1 — 2026-11-19

- Compact mobile metadata into a deliberate menu when the visual viewport is
  short. Activity, progress and files share one row; expanded content and
  questions use a single outer scroll area. Drafts, selection, zoom and safe
  areas are preserved. Enabled Stop remains touchable beside blocking questions.
- Add native conversation token totals and supported OpenAI OAuth subscription
  quotas beside the context meter. Only real quota windows are displayed;
  missing data is not zero, stale snapshots are labelled, and late responses
  cannot overwrite another account, agent or conversation. No polling or storage.
- Respect explicit skill-review authorization also for own-conversation users;
  conversation privacy and global skill administration are separate privileges.
- Include Linux desktop 1.0.7-community.1: native Wayland preference with explicit
  X11 override, preserving profiles, sandbox, downloads and voice permissions.
  Native Wayland drag-and-drop remains unverified; the file picker is available.
- Ignore late desktop focus callbacks after the web view has been destroyed,
  preventing a native exception dialog when closing and reopening the client.
  Late focus events also respect minimized/inactive windows instead of restoring
  the client when a background notification arrives.
- Expand public CI with usage, model settings, skill-review and mobile regression
  fixtures using the declared pinned browser dependency. Physical phone IMEs
  and independent third-party gateway versions are not certified by these tests.

## 1.3.2-community.1 — 2026-11-17

- Reconcile the open conversation against native run status after missed terminal
  events, and refresh session/agent lists without restoring stale unread state.
- Include Linux desktop 1.0.5-community.1, focusing the window and web view on
  opening, activation and second-instance requests.

## 1.3.1-community.1 — 2026-11-15

- Opening a conversation now acknowledges its read state through the native
  `sessions.patch { unread: false }` contract with `expectedMarkedUnreadAt`.
  The unread dot clears when the conversation is read, while a newer manual
  unread marker from another client is preserved.
- Only the open conversation's automatic unread state is acknowledged here;
  a manual marker remains until the conversation is reopened.

## 1.3.0-community.1 — 2026-11-15

- Show whether an agent is working without opening a conversation: each session
  row carries a live Working indicator, Waiting when a question needs an answer,
  and Ready/Stopped/Error after the turn closes. Agent tabs get a live activity
  dot while any of that agent's turns is active.
- The indicator is backed by the gateway's native `hasActiveRun` truth and
  session/chat events, with a bounded safety refresh. It is not a local timer.
- Add optional Workshop skill review for explicitly authorized operators:
  inspect complete instructions, comparison and files before accepting or
  rejecting the exact revision. Nothing is applied automatically, and a changed
  installed skill blocks an update until it is reviewed again.
- On mobile, selecting a skill proposal opens its detail; Back to pending keeps
  the inbox within reach. Desktop keeps the side-by-side review layout.

## 1.1.5-community.1 — 2026-10-31

- Consolidated conversation navigation on desktop and mobile. One expandable
  panel groups Other sessions, ordering, older conversations and search,
  leaving the session list clear by default.
- The internal Central origin selector is not included. Every authorized
  conversation remains available in the community edition's general view.
- Compact view controls stay on one row, including on narrow mobile screens.
- Stop cancels only the active response. Queued follow-ups are preserved and
  can start next; Stop confirmation recognizes the new run taking over.
- The active run ID scopes Stop precisely, preventing session-wide
  cancellation from interrupting the preserved follow-up.
- Interrupted follow-ups are resumed idempotently only when native receipts
  confirm they were not consumed; started or completed work is never replayed.

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
