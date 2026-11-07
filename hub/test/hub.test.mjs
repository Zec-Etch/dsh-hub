// End-to-end tests: real hub, real agent tunnel and mux, stub DSH Web server, real sockets.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { Script } from 'node:vm';
import { WebSocket, WebSocketServer } from 'ws';
import { createHub, hashPassword, Store } from '../server.mjs';
import { Mux } from '../mux.mjs';
import { createTunnel } from '../../plugin/tunnel.js';

const PASSWORD = 'correct horse battery';
const LOCAL_COOKIE = 'dsh=local-session';
let dir; let hub; let base; let store; let cookie;
const quiet = { info() {}, error() {}, warn() {} };
const sockets = [];

/** Stands in for DSH: enforces its cookie and Host/Origin fence like the real listener. */
async function stubHost() {
  const seen = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      seen.push({ method: req.method, url: req.url, headers: req.headers, size: body.length });
      if (req.headers.cookie !== LOCAL_COOKIE) { res.writeHead(401); return res.end(); }
      if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) { res.writeHead(403); return res.end(); }
      if (req.url === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'set-cookie': 'leak=1' });
        return res.end('<!doctype html><html><head><base href="./"><meta name="viewport" content="width=device-width"><link rel="manifest" href="./manifest.webmanifest"></head><body><div id="root"></div></body></html>');
      }
      if (req.url === '/assets/index-abc.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end('ok()'); }
      if (req.url === '/big') { res.writeHead(200); return res.end(Buffer.alloc(6 * 1024 * 1024, 7)); }
      if (req.url === '/api/echo') { res.writeHead(200); return res.end(body); }
      res.writeHead(404);
      return res.end();
    });
  });
  const wss = new WebSocketServer({ server, path: '/api/remote.mux' });
  wss.on('connection', (socket, req) => {
    seen.push({ upgrade: true, headers: req.headers });
    socket.on('message', (data, binary) => socket.send(data, { binary }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { seen, origin: `http://127.0.0.1:${server.address().port}/`, close: () => { wss.close(); server.closeAllConnections(); server.close(); } };
}

async function login() {
  const response = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ password: PASSWORD }) });
  assert.equal(response.status, 200);
  return response.headers.get('set-cookie').split(';')[0];
}

async function connectHarness(token, host) {
  const tunnel = createTunnel({ origin: () => host.origin, signIn: async () => LOCAL_COOKIE, log: quiet });
  const socket = new WebSocket(`${base.replace('http', 'ws')}/ws/harness`);
  sockets.push(socket);
  await once(socket, 'open');
  socket.send(JSON.stringify({ t: 'hello', v: 2, token, harness: { name: 'stub', host: 'h', platform: 'linux' } }));
  const mux = new Mux({
    sendJson: (frame) => socket.send(JSON.stringify(frame)),
    sendBinary: (bytes) => socket.send(bytes, { binary: true }),
    accept: (channel, frame) => tunnel.accept(channel, frame),
  });
  socket.on('message', (data, isBinary) => {
    if (isBinary) mux.binary(data);
    else { const frame = JSON.parse(data.toString()); if (frame.t !== 'welcome') mux.json(frame); }
  });
  socket.on('close', () => mux.closeAll());
  await new Promise((resolve) => setTimeout(resolve, 40));
  return { socket, mux };
}

const authed = (path, init = {}) => fetch(`${base}${path}`, { ...init, headers: { cookie, ...init.headers } });

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-hub-test-'));
  store = new Store(dir);
  store.data.passwordHash = hashPassword(PASSWORD);
  store.save();
  hub = createHub({ store, log: quiet });
  await new Promise((resolve) => hub.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${hub.server.address().port}`;
  cookie = await login();
});

after(async () => {
  for (const socket of sockets) socket.terminate();
  await hub.close();
  rmSync(dir, { recursive: true, force: true });
});

test('secrets stay hashed and static paths cannot escape', async () => {
  const { token, record } = store.mint('hash-check');
  assert.equal(JSON.stringify(store.data).includes(token), false);
  store.remove(record.id);
  for (const path of ['/../server.mjs', '/%2e%2e/server.mjs', '/..%2fhub.json']) {
    const body = await (await fetch(base + path)).text();
    assert.equal(body.includes('createHub'), false, path);
  }
});

test('wrong password is rejected and login needs same origin', async () => {
  const bad = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ password: 'nope' }) });
  assert.equal(bad.status, 401);
  const cross = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: JSON.stringify({ password: PASSWORD }) });
  assert.equal(cross.status, 403);
  assert.equal((await fetch(`${base}/api/harnesses`)).status, 401);
});

test('bad harness token closes with 4401; old protocol stays retryable', async () => {
  const bad = new WebSocket(`${base.replace('http', 'ws')}/ws/harness`);
  await once(bad, 'open');
  bad.send(JSON.stringify({ t: 'hello', v: 2, token: 'wrong' }));
  assert.equal((await once(bad, 'close'))[0], 4401);
  const { token, record } = store.mint('old');
  const old = new WebSocket(`${base.replace('http', 'ws')}/ws/harness`);
  await once(old, 'open');
  old.send(JSON.stringify({ t: 'hello', v: 1, token }));
  assert.equal((await once(old, 'close'))[0], 4426);
  store.remove(record.id);
});

test('PWA and mobile shell are public, typed and never serve stale workers', async () => {
  const worker = await fetch(`${base}/sw.js`);
  assert.equal(worker.headers.get('cache-control'), 'no-cache');
  assert.match(worker.headers.get('content-type'), /javascript/);
  assert.match((await fetch(`${base}/shell/boot.js`)).headers.get('content-type'), /javascript/);
  assert.match((await fetch(`${base}/shell/mobile.css`)).headers.get('content-type'), /css/);
  assert.equal((await fetch(`${base}/icons/icon-512.png`)).headers.get('content-type'), 'image/png');
  const manifest = await (await fetch(`${base}/manifest.webmanifest`)).json();
  assert.equal(manifest.scope, '/');
  assert.ok(manifest.icons.some((icon) => icon.purpose === 'maskable'));
});

test('every served script parses', () => {
  for (const file of ['app.js', 'lib.js', 'sw.js', 'shell/boot.js']) {
    const source = readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8');
    const script = source.replace(/^import .*$/gm, '').replace(/^export /gm, '');
    assert.doesNotThrow(() => new Script(`(async () => {${script}\n})`), file);
  }
});

test('the mux copies stay identical', () => {
  const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
  assert.equal(read('../mux.mjs'), read('../../plugin/mux.js'));
});

test('a password change from another process applies at once and survives this process saving', async () => {
  const dirA = mkdtempSync(join(tmpdir(), 'dsh-hub-auth-'));
  const running = new Store(dirA);
  running.data.passwordHash = hashPassword('first password 1');
  running.save({ ownAuth: true });
  const service = createHub({ store: running, log: quiet });
  await new Promise((resolve) => service.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${service.server.address().port}`;
  const signIn = (password) => fetch(`${origin}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ password }) });
  const session = (await signIn('first password 1')).headers.get('set-cookie').split(';')[0];
  assert.equal((await fetch(`${origin}/api/me`, { headers: { cookie: session } })).status, 200);

  // What `server.mjs set-password` does, in its own Store while the service keeps running.
  await new Promise((resolve) => setTimeout(resolve, 15));
  const command = new Store(dirA);
  command.data.passwordHash = hashPassword('second password 2');
  command.data.sessionEpoch += 1;
  command.save({ ownAuth: true });

  // The old login dies with no restart, and the service's next routine save keeps the new hash.
  assert.equal((await fetch(`${origin}/api/me`, { headers: { cookie: session } })).status, 401);
  running.mint('routine-save');
  assert.equal(JSON.parse(readFileSync(join(dirA, 'hub.json'), 'utf8')).passwordHash, command.data.passwordHash);
  assert.equal((await signIn('first password 1')).status, 401);
  assert.equal((await signIn('second password 2')).status, 200);
  await service.close();
  rmSync(dirA, { recursive: true, force: true });
});

test('tunnel: auth gate, shell injection, header policy, caching, streaming, uploads, sockets', async () => {
  const hostA = await stubHost();
  const hostB = await stubHost();
  const a = store.mint('alpha');
  const b = store.mint('beta');
  const agentA = await connectHarness(a.token, hostA);
  const agentB = await connectHarness(b.token, hostB);
  const prefix = `/h/${a.record.id}`;

  const roster = await (await authed('/api/harnesses')).json();
  assert.equal(roster.harnesses.filter((row) => row.online).length, 2);
  assert.equal(JSON.stringify(roster).includes('tokenHash'), false);

  // Anonymous callers reach nothing behind the prefix.
  assert.equal((await fetch(`${base}${prefix}/api/echo`, { method: 'POST' })).status, 401);
  const anonymous = await fetch(`${base}${prefix}/`, { redirect: 'manual', headers: { accept: 'text/html' } });
  assert.equal(anonymous.status, 302);
  assert.match(anonymous.headers.get('location'), /^\/\?next=/);
  assert.equal(hostA.seen.length, 0);

  // A bare harness root gains the slash that the page's relative base needs.
  const bare = await authed(prefix, { redirect: 'manual' });
  assert.equal(bare.status, 308);
  assert.equal(bare.headers.get('location'), `${prefix}/`);

  // The index carries the shell, drops the Host's own manifest, and leaks no Host cookie.
  const index = await authed(`${prefix}/`, { headers: { accept: 'text/html' } });
  const html = await index.text();
  assert.equal(index.status, 200);
  assert.equal(index.headers.get('set-cookie'), null);
  assert.equal(index.headers.get('cache-control'), 'no-store');
  assert.match(html, /viewport-fit=cover/);
  assert.match(html, /\/shell\/mobile\.css/);
  assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest">/);
  assert.equal(html.includes('./manifest.webmanifest'), false);
  assert.ok(html.includes(a.record.id));
  assert.ok(html.indexOf('<base') < html.indexOf('/shell/boot.js'));

  // The hub session stops at the hub; DSH sees its own cookie, Host and Origin.
  const forwarded = hostA.seen.find((row) => row.url === '/');
  assert.equal(forwarded.headers.cookie, LOCAL_COOKIE);
  assert.equal(forwarded.headers.host, new URL(hostA.origin).host);
  assert.equal(hostB.seen.length, 0);

  // Hashed bundles become cacheable.
  const asset = await authed(`${prefix}/assets/index-abc.js`);
  assert.match(asset.headers.get('cache-control'), /immutable/);
  assert.equal(await asset.text(), 'ok()');

  // A transfer larger than the credit window survives intact, both ways.
  const big = await authed(`${prefix}/big`);
  assert.equal((await big.arrayBuffer()).byteLength, 6 * 1024 * 1024);
  const upload = Buffer.alloc(5 * 1024 * 1024, 3);
  const echoed = await authed(`${prefix}/api/echo`, { method: 'POST', headers: { origin: base }, body: upload });
  assert.equal(echoed.status, 200);
  assert.equal(Buffer.compare(Buffer.from(await echoed.arrayBuffer()), upload), 0);

  // State-changing calls need the hub's origin even with a session.
  assert.equal((await authed(`${prefix}/api/echo`, { method: 'POST', headers: { origin: 'https://evil.example' }, body: 'x' })).status, 403);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(agentA.mux.channels.size, 0, 'finished channels are released');

  // WebSocket upgrades pass through as raw bytes with text and binary intact.
  const ws = new WebSocket(`${base.replace('http', 'ws')}${prefix}/api/remote.mux`, { headers: { cookie, origin: base } });
  await once(ws, 'open');
  ws.send('hello');
  assert.equal((await once(ws, 'message'))[0].toString(), 'hello');
  ws.send(Buffer.from([1, 2, 3]), { binary: true });
  assert.deepEqual([...(await once(ws, 'message'))[0]], [1, 2, 3]);
  const upgrade = hostA.seen.find((row) => row.upgrade);
  assert.equal(upgrade.headers.cookie, LOCAL_COOKIE);
  assert.equal(upgrade.headers.origin, new URL(hostA.origin).origin);

  const evil = new WebSocket(`${base.replace('http', 'ws')}${prefix}/api/remote.mux`, { headers: { cookie, origin: 'https://evil.example' } });
  assert.equal((await once(evil, 'unexpected-response'))[1].statusCode, 403);
  const noCookie = new WebSocket(`${base.replace('http', 'ws')}${prefix}/api/remote.mux`, { headers: { origin: base } });
  assert.equal((await once(noCookie, 'unexpected-response'))[1].statusCode, 401);

  // Revoking a harness ends its tunnels, and pages get a clean offline answer.
  const browserClosed = once(ws, 'close');
  const harnessClosed = once(agentA.socket, 'close');
  const removed = await authed(`/api/harnesses/${a.record.id}`, { method: 'DELETE', headers: { origin: base } });
  assert.equal(removed.status, 200);
  assert.equal((await harnessClosed)[0], 4403);
  await browserClosed;
  assert.equal((await authed(`${prefix}/api/echo`, { method: 'POST', headers: { origin: base }, body: 'x' })).status, 502);
  const gone = await authed(`${prefix}/`, { redirect: 'manual', headers: { accept: 'text/html' } });
  assert.match(gone.headers.get('location'), /^\/\?offline=/);

  agentB.socket.close();
  hostA.close();
  hostB.close();
});
