# DSH Hub

[简体中文](README.zh-CN.md)

A small always-on web service plus a plugin for DeepSeek Harness (DSH, npm package `@deepseek-ai/dsh`). Every DSH instance dials **out** to the hub over a persistent WebSocket; you sign in to the hub from any browser, pick an instance, and use **that instance's own, complete Web GUI**. Pages, settings, terminals, files and plugin UIs all come from the backend itself. The hub only relays bytes, and wraps them in a PWA and phone layout without modifying DSH.

```
browser ──HTTPS/WSS──▶ dsh-hub (server) ◀──outbound WSS── dsh-hub-agent plugin (each DSH)
        /h/<id>/*                byte tunnel               └▶ that DSH's local web server
```

- `hub/` – the server, the sign-in and harness picker pages, and the mobile shell (`public/shell/`). One runtime dependency (`ws`); no front-end build.
- `plugin/` – the DSH plugin, zero dependencies. It replays requests with the DSH's own browser session, so DSH upgrades and new plugins need no hub changes.

`plugin/mux.js` and `hub/mux.mjs` must stay identical; the tests check it.

> This is an independent, unofficial project. It contains no DeepSeek Harness code and is not affiliated with its authors.

## Run the hub

Node.js 20 or newer.

```sh
cd hub && npm ci --omit=dev
DSH_HUB_DATA=/var/lib/dsh-hub node server.mjs set-password   # generates and prints a password once
DSH_HUB_DATA=/var/lib/dsh-hub node server.mjs serve          # listens on 127.0.0.1:8790 by default
```

Put it behind a TLS reverse proxy (see [`dsh-hub.service`](hub/deploy/dsh-hub.service) and [`Caddyfile.example`](hub/deploy/Caddyfile.example)); PWAs and service workers require HTTPS.

For a container managed by MCSManager, start from [`mcsm-instance.example.json`](hub/deploy/mcsm-instance.example.json): a docker instance with the code mounted at `/app` and data at `/data`. The daemon mounts the instance directory as the working directory itself, so keep `workingDir` at `/workspace` – using `/app` fails with `Duplicate mount point`.

| Variable | Meaning |
| --- | --- |
| `DSH_HUB_DATA` | Data directory, default `./data` |
| `HOST` / `PORT` | Listen address, default `127.0.0.1:8790` |
| `DSH_HUB_PUBLIC_ORIGIN` | Public URL, e.g. `https://hub.example.com`; used for Origin checks and Secure cookies |
| `DSH_HUB_TRUST_PROXY` | `1` trusts the proxy's `X-Forwarded-For`. Required behind a proxy, otherwise everyone shares one login rate-limit bucket |
| `DSH_HUB_PASSWORD` | With `set-password`, choose the password (at least 10 characters) |

Changing the password signs out every browser. Static files in `hub/public/` are read from disk per request, so front-end changes need no restart; changes to `server.mjs` do.

## Connect a DSH

1. Install the `plugin/` bundle in that DSH.
2. On the picker page choose **Add harness** to get a JSON snippet shown once.
3. Save it as `$DSH_HOME/dsh-hub-agent.json`. The plugin connects within seconds, no restart.

Without that file the plugin stays idle. Non-loopback hubs must use `https`/`wss`, otherwise the plugin refuses to connect.

The bundle also pins this DSH's folder chooser to the in-app one (`directory-picker-browse`), including on the desktop: a native dialog would open on the backend's screen, which looks like a hang when used remotely.

## Security model

**A hub login is full control of the connected machine.** Through the hub you can use terminals, read and write files, change settings and manage plugins and credentials; there is no API allow-list. See [SECURITY.md](SECURITY.md).

- **The password is the only gate.** Use a long random one. If it leaks, run `set-password` again: the old password and every session end at once.
- **The hub is inside the trust boundary.** TLS ends at the hub, which sees everything; whoever controls it can operate every connected DSH. Run it on a machine you trust.
- Browser side: scrypt password, HttpOnly + SameSite=Strict cookie, login rate limiting, Origin checks on WebSockets and writes. The hub cookie never crosses the tunnel and the DSH cookie never reaches the browser.
- Backend side: one independent 256-bit token per backend, only its hash is stored; the token travels in the first frame, never in URLs or access logs; revocable at any time.
- All backends share one origin, so DSH's local storage is namespaced per backend and session state cannot leak between them.

## Mobile and PWA

DSH's own front end has no phone layout. `hub/public/shell/` adds one without changing DSH. Selectors use only the semantic part of CSS-module class names (such as `_sidebarCol`) and DSH's `data-*` state attributes, so rebuilt hashes do not break them. Design notes and the iOS findings are in [docs/mobile-shell.md](docs/mobile-shell.md).

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

Browser regression checks for the phone shell live in [`hub/test-browser/`](hub/test-browser/shell-input.mjs); they need Chromium with remote debugging and `playwright-core`, and are not part of `npm test`.

## License

[Apache License 2.0](LICENSE)

