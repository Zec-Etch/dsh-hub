# Deploy DSH Hub v0.2.1

[简体中文](deployment.zh-CN.md) · [Project README](../README.md)

## Scope and prerequisites

A hub login grants **full control of every connected DSH backend**, including terminals, files, settings, plugins and credentials. Treat the hub, TLS proxy, data backups and agent JSON credentials like an SSH control plane. See [SECURITY.md](../SECURITY.md). This is an independent project: no DSH private code is included.

These examples use **Linux with a POSIX shell** and placeholder domain `hub.example.com`. Replace the domain with one you control. Use one service manager and **one hub process per data directory**; choose Compose, plain Docker, or native/systemd below, not all three.

- Server: Node.js **>=20**, **22 recommended**; only runtime dependency is `ws`. Static front-end files need **no build**.
- Agent: DSH **`>=0.2.2-rc.1 <0.3.0`**, with a **Node.js >=22** runtime (global WebSocket support). This is stricter than the server requirement.
- For containers: Docker Engine and Compose v2. No prebuilt registry image is required; build locally from the release.
- For native/systemd: Node.js/npm, a dedicated non-root service account, and administrative access for service installation.
- A trusted TLS reverse proxy (Caddy example below), DNS, and inbound TCP 80/443 for its normal certificate flow. Agents need outbound HTTPS/WSS to the hub; do **not** publish a DSH backend port.

## 1. Obtain the server

Choose **one** option. Run subsequent commands from its resulting top-level directory. Client package `dsh-hub-agent-0.2.1.tgz` is not the standalone server.

### Release archive

```sh
curl --fail --location --remote-name \
  https://github.com/Zec-Etch/dsh-hub/releases/download/v0.2.1/dsh-hub-server-0.2.1.tar.gz
tar -tzf dsh-hub-server-0.2.1.tar.gz   # inspect before extracting
tar -xzf dsh-hub-server-0.2.1.tar.gz
cd dsh-hub-server-0.2.1
```

Download from the trusted [v0.2.1 release](https://github.com/Zec-Etch/dsh-hub/releases/tag/v0.2.1); verify any published checksum before extraction. The archive has one top-level `dsh-hub-server-0.2.1/` containing [`hub/`](../hub/), [`docs/`](./), both READMEs, [LICENSE](../LICENSE), [NOTICE](../NOTICE) and [SECURITY.md](../SECURITY.md). It does not contain the DSH application or require its source.

### Source tag

```sh
git clone --branch v0.2.1 --depth 1 \
  https://github.com/Zec-Etch/dsh-hub.git dsh-hub-server-0.2.1
cd dsh-hub-server-0.2.1
git describe --tags --exact-match   # v0.2.1
```

Do not deploy a moving default branch. Server dependency installation is in the `hub` directory, not the client package at the repository root.

## 2. Start one server deployment

### Option A: Docker Compose (recommended)

The [Dockerfile](../hub/Dockerfile) uses Node 22 Alpine, installs locked production dependencies with `npm ci --omit=dev --ignore-scripts`, copies only server runtime/static files, and runs as `node` (UID/GID 1000). Its entrypoint is `node server.mjs` and its default argument is `serve`; **`set-password` replaces that argument**, so do not prepend another `node server.mjs` in the commands below.

The [Compose file](../hub/deploy/compose.yaml) uses an independent named volume **`dsh-hub-data`** at `/data`, a read-only container filesystem, dropped capabilities, and the image's `/healthz` healthcheck. Publishing is restricted to **`127.0.0.1:8790`** on the host; `HOST=0.0.0.0` inside the container is necessary and does not change that host binding. The proxy example assumes Caddy runs on the same host.

From the release root:

```sh
export DSH_HUB_PUBLIC_ORIGIN=https://hub.example.com
docker compose -f hub/deploy/compose.yaml config --quiet
docker compose -f hub/deploy/compose.yaml build
# First initialization only; no hub service should be running yet.
docker compose -f hub/deploy/compose.yaml run --rm --no-deps hub set-password
# Save the generated random password privately before continuing.
docker compose -f hub/deploy/compose.yaml up -d hub
docker compose -f hub/deploy/compose.yaml ps
curl --fail http://127.0.0.1:8790/healthz   # ok
```

Initialization prints a newly generated password once to your terminal. Do it locally in a private terminal, not in CI, shared logs or a recorded session. Store it in a password manager. Never commit it to configuration. Re-export the same `DSH_HUB_PUBLIC_ORIGIN` before later Compose commands in a new shell; the configuration intentionally refuses to run if it is missing. If you use a local environment file instead, protect its permissions and exclude it from version control.

New named volumes inherit `/data` ownership from the image. For an existing volume restored with wrong ownership, see [permissions](#data-and-permissions). Different installations must use different volume names; changing the Compose project or release directory alone does **not** isolate the explicitly named volume.

### Option B: plain Docker

Use this **instead of** Compose. From the release root:

```sh
export DSH_HUB_PUBLIC_ORIGIN=https://hub.example.com
docker build --tag dsh-hub-server:0.2.1 --file hub/Dockerfile hub
docker volume create dsh-hub-data
docker run --rm \
  --mount type=volume,source=dsh-hub-data,target=/data \
  dsh-hub-server:0.2.1 set-password
# Save the generated password privately, then start the service.
docker run --detach --name dsh-hub --init --restart unless-stopped \
  --publish 127.0.0.1:8790:8790 \
  --mount type=volume,source=dsh-hub-data,target=/data \
  --env DSH_HUB_PUBLIC_ORIGIN --env DSH_HUB_TRUST_PROXY=1 \
  --read-only --tmpfs /tmp:rw,noexec,nosuid,size=16m \
  --cap-drop ALL --security-opt no-new-privileges:true \
  dsh-hub-server:0.2.1
curl --fail http://127.0.0.1:8790/healthz
```

The image contains a healthcheck; inspect it with `docker inspect --format '{{.State.Health.Status}}' dsh-hub`. The container image is disposable; the named volume is not. Do not remove the volume during upgrades or cleanup.

### Option C: native Node.js with systemd

These commands assume a fresh Linux installation, release root as the current directory, and Node available at `/usr/bin/node`. If your system installs Node elsewhere, update both the commands and the unit's `ExecStart`. Keep code separate from writable state:

```sh
sudo useradd --system --user-group --home-dir /var/lib/dsh-hub \
  --shell /usr/sbin/nologin dsh-hub
sudo install -d -m 755 /opt/dsh-hub
sudo cp -a . /opt/dsh-hub/
sudo install -d -o dsh-hub -g dsh-hub -m 700 /var/lib/dsh-hub
cd /opt/dsh-hub/hub
sudo npm ci --omit=dev --ignore-scripts
# This guide's conservative procedure keeps the service stopped during initialization/rotation.
sudo -u dsh-hub env DSH_HUB_DATA=/var/lib/dsh-hub \
  /usr/bin/node /opt/dsh-hub/hub/server.mjs set-password
```

Save the generated password privately. Install and edit the existing [systemd unit](../hub/deploy/dsh-hub.service):

```sh
sudo cp deploy/dsh-hub.service /etc/systemd/system/dsh-hub.service
sudoedit /etc/systemd/system/dsh-hub.service
```

**Before starting it, explicitly set/verify the following directives in the installed unit**, replacing the existing values rather than appending a second `ExecStart`. The archive contains the `hub` subdirectory; do not point the entry file at `/opt/dsh-hub/server.mjs`. Replace the example domain with your actual HTTPS origin:

```ini
[Service]
User=dsh-hub
WorkingDirectory=/opt/dsh-hub/hub
ExecStart=/usr/bin/node /opt/dsh-hub/hub/server.mjs serve
Environment=DSH_HUB_DATA=/var/lib/dsh-hub
Environment=DSH_HUB_PUBLIC_ORIGIN=https://hub.example.com
ReadWritePaths=/var/lib/dsh-hub
```

Then start the installed service:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now dsh-hub
sudo systemctl status dsh-hub --no-pager
curl --fail http://127.0.0.1:8790/healthz
```

The supplied unit sets `HOST=127.0.0.1`, `PORT=8790`, `DSH_HUB_TRUST_PROXY=1` and restricts writes to `/var/lib/dsh-hub`. Code and dependencies must be readable by the service account; do not install under another user's private home. Run future `npm ci` in a new release directory during a maintenance window, not against a running installation.

### MCSManager reference

Keep the [MCSManager example](../hub/deploy/mcsm-instance.example.json) as a starting point, not a ready-made configuration for your host. Use MCSManager for managed-instance start/stop/restart, not competing `docker stop/restart` commands.

- It runs Node 22 with `runAs=1000:1000`, loopback-only port publishing, `/app` for code and `/data` for state. Install server dependencies in the code directory with `npm ci --omit=dev --ignore-scripts` using a compatible runtime before starting.
- Its sample `/opt/dsh-hub|/app` mount expects that host directory to contain the server entry file directly. If following the native layout above, use `/opt/dsh-hub/hub|/app` instead. Make the data bind mount writable by UID/GID 1000 with mode `0700`.
- Keep `workingDir=/workspace`: MCSManager automatically mounts its instance directory there. Using `/app` for that implicit mount as well can cause `Duplicate mount point`.
- Initialize the password while the managed instance is stopped, using the **same** code, runtime, user and data mount. For the native layout above, an administrator can run this one-shot command (not the managed service):

```sh
docker run --rm --user 1000:1000 \
  --mount type=bind,source=/opt/dsh-hub/hub,target=/app,readonly \
  --mount type=bind,source=/var/lib/dsh-hub,target=/data \
  --workdir /app --env DSH_HUB_DATA=/data \
  node:22-alpine node server.mjs set-password
```

Set the real public origin in the instance environment, then start it through MCSManager and check health. Adapt all sample paths to your own host; do not copy anyone else's cluster addresses or credentials.

## 3. DNS and HTTPS reverse proxy

1. Create the domain's DNS A record for your server's public address; publish AAAA only if IPv6 routing and firewall rules actually work.
2. Allow inbound 80/443 to Caddy for HTTP validation and HTTPS. Do **not** allow public access to 8790. Confirm that a container port is not published as `0.0.0.0:8790` or `[::]:8790`.
3. On the same host as the hub, use the [Caddy example](../hub/deploy/Caddyfile.example), replacing the domain:

```caddyfile
hub.example.com {
    reverse_proxy 127.0.0.1:8790
}
```

Caddy obtains TLS certificates, redirects HTTP to HTTPS, and supports WebSocket upgrades automatically. Do not strip `Origin`, disable upgrades, cache authenticated/tunneled content, or add a second path prefix: deploy the hub at the origin root. Caddy must supply/overwrite forwarding headers from the direct client; configure trusted upstream proxies explicitly if there is another proxy in front.

After validating your Caddy configuration with `caddy validate --config /etc/caddy/Caddyfile`, reload it using its existing service manager. Keep a backup before editing an existing proxy configuration. If Caddy is in a separate container, its `127.0.0.1` is **not** the host: use a private shared container network and correct upstream instead, without adding a public HTTP binding. If the proxy is on another host, use a protected private link with firewall restrictions (and TLS on an untrusted link); the supplied loopback-only example is deliberately same-host.

Verify from a different machine, using normal certificate validation:

```sh
curl --fail https://hub.example.com/healthz   # ok
```

Then open `https://hub.example.com`, sign in, and connect an agent. Do not use `curl -k` to hide a broken certificate. `/healthz` is unauthenticated process liveness only; it does not prove TLS, authentication or the DSH tunnel works.

## Environment variables

Set these on the **hub process/container**, not just in your interactive shell when using systemd/MCSManager.

| Variable | Default / meaning |
| --- | --- |
| `DSH_HUB_DATA` | `./data`, relative to process working directory. Use an absolute persistent path; image uses `/data`. Stores the sensitive hub state document. |
| `HOST` | Native default `127.0.0.1`; image uses `0.0.0.0` to accept the container's published port. Keep host publication loopback-only. |
| `PORT` | `8790`. If changed, update the mapping, proxy upstream and health probes together. |
| `DSH_HUB_PUBLIC_ORIGIN` | Exact browser origin, e.g. `https://hub.example.com`, with no path/query. Used for Origin checks and Secure cookies. Set it explicitly for production. |
| `DSH_HUB_TRUST_PROXY` | Only literal `1` enables trust of `X-Forwarded-For`. Enable behind your trusted proxy so clients do not share one login-limit bucket. The app does not enforce a trusted-proxy IP allow-list: prevent direct access and make the proxy sanitize this header. |
| `DSH_HUB_PASSWORD` | Used **only by `set-password`**, not a `serve` login setting. If absent, a random password is generated and printed. A supplied password must have at least 10 characters; use a much longer random one. Do not put plaintext secrets in command history, Compose files or repository files. |

Passing a new password to `serve`, or merely changing an environment file, does not rotate the persisted password. Use the stopped-service rotation procedure below.

## Data and permissions

The state document contains password/token hashes, backend registrations and a session-signing secret. A backup is sensitive even though agent token plaintext is not stored there. Keep the whole data directory, not only selected fields; never print its contents for diagnostics or place it under the public/static directory.

- The server creates a new data directory with mode `0700` and state files with `0600`; pre-existing directory ownership/mode still needs to be correct.
- Native: data directory owner must be the service account. For the example: `sudo chown -R dsh-hub:dsh-hub /var/lib/dsh-hub` and `sudo chmod 700 /var/lib/dsh-hub` (while stopped). Ensure state files are `0600`.
- Container bind mount: prepare it before first use with `sudo install -d -o 1000 -g 1000 -m 700 /var/lib/dsh-hub`, then mount at `/data`. Bind mounts do not inherit the image directory's ownership.
- An existing named volume can be repaired **while the hub is stopped** with a one-shot maintenance container:

```sh
docker run --rm --user 0:0 --entrypoint sh \
  --mount type=volume,source=dsh-hub-data,target=/data \
  dsh-hub-server:0.2.1 \
  -c 'chown -R node:node /data && chmod 700 /data && if [ -f /data/hub.json ]; then chmod 600 /data/hub.json; fi'
```

This temporary maintenance command uses root only to repair ownership; the normal server still runs as non-root. Avoid `chmod 777`, privileged mode, or running the service as root to mask a permissions error.

## Connect an agent

1. On **each DSH backend**, use its plugin/bundle installer with source **`github:Zec-Etch/dsh-hub#v0.2.1`**. You can also paste the Release tgz URL below, or download [dsh-hub-agent-0.2.1.tgz](https://github.com/Zec-Etch/dsh-hub/releases/download/v0.2.1/dsh-hub-agent-0.2.1.tgz) and install its absolute local path through DSH. The package name is `dsh-hub-agent`; the root bundle applies the [Cordis patch](https://github.com/Zec-Etch/dsh-hub/blob/v0.2.1/plugin/cordis.patch.yml). You do not need the server on each backend.

```text
https://github.com/Zec-Etch/dsh-hub/releases/download/v0.2.1/dsh-hub-agent-0.2.1.tgz
```

2. Sign in to the HTTPS hub and choose **Connect backend**. Give it a name and copy the JSON shown once. The token cannot be recovered later; revoke/recreate the backend entry if lost.
3. On the machine running DSH, as the **same OS account as DSH**, privately save the snippet to `$DSH_HOME/dsh-hub-agent.json`. With `DSH_HOME` unset, it defaults to that process user's `~/.dsh/dsh-hub-agent.json`. If DSH itself is in a container, this means its persistent DSH home inside that container/mount, not the host's unrelated home.

Example shape only — **not usable credentials**:

```json
{
  "hubUrl": "https://hub.example.com",
  "token": "<paste-the-once-shown-token-privately>",
  "harnessName": "Example backend"
}
```

For a POSIX DSH backend, create/edit it without putting token text into command history or printing it:

```sh
umask 077
agent_home="${DSH_HOME:-$HOME/.dsh}"
mkdir -p "$agent_home"
chmod 700 "$agent_home"
"${EDITOR:-vi}" "$agent_home/dsh-hub-agent.json"   # paste privately, save valid JSON
chmod 600 "$agent_home/dsh-hub-agent.json"
```

On Windows, use the DSH process's `DSH_HOME`, or its user profile's `.dsh` directory if unset; restrict the file ACL to that account (and trusted system administrators), rather than assuming `chmod` protects it. Never paste real credentials in a bug report, command output or screenshot.

Once loaded, the agent polls settings about every 5 seconds. It stays idle without a usable URL/token. Remote URLs must use `https` or `wss`; do not set `allowInsecure` in production. If you configured the same settings directly in the plugin configuration, those override the JSON; remove stale overrides. Tokens rejected as unknown/revoked (4401/4403) stop retrying until settings change. Ordinary network failures retry with backoff up to about a minute.

Confirm the backend becomes online, open its original DSH GUI, perform a harmless action and check its terminal connection. This end-to-end check also validates the WebSocket tunnel. No DSH inbound port forwarding is necessary.

## Operations

All examples below assume the original Compose volume name and a shell with the same `DSH_HUB_PUBLIC_ORIGIN` exported. Schedule maintenance: stopping the hub interrupts active browser tunnels, terminals and agent connections. Backend jobs may continue independently, but clients must reconnect; do not promise seamless sessions.

### Rotate the login password

For **v0.2.1**, this guide recommends a **conservative maintenance procedure**: stop the hub, run `set-password` with the same data directory/volume and service identity, then start it again. This is an operational recommendation, not a statement that password changes require a restart to take effect. The steps below consistently use this stopped-service workflow.

```sh
# Compose, from the release root:
docker compose -f hub/deploy/compose.yaml stop hub
docker compose -f hub/deploy/compose.yaml run --rm --no-deps hub set-password
docker compose -f hub/deploy/compose.yaml start hub
```

Plain Docker: `docker stop dsh-hub`, run the same initialization `docker run --rm --mount ... IMAGE set-password` against `dsh-hub-data`, then `docker start dsh-hub`. systemd: `sudo systemctl stop dsh-hub`, run the same `sudo -u dsh-hub env DSH_HUB_DATA=... /usr/bin/node server.mjs set-password` from the installed server directory, then `sudo systemctl start dsh-hub`. For MCSManager, stop/start through the panel and use the matching one-shot initialization while stopped.

Save the new password privately. After restart the old password and all old browser sessions are invalid. Agent tokens remain valid; if an agent token leaked, revoke its backend entry in the picker, create a replacement and update its private JSON instead. If the hub host itself was compromised, recover on a trusted host and replace credentials; password rotation alone is not remediation.

### Back up

Stop the only writer before taking a consistent backup. Keep the code version, non-secret deployment configuration and origin alongside an **encrypted/private** copy of the whole data directory. Never commit state or backups.

Compose example, writing binary tar output in a POSIX shell:

```sh
umask 077
mkdir -p backups
backup="backups/dsh-hub-data-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
docker compose -f hub/deploy/compose.yaml stop hub
docker run --rm --entrypoint tar \
  --mount type=volume,source=dsh-hub-data,target=/data,readonly \
  dsh-hub-server:0.2.1 -czf - -C /data . > "$backup"
tar -tzf "$backup" >/dev/null   # verify success before proceeding
docker compose -f hub/deploy/compose.yaml start hub
```

If either archive command fails, investigate before calling the backup valid. Native equivalent: stop the service, use `umask 077; sudo tar -czf - -C /var/lib/dsh-hub . > "$backup"`, verify it, then restart. Plain Docker and MCSManager follow the same stop/archive/start sequence using their own lifecycle manager. Copy backups off-host securely and test restoration periodically; do not print their contents.

### Upgrade and roll back

1. Record the current version, environment, mounts and origin. Take and verify a stopped-service backup.
2. Keep the old release/image and backup. Download/extract the **new tagged release into a new directory**; do not overwrite live code or remove volumes. Read its migration/compatibility notes and upgrade agents if required.
3. For Compose, with the old service stopped, run the old directory's `docker compose -f hub/deploy/compose.yaml down` **without `--volumes`/`-v`**. In the new release root, build its image, re-export the origin and reuse the same named data volume, then `up -d hub`. **Do not run `set-password` again** for a normal upgrade. The explicit volume name survives project-directory changes; do not leave the old service enabled to start a second writer.
4. For native/systemd or MCSManager, stop through its manager, install dependencies with `npm ci --omit=dev --ignore-scripts` in the new server directory, point the manager to that code and the existing data, then start. Keep ownership and hardened settings intact.
5. Verify local and public `/healthz`, certificate validity, login, roster, GUI and terminal through one agent. A green liveness probe alone is insufficient.
6. If upgrade validation fails, stop the new service first. Start the retained old version against data only if it is backward compatible; otherwise restore the matching pre-upgrade backup into a clean replacement volume/directory first. Never let old and new versions write the same data simultaneously.

### Restore

Stop the service and preserve the current data for investigation. Restore into a **new, empty** volume instead of merging a backup over live state:

```sh
# Set backup to the private verified archive path from your backup procedure.
docker compose -f hub/deploy/compose.yaml stop hub
docker volume create dsh-hub-data-restored
docker run --rm --interactive --user 0:0 --entrypoint sh \
  --mount type=volume,source=dsh-hub-data-restored,target=/data \
  dsh-hub-server:0.2.1 \
  -c 'tar -xzf - -C /data && chown -R node:node /data && chmod 700 /data && chmod 600 /data/hub.json' \
  < "$backup"
```

Use a fresh replacement volume name for every restore attempt. Only continue if extraction succeeds. Change the volume `name` in your local [Compose configuration](../hub/deploy/compose.yaml) to `dsh-hub-data-restored`, then run `docker compose -f hub/deploy/compose.yaml up -d --force-recreate hub` using the release matching that backup. Keep the old volume until recovery is verified. For plain Docker, recreate the stopped container with the replacement volume and the same settings.

Native/systemd: extract into an empty replacement directory, restore ownership to `dsh-hub`, directory mode `0700` and state-file mode `0600`; update **both** `DSH_HUB_DATA` and the unit's `ReadWritePaths`, reload the unit and start. MCSManager: update its data mount while stopped, then start through the panel.

Restoring old state also restores old password/session/token registrations. Rotate the password after recovery if needed (stop → set-password → start); recheck revoked tokens because a backup predating revocation can bring them back. If the entire data directory is lost, there is no token recovery: initialize a new hub and re-enroll every backend.

## Failure diagnosis

Inspect logs locally with `docker compose -f hub/deploy/compose.yaml logs --tail=100 hub`, `docker logs --tail=100 dsh-hub`, `journalctl -u dsh-hub -n 100 --no-pager`, or the MCSManager console. Redact hostnames, paths and other sensitive metadata before sharing; never dump environment files, state documents, cookies or agent JSON.

| Symptom | Check / action |
| --- | --- |
| `no password set` / restart loop | Initialize with `set-password` while stopped. Ensure initialization and service use the exact same data volume/path. Do not keep retrying startup against an empty directory. |
| `EACCES`, read-only filesystem, or lost registrations after recreation | Check UID/GID 1000 (container) or service user (native), directory `0700`, persistent `/data` mount and free space. Code may be read-only, data must not be. Never fix with `chmod 777`. |
| Local `/healthz` fails | Check process/container logs, port conflicts, `HOST`, `PORT` and mapping. Inside Docker, binding `127.0.0.1` instead of `0.0.0.0` prevents host-published access. |
| Local health works; HTTPS fails or proxy returns 502 | Check DNS A/AAAA, firewall 80/443, certificates, Caddy upstream and proxy location. Container loopback is not host loopback. Do not expose 8790 as a workaround. |
| Login/write/roster returns 403 `origin` | Match the browser's exact scheme/host/port with `DSH_HUB_PUBLIC_ORIGIN`; use the origin root, preserve `Origin`, and restart after changing environment. |
| Login 401 after setting an environment variable | `serve` does not consume `DSH_HUB_PASSWORD` as a password change. Follow the stopped-service `set-password` procedure against the real data path. |
| Login 429 / unrelated users all limited | Login failures are limited per client for about 10 minutes. Wait, check the password and trusted forwarding-header configuration; do not bypass TLS or rate limiting. |
| Agent stays idle/offline | Check bundle enabled, Node >=22, correct DSH user's `DSH_HOME`, private valid JSON, URL/token and stale plugin-config overrides. Check outbound DNS/TLS/WSS and agent logs without printing credentials. |
| Agent rejected 4401/4403 | Token unknown/revoked. Re-enroll if needed and change the settings file; simply waiting/restarting the hub does not make that token valid. |
| Agent 4426 / repeated disconnects | Upgrade the agent/server to a compatible protocol pair. 4409 can mean two agents share a token: issue one token per backend. |
| Roster works but terminal/GUI breaks | Confirm proxy supports long-lived WebSocket upgrades for `/ws/*` and `/h/*` without caching, stripping headers or short idle timeouts; check the backend DSH web server and agent logs. |
| Old phone/PWA assets after upgrade | Reload the page/reopen the PWA after verifying the server version. Backend content/API responses are not intended to be cached by a proxy. See [mobile notes](mobile-shell.md). |

Do not attach real credentials or private cluster details to public issues. Describe versions, deployment mode, redacted configuration, which health checks pass, and the failing step instead.
