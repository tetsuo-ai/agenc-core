// Offline composition candidate, not installed in any provider/observer.
import { createHash } from 'node:crypto';
import { createFinancialJournal } from '../luna-finance-io-v1/journal.mjs';
import { requestReserve, PRICE_ID, TERMINAL_PROOF } from '../luna-finance-v1/accounting.mjs';
import { createResponsesTerminal } from '../luna-terminal-v1/terminal.mjs';

const refuse = () => { throw new Error('Financial call lifecycle refused'); };
const requireValue = condition => { if (!condition) refuse(); };
const moneyFields = new Set(['reserve', 'cost_usd', 'budget_charge_usd']);
function decimal(nanos) {
  requireValue(typeof nanos === 'bigint' && nanos >= 0n);
  const whole = nanos / 1_000_000_000n;
  const fraction = String(nanos % 1_000_000_000n).padStart(9, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : String(whole);
}
function rowBytes(row) {
  // Monetary JSON numeric tokens come directly from exact integers. No
  // BigInt→Number→JSON round trip or placeholder substitution is involved.
  return Buffer.from('{' + Object.entries(row).map(([key, value]) =>
    JSON.stringify(key) + ':' + (moneyFields.has(key) && value !== null ? decimal(value) : JSON.stringify(value))
  ).join(',') + '}\n');
}

/**
 * New run only; existing same-run rows cause duplicate/ordinal refusal.
 * Caller must enforce fixed request policy/binding BEFORE admit, and owns the
 * true HTTP metadata, physical attempts and EOF. This bridge does not send.
 */
export function createFinancialOwner({ runId, taskCallCap, root, inventory, policyId, capUsd, fs }) {
  requireValue(typeof runId === 'string' && /^[A-Za-z0-9_.-]{1,240}$/.test(runId));
  requireValue(Number.isSafeInteger(taskCallCap) && taskCallCap > 0 && taskCallCap <= 10000);
  const journal = createFinancialJournal({ root, inventory, policyId, capUsd, ...(fs ? { fs } : {}) });
  let next = 1, blocked = false;
  function admit(raw, outputCap) {
    requireValue(!blocked && next <= taskCallCap && raw instanceof Uint8Array && raw.byteLength > 0 && raw.byteLength <= 1024 * 1024 &&
      Number.isSafeInteger(outputCap) && outputCap > 0 && outputCap <= 8192);
    const bytes = Buffer.from(raw), ordinal = next;
    const requestSha256 = createHash('sha256').update(bytes).digest('hex');
    const reserve = requestReserve(bytes.length, outputCap);
    const common = { id: `${runId}:${ordinal}`, run: runId, call: ordinal,
      financial_schema: 1, financial_policy_id: policyId, price_id: PRICE_ID };
    let receipt;
    try {
      receipt = journal.commit(rowBytes({ event: 'admit', ...common, reserve,
        reserve_nanos: String(reserve), request_sha256: requestSha256 }));
    } catch (cause) { blocked = true; throw cause; }
    next++;
    if (receipt.stopPresent) { blocked = true; refuse(); } // durable reservation remains
    let tracker = null, headersSeen = false, invalidTransport = false, attempted = false, accounting = null, uncertain = false;
    const open = () => requireValue(!attempted);
    function headers(httpStatus, contentType) {
      open();
      if (headersSeen) { invalidTransport = true; return; }
      headersSeen = true;
      try { tracker = createResponsesTerminal({ httpStatus, contentType, expectedModel: 'gpt-6-luna' }); }
      catch (cause) { invalidTransport = true; blocked = true; throw cause; }
    }
    function push(chunk) {
      open();
      if (tracker === null) { invalidTransport = true; return; }
      try { tracker.push(chunk); }
      catch (cause) { invalidTransport = true; blocked = true; throw cause; }
    }
    function finish(outcome) {
      // One accounting attempt: a later artifact error or repeated caller must
      // not append a second row or retry a possibly committed settlement.
      if (attempted) { if (uncertain) refuse(); return accounting; }
      attempted = true;
      try {
        // Preparation is part of the single attempt too. A helper exception
        // leaves the existing reservation intact and must block new admissions.
        const terminal = invalidTransport || tracker === null ? { state: 'unknown' } : tracker.finish(outcome);
        const known = terminal.state === 'known';
        const charge = known ? BigInt(terminal.chargeNanos) : reserve;
        const usage = known ? { input_tokens: terminal.input, output_tokens: terminal.output,
          total_tokens: terminal.input + terminal.output, input_tokens_details: { cached_tokens: terminal.cached } } : {};
        const row = { event: 'settle', ...common, request_sha256: requestSha256,
          usage_missing: !known, usage, cost_usd: known ? charge : null,
          budget_charge_usd: charge, charge_nanos: String(charge),
          error: known ? null : { type: 'unknown_terminal' },
          ...(known ? { settlement_proof: TERMINAL_PROOF, terminal_proof: terminal.proof,
            response_id_sha256: terminal.responseIdSha256, input_tokens: terminal.input,
            output_tokens: terminal.output, cached_tokens: terminal.cached,
            uncached_tokens: terminal.input - terminal.cached } : {}) };
        const committed = journal.commit(rowBytes(row));
        if (committed.stopPresent || committed.stopRequired) blocked = true;
        accounting = Object.freeze({ state: known ? 'known_charge_committed' : 'unknown_hold_committed',
          chargeNanodollars: String(charge), exposureNanodollars: committed.exposureNanodollars,
          stopPresent: committed.stopPresent });
        return accounting;
      } catch (cause) { uncertain = true; blocked = true; throw cause; }
    }
    return Object.freeze({ ordinal, requestSha256, reservedNanodollars: String(reserve), headers, push, finish });
  }
  return Object.freeze({ nextOrdinal: () => next, isBlocked: () => blocked, admit });
}
