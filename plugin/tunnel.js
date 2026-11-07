// Agent half of the tunnel: replays hub requests against this Host's own Web server
// with the Host's own browser session. DSH sees an ordinary local browser, so every
// page, plugin bundle, Remote call and WebSocket stream works without an allowlist.
import http from 'node:http';
import https from 'node:https';

/** Identity headers the agent always decides itself. */
const STRIPPED = new Set(['host', 'origin', 'referer', 'cookie', 'authorization', 'x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host', 'forwarded', 'x-real-ip']);

function pairs(raw) {
  const out = [];
  for (let at = 0; at < raw.length; at += 2) out.push([raw[at], raw[at + 1]]);
  return out;
}

export function createTunnel({ origin, signIn, log }) {
  const target = () => new URL(origin());
  let cookie;

  async function ensureCookie(refresh = false) {
    if (refresh) cookie = undefined;
    cookie ??= await signIn();
    return cookie;
  }

  function headersFor(frame, url) {
    const out = {};
    for (const [name, value] of frame.headers) {
      const key = name.toLowerCase();
      if (!STRIPPED.has(key)) out[key] = out[key] === undefined ? value : `${out[key]}, ${value}`;
    }
    out.host = url.host;
    out.cookie = cookie;
    if (frame.origin) out.origin = url.origin;
    return out;
  }

  function dispatch(channel, frame, retried) {
    const url = target();
    const transport = url.protocol === 'https:' ? https : http;
    const outbound = transport.request({
      hostname: url.hostname.replace(/^\[|\]$/g, ''),
      port: url.port,
      path: frame.path,
      method: frame.method,
      headers: headersFor(frame, url),
      rejectUnauthorized: false, // The listener is this process; its certificate names a public authority.
    });
    channel.onClose = () => outbound.destroy();

    outbound.on('response', (response) => {
      const bodiless = frame.method === 'GET' || frame.method === 'HEAD';
      if (response.statusCode === 401 && !retried && bodiless && !frame.upgrade) {
        response.resume();
        ensureCookie(true).then(() => dispatch(channel, frame, true), () => channel.abort());
        return;
      }
      if (response.statusCode === 401) cookie = undefined;
      channel.control({ t: 'head', status: response.statusCode, headers: pairs(response.rawHeaders) });
      channel.onClose = () => response.destroy();
      void channel.pipeFrom(response);
    });
    outbound.on('upgrade', (response, socket, head) => {
      channel.control({ t: 'head', status: 101, headers: pairs(response.rawHeaders) });
      channel.onClose = () => socket.destroy();
      socket.on('error', () => channel.abort());
      socket.on('close', () => channel.abort());
      if (head.length) void channel.write(head);
      channel.pipeTo(socket);
      void channel.pipeFrom(socket);
    });
    outbound.on('error', (error) => {
      if (!channel.closed) log.warn?.('dsh-hub-agent: local request failed', error?.message);
      channel.abort();
    });
    if (frame.upgrade || retried) outbound.end(); else channel.pipeTo(outbound);
  }

  return {
    accept(channel, frame) {
      ensureCookie().then(() => dispatch(channel, frame, false), (error) => {
        log.warn?.('dsh-hub-agent: local sign-in failed', error?.message);
        channel.abort();
      });
    },
    /** One authenticated local Remote call, used for the picker's status line. */
    async remote(method, args) {
      await ensureCookie();
      const url = target();
      const response = await fetch(new URL(`api/${method}`, url).href, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie, origin: url.origin },
        body: JSON.stringify({ type: 'client-request', rpcId: `hub-${Date.now()}`, method, payload: { args } }),
      });
      if (response.status === 401) cookie = undefined;
      if (!response.ok) throw new Error(`host answered ${response.status}`);
      return (await response.json()).result?.value;
    },
  };
}
