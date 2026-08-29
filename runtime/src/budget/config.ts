/**
 * Budget policy projection from the already-layered canonical config.
 * Disabled by default: zero behavior change until an operator opts in.
 */

import type { BudgetConfig } from "../config/schema.js";
import type { BudgetPolicy } from "./types.js";

const DEFAULT_SOFT_THRESHOLD = 0.8;

function positive(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

/**
 * Resolve the budget policy from an already-layered `[budget]` config block.
 * A cap of 0/absent means no cap. Never reads process-global environment state.
 */
export function resolveBudgetPolicy(config?: BudgetConfig): BudgetPolicy {
  const dailyUsd = positive(config?.daily_usd);
  const monthlyUsd = positive(config?.monthly_usd);
  const dailyTokens = positive(config?.daily_tokens);
  const monthlyTokens = positive(config?.monthly_tokens);
  const softThreshold =
    config?.soft_threshold !== undefined &&
    config.soft_threshold > 0 &&
    config.soft_threshold < 1
      ? config.soft_threshold
      : DEFAULT_SOFT_THRESHOLD;

  return {
    enabled: config?.enabled === true,
    softThreshold,
    enforceInteractive: config?.enforce_interactive === true,
    caps: {
      ...(dailyUsd !== undefined ? { dailyUsd } : {}),
      ...(monthlyUsd !== undefined ? { monthlyUsd } : {}),
      ...(dailyTokens !== undefined ? { dailyTokens } : {}),
      ...(monthlyTokens !== undefined ? { monthlyTokens } : {}),
    },
  };
}
