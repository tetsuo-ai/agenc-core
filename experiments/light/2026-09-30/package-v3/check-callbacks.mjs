// Local synthetic unit/type gate, never a provider/client/performance launch.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const here = path.dirname(fileURLToPath(import.meta.url));
const label = process.argv[2];
if (!/^[a-z0-9-]{1,50}$/.test(label ?? '')) throw Error('unique result label required');
if (process.versions.node !== '26.8.1') throw Error('selected Node 26.8.1 required');
const source = '/private/tmp/light-clean-cli-validator-v2-GANyA9/source';
const resultDir = path.join(here, 'callback-checks-' + label);
fs.mkdirSync(resultDir, {mode: 0o700});
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const files = ['fixture-callbacks.ts', 'fixture-callbacks.test.ts', 'vitest.callbacks.config.mts',
  'tsconfig.callbacks.json', 'tsconfig.companion.json', 'check-callbacks.mjs'];
const hashes = Object.fromEntries(files.map(file => [file, sha(fs.readFileSync(path.join(here, file)))]));
const result = {scope: 'synthetic callback unit/type validation only', sourceCommit: '403da04398b55e51d1f4e8814f9a70957b0db5ef',
  source, node: process.version, started: new Date().toISOString(), hashes, steps: []};
const env = {PATH: path.dirname(process.execPath) + ':/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', TZ: 'UTC', CI: 'true'};
for (const [name, args] of [
  ['types', [source + '/node_modules/typescript/bin/tsc', '-p', here + '/tsconfig.callbacks.json', '--noEmit', '--pretty', 'false']],
  ['tests', [source + '/runtime/scripts/run-hermetic-vitest.mjs', '--require-zero-skips', 'run', '--config', here + '/vitest.callbacks.config.mts']],
]) {
  const fd = fs.openSync(path.join(resultDir, name + '.log'), 'wx', 0o600);
  let child;
  try { child = spawnSync(process.execPath, args, {cwd: source + '/runtime', env, stdio: ['ignore', fd, fd], timeout: 120000}); }
  finally { fs.closeSync(fd); }
  const step = {name, status: child.status, signal: child.signal, error: child.error?.code ?? null};
  result.steps.push(step); console.log(JSON.stringify(step));
}
result.finished = new Date().toISOString();
result.inputsUnchanged = files.every(file => hashes[file] === sha(fs.readFileSync(path.join(here, file))));
result.passed = result.inputsUnchanged && result.steps.every(step => step.status === 0 && step.error === null && step.signal === null);
fs.writeFileSync(path.join(resultDir, 'result.json'), JSON.stringify(result, null, 2) + '\n', {flag: 'wx', mode: 0o600});
console.log(JSON.stringify({resultDir, passed: result.passed}));
process.exitCode = result.passed ? 0 : 1;
