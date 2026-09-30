import { Worker } from 'node:worker_threads';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const helper = await import(process.env.M4_CHARACTERIZATION_HELPER!);
assert.equal(process.env.AGENC_TEST_M4_DIAGNOSTIC_SCOPE, undefined);
assert.equal(helper.mark('fixture_entry'), true);
assert.equal(helper.mark('paths_ready'), true);
const worker = new Worker(new URL('./worker.mjs', import.meta.url), {
  env: { ...process.env, AGENC_TEST_M4_DIAGNOSTIC_SCOPE: 'crash' },
});
const workerResult = await new Promise((resolve, reject) => {
  let seen = false;
  worker.on('message', value => {
    if (seen) return reject(new Error('duplicate worker result'));
    seen = true;
    try { assert.deepEqual(value, { scopeAbsent: true, emitterAbsent: true }); }
    catch (error) { reject(error); }
  });
  worker.on('error', reject);
  worker.on('exit', code => code === 0 && seen ? resolve(true) : reject(new Error('worker failed')));
});
const descendant = fork(fileURLToPath(new URL('./descendant.mjs', import.meta.url)), [], {
  stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
});
const descendantResult = await new Promise((resolve, reject) => {
  let seen = false;
  descendant.on('message', value => {
    if (seen) return reject(new Error('duplicate descendant result'));
    seen = true;
    try { assert.deepEqual(value, { scopeAbsent: true, emitterAbsent: true, ipcWorks: true }); }
    catch (error) { reject(error); }
  });
  descendant.on('error', reject);
  descendant.on('exit', code => code === 0 && seen ? resolve(true) : reject(new Error('descendant failed')));
});
process.stdout.write(JSON.stringify({ mainScopeConsumed: true, workerResult, descendantResult }) + '\n');
