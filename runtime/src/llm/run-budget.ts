/**
 * Runtime budget — collapsed stub (Cut 1.2).
 *
 * Replaces the previous 552-LOC per-run-class economics ledger
 * (planner/executor/verifier/child token + latency + spend ceilings,
 * downgrade ratio computation, route telemetry, denial counters).
 * The planner subsystem that produced these run classes has been
 * deleted, so the runtime now reports an empty unbounded shape and
 * `recordRuntimeModelCall` is a no-op. The exported types are kept so
 * chat-executor + gateway/sub-agent constructor wiring still links.
 *
 * @module
 */

import type { LLMUsage } from "./types.js";

export type RuntimeBudgetMode = "report_only" | "enforce";

export type RuntimeRunClass =
  | "planner"
  | "executor"
  | "verifier"
  | "child";

export interface RuntimeRunBudget {
  readonly runClass: RuntimeRunClass;
  readonly tokenCeiling: number;
  readonly latencyCeilingMs: number;
  readonly spendCeilingUnits: number;
  readonly downgradeTokenRatio: number;
  readonly downgradeSpendRatio: number;
  readonly downgradeLatencyRatio: number;
}

export interface RuntimeRouteTelemetry {
  readonly runClass: RuntimeRunClass;
  readonly phase: string;
  readonly provider: string;
  readonly model?: string;
  readonly rerouted: boolean;
  readonly downgraded: boolean;
  readonly reason?: string;
}

export interface RuntimeRunBudgetLedger {
  readonly runClass: RuntimeRunClass;
  tokens: number;
  latencyMs: number;
  spendUnits: number;
  calls: number;
  reroutes: number;
  downgrades: number;
  ceilingBreaches: number;
  denialCount: number;
  lastProvider?: string;
  lastModel?: string;
}

export interface RuntimeEconomicsPolicy {
  readonly mode: RuntimeBudgetMode;
  readonly budgets: Readonly<Record<RuntimeRunClass, RuntimeRunBudget>>;
  readonly childFanoutSoftCap: number;
  readonly negativeDelegationMarginUnits: number;
  readonly negativeDelegationMarginTokens: number;
}

export interface RuntimeEconomicsState {
  readonly perRunClass: Record<RuntimeRunClass, RuntimeRunBudgetLedger>;
  readonly routes: RuntimeRouteTelemetry[];
  totalTokens: number;
  totalLatencyMs: number;
  totalSpendUnits: number;
  rerouteCount: number;
  downgradeCount: number;
  denialCount: number;
  budgetViolationCount: number;
}

export interface RuntimeBudgetPressure {
  readonly tokenRatio: number;
  readonly latencyRatio: number;
  readonly spendRatio: number;
  readonly hardExceeded: boolean;
  readonly shouldDowngrade: boolean;
}

export interface RuntimeRunBudgetSummary {
  readonly budget: RuntimeRunBudget;
  readonly usage: {
    readonly tokens: number;
    readonly latencyMs: number;
    readonly spendUnits: number;
    readonly calls: number;
    readonly reroutes: number;
    readonly downgrades: number;
    readonly ceilingBreaches: number;
    readonly denials: number;
  };
  readonly pressure: RuntimeBudgetPressure;
  readonly lastProvider?: string;
  readonly lastModel?: string;
}

export interface RuntimeEconomicsSummary {
  readonly mode: RuntimeBudgetMode;
  readonly totalTokens: number;
  readonly totalLatencyMs: number;
  readonly totalSpendUnits: number;
  readonly rerouteCount: number;
  readonly downgradeCount: number;
  readonly denialCount: number;
  readonly budgetViolationCount: number;
  readonly runClasses: Readonly<Record<RuntimeRunClass, RuntimeRunBudgetSummary>>;
  readonly routes: readonly RuntimeRouteTelemetry[];
}

export interface DelegationBudgetSnapshot {
  readonly mode: RuntimeBudgetMode;
  readonly childBudget: RuntimeRunBudget;
  readonly remainingTokens: number;
  readonly remainingLatencyMs: number;
  readonly remainingSpendUnits: number;
  readonly parentTokenRatio: number;
  readonly parentLatencyRatio: number;
  readonly parentSpendRatio: number;
  readonly childFanoutSoftCap: number;
  readonly negativeDelegationMarginUnits: number;
  readonly negativeDelegationMarginTokens: number;
}

const UNBOUNDED_BUDGET = (runClass: RuntimeRunClass): RuntimeRunBudget => ({
  runClass,
  tokenCeiling: Number.POSITIVE_INFINITY,
  latencyCeilingMs: Number.POSITIVE_INFINITY,
  spendCeilingUnits: Number.POSITIVE_INFINITY,
  downgradeTokenRatio: 1,
  downgradeSpendRatio: 1,
  downgradeLatencyRatio: 1,
});

const UNBOUNDED_LEDGER = (runClass: RuntimeRunClass): RuntimeRunBudgetLedger => ({
  runClass,
  tokens: 0,
  latencyMs: 0,
  spendUnits: 0,
  calls: 0,
  reroutes: 0,
  downgrades: 0,
  ceilingBreaches: 0,
  denialCount: 0,
});

export function mapPhaseToRunClass(_phase: string): RuntimeRunClass {
  return "executor";
}

export function buildRuntimeEconomicsPolicy(_params: {
  readonly sessionTokenBudget?: number;
  readonly plannerMaxTokens?: number;
  readonly requestTimeoutMs?: number;
  readonly childTimeoutMs?: number;
  readonly childTokenBudget?: number;
  readonly maxFanoutPerTurn?: number;
  readonly mode?: RuntimeBudgetMode;
}): RuntimeEconomicsPolicy {
  return {
    mode: "report_only",
    budgets: {
      planner: UNBOUNDED_BUDGET("planner"),
      executor: UNBOUNDED_BUDGET("executor"),
      verifier: UNBOUNDED_BUDGET("verifier"),
      child: UNBOUNDED_BUDGET("child"),
    },
    childFanoutSoftCap: Number.POSITIVE_INFINITY,
    negativeDelegationMarginUnits: 0,
    negativeDelegationMarginTokens: 0,
  };
}

export function createRuntimeEconomicsState(): RuntimeEconomicsState {
  return {
    perRunClass: {
      planner: UNBOUNDED_LEDGER("planner"),
      executor: UNBOUNDED_LEDGER("executor"),
      verifier: UNBOUNDED_LEDGER("verifier"),
      child: UNBOUNDED_LEDGER("child"),
    },
    routes: [],
    totalTokens: 0,
    totalLatencyMs: 0,
    totalSpendUnits: 0,
    rerouteCount: 0,
    downgradeCount: 0,
    denialCount: 0,
    budgetViolationCount: 0,
  };
}

export function estimateSpendUnitsForUsage(_params: {
  readonly usage: LLMUsage;
  readonly provider?: string;
  readonly model?: string;
}): number {
  return 0;
}

export function getRuntimeBudgetPressure(
  _policy: RuntimeEconomicsPolicy,
  _state: RuntimeEconomicsState,
  _runClass: RuntimeRunClass,
): RuntimeBudgetPressure {
  return {
    tokenRatio: 0,
    latencyRatio: 0,
    spendRatio: 0,
    hardExceeded: false,
    shouldDowngrade: false,
  };
}

export function recordRuntimeModelCall(_params: {
  readonly policy: RuntimeEconomicsPolicy;
  readonly state: RuntimeEconomicsState;
  readonly runClass: RuntimeRunClass;
  readonly provider: string;
  readonly model?: string;
  readonly usage: LLMUsage;
  readonly durationMs: number;
  readonly rerouted: boolean;
  readonly downgraded: boolean;
  readonly phase: string;
  readonly reason?: string;
}): void {
  // no-op
}

export function recordRuntimeDenial(
  _state: RuntimeEconomicsState,
  _runClass: RuntimeRunClass,
): void {
  // no-op
}

export function buildDelegationBudgetSnapshot(
  policy: RuntimeEconomicsPolicy,
  _state: RuntimeEconomicsState,
): DelegationBudgetSnapshot {
  return {
    mode: policy.mode,
    childBudget: policy.budgets.child,
    remainingTokens: Number.POSITIVE_INFINITY,
    remainingLatencyMs: Number.POSITIVE_INFINITY,
    remainingSpendUnits: Number.POSITIVE_INFINITY,
    parentTokenRatio: 0,
    parentLatencyRatio: 0,
    parentSpendRatio: 0,
    childFanoutSoftCap: policy.childFanoutSoftCap,
    negativeDelegationMarginUnits: policy.negativeDelegationMarginUnits,
    negativeDelegationMarginTokens: policy.negativeDelegationMarginTokens,
  };
}

export function buildRuntimeEconomicsSummary(
  policy: RuntimeEconomicsPolicy,
  state: RuntimeEconomicsState,
): RuntimeEconomicsSummary {
  const blankPressure: RuntimeBudgetPressure = {
    tokenRatio: 0,
    latencyRatio: 0,
    spendRatio: 0,
    hardExceeded: false,
    shouldDowngrade: false,
  };
  const buildSummary = (runClass: RuntimeRunClass): RuntimeRunBudgetSummary => ({
    budget: policy.budgets[runClass],
    usage: {
      tokens: 0,
      latencyMs: 0,
      spendUnits: 0,
      calls: 0,
      reroutes: 0,
      downgrades: 0,
      ceilingBreaches: 0,
      denials: 0,
    },
    pressure: blankPressure,
  });
  return {
    mode: policy.mode,
    totalTokens: state.totalTokens,
    totalLatencyMs: state.totalLatencyMs,
    totalSpendUnits: state.totalSpendUnits,
    rerouteCount: state.rerouteCount,
    downgradeCount: state.downgradeCount,
    denialCount: state.denialCount,
    budgetViolationCount: state.budgetViolationCount,
    runClasses: {
      planner: buildSummary("planner"),
      executor: buildSummary("executor"),
      verifier: buildSummary("verifier"),
      child: buildSummary("child"),
    },
    routes: state.routes,
  };
}
