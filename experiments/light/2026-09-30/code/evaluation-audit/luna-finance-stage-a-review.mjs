import assert from 'node:assert/strict';
import test from 'node:test';
import { usageCharge, ledgerExposure, PRICE_ID, TERMINAL_PROOF, fitsCap } from '/private/tmp/light-takeover/fair-confirmation/luna-finance-v1/accounting.mjs';
import { parseLedgerBytes } from '/private/tmp/light-takeover/fair-confirmation/luna-finance-v1/ledger-json.mjs';

const policyId = 'a'.repeat(64);
const selection = { policyId };
const raw = values => parseLedgerBytes(Buffer.from(values.map(value => JSON.stringify(value)).join('\n') + '\n'));
const usage = () => ({ input_tokens: 100, output_tokens: 20, total_tokens: 120, input_tokens_details: { cached_tokens: 10 } });
const admit = (modern = true) => ({ event: 'admit', id: 'r:1', run: 'r', call: 1, reserve: 0.01,
  ...(modern ? { financial_schema: 1, financial_policy_id: policyId, price_id: PRICE_ID, reserve_nanos: '10000000' } : {}) });
const settle = (modern = true) => ({ event: 'settle', id: 'r:1', run: 'r', call: 1,
  usage_missing: false, usage: usage(), input_tokens: 100, output_tokens: 20,
  cached_tokens: 10, uncached_tokens: 90, cost_usd: 0.0000191, budget_charge_usd: 0.0000191, error: null,
  ...(modern ? { financial_schema: 1, financial_policy_id: policyId, price_id: PRICE_ID,
    charge_nanos: '19100', settlement_proof: TERMINAL_PROOF } : {}) });
const refused = fn => assert.throws(fn, /^Error: Luna accounting evidence refused$/);

test('raw numeric input details must not masquerade as an absent optional cache count', () => {
  const parsed = raw([{ usage: { ...usage(), input_tokens_details: 1 } }]);
  refused(() => usageCharge(parsed[0].usage));
});

test('raw numeric output details must not authorize lower proven settlement exposure', () => {
  const terminal = settle(); terminal.usage.output_tokens_details = 1;
  refused(() => ledgerExposure(raw([admit(), terminal]), selection));
});

for (const [field, value] of [['charge_nanos', 'not-a-number'], ['settlement_proof', 'unreviewed-proof']]) {
  test(`modern admission refuses settlement-only financial field ${field}`, () => {
    refused(() => ledgerExposure(raw([{ ...admit(), [field]: value }]), selection));
  });
}

test('modern settlement refuses an admission-only contradictory reserve_nanos', () => {
  refused(() => ledgerExposure(raw([admit(), { ...settle(), reserve_nanos: '1' }]), selection));
});

test('an exposed held count must not report zero for an unknown settlement retaining a full hold', () => {
  const unknown = { event: 'settle', id: 'r:1', run: 'r', call: 1,
    usage_missing: true, cost_usd: null, budget_charge_usd: 0.01 };
  const folded = ledgerExposure(raw([admit(false), unknown]), selection);
  assert.equal(folded.exposure, 10_000_000n);
  // Renaming the old field to unclosedAdmissions is also a valid correction;
  // a successor then needs its own explicit disposition-count assertions.
  if (Object.hasOwn(folded, 'held')) assert.equal(folded.held, 1);
});

test('modern unproven settlement must not increment a counter named legacy', () => {
  const unproven = settle(); delete unproven.settlement_proof;
  const folded = ledgerExposure(raw([admit(), unproven]), selection);
  assert.equal(folded.exposure, 10_000_000n);
  if (Object.hasOwn(folded, 'conservativeLegacySettlements')) assert.equal(folded.conservativeLegacySettlements, 0);
});

test('control: trusted new proof reduces exposure; legacy record does not', () => {
  assert.equal(ledgerExposure(raw([admit(), settle()]), selection).exposure, 19_100n);
  assert.equal(ledgerExposure(raw([admit(false), settle(false)]), selection).exposure, 10_000_000n);
});

test('control: exact raw amount tail remains charged at the next nanodollar', () => {
  const text = '{"event":"admit","id":"r:1","run":"r","call":1,"reserve":0.010000000000000000000000000001}\n';
  const folded = ledgerExposure(parseLedgerBytes(Buffer.from(text)));
  assert.equal(folded.exposure, 10_000_001n);
  assert.equal(fitsCap(folded.exposure, 1n, 10_000_001n), false);
  assert.equal(fitsCap(folded.exposure, 1n, 10_000_002n), true);
});
