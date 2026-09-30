// Import ONLY the reviewed disabled entry/static closure; never enable execution.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const root = '/private/tmp/light-companion-build-v2';
const here = '/private/tmp/light-takeover/fair-confirmation/current-cli-observer-v1';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
assert.equal(process.version, 'v26.8.1');
const raw = fs.readFileSync(path.join(here, 'companion-build-inputs-v2.json'));
assert.equal(sha(raw), 'c603d313de6290573c693707b3f31fc2edbd2f73798c2737f8aaf5f1e1126b94');
const accepted = JSON.parse(raw);
const built = JSON.parse(fs.readFileSync(path.join(root, 'build-result.json')));
assert.equal(built.recipeVersion, 2); assert.equal(built.manifestHash, sha(raw));
assert.deepEqual(built.splitGraph.entryStaticClosure, ['chunks/chunk-KHT67E7S.mjs', 'owner-companion.mjs']);
const verify = () => {
  for (const output of built.outputs) {
    const bytes = fs.readFileSync(path.join(root, output.name));
    assert.equal(bytes.length, output.bytes); assert.equal(sha(bytes), output.sha256);
  }
  for (const name of ['selection.mjs', 'compatibility-selection.mjs', 'empty-resources.mjs']) {
    const filename = path.join(here, name);
    assert.equal(sha(fs.readFileSync(filename)), accepted.files[filename]);
  }
};
verify();
const beforeFetch = globalThis.fetch;
const entry = await import(pathToFileURL(path.join(root, 'owner-companion.mjs')).href);
assert.deepEqual(Object.keys(entry), ['runOwnedForeground']);
await assert.rejects(entry.runOwnedForeground(undefined), {message: 'cli_fixture_selection_not_accepted'});
assert.equal(globalThis.fetch, beforeFetch);
verify();
const result = {scope: 'disabled entry import only; no Core graph/client/provider startup',
  passed: true, selectionStillDisabled: true, refusal: 'cli_fixture_selection_not_accepted',
  fetchUnchanged: true, dynamicRuntimeImported: false, osNetworkDenied: true,
  entrySha256: '2d61db9e11d024f0182a42aad935a45ffd5e3abf4ed2792148b5c2b4cea1dfc5',
  finished: new Date().toISOString()};
fs.writeFileSync(path.join(root, 'disabled-entry-smoke.json'), JSON.stringify(result, null, 2) + '\n', {flag: 'wx', mode: 0o600});
console.log(JSON.stringify(result));
