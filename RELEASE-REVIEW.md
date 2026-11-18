# Community preview — release review

Repository: https://github.com/jobmaking/openclaw-hub
License: MIT. Publication authorized by the project owner on 2026-10-19.

## 1.3.7 candidate review

- Web 1.3.7-community.1 and optional Linux desktop 1.0.6-community.1 source.
- Mobile reading layout, supported provider quotas, scoped token totals and
  explicit own-scope skill-review privileges are included. No operational
  data, account settings, gateway credentials or private hosting adapters.
- The public check command now includes the new usage, model, skill-review,
  mobile keyboard and touch-scrolling fixtures, not just the historical suites.
- Verify the fresh export, installed launcher, manifest and executable modes;
  public CI must pass on the exact public SHA before a release is created.
- Mobile geometry is emulated, not a physical IME certification. Native Wayland
  file drop and independent third-party installations remain separate checks.

## 1.1.5 candidate review

- Consolidates the conversation controls into one accessible expandable panel
  on desktop and mobile; no view actions remain at the bottom of the tree.
- Excludes the operational Central tab and its backend partition. Community
  users keep all authorized sessions in the general list.
- Candidate checks must cover collapsed and expanded desktop/mobile layouts,
  search and view switching, the complete exported backend suites, Compose,
  image build and public CI for the exact release SHA.

## 1.3.0 candidate review

- Web 1.3.0-community.1 and optional Linux desktop 1.0.4-community.1 source.
- Includes live per-session and per-agent working status, optional Workshop
  skill review for explicitly authorized operators, and the mobile proposal
  navigation. Nothing is applied automatically; the Central selector remains
  out of the community edition and every authorized session stays in the
  general view.
- Local candidate results: exported web suites all pass (94/94 backend audit,
  29/29 artifact routes, 61/61 question contract, 25/25 user isolation, the
  paste browser suite reports TODO OK, and 25/25 voice contract); desktop unit
  tests 18/18; Compose validation and the isolated image build pass.
- Public CI for the exact release SHA and the anonymous release download remain
  required. The operational Hub live acceptance covered the working row and
  agent dot; no operational screenshots or data are included here.

## 1.3.1 candidate review

- Web 1.3.1-community.1: opening a conversation acknowledges its native read
  state with `expectedMarkedUnreadAt`; the unread dot clears and a newer manual
  marker from another client is not erased. No permissions were expanded.
- The community tenant stub continues to reject `PANEL_TENANT`; the private
  per-tenant read route is not exported.
- Local results: 94/94 backend audit, 29/29 artifact routes, 61/61 question
  contract, 25/25 user isolation, paste suite TODO OK, 25/25 voice contract,
  18/18 desktop unit tests; Compose validation and the isolated image build
  pass. Public CI and anonymous release download remain required.

## Reviewed scope

- Fresh public history; no operational repository history, users, data or credentials.
- Allowlisted standalone web edition plus optional Linux desktop source and installer.
- Private hosting profiles excluded; PANEL_TENANT explicitly rejected.
- Dependency licenses and notices retained in THIRD_PARTY.md.
- Exact source manifest verified before publication.
- Local verification: 208 web checks, 17 desktop unit checks, 44 desktop GUI
  checks and 23 desktop notification checks; 292 checks passed in isolation.
- Docker Compose validation, image build and isolated installer verification passed.
- GitHub Actions repeats web/unit checks and image build for this public tree.
- First private CI run found an undeclared Playwright/browser dependency. It is
  now pinned explicitly as a development dependency with Chromium setup in CI.
- 1.0.32 review (2026-10-20): the exported web tests, Docker Compose validation
  and image build passed. The operational Hub live acceptance covered the
  collapsed session tree, derived-session expansion and the general E2E flow.

## 1.0.34 candidate review

- Web 1.0.34-community.1 and optional Linux desktop 1.0.3-community.1 source.
- Includes file-drop overlay recovery and Linux desktop native-drop compatibility.
- Public CI includes the isolated clipboard/drag-and-drop browser fixture.
- Candidate desktop: 47 GUI checks with the actual launcher, GTK native
  URI-list PDF/ZIP batch, exact uploaded bytes, attachment chips and effective
  renderer sandbox checks; 17 unit checks. Isolated browser drop suite: 19 checks.
- The exact source commit is recorded in SOURCE.json; exported-package CI results
  must be checked for the public release SHA. Historical counts above are separate.
- Automated native fixtures are distinct from a physical file-manager drag.
  Confirmation from the reporting Linux user remains pending.

## 1.0.37 candidate review

- Web 1.0.37-community.1 and optional Linux desktop 1.0.4-community.1 source.
- Includes private voice notes, optional spoken replies and a local-only voice
  adapter contract; no models, worker runtime or cloud fallback are included.
- Includes the mobile one-line composer and browser cache-recovery corrections.
- Public CI repeats the backend, artifact, question, user-isolation and paste
  suites, including the authenticated voice-route contract, then validates
  Compose and builds the image. Desktop unit tests run separately.
- Acceptance of the operational release: 46/46 voice UI checks, 25/25 voice
  route checks and 22/22 native agent voice checks; synthetic audio and mobile
  Chromium emulation, not a physical phone or human microphone.
- The Linux desktop microphone consent was validated with real Electron dialogs
  and X11 input in an isolated display; camera, screen and subframe requests are
  denied. Physical desktop and mobile-device checks remain separate evidence.

## Limits

This is a community preview, not a universal compatibility certification. No new
independent third-party installation has been verified. The operational Hub is
used separately; isolated checks do not establish compatibility with every
OpenClaw release or Linux distribution. No Windows/macOS desktop build is included.
Screenshots from the operational installation are intentionally omitted.

Private vulnerability reporting is configured on GitHub. Use the Security tab
to report a vulnerability privately, rather than disclosing secrets in issues.
