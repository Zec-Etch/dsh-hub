// Verify an actual isolated package installation without activating a live DSH profile.
// node test/installed-package.mjs <profile-directory>
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const profile = resolve(process.argv[2]);
const require = createRequire(join(profile, 'package.json'));
const file = require.resolve('dsh-hub-agent/package.json');
const manifest = JSON.parse(readFileSync(file, 'utf8'));
assert.equal(manifest.name, 'dsh-hub-agent');
assert.equal(manifest.version, JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
assert.equal(manifest.dsh.bundle.patch, './plugin/cordis.patch.yml');
const plugin = await import(pathToFileURL(require.resolve('dsh-hub-agent')).href);
assert.equal(plugin.name, manifest.name);
assert.equal(typeof plugin.apply, 'function');
assert.deepEqual(plugin.inject, ['connection', 'webServer']);
assert.equal(JSON.parse(readFileSync(require.resolve('dsh-hub-agent/locale/en.json'), 'utf8')).meta.title, 'DSH Hub Agent');
assert.ok(readFileSync(require.resolve('dsh-hub-agent/icon'), 'utf8').includes('<svg'));
console.log('PASS installed package entry, bundle metadata, locale and icon exports');
if (process.env.DSH_APP_BOOT_MODULE) {
  const native = await import(pathToFileURL(process.env.DSH_APP_BOOT_MODULE).href);
  const directory = native.resolveBundleDir('dsh', manifest.name, join(profile, 'package.json'), profile);
  const installed = native.readProfileManifest('dsh', directory);
  assert.equal(installed.name, manifest.name);
  assert.equal(native.evaluatePluginCompatibility(installed), undefined);
  const patches = native.bundlePatchPaths(directory, installed.dsh.bundle).flatMap((path) => native.loadOverlayPatches('dsh', path));
  assert.ok(patches.length > 0);
  console.log('PASS actual DSH runtime discovers the installed bundle and parses its patches');
}
