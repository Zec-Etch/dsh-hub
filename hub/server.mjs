#!/usr/bin/env node
// dsh-hub: always-on relay. DSH plugins dial in over WSS; browsers log in, pick a
// harness, and reach that harness's own Web GUI under /h/<id>/ through a byte tunnel.
// The hub adds only the PWA and mobile shell, so it stays version-agnostic.
import { createServer } from 'node:http';
import { createHash, createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { Mux } from './mux.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_DIR = join(HERE, 'public');
const COOKIE = 'dsh_hub_session';
const SESSION_MS = 30 * 24 * 3600 * 1000;
const MAX_FRAME = 32 * 1024 * 1024;
const PROTOCOL = 2;
const MAX_INDEX_BYTES = 8 * 1024 * 1024;
const HEARTBEAT_MS = 20_000;
const HELLO_TIMEOUT_MS = 8_000;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
};
/** Never crosses the tunnel: the hub session ends here, and hop-by-hop headers are per-link. */
const REQUEST_DROP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'cookie']);
const RESPONSE_DROP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'set-cookie']);
const PROXY_HEADERS = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'SAMEORIGIN' };
const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
};

export function hashPassword(password) {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  const [kind, salt, key] = String(stored ?? '').split('$');
  if (kind !== 'scrypt' || !salt || !key) return false;
  const expected = Buffer.from(key, 'base64');
  const actual = scryptSync(password, Buffer.from(salt, 'base64'), expected.length, { N: 2 ** 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
  return timingSafeEqual(actual, expected);
}

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

/** JSON document persisted atomically; only hashes of secrets are ever stored. */
export class Store {
  constructor(dir) {
    this.file = join(dir, 'hub.json');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.data = existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : {};
    this.data.harnesses ??= [];
    this.data.sessionSecret ??= randomBytes(32).toString('base64');
    this.data.sessionEpoch ??= 1;
    this.save();
  }

  /**
   * `set-password` runs as a separate process while the service stays up, so the password
   * hash and session epoch on disk always win over this process's copy. Only those two
   * fields are taken: live connections hold references to the harness records.
   */
  syncAuth() {
    let stamp;
    try { stamp = statSync(this.file).mtimeMs; } catch { return; }
    if (stamp === this.stamp) return;
    this.stamp = stamp;
    const disk = JSON.parse(readFileSync(this.file, 'utf8'));
    this.data.passwordHash = disk.passwordHash;
    this.data.sessionEpoch = disk.sessionEpoch;
  }

  /** `ownAuth` is only for the command that changes the password itself. */
  save({ ownAuth = false } = {}) {
    if (!ownAuth) this.syncAuth();
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
    this.stamp = statSync(this.file).mtimeMs;
  }

  mint(name) {
    const token = `dshh_${randomBytes(32).toString('base64url')}`;
    const record = { id: randomUUID(), name: String(name).slice(0, 80), tokenHash: sha256(token), createdAt: Date.now(), lastSeen: null };
    this.data.harnesses.push(record);
    this.save();
    return { record, token };
  }

  byToken(token) {
    const hash = sha256(String(token));
    return this.data.harnesses.find((row) => safeEqual(row.tokenHash, hash));
  }

  byId(id) { return this.data.harnesses.find((row) => row.id === id); }

  remove(id) {
    const before = this.data.harnesses.length;
    this.data.harnesses = this.data.harnesses.filter((row) => row.id !== id);
    if (this.data.harnesses.length !== before) this.save();
    return this.data.harnesses.length !== before;
  }
}

/** Sliding failure window per client address; successful logins clear it. */
class LoginLimiter {
  constructor(limit = 8, windowMs = 10 * 60_000) { this.limit = limit; this.windowMs = windowMs; this.rows = new Map(); }
  blocked(key) {
    const row = this.rows.get(key);
    if (row && Date.now() - row.first > this.windowMs) { this.rows.delete(key); return false; }
    return (row?.count ?? 0) >= this.limit;
  }
  fail(key) {
    const row = this.rows.get(key) ?? { first: Date.now(), count: 0 };
    row.count += 1;
    this.rows.set(key, row);
    if (this.rows.size > 10_000) this.rows.delete(this.rows.keys().next().value);
  }
  clear(key) { this.rows.delete(key); }
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at > 0) out[part.slice(0, at).trim()] = part.slice(at + 1).trim();
  }
  return out;
}

async function readJson(req, limit = 64 * 1024) {
  const media = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (media !== 'application/json') throw Object.assign(new Error('content type'), { status: 415 });
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('too large'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw Object.assign(new Error('bad json'), { status: 400 }); }
}

function json(res, status, body, headers = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...SECURITY_HEADERS, ...headers });
  res.end(text);
}

export function createHub({ store, publicOrigin = '', trustProxy = false, log = console } = {}) {
  const limiter = new LoginLimiter();
  /** harness id -> live record */
  const live = new Map();
  const watchers = new Set();
  const nextConn = (() => { let n = 0; return () => `c${(n += 1).toString(36)}`; })();

  const clientIp = (req) => {
    if (trustProxy) {
      const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
      if (forwarded) return forwarded;
    }
    return req.socket.remoteAddress ?? 'unknown';
  };

  const isHttps = (req) => (publicOrigin ? publicOrigin.startsWith('https:') : trustProxy && req.headers['x-forwarded-proto'] === 'https');

  function signSession(expires) {
    const body = `${store.data.sessionEpoch}.${expires}.${randomBytes(9).toString('base64url')}`;
    return `${body}.${createHmac('sha256', store.data.sessionSecret).update(body).digest('base64url')}`;
  }

  function authed(req) {
    store.syncAuth();
    const value = parseCookies(req.headers.cookie)[COOKIE];
    if (!value) return false;
    const at = value.lastIndexOf('.');
    if (at < 0) return false;
    const body = value.slice(0, at);
    if (!safeEqual(createHmac('sha256', store.data.sessionSecret).update(body).digest('base64url'), value.slice(at + 1))) return false;
    const [epoch, expires] = body.split('.');
    return Number(epoch) === store.data.sessionEpoch && Number(expires) > Date.now();
  }

  /** Browser requests must stay same-origin; this blocks cross-site WebSocket hijacking. */
  function sameOrigin(req) {
    const origin = req.headers.origin;
    if (origin === undefined) return false;
    if (publicOrigin) return origin === publicOrigin;
    try { return new URL(origin).host === req.headers.host; } catch { return false; }
  }

  function view(record) {
    const row = live.get(record.id);
    return {
      id: record.id, name: row?.info.name || record.name, createdAt: record.createdAt,
      lastSeen: row ? Date.now() : record.lastSeen, online: Boolean(row),
      host: row?.info.host ?? record.host ?? null, platform: row?.info.platform ?? record.platform ?? null,
      dshVersion: row?.info.dshVersion ?? null, pluginVersion: row?.info.pluginVersion ?? null,
      status: row?.status ?? null,
    };
  }

  const roster = () => store.data.harnesses.map(view);

  function broadcast() {
    const text = JSON.stringify({ t: 'roster', harnesses: roster() });
    for (const socket of watchers) if (socket.readyState === WebSocket.OPEN) socket.send(text);
  }

  async function api(req, res, url) {
    if (url.pathname === '/api/login' && req.method === 'POST') {
      if (!sameOrigin(req)) return json(res, 403, { error: 'origin' });
      store.syncAuth();
      const ip = clientIp(req);
      if (limiter.blocked(ip)) return json(res, 429, { error: 'rate-limited' });
      const { password } = await readJson(req);
      if (typeof password !== 'string' || !store.data.passwordHash || !verifyPassword(password, store.data.passwordHash)) {
        limiter.fail(ip);
        return json(res, 401, { error: 'invalid-password' });
      }
      limiter.clear(ip);
      const expires = Date.now() + SESSION_MS;
      const cookie = `${COOKIE}=${signSession(expires)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MS / 1000}${isHttps(req) ? '; Secure' : ''}`;
      return json(res, 200, { ok: true }, { 'set-cookie': cookie });
    }
    if (!authed(req)) return json(res, 401, { error: 'unauthenticated' });
    if (url.pathname === '/api/me' && req.method === 'GET') return json(res, 200, { ok: true });
    if (req.method !== 'GET' && !sameOrigin(req)) return json(res, 403, { error: 'origin' });
    if (url.pathname === '/api/logout' && req.method === 'POST') {
      return json(res, 200, { ok: true }, { 'set-cookie': `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${isHttps(req) ? '; Secure' : ''}` });
    }
    if (url.pathname === '/api/harnesses') {
      if (req.method === 'GET') return json(res, 200, { harnesses: roster() });
      if (req.method === 'POST') {
        const { name } = await readJson(req);
        if (typeof name !== 'string' || !name.trim()) return json(res, 400, { error: 'name' });
        const { record, token } = store.mint(name.trim());
        broadcast();
        return json(res, 201, { harness: view(record), token });
      }
    }
    const match = /^\/api\/harnesses\/([\w-]+)$/.exec(url.pathname);
    if (match && req.method === 'DELETE') {
      const row = live.get(match[1]);
      const removed = store.remove(match[1]);
      row?.socket.close(4403, 'revoked');
      broadcast();
      return json(res, removed ? 200 : 404, { ok: removed });
    }
    return json(res, 404, { error: 'not-found' });
  }

  function headerPairs(req, drop) {
    const out = [];
    for (let at = 0; at < req.rawHeaders.length; at += 2) {
      if (!drop(req.rawHeaders[at].toLowerCase())) out.push([req.rawHeaders[at], req.rawHeaders[at + 1]]);
    }
    return out;
  }

  function responseHeaders(pairs, cacheable) {
    const out = {};
    for (const [name, value] of pairs) {
      if (RESPONSE_DROP.has(name.toLowerCase())) continue;
      const key = name.toLowerCase();
      out[key] = out[key] === undefined ? value : `${out[key]}, ${value}`;
    }
    // Content-hashed bundles: DSH sends no validators, and each reload crosses the backend's uplink.
    if (cacheable) out['cache-control'] = 'private, max-age=31536000, immutable';
    return { ...PROXY_HEADERS, ...out };
  }

  /** Adds the PWA and mobile shell around a Host's index document. */
  function shellIndex(html, id) {
    const record = store.byId(id);
    const boot = JSON.stringify({ id, name: live.get(id)?.info.name || record?.name || '' }).replace(/</g, '\\u003c');
    const head = [
      '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">',
      '<meta name="mobile-web-app-capable" content="yes">',
      '<meta name="apple-mobile-web-app-capable" content="yes">',
      '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">',
      '<meta name="apple-mobile-web-app-title" content="DSH">',
      '<link rel="apple-touch-icon" href="/icons/icon-180.png">',
      '<link rel="manifest" href="/manifest.webmanifest">',
      `<script>window.__DSH_HUB__=${boot}</script>`,
      '<script src="/shell/boot.js"></script>',
    ].join('');
    return html
      .replace(/<meta\s+name=["']viewport["'][^>]*>/i, '')
      .replace(/<link\s+rel=["']manifest["'][^>]*>/i, '')
      .replace(/<head(\s[^>]*)?>(\s*<base[^>]*>)?/i, (open) => `${open}${head}`)
      .replace(/<\/head>/i, '<link rel="stylesheet" href="/shell/mobile.css"></head>');
  }

  function bufferIndex(res, status, headers, id) {
    const chunks = [];
    let size = 0;
    return new Writable({
      write(chunk, _encoding, done) {
        size += chunk.length;
        if (size > MAX_INDEX_BYTES) return done(new Error('index too large'));
        chunks.push(chunk);
        return done();
      },
      final(done) {
        const body = Buffer.from(shellIndex(Buffer.concat(chunks).toString('utf8'), id));
        const { 'content-length': _length, etag: _etag, ...rest } = headers;
        res.writeHead(status, { ...rest, 'cache-control': 'no-store', 'content-length': body.length });
        res.end(body);
        done();
      },
    }).on('error', () => res.destroy());
  }

  function proxy(req, res, url, id, rest) {
    const navigating = String(req.headers['sec-fetch-mode'] ?? '') === 'navigate' || String(req.headers.accept ?? '').includes('text/html');
    const redirect = (location) => { res.writeHead(302, { location, 'cache-control': 'no-store', ...PROXY_HEADERS }); res.end(); };
    if (!authed(req)) {
      if (navigating) return redirect(`/?next=${encodeURIComponent(`/h/${id}/`)}`);
      return json(res, 401, { error: 'unauthenticated' });
    }
    const safe = req.method === 'GET' || req.method === 'HEAD';
    if (!safe && !sameOrigin(req)) return json(res, 403, { error: 'origin' });
    if (!rest) { res.writeHead(308, { location: `/h/${id}/${url.search}`, ...PROXY_HEADERS }); return res.end(); }
    const row = live.get(id);
    if (!row) return navigating ? redirect(`/?offline=${encodeURIComponent(id)}`) : json(res, 502, { error: 'harness-offline' });

    const index = req.method === 'GET' && (rest === '/' || rest === '/index.html');
    const channel = row.mux.create();
    channel.onClose = () => {
      if (res.headersSent) res.destroy();
      else json(res, 502, { error: 'harness-unavailable' });
    };
    res.on('close', () => { if (!res.writableFinished) channel.abort(); });
    channel.onHead = ({ status, headers }) => {
      const out = responseHeaders(headers, status === 200 && (rest.startsWith('/assets/') || (rest.startsWith('/plugins/') && url.searchParams.has('rev'))));
      const html = String(out['content-type'] ?? '').startsWith('text/html');
      if (index && status === 200 && html && !out['content-encoding']) {
        channel.pipeTo(bufferIndex(res, status, out, id));
        return;
      }
      res.writeHead(status, out);
      channel.pipeTo(res);
    };
    channel.control({
      t: 'req', method: req.method, path: `${rest}${url.search}`, origin: req.headers.origin !== undefined,
      headers: headerPairs(req, (key) => REQUEST_DROP.has(key) || (index && (key === 'accept-encoding' || key.startsWith('if-')))),
    });
    void channel.pipeFrom(req);
    return undefined;
  }

  function tunnelUpgrade(req, socket, head, id, path, reject) {
    const row = live.get(id);
    if (!row) return reject(502);
    socket.setKeepAlive(true, HEARTBEAT_MS);
    const channel = row.mux.create();
    channel.onClose = () => socket.destroy();
    socket.on('error', () => channel.abort());
    socket.on('close', () => channel.abort());
    channel.onHead = ({ status, headers }) => {
      const lines = headers.filter(([name]) => name.toLowerCase() !== 'set-cookie').map(([name, value]) => `${name}: ${value}`);
      socket.write(`HTTP/1.1 ${status} ${status === 101 ? 'Switching Protocols' : 'Rejected'}\r\n${lines.join('\r\n')}\r\n\r\n`);
      if (status !== 101) { socket.end(); channel.abort(); return; }
      if (head.length) void channel.write(head);
      channel.pipeTo(socket);
      void channel.pipeFrom(socket);
    };
    channel.control({
      t: 'req', method: 'GET', path, origin: true, upgrade: true,
      headers: headerPairs(req, (key) => key === 'cookie'),
    });
    return undefined;
  }

  function serveStatic(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, SECURITY_HEADERS); return res.end(); }
    let path;
    try { path = normalize(decodeURIComponent(url.pathname)); } catch { res.writeHead(400, SECURITY_HEADERS); return res.end(); }
    let file = resolve(PUBLIC_DIR, `.${sep}${path}`);
    if (!file.startsWith(PUBLIC_DIR + sep) && file !== PUBLIC_DIR) { res.writeHead(403, SECURITY_HEADERS); return res.end(); }
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(PUBLIC_DIR, 'index.html');
    const type = MIME[extname(file)] ?? 'application/octet-stream';
    res.writeHead(200, { 'content-type': type, 'cache-control': extname(file) === '.html' || file.endsWith('sw.js') ? 'no-cache' : 'public, max-age=300', ...SECURITY_HEADERS });
    if (req.method === 'HEAD') return res.end();
    return createReadStream(file).pipe(res);
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://hub.invalid');
    if (url.pathname === '/healthz') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('ok\n'); }
    const tunneled = /^\/h\/([\w-]+)(\/.*)?$/.exec(url.pathname);
    if (tunneled) return proxy(req, res, url, tunneled[1], tunneled[2]);
    if (url.pathname.startsWith('/api/')) {
      return api(req, res, url).catch((error) => {
        if (!res.headersSent) json(res, error.status ?? 500, { error: error.status ? error.message : 'internal' });
        else res.destroy();
        if (!error.status) log.error('[hub] api failure', error);
      });
    }
    return serveStatic(req, res, url);
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME, perMessageDeflate: false });

  function heartbeat(socket) {
    socket.alive = true;
    socket.on('pong', () => { socket.alive = true; });
  }
  const pulse = setInterval(() => {
    for (const socket of wss.clients) {
      if (!socket.alive) { socket.terminate(); continue; }
      socket.alive = false;
      socket.ping();
    }
  }, HEARTBEAT_MS);
  pulse.unref?.();

  function attachHarness(socket) {
    heartbeat(socket);
    const timer = setTimeout(() => socket.close(4401, 'hello timeout'), HELLO_TIMEOUT_MS);
    let record;
    socket.on('message', (data, isBinary) => {
      if (isBinary) { live.get(record?.id)?.mux.binary(data); return undefined; }
      let frame;
      try { frame = JSON.parse(data.toString()); } catch { return socket.close(4400, 'bad frame'); }
      if (!record) {
        clearTimeout(timer);
        record = frame.t === 'hello' ? store.byToken(frame.token) : undefined;
        if (!record) return socket.close(4401, 'unauthorized');
        // An older agent keeps retrying with backoff until it is upgraded.
        if (frame.v !== PROTOCOL) { record = undefined; return socket.close(4426, 'upgrade dsh-hub-agent'); }
        live.get(record.id)?.socket.close(4409, 'replaced');
        const info = frame.harness ?? {};
        const mux = new Mux({
          sendJson: (message) => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message)); },
          sendBinary: (bytes) => { if (socket.readyState === WebSocket.OPEN) socket.send(bytes, { binary: true }); },
        });
        live.set(record.id, { socket, info, status: null, mux });
        record.lastSeen = Date.now();
        record.host = String(info.host ?? '').slice(0, 120);
        record.platform = String(info.platform ?? '').slice(0, 40);
        store.save();
        socket.send(JSON.stringify({ t: 'welcome', id: record.id }));
        log.info(`[hub] harness online: ${record.name}`);
        return broadcast();
      }
      const row = live.get(record.id);
      if (row?.socket !== socket) return undefined;
      if (frame.t === 'status') { row.status = frame.status ?? null; return broadcast(); }
      row.mux.json(frame);
      return undefined;
    });
    socket.on('close', () => {
      clearTimeout(timer);
      const row = record && live.get(record.id);
      if (row?.socket === socket) {
        live.delete(record.id);
        record.lastSeen = Date.now();
        store.save();
        row.mux.closeAll();
        log.info(`[hub] harness offline: ${record.name}`);
        broadcast();
      }
    });
    socket.on('error', () => undefined);
  }

  function attachWatcher(socket) {
    heartbeat(socket);
    watchers.add(socket);
    socket.send(JSON.stringify({ t: 'roster', harnesses: roster() }));
    socket.on('close', () => watchers.delete(socket));
    socket.on('error', () => undefined);
  }

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://hub.invalid');
    const reject = (code) => { socket.end(`HTTP/1.1 ${code} Rejected\r\nConnection: close\r\n\r\n`); };
    const accept = (attach) => wss.handleUpgrade(req, socket, head, attach);
    // Harnesses authenticate with their first frame so tokens never enter URLs or access logs.
    if (url.pathname === '/ws/harness') return accept(attachHarness);
    if (!sameOrigin(req)) return reject(403);
    if (!authed(req)) return reject(401);
    if (url.pathname === '/ws/roster') return accept(attachWatcher);
    const tunneled = /^\/h\/([\w-]+)(\/.*)$/.exec(url.pathname);
    if (tunneled) return tunnelUpgrade(req, socket, head, tunneled[1], `${tunneled[2]}${url.search}`, reject);
    return reject(404);
  });

  return { server, close: async () => {
    clearInterval(pulse);
    for (const socket of wss.clients) socket.terminate();
    await new Promise((done) => { wss.close(() => server.close(done)); });
  } };
}

function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 ? process.argv[at + 1] : fallback;
}

async function main() {
  const command = process.argv[2] ?? 'serve';
  const dataDir = resolve(arg('data', process.env.DSH_HUB_DATA ?? './data'));
  const store = new Store(dataDir);
  if (command === 'set-password') {
    const password = process.env.DSH_HUB_PASSWORD ?? randomBytes(15).toString('base64url');
    if (password.length < 10) throw new Error('password must have at least 10 characters');
    store.data.passwordHash = hashPassword(password);
    store.data.sessionEpoch += 1; // Every existing login ends with the old password.
    store.save({ ownAuth: true });
    console.log(process.env.DSH_HUB_PASSWORD ? 'password updated' : `generated password: ${password}`);
    return;
  }
  if (command !== 'serve') { console.error('usage: server.mjs [serve|set-password] [--data DIR] [--port N] [--host H]'); process.exit(2); }
  if (!store.data.passwordHash) { console.error('no password set: run "server.mjs set-password" first'); process.exit(1); }
  const port = Number(arg('port', process.env.PORT ?? 8790));
  const host = arg('host', process.env.HOST ?? '127.0.0.1');
  const hub = createHub({ store, publicOrigin: (process.env.DSH_HUB_PUBLIC_ORIGIN ?? '').replace(/\/$/, ''), trustProxy: process.env.DSH_HUB_TRUST_PROXY === '1' });
  hub.server.listen(port, host, () => console.log(`[hub] listening on http://${host}:${port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => hub.close().then(() => process.exit(0)));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
