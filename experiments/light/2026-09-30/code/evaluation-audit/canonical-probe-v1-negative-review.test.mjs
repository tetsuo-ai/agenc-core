// Frozen-defect characterization only: passing tests confirm v1's false-positive
// negative-case classifications. Do not repin this file to a successor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { runCase } from '../fair-confirmation/real-parent-canonical-probe-v1/control.mjs';
import { SOURCE_REVISION } from '../fair-confirmation/real-parent-adapters-v1/pins.mjs';
const source = new URL('../fair-confirmation/real-parent-canonical-probe-v1/control.mjs', import.meta.url);
assert.equal(createHash('sha256').update(readFileSync(source)).digest('hex'),
  'b793d533ed4ea589ba343694770c68a250b63d878a30d986bb7d6f8b8762ae73');

class Child extends EventEmitter {
  constructor() { super(); this.pid = 401; this.connected = true; }
  finish(code, signal = null, closeCode = code) {
    this.connected = false; this.emit('disconnect');
    this.emit('exit', code, signal); this.emit('close', closeCode, signal);
  }
  kill(signal) { queueMicrotask(() => this.finish(null, signal)); return true; }
  unexpectedValidMessage() {
    this.emit('message', { kind: 'lifecycle-probe-v5', ordinal: 1, pid: this.pid, connected: true });
  }
}
function fixture(caseName) {
  const owner = new Child();
  const tuple = { pid: owner.pid, instanceId: 'review-owner', processStart: 'linux:boot:99',
    runtimeVersion: 'review', commit: SOURCE_REVISION, buildTime: 'review' };
  let cookie = true;
  const api = {
    readDaemonRuntimeInfo: () => ({ ...tuple }),
    daemonInstanceIdentityFromRuntimeInfo: value => value,
    resolveAgenCDaemonRuntimeInfoPath: home => `${home}/daemon-runtime.json`,
    readAgenCDaemonProcessStart: () => tuple.processStart,
    isAgenCDaemonInstanceIdentity: value => !!value && Object.keys(tuple).every(key => typeof value[key] === typeof tuple[key]),
    sameAgenCDaemonInstanceIdentity: (a, b) => Object.keys(tuple).every(key => a[key] === b[key]),
    requestAgenCDaemonInstanceIdentity() {
      if (!cookie) throw new Error('daemon connection authentication failed');
      return { ...tuple };
    },
    requestAgenCDaemonShutdown() { owner.finish(0); },
    resolveAgenCDaemonHome: env => env.AGENC_HOME,
    resolveAgenCDaemonRequestTimeoutMs: env => Number(env.AGENC_DAEMON_REQUEST_TIMEOUT_MS),
  };
  const input = { caseName, api, expectedBuild: tuple,
    daemonHome: '/synthetic/review/daemon', userHome: '/synthetic/review/user', platform: 'linux',
    readyMs: 70, operationMs: 50, requestMs: 5, taskMs: 10, stopMs: 10,
    closeMs: 5, killGraceMs: 5, drainMs: 10,
    spawnOwner(register) { register(owner); queueMicrotask(() => owner.emit('spawn')); },
    spawnSentinel() { throw new Error('sentinel must not run'); },
    corruptFreshCookie() { cookie = false; },
  };
  return { owner, input, api };
}

test('v1 incorrectly passes early-exit case despite a well-shaped unexpected IPC message', async () => {
  const f = fixture('owner-exit-before-readiness');
  f.input.spawnOwner = register => { register(f.owner); queueMicrotask(() => {
    f.owner.emit('spawn'); f.owner.unexpectedValidMessage(); f.owner.finish(73);
  }); };
  const result = await runCase(f.input);
  assert.equal(result.lifecycle.message_count, 1);
  assert(result.lifecycle.issues.includes('message_count_mismatch'));
  assert.equal(result.case_pass, true); // Defect: zero messages required.
});

test('v1 incorrectly passes authentication-refusal case despite unexpected well-shaped IPC', async () => {
  const f = fixture('authenticated-identity-refusal');
  const canonical = f.api.requestAgenCDaemonInstanceIdentity;
  f.api.requestAgenCDaemonInstanceIdentity = () => {
    f.owner.unexpectedValidMessage(); return canonical();
  };
  const result = await runCase(f.input);
  assert.equal(result.lifecycle.message_count, 1);
  assert(result.lifecycle.issues.includes('message_count_mismatch'));
  assert.equal(result.case_pass, true); // Defect: unrelated channel activity.
});

test('v1 incorrectly passes early-exit case despite inconsistent exit and close status', async () => {
  const f = fixture('owner-exit-before-readiness');
  f.input.spawnOwner = register => { register(f.owner); queueMicrotask(() => {
    f.owner.emit('spawn'); f.owner.finish(73, null, 9);
  }); };
  const result = await runCase(f.input);
  assert.equal(result.lifecycle.owner.lifecycle_invalid, true);
  assert(result.lifecycle.issues.includes('owner_exit_close_mismatch'));
  assert.equal(result.case_pass, true); // Defect: close is not valid lifecycle proof.
});

test('v1 incorrectly passes authentication-refusal case despite inconsistent forced-close status', async () => {
  const f = fixture('authenticated-identity-refusal');
  f.owner.kill = signal => { queueMicrotask(() => f.owner.finish(null, signal, 9)); return true; };
  const result = await runCase(f.input);
  assert.equal(result.lifecycle.owner.lifecycle_invalid, true);
  assert(result.lifecycle.issues.includes('owner_exit_close_mismatch'));
  assert.equal(result.case_pass, true); // Defect: expected refusal cannot waive terminal mismatch.
});
