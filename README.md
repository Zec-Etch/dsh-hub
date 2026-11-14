# DSH Hub

[简体中文](README.zh-CN.md)

A small always-on web service plus a plugin for DeepSeek Harness (DSH, npm package `@deepseek-ai/dsh`). Every DSH instance dials **out** to the hub over a persistent WebSocket; you sign in to the hub from any browser, pick an instance, and use **that instance's own, complete Web GUI**. Pages, settings, terminals, files and plugin UIs all come from the backend itself. The hub only relays bytes, and wraps them in a PWA and phone layout without modifying DSH.

```
browser ──HTTPS/WSS──▶ dsh-hub (server) ◀──outbound WSS── dsh-hub-agent plugin (each DSH)
        /h/<id>/*                byte tunnel               └▶ that DSH's local web server
```

- [`hub/`](hub/) – the server, the sign-in and harness picker pages, and the [mobile shell](hub/public/shell/). One runtime dependency (`ws`); no front-end build.
- [`plugin/`](https://github.com/Zec-Etch/dsh-hub/tree/v0.2.1/plugin) – the DSH plugin, zero dependencies. It replays requests with the DSH's own browser session, so DSH upgrades and new plugins need no hub changes.

The [agent mux](https://github.com/Zec-Etch/dsh-hub/blob/v0.2.1/plugin/mux.js) and [server mux](hub/mux.mjs) must stay identical; the tests check it.

> This is an independent, unofficial project. It contains no DeepSeek Harness code and is not affiliated with its authors.

## v0.2.1: choose the right package

| Component | Requirements | Install/download |
| --- | --- | --- |
| DSH client bundle, **`dsh-hub-agent`** (repository root) | DSH **`>=0.2.2-rc.1 <0.3.0`**, agent runtime **Node.js >=22** | DSH bundle source `github:Zec-Etch/dsh-hub#v0.2.1`, or [dsh-hub-agent-0.2.1.tgz](https://github.com/Zec-Etch/dsh-hub/releases/download/v0.2.1/dsh-hub-agent-0.2.1.tgz) |
| Standalone hub server | **Node.js >=20**, **22 recommended**; Docker image uses 22 | [dsh-hub-server-0.2.1.tar.gz](https://github.com/Zec-Etch/dsh-hub/releases/download/v0.2.1/dsh-hub-server-0.2.1.tar.gz), or source tag `v0.2.1` |

The client tarball is **not the server**. The server archive extracts into `dsh-hub-server-0.2.1/` with [`hub/`](hub/), [`docs/`](docs/), both READMEs, [LICENSE](LICENSE), [NOTICE](NOTICE) and [SECURITY.md](SECURITY.md). Only `ws` is needed at server runtime; there is no front-end build or bundled private DSH code.

## Deploy the hub

Follow the [deployment guide](docs/deployment.md) ([中文](docs/deployment.zh-CN.md)) for exact download/tag checkout commands, Docker/Compose initialization, DNS, Caddy HTTPS/WebSockets, permissions, systemd/MCSManager, backup, upgrade and recovery.

For a local Node.js smoke setup, from the extracted archive or checked-out source root:

```sh
cd hub
npm ci --omit=dev
export DSH_HUB_DATA="$PWD/data"
node server.mjs set-password   # prints a newly generated random password; keep it private
node server.mjs serve          # default: 127.0.0.1:8790; foreground process
```

Do not expose this HTTP port publicly. For production, use a trusted TLS reverse proxy, set `DSH_HUB_PUBLIC_ORIGIN=https://hub.example.com` and `DSH_HUB_TRUST_PROXY=1`, and use a persistent data directory outside the release. HTTPS is required for remote agents, PWAs and service workers. The provided [Compose configuration](hub/deploy/compose.yaml) publishes **only `127.0.0.1:8790`**, runs as non-root and persists `/data` in a named volume.

**Recommended conservative password-rotation procedure: stop the hub, run `set-password` against the same data directory/volume and as the same service user, then start it again.** After completing this flow, the previous password and browser sessions are invalid. This is an operational recommendation, not a claim that a restart is required to apply a password change. Do not run two serving hub instances against the same data directory. See [operations](docs/deployment.md#operations).

## Install and connect a DSH

1. In **each DSH instance's plugin/bundle installer**, install source **`github:Zec-Etch/dsh-hub#v0.2.1`**. Alternatively paste the [Release tgz URL](https://github.com/Zec-Etch/dsh-hub/releases/download/v0.2.1/dsh-hub-agent-0.2.1.tgz) into that installer, or download it and install its absolute local path. The installed bundle name is `dsh-hub-agent`; installing server dependencies with npm does not enable it in DSH.

   ```text
   https://github.com/Zec-Etch/dsh-hub/releases/download/v0.2.1/dsh-hub-agent-0.2.1.tgz
   ```
2. Sign in to the HTTPS hub. On the picker choose **Connect backend**, enter a name and copy the JSON shown **once**.
3. Save it privately on the **backend running DSH** as `$DSH_HOME/dsh-hub-agent.json`. If `DSH_HOME` is unset, use the DSH process user's `~/.dsh/dsh-hub-agent.json`, not the browser computer's home. On POSIX, use directory mode `0700` and file mode `0600`; on Windows, restrict the file ACL to that account. See [credential setup](docs/deployment.md#connect-an-agent).
4. Once the bundle is loaded, settings changes are picked up within about 5 seconds without restarting DSH. Wait for the backend to become online, then open it and check its GUI and terminal.

Without a valid URL/token the agent stays idle. Remote connections must use `https`/`wss`; do not use the insecure override in production. The backend makes an **outbound** connection; no inbound port forwarding to DSH is required. Treat the JSON as a password: never paste its real value into logs, screenshots, issues or this repository.

The bundle also pins this DSH's folder chooser to the in-app one (`directory-picker-browse`), including on the desktop: a native dialog would open on the backend's screen, which looks like a hang when used remotely.

## Security model

**A hub login is full control of the connected machine.** Through the hub you can use terminals, read and write files, change settings and manage plugins and credentials; there is no API allow-list. See [SECURITY.md](SECURITY.md).

- **The password is the only gate.** Use a long random one. If it leaks, use the recommended conservative rotation flow above: stop the hub, run `set-password` on the same persistent data, then start it again. Completing this flow invalidates the old password and all previous browser sessions.
- **The hub and its TLS proxy are inside the trust boundary.** HTTPS/WSS terminates at the reverse proxy and is relayed to the hub; both can see traffic. Whoever controls them can operate every connected DSH. Use trusted machines and protect the proxy-to-hub link.
- Browser side: scrypt password, HttpOnly + SameSite=Strict cookie, login rate limiting, Origin checks on WebSockets and writes. The hub cookie never crosses the tunnel and the DSH cookie never reaches the browser.
- Backend side: one independent 256-bit token per backend, only its hash is stored; the token travels in the first frame, never in URLs or access logs; revocable at any time.
- All backends share one origin. Local storage is namespaced per backend for convenience, not a security boundary between mutually untrusted backends; only connect machines you trust.

## Mobile and PWA

DSH's own front end has no phone layout. The [mobile shell](hub/public/shell/) adds one without changing DSH. Selectors use only the semantic part of CSS-module class names (such as `_sidebarCol`) and DSH's `data-*` state attributes, so rebuilt hashes do not break them. Design notes and the iOS findings are in [docs/mobile-shell.md](docs/mobile-shell.md).

| Screen | Layout |
| --- | --- |
| width < 768, or touch with device height ≤ 500 | one column; the sidebar becomes a drawer with edge-swipe; settings become a full-screen single pane |
| tablet, desktop | DSH's own multi-column layout |

- Soft keyboard: `visualViewport` keeps the page on the visible area; the composer is never covered and iOS does not zoom.
- Touch: hover-only actions stay visible (the rule scans stylesheets at runtime, so third-party plugins are covered), larger targets, keyboard-shortcut hints hidden. Toolbar buttons no longer raise the keyboard.
- Terminal: Esc, Tab, arrows and Ctrl+C/D/L above the keyboard while focused.
- Notch and home-indicator safe areas, landscape, light/dark, reduced motion.
- PWA: installable, the picker opens offline, reopening returns to the last backend. The service worker never caches backend content or API responses, so stale sessions are not shown as online.
- Diagnostics: long-press the menu button for a panel with viewport, safe-area and editor-event readings, useful for reporting device-specific layout problems.

## Known limitations

- "Open in…", "Reveal file" and "Open config file" run on the **backend computer**, by definition.
- The right-sidebar browser loads URLs on the **phone**, so `localhost` means the phone, not the backend.
- Voice input needs microphone permission over HTTPS; the hub does not restrict it, the browser decides.
- An iOS home-screen app can run with a window shorter than the screen; that strip cannot be used (see the mobile notes).

## Tests

```sh
cd hub && npm test
```

Where a restricted shell cannot spawn child processes, use `node --test --test-isolation=none test/hub.test.mjs`.

Browser regressions are separate from `npm test`. The [touch-style regression](hub/test-browser/touch-styles.mjs) uses only the existing `ws` dependency and an isolated Chromium test browser with loopback-only remote debugging:

```sh
# From hub/, with a dedicated test browser already listening on loopback port 9333:
CDP_URL=http://127.0.0.1:9333 node test-browser/touch-styles.mjs public/shell/boot.js
```

The older [phone input checks](hub/test-browser/shell-input.mjs) additionally require the optional development tool `playwright-core`; it is not a server runtime dependency. Never expose a browser debugging port publicly or use a browser holding real credentials for these tests.

## License

[Apache License 2.0](LICENSE)

