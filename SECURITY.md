# Security

This is a trusted-operator interface, not an anonymous chatbot service. Gateway
credentials and device identities can authorize powerful agent actions. Keep
the default loopback listener or put a trusted HTTPS proxy/private network in
front of it. Set `BEHIND_PROXY=1` only when forwarded headers are overwritten by
that proxy and direct access is prevented.

- `data/` contains credentials and authorization state. Keep it private and backed up.
- Per-user conversation ACLs do not isolate gateway memory, workspace or tools.
  Use separate gateways and data directories for mutually untrusted users/tenants.
- The example disables workspace-file fallback; native downloads still require
  authorization. Do not mount secrets to resolve missing files.
- The initial random admin password appears in first-start logs. Protect logs
  and restrict user policies before giving anyone access.
- Client-specific Internet-facing hosting profiles are not included. Setting
  `PANEL_TENANT` fails closed in this edition.

Report vulnerabilities privately using [GitHub security advisories](https://github.com/jobmaking/openclaw-hub/security/advisories/new),
not a public issue containing exploit details or secrets. No response-time or
support SLA is promised.
