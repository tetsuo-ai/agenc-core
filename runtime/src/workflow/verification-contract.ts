/**
 * Workflow verification contract — collapsed stub (Cut 1.1).
 *
 * Replaces the previous 1,117-LOC effect-ledger / mutation-evidence /
 * acceptance-criteria validation pipeline. The planner subsystem that
 * produced workflow contracts has been deleted; the runtime no longer
 * runs structured verification on tool execution outcomes.
 *
 * @module
 */

import type { RuntimeVerificationDecision } from "./verification-results.js";

export function validateRuntimeVerificationContract(
  _input: Record<string, unknown>,
): RuntimeVerificationDecision {
  return { ok: true, channels: [] };
}
