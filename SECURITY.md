# Security policy

## Threat model

A hub login is **full control of every connected DSH machine**: terminals, file read/write, settings, plugins and credentials are all reachable through the tunnel, with no API allow-list. Treat the hub like an SSH jump host.

- The access password is the only gate. Use a long random one. For a conservative rotation procedure, stop the hub, run `node server.mjs set-password` using the same service identity and data directory, then start it again. Old browser sessions are invalidated. Follow the [deployment guide](docs/deployment.md#rotate-the-login-password); do not print real credentials into shared logs.
- Production TLS terminates at your trusted HTTPS reverse proxy. Both the proxy and hub can see decrypted traffic and belong inside the trust boundary. Keep the hub HTTP listener private; use a protected private link or TLS if the upstream crosses an untrusted network.
- Per-backend tokens are shown once and only their hashes are stored. Revoke a token from the picker page to disconnect a backend.
- Do not expose `DSH_HUB_TRUST_PROXY=1` without a proxy that overwrites `X-Forwarded-For`.

## Reporting a vulnerability

Please report privately through GitHub's "Report a vulnerability" (Security tab → Advisories) rather than a public issue. Include the version, a description and steps to reproduce.
