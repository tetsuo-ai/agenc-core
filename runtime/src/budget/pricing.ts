/**
 * Model-price adapter for the budget enforcer (TODO task 15).
 *
 * Bridges the pure enforcer (which takes an injected `ModelPriceResolver`) to
 * the runtime's canonical cost registry, converting per-1K rates to the
 * per-1M-token rates the enforcer prices in. Kept separate so budget/ has no
 * dependency on the cost tables in its core.
 */

import {
  DEFAULT_MODEL_COSTS,
  resolveModelCostEntry,
} from "../session/cost.js";
import type { ModelPrice, ModelPriceResolver } from "./types.js";

/**
 * Build a price resolver from the default cost registry. Returns null for a
 * model with no known price (e.g. local models) — the enforcer then can't gate
 * that model on dollar caps, only token caps.
 */
export function createModelPriceResolver(): ModelPriceResolver {
  return (model: string): ModelPrice | null => {
    const resolved = resolveModelCostEntry(
      { model, provider: "" },
      DEFAULT_MODEL_COSTS,
    );
    if (resolved === null) return null;
    const { entry } = resolved;
    // Local/free models are registered with zero rates; treat a zero-priced
    // model as "unpriced" so dollar caps don't spuriously admit unlimited use.
    if (entry.inputUsdPer1K === 0 && entry.outputUsdPer1K === 0) return null;
    return {
      inputPerMTokens: entry.inputUsdPer1K * 1000,
      outputPerMTokens: entry.outputUsdPer1K * 1000,
    };
  };
}
