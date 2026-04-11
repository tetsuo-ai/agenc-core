import { hasRuntimeLimit } from "./runtime-limit-policy.js";
import type { LLMUsage } from "./types.js";

export type RuntimeBudgetMode = "report_only" | "enforce";

export type RuntimeRunClass =
  | "planner"
  | "executor"
  | "verifier"
  | "child";

interface RuntimeRunBudget {
  readonly runClass: RuntimeRunClass;
  readonly tokenCeiling: number;
  readonly latencyCeilingMs: number;
  readonly spendCeilingUnits: number;
  readonly downgradeTokenRatio: number;
  readonly downgradeSpendRatio: number;
  readonly downgradeLatencyRatio: number;
}

interface RuntimeRouteTelemetry {
  readonly runClass: RuntimeRunClass;
  readonly phase: string;
  readonly provider: string;
  readonly model?: string;
  readonly rerouted: boolean;
  readonly downgraded: boolean;
  readonly reason?: string;
}

interface RuntimeRunBudgetLedger {
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

interface RuntimeBudgetPressure {
  readonly tokenRatio: number;
  readonly latencyRatio: number;
  readonly spendRatio: number;
  readonly hardExceeded: boolean;
  readonly shouldDowngrade: boolean;
}

interface RuntimeRunBudgetSummary {
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

const DEFAULT_DOWNGRADE_RATIO = 0.7;
const DEFAULT_NEGATIVE_DELEGATION_MARGIN_UNITS = 0.2;
const DEFAULT_NEGATIVE_DELEGATION_MARGIN_TOKENS = 64;
const DEFAULT_MIN_SPEND_UNITS = 0.25;
const TOKEN_TO_SPEND_UNIT_DIVISOR = 256;

function normalizeLimitedNumber(value: number | undefined): number {
  return hasRuntimeLimit(value)
    ? Math.max(1, Math.floor(Number(value)))
    : Number.POSITIVE_INFINITY;
}

function resolveBudgetCeiling(
  primary: number | undefined,
  fallback?: number,
): number {
  const resolvedPrimary = normalizeLimitedNumber(primary);
  if (hasRuntimeLimit(resolvedPrimary)) {
    return resolvedPrimary;
  }
  const resolvedFallback = normalizeLimitedNumber(fallback);
  return hasRuntimeLimit(resolvedFallback)
    ? resolvedFallback
    : Number.POSITIVE_INFINITY;
}

function resolveRatio(used: number, limit: number): number {
  if (!hasRuntimeLimit(limit)) {
    return 0;
  }
  return used / Math.max(1, limit);
}

function normalizeNonNegative(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, value);
}

function estimateSpendUnits(totalTokens: number): number {
  if (!Number.isFinite(totalTokens) || totalTokens <= 0) {
    return 0;
  }
  return Number((totalTokens / TOKEN_TO_SPEND_UNIT_DIVISOR).toFixed(4));
}

function createRuntimeRunBudget(
  runClass: RuntimeRunClass,
  params: {
    readonly tokenCeiling: number;
    readonly latencyCeilingMs: number;
    readonly spendCeilingUnits: number;
  },
): RuntimeRunBudget {
  return {
    runClass,
    tokenCeiling: params.tokenCeiling,
    latencyCeilingMs: params.latencyCeilingMs,
    spendCeilingUnits: params.spendCeilingUnits,
    downgradeTokenRatio: DEFAULT_DOWNGRADE_RATIO,
    downgradeSpendRatio: DEFAULT_DOWNGRADE_RATIO,
    downgradeLatencyRatio: DEFAULT_DOWNGRADE_RATIO,
  };
}

function createRuntimeRunBudgetLedger(
  runClass: RuntimeRunClass,
): RuntimeRunBudgetLedger {
  return {
    runClass,
    tokens: 0,
    latencyMs: 0,
    spendUnits: 0,
    calls: 0,
    reroutes: 0,
    downgrades: 0,
    ceilingBreaches: 0,
    denialCount: 0,
  };
}

function createRuntimeBudgetPressure(
  budget: RuntimeRunBudget,
  ledger: RuntimeRunBudgetLedger,
): RuntimeBudgetPressure {
  const tokenRatio = resolveRatio(ledger.tokens, budget.tokenCeiling);
  const latencyRatio = resolveRatio(ledger.latencyMs, budget.latencyCeilingMs);
  const spendRatio = resolveRatio(ledger.spendUnits, budget.spendCeilingUnits);
  const hardExceeded =
    (hasRuntimeLimit(budget.tokenCeiling) && ledger.tokens >= budget.tokenCeiling) ||
    (hasRuntimeLimit(budget.latencyCeilingMs) &&
      ledger.latencyMs >= budget.latencyCeilingMs) ||
    (hasRuntimeLimit(budget.spendCeilingUnits) &&
      ledger.spendUnits >= budget.spendCeilingUnits);
  const shouldDowngrade =
    !hardExceeded &&
    (tokenRatio >= budget.downgradeTokenRatio ||
      latencyRatio >= budget.downgradeLatencyRatio ||
      spendRatio >= budget.downgradeSpendRatio);
  return {
    tokenRatio,
    latencyRatio,
    spendRatio,
    hardExceeded,
    shouldDowngrade,
  };
}

export function mapPhaseToRunClass(phase: string): RuntimeRunClass {
  switch (phase.trim().toLowerCase()) {
    case "compaction":
    case "planner":
    case "planner_synthesis":
      return "planner";
    case "planner_verifier":
    case "evaluator":
    case "evaluator_retry":
    case "review":
      return "verifier";
    default:
      return "executor";
  }
}

export function buildRuntimeEconomicsPolicy(params: {
  readonly sessionTokenBudget?: number;
  readonly plannerMaxTokens?: number;
  readonly requestTimeoutMs?: number;
  readonly childTimeoutMs?: number;
  readonly childTokenBudget?: number;
  readonly maxFanoutPerTurn?: number;
  readonly mode?: RuntimeBudgetMode;
}): RuntimeEconomicsPolicy {
  const sessionTokenBudget = resolveBudgetCeiling(params.sessionTokenBudget);
  const plannerTokenCeiling = resolveBudgetCeiling(
    params.plannerMaxTokens,
    sessionTokenBudget,
  );
  const verifierTokenCeiling = resolveBudgetCeiling(
    params.plannerMaxTokens,
    sessionTokenBudget,
  );
  const childTokenCeiling = resolveBudgetCeiling(
    params.childTokenBudget,
    sessionTokenBudget,
  );
  const requestTimeoutMs = resolveBudgetCeiling(params.requestTimeoutMs);
  const childTimeoutMs = resolveBudgetCeiling(
    params.childTimeoutMs,
    requestTimeoutMs,
  );

  const budgets = {
    planner: createRuntimeRunBudget("planner", {
      tokenCeiling: plannerTokenCeiling,
      latencyCeilingMs: requestTimeoutMs,
      spendCeilingUnits: hasRuntimeLimit(plannerTokenCeiling)
        ? Math.max(
            DEFAULT_MIN_SPEND_UNITS,
            estimateSpendUnits(plannerTokenCeiling),
          )
        : Number.POSITIVE_INFINITY,
    }),
    executor: createRuntimeRunBudget("executor", {
      tokenCeiling: sessionTokenBudget,
      latencyCeilingMs: requestTimeoutMs,
      spendCeilingUnits: hasRuntimeLimit(sessionTokenBudget)
        ? Math.max(
            DEFAULT_MIN_SPEND_UNITS,
            estimateSpendUnits(sessionTokenBudget),
          )
        : Number.POSITIVE_INFINITY,
    }),
    verifier: createRuntimeRunBudget("verifier", {
      tokenCeiling: verifierTokenCeiling,
      latencyCeilingMs: requestTimeoutMs,
      spendCeilingUnits: hasRuntimeLimit(verifierTokenCeiling)
        ? Math.max(
            DEFAULT_MIN_SPEND_UNITS,
            estimateSpendUnits(verifierTokenCeiling),
          )
        : Number.POSITIVE_INFINITY,
    }),
    child: createRuntimeRunBudget("child", {
      tokenCeiling: childTokenCeiling,
      latencyCeilingMs: childTimeoutMs,
      spendCeilingUnits: hasRuntimeLimit(childTokenCeiling)
        ? Math.max(
            DEFAULT_MIN_SPEND_UNITS,
            estimateSpendUnits(childTokenCeiling),
          )
        : Number.POSITIVE_INFINITY,
    }),
  } satisfies Record<RuntimeRunClass, RuntimeRunBudget>;

  return {
    mode: params.mode ?? "report_only",
    budgets,
    childFanoutSoftCap: hasRuntimeLimit(params.maxFanoutPerTurn)
      ? Math.max(1, Math.floor(Number(params.maxFanoutPerTurn)))
      : Number.POSITIVE_INFINITY,
    negativeDelegationMarginUnits: DEFAULT_NEGATIVE_DELEGATION_MARGIN_UNITS,
    negativeDelegationMarginTokens: DEFAULT_NEGATIVE_DELEGATION_MARGIN_TOKENS,
  };
}

export function createRuntimeEconomicsState(): RuntimeEconomicsState {
  return {
    perRunClass: {
      planner: createRuntimeRunBudgetLedger("planner"),
      executor: createRuntimeRunBudgetLedger("executor"),
      verifier: createRuntimeRunBudgetLedger("verifier"),
      child: createRuntimeRunBudgetLedger("child"),
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

export function getRuntimeBudgetPressure(
  policy: RuntimeEconomicsPolicy,
  state: RuntimeEconomicsState,
  runClass: RuntimeRunClass,
): RuntimeBudgetPressure {
  return createRuntimeBudgetPressure(
    policy.budgets[runClass],
    state.perRunClass[runClass],
  );
}

export function recordRuntimeModelCall(params: {
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
  const ledger = params.state.perRunClass[params.runClass];
  const pressureBefore = createRuntimeBudgetPressure(
    params.policy.budgets[params.runClass],
    ledger,
  );
  const totalTokens = normalizeNonNegative(params.usage.totalTokens);
  const durationMs = normalizeNonNegative(params.durationMs);
  const spendUnits = estimateSpendUnits(totalTokens);

  ledger.tokens += totalTokens;
  ledger.latencyMs += durationMs;
  ledger.spendUnits = Number((ledger.spendUnits + spendUnits).toFixed(4));
  ledger.calls += 1;
  if (params.rerouted) {
    ledger.reroutes += 1;
    params.state.rerouteCount += 1;
  }
  if (params.downgraded) {
    ledger.downgrades += 1;
    params.state.downgradeCount += 1;
  }
  ledger.lastProvider = params.provider;
  ledger.lastModel = params.model;

  params.state.totalTokens += totalTokens;
  params.state.totalLatencyMs += durationMs;
  params.state.totalSpendUnits = Number(
    (params.state.totalSpendUnits + spendUnits).toFixed(4),
  );
  params.state.routes.push({
    runClass: params.runClass,
    phase: params.phase,
    provider: params.provider,
    model: params.model,
    rerouted: params.rerouted,
    downgraded: params.downgraded,
    reason: params.reason,
  });

  const pressureAfter = createRuntimeBudgetPressure(
    params.policy.budgets[params.runClass],
    ledger,
  );
  if (!pressureBefore.hardExceeded && pressureAfter.hardExceeded) {
    ledger.ceilingBreaches += 1;
    params.state.budgetViolationCount += 1;
  }
}

export function buildRuntimeEconomicsSummary(
  policy: RuntimeEconomicsPolicy,
  state: RuntimeEconomicsState,
): RuntimeEconomicsSummary {
  const buildSummary = (runClass: RuntimeRunClass): RuntimeRunBudgetSummary => {
    const ledger = state.perRunClass[runClass];
    const budget = policy.budgets[runClass];
    return {
      budget,
      usage: {
        tokens: ledger.tokens,
        latencyMs: ledger.latencyMs,
        spendUnits: ledger.spendUnits,
        calls: ledger.calls,
        reroutes: ledger.reroutes,
        downgrades: ledger.downgrades,
        ceilingBreaches: ledger.ceilingBreaches,
        denials: ledger.denialCount,
      },
      pressure: createRuntimeBudgetPressure(budget, ledger),
      lastProvider: ledger.lastProvider,
      lastModel: ledger.lastModel,
    };
  };

  return {
    mode: policy.mode,
    totalTokens: state.totalTokens,
    totalLatencyMs: state.totalLatencyMs,
    totalSpendUnits: Number(state.totalSpendUnits.toFixed(4)),
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
    routes: [...state.routes],
  };
}
