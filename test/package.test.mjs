import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
const root = fileURLToPath(new URL('..', import.meta.url));
const json = (path) => JSON.parse(readFileSync(resolve(root, path), 'utf8'));
const manifest = json('package.json');

test('repository root is an installable DSH bundle', () => {
  assert.equal(manifest.name, 'dsh-hub-agent');
  assert.notEqual(manifest.private, true);
  assert.equal(manifest.dsh.bundle.patch, './plugin/cordis.patch.yml');
  assert.ok(existsSync(resolve(root, manifest.dsh.bundle.patch)));
  assert.equal(manifest.engines.node, '>=22');
  assert.equal(manifest.engines.dsh, '>=0.2.2-rc.1 <0.3.0');
});
test('package self-reference loads the real agent entry', async () => {
  const plugin = await import('dsh-hub-agent');
  assert.equal(plugin.name, 'dsh-hub-agent');
  assert.deepEqual(plugin.inject, ['connection', 'webServer']);
  assert.equal(typeof plugin.apply, 'function');
});
test('root and subdirectory packages share version and compatibility', () => {
  const plugin = json('plugin/package.json');
  const server = json('hub/package.json');
  const lock = json('hub/package-lock.json');
  assert.equal(plugin.version, manifest.version);
  assert.equal(server.version, manifest.version);
  assert.equal(lock.version, server.version);
  assert.equal(lock.packages[''].version, server.version);
  assert.deepEqual(plugin.engines, manifest.engines);
  assert.ok(readFileSync(resolve(root, 'plugin/index.js'), 'utf8').includes(`const VERSION = '${manifest.version}'`));
});
test('agent and server have byte-identical multiplexers', () => {
  assert.deepEqual(readFileSync(resolve(root, 'plugin/mux.js')), readFileSync(resolve(root, 'hub/mux.mjs')));
});
test('client package contains its complete plugin payload', () => {
  for (const path of ['plugin/index.js', 'plugin/mux.js', 'plugin/tunnel.js', 'plugin/cordis.patch.yml', 'plugin/icon.svg', 'plugin/locale/en.json', 'plugin/locale/zh.json']) {
    assert.ok(existsSync(resolve(root, path)), path);
  }
  assert.equal(manifest.exports['.'], './plugin/index.js');
  assert.equal(manifest.exports['./package.json'], './package.json');
  assert.equal(manifest.exports['./locale/*.json'], './plugin/locale/*.json');
  assert.equal(manifest.exports['./icon'], './plugin/icon.svg');
});
test('client has no runtime dependencies or installation lifecycle hooks', () => {
  assert.deepEqual(manifest.dependencies ?? {}, {});
  for (const hook of ['preinstall', 'install', 'postinstall', 'prepare', 'prepack']) assert.equal(manifest.scripts?.[hook], undefined, hook);
  assert.ok(!manifest.files.some((path) => path.startsWith('hub/')));
});
test('bundle declares the agent and remote-safe folder pickers', () => {
  const patch = readFileSync(resolve(root, manifest.dsh.bundle.patch), 'utf8');
  for (const name of ['dsh-hub-agent', '@deepseek-ai/dsh-host-directory-picker-browse', '@deepseek-ai/dsh-client-ui-directory-picker-browse']) assert.ok(patch.includes(name), name);
});
test('native DSH loader recognizes the bundle and compatibility', { skip: !process.env.DSH_APP_BOOT_MODULE }, async () => {
  const native = await import(pathToFileURL(process.env.DSH_APP_BOOT_MODULE).href);
  assert.equal(native.evaluatePluginCompatibility(manifest, {}, '0.2.2-rc.1'), undefined);
  assert.equal(native.evaluatePluginCompatibility(manifest, {}, '0.2.2'), undefined);
  assert.equal(native.evaluatePluginCompatibility(manifest, {}, '0.1.7').exempted, false);
  const paths = native.bundlePatchPaths(root, manifest.dsh.bundle);
  assert.deepEqual(paths, [resolve(root, 'plugin/cordis.patch.yml')]);
  const patches = native.loadOverlayPatches('dsh', paths[0]);
  assert.ok(Array.isArray(patches) && patches.length > 0);
});
