/**
 * Delegation decision — collapsed stub (Cut 1.2).
 *
 * Replaces the previous 619-LOC `assessDelegationDecision()` machinery
 * (utility scoring, decomposition benefit, coordination overhead,
 * latency cost risk, safety hard-block detection, score thresholds,
 * fanout/depth caps). The planner subsystem that consumed this output
 * has been deleted; live delegation now flows through
 * `gateway/delegation-admission.ts::assessDelegationAdmission` which
 * applies hard-rejection-only gates. The exported types are kept as
 * tiny shapes so chat-executor configuration call sites still parse.
 *
 * @module
 */

export type DelegationDecisionReason =
  | "delegation_disabled"
  | "approved";

export type DelegationHardBlockedTaskClass =
  | "wallet_signing"
  | "wallet_transfer"
  | "stake_or_rewards"
  | "destructive_host_mutation"
  | "credential_exfiltration";

export type DelegationHardBlockedMatchSource = "capability" | "text";

/**
 * Minimal delegation verdict shape kept for ExecutionContext plumbing.
 * The rich scoring output (utilityScore, decompositionBenefit,
 * coordinationOverhead, latencyCostRisk, safetyRisk, ...) was produced
 * by the deleted assessDelegationDecision pipeline. The runtime now
 * only distinguishes approved vs delegation_disabled outcomes.
 */
export interface DelegationDecision {
  readonly shouldDelegate: boolean;
  readonly reason: DelegationDecisionReason;
  readonly hardBlockedTaskClass: DelegationHardBlockedTaskClass | null;
  readonly hardBlockedTaskClassSource: DelegationHardBlockedMatchSource | null;
}

export interface DelegationDecisionConfig {
  readonly enabled?: boolean;
  readonly mode?: "manager_tools" | "handoff" | "hybrid";
  readonly scoreThreshold?: number;
  readonly maxFanoutPerTurn?: number;
  readonly maxDepth?: number;
  readonly handoffMinPlannerConfidence?: number;
  readonly hardBlockedTaskClasses?: readonly DelegationHardBlockedTaskClass[];
}

export interface ResolvedDelegationDecisionConfig {
  readonly enabled: boolean;
  readonly mode: "manager_tools" | "handoff" | "hybrid";
  readonly scoreThreshold: number;
  readonly maxFanoutPerTurn: number;
  readonly maxDepth: number;
  readonly handoffMinPlannerConfidence: number;
  readonly hardBlockedTaskClasses: ReadonlySet<DelegationHardBlockedTaskClass>;
}

const DEFAULT_HARD_BLOCKED_TASK_CLASSES: readonly DelegationHardBlockedTaskClass[] = [
  "wallet_signing",
  "wallet_transfer",
  "stake_or_rewards",
  "credential_exfiltration",
];

export function resolveDelegationDecisionConfig(
  config: DelegationDecisionConfig | undefined,
): ResolvedDelegationDecisionConfig {
  return {
    enabled: config?.enabled ?? false,
    mode: config?.mode ?? "manager_tools",
    scoreThreshold: config?.scoreThreshold ?? 0.2,
    maxFanoutPerTurn: config?.maxFanoutPerTurn ?? 8,
    maxDepth: config?.maxDepth ?? 4,
    handoffMinPlannerConfidence: config?.handoffMinPlannerConfidence ?? 0.82,
    hardBlockedTaskClasses: new Set(
      config?.hardBlockedTaskClasses ?? DEFAULT_HARD_BLOCKED_TASK_CLASSES,
    ),
  };
}
