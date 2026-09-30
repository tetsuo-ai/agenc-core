// Independent defect characterizations of the frozen offline helper only.
// No OS child, client, timer benchmark, provider, filesystem output or network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const source = new URL('../fair-confirmation/real-parent-v3/lifecycle.mjs', import.meta.url);
assert.equal(createHash('sha256').update(readFileSync(source)).digest('hex'),
  'b62c691bfcdf88a78dc5319926bdf632ab1ff49f1022e80264ce919e59a53381',
  'Frozen reviewed helper changed; do not silently repin this characterization');
const { supervise } = await import(source.href);

async function trace(kind) {
  const owner = new EventEmitter();
  Object.assign(owner, { pid: 101, connected: true,
    kill() { assert.fail('Completed synthetic owner must not be signalled'); } });
  return supervise({ arm: 'pi', expectedMessages: 1,
    readyMs: 50, taskMs: 50, closeMs: 50, stopMs: 50, killGraceMs: 20,
    spawnOwner(register) {
      register(owner);
      queueMicrotask(() => {
        owner.emit('spawn');
        owner.emit('message', { kind: 'lifecycle-probe-v3', pid: 101,
          ordinal: 1, connected: true });
        owner.connected = false;
        owner.emit('disconnect');
        if (kind === 'duplicate-exit') owner.emit('exit', 9, null);
        if (kind === 'close-before-exit') {
          owner.emit('close', 0, null);
          owner.emit('exit', 0, null);
        } else {
          owner.emit('exit', 0, null);
          owner.emit('close', 0, null);
        }
      });
    },
    publish() {
      if (kind === 'late-exit') owner.emit('exit', 9, null);
    },
  });
}

test('frozen v3 defect: duplicate exit overwrites earlier failure and returns valid', async () => {
  const result = await trace('duplicate-exit');
  assert.equal(result.valid, true);
  assert.equal(result.owner.code, 0);
  assert.deepEqual(result.issues, []);
});

test('frozen v3 defect: close-before-exit is retrospectively accepted', async () => {
  const result = await trace('close-before-exit');
  assert.equal(result.valid, true);
  assert.equal(result.owner.closed, true);
  assert.deepEqual(result.issues, []);
});

test('frozen v3 defect: late exit during publication returns valid with nonzero owner status', async () => {
  const result = await trace('late-exit');
  assert.equal(result.valid, true);
  assert.equal(result.owner.code, 9);
  assert.equal(result.publication, 'returned');
  assert.deepEqual(result.issues, []);
});

for (const value of [null, undefined]) {
  test(`frozen v3 defect: thrown ${String(value)} loses the sanitized failure result`, async () => {
    await assert.rejects(supervise({ arm: 'pi', expectedMessages: 0,
      spawnOwner() { throw value; } }), TypeError);
  });
}
