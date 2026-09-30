import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { financialPolicyId, createFinancialJournal } from './journal.mjs';
import { createFinancialOwner } from './owner.mjs';
import { ledgerExposure } from '../luna-finance-v1/accounting.mjs';
import { parseLedgerBytes } from '../luna-finance-v1/ledger-json.mjs';

const credit = Object.freeze({ mode: 'credit_exhaustion' });
const capped = capUsd => ({ mode: 'positive_cap', capUsd });
const raw = Buffer.from('{}');
function setup(spendPolicy, { initial = Buffer.alloc(0), taskCallCap = 3 } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'luna-finance-mode-')));
  fs.chmodSync(root, 0o700);
  const ledger = path.join(root, 'luna-api-ledger.jsonl');
  fs.writeFileSync(ledger, initial, { flag: 'wx', mode: 0o600 });
  const r = fs.statSync(root, { bigint: true }), j = fs.statSync(ledger, { bigint: true });
  const config = { root, runId: 'mode-test', taskCallCap, spendPolicy, policyId: financialPolicyId(spendPolicy),
    inventory: { rootDev: String(r.dev), rootIno: String(r.ino), journalDev: String(j.dev), journalIno: String(j.ino),
      prefixBytes: initial.length, prefixSha256: createHash('sha256').update(initial).digest('hex') } };
  return { root, ledger, config, owner: createFinancialOwner(config),
    read: () => fs.readFileSync(ledger), exposure: () => ledgerExposure(parseLedgerBytes(fs.readFileSync(ledger)), { policyId: config.policyId }) };
}
function known(call, input = 100, output = 20) {
  call.headers(200, 'text/event-stream');
  const response = { id: 'synthetic-response', model: 'gpt-6-luna', status: 'in_progress' };
  call.push(Buffer.from('data: ' + JSON.stringify({ type: 'response.created', response }) + '\n\n' +
    'data: ' + JSON.stringify({ type: 'response.completed', response: { ...response, status: 'completed',
      usage: { input_tokens: input, output_tokens: output, total_tokens: input + output,
        input_tokens_details: { cached_tokens: 0 } } } }) + '\n\n'));
  return call.finish('eof');
}

test('mode is explicit and closed: no default, implicit zero, Infinity or disguised cap', () => {
  for (const invalid of [undefined, null, 0, '0', Infinity, {}, [], { mode: 'other' },
    { mode: 'positive_cap' }, capped('0'), capped('0.000'), capped('Infinity'), capped(Infinity),
    { mode: 'credit_exhaustion', capUsd: '0' }, { mode: 'credit_exhaustion', capUsd: '99999999' },
    { mode: 'credit_exhaustion', extra: false }, { ...capped('1'), extra: false }]) {
    assert.throws(() => financialPolicyId(invalid));
  }
  assert.notEqual(financialPolicyId(credit), financialPolicyId(capped('1')));
  assert.notEqual(financialPolicyId(capped('1')), financialPolicyId(capped('2')));
  assert.equal(financialPolicyId(capped('0.1')), financialPolicyId(capped('0.1000')));
});

test('credit mode skips only monetary cap; reservations still accumulate and task cap applies', () => {
  const finite = setup(capped('0.001'));
  assert.throws(() => finite.owner.admit(raw, 8192)); assert.equal(finite.read().length, 0);
  const t = setup(credit, { taskCallCap: 2 });
  const a = t.owner.admit(raw, 8192), b = t.owner.admit(raw, 8192);
  assert.equal(t.exposure().exposure, BigInt(a.reservedNanodollars) + BigInt(b.reservedNanodollars));
  assert.equal(t.exposure().unsettledAdmissions, 2);
  assert.throws(() => t.owner.admit(raw, 8192));
  known(a); known(b);
  assert.equal(t.exposure().unsettledAdmissions, 0); assert.equal(t.exposure().exposure, 40000n);
});

test('credit mode unknown settlement persists full hold/stop and refuses new owner admission', () => {
  const t = setup(credit), call = t.owner.admit(raw, 8192);
  const receipt = call.finish('fetch_error');
  assert.equal(receipt.state, 'unknown_hold_committed');
  assert.equal(t.exposure().exposure, BigInt(call.reservedNanodollars));
  assert.equal(t.exposure().unknownUsageSettlements, 1);
  const stop = path.join(t.root, 'luna-api-stop.json'), original = fs.readFileSync(stop), before = t.read();
  const restart = createFinancialOwner({ ...t.config, runId: 'new-identity' });
  assert.throws(() => restart.admit(raw, 8192));
  assert.deepEqual(t.read(), before); assert.deepEqual(fs.readFileSync(stop), original);
});

test('credit mode still counts full over-reserve known usage and stops', () => {
  const t = setup(credit), call = t.owner.admit(raw, 8192);
  const result = known(call, 1_000_000, 1);
  assert.equal(result.state, 'known_charge_committed');
  assert.equal(result.chargeNanodollars, '200000750');
  assert.equal(result.stopPresent, true); assert.equal(t.owner.isBlocked(), true);
  assert.equal(t.exposure().exposure, 200000750n);
});

test('mode transition cannot relabel existing modern history or reset exposure', () => {
  const t = setup(capped('0.1')); known(t.owner.admit(raw, 8192));
  const before = t.read();
  const other = createFinancialOwner({ ...t.config, runId: 'other-run', spendPolicy: credit, policyId: financialPolicyId(credit) });
  assert.throws(() => other.admit(raw, 8192)); assert.deepEqual(t.read(), before);
  assert.equal(fs.existsSync(path.join(t.root, 'luna-api-admission.lock')), true);
});

test('credit mode preserves original legacy outstanding bytes and counts the hold, not a refund', () => {
  const initial = Buffer.from('{"event":"admit","id":"historical:1","run":"historical","call":1,"reserve":1}\n');
  const t = setup(credit, { initial }), call = t.owner.admit(raw, 8192);
  assert.deepEqual(t.read().subarray(0, initial.length), initial);
  assert.equal(t.exposure().exposure, 1_000_000_000n + BigInt(call.reservedNanodollars));
  assert.equal(t.exposure().unsettledAdmissions, 2);
  known(call);
  assert.equal(t.exposure().unsettledAdmissions, 1);
  assert.equal(t.exposure().exposure, 1_000_020_000n);
  assert.equal(String(fs.statSync(t.ledger, { bigint: true }).ino), t.config.inventory.journalIno);
  // Accounting compatibility alone is not authorization to run past a prior
  // unknown attempt: root/cell reconciliation remains a separate prerequisite.
});

test('credit mode retains an existing foreign lock and old stop unchanged', () => {
  for (const marker of ['luna-api-admission.lock', 'luna-api-stop.json']) {
    const t = setup(credit), filename = path.join(t.root, marker), sentinel = Buffer.from('original-marker');
    if (marker.endsWith('.lock')) { fs.mkdirSync(filename); fs.writeFileSync(path.join(filename, 'foreign'), sentinel); }
    else fs.writeFileSync(filename, sentinel);
    assert.throws(() => t.owner.admit(raw, 8192));
    assert.equal(t.read().length, 0);
    assert.deepEqual(fs.readFileSync(marker.endsWith('.lock') ? path.join(filename, 'foreign') : filename), sentinel);
  }
});

test('policy normalization rejects accessors, hidden fields, symbols and proxies without executing them', () => {
  let reads = 0;
  const accessor = { mode: 'positive_cap', get capUsd() { reads++; return reads === 1 ? '0.1' : '0.001'; } };
  const t = setup(capped('0.001'));
  assert.throws(() => createFinancialJournal({ ...t.config, spendPolicy: accessor }));
  assert.equal(reads, 0); assert.equal(t.read().length, 0);
  const hidden = Object.defineProperty({ mode: 'credit_exhaustion' }, 'capUsd', { value: '0' });
  const symbol = { mode: 'credit_exhaustion', [Symbol('hidden')]: '0' };
  const proxy = new Proxy({ mode: 'credit_exhaustion' }, { ownKeys() { reads++; throw new Error('must not inspect'); } });
  const inherited = Object.create({ mode: 'credit_exhaustion' });
  for (const invalid of [accessor, hidden, symbol, proxy, inherited]) assert.throws(() => financialPolicyId(invalid));
  assert.equal(reads, 0);
  assert.equal(financialPolicyId(Object.assign(Object.create(null), credit)), financialPolicyId(credit));
});

test('normalized cap and policy remain fixed after caller mutates the original selection', () => {
  const selection = capped('0.001'), t = setup(selection);
  selection.capUsd = '100'; selection.mode = 'credit_exhaustion';
  assert.throws(() => t.owner.admit(raw, 8192)); assert.equal(t.read().length, 0);
});
