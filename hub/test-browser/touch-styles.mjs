// Real Chromium DOM regression for the actual Hub shell; uses an isolated CDP context.
// node test-browser/touch-styles.mjs [boot.js] [--expect-cycle]
// Requires the existing `ws` dependency and Chromium with remote debugging on port 9333.
// CDP_URL may point at another browser; only contexts created by this script are closed.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
const require = createRequire(import.meta.url);
const { WebSocket } = require('ws');
const boot = readFileSync(process.argv[2] ?? new URL('../public/shell/boot.js', import.meta.url), 'utf8');
const expectCycle = process.argv.includes('--expect-cycle');
const endpoint = process.env.CDP_URL ?? 'http://127.0.0.1:9333';
const version = await (await fetch(`${endpoint}/json/version`)).json();
const socket = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
let nextId = 0;
const pending = new Map();
const contexts = new Set();
const fixtures = new Map();
let interceptionFailure;
function rpc(method, params = {}, sessionId) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 8000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}
socket.on('message', (bytes) => {
  const message = JSON.parse(bytes.toString());
  if (message.id) {
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(JSON.stringify(message.error)));
    else request.resolve(message.result);
  } else if (message.method === 'Fetch.requestPaused' && fixtures.has(message.sessionId)) {
    const html = fixtures.get(message.sessionId);
    void rpc('Fetch.fulfillRequest', {
      requestId: message.params.requestId,
      responseCode: 200,
      responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }, { name: 'Cache-Control', value: 'no-store' }],
      body: Buffer.from(html).toString('base64'),
    }, message.sessionId).catch((error) => { interceptionFailure = error; });
  }
});
const prefix = `
window.__DSH_HUB__ = { id: 'touch-style-fixture' };
window.revealStats = { scans: 0, writes: 0, schedules: 0 };
const sheetsGetter = Object.getOwnPropertyDescriptor(Document.prototype, 'styleSheets').get;
Object.defineProperty(document, 'styleSheets', { get() { revealStats.scans++; return sheetsGetter.call(document); } });
const nativeTimeout = window.setTimeout.bind(window);
window.setTimeout = (callback, ms, ...args) => { if (callback.name === 'rebuild' && ms === 400) revealStats.schedules++; return nativeTimeout(callback, ms, ...args); };
window.generatedSheet = () => document.querySelector('head > style:not([id])');
new MutationObserver((records) => {
  const own = generatedSheet();
  if (own) revealStats.writes += records.filter((r) => r.target === own || own.contains(r.target)).length;
}).observe(document.head, { childList: true, subtree: true, characterData: true });
`;
const fixture = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style id="fixture-source">.row .actions{opacity:0}.row:hover .actions{opacity:1}</style></head><body><div id="root"><div class="row"><span class="actions">Action</span></div></div><script>${prefix}</script><script>${boot}</script></body></html>`;
async function open(touch) {
  const { browserContextId } = await rpc('Target.createBrowserContext', { disposeOnDetach: true });
  contexts.add(browserContextId);
  const { targetId } = await rpc('Target.createTarget', { url: 'about:blank', browserContextId });
  const { sessionId } = await rpc('Target.attachToTarget', { targetId, flatten: true });
  await rpc('Emulation.setDeviceMetricsOverride', { width: touch ? 390 : 1280, height: 844, deviceScaleFactor: 1, mobile: touch }, sessionId);
  await rpc('Emulation.setTouchEmulationEnabled', { enabled: touch, maxTouchPoints: touch ? 5 : 1 }, sessionId);
  fixtures.set(sessionId, fixture);
  await rpc('Fetch.enable', { patterns: [{ urlPattern: 'http://hub-style-fixture.test/*', requestStage: 'Request' }] }, sessionId);
  await rpc('Page.navigate', { url: 'http://hub-style-fixture.test/' }, sessionId);
  const evaluate = async (expression) => {
    const result = await rpc('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
  for (let i = 0; i < 30; i++) {
    if (await evaluate('Boolean(window.revealStats && document.getElementById("hub-menu"))')) break;
    if (interceptionFailure) throw interceptionFailure;
    await delay(100);
  }
  assert.equal(await evaluate('Boolean(document.getElementById("hub-menu"))'), true, 'actual boot script mounted');
  return { evaluate, close: async () => { fixtures.delete(sessionId); await rpc('Target.disposeBrowserContext', { browserContextId }); contexts.delete(browserContextId); } };
}
let passed = 0;
const pass = (name, detail) => { passed++; console.log('PASS', name, detail ?? ''); };
try {
  const mobile = await open(true);
  const evaluate = mobile.evaluate;
  assert.equal(await evaluate('matchMedia("(hover: none)").matches'), true);
  assert.equal(await evaluate('getComputedStyle(document.querySelector(".actions")).opacity'), '1');
  pass('touch rules reveal the original action');
  const initial = await evaluate('({...revealStats})');
  await delay(1150);
  const idle = await evaluate('({...revealStats})');
  console.log('IDLE_COUNTS', JSON.stringify({ initial, after1150ms: idle }));
  if (expectCycle) {
    assert.ok(idle.scans > initial.scans && idle.writes > initial.writes, 'unfixed source must reproduce the loop');
    pass('unfixed source reproduces repeated idle scans');
  } else {
    assert.deepEqual(idle, initial, 'idle page must stop scanning and rewriting');
    pass('idle page stops scanning and rewriting');
    await evaluate(`for (let i=0;i<3;i++) { const node=document.createElement('meta'); node.name='fixture-batch-'+i; document.head.append(node); }`);
    await delay(650);
    const unrelated = await evaluate('({...revealStats})');
    assert.equal(unrelated.scans, idle.scans + 1);
    assert.equal(unrelated.writes, idle.writes);
    assert.equal(unrelated.schedules, idle.schedules + 1);
    pass('external batch coalesces without rewriting identical CSS', JSON.stringify(unrelated));
    await evaluate(`const extra=document.createElement('style'); extra.id='fixture-extra'; extra.textContent='.added:hover .control{visibility:visible}'; document.head.append(extra);`);
    await delay(650);
    assert.equal(await evaluate('generatedSheet().textContent.includes(".added .control{visibility:visible!important;}")'), true);
    pass('external stylesheet addition updates reveal rules');
    const external = await evaluate('({...revealStats})');
    await delay(900);
    assert.deepEqual(await evaluate('({...revealStats})'), external);
    pass('external update settles without a new loop');
    await evaluate(`generatedSheet().textContent+=' /* self batch */'; document.getElementById('fixture-extra').textContent='.mixed:hover .control{opacity:1}';`);
    await delay(650);
    assert.equal(await evaluate('generatedSheet().textContent.includes(".mixed .control{opacity:1!important;}") && !generatedSheet().textContent.includes("self batch")'), true);
    pass('mixed own and external mutation batch preserves external updates');
    const pendingStart = await evaluate('revealStats.schedules');
    await evaluate(`document.getElementById('fixture-extra').textContent='.pending:hover .control{visibility:visible}';`);
    await delay(120);
    assert.equal(await evaluate('revealStats.schedules'), pendingStart + 1);
    await evaluate(`generatedSheet().firstChild.data+=' /* own text mutation */'; generatedSheet().textContent+=' /* own child mutation */';`);
    await delay(100);
    assert.equal(await evaluate('revealStats.schedules'), pendingStart + 1);
    await delay(450);
    assert.equal(await evaluate('generatedSheet().textContent.includes(".pending .control{visibility:visible!important;}")'), true);
    pass('own records leave an already scheduled external update intact');
    await evaluate(`document.getElementById('fixture-extra').remove(); document.getElementById('fixture-source').textContent='.nothing{color:red}';`);
    await delay(650);
    assert.equal(await evaluate('generatedSheet().textContent'), '');
    pass('removing the final hover rule clears generated CSS');
    const empty = await evaluate('({...revealStats})');
    await delay(900);
    assert.deepEqual(await evaluate('({...revealStats})'), empty);
    pass('empty output settles without scanning');
    await mobile.close();
    const desktop = await open(false);
    assert.equal(await desktop.evaluate('matchMedia("(hover: none)").matches'), false);
    assert.equal(await desktop.evaluate('generatedSheet() === null && revealStats.scans === 0'), true);
    pass('mouse desktop branch remains inactive');
    await desktop.close();
  }
  console.log(`RESULT ${passed} checks passed; ${expectCycle ? 'baseline loop confirmed' : 'fixed source'}`);
} finally {
  for (const browserContextId of contexts) await rpc('Target.disposeBrowserContext', { browserContextId });
  socket.close();
}
