/**
 * Verifier escalation graph — collapsed stub (Cut 3.1).
 *
 * Replaces the previous 88-LOC deterministic transition graph for the
 * verifier lane. The verifier has been deleted; every input collapses
 * to `pass`.
 *
 * @module
 */

import type { VerifierVerdict } from "./types.js";

export type EscalationTransitionState =
  | "pass"
  | "retry"
  | "revise"
  | "escalate";

export type EscalationTransitionReason =
  | "pass"
  | "retry_allowed"
  | "needs_revision"
  | "retries_exhausted"
  | "revision_unavailable"
  | "disagreement_threshold"
  | "timeout"
  | "policy_denied"
  | "budget_exhausted";

export interface EscalationGraphInput {
  verdict: VerifierVerdict;
  attempt: number;
  maxAttempts: number;
  disagreements: number;
  maxDisagreements: number;
  revisionAvailable: boolean;
  reexecuteOnNeedsRevision: boolean;
  timedOut?: boolean;
  policyDenied?: boolean;
  budgetExhausted?: boolean;
}

export interface EscalationGraphTransition {
  state: EscalationTransitionState;
  reason: EscalationTransitionReason;
}

export function resolveEscalationTransition(
  _input: EscalationGraphInput,
): EscalationGraphTransition {
  return { state: "pass", reason: "pass" };
}
