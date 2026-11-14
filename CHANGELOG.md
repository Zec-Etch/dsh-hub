# Changelog

## 0.2.1 — 2026-11-14

- Make the repository root an installable `dsh-hub-agent` DSH bundle. Both a pinned GitHub installation spec and a standalone client tarball are supported.
- Declare Node.js 22+ for the agent and DSH `>=0.2.2-rc.1 <0.3.0` compatibility; retain Node.js 20+ support for the server.
- Stop touch stylesheet changes from triggering another stylesheet scan, and skip writes when generated CSS is unchanged.
- Add real Chromium regression checks for idle scans, dynamic stylesheet changes, mixed mutation batches and the desktop branch.
- Add client packaging tests, server Docker/Compose deployment files, bilingual setup instructions and release checksums.

DSH itself is not modified or redistributed. No protocol change or data migration is required.
