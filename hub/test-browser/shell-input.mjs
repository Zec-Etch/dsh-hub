// Browser regression checks for the phone shell's input handling (public/shell/boot.js).
//
// They need a Chromium with remote debugging and `playwright-core`; neither is a dependency of the hub:
//   chrome --headless=new --remote-debugging-port=9333 about:blank
//   npm i --no-save playwright-core && CDP_URL=http://127.0.0.1:9333 node test-browser/shell-input.mjs
//
// The DSH page is modelled, not loaded: DSH's code is not part of this repository.
import fs from 'node:fs';
import { chromium } from 'playwright-core';

const boot = fs.readFileSync(new URL('../public/shell/boot.js', import.meta.url), 'utf8');
const browser = await chromium.connectOverCDP(process.env.CDP_URL ?? 'http://127.0.0.1:9333');
let failed = 0;
const report = (ok, name, detail) => { console.log(ok ? 'PASS' : 'FAIL', name, detail); if (!ok) failed += 1; };

async function open(html, { touch }) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: touch, isMobile: touch });
  const page = await context.newPage();
  await page.route('http://fixture.test/**', (route) => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto('http://fixture.test/');
  return { page, close: () => context.close() };
}

/*
 * DSH deletes a command chip in two steps (first Backspace selects it, the second removes it) and drops
 * the selection on the next keydown unless that keydown also deleted. A soft keyboard deletes through
 * `beforeinput` only, so on a phone the selection was dropped first and the chip could never be removed.
 */
const chipPage = (withShell) => `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1">
<div id=root><div data-composer-card><div id=ed contenteditable=true>/cmd</div></div></div>
<script>window.__DSH_HUB__={id:'f'};const ed=document.getElementById('ed');let selected=false;window.log=[];
ed.addEventListener('keydown',()=>{if(selected)queueMicrotask(()=>{selected=false;ed.removeAttribute('data-composer-chip-selected');});});
ed.addEventListener('beforeinput',(e)=>{if(e.inputType!=='deleteContentBackward')return;log.push(selected?'delete':'select');e.preventDefault();
  if(!selected){selected=true;ed.setAttribute('data-composer-chip-selected','');}else{selected=false;ed.removeAttribute('data-composer-chip-selected');ed.textContent='';}});
</script>${withShell ? `<script>${boot}</script>` : ''}`;

for (const [name, shell, touch, expected] of [
  ['without the shell, a phone never deletes the chip', false, true, 'select,select,select'],
  ['with the shell, the second Backspace deletes it', true, true, 'select,delete'],
  ['with the shell, a desktop keeps its own behaviour', true, false, 'select,select,select'],
]) {
  const { page, close } = await open(chipPage(shell), { touch });
  await page.evaluate(() => document.getElementById('ed').focus());
  for (let press = 0; press < expected.split(',').length; press += 1) { await page.keyboard.press('Backspace'); await page.waitForTimeout(150); }
  const seen = (await page.evaluate(() => window.log)).slice(0, expected.split(',').length).join(',');
  report(seen === expected, name, seen);
  await close();
}

/* A Backspace that produced no `beforeinput` (some mobile keyboards beside a non-editable chip) is replayed. */
const plainPage = `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1">
<div id=root><div data-composer-card><div id=ed contenteditable=true>abc</div></div></div>
<script>window.__DSH_HUB__={id:'f'};window.log=[];window.swallow=false;const ed=document.getElementById('ed');
ed.addEventListener('beforeinput',(e)=>log.push(e.inputType));
ed.addEventListener('keydown',(e)=>{if(swallow&&e.key==='Backspace')e.preventDefault();});</script><script>${boot}</script>`;
for (const [name, swallow, touch, expected] of [
  ['a normal Backspace is not replayed', false, true, 1],
  ['a swallowed Backspace is replayed once on touch', true, true, 1],
  ['a swallowed Backspace is left alone with a mouse', true, false, 0],
]) {
  const { page, close } = await open(plainPage, { touch });
  await page.evaluate((hide) => { window.swallow = hide; const ed = document.getElementById('ed'); ed.focus(); getSelection().selectAllChildren(ed); getSelection().collapseToEnd(); }, swallow);
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(400);
  const log = await page.evaluate(() => window.log);
  report(log.length === expected && (expected === 0 || log[0] === 'deleteContentBackward'), name, JSON.stringify(log));
  await close();
}

await browser.close();
process.exit(failed ? 1 : 0);
