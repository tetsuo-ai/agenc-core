import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import test from 'node:test';

const source = readFileSync(new URL('../fair-confirmation/current-initial-preflight-v2/probe.test.ts', import.meta.url), 'utf8');
const sha = text => createHash('sha256').update(text).digest('hex');
assert.equal(sha(source), 'c7ca2913f0515cdeac1302f9267d295bb996901e0492d77baa2390a4dc79d4a6');
const start = source.indexOf('  } catch(error) {\n    primaryFailed=true;primaryCause=error;');
const end = source.indexOf('\n}\n\ndescribe(', start);
assert.ok(start >= 0 && end > start);
const closing = source.slice(start, end).replace('const cleanupErrors:unknown[]=[];', 'const cleanupErrors=[];');
const run = new Function('state', 'work', `return (async()=>{
  const {disposers,sessions,store,kernel}=state;
  let primaryFailed=false,primaryCause;
  try { return await work(); ${closing}
})();`);

test('exact inverse of the reviewed cleanup/comment delta recovers the original source SHA', () => {
  let old = source.replace('  let primaryFailed=false,primaryCause:unknown;\n', '')
    .replace('    // No raw wire body/header capture is exported. The mounted RolloutStore\n    // retains normal synthetic task/conversation events in the private root.',
      '    // Only scalar result evidence leaves the probe. Raw prompt/schema/body\n    // remain in test memory; no captured request is persisted.');
  const from = old.indexOf('  } catch(error) {\n    primaryFailed=true;primaryCause=error;');
  const to = old.indexOf('    // Only new synthetic private roots', from);
  assert.ok(from >= 0 && to > from);
  old = old.slice(0, from) + `  } finally {
    let failed=0;
    for(const dispose of disposers.reverse())try{dispose();}catch{failed++;}
    for(const s of sessions.reverse()) {
      try{await s.shutdown();}catch{failed++;}
      try{s.mountRolloutStore(null);}catch{failed++;}
    }
    try{store?.close();}catch{failed++;}
    try{kernel?.close();}catch{failed++;}
    if(failed)throw new Error("Synthetic preflight cleanup failed");
` + old.slice(to);
  assert.equal(sha(old), '93484f3e6b1e5cd508888b69b3bea8592bea579f62d81eb3e9f89a4dfe91b64b');
});

const order = ['dispose2', 'dispose1', 'shutdown2', 'unmount2', 'shutdown1', 'unmount1', 'store', 'kernel'];
function owned(trace, causes = new Map()) {
  const step = name => { trace.push(name); if (causes.has(name)) throw causes.get(name); };
  return {
    disposers: [() => step('dispose1'), () => step('dispose2')],
    sessions: [1, 2].map(index => ({shutdown: async () => step(`shutdown${index}`), mountRolloutStore: value => {
      assert.equal(value, null); step(`unmount${index}`);
    }})),
    store: {close: () => step('store')}, kernel: {close: () => step('kernel')},
  };
}
async function caught(callback) {
  try { await callback(); } catch (error) { return {failed: true, error}; }
  return {failed: false};
}

test('combined Error and undefined primaries retain exact primary plus every exact cleanup cause', async () => {
  for (const primary of [new Error('primary'), undefined]) {
    const trace = [], causes = new Map(order.map((name, index) => [name, index ? {name} : undefined]));
    const result = await caught(() => run(owned(trace, causes), async () => { throw primary; }));
    assert.equal(result.failed, true);
    assert.ok(result.error instanceof AggregateError);
    assert.equal(result.error.cause, primary);
    assert.deepEqual(result.error.errors, [primary, ...order.map(name => causes.get(name))]);
    assert.deepEqual(trace, order);
  }
});

test('exception objects are not introspected, stringified or awaited during retention', async () => {
  const poison = new Proxy({}, {get() { throw new Error('must not inspect exception'); }});
  const trace = [], result = await caught(() => run(owned(trace, new Map([['store', poison]])), async () => { throw poison; }));
  assert.equal(result.failed, true);
  assert.equal(result.error.cause, poison);
  assert.equal(result.error.errors[0], poison);
  assert.equal(result.error.errors[1], poison);
  assert.equal(result.error.message, 'Synthetic preflight and cleanup failed');
  assert.deepEqual(trace, order);
});

test('single cleanup failure at each position never prevents any independent remaining cleanup', async () => {
  for (const location of order) {
    const trace = [], cause = {}, result = await caught(() => run(owned(trace, new Map([[location, cause]])), async () => 1));
    assert.equal(result.failed, true);
    assert.ok(result.error instanceof AggregateError);
    assert.deepEqual(result.error.errors, [cause]);
    assert.equal(Object.hasOwn(result.error, 'cause'), false);
    assert.deepEqual(trace, order);
  }
});

test('clean teardown preserves original rejection identity including undefined/null and non-Errors', async () => {
  for (const primary of [undefined, null, 0, false, {}, new Error('primary')]) {
    const trace = [], result = await caught(() => run(owned(trace), async () => { throw primary; }));
    assert.equal(result.failed, true); assert.equal(result.error, primary);
    assert.deepEqual(trace, order);
  }
});

test('successful value and partial acquisition remain supported', async () => {
  const result = {}, trace = [];
  assert.equal(await run(owned(trace), async () => result), result);
  assert.deepEqual(trace, order);
  assert.equal(await run({disposers: [], sessions: []}, async () => result), result);
});
