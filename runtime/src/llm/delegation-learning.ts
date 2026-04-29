/**
 * Delegation learning primitives: trajectory schema for offline analysis.
 *
 * The runtime emits normalized trajectory records into an in-memory sink;
 * trainer/offline optimization stays decoupled from execution.
 *
 * @module
 */

export const DELEGATION_TRAJECTORY_SCHEMA_VERSION = 1 as const;

export type DelegationTrajectoryTurnType = "parent" | "child";

export interface DelegationTrajectoryStateFeatures {
  readonly sessionId: string;
  readonly contextClusterId: string;
  readonly complexityScore: number;
  readonly plannerStepCount: number;
  readonly subagentStepCount: number;
  readonly deterministicStepCount: number;
  readonly synthesisStepCount: number;
  readonly dependencyDepth: number;
  readonly fanout: number;
}

export interface DelegationTrajectoryAction {
  readonly delegated: boolean;
  readonly strategyArmId: string;
  readonly threshold: number;
  readonly selectedTools: readonly string[];
  readonly childConfig: {
    readonly maxDepth: number;
    readonly maxFanoutPerTurn: number;
    readonly timeoutMs: number;
  };
}

export interface DelegationTrajectoryImmediateOutcome {
  readonly qualityProxy: number;
  readonly tokenCost: number;
  readonly latencyMs: number;
  readonly errorCount: number;
  readonly errorClass?: string;
}

export interface DelegationTrajectoryFinalReward {
  readonly value: number;
  readonly qualityComponent: number;
  readonly costPenalty: number;
  readonly latencyPenalty: number;
  readonly errorPenalty: number;
}

export interface DelegationTrajectoryRecord {
  readonly schemaVersion: typeof DELEGATION_TRAJECTORY_SCHEMA_VERSION;
  readonly traceId: string;
  readonly turnId: string;
  readonly parentTurnId?: string;
  readonly turnType: DelegationTrajectoryTurnType;
  readonly timestampMs: number;
  readonly stateFeatures: DelegationTrajectoryStateFeatures;
  readonly action: DelegationTrajectoryAction;
  readonly immediateOutcome: DelegationTrajectoryImmediateOutcome;
  readonly finalReward: DelegationTrajectoryFinalReward;
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;
}

export interface DelegationTrajectorySink {
  record(record: DelegationTrajectoryRecord): void;
}

export interface InMemoryDelegationTrajectorySinkConfig {
  readonly maxRecords?: number;
}

export class InMemoryDelegationTrajectorySink implements DelegationTrajectorySink {
  private readonly maxRecords: number;
  private readonly records: DelegationTrajectoryRecord[] = [];

  constructor(config: InMemoryDelegationTrajectorySinkConfig = {}) {
    this.maxRecords = Math.max(1, Math.floor(config.maxRecords ?? 10_000));
  }

  record(record: DelegationTrajectoryRecord): void {
    this.records.push(record);
    if (this.records.length <= this.maxRecords) return;
    this.records.splice(0, this.records.length - this.maxRecords);
  }

  snapshot(): readonly DelegationTrajectoryRecord[] {
    return [...this.records];
  }

  clear(): void {
    this.records.splice(0, this.records.length);
  }
}

export interface DelegationFinalRewardInput {
  readonly qualityProxy: number;
  readonly tokenCost: number;
  readonly latencyMs: number;
  readonly errorCount: number;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function clampNeg1To1(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-1, Math.min(1, value));
}

function normalizeCostPenalty(tokenCost: number): number {
  if (!Number.isFinite(tokenCost) || tokenCost <= 0) return 0;
  return clamp01(tokenCost / 120_000);
}

function normalizeLatencyPenalty(latencyMs: number): number {
  if (!Number.isFinite(latencyMs) || latencyMs <= 0) return 0;
  return clamp01(latencyMs / 90_000);
}

export function computeDelegationFinalReward(
  input: DelegationFinalRewardInput,
): DelegationTrajectoryFinalReward {
  const qualityComponent = clamp01(input.qualityProxy);
  const costPenalty = normalizeCostPenalty(input.tokenCost);
  const latencyPenalty = normalizeLatencyPenalty(input.latencyMs);
  const errorPenalty = clamp01(input.errorCount > 0 ? 1 : 0);

  const value = clampNeg1To1(
    qualityComponent -
      0.2 * costPenalty -
      0.2 * latencyPenalty -
      0.35 * errorPenalty,
  );

  return {
    value,
    qualityComponent,
    costPenalty,
    latencyPenalty,
    errorPenalty,
  };
}

export type DelegationComplexityBucket =
  | "low"
  | "medium"
  | "high"
  | "critical";

export function deriveDelegationComplexityBucket(
  complexityScore: number,
): DelegationComplexityBucket {
  if (!Number.isFinite(complexityScore)) return "low";
  if (complexityScore >= 9) return "critical";
  if (complexityScore >= 7) return "high";
  if (complexityScore >= 4) return "medium";
  return "low";
}

export interface DelegationContextClusterInput {
  readonly complexityScore: number;
  readonly subagentStepCount: number;
  readonly hasHistory: boolean;
  readonly highRiskPlan: boolean;
}

export function deriveDelegationContextClusterId(
  input: DelegationContextClusterInput,
): string {
  const complexity = deriveDelegationComplexityBucket(input.complexityScore);
  const shape = input.subagentStepCount >= 3
    ? "fanout"
    : input.subagentStepCount >= 1
      ? "single"
      : "none";
  const history = input.hasHistory ? "history" : "fresh";
  const risk = input.highRiskPlan ? "highrisk" : "normal";
  return `${complexity}:${shape}:${history}:${risk}`;
}

