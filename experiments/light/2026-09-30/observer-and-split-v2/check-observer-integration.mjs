// Root-reviewed offline integration gate; retains every result and child root.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const here = path.dirname(fileURLToPath(import.meta.url));
const label = process.argv[2];
if (!/^[a-z0-9-]{1,50}$/.test(label ?? '') || process.versions.node !== '26.8.1') throw Error('selected node and fresh label required');
const output = path.join(here, 'observer-check-' + label);
fs.mkdirSync(output, {mode: 0o700});
const names = ['callback-observer-child.mjs', 'callback-observer.test.mjs', 'fixture-callbacks.ts', 'check-observer-integration.mjs'];
const hash = name => createHash('sha256').update(fs.readFileSync(path.join(here, name))).digest('hex');
const inputs = Object.fromEntries(names.map(name => [name, hash(name)]));
const fd = fs.openSync(path.join(output, 'tests.tap'), 'wx', 0o600);
const started = new Date().toISOString();
let result;
try {
  result = spawnSync('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)(deny network*)',
    process.execPath, '--experimental-strip-types', '--test', '--test-timeout=100000',
    path.join(here, 'callback-observer.test.mjs')], {
    cwd: here, env: {PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', TZ: 'UTC'},
    stdio: ['ignore', fd, fd], timeout: 120000,
  });
} finally {fs.closeSync(fd);}
const receipt = {scope: 'actual observer with synthetic callbacks, not CLI/client/provider execution', started,
  finished: new Date().toISOString(), status: result.status, signal: result.signal, error: result.error?.code ?? null,
  node: process.version, inputs, inputsUnchanged: names.every(name => inputs[name] === hash(name)), osNetworkDenied: true};
fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(receipt, null, 2) + '\n', {flag: 'wx', mode: 0o600});
console.log(JSON.stringify({...receipt, output}));
process.exitCode = receipt.status === 0 && receipt.error === null && receipt.signal === null && receipt.inputsUnchanged ? 0 : 1;
