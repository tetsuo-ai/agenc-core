// Independent frozen-candidate review. Synthetic private roots only; no sends.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createFinancialJournal, financialPolicyId } from '../fair-confirmation/luna-finance-mode-v2/journal.mjs';
import { PRICE_ID } from '../fair-confirmation/luna-finance-v1/accounting.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
assert.equal(sha(fs.readFileSync(new URL('../fair-confirmation/luna-finance-mode-v2/journal.mjs', import.meta.url))),
  '2c9babd098d5f5a3b38ecfa893e23a88369fb0832b6ffa8f111c1efba569e514');

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'luna-mode-review-')));
  const ledger = path.join(root, 'luna-api-ledger.jsonl');
  fs.writeFileSync(ledger, '', { flag: 'wx', mode: 0o600 });
  const r = fs.statSync(root, { bigint: true }), j = fs.statSync(ledger, { bigint: true });
  return { root, ledger, inventory: {
    rootDev: String(r.dev), rootIno: String(r.ino), journalDev: String(j.dev), journalIno: String(j.ino),
    prefixBytes: 0, prefixSha256: sha(''),
  } };
}
const cap = capUsd => ({ mode: 'positive_cap', capUsd });
const admission = policyId => Buffer.from(JSON.stringify({
  event: 'admit', id: 'review:1', run: 'review', call: 1, reserve: 0.01,
  financial_schema: 1, financial_policy_id: policyId, price_id: PRICE_ID, reserve_nanos: '10000000',
}) + '\n');

test('reject a getter selection whose first enforced cap differs from its later hashed cap', () => {
  const t = fixture(), policyId = financialPolicyId(cap('0.001'));
  let reads = 0;
  const spendPolicy = { mode: 'positive_cap', get capUsd() { return ++reads === 1 ? '0.1' : '0.001'; } };
  assert.throws(() => {
    const writer = createFinancialJournal({ ...t, policyId, spendPolicy });
    writer.commit(admission(policyId));
  }, 'A 0.01 reservation must not be accepted under the policy ID for a 0.001 cap');
  assert.equal(fs.readFileSync(t.ledger).length, 0);
});

test('credit mode rejects a supplied non-enumerable cap key rather than ignoring it', () => {
  const spendPolicy = Object.defineProperty({ mode: 'credit_exhaustion' }, 'capUsd', { value: '0' });
  assert.throws(() => financialPolicyId(spendPolicy));
});

test('control: a stable plain positive cap still refuses an excessive admission', () => {
  const t = fixture(), spendPolicy = cap('0.001'), policyId = financialPolicyId(spendPolicy);
  const writer = createFinancialJournal({ ...t, spendPolicy, policyId });
  assert.throws(() => writer.commit(admission(policyId)));
  assert.equal(fs.readFileSync(t.ledger).length, 0);
});

test('control: an ordinary declaration changed after construction cannot change the captured cap', () => {
  const t = fixture(), spendPolicy = cap('0.001'), policyId = financialPolicyId(spendPolicy);
  const writer = createFinancialJournal({ ...t, spendPolicy, policyId });
  spendPolicy.capUsd = '0.1'; spendPolicy.mode = 'credit_exhaustion';
  assert.throws(() => writer.commit(admission(policyId)));
  assert.equal(fs.readFileSync(t.ledger).length, 0);
});
