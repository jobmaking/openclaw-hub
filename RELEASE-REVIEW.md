# Community preview — release review

Repository: https://github.com/jobmaking/openclaw-hub
License: MIT. Publication authorized by the project owner on 2026-10-19.

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
  route checks and 22/22 native Bu/Paco voice checks; synthetic audio and mobile
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
