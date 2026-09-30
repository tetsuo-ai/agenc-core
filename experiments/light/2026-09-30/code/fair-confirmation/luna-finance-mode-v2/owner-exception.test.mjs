// Isolated fault injection only. Run with --experimental-test-module-mocks.
// The production owner exposes no replacement terminal/helper capability.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { financialPolicyId } from './journal.mjs';

let finishBehavior;
let createBehavior = () => ({ push() {}, finish: () => finishBehavior() });
mock.module('../luna-terminal-v1/terminal.mjs', {
  exports: { createResponsesTerminal: (...args) => createBehavior(...args) },
});
const { createFinancialOwner } = await import('./owner.mjs');

function setup({ headers = true } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'luna-owner-fault-')));
  fs.chmodSync(root, 0o700);
  const ledger = path.join(root, 'luna-api-ledger.jsonl');
  fs.writeFileSync(ledger, '', { flag: 'wx', mode: 0o600 });
  const r = fs.statSync(root, { bigint: true }), j = fs.statSync(ledger, { bigint: true });
  const owner = createFinancialOwner({ root, runId: 'synthetic-fault', taskCallCap: 3,
    spendPolicy: { mode: 'positive_cap', capUsd: '0.1' }, policyId: financialPolicyId({ mode: 'positive_cap', capUsd: '0.1' }),
    inventory: { rootDev: String(r.dev), rootIno: String(r.ino), journalDev: String(j.dev), journalIno: String(j.ino),
      prefixBytes: 0, prefixSha256: createHash('sha256').update('').digest('hex') } });
  const call = owner.admit(Buffer.from('{}'), 8192);
  if (headers) call.headers(200, 'text/event-stream');
  return { owner, call, ledger };
}

for (const [name, behavior, expected] of [
  ['helper throws exact Error', () => { throw sentinel; }, () => sentinel],
  ['helper throws undefined', () => { throw undefined; }, () => undefined],
  ['invalid exact charge conversion', () => ({ state: 'known', chargeNanos: 'not-an-integer' }), null],
]) {
  test('pre-commit failure blocks later calls: ' + name, () => {
    const { owner, call, ledger } = setup();
    const before = fs.readFileSync(ledger);
    finishBehavior = behavior;
    let threw = false, caught;
    try { call.finish('eof'); } catch (cause) { threw = true; caught = cause; }
    assert.equal(threw, true);
    if (expected) assert.equal(caught, expected());
    assert.equal(owner.isBlocked(), true);
    assert.throws(() => call.finish('eof'));
    assert.throws(() => owner.admit(Buffer.from('{}'), 8192));
    assert.deepEqual(fs.readFileSync(ledger), before);
    assert.equal(before.toString().trim().split('\n').length, 1); // durable outstanding hold, no invented settlement
  });
}
const sentinel = new Error('synthetic terminal helper failure');

for (const location of ['headers', 'push']) {
  test(location + ' evidence failure stays unknown even if caller catches it', () => {
    let constructions = 0, finishes = 0;
    createBehavior = () => {
      constructions++;
      if (location === 'headers') throw sentinel;
      return { push() { throw sentinel; }, finish() { finishes++; throw new Error('must not be reached'); } };
    };
    const { owner, call, ledger } = setup({ headers: false });
    if (location === 'push') call.headers(200, 'text/event-stream');
    let caught;
    try {
      if (location === 'headers') call.headers(200, 'text/event-stream');
      else call.push(Buffer.from('synthetic'));
    } catch (cause) { caught = cause; }
    assert.equal(caught, sentinel);
    assert.equal(owner.isBlocked(), true);
    assert.throws(() => owner.admit(Buffer.from('{}'), 8192));
    call.headers(200, 'text/event-stream'); // cannot replace the failed evidence
    const result = call.finish('eof');
    assert.equal(result.state, 'unknown_hold_committed');
    assert.equal(result.chargeNanodollars, call.reservedNanodollars);
    assert.equal(result.stopPresent, true);
    assert.equal(constructions, 1); assert.equal(finishes, 0);
    const rows = fs.readFileSync(ledger, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(rows.length, 2); assert.equal(rows[1].usage_missing, true);
    assert.equal(Object.hasOwn(rows[1], 'settlement_proof'), false);
    assert.equal(call.finish('eof'), result);
  });
}

