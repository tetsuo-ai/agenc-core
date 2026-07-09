/**
 * Budget policy resolution (TODO task 15), env > config > default — mirroring
 * transaction-guard/config.ts. Disabled by default: zero behavior change until
 * an operator opts in.
 *
 * Env overrides:
 *   AGENC_BUDGET                 "on"/"1"/"true" enables, any other value disables
 *   AGENC_BUDGET_DAILY_USD       hard daily dollar cap
 *   AGENC_BUDGET_MONTHLY_USD     hard monthly dollar cap
 *   AGENC_BUDGET_SOFT_THRESHOLD  soft-warning fraction [0,1)
 *   AGENC_BUDGET_ENFORCE_INTERACTIVE  "1"/"true" also gates interactive turns
 */

import type { BudgetConfig } from "../config/schema.js";
import type {
  BudgetPolicy,
  BudgetPolicySources,
  BudgetValueSource,
  ResolvedBudgetPolicy,
} from "./types.js";

const DEFAULT_SOFT_THRESHOLD = 0.8;

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.trim().length > 0 ? value.trim() : undefined;
}

function parsePositiveNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parseBool(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const v = value.trim().toLowerCase();
  if (v === "on" || v === "1" || v === "true" || v === "yes") return true;
  if (v === "off" || v === "0" || v === "false" || v === "no") return false;
  return undefined;
}

/**
 * Resolve the budget policy from the `[budget]` config block and the
 * environment. Caps: env wins, else config; a cap of 0/absent means no cap.
 */
export function resolveBudgetPolicy(
  config?: BudgetConfig,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedBudgetPolicy {
  // enabled
  let enabled = false;
  let enabledSource: BudgetValueSource = "default";
  const envEnabled = parseBool(nonEmpty(env.AGENC_BUDGET));
  if (envEnabled !== undefined) {
    enabled = envEnabled;
    enabledSource = "env";
  } else if (config?.enabled !== undefined) {
    enabled = config.enabled;
    enabledSource = "config";
  }

  // daily USD cap
  let dailyUsd: number | undefined;
  let dailyUsdSource: BudgetValueSource = "default";
  const envDaily = parsePositiveNumber(nonEmpty(env.AGENC_BUDGET_DAILY_USD));
  if (envDaily !== undefined) {
    dailyUsd = envDaily;
    dailyUsdSource = "env";
  } else if (config?.daily_usd !== undefined && config.daily_usd > 0) {
    dailyUsd = config.daily_usd;
    dailyUsdSource = "config";
  }

  // monthly USD cap
  let monthlyUsd: number | undefined;
  let monthlyUsdSource: BudgetValueSource = "default";
  const envMonthly = parsePositiveNumber(nonEmpty(env.AGENC_BUDGET_MONTHLY_USD));
  if (envMonthly !== undefined) {
    monthlyUsd = envMonthly;
    monthlyUsdSource = "env";
  } else if (config?.monthly_usd !== undefined && config.monthly_usd > 0) {
    monthlyUsd = config.monthly_usd;
    monthlyUsdSource = "config";
  }

  // token caps (config or env, env wins)
  const dailyTokens =
    parsePositiveNumber(nonEmpty(env.AGENC_BUDGET_DAILY_TOKENS)) ??
    (config?.daily_tokens !== undefined && config.daily_tokens > 0
      ? config.daily_tokens
      : undefined);
  const monthlyTokens =
    parsePositiveNumber(nonEmpty(env.AGENC_BUDGET_MONTHLY_TOKENS)) ??
    (config?.monthly_tokens !== undefined && config.monthly_tokens > 0
      ? config.monthly_tokens
      : undefined);

  // soft threshold
  let softThreshold =
    config?.soft_threshold !== undefined &&
    config.soft_threshold > 0 &&
    config.soft_threshold < 1
      ? config.soft_threshold
      : DEFAULT_SOFT_THRESHOLD;
  const envSoft = parsePositiveNumber(nonEmpty(env.AGENC_BUDGET_SOFT_THRESHOLD));
  if (envSoft !== undefined && envSoft < 1) softThreshold = envSoft;

  const enforceInteractive =
    parseBool(nonEmpty(env.AGENC_BUDGET_ENFORCE_INTERACTIVE)) ??
    config?.enforce_interactive ??
    false;

  const policy: BudgetPolicy = {
    enabled,
    softThreshold,
    enforceInteractive,
    caps: {
      ...(dailyUsd !== undefined ? { dailyUsd } : {}),
      ...(monthlyUsd !== undefined ? { monthlyUsd } : {}),
      ...(dailyTokens !== undefined ? { dailyTokens } : {}),
      ...(monthlyTokens !== undefined ? { monthlyTokens } : {}),
    },
  };
  const sources: BudgetPolicySources = {
    enabled: enabledSource,
    dailyUsd: dailyUsdSource,
    monthlyUsd: monthlyUsdSource,
  };
  return { policy, sources };
}
