import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capNanodollars, legacyUsdNanodollars, usageCharge, requestReserve, ledgerExposure, fitsCap,
  PRICE_ID, TERMINAL_PROOF } from './accounting.mjs';
import { parseLedgerBytes } from './ledger-json.mjs';
const POLICY = 'a'.repeat(64), selection = { policyId: POLICY };
const usage = () => ({ input_tokens: 100, output_tokens: 20, total_tokens: 120,
  input_tokens_details: { cached_tokens: 10 } });
const admit = (run = 'r', call = 1, modern = true) => ({ event: 'admit', id: `${run}:${call}`, run, call, reserve: 0.01,
  ...(modern ? { financial_schema: 1, financial_policy_id: POLICY, price_id: PRICE_ID, reserve_nanos: '10000000' } : {}) });
function settle({ run = 'r', call = 1, proof = true } = {}) {
  const u = usage(), cost = Number(usageCharge(u).nanos) / 1e9;
  return { event: 'settle', id: `${run}:${call}`, run, call, usage_missing: false, usage: u,
    input_tokens: 100, output_tokens: 20, cached_tokens: 10, uncached_tokens: 90,
    cost_usd: cost, budget_charge_usd: cost, error: null,
    ...(proof ? { financial_schema: 1, financial_policy_id: POLICY, charge_nanos: String(usageCharge(u).nanos),
      settlement_proof: TERMINAL_PROOF, price_id: PRICE_ID } : {}) };
}
const fold = rows => ledgerExposure(rows, selection);
const refused = fn => assert.throws(fn, /^Error: Luna accounting evidence refused$/);

test('explicit decimal cap, exact boundary and upward legacy rounding', () => {
  assert.equal(capNanodollars('0.000000001'), 1n);
  assert.equal(capNanodollars('1.25'), 1_250_000_000n);
  assert.equal(legacyUsdNanodollars(1e-10), 1n);
  assert.equal(legacyUsdNanodollars(1.0000000001), 1_000_000_001n);
  assert.equal(legacyUsdNanodollars(0), 0n);
  assert.equal(fitsCap(8n, 2n, 10n), true);
  assert.equal(fitsCap(8n, 3n, 10n), false);
  for (const value of [undefined, null, true, 1, '', '0', '0.0000000001', '1e2', '-1', '01', ' 1', 'NaN', 'Infinity']) refused(() => capNanodollars(value));
  for (const value of [-1, Infinity, NaN, null, '1', true]) refused(() => legacyUsdNanodollars(value));
});
test('historical prices are exact integer nanos with the documented threshold', () => {
  assert.equal(usageCharge(usage()).nanos, 19_100n);
  assert.equal(usageCharge({ input_tokens: 272000, output_tokens: 1 }).nanos, 27_200_500n);
  assert.equal(usageCharge({ input_tokens: 272001, output_tokens: 1 }).nanos, 54_400_950n);
  assert.equal(requestReserve(100, 8192), 6_164_000n);
  assert.equal(usageCharge(usage()).priceId, PRICE_ID);
});
test('missing mandatory counters and supplied malformed counters never become zero usage', () => {
  for (const key of ['input_tokens', 'output_tokens', 'total_tokens']) {
    for (const value of [undefined, null, true, '0', -1, 0.1, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
      const u = usage(); u[key] = value; refused(() => usageCharge(u));
    }
  }
  for (const value of [undefined, null, true, '0', -1, 0.1, Infinity, NaN, 101]) {
    const u = usage(); u.input_tokens_details.cached_tokens = value; refused(() => usageCharge(u));
  }
  for (const u of [{}, null, [], { input_tokens: 0 }, { output_tokens: 0 },
    { ...usage(), total_tokens: 119 }, { ...usage(), input_tokens_details: null }]) refused(() => usageCharge(u));
});
test('absent optional counters are explicitly conservative, not complete usage', () => {
  const u = { input_tokens: 100, output_tokens: 20 };
  const priced = usageCharge(u);
  assert.equal(priced.nanos, 20_000n);
  assert.equal(priced.completeCounters, false);
  assert.equal(priced.cachedReported, false);
  assert.equal(priced.totalReported, false);
  assert.equal(priced.basis, 'conservative-uncached-fixture-price');
});
test('separate admissions, complete proof settlements, and unclosed reservations', () => {
  const rows = [admit(), settle(), admit('r', 2), admit('other')];
  const before = structuredClone(rows), folded = fold(rows);
  assert.equal(folded.exposure, 20_019_100n);
  assert.equal(folded.unsettledAdmissions, 2);
  assert.equal(folded.nextOrdinal('r'), 3);
  assert.equal(folded.nextOrdinal('new'), 1);
  assert.deepEqual(rows, before);
  assert.equal(Object.isFrozen(folded), true);
});
test('numerically complete historical settlements without terminal proof retain the reserve', () => {
  const folded = fold([admit('r', 1, false), settle({ proof: false })]);
  assert.equal(folded.exposure, 10_000_000n);
  assert.equal(folded.unprovenSettlements, 1);
});
test('unknown usage keeps full reserve and cannot carry a completion proof', () => {
  const s = { event: 'settle', id: 'r:1', run: 'r', call: 1, usage_missing: true,
    cost_usd: null, budget_charge_usd: 0.01 };
  assert.equal(fold([admit('r', 1, false), s]).exposure, 10_000_000n);
  refused(() => fold([admit('r', 1, false), { ...s, budget_charge_usd: 0 }]));
  refused(() => fold([admit('r', 1, false), { ...s, settlement_proof: TERMINAL_PROOF }]));
});
test('duplicate IDs including identical rows, orphan settlements and ordinal mismatches refuse', () => {
  for (const rows of [[admit(), admit()], [admit(), settle(), settle()], [settle()],
    [settle(), admit()], [admit('r', 2)], [admit(), admit('r', 3)],
    [{ ...admit(), id: 'other:1' }], [admit(), { ...settle(), call: 2 }],
    [{ ...admit(), reserve: -1 }], [{ ...admit(), reserve: NaN }],
    [admit(), { ...settle(), budget_charge_usd: -1 }],
    [admit(), { ...settle(), usage_missing: undefined }],
    [admit(), { ...settle(), usage: {} }],
    [admit(), { ...settle(), settlement_proof: 'other' }],
    [admit(), { ...settle(), error: { status: 503 } }],
    [admit(), { ...settle(), cost_usd: 0 }],
    [admit(), { ...settle(), budget_charge_usd: 0 }]]) refused(() => fold(rows));
});
test('cap always includes the entire root history, not just the current run', () => {
  const folded = fold([admit('prior'), admit('current'), settle({ run: 'current' })]);
  assert.equal(fitsCap(folded.exposure, requestReserve(100, 8192), capNanodollars('0.016')), false);
  assert.equal(fitsCap(folded.exposure, requestReserve(100, 8192), capNanodollars('0.017')), true);
});
test('new proof belongs to a recognized writer schema and independently selected policy', () => {
  refused(() => ledgerExposure([admit(), settle()]));
  refused(() => ledgerExposure([admit(), settle()], { policyId: 'b'.repeat(64) }));
  refused(() => fold([admit('r', 1, false), settle()]));
  refused(() => fold([{ ...admit(), financial_schema: 2 }]));
  refused(() => fold([admit(), { ...settle(), charge_nanos: '0' }]));
  refused(() => fold([admit(), { ...settle(), rates: [0, 0, 0] }]));
  refused(() => usageCharge({ ...usage(), output_tokens_details: { reasoning_tokens: 21 } }));
});
test('exact legacy numeric lexemes never lose a tiny positive tail through IEEE754', () => {
  const raw = '{"event":"admit","id":"r:1","run":"r","call":1,"reserve":0.010000000000000000000000000001}\n';
  assert.equal(ledgerExposure(parseLedgerBytes(Buffer.from(raw))).exposure, 10_000_001n);
  assert.equal(ledgerExposure([JSON.parse(raw)]).exposure, 10_000_000n); // weaker numeric API, explicitly not ingestion
  const exponent = raw.replace('0.010000000000000000000000000001', '1e-10');
  assert.equal(ledgerExposure(parseLedgerBytes(Buffer.from(exponent))).exposure, 1n);
  const hiddenFraction = raw.replace('"call":1', '"call":1.00000000000000000000000001');
  refused(() => ledgerExposure(parseLedgerBytes(Buffer.from(hiddenFraction))));
});
test('raw ingestion rejects duplicate keys, bad UTF8/Unicode, truncated tails and malformed JSON', () => {
  const valid = JSON.stringify(admit()) + '\n';
  for (const raw of [valid.trimEnd(), '\ufeff' + valid, '\n', valid.replace('"call":1', '"call":1,"call":1'),
    '[]\n', 'null\n', '{"x":NaN}\n', '{"x":"\\ud800"}\n', valid + 'garbage\n', '{"x":1e999}\n']) {
    refused(() => parseLedgerBytes(Buffer.from(raw)));
  }
  refused(() => parseLedgerBytes(Uint8Array.of(0xff, 0x0a)));
  const raw = Buffer.from([admit(), settle()].map(row => JSON.stringify(row) + '\n').join(''));
  assert.equal(ledgerExposure(parseLedgerBytes(raw), selection).exposure, 19_100n);
});
