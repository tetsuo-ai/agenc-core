import type { AgentBudgetConfig, BudgetConfig } from "../config/schema.js";
import { resolveBudgetPolicy } from "./config.js";
import type { AdmissionConcurrencyLimits } from "./admission-types.js";

export const DEFAULT_ADMISSION_CONCURRENCY_LIMITS: AdmissionConcurrencyLimits =
  Object.freeze({
    global: 64,
    workspace: 32,
    session: 8,
    parent: 4,
    provider: 16,
  });

const CONCURRENCY_ENV: Readonly<
  Record<keyof AdmissionConcurrencyLimits, string>
> = Object.freeze({
  global: "AGENC_ADMISSION_GLOBAL_CONCURRENCY",
  workspace: "AGENC_ADMISSION_WORKSPACE_CONCURRENCY",
  session: "AGENC_ADMISSION_SESSION_CONCURRENCY",
  parent: "AGENC_ADMISSION_PARENT_CONCURRENCY",
  provider: "AGENC_ADMISSION_PROVIDER_CONCURRENCY",
});

export interface ExecutionAdmissionBudgetPolicy {
  readonly dailyUsd?: number;
  readonly monthlyUsd?: number;
  readonly dailyTokens?: number;
  readonly monthlyTokens?: number;
  readonly runMaxCostUsd?: number;
  readonly runMaxTokens?: number;
  readonly deadlineAt?: string;
}

function positiveInteger(value: string | undefined): number | undefined {
  if (value === undefined || value.trim().length === 0) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function nonNegativeFinite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

export function resolveAdmissionConcurrencyLimits(
  env: NodeJS.ProcessEnv = process.env,
  options: {
    readonly sessionLimit?: number;
    readonly overrides?: Partial<AdmissionConcurrencyLimits>;
  } = {},
): AdmissionConcurrencyLimits {
  const value = (key: keyof AdmissionConcurrencyLimits): number =>
    positiveInteger(env[CONCURRENCY_ENV[key]]) ??
    (key === "session"
      ? positiveInteger(String(options.sessionLimit ?? ""))
      : undefined) ??
    options.overrides?.[key] ??
    DEFAULT_ADMISSION_CONCURRENCY_LIMITS[key];
  return {
    global: value("global"),
    workspace: value("workspace"),
    session: value("session"),
    parent: value("parent"),
    provider: value("provider"),
  };
}

/**
 * Resolve the monetary/token allocation enforced by the SQLite kernel.
 * Existing `[budget]` windows remain opt-in, while `[agent.budget]` run caps
 * are always hard when present. Wall-clock budget becomes a durable deadline.
 */
export function resolveExecutionAdmissionBudgetPolicy(params: {
  readonly budget?: BudgetConfig;
  readonly agentBudget?: AgentBudgetConfig;
  readonly autonomous: boolean;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: Date;
}): ExecutionAdmissionBudgetPolicy {
  const resolved = resolveBudgetPolicy(params.budget, params.env);
  const enforceWindows =
    resolved.policy.enabled &&
    (params.autonomous || resolved.policy.enforceInteractive);
  const wallClockSeconds = nonNegativeFinite(
    params.agentBudget?.wall_clock_seconds,
  );
  const now = params.now ?? new Date();
  return {
    ...(enforceWindows && resolved.policy.caps.dailyUsd !== undefined
      ? { dailyUsd: resolved.policy.caps.dailyUsd }
      : {}),
    ...(enforceWindows && resolved.policy.caps.monthlyUsd !== undefined
      ? { monthlyUsd: resolved.policy.caps.monthlyUsd }
      : {}),
    ...(enforceWindows && resolved.policy.caps.dailyTokens !== undefined
      ? { dailyTokens: resolved.policy.caps.dailyTokens }
      : {}),
    ...(enforceWindows && resolved.policy.caps.monthlyTokens !== undefined
      ? { monthlyTokens: resolved.policy.caps.monthlyTokens }
      : {}),
    ...(nonNegativeFinite(params.agentBudget?.dollar_cap) !== undefined
      ? { runMaxCostUsd: params.agentBudget?.dollar_cap }
      : {}),
    ...(nonNegativeFinite(params.agentBudget?.token_cap) !== undefined
      ? { runMaxTokens: params.agentBudget?.token_cap }
      : {}),
    ...(wallClockSeconds !== undefined
      ? {
          deadlineAt: new Date(
            now.getTime() + wallClockSeconds * 1_000,
          ).toISOString(),
        }
      : {}),
  };
}
