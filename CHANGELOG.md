# Changelog

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

This package does not update any existing deployment and is not yet a public release.
