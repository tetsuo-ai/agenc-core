/**
 * Verifier scheduler — collapsed stub (Cut 3.1).
 *
 * Replaces the previous 104-LOC route strategy / attempt budget
 * planner. The verifier lane that consumed this scheduler has been
 * deleted; every plan now collapses to a single-pass route.
 *
 * @module
 */

import type { RiskTier } from "./risk-scoring.js";

export type VerifierRouteStrategy =
  | "single_pass"
  | "retry_execute"
  | "revision_first";

export interface VerifierScheduleInput {
  adaptiveEnabled: boolean;
  riskTier: RiskTier;
  baseMaxAttempts: number;
  hasRevisionExecutor: boolean;
  reexecuteOnNeedsRevision: boolean;
  adaptiveRiskConfig?: unknown;
}

export interface VerifierSchedulePlan {
  riskTier: RiskTier;
  route: VerifierRouteStrategy;
  maxAttempts: number;
  maxDisagreements: number;
  metadata: Record<string, string | number | boolean>;
}

export function planVerifierSchedule(
  input: VerifierScheduleInput,
): VerifierSchedulePlan {
  return {
    riskTier: input.riskTier,
    route: "single_pass",
    maxAttempts: 1,
    maxDisagreements: Number.MAX_SAFE_INTEGER,
    metadata: { source: "stub" },
  };
}
