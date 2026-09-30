// Root-reviewed disabled entries only. No dynamic Core import or daemon start.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const root = '/private/tmp/light-companion-build-v3';
const here = '/private/tmp/light-takeover/fair-confirmation/current-cli-observer-v1';
const runtime = '/private/tmp/light-clean-cli-validator-v2-GANyA9/source/runtime';
const hash = b => createHash('sha256').update(b).digest('hex');
const expected = 'c73dbf32d6c243e115bf524459f535cace0f8effdc7d00901d274e2a5bec05cd';
assert.equal(process.version, 'v26.8.1');
assert.deepEqual(process.execArgv, []);
const manifestBytes = fs.readFileSync(path.join(here, 'companion-build-inputs-v3.json'));
assert.equal(hash(manifestBytes), expected);
const manifest = JSON.parse(manifestBytes);
const buildBytes = fs.readFileSync(path.join(root, 'build-result.json'));
assert.equal(hash(buildBytes), '00cbecea8889c362e817e4931b28ef3e5dc4a340b39633f852c9e8c11f86edd1');
const built = JSON.parse(buildBytes);
assert.equal(built.recipeVersion, 3);
assert.equal(built.manifestHash, expected);
const verify = () => {
  for (const row of [...built.outputs, ...built.packageAssets.map(a => ({ ...a, name: a.destination }))]) {
    assert(!row.name.includes('..') && !path.isAbsolute(row.name));
    const data = fs.readFileSync(path.join(root, row.name));
    assert.equal(data.length, row.bytes); assert.equal(hash(data), row.sha256);
  }
  for (const name of ['selection.mjs', 'compatibility-selection.mjs', 'empty-resources.mjs', 'preflight-selection.mjs']) {
    const file = path.join(here, name);
    assert.equal(hash(fs.readFileSync(file)), manifest.files[file]);
  }
};
verify();
assert.deepEqual(built.splitGraph.entries.map(e => [e.entry, e.staticClosure]), [
  ['dist/owner-companion.mjs', ['dist/chunk-HMJKBMOE.mjs', 'dist/owner-companion.mjs']],
  ['dist/preflight-companion.mjs', ['dist/chunk-HMJKBMOE.mjs', 'dist/preflight-companion.mjs']],
]);
const beforeFetch = globalThis.fetch;
const owner = await import(pathToFileURL(path.join(root, 'dist/owner-companion.mjs')).href);
const preflight = await import(pathToFileURL(path.join(root, 'dist/preflight-companion.mjs')).href);
assert.deepEqual(Object.keys(owner), ['runOwnedForeground']);
assert.deepEqual(Object.keys(preflight), ['runSelectedIndependent']);
await assert.rejects(owner.runOwnedForeground(undefined), { message: 'cli_fixture_selection_not_accepted' });
await assert.rejects(preflight.runSelectedIndependent(undefined), { message: 'preflight_execution_not_approved' });
assert.equal(globalThis.fetch, beforeFetch);
// Path/byte checks only: do not import the classifier or runtime-info graph.
const requireFromDist = createRequire(pathToFileURL(path.join(root, 'dist/owner-companion.mjs')));
for (const name of ['auto_mode_system_prompt.txt', 'permissions_external.txt']) {
  const resolved = requireFromDist.resolve('./yolo-classifier-prompts/' + name);
  assert.equal(resolved, path.join(root, 'dist/yolo-classifier-prompts', name));
  assert.equal(hash(fs.readFileSync(resolved)), manifest.files[path.join(runtime, 'dist/yolo-classifier-prompts', name)]);
}
assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).name, '@tetsuo-ai/runtime');
assert.equal(hash(fs.readFileSync(path.join(root, 'package.json'))), manifest.files[path.join(runtime, 'package.json')]);
assert.equal(hash(fs.readFileSync(path.join(root, 'dist/VERSION'))), manifest.files[path.join(runtime, 'dist/VERSION')]);
verify();
const result = { passed: true, scope: 'disabled two-entry imports and package path/byte checks only',
  selectionStillDisabled: true, preflightStillDisabled: true, fetchUnchanged: true,
  dynamicCoreImported: false, daemonStarted: false, providerCalls: 0,
  promptPathsResolve: true, exactPackageAndVersion: true, deploymentClosureComplete: false,
  linuxValidated: false, finished: new Date().toISOString() };
fs.writeFileSync(path.join(root, 'disabled-entries-smoke.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify(result));
