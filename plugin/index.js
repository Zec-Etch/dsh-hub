// Host half: one outbound WebSocket to the hub carrying a byte tunnel to this Host's
// Web server. Holds no state of its own beyond the local browser session.
import { readFileSync } from 'node:fs';
import { homedir, hostname, platform } from 'node:os';
import { join } from 'node:path';
import { Mux } from './mux.js';
import { createTunnel } from './tunnel.js';

export const name = 'dsh-hub-agent';
export const inject = ['connection', 'webServer'];

const MIN_RETRY_MS = 1_000;
const MAX_RETRY_MS = 60_000;
const SETTINGS_POLL_MS = 5_000;
const STATUS_MS = 15_000;
const PROTOCOL = 2;
const VERSION = '0.2.1';

const settingsPath = () => join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'dsh-hub-agent.json');

/** The agent's own settings file; absent or malformed means stay idle. */
function readSettings() {
  try { return readFileSync(settingsPath(), 'utf8'); } catch { return ''; }
}

function resolveConfig(config, text) {
  let file = {};
  try { file = text ? JSON.parse(text) : {}; } catch { file = {}; }
  const raw = { ...file, ...config };
  return {
    hubUrl: String(raw.hubUrl ?? process.env.DSH_HUB_URL ?? '').trim(),
    token: String(raw.token ?? process.env.DSH_HUB_TOKEN ?? '').trim(),
    harnessName: String(raw.harnessName ?? '').trim() || hostname(),
    allowInsecure: raw.allowInsecure === true,
  };
}

function isLoopback(url) {
  return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname);
}

export function apply(ctx, config) {
  const log = typeof ctx.logger === 'function' ? ctx.logger('dsh-hub-agent') : console;
  let text = readSettings();
  let stop = start(ctx, resolveConfig(config, text), log);
  // Token changes apply without restarting DSH.
  const poll = setInterval(() => {
    const next = readSettings();
    if (next === text) return;
    text = next;
    void Promise.resolve(stop?.()).then(() => { stop = start(ctx, resolveConfig(config, text), log); });
  }, SETTINGS_POLL_MS);
  ctx.effect(() => () => {
    clearInterval(poll);
    return stop?.();
  }, 'dsh-hub-agent: settings watcher');
}

/** Exchange the Host's launch token for the signed browser cookie it mints. */
async function signIn(ctx, origin) {
  const response = await fetch(ctx.connection.authenticatedUrl(origin), { redirect: 'manual' });
  const cookies = response.headers.getSetCookie().map((line) => line.split(';')[0]);
  if (cookies.length === 0) throw new Error(`no session cookie (status ${response.status})`);
  return cookies.join('; ');
}

function start(ctx, options, log) {
  if (!options.hubUrl || !options.token) {
    log.info?.('dsh-hub-agent idle: no hubUrl/token in dsh-hub-agent.json');
    return undefined;
  }
  let url;
  try {
    url = new URL('/ws/harness', options.hubUrl.replace(/^http/, 'ws'));
  } catch {
    log.error?.('dsh-hub-agent: hubUrl is not a valid URL');
    return undefined;
  }
  if (url.protocol !== 'wss:' && !isLoopback(url) && !options.allowInsecure) {
    log.error?.('dsh-hub-agent refuses an unencrypted hub connection; use https/wss');
    return undefined;
  }
  if (typeof globalThis.WebSocket !== 'function') {
    log.error?.('dsh-hub-agent needs a runtime with a global WebSocket (Node 22+)');
    return undefined;
  }

  return ctx.effect(() => {
    const origin = () => `${ctx.webServer.getOrigin().replace(/\/$/, '')}/`;
    const tunnel = createTunnel({ origin, signIn: () => signIn(ctx, origin()), log });
    let socket;
    let mux;
    let stopped = false;
    let attempt = 0;
    let retry;
    let statusTimer;

    const publishStatus = async (current) => {
      try {
        const items = (await tunnel.remote('session/list', { _request: {} }))?.items ?? [];
        if (current.readyState !== WebSocket.OPEN) return;
        current.send(JSON.stringify({ t: 'status', status: {
          sessions: items.filter((item) => !item.parentSessionId).length,
          running: items.filter((item) => item.running).length,
        } }));
      } catch (error) {
        log.debug?.('dsh-hub-agent: status failed', error?.message);
      }
    };

    const connect = () => {
      if (stopped) return;
      socket = new WebSocket(url.href);
      socket.binaryType = 'arraybuffer';
      const current = socket;
      current.addEventListener('open', () => {
        current.send(JSON.stringify({
          t: 'hello', v: PROTOCOL, token: options.token,
          harness: { name: options.harnessName, host: hostname(), platform: platform(), dshVersion: process.env.DSH_VERSION ?? null, pluginVersion: VERSION },
        }));
      });
      current.addEventListener('message', (event) => {
        if (typeof event.data !== 'string') { mux?.binary(Buffer.from(event.data)); return; }
        let frame;
        try { frame = JSON.parse(event.data); } catch { return; }
        if (frame.t === 'welcome') {
          attempt = 0;
          mux = new Mux({
            sendJson: (message) => { if (current.readyState === WebSocket.OPEN) current.send(JSON.stringify(message)); },
            sendBinary: (bytes) => { if (current.readyState === WebSocket.OPEN) current.send(bytes); },
            accept: (channel, request) => tunnel.accept(channel, request),
          });
          log.info?.('dsh-hub-agent connected');
          void publishStatus(current);
          clearInterval(statusTimer);
          statusTimer = setInterval(() => void publishStatus(current), STATUS_MS);
        } else {
          mux?.json(frame);
        }
      });
      current.addEventListener('close', (event) => {
        clearInterval(statusTimer);
        mux?.closeAll();
        mux = undefined;
        if (stopped) return;
        // A revoked or unknown token cannot succeed by retrying.
        if (event.code === 4401 || event.code === 4403) {
          log.error?.(`dsh-hub-agent rejected by hub (${event.code}); check the token`);
          return;
        }
        attempt += 1;
        const ceiling = Math.min(MAX_RETRY_MS, MIN_RETRY_MS * 2 ** Math.min(attempt, 6));
        retry = setTimeout(connect, ceiling * (0.5 + Math.random() / 2));
      });
      current.addEventListener('error', () => undefined);
    };
    connect();

    return () => {
      stopped = true;
      clearTimeout(retry);
      clearInterval(statusTimer);
      socket?.close();
      mux?.closeAll();
    };
  }, 'dsh-hub-agent: hub connection');
}
