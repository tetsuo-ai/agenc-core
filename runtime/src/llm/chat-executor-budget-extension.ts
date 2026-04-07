/**
 * Tool round budget extension — collapsed stub (Cut 1.2).
 *
 * Replaces the previous 356-LOC dynamic budget-extension evaluator
 * (recent-progress-rate scoring, repair-episode detection, sustained
 * progress tracking, weighted-semantic-key averages, time-bound
 * negotiation). claude_code uses a fixed `maxTurns` + recovery message
 * — there is no run-time extension. The runtime now reports a static
 * `ceiling_reached` decision so the tool loop terminates exactly at
 * the configured limit.
 *
 * @module
 */

import type {
  ExecutionContext,
} from "./chat-executor-types.js";
import type {
  ToolRoundProgressSummary,
} from "./chat-executor-tool-utils.js";

export interface ToolRoundBudgetExtensionParams {
  readonly ctx: ExecutionContext;
  readonly currentLimit: number;
  readonly recentRounds: readonly ToolRoundProgressSummary[];
}

export interface ToolRoundBudgetExtensionResult {
  readonly decision:
    | "extended"
    | "ceiling_reached"
    | "no_recent_rounds"
    | "insufficient_recent_progress"
    | "request_time_exhausted"
    | "time_bound_exhausted"
    | "tool_budget_exhausted"
    | "extension_budget_exhausted";
  readonly recentProgressRate: number;
  readonly recentTotalNewSuccessfulSemanticKeys: number;
  readonly recentTotalNewVerificationFailureDiagnosticKeys: number;
  readonly weightedAverageNewSuccessfulSemanticKeys: number;
  readonly latestRoundHadMaterialProgress: boolean;
  readonly newLimit: number;
  readonly extensionRounds: number;
  readonly remainingToolBudget: number;
  readonly remainingRequestMs: number;
  readonly recentAverageRoundMs: number;
  readonly latestRoundNewSuccessfulSemanticKeys: number;
  readonly latestRoundNewVerificationFailureDiagnosticKeys: number;
  readonly extensionReason:
    | "none"
    | "repair_episode"
    | "sustained_progress";
  readonly repairCycleOpen: boolean;
  readonly repairCycleNeedsMutation: boolean;
  readonly repairCycleNeedsVerification: boolean;
}

export function evaluateToolRoundBudgetExtension(
  params: ToolRoundBudgetExtensionParams,
  _getRemainingRequestMs: (ctx: ExecutionContext) => number,
): ToolRoundBudgetExtensionResult {
  return {
    decision: "ceiling_reached",
    recentProgressRate: 0,
    recentTotalNewSuccessfulSemanticKeys: 0,
    recentTotalNewVerificationFailureDiagnosticKeys: 0,
    weightedAverageNewSuccessfulSemanticKeys: 0,
    latestRoundHadMaterialProgress: false,
    newLimit: params.currentLimit,
    extensionRounds: 0,
    remainingToolBudget: 0,
    remainingRequestMs: 0,
    recentAverageRoundMs: 0,
    latestRoundNewSuccessfulSemanticKeys: 0,
    latestRoundNewVerificationFailureDiagnosticKeys: 0,
    extensionReason: "none",
    repairCycleOpen: false,
    repairCycleNeedsMutation: false,
    repairCycleNeedsVerification: false,
  };
}
