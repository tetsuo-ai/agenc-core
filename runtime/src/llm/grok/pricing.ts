/**
 * xAI model pricing table and USD cost helpers.
 *
 * Source: developer console catalog (retrieved April 19, 2026). Prices
 * are USD per 1,000,000 tokens for input and output respectively. When
 * a model is not in this table, cost is reported as `undefined` rather
 * than guessed — the TUI skips rendering the cost chip in that case.
 *
 * Update the table in one place (this module) when xAI changes rates.
 */

import type { LLMUsage } from "../types.js";
import { normalizeGrokModel } from "../../gateway/context-window.js";

export interface GrokModelPricing {
  /** USD per 1,000,000 input (prompt) tokens. */
  readonly inputPricePer1M: number;
  /** USD per 1,000,000 output (completion) tokens. */
  readonly outputPricePer1M: number;
}

const GROK_PRICING_BY_CANONICAL_ID: Readonly<Record<string, GrokModelPricing>> =
  Object.freeze({
    // Grok 4.20 family — $2.00 input / $6.00 output per 1M
    "grok-4.20-0309-reasoning": {
      inputPricePer1M: 2.0,
      outputPricePer1M: 6.0,
    },
    "grok-4.20-0309-non-reasoning": {
      inputPricePer1M: 2.0,
      outputPricePer1M: 6.0,
    },
    "grok-4.20-multi-agent-0309": {
      inputPricePer1M: 2.0,
      outputPricePer1M: 6.0,
    },
    // Grok 4.1 fast family — $0.20 input / $0.50 output per 1M
    "grok-4-1-fast-reasoning": {
      inputPricePer1M: 0.2,
      outputPricePer1M: 0.5,
    },
    "grok-4-1-fast-non-reasoning": {
      inputPricePer1M: 0.2,
      outputPricePer1M: 0.5,
    },
  });

/**
 * Look up per-1M USD pricing for a grok model, applying legacy-alias
 * normalization so the old "-beta-" IDs resolve to the current catalog.
 * Returns `undefined` when the (canonicalized) model is not priced.
 */
export function getGrokModelPricing(
  model: string | undefined,
): GrokModelPricing | undefined {
  if (typeof model !== "string" || model.length === 0) {
    return undefined;
  }
  const canonical = normalizeGrokModel(model) ?? model;
  return GROK_PRICING_BY_CANONICAL_ID[canonical];
}

/**
 * Compute the USD cost of a single LLM call given its usage record and
 * the model ID it ran against. Returns `undefined` when pricing is not
 * available for the model — callers should drop the field rather than
 * display `$0.0000` as a false assertion of zero cost.
 */
export function computeGrokCallCostUsd(
  usage: Pick<LLMUsage, "promptTokens" | "completionTokens">,
  model: string | undefined,
): number | undefined {
  const pricing = getGrokModelPricing(model);
  if (!pricing) return undefined;
  const promptTokens = Number.isFinite(usage.promptTokens)
    ? Math.max(0, usage.promptTokens)
    : 0;
  const completionTokens = Number.isFinite(usage.completionTokens)
    ? Math.max(0, usage.completionTokens)
    : 0;
  const inputCost = (promptTokens * pricing.inputPricePer1M) / 1_000_000;
  const outputCost = (completionTokens * pricing.outputPricePer1M) / 1_000_000;
  return Number((inputCost + outputCost).toFixed(6));
}
