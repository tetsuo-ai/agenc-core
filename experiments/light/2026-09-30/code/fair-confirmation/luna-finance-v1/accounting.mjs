// Offline candidate. No I/O, live balances, keys, or permission to spend.
// Prices are retained HISTORICAL FIXTURE values, not verified current pricing.
import { numericLexeme, decimalParts } from './ledger-json.mjs';
const fail = () => { throw new Error('Luna accounting evidence refused'); };
const requireValue = condition => { if (!condition) fail(); };
// Exact numeric lexemes are privately boxed objects, never JSON object data.
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && numericLexeme(value) === undefined;
const integer = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
function count(value) {
  const raw = numericLexeme(value);
  if (raw === undefined) { requireValue(integer(value)); return value; }
  const { coefficient, exponent } = decimalParts(raw);
  const divisor = exponent < 0 ? 10n ** BigInt(-exponent) : 1n;
  requireValue(coefficient % divisor === 0n);
  const result = exponent < 0 ? coefficient / divisor : coefficient * 10n ** BigInt(exponent);
  requireValue(result <= BigInt(Number.MAX_SAFE_INTEGER));
  return Number(result);
}
const identity = value => typeof value === 'string' && value.length <= 240 && /^[A-Za-z0-9_.-]+$/.test(value);
export const PRICE_ID = 'historical-luna-fixture-nanodollars-v1';
export const TERMINAL_PROOF = 'completed-full-usage-v1';
const units = value => {
  requireValue(typeof value === 'string' && value.length <= 80 && /^(?:0|[1-9][0-9]*)$/.test(value));
  return BigInt(value);
};

/** Positive explicitly selected USD cap; at most nine decimal places. */
export function capNanodollars(value) {
  requireValue(typeof value === 'string' && value.length <= 40 && /^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,9})?$/.test(value));
  const [whole, fraction = ''] = value.split('.');
  const nanos = BigInt(whole) * 1_000_000_000n + BigInt(fraction.padEnd(9, '0'));
  requireValue(nanos > 0n);
  return nanos;
}

/** Exact lexeme path, or a numeric-only compatibility path with weaker evidence. */
export function legacyUsdNanodollars(value) {
  const raw = numericLexeme(value);
  requireValue(raw !== undefined || (typeof value === 'number' && Number.isFinite(value) && value >= 0));
  const { coefficient, exponent } = decimalParts(raw ?? String(value));
  const shift = 9 + exponent;
  if (shift >= 0) return coefficient * 10n ** BigInt(shift);
  const divisor = 10n ** BigInt(-shift);
  return (coefficient + divisor - 1n) / divisor;
}

/** Numeric pricing only. Never establishes transport completion or billing. */
export function usageCharge(usage) {
  requireValue(plain(usage));
  const input = count(usage.input_tokens), output = count(usage.output_tokens);
  const hasDetails = Object.hasOwn(usage, 'input_tokens_details');
  requireValue(!hasDetails || plain(usage.input_tokens_details));
  const cachedReported = hasDetails && Object.hasOwn(usage.input_tokens_details, 'cached_tokens');
  const cached = cachedReported ? count(usage.input_tokens_details.cached_tokens) : 0;
  requireValue(cached <= input);
  const totalReported = Object.hasOwn(usage, 'total_tokens');
  if (totalReported) {
    requireValue(BigInt(count(usage.total_tokens)) === BigInt(input) + BigInt(output));
  }
  if (Object.hasOwn(usage, 'output_tokens_details')) {
    requireValue(plain(usage.output_tokens_details));
    if (Object.hasOwn(usage.output_tokens_details, 'reasoning_tokens')) {
      requireValue(count(usage.output_tokens_details.reasoning_tokens) <= output);
    }
  }
  const [cachedRate, inputRate, outputRate] = input > 272_000 ? [20n, 200n, 750n] : [10n, 100n, 500n];
  const nanos = BigInt(cached) * cachedRate + BigInt(input - cached) * inputRate + BigInt(output) * outputRate;
  return Object.freeze({ nanos, input, output, cached, cachedReported, totalReported,
    completeCounters: cachedReported && totalReported,
    basis: cachedReported ? 'reported-counter-fixture-price' : 'conservative-uncached-fixture-price',
    priceId: PRICE_ID });
}

/** Same historical reservation arithmetic in exact nanos, not a proven bill bound. */
export function requestReserve(byteCount, outputCap) {
  requireValue(integer(byteCount) && byteCount > 0 && integer(outputCap) && outputCap > 0);
  return BigInt(byteCount) * 200n + BigInt(outputCap) * 750n;
}

/**
 * Fold parsed, trusted-root ledger rows without mutating/deduplicating them.
 * Use parseLedgerBytes for exact original monetary/count lexemes. Ordinary
 * parsed Number inputs are supported for synthetic callers but cannot recover
 * lost source precision and are NOT a byte-ingestion guarantee.
 * New lower exposures require explicit completed-full-usage proof. Legacy
 * numeric settlements without it remain conservatively reserved. This field
 * is a trusted writer assertion, NOT authentication or a transport verifier.
 */
export function ledgerExposure(rows, { policyId } = {}) {
  requireValue(Array.isArray(rows) && rows.length <= 100_000);
  const admissions = new Map(), settlements = new Set(), ordinals = new Map();
  let exposure = 0n, unknownUsageSettlements = 0, unprovenSettlements = 0;
  for (const row of rows) {
    requireValue(plain(row) && identity(row.run));
    const call = count(row.call);
    requireValue(call > 0 && row.id === `${row.run}:${call}`);
    const modern = Object.hasOwn(row, 'financial_schema');
    if (modern) {
      requireValue(count(row.financial_schema) === 1 && typeof policyId === 'string' &&
        policyId.length === 64 && /^[a-f0-9]{64}$/.test(policyId) &&
        row.financial_policy_id === policyId && row.price_id === PRICE_ID);
    } else {
      requireValue(!['financial_policy_id', 'reserve_nanos', 'charge_nanos', 'settlement_proof', 'price_id']
        .some(key => Object.hasOwn(row, key)));
    }
    if (row.event === 'admit') {
      requireValue(!['charge_nanos', 'settlement_proof'].some(key => Object.hasOwn(row, key)));
      requireValue(!admissions.has(row.id) && call === (ordinals.get(row.run) ?? 0) + 1);
      const reserve = legacyUsdNanodollars(row.reserve);
      requireValue(reserve > 0n);
      if (modern) {
        const exact = units(row.reserve_nanos);
        requireValue(exact > 0n && reserve >= exact && reserve <= exact + 1n);
      }
      admissions.set(row.id, { reserve, run: row.run, call, modern });
      ordinals.set(row.run, call);
      exposure += reserve;
      continue;
    }
    requireValue(row.event === 'settle' && !settlements.has(row.id) && admissions.has(row.id));
    requireValue(!Object.hasOwn(row, 'reserve_nanos'));
    const admission = admissions.get(row.id);
    requireValue(row.run === admission.run && call === admission.call && typeof row.usage_missing === 'boolean' && modern === admission.modern);
    const recorded = legacyUsdNanodollars(row.budget_charge_usd);
    if (modern) {
      const exact = units(row.charge_nanos);
      requireValue(recorded >= exact && recorded <= exact + 1n);
    }
    const hasProof = Object.hasOwn(row, 'settlement_proof');
    requireValue(!hasProof || row.settlement_proof === TERMINAL_PROOF);
    let effective;
    if (row.usage_missing) {
      requireValue(row.cost_usd === null && !hasProof && recorded >= admission.reserve);
      unknownUsageSettlements++;
      effective = recorded;
    } else {
      const charge = usageCharge(row.usage);
      requireValue(charge.completeCounters && count(row.input_tokens) === charge.input &&
        count(row.output_tokens) === charge.output && count(row.cached_tokens) === charge.cached &&
        count(row.uncached_tokens) === charge.input - charge.cached);
      const cost = legacyUsdNanodollars(row.cost_usd);
      // Legacy floating arithmetic may round a decimal nano up by one unit.
      // Never discount either recorded number to repair that representation.
      requireValue(cost >= charge.nanos && cost <= charge.nanos + 1n && recorded >= cost);
      if (Object.hasOwn(row, 'rates')) {
        const expected = charge.input > 272000 ? [20_000_000n, 200_000_000n, 750_000_000n] : [10_000_000n, 100_000_000n, 500_000_000n];
        requireValue(Array.isArray(row.rates) && row.rates.length === 3 &&
          row.rates.every((rate, index) => legacyUsdNanodollars(rate) === expected[index]));
      }
      if (hasProof) {
        requireValue(modern && units(row.charge_nanos) === charge.nanos && row.error === null);
        effective = recorded;
      } else {
        unprovenSettlements++;
        effective = recorded > admission.reserve ? recorded : admission.reserve;
      }
    }
    exposure += effective - admission.reserve;
    settlements.add(row.id);
  }
  const unsettledAdmissions = admissions.size - settlements.size;
  return Object.freeze({ exposure, admissions: admissions.size, settlements: settlements.size,
    unsettledAdmissions, unknownUsageSettlements, unprovenSettlements,
    conservativeHolds: unsettledAdmissions + unknownUsageSettlements + unprovenSettlements,
    nextOrdinal: run => { requireValue(identity(run)); return (ordinals.get(run) ?? 0) + 1; } });
}

export function fitsCap(exposure, reserve, cap) {
  requireValue(typeof exposure === 'bigint' && exposure >= 0n && typeof reserve === 'bigint' && reserve > 0n &&
    typeof cap === 'bigint' && cap > 0n);
  return exposure + reserve <= cap;
}
