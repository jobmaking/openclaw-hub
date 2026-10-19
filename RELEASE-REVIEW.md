# First community preview — release review

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

## Limits

This is a community preview, not a universal compatibility certification. No new
independent third-party installation has been verified. The operational Hub is
used separately; isolated checks do not establish compatibility with every
OpenClaw release or Linux distribution. No Windows/macOS desktop build is included.
Screenshots from the operational installation are intentionally omitted.

Private vulnerability reporting is configured on GitHub. Use the Security tab
to report a vulnerability privately, rather than disclosing secrets in issues.
