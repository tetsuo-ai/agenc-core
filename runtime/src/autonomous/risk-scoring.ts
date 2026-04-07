/**
 * Adaptive verifier risk scoring — collapsed stub (Cut 3.1).
 *
 * Replaces the previous 215-LOC weighted feature scoring used by the
 * adaptive verifier policy. The verifier lane has been deleted; every
 * task now scores as low risk.
 *
 * @module
 */

import type {
  Task,
  VerifierAdaptiveRiskWeights,
} from "./types.js";

export type RiskTier = "low" | "medium" | "high";

export interface RiskFeatureVector {
  rewardSignal: number;
  deadlineSignal: number;
  claimPressureSignal: number;
  taskTypeSignal: number;
  verifierDisagreementSignal: number;
  rollbackSignal: number;
}

export interface RiskContribution {
  feature: keyof RiskFeatureVector;
  value: number;
  weight: number;
  contribution: number;
}

export interface TaskRiskScoringContext {
  nowMs?: number;
  verifierDisagreementRate?: number;
  rollbackRate?: number;
  taskTypeRiskMultiplier?: number;
}

export interface TaskRiskScoringConfig {
  mediumRiskThreshold?: number;
  highRiskThreshold?: number;
  weights?: VerifierAdaptiveRiskWeights;
  taskTypeRiskMultipliers?: Record<number, number>;
}

export interface TaskRiskScoreResult {
  score: number;
  tier: RiskTier;
  features: RiskFeatureVector;
  contributions: RiskContribution[];
  metadata: {
    mediumRiskThreshold: number;
    highRiskThreshold: number;
  };
}

export function extractTaskRiskFeatures(
  _task: Task,
  _context?: TaskRiskScoringContext,
): RiskFeatureVector {
  return {
    rewardSignal: 0,
    deadlineSignal: 0,
    claimPressureSignal: 0,
    taskTypeSignal: 0,
    verifierDisagreementSignal: 0,
    rollbackSignal: 0,
  };
}

export function scoreTaskRisk(
  task: Task,
  _context?: TaskRiskScoringContext,
  _adaptiveRisk?: unknown,
  _scoringConfig?: TaskRiskScoringConfig,
): TaskRiskScoreResult {
  return {
    score: 0,
    tier: "low",
    features: extractTaskRiskFeatures(task),
    contributions: [],
    metadata: { mediumRiskThreshold: 0.35, highRiskThreshold: 0.7 },
  };
}
