import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ledgerExposure, usageCharge, PRICE_ID, TERMINAL_PROOF } from './accounting.mjs';
import { parseLedgerBytes } from './ledger-json.mjs';
const policyId = 'a'.repeat(64);
const rawRows = rows => parseLedgerBytes(Buffer.from(rows.map(row => JSON.stringify(row)).join('\n') + '\n'));
const refuse = fn => assert.throws(fn, /^Error: Luna accounting evidence refused$/);
const usage = () => ({ input_tokens: 100, output_tokens: 20, total_tokens: 120, input_tokens_details: { cached_tokens: 10 } });
const admit = () => ({ event: 'admit', id: 'r:1', run: 'r', call: 1, reserve: 0.01,
  financial_schema: 1, financial_policy_id: policyId, price_id: PRICE_ID, reserve_nanos: '10000000' });
const settle = () => ({ event: 'settle', id: 'r:1', run: 'r', call: 1,
  financial_schema: 1, financial_policy_id: policyId, price_id: PRICE_ID,
  charge_nanos: '19100', settlement_proof: TERMINAL_PROOF, usage_missing: false,
  usage: usage(), input_tokens: 100, output_tokens: 20, cached_tokens: 10, uncached_tokens: 90,
  cost_usd: 0.0000191, budget_charge_usd: 0.0000191, error: null });
const fold = rows => ledgerExposure(rawRows(rows), { policyId });

test('raw numeric detail boxes must never be treated as objects', () => {
  for (const field of ['input_tokens_details', 'output_tokens_details']) {
    for (const value of [0, 1, 0.5, null, true, '1', []]) {
      const u = { ...usage(), [field]: value };
      refuse(() => usageCharge(rawRows([{ usage: u }])[0].usage));
      refuse(() => fold([admit(), { ...settle(), usage: u }]));
    }
  }
});

test('event-inappropriate financial fields refuse instead of being ignored', () => {
  for (const field of ['charge_nanos', 'settlement_proof']) {
    refuse(() => fold([{ ...admit(), [field]: 'unexpected' }]));
  }
  refuse(() => fold([admit(), { ...settle(), reserve_nanos: '999999999' }]));
});

test('counters distinguish unresolved admissions, unknown settlements, and unproven settlements', () => {
  const open = fold([admit()]);
  assert.equal(open.unsettledAdmissions, 1);
  assert.equal(open.conservativeHolds, 1);
  const unknown = { ...settle(), usage_missing: true, cost_usd: null,
    budget_charge_usd: 0.01, charge_nanos: '10000000' };
  delete unknown.settlement_proof;
  const held = fold([admit(), unknown]);
  assert.equal(held.unsettledAdmissions, 0);
  assert.equal(held.unknownUsageSettlements, 1);
  assert.equal(held.conservativeHolds, 1);
  const unproven = settle(); delete unproven.settlement_proof;
  const unverified = fold([admit(), unproven]);
  assert.equal(unverified.unprovenSettlements, 1);
  assert.equal(unverified.conservativeHolds, 1);
  const proven = fold([admit(), settle()]);
  assert.equal(proven.conservativeHolds, 0);
  assert.equal(proven.unknownUsageSettlements, 0);
  assert.equal(proven.unprovenSettlements, 0);
});

test('authoritative explicit zero differs from absent usage; over-reserve charge is not clamped', () => {
  const s = settle();
  s.usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0, input_tokens_details: { cached_tokens: 0 } };
  for (const key of ['input_tokens', 'output_tokens', 'cached_tokens', 'uncached_tokens', 'cost_usd', 'budget_charge_usd']) s[key] = 0;
  s.charge_nanos = '0';
  assert.equal(fold([admit(), s]).exposure, 0n);
  refuse(() => fold([admit(), { ...s, usage: {} }]));
  const tiny = { ...admit(), reserve: 0.000000001, reserve_nanos: '1' };
  assert.equal(fold([tiny, settle()]).exposure, 19100n);
});
