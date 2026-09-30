import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import test from 'node:test';

const source = readFileSync('/private/tmp/light-takeover/fair-confirmation/current-initial-preflight-v2/probe.test.ts', 'utf8');
assert.equal(createHash('sha256').update(source).digest('hex'), '93484f3e6b1e5cd508888b69b3bea8592bea579f62d81eb3e9f89a4dfe91b64b');
const start = source.indexOf('  } finally {\n    let failed=0;');
const end = source.indexOf('\n}\n\ndescribe(', start);
assert.ok(start >= 0 && end > start);
const cleanup = source.slice(start + '  } finally {'.length, end);
assert.ok(cleanup.trimEnd().endsWith('}'));
const body = cleanup.slice(0, cleanup.lastIndexOf('}'));
// Extract the exact frozen finally body. Only inert callbacks are supplied;
// this does not import Core or launch the actual fixture/SQLite/provider.
const run = new Function('state', 'work', `
  return (async()=>{
    const {disposers,sessions,store,kernel}=state;
    try { return await work(); } finally { ${body} }
  })();
`);

function state(trace, fail = false) {
  return {
    disposers: [() => trace.push('unsubscribe')],
    sessions: [{ shutdown: async () => { trace.push('shutdown'); if (fail) throw new Error('cleanup marker'); }, mountRolloutStore: () => trace.push('unmount') }],
    store: { close: () => trace.push('store') },
    kernel: { close: () => trace.push('kernel') },
  };
}

for (const primary of [new Error('primary marker'), undefined]) {
  test(`combined failure preserves primary ${primary === undefined ? 'undefined' : 'Error'} while attempting all cleanup`, async () => {
    const trace = [];
    let caught;
    try { await run(state(trace, true), async () => { throw primary; }); } catch (error) { caught = error; }
    assert.deepEqual(trace, ['unsubscribe', 'shutdown', 'unmount', 'store', 'kernel']);
    assert.ok(caught instanceof AggregateError, 'combined failure must retain primary and teardown causes');
    assert.equal(caught.errors[0], primary);
  });
}

test('control: successful cleanup retains exact primary identity', async () => {
  const trace = [], primary = { marker: true };
  let caught;
  try { await run(state(trace), async () => { throw primary; }); } catch (error) { caught = error; }
  assert.equal(caught, primary);
  assert.deepEqual(trace, ['unsubscribe', 'shutdown', 'unmount', 'store', 'kernel']);
});

test('control: successful body retains its value and every cleanup runs', async () => {
  const trace = [];
  assert.equal(await run(state(trace), async () => 17), 17);
  assert.deepEqual(trace, ['unsubscribe', 'shutdown', 'unmount', 'store', 'kernel']);
});
