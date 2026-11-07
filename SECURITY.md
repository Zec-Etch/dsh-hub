# Security policy

## Threat model

A hub login is **full control of every connected DSH machine**: terminals, file read/write, settings, plugins and credentials are all reachable through the tunnel, with no API allow-list. Treat the hub like an SSH jump host.

- The access password is the only gate. Use a long random one and rotate it with `node server.mjs set-password` if it may have leaked; every session ends at once.
- TLS terminates at the hub, so the hub sees all traffic. Run it only on a machine you trust, behind HTTPS.
- Per-backend tokens are shown once and only their hashes are stored. Revoke a token from the picker page to disconnect a backend.
- Do not expose `DSH_HUB_TRUST_PROXY=1` without a proxy that overwrites `X-Forwarded-For`.

## Reporting a vulnerability

Please report privately through GitHub's "Report a vulnerability" (Security tab → Advisories) rather than a public issue. Include the version, a description and steps to reproduce.
