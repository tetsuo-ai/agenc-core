import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Exercise the exact fixture catch/finally source without importing Core or
// creating any provider, Session, SQLite database, or filesystem fixture.
const source = readFileSync(new URL('./probe.test.ts', import.meta.url), 'utf8');
assert.ok(source.includes('let primaryFailed=false,primaryCause:unknown;'));
const start = source.indexOf('  } catch(error) {\n    primaryFailed=true;primaryCause=error;');
const end = source.indexOf('\n}\n\ndescribe(', start);
assert.ok(start >= 0 && end > start);
// Erase only the TypeScript unknown[] annotation; preserve executable source.
const closing = source.slice(start, end).replace('const cleanupErrors:unknown[]=[];', 'const cleanupErrors=[];');
const run = new Function('state', 'work', `return (async()=>{
  const {disposers,sessions,store,kernel}=state;
  let primaryFailed=false,primaryCause;
  try { return await work(); ${closing}
})();`);

function owned(trace, failures = new Set(), errors = new Map()) {
  const step = name => { trace.push(name); if (failures.has(name)) throw errors.get(name); };
  return {
    disposers: [() => step('unsubscribe1'), () => step('unsubscribe2')],
    sessions: [
      { shutdown: async () => step('shutdown1'), mountRolloutStore: () => step('unmount1') },
      { shutdown: async () => step('shutdown2'), mountRolloutStore: () => step('unmount2') },
    ],
    store: { close: () => step('store') }, kernel: { close: () => step('kernel') },
  };
}
const all = ['unsubscribe2', 'unsubscribe1', 'shutdown2', 'unmount2', 'shutdown1', 'unmount1', 'store', 'kernel'];
const primaryValues = [new Error('synthetic primary'), undefined, null, { synthetic: true }, 'synthetic marker'];
for (const [index, primary] of primaryValues.entries()) {
  test(`combined failure retains exact primary cause ${index} and attempts every failing cleanup`, async () => {
    const trace = [], errors = new Map(all.map(name => [name, new Error('synthetic private cleanup detail')]));
    await assert.rejects(run(owned(trace, new Set(all), errors), async () => { throw primary; }), error => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.cause, primary); assert.equal(error.errors[0], primary);
      assert.equal(error.errors.length, 1 + all.length);
      assert.equal(error.message, 'Synthetic preflight and cleanup failed');
      all.forEach((name, index) => assert.equal(error.errors[index + 1], errors.get(name)));
      return true;
    });
    assert.deepEqual(trace, all);
  });
  test(`successful cleanup preserves exact original thrown value ${index}`, async () => {
    const trace = []; let rejected = false;
    try { await run(owned(trace), async () => { throw primary; }); }
    catch (error) { rejected = true; assert.equal(error, primary); }
    assert.equal(rejected, true); assert.deepEqual(trace, all);
  });
}
test('cleanup-only failure is surfaced sanitized, and later cleanup is still attempted', async () => {
  for (const failure of all) {
    const trace = [], cleanupCause = { synthetic: true };
    await assert.rejects(run(owned(trace, new Set([failure]), new Map([[failure, cleanupCause]])), async () => 17), error => {
      assert.equal(error.constructor, AggregateError);
      assert.equal(error.message, 'Synthetic preflight cleanup failed');
      assert.equal(Object.hasOwn(error, 'cause'), false);
      assert.equal(error.errors.length, 1); assert.equal(error.errors[0], cleanupCause);
      return true;
    });
    assert.deepEqual(trace, all);
  }
});
test('success retains exact return identity and partial setup handles missing resources', async () => {
  const trace = [], result = { synthetic: 17 };
  assert.equal(await run(owned(trace), async () => result), result);
  assert.deepEqual(trace, all);
  assert.equal(await run({ disposers: [], sessions: [] }, async () => result), result);
});
