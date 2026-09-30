import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createIdentityAdapters } from '../fair-confirmation/real-parent-adapters-v1/adapters.mjs';
import { SOURCE_REVISION } from '../fair-confirmation/real-parent-adapters-v1/pins.mjs';

const target = new URL('../fair-confirmation/real-parent-adapters-v1/adapters.mjs', import.meta.url);
assert.equal(createHash('sha256').update(readFileSync(target)).digest('hex'),
  '1e1526531c9e579829e448a26ba693dffb82700056a6f95607f24a45cbac23f7');

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
function fixture() {
  const value = { pid: 301, instanceId: 'review-instance', processStart: 'linux:boot:7',
    runtimeVersion: 'review', commit: SOURCE_REVISION, buildTime: 'review-build' };
  const calls = [];
  const keys = Object.keys(value);
  const api = {
    readDaemonRuntimeInfo() { calls.push('sidecar'); return { ...value }; },
    daemonInstanceIdentityFromRuntimeInfo: value => value,
    resolveAgenCDaemonRuntimeInfoPath: home => `${home}/daemon-runtime.json`,
    readAgenCDaemonProcessStart() { calls.push('process'); return value.processStart; },
    isAgenCDaemonInstanceIdentity: candidate => candidate !== null && typeof candidate === 'object' &&
      keys.every(key => key === 'pid' ? Number.isSafeInteger(candidate[key]) && candidate[key] > 0 :
        typeof candidate[key] === 'string' && candidate[key].length > 0),
    sameAgenCDaemonInstanceIdentity: (a, b) => keys.every(key => a[key] === b[key]),
    requestAgenCDaemonInstanceIdentity() { calls.push('authenticate'); return value; },
    requestAgenCDaemonShutdown() { calls.push('shutdown'); },
    resolveAgenCDaemonHome: env => env.AGENC_HOME,
    resolveAgenCDaemonRequestTimeoutMs: env => Number(env.AGENC_DAEMON_REQUEST_TIMEOUT_MS),
  };
  const adapter = createIdentityAdapters({ api, ownedPid: value.pid,
    daemonHome: '/synthetic/review/daemon', userHome: '/synthetic/review/user',
    expectedBuild: value, platform: 'linux', requestMs: 10, operationMs: 100 });
  return { adapter, api, value, calls };
}

test('abort before the dispatch microtask calls no canonical operation', async () => {
  const { adapter, calls } = fixture();
  const controller = new AbortController();
  const request = adapter.identityAdapter.requestAuthenticatedIdentity(controller.signal);
  controller.abort();
  await assert.rejects(request, { message: 'adapter_operation_failed' });
  await tick();
  assert.deepEqual(calls, []);
  assert.equal(adapter.state().outstanding, false);
  assert.equal(adapter.state().poisoned, true);
});

test('all six authenticated tuple fields are required for bound shutdown', async () => {
  for (const key of ['pid', 'instanceId', 'processStart', 'runtimeVersion', 'commit', 'buildTime']) {
    const { adapter, calls } = fixture();
    const bound = await adapter.identityAdapter.requestAuthenticatedIdentity();
    const altered = { ...bound, [key]: key === 'pid' ? 302 : `${bound[key]}-changed` };
    await assert.rejects(adapter.requestShutdown(altered), { message: 'adapter_operation_failed' });
    assert.deepEqual(calls, ['authenticate'], key);
    assert.equal(adapter.state().poisoned, true, key);
  }
});

test('authenticated tuple is copied and frozen, never retained by reference', async () => {
  const { adapter, api, value } = fixture();
  const bound = await adapter.identityAdapter.requestAuthenticatedIdentity();
  const original = { ...bound };
  value.instanceId = 'replacement';
  value.processStart = 'linux:boot:99';
  assert(Object.isFrozen(bound));
  let delivered;
  api.requestAgenCDaemonShutdown = (_host, expected) => { delivered = expected; };
  await adapter.requestShutdown(bound);
  assert.deepEqual(delivered, original);
  assert(Object.isFrozen(delivered));
});

test('unknown thrown values are sanitized without inspecting hostile error properties', async () => {
  let inspected = 0;
  const hostile = Object.defineProperties({}, {
    message: { get() { inspected++; throw new Error('must not inspect'); } },
    safeReason: { get() { inspected++; throw new Error('must not inspect'); } },
  });
  for (const value of [null, undefined, hostile]) {
    const { adapter, api } = fixture();
    api.requestAgenCDaemonInstanceIdentity = () => { throw value; };
    await assert.rejects(adapter.identityAdapter.requestAuthenticatedIdentity(),
      { message: 'adapter_operation_failed' });
    assert.equal(adapter.state().poisoned, true);
    assert.equal(adapter.state().outstanding, false);
  }
  assert.equal(inspected, 0);
});

test('close does not claim to cancel an outstanding bound shutdown', async () => {
  const { adapter, api } = fixture();
  const bound = await adapter.identityAdapter.requestAuthenticatedIdentity();
  const pending = deferred();
  let calls = 0;
  api.requestAgenCDaemonShutdown = () => { calls++; return pending.promise; };
  const request = adapter.requestShutdown(bound);
  await tick();
  adapter.close();
  assert.deepEqual(adapter.state(), {
    poisoned: true, closed: true, outstanding: true, shutdown_started: true,
  });
  pending.resolve();
  await assert.rejects(request, { message: 'adapter_operation_failed' });
  assert.equal(adapter.state().outstanding, false);
  await assert.rejects(adapter.requestShutdown(bound), { message: 'adapter_unavailable' });
  assert.equal(calls, 1);
});
