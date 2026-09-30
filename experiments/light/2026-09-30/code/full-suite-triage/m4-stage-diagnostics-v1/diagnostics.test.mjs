import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createCollector, createEmitter, createLocalProbe, observeSdkAttempt,
  observeMarkerWait, LIMITS, mark } from './diagnostics.mjs';
import { proposedSources, PINS } from './proposal.mjs';

function fixture(scope, stages) {
  const chunks = [];
  let tick = 0;
  const emitter = createEmitter(scope, {
    write: bytes => { chunks.push(bytes); return bytes.length; },
    clock: () => BigInt(++tick * 1_000_000),
    cpu: () => ({ user: tick * 100, system: tick * 10 }),
  });
  for (const stage of stages) assert.equal(emitter.mark(stage), true);
  return Buffer.concat(chunks);
}
function report(scope, bytes) {
  const collector = createCollector(scope);
  collector.push(bytes);
  collector.end();
  return collector.report();
}
const early = ['node_preload', 'fixture_entry', 'paths_ready', 'crash_dispatch',
  'reservation_imports_start', 'reservation_imports_ready', 'kernel_ready',
  'journal_bound', 'acquire_start'];

test('no preload means import/mark does no I/O', () => assert.equal(mark('fixture_entry'), false));
for (let count = 1; count <= early.length; count++) {
  test(`early boundary prefix ${count} states observation, not cause or durability proof`, () => {
    const actual = report('crash', fixture('crash', early.slice(0, count)));
    assert.equal(actual.evidence, 'observed_prefix_only');
    assert.equal(actual.lastObserved, early[count - 1]);
    assert.equal(actual.cause, 'not_established');
    assert.equal(actual.segments.length, count - 1);
    if (count > 1) assert.deepEqual(actual.segments[0], {
      from: 'node_preload', to: 'fixture_entry', wallMs: 1, cpuUserUs: 100, cpuSystemUs: 10,
    });
  });
}
test('recover and daemon stages remain distinct; no SDK inference from main_start', () => {
  assert.equal(report('recover', fixture('recover', [
    'node_preload', 'fixture_entry', 'paths_ready', 'recover_start', 'recover_done',
  ])).lastObserved, 'recover_done');
  const daemon = report('daemon', fixture('daemon', ['node_preload', 'daemon_entry', 'main_start']));
  assert.equal(daemon.lastObserved, 'main_start');
  assert.equal(daemon.cause, 'not_established');
});
test('byte-split framing retains exact numeric stages', () => {
  const collector = createCollector('crash');
  for (const byte of fixture('crash', early)) collector.push(Buffer.from([byte]));
  collector.end();
  assert.equal(collector.report().lastObserved, 'acquire_start');
});
test('no EOF, absent, truncated, duplicate/extra JSON fields are unknown', () => {
  const bytes = fixture('crash', early);
  const collector = createCollector('crash'); collector.push(bytes);
  assert.equal(collector.report().evidence, 'unknown');
  for (const value of [Buffer.alloc(0), bytes.subarray(0, -1),
    Buffer.from(bytes.toString().replace('"v":1', '"v":1,"v":1')),
    Buffer.from(bytes.toString().replace('"v":1', '"secret":"do-not-print","v":1'))]) {
    const result = report('crash', value);
    assert.equal(result.evidence, 'unknown');
    assert.equal(result.lastObserved, null);
    assert(!JSON.stringify(result).includes('do-not-print'));
  }
});
test('invalid UTF8, bad scalar types, nonfinite, wrong sequence/scope/clock all unknown', () => {
  const bytes = fixture('crash', early.slice(0, 2));
  for (const value of [Buffer.from([255, 10]),
    Buffer.from(bytes.toString().replace('"seq":0', '"seq":false')),
    Buffer.from(bytes.toString().replace('"user":100', '"user":1e999')),
    Buffer.from(bytes.toString().replace('"seq":1', '"seq":0')),
    Buffer.from(bytes.toString().replace('"scope":"crash"', '"scope":"recover"')),
    Buffer.from(bytes.toString().replace('"ns":"2000000"', '"ns":"0"')),
    Buffer.from(bytes.toString().replace('"user":200', '"user":0'))]) {
    assert.equal(report('crash', value).evidence, 'unknown');
  }
});
test('out of order, skipped, duplicate and post-terminal stages reject', () => {
  for (const stages of [['fixture_entry'], ['node_preload', 'paths_ready'],
    ['node_preload', 'node_preload']]) {
    assert.equal(report('crash', fixture('crash', stages)).evidence, 'unknown');
  }
  assert.equal(report('sdk', fixture('sdk', ['connect_start', 'connect_ready', 'connect_start'])).evidence, 'unknown');
});
test('collector count/byte/line ceilings and late writes fail closed', () => {
  for (const bytes of [Buffer.alloc(LIMITS.bytes + 1), Buffer.alloc(LIMITS.line)]) {
    assert.equal(report('crash', bytes).evidence, 'unknown');
  }
  const collector = createCollector('crash');
  collector.push(fixture('crash', ['node_preload'])); collector.end();
  collector.push(Buffer.alloc(0)); assert.equal(collector.report().evidence, 'unknown');
  const local = createLocalProbe('sdk');
  for (let i = 0; i <= LIMITS.records / 2; i++) {
    local.emitter.mark('connect_start'); local.emitter.mark('connect_error');
  }
  assert.equal(local.finish().evidence, 'unknown');
});
test('bad scope and arbitrary stage/payload never serialize caller input', () => {
  assert.throws(() => createEmitter('secret'), /invalid diagnostic scope/);
  const chunks = [];
  const emitter = createEmitter('sdk', { write: b => { chunks.push(b); return b.length; } });
  assert.equal(emitter.mark({ secret: 'private' }), false);
  assert.equal(chunks.length, 0);
});
for (const failure of ['throw', 'short']) {
  test(`observer ${failure} failure disables writes without changing SDK value or errors`, async () => {
    let writes = 0;
    const emitter = createEmitter('sdk', { write() {
      writes++; if (failure === 'throw') throw new Error('secret'); return 0;
    } });
    const value = {};
    assert.equal(await observeSdkAttempt(emitter, async () => value), value);
    assert.equal(writes, 1);
    assert.deepEqual(emitter.status(), { emitted: 0, disabled: true });
    try { await observeSdkAttempt(emitter, async () => { throw null; }); assert.fail(); }
    catch (error) { assert.equal(error, null); }
  });
}
test('SDK failures have no message leakage; same operation/options/error identity, no retry', async () => {
  const probe = createLocalProbe('sdk');
  const error = new Error('private socket path and cookie');
  let calls = 0;
  await assert.rejects(observeSdkAttempt(probe.emitter, async () => { calls++; throw error; }), e => e === error);
  const value = {};
  assert.equal(await observeSdkAttempt(probe.emitter, async () => { calls++; return value; }), value);
  const result = probe.finish();
  assert.equal(calls, 2); assert.equal(result.attempts, 2);
  assert.equal(result.lastObserved, 'connect_ready');
  assert(!JSON.stringify(result).includes('private'));
});
test('marker timeout and success preserve outcome; no timer or retry installed', async () => {
  for (const rejects of [false, true]) {
    const probe = createLocalProbe('marker');
    const sentinel = {};
    let calls = 0;
    try {
      const result = await observeMarkerWait(probe.emitter, async () => {
        calls++; if (rejects) throw sentinel; return sentinel;
      });
      assert.equal(rejects, false); assert.equal(result, sentinel);
    } catch (error) { assert.equal(rejects, true); assert.equal(error, sentinel); }
    assert.equal(calls, 1);
    assert.equal(probe.finish().lastObserved, rejects ? 'wait_error' : 'marker_observed');
  }
});
test('SDK renderer bounded to last32 intervals without changing total attempts', () => {
  const stages = Array.from({ length: 100 }, () => ['connect_start', 'connect_error']).flat();
  const result = report('sdk', fixture('sdk', stages));
  assert.equal(result.attempts, 100); assert.equal(result.segments.length, 32);
  assert.equal(result.segmentCount, 199);
});

// Read-only source binding. No dynamic import of Core, processes, sockets or suites.
const root = '/private/tmp/light-takeover/startup-core/runtime/tests/durability/';
const input = {
  parent: readFileSync(root + 'failure-matrix.acceptance.test.ts', 'utf8'),
  child: readFileSync(root + 'fixtures/m4-failure-matrix-child.ts', 'utf8'),
  daemon: readFileSync(root + 'fixtures/daemon-main-child.ts', 'utf8'),
};
test('proposal applies only to exact three source preimages; never modifies disk', () => {
  const output = proposedSources(input);
  for (const key of Object.keys(input)) {
    assert.equal(createHash('sha256').update(input[key]).digest('hex'), PINS[key]);
    assert.notEqual(output[key], input[key]);
    assert.throws(() => proposedSources({ ...input, [key]: input[key] + '\n' }), /preimage mismatch/);
  }
  assert.equal(readFileSync(root + 'failure-matrix.acceptance.test.ts', 'utf8'), input.parent);
});
test('source proposal retains original deadlines, boundary assertions, SDK policy and static Session', () => {
  const output = proposedSources(input);
  const marker = text => text.slice(text.indexOf('async function waitForMarker('), text.indexOf('async function crashAt('));
  const boundary = text => text.slice(text.indexOf('function verifyBoundary('), text.indexOf('describe.sequential('));
  assert(marker(input.parent).length > 100);
  assert(boundary(input.parent).length > 100);
  assert.equal(marker(output.parent), marker(input.parent));
  assert.equal(boundary(output.parent), boundary(input.parent));
  for (const exact of ['const deadline = Date.now() + 20_000;', 'readyTimeoutMs: 250,',
    'requestTimeoutMs: 5_000,', 'autostart: false,', '{ timeout: 120_000 }',
    '    verifyBoundary(failpoint, report);', '    await verifyFreshDaemonSdk(failpoint, stateDirectory);']) {
    assert(input.parent.includes(exact));
    assert.equal(output.parent.split(exact).length, input.parent.split(exact).length);
  }
  assert(output.child.includes('import { Session } from "../../../src/session/session.js";'));
  assert.equal((output.parent.match(/DIAGNOSTIC_PRELOAD,/g) || []).length, 3);
  assert.equal((output.parent.match(/"pipe", "pipe", "pipe"/g) || []).length, 3);
  assert(output.parent.includes('stateDirectory, 1)'));
  assert(output.parent.includes('stateDirectory, 2)'));
  // Recovery stays exactly one stdout JSON line, failpoint implementation untouched.
  assert.equal((output.child.match(/process.stdout.write/g) || []).length, 1);
  assert(output.child.includes('JSON.stringify(report)}\\n`'));
});
