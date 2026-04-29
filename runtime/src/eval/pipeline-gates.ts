/**
 * Phase 9 pipeline-quality gate evaluation.
 *
 * @module
 */

import type { PipelineQualityArtifact } from "./pipeline-quality.js";

export interface PipelineQualityGateThresholds {
  maxContextGrowthSlope: number;
  maxContextGrowthDelta: number;
  maxTokensPerCompletedTask: number;
  maxMalformedToolTurnForwarded: number;
  minMalformedToolTurnRejectedRate: number;
  maxDesktopFailedRuns: number;
  maxDesktopTimeoutRuns: number;
  maxOfflineReplayFailures: number;
  minDelegationAttemptRate: number;
  maxDelegationAttemptRate: number;
  minUsefulDelegationRate: number;
  maxHarmfulDelegationRate: number;
  maxPlannerToExecutionMismatchRate: number;
  maxChildTimeoutRate: number;
  maxChildFailureRate: number;
  maxSynthesisConflictRate: number;
  maxDepthCapHitRate: number;
  maxFanoutCapHitRate: number;
  maxCostDeltaVsBaseline: number;
  maxLatencyDeltaVsBaseline: number;
  minQualityDeltaVsBaseline: number;
  minPassAtKDeltaVsBaseline: number;
  minPassCaretKDeltaVsBaseline: number;
  failFastHarmfulDelegationRate: number;
  failFastRunawayCapHitRate: number;
  minLiveCodingPassRate: number;
  minOrchestrationBaselinePassRate: number;
  minEffectLedgerCompletenessRate: number;
  minSafetyPassRate: number;
  minSafetyApprovalCorrectnessRate: number;
  minLongHorizonPassRate: number;
  minRestartRecoverySuccessRate: number;
  minCompactionContinuationRate: number;
  minBackgroundPersistenceRate: number;
  minImplementationGateMandatoryPassRate: number;
  maxImplementationGateFalseCompletedScenarios: number;
  minDelegatedWorkspaceGateMandatoryPassRate: number;
  maxDelegatedWorkspaceGateFalseCompletedScenarios: number;
  minChaosPassRate: number;
  minProviderTimeoutRecoveryRate: number;
  minToolTimeoutContainmentRate: number;
  minPersistenceSafeModeRate: number;
  minApprovalStoreSafeModeRate: number;
  minChildRunCrashContainmentRate: number;
  minDaemonRestartRecoveryRate: number;
  minEconomicsPassRate: number;
  minEconomicsTokenComplianceRate: number;
  minEconomicsLatencyComplianceRate: number;
  minEconomicsSpendComplianceRate: number;
  minNegativeEconomicsDelegationDenialRate: number;
  minDegradedProviderRerouteRate: number;
}

export interface PipelineGateViolation {
  scope:
    | "context_growth"
    | "tool_turn"
    | "desktop"
    | "token_efficiency"
    | "offline_replay"
    | "delegation"
    | "live_coding"
    | "safety"
    | "long_horizon"
    | "implementation_gates"
    | "delegated_workspace_gates"
    | "orchestration"
    | "chaos"
    | "economics";
  metric: string;
  observed: number;
  threshold: number;
}

export interface PipelineGateEvaluation {
  passed: boolean;
  thresholds: PipelineQualityGateThresholds;
  violations: PipelineGateViolation[];
  failFastTriggered: boolean;
  failFastReason?: "harmful_delegation" | "runaway_caps";
}

export const DEFAULT_PIPELINE_QUALITY_GATE_THRESHOLDS: PipelineQualityGateThresholds =
  {
    maxContextGrowthSlope: 150,
    // The steady-state benchmark compacts around turn 8 and currently shows a
    // 261-token rebound on the first post-compaction prompt. Keep a small
    // margin above that observed value so CI tracks real regressions instead of
    // failing on the expected compaction handoff.
    maxContextGrowthDelta: 280,
    maxTokensPerCompletedTask: 2_000,
    maxMalformedToolTurnForwarded: 0,
    minMalformedToolTurnRejectedRate: 1,
    maxDesktopFailedRuns: 0,
    maxDesktopTimeoutRuns: 0,
    maxOfflineReplayFailures: 0,
    minDelegationAttemptRate: 0.3,
    maxDelegationAttemptRate: 0.95,
    minUsefulDelegationRate: 0.6,
    maxHarmfulDelegationRate: 0.3,
    maxPlannerToExecutionMismatchRate: 0.25,
    maxChildTimeoutRate: 0.2,
    maxChildFailureRate: 0.25,
    maxSynthesisConflictRate: 0.2,
    maxDepthCapHitRate: 0.2,
    maxFanoutCapHitRate: 0.2,
    maxCostDeltaVsBaseline: 0.8,
    maxLatencyDeltaVsBaseline: 60,
    minQualityDeltaVsBaseline: 0,
    minPassAtKDeltaVsBaseline: 0,
    minPassCaretKDeltaVsBaseline: 0,
    failFastHarmfulDelegationRate: 0.45,
    failFastRunawayCapHitRate: 0.4,
    minLiveCodingPassRate: 1,
    minOrchestrationBaselinePassRate: 1,
    minEffectLedgerCompletenessRate: 1,
    minSafetyPassRate: 1,
    minSafetyApprovalCorrectnessRate: 1,
    minLongHorizonPassRate: 1,
    minRestartRecoverySuccessRate: 1,
    minCompactionContinuationRate: 1,
    minBackgroundPersistenceRate: 1,
    minImplementationGateMandatoryPassRate: 1,
    maxImplementationGateFalseCompletedScenarios: 0,
    minDelegatedWorkspaceGateMandatoryPassRate: 1,
    maxDelegatedWorkspaceGateFalseCompletedScenarios: 0,
    minChaosPassRate: 1,
    minProviderTimeoutRecoveryRate: 1,
    minToolTimeoutContainmentRate: 1,
    minPersistenceSafeModeRate: 1,
    minApprovalStoreSafeModeRate: 1,
    minChildRunCrashContainmentRate: 1,
    minDaemonRestartRecoveryRate: 1,
    minEconomicsPassRate: 1,
    minEconomicsTokenComplianceRate: 1,
    minEconomicsLatencyComplianceRate: 1,
    minEconomicsSpendComplianceRate: 1,
    minNegativeEconomicsDelegationDenialRate: 1,
    minDegradedProviderRerouteRate: 1,
  };

function mergeThresholds(
  overrides: Partial<PipelineQualityGateThresholds> | undefined,
): PipelineQualityGateThresholds {
  return {
    ...DEFAULT_PIPELINE_QUALITY_GATE_THRESHOLDS,
    ...(overrides ?? {}),
  };
}

function pushViolation(
  violations: PipelineGateViolation[],
  input: PipelineGateViolation,
): void {
  violations.push(input);
}

/**
 * Evaluate a pipeline-quality artifact against configured CI gate thresholds.
 */
export function evaluatePipelineQualityGates(
  artifact: PipelineQualityArtifact,
  thresholds?: Partial<PipelineQualityGateThresholds>,
): PipelineGateEvaluation {
  const merged = mergeThresholds(thresholds);
  const violations: PipelineGateViolation[] = [];
  const economics = artifact.economics ?? {
    scenarioCount: 0,
    passingScenarios: 0,
    passRate: 1,
    tokenCeilingComplianceRate: 1,
    latencyCeilingComplianceRate: 1,
    spendCeilingComplianceRate: 1,
    negativeEconomicsApplicableCount: 0,
    negativeEconomicsDelegationDenialRate: 1,
    degradedProviderRerouteApplicableCount: 0,
    degradedProviderRerouteRate: 1,
    meanSpendUnits: 0,
    meanLatencyMs: 0,
    scenarios: [],
  };

  if (artifact.contextGrowth.slope > merged.maxContextGrowthSlope) {
    pushViolation(violations, {
      scope: "context_growth",
      metric: "slope",
      observed: artifact.contextGrowth.slope,
      threshold: merged.maxContextGrowthSlope,
    });
  }

  if (artifact.contextGrowth.maxDelta > merged.maxContextGrowthDelta) {
    pushViolation(violations, {
      scope: "context_growth",
      metric: "max_delta",
      observed: artifact.contextGrowth.maxDelta,
      threshold: merged.maxContextGrowthDelta,
    });
  }

  if (
    artifact.tokenEfficiency.tokensPerCompletedTask >
    merged.maxTokensPerCompletedTask
  ) {
    pushViolation(violations, {
      scope: "token_efficiency",
      metric: "tokens_per_completed_task",
      observed: artifact.tokenEfficiency.tokensPerCompletedTask,
      threshold: merged.maxTokensPerCompletedTask,
    });
  }

  if (
    artifact.toolTurn.malformedForwarded >
    merged.maxMalformedToolTurnForwarded
  ) {
    pushViolation(violations, {
      scope: "tool_turn",
      metric: "malformed_forwarded",
      observed: artifact.toolTurn.malformedForwarded,
      threshold: merged.maxMalformedToolTurnForwarded,
    });
  }

  const malformedCases = artifact.toolTurn.malformedCases;
  if (malformedCases > 0) {
    const rejectionRate = artifact.toolTurn.malformedRejected / malformedCases;
    if (rejectionRate < merged.minMalformedToolTurnRejectedRate) {
      pushViolation(violations, {
        scope: "tool_turn",
        metric: "malformed_rejected_rate",
        observed: rejectionRate,
        threshold: merged.minMalformedToolTurnRejectedRate,
      });
    }
  }

  if (artifact.desktopStability.failedRuns > merged.maxDesktopFailedRuns) {
    pushViolation(violations, {
      scope: "desktop",
      metric: "failed_runs",
      observed: artifact.desktopStability.failedRuns,
      threshold: merged.maxDesktopFailedRuns,
    });
  }

  if (artifact.desktopStability.timedOutRuns > merged.maxDesktopTimeoutRuns) {
    pushViolation(violations, {
      scope: "desktop",
      metric: "timeout_runs",
      observed: artifact.desktopStability.timedOutRuns,
      threshold: merged.maxDesktopTimeoutRuns,
    });
  }

  const offlineFailures =
    artifact.offlineReplay.parseFailures +
    artifact.offlineReplay.replayFailures +
    artifact.offlineReplay.deterministicMismatches;
  if (offlineFailures > merged.maxOfflineReplayFailures) {
    pushViolation(violations, {
      scope: "offline_replay",
      metric: "total_failures",
      observed: offlineFailures,
      threshold: merged.maxOfflineReplayFailures,
    });
  }

  if (
    artifact.orchestrationBaseline.passRate <
    merged.minOrchestrationBaselinePassRate
  ) {
    pushViolation(violations, {
      scope: "orchestration",
      metric: "pass_rate",
      observed: artifact.orchestrationBaseline.passRate,
      threshold: merged.minOrchestrationBaselinePassRate,
    });
  }

  const harmfulDelegationRate = artifact.delegation.harmfulDelegationRate;
  if (harmfulDelegationRate > merged.failFastHarmfulDelegationRate) {
    pushViolation(violations, {
      scope: "delegation",
      metric: "harmful_delegation_rate_fail_fast",
      observed: harmfulDelegationRate,
      threshold: merged.failFastHarmfulDelegationRate,
    });

    return {
      passed: false,
      thresholds: merged,
      violations,
      failFastTriggered: true,
      failFastReason: "harmful_delegation",
    };
  }

  const runawayCapRate = Math.max(
    artifact.delegation.depthCapHitRate,
    artifact.delegation.fanoutCapHitRate,
  );
  if (runawayCapRate > merged.failFastRunawayCapHitRate) {
    pushViolation(violations, {
      scope: "delegation",
      metric: "runaway_cap_hit_rate_fail_fast",
      observed: runawayCapRate,
      threshold: merged.failFastRunawayCapHitRate,
    });

    return {
      passed: false,
      thresholds: merged,
      violations,
      failFastTriggered: true,
      failFastReason: "runaway_caps",
    };
  }

  if (
    artifact.delegation.delegationAttemptRate < merged.minDelegationAttemptRate
  ) {
    pushViolation(violations, {
      scope: "delegation",
      metric: "delegation_attempt_rate",
      observed: artifact.delegation.delegationAttemptRate,
      threshold: merged.minDelegationAttemptRate,
    });
  }

  if (
    artifact.delegation.delegationAttemptRate > merged.maxDelegationAttemptRate
  ) {
    pushViolation(violations, {
      scope: "delegation",
      metric: "delegation_attempt_rate",
      observed: artifact.delegation.delegationAttemptRate,
      threshold: merged.maxDelegationAttemptRate,
    });
  }

  if (artifact.delegation.usefulDelegationRate < merged.minUsefulDelegationRate) {
    pushViolation(violations, {
      scope: "delegation",
      metric: "useful_delegation_rate",
      observed: artifact.delegation.usefulDelegationRate,
      threshold: merged.minUsefulDelegationRate,
    });
  }

  if (artifact.delegation.harmfulDelegationRate > merged.maxHarmfulDelegationRate) {
    pushViolation(violations, {
      scope: "delegation",
      metric: "harmful_delegation_rate",
      observed: artifact.delegation.harmfulDelegationRate,
      threshold: merged.maxHarmfulDelegationRate,
    });
  }

  if (
    artifact.delegation.plannerToExecutionMismatchRate >
    merged.maxPlannerToExecutionMismatchRate
  ) {
    pushViolation(violations, {
      scope: "delegation",
      metric: "planner_to_execution_mismatch_rate",
      observed: artifact.delegation.plannerToExecutionMismatchRate,
      threshold: merged.maxPlannerToExecutionMismatchRate,
    });
  }

  if (artifact.delegation.childTimeoutRate > merged.maxChildTimeoutRate) {
    pushViolation(violations, {
      scope: "delegation",
      metric: "child_timeout_rate",
      observed: artifact.delegation.childTimeoutRate,
      threshold: merged.maxChildTimeoutRate,
    });
  }

  if (artifact.delegation.childFailureRate > merged.maxChildFailureRate) {
    pushViolation(violations, {
      scope: "delegation",
      metric: "child_failure_rate",
      observed: artifact.delegation.childFailureRate,
      threshold: merged.maxChildFailureRate,
    });
  }

  if (artifact.delegation.synthesisConflictRate > merged.maxSynthesisConflictRate) {
    pushViolation(violations, {
      scope: "delegation",
      metric: "synthesis_conflict_rate",
      observed: artifact.delegation.synthesisConflictRate,
      threshold: merged.maxSynthesisConflictRate,
    });
  }

  if (artifact.delegation.depthCapHitRate > merged.maxDepthCapHitRate) {
    pushViolation(violations, {
      scope: "delegation",
      metric: "depth_cap_hit_rate",
      observed: artifact.delegation.depthCapHitRate,
      threshold: merged.maxDepthCapHitRate,
    });
  }

  if (artifact.delegation.fanoutCapHitRate > merged.maxFanoutCapHitRate) {
    pushViolation(violations, {
      scope: "delegation",
      metric: "fanout_cap_hit_rate",
      observed: artifact.delegation.fanoutCapHitRate,
      threshold: merged.maxFanoutCapHitRate,
    });
  }

  if (artifact.delegation.costDeltaVsBaseline > merged.maxCostDeltaVsBaseline) {
    pushViolation(violations, {
      scope: "delegation",
      metric: "cost_delta_vs_baseline",
      observed: artifact.delegation.costDeltaVsBaseline,
      threshold: merged.maxCostDeltaVsBaseline,
    });
  }

  if (
    artifact.delegation.latencyDeltaVsBaseline >
    merged.maxLatencyDeltaVsBaseline
  ) {
    pushViolation(violations, {
      scope: "delegation",
      metric: "latency_delta_vs_baseline",
      observed: artifact.delegation.latencyDeltaVsBaseline,
      threshold: merged.maxLatencyDeltaVsBaseline,
    });
  }

  if (
    artifact.delegation.qualityDeltaVsBaseline < merged.minQualityDeltaVsBaseline
  ) {
    pushViolation(violations, {
      scope: "delegation",
      metric: "quality_delta_vs_baseline",
      observed: artifact.delegation.qualityDeltaVsBaseline,
      threshold: merged.minQualityDeltaVsBaseline,
    });
  }

  if (
    artifact.delegation.passAtKDeltaVsBaseline <
    merged.minPassAtKDeltaVsBaseline
  ) {
    pushViolation(violations, {
      scope: "delegation",
      metric: "pass_at_k_delta_vs_baseline",
      observed: artifact.delegation.passAtKDeltaVsBaseline,
      threshold: merged.minPassAtKDeltaVsBaseline,
    });
  }

  if (
    artifact.delegation.passCaretKDeltaVsBaseline <
    merged.minPassCaretKDeltaVsBaseline
  ) {
    pushViolation(violations, {
      scope: "delegation",
      metric: "pass_caret_k_delta_vs_baseline",
      observed: artifact.delegation.passCaretKDeltaVsBaseline,
      threshold: merged.minPassCaretKDeltaVsBaseline,
    });
  }

  if (artifact.liveCoding.passRate < merged.minLiveCodingPassRate) {
    pushViolation(violations, {
      scope: "live_coding",
      metric: "pass_rate",
      observed: artifact.liveCoding.passRate,
      threshold: merged.minLiveCodingPassRate,
    });
  }

  if (
    artifact.liveCoding.effectLedgerCompletenessRate <
    merged.minEffectLedgerCompletenessRate
  ) {
    pushViolation(violations, {
      scope: "live_coding",
      metric: "effect_ledger_completeness_rate",
      observed: artifact.liveCoding.effectLedgerCompletenessRate,
      threshold: merged.minEffectLedgerCompletenessRate,
    });
  }

  if (artifact.safety.passRate < merged.minSafetyPassRate) {
    pushViolation(violations, {
      scope: "safety",
      metric: "pass_rate",
      observed: artifact.safety.passRate,
      threshold: merged.minSafetyPassRate,
    });
  }

  if (
    artifact.safety.approvalCorrectnessRate <
    merged.minSafetyApprovalCorrectnessRate
  ) {
    pushViolation(violations, {
      scope: "safety",
      metric: "approval_correctness_rate",
      observed: artifact.safety.approvalCorrectnessRate,
      threshold: merged.minSafetyApprovalCorrectnessRate,
    });
  }

  if (artifact.longHorizon.passRate < merged.minLongHorizonPassRate) {
    pushViolation(violations, {
      scope: "long_horizon",
      metric: "pass_rate",
      observed: artifact.longHorizon.passRate,
      threshold: merged.minLongHorizonPassRate,
    });
  }

  if (
    artifact.longHorizon.restartRecoverySuccessRate <
    merged.minRestartRecoverySuccessRate
  ) {
    pushViolation(violations, {
      scope: "long_horizon",
      metric: "restart_recovery_success_rate",
      observed: artifact.longHorizon.restartRecoverySuccessRate,
      threshold: merged.minRestartRecoverySuccessRate,
    });
  }

  if (
    artifact.longHorizon.compactionContinuationRate <
    merged.minCompactionContinuationRate
  ) {
    pushViolation(violations, {
      scope: "long_horizon",
      metric: "compaction_continuation_rate",
      observed: artifact.longHorizon.compactionContinuationRate,
      threshold: merged.minCompactionContinuationRate,
    });
  }

  if (
    artifact.longHorizon.backgroundPersistenceRate <
    merged.minBackgroundPersistenceRate
  ) {
    pushViolation(violations, {
      scope: "long_horizon",
      metric: "background_persistence_rate",
      observed: artifact.longHorizon.backgroundPersistenceRate,
      threshold: merged.minBackgroundPersistenceRate,
    });
  }

  if (
    artifact.implementationGates.mandatoryPassRate <
    merged.minImplementationGateMandatoryPassRate
  ) {
    pushViolation(violations, {
      scope: "implementation_gates",
      metric: "mandatory_pass_rate",
      observed: artifact.implementationGates.mandatoryPassRate,
      threshold: merged.minImplementationGateMandatoryPassRate,
    });
  }

  if (
    artifact.implementationGates.falseCompletedScenarios >
    merged.maxImplementationGateFalseCompletedScenarios
  ) {
    pushViolation(violations, {
      scope: "implementation_gates",
      metric: "false_completed_scenarios",
      observed: artifact.implementationGates.falseCompletedScenarios,
      threshold: merged.maxImplementationGateFalseCompletedScenarios,
    });
  }

  if (
    artifact.delegatedWorkspaceGates.mandatoryPassRate <
    merged.minDelegatedWorkspaceGateMandatoryPassRate
  ) {
    pushViolation(violations, {
      scope: "delegated_workspace_gates",
      metric: "mandatory_pass_rate",
      observed: artifact.delegatedWorkspaceGates.mandatoryPassRate,
      threshold: merged.minDelegatedWorkspaceGateMandatoryPassRate,
    });
  }

  if (
    artifact.delegatedWorkspaceGates.falseCompletedScenarios >
    merged.maxDelegatedWorkspaceGateFalseCompletedScenarios
  ) {
    pushViolation(violations, {
      scope: "delegated_workspace_gates",
      metric: "false_completed_scenarios",
      observed: artifact.delegatedWorkspaceGates.falseCompletedScenarios,
      threshold: merged.maxDelegatedWorkspaceGateFalseCompletedScenarios,
    });
  }

  if (artifact.chaos.passRate < merged.minChaosPassRate) {
    pushViolation(violations, {
      scope: "chaos",
      metric: "pass_rate",
      observed: artifact.chaos.passRate,
      threshold: merged.minChaosPassRate,
    });
  }

  if (
    artifact.chaos.providerTimeoutRecoveryRate <
    merged.minProviderTimeoutRecoveryRate
  ) {
    pushViolation(violations, {
      scope: "chaos",
      metric: "provider_timeout_recovery_rate",
      observed: artifact.chaos.providerTimeoutRecoveryRate,
      threshold: merged.minProviderTimeoutRecoveryRate,
    });
  }

  if (
    artifact.chaos.toolTimeoutContainmentRate <
    merged.minToolTimeoutContainmentRate
  ) {
    pushViolation(violations, {
      scope: "chaos",
      metric: "tool_timeout_containment_rate",
      observed: artifact.chaos.toolTimeoutContainmentRate,
      threshold: merged.minToolTimeoutContainmentRate,
    });
  }

  if (
    artifact.chaos.persistenceSafeModeRate <
    merged.minPersistenceSafeModeRate
  ) {
    pushViolation(violations, {
      scope: "chaos",
      metric: "persistence_safe_mode_rate",
      observed: artifact.chaos.persistenceSafeModeRate,
      threshold: merged.minPersistenceSafeModeRate,
    });
  }

  if (
    artifact.chaos.approvalStoreSafeModeRate <
    merged.minApprovalStoreSafeModeRate
  ) {
    pushViolation(violations, {
      scope: "chaos",
      metric: "approval_store_safe_mode_rate",
      observed: artifact.chaos.approvalStoreSafeModeRate,
      threshold: merged.minApprovalStoreSafeModeRate,
    });
  }

  if (
    artifact.chaos.childRunCrashContainmentRate <
    merged.minChildRunCrashContainmentRate
  ) {
    pushViolation(violations, {
      scope: "chaos",
      metric: "child_run_crash_containment_rate",
      observed: artifact.chaos.childRunCrashContainmentRate,
      threshold: merged.minChildRunCrashContainmentRate,
    });
  }

  if (
    artifact.chaos.daemonRestartRecoveryRate <
    merged.minDaemonRestartRecoveryRate
  ) {
    pushViolation(violations, {
      scope: "chaos",
      metric: "daemon_restart_recovery_rate",
      observed: artifact.chaos.daemonRestartRecoveryRate,
      threshold: merged.minDaemonRestartRecoveryRate,
    });
  }

  if (economics.passRate < merged.minEconomicsPassRate) {
    pushViolation(violations, {
      scope: "economics",
      metric: "pass_rate",
      observed: economics.passRate,
      threshold: merged.minEconomicsPassRate,
    });
  }

  if (
    economics.tokenCeilingComplianceRate <
    merged.minEconomicsTokenComplianceRate
  ) {
    pushViolation(violations, {
      scope: "economics",
      metric: "token_ceiling_compliance_rate",
      observed: economics.tokenCeilingComplianceRate,
      threshold: merged.minEconomicsTokenComplianceRate,
    });
  }

  if (
    economics.latencyCeilingComplianceRate <
    merged.minEconomicsLatencyComplianceRate
  ) {
    pushViolation(violations, {
      scope: "economics",
      metric: "latency_ceiling_compliance_rate",
      observed: economics.latencyCeilingComplianceRate,
      threshold: merged.minEconomicsLatencyComplianceRate,
    });
  }

  if (
    economics.spendCeilingComplianceRate <
    merged.minEconomicsSpendComplianceRate
  ) {
    pushViolation(violations, {
      scope: "economics",
      metric: "spend_ceiling_compliance_rate",
      observed: economics.spendCeilingComplianceRate,
      threshold: merged.minEconomicsSpendComplianceRate,
    });
  }

  if (
    economics.negativeEconomicsDelegationDenialRate <
    merged.minNegativeEconomicsDelegationDenialRate
  ) {
    pushViolation(violations, {
      scope: "economics",
      metric: "negative_economics_delegation_denial_rate",
      observed: economics.negativeEconomicsDelegationDenialRate,
      threshold: merged.minNegativeEconomicsDelegationDenialRate,
    });
  }

  if (
    economics.degradedProviderRerouteRate <
    merged.minDegradedProviderRerouteRate
  ) {
    pushViolation(violations, {
      scope: "economics",
      metric: "degraded_provider_reroute_rate",
      observed: economics.degradedProviderRerouteRate,
      threshold: merged.minDegradedProviderRerouteRate,
    });
  }

  return {
    passed: violations.length === 0,
    thresholds: merged,
    violations,
    failFastTriggered: false,
  };
}

/**
 * Human-readable gate report for CI logs.
 */
export function formatPipelineQualityGateEvaluation(
  evaluation: PipelineGateEvaluation,
): string {
  const lines = [
    `Pipeline quality gates: ${evaluation.passed ? "PASS" : "FAIL"}`,
    "Thresholds:",
    `  context growth slope <= ${evaluation.thresholds.maxContextGrowthSlope.toFixed(4)}`,
    `  context growth max delta <= ${evaluation.thresholds.maxContextGrowthDelta.toFixed(4)}`,
    `  tokens/completed task <= ${evaluation.thresholds.maxTokensPerCompletedTask.toFixed(4)}`,
    `  malformed tool-turn forwarded <= ${evaluation.thresholds.maxMalformedToolTurnForwarded.toFixed(4)}`,
    `  malformed tool-turn rejected rate >= ${evaluation.thresholds.minMalformedToolTurnRejectedRate.toFixed(4)}`,
    `  desktop failed runs <= ${evaluation.thresholds.maxDesktopFailedRuns.toFixed(4)}`,
    `  desktop timeout runs <= ${evaluation.thresholds.maxDesktopTimeoutRuns.toFixed(4)}`,
    `  offline replay failures <= ${evaluation.thresholds.maxOfflineReplayFailures.toFixed(4)}`,
    `  delegation attempt rate >= ${evaluation.thresholds.minDelegationAttemptRate.toFixed(4)}`,
    `  delegation attempt rate <= ${evaluation.thresholds.maxDelegationAttemptRate.toFixed(4)}`,
    `  useful delegation rate >= ${evaluation.thresholds.minUsefulDelegationRate.toFixed(4)}`,
    `  harmful delegation rate <= ${evaluation.thresholds.maxHarmfulDelegationRate.toFixed(4)}`,
    `  planner/execution mismatch rate <= ${evaluation.thresholds.maxPlannerToExecutionMismatchRate.toFixed(4)}`,
    `  child timeout rate <= ${evaluation.thresholds.maxChildTimeoutRate.toFixed(4)}`,
    `  child failure rate <= ${evaluation.thresholds.maxChildFailureRate.toFixed(4)}`,
    `  synthesis conflict rate <= ${evaluation.thresholds.maxSynthesisConflictRate.toFixed(4)}`,
    `  depth cap hit rate <= ${evaluation.thresholds.maxDepthCapHitRate.toFixed(4)}`,
    `  fanout cap hit rate <= ${evaluation.thresholds.maxFanoutCapHitRate.toFixed(4)}`,
    `  cost delta vs baseline <= ${evaluation.thresholds.maxCostDeltaVsBaseline.toFixed(4)}`,
    `  latency delta vs baseline <= ${evaluation.thresholds.maxLatencyDeltaVsBaseline.toFixed(4)}`,
    `  quality delta vs baseline >= ${evaluation.thresholds.minQualityDeltaVsBaseline.toFixed(4)}`,
    `  pass@k delta vs baseline >= ${evaluation.thresholds.minPassAtKDeltaVsBaseline.toFixed(4)}`,
    `  pass^k delta vs baseline >= ${evaluation.thresholds.minPassCaretKDeltaVsBaseline.toFixed(4)}`,
    `  fail-fast harmful delegation rate <= ${evaluation.thresholds.failFastHarmfulDelegationRate.toFixed(4)}`,
    `  fail-fast runaway cap hit rate <= ${evaluation.thresholds.failFastRunawayCapHitRate.toFixed(4)}`,
    `  live coding pass rate >= ${evaluation.thresholds.minLiveCodingPassRate.toFixed(4)}`,
    `  orchestration baseline pass rate >= ${evaluation.thresholds.minOrchestrationBaselinePassRate.toFixed(4)}`,
    `  effect ledger completeness rate >= ${evaluation.thresholds.minEffectLedgerCompletenessRate.toFixed(4)}`,
    `  safety pass rate >= ${evaluation.thresholds.minSafetyPassRate.toFixed(4)}`,
    `  safety approval correctness rate >= ${evaluation.thresholds.minSafetyApprovalCorrectnessRate.toFixed(4)}`,
    `  long-horizon pass rate >= ${evaluation.thresholds.minLongHorizonPassRate.toFixed(4)}`,
    `  restart recovery success rate >= ${evaluation.thresholds.minRestartRecoverySuccessRate.toFixed(4)}`,
    `  compaction continuation rate >= ${evaluation.thresholds.minCompactionContinuationRate.toFixed(4)}`,
    `  background persistence rate >= ${evaluation.thresholds.minBackgroundPersistenceRate.toFixed(4)}`,
    `  implementation-gate mandatory pass rate >= ${evaluation.thresholds.minImplementationGateMandatoryPassRate.toFixed(4)}`,
    `  implementation-gate false-completed scenarios <= ${evaluation.thresholds.maxImplementationGateFalseCompletedScenarios.toFixed(4)}`,
    `  delegated-workspace mandatory pass rate >= ${evaluation.thresholds.minDelegatedWorkspaceGateMandatoryPassRate.toFixed(4)}`,
    `  delegated-workspace false-completed scenarios <= ${evaluation.thresholds.maxDelegatedWorkspaceGateFalseCompletedScenarios.toFixed(4)}`,
    `  chaos pass rate >= ${evaluation.thresholds.minChaosPassRate.toFixed(4)}`,
    `  provider timeout recovery rate >= ${evaluation.thresholds.minProviderTimeoutRecoveryRate.toFixed(4)}`,
    `  tool timeout containment rate >= ${evaluation.thresholds.minToolTimeoutContainmentRate.toFixed(4)}`,
    `  persistence safe-mode rate >= ${evaluation.thresholds.minPersistenceSafeModeRate.toFixed(4)}`,
    `  approval-store safe-mode rate >= ${evaluation.thresholds.minApprovalStoreSafeModeRate.toFixed(4)}`,
    `  child-run crash containment rate >= ${evaluation.thresholds.minChildRunCrashContainmentRate.toFixed(4)}`,
    `  daemon restart recovery rate >= ${evaluation.thresholds.minDaemonRestartRecoveryRate.toFixed(4)}`,
    `  economics pass rate >= ${evaluation.thresholds.minEconomicsPassRate.toFixed(4)}`,
    `  economics token ceiling compliance rate >= ${evaluation.thresholds.minEconomicsTokenComplianceRate.toFixed(4)}`,
    `  economics latency ceiling compliance rate >= ${evaluation.thresholds.minEconomicsLatencyComplianceRate.toFixed(4)}`,
    `  economics spend ceiling compliance rate >= ${evaluation.thresholds.minEconomicsSpendComplianceRate.toFixed(4)}`,
    `  negative-economics delegation denial rate >= ${evaluation.thresholds.minNegativeEconomicsDelegationDenialRate.toFixed(4)}`,
    `  degraded-provider reroute rate >= ${evaluation.thresholds.minDegradedProviderRerouteRate.toFixed(4)}`,
  ];

  if (evaluation.failFastTriggered) {
    lines.push(`Fail-fast triggered: ${evaluation.failFastReason ?? "unknown"}`);
  }

  if (evaluation.violations.length === 0) {
    lines.push("No threshold violations detected.");
    return lines.join("\n");
  }

  lines.push("Violations:");
  for (const violation of evaluation.violations) {
    lines.push(
      `  - [${violation.scope}] ${violation.metric}: observed=${violation.observed.toFixed(6)} threshold=${violation.threshold.toFixed(6)}`,
    );
  }

  return lines.join("\n");
}
