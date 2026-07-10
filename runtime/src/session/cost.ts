/**
 * Cost sidecar — session cost tracking + formatting.
 *
 * Responsibilities:
 *   - Subscribe to `token_count` events and tally cumulative
 *     input/output/cache/reasoning tokens plus web search requests per
 *     provider + model.
 *   - Maintain a provider-aware model cost registry (USD/1K input +
 *     USD/1K output + USD/1K cache + USD/search request). Ships
 *     sensible defaults for hosted third-party and local providers;
 *     callers can override the registry.
 *   - Format cumulative cost for `/status` and status-line display.
 *   - Provide an exit-summary hook equivalent to upstream's React hook,
 *     but as a plain process listener so the runtime can install or skip
 *     it without depending on React.
 *   - Emit `token_budget_exceeded` warnings via the session-level
 *     BudgetTracker (integrates with conversation/token-budget.ts per I-22).
 *
 * @module
 */

import { join } from "node:path";
import { promises as fsp } from "node:fs";
import { monotonicMs } from "./_deps/utils.js";
import type { BudgetTracker } from "../conversation/token-budget.js";
import type { Event } from "./event-log.js";
import type { Sidecar } from "./sidecar.js";

// ─────────────────────────────────────────────────────────────────────
// Cost registry — USD per 1K tokens.
// ─────────────────────────────────────────────────────────────────────

export interface ModelCostEntry {
  readonly inputUsdPer1K: number;
  readonly outputUsdPer1K: number;
  readonly cachedInputUsdPer1K?: number;
  /**
   * Some providers report cached input as a subset of input tokens.
   * When true, cached tokens are subtracted from the full-rate input
   * portion before applying cached-input pricing.
   */
  readonly cachedInputIncludedInInputTokens?: boolean;
  readonly cacheCreationUsdPer1K?: number;
  /**
   * Per-1K rate for reasoning output tokens. Reasoning tokens are reported as
   * a SUBSET of output tokens (OpenAI/xAI Responses convention), so when this
   * is set computeUsdCost charges the full output rate only on the
   * non-reasoning portion (outputTokens − reasoningOutputTokens) and bills the
   * reasoning portion here — avoiding double-charging. (gaphunt3 #12)
   */
  readonly reasoningOutputUsdPer1K?: number;
  readonly webSearchUsdPerRequest?: number;
  /** Free-form label for display. */
  readonly label?: string;
}

export interface CostSummaryProcessLike {
  readonly stdout: { write: (value: string) => unknown };
  on(event: "exit", listener: () => void): unknown;
  off(event: "exit", listener: () => void): unknown;
}

export interface CostSummaryExitHookOptions {
  readonly processLike?: CostSummaryProcessLike;
  readonly shouldPrint?: () => boolean;
  readonly getSummary?: () => string;
}

export interface CostFpsMetrics {
  readonly averageFps?: number;
  readonly low1PctFps?: number;
}

export const DEFAULT_UNKNOWN_MODEL_COST: Readonly<ModelCostEntry> =
  Object.freeze({
    inputUsdPer1K: 0.005,
    outputUsdPer1K: 0.025,
    cachedInputUsdPer1K: 0.0005,
    cacheCreationUsdPer1K: 0.00625,
    webSearchUsdPerRequest: 0.01,
    label: "fallback",
  });

function openAiCachedInputTier(
  inputUsdPer1M: number,
  outputUsdPer1M: number,
  cachedInputUsdPer1M: number,
): Readonly<ModelCostEntry> {
  return Object.freeze({
    inputUsdPer1K: inputUsdPer1M / 1000,
    outputUsdPer1K: outputUsdPer1M / 1000,
    cachedInputUsdPer1K: cachedInputUsdPer1M / 1000,
    cachedInputIncludedInInputTokens: true,
    webSearchUsdPerRequest: 0.01,
  });
}

function openAiUncachedInputTier(
  inputUsdPer1M: number,
  outputUsdPer1M: number,
): Readonly<ModelCostEntry> {
  return Object.freeze({
    inputUsdPer1K: inputUsdPer1M / 1000,
    outputUsdPer1K: outputUsdPer1M / 1000,
    webSearchUsdPerRequest: 0.01,
  });
}

function openAiCostAliases(
  model: string,
  entry: ModelCostEntry,
): Record<string, ModelCostEntry> {
  return {
    [`openai:${model}`]: entry,
    [model]: entry,
    [`openai/${model}`]: entry,
    [`openrouter:openai/${model}`]: entry,
    [`openrouter:${model}`]: entry,
  };
}

const COST_TIER_GPT_5_4 = openAiCachedInputTier(2.5, 15, 0.25);
const COST_TIER_GPT_5_4_MINI = openAiCachedInputTier(0.75, 4.5, 0.075);
const COST_TIER_GPT_5_4_NANO = openAiCachedInputTier(0.2, 1.25, 0.02);
const COST_TIER_GPT_5_2 = openAiCachedInputTier(1.75, 14, 0.175);
const COST_TIER_GPT_5_1 = openAiCachedInputTier(1.25, 10, 0.125);
const COST_TIER_GPT_5 = openAiCachedInputTier(1.25, 10, 0.125);
const COST_TIER_GPT_5_MINI = openAiCachedInputTier(0.25, 2, 0.025);
const COST_TIER_GPT_5_NANO = openAiCachedInputTier(0.05, 0.4, 0.005);
const COST_TIER_GPT_4_1 = openAiCachedInputTier(2, 8, 0.5);
const COST_TIER_GPT_4_1_MINI = openAiCachedInputTier(0.4, 1.6, 0.1);
const COST_TIER_GPT_4_1_NANO = openAiCachedInputTier(0.1, 0.4, 0.025);
const COST_TIER_GPT_4O = openAiCachedInputTier(2.5, 10, 1.25);
const COST_TIER_GPT_4O_MINI = openAiCachedInputTier(0.15, 0.6, 0.075);
const COST_TIER_O1 = openAiCachedInputTier(15, 60, 7.5);
const COST_TIER_O1_MINI = openAiCachedInputTier(1.1, 4.4, 0.55);
const COST_TIER_O1_PRO = openAiUncachedInputTier(150, 600);
const COST_TIER_O3 = openAiCachedInputTier(2, 8, 0.5);
const COST_TIER_O3_MINI = openAiCachedInputTier(1.1, 4.4, 0.55);
const COST_TIER_O4_MINI = openAiCachedInputTier(1.1, 4.4, 0.275);

const COST_TIER_SONNET: Readonly<ModelCostEntry> = Object.freeze({
  inputUsdPer1K: 0.003,
  outputUsdPer1K: 0.015,
  cachedInputUsdPer1K: 0.0003,
  cacheCreationUsdPer1K: 0.00375,
  webSearchUsdPerRequest: 0.01,
});

const COST_TIER_OPUS: Readonly<ModelCostEntry> = Object.freeze({
  inputUsdPer1K: 0.015,
  outputUsdPer1K: 0.075,
  cachedInputUsdPer1K: 0.0015,
  cacheCreationUsdPer1K: 0.01875,
  webSearchUsdPerRequest: 0.01,
});

/**
 * Non-reasoning grok-4.x tier. Same illustrative input/output rates as
 * `grok-4.20-0309-reasoning` (0.003 / 0.012 per 1K, pending confirmed xAI
 * pricing) but WITHOUT `reasoningOutputUsdPer1K`: these models do not bill a
 * separate reasoning-token rate, so charging the reasoning surcharge here
 * would over-count cost and trip `dollar_cap` budgets at the wrong threshold.
 * grok-4.3 (the grok provider default) and grok-build-0.1 both belong here.
 */
const COST_TIER_GROK_4X_NON_REASONING: Readonly<ModelCostEntry> = Object.freeze({
  inputUsdPer1K: 0.003,
  outputUsdPer1K: 0.012,
  webSearchUsdPerRequest: 0.01,
});

/** Official Grok 4.5 token pricing, including prompt-cache reads. */
const COST_TIER_GROK_45: Readonly<ModelCostEntry> = Object.freeze({
  inputUsdPer1K: 0.002,
  outputUsdPer1K: 0.006,
  cachedInputUsdPer1K: 0.0005,
  webSearchUsdPerRequest: 0.01,
});

/** Register a grok model under both its `xai:`-qualified and bare slug. */
function grokCostAliases(
  model: string,
  entry: ModelCostEntry,
): Record<string, ModelCostEntry> {
  return {
    [`xai:${model}`]: entry,
    [model]: entry,
  };
}

/**
 * Default model cost registry. Values are best-available public
 * pricing plus reasonable defaults for local providers (zero cost).
 *
 * Prices here are illustrative; override via `registerModelCost()`.
 */
export const DEFAULT_MODEL_COSTS: Readonly<Record<string, ModelCostEntry>> =
  Object.freeze({
    "xai:grok-4-fast": {
      inputUsdPer1K: 0.002,
      outputUsdPer1K: 0.01,
      webSearchUsdPerRequest: 0.01,
    },
    "grok-4-fast": {
      inputUsdPer1K: 0.002,
      outputUsdPer1K: 0.01,
      webSearchUsdPerRequest: 0.01,
    },
    "xai:grok-4-1-fast-non-reasoning": {
      inputUsdPer1K: 0.002,
      outputUsdPer1K: 0.01,
      webSearchUsdPerRequest: 0.01,
    },
    "grok-4-1-fast-non-reasoning": {
      inputUsdPer1K: 0.002,
      outputUsdPer1K: 0.01,
      webSearchUsdPerRequest: 0.01,
    },
    "xai:grok-4.20-0309-reasoning": {
      inputUsdPer1K: 0.003,
      outputUsdPer1K: 0.012,
      reasoningOutputUsdPer1K: 0.012,
      webSearchUsdPerRequest: 0.01,
    },
    "grok-4.20-0309-reasoning": {
      inputUsdPer1K: 0.003,
      outputUsdPer1K: 0.012,
      reasoningOutputUsdPer1K: 0.012,
      webSearchUsdPerRequest: 0.01,
    },
    // Default + catalog grok variants that do NOT bill a separate reasoning
    // surcharge. Grok 4.5 reasoning tokens are covered by its output rate.
    // grok-4.3 is the grok provider default (provider-info.ts); pricing these
    // explicitly stops the blanket grok-4* → reasoning collapse from charging
    // them the reasoning rate and skewing dollar_cap budget enforcement.
    ...grokCostAliases("grok-4.5", COST_TIER_GROK_45),
    ...grokCostAliases("grok-4.3", COST_TIER_GROK_4X_NON_REASONING),
    ...grokCostAliases("grok-build-0.1", COST_TIER_GROK_4X_NON_REASONING),
    ...grokCostAliases(
      "grok-4.20-0309-non-reasoning",
      COST_TIER_GROK_4X_NON_REASONING,
    ),
    ...grokCostAliases(
      "grok-4.20-multi-agent-0309",
      COST_TIER_GROK_4X_NON_REASONING,
    ),
    ...openAiCostAliases("gpt-5.4", COST_TIER_GPT_5_4),
    ...openAiCostAliases("gpt-5.4-mini", COST_TIER_GPT_5_4_MINI),
    ...openAiCostAliases("gpt-5.4-nano", COST_TIER_GPT_5_4_NANO),
    ...openAiCostAliases("gpt-5.2", COST_TIER_GPT_5_2),
    ...openAiCostAliases("gpt-5.1", COST_TIER_GPT_5_1),
    ...openAiCostAliases("gpt-5", COST_TIER_GPT_5),
    ...openAiCostAliases("gpt-5-mini", COST_TIER_GPT_5_MINI),
    ...openAiCostAliases("gpt-5-nano", COST_TIER_GPT_5_NANO),
    ...openAiCostAliases("gpt-4.1", COST_TIER_GPT_4_1),
    ...openAiCostAliases("gpt-4.1-mini", COST_TIER_GPT_4_1_MINI),
    ...openAiCostAliases("gpt-4.1-nano", COST_TIER_GPT_4_1_NANO),
    ...openAiCostAliases("gpt-4o", COST_TIER_GPT_4O),
    ...openAiCostAliases("gpt-4o-mini", COST_TIER_GPT_4O_MINI),
    ...openAiCostAliases("o1", COST_TIER_O1),
    ...openAiCostAliases("o1-preview", COST_TIER_O1),
    ...openAiCostAliases("o1-mini", COST_TIER_O1_MINI),
    ...openAiCostAliases("o1-pro", COST_TIER_O1_PRO),
    ...openAiCostAliases("o3", COST_TIER_O3),
    ...openAiCostAliases("o3-mini", COST_TIER_O3_MINI),
    ...openAiCostAliases("o4-mini", COST_TIER_O4_MINI),
    // branding-scan: allow documented Anthropic API model identifier
    "anthropic:claude-sonnet-4-6": COST_TIER_SONNET,
    // branding-scan: allow documented Anthropic API model identifier
    "claude-sonnet-4-6": COST_TIER_SONNET,
    // branding-scan: allow documented Anthropic API model identifier
    "anthropic:claude-sonnet-4-5": COST_TIER_SONNET,
    // branding-scan: allow documented Anthropic API model identifier
    "claude-sonnet-4-5": COST_TIER_SONNET,
    // branding-scan: allow documented Anthropic API model identifier
    "anthropic:claude-opus-4-7": COST_TIER_OPUS,
    // branding-scan: allow documented Anthropic API model identifier
    "claude-opus-4-7": COST_TIER_OPUS,
    // branding-scan: allow documented Anthropic API model identifier
    "anthropic:claude-opus-4-7-1m": COST_TIER_OPUS,
    // branding-scan: allow documented Anthropic API model identifier
    "claude-opus-4-7-1m": COST_TIER_OPUS,
    // branding-scan: allow documented Anthropic API model identifier
    "anthropic:claude-haiku-4-5": {
      inputUsdPer1K: 0.001,
      outputUsdPer1K: 0.005,
      cachedInputUsdPer1K: 0.0001,
      cacheCreationUsdPer1K: 0.00125,
      webSearchUsdPerRequest: 0.01,
    },
    // branding-scan: allow documented Anthropic API model identifier
    "claude-haiku-4-5": {
      inputUsdPer1K: 0.001,
      outputUsdPer1K: 0.005,
      cachedInputUsdPer1K: 0.0001,
      cacheCreationUsdPer1K: 0.00125,
      webSearchUsdPerRequest: 0.01,
    },
    "groq:llama-3.3-70b-versatile": {
      inputUsdPer1K: 0.00059,
      outputUsdPer1K: 0.00079,
    },
    "llama-3.3-70b-versatile": {
      inputUsdPer1K: 0.00059,
      outputUsdPer1K: 0.00079,
    },
    "deepseek:deepseek-reasoner": {
      inputUsdPer1K: 0.00055,
      outputUsdPer1K: 0.00219,
      cachedInputUsdPer1K: 0.00014,
    },
    "deepseek-reasoner": {
      inputUsdPer1K: 0.00055,
      outputUsdPer1K: 0.00219,
      cachedInputUsdPer1K: 0.00014,
    },
    "gemini:gemini-2.5-pro": {
      inputUsdPer1K: 0.00125,
      outputUsdPer1K: 0.01,
    },
    "gemini-2.5-pro": {
      inputUsdPer1K: 0.00125,
      outputUsdPer1K: 0.01,
    },
    "mistral:devstral-latest": {
      inputUsdPer1K: 0.0001,
      outputUsdPer1K: 0.0003,
    },
    "devstral-latest": {
      inputUsdPer1K: 0.0001,
      outputUsdPer1K: 0.0003,
    },
    "nvidia-nim:nvidia/llama-3.1-nemotron-70b-instruct": DEFAULT_UNKNOWN_MODEL_COST,
    "nvidia/llama-3.1-nemotron-70b-instruct": DEFAULT_UNKNOWN_MODEL_COST,
    "minimax:MiniMax-M2.5": DEFAULT_UNKNOWN_MODEL_COST,
    "MiniMax-M2.5": DEFAULT_UNKNOWN_MODEL_COST,
    "amazon-bedrock:amazon.nova-pro-v1:0": DEFAULT_UNKNOWN_MODEL_COST,
    "amazon.nova-pro-v1:0": DEFAULT_UNKNOWN_MODEL_COST,
    "agenc:agenc": DEFAULT_UNKNOWN_MODEL_COST,
    agenc: DEFAULT_UNKNOWN_MODEL_COST,
    ollama: { inputUsdPer1K: 0, outputUsdPer1K: 0, label: "local" },
    lmstudio: { inputUsdPer1K: 0, outputUsdPer1K: 0, label: "local" },
    "openai-compatible": {
      inputUsdPer1K: 0,
      outputUsdPer1K: 0,
      label: "local",
    },
  });

// ─────────────────────────────────────────────────────────────────────
// Per-model usage accumulator
// ─────────────────────────────────────────────────────────────────────

export interface ModelUsage {
  readonly model: string;
  readonly provider?: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
  reasoningOutputTokens: number;
  webSearchRequests: number;
  totalTokens: number;
  /** Number of completed turns attributed to this model. */
  turns: number;
}

export interface TokenUsageDelta {
  readonly model: string;
  readonly provider?: string;
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly cachedInputTokens?: number;
  readonly cacheCreationInputTokens?: number;
  readonly reasoningOutputTokens?: number;
  readonly webSearchRequests?: number;
  readonly totalTokens?: number;
  readonly costUsd?: number;
}

function emptyModelUsage(model: string, provider?: string): ModelUsage {
  return {
    model,
    ...(provider !== undefined ? { provider } : {}),
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    reasoningOutputTokens: 0,
    webSearchRequests: 0,
    totalTokens: 0,
    turns: 0,
  };
}

function subtractModelUsage(
  a: ModelUsage,
  b: ModelUsage,
): ModelUsage {
  return {
    model: a.model,
    ...(a.provider !== undefined ? { provider: a.provider } : {}),
    inputTokens: Math.max(0, a.inputTokens - b.inputTokens),
    outputTokens: Math.max(0, a.outputTokens - b.outputTokens),
    cachedInputTokens: Math.max(0, a.cachedInputTokens - b.cachedInputTokens),
    cacheCreationInputTokens: Math.max(
      0,
      a.cacheCreationInputTokens - b.cacheCreationInputTokens,
    ),
    reasoningOutputTokens: Math.max(
      0,
      a.reasoningOutputTokens - b.reasoningOutputTokens,
    ),
    webSearchRequests: Math.max(0, a.webSearchRequests - b.webSearchRequests),
    totalTokens: Math.max(0, a.totalTokens - b.totalTokens),
    turns: Math.max(0, a.turns - b.turns),
  };
}

// ─────────────────────────────────────────────────────────────────────
// Cost computation
// ─────────────────────────────────────────────────────────────────────

export function computeUsdCost(
  usage: ModelUsage,
  registry: Readonly<Record<string, ModelCostEntry>>,
): number {
  return computeUsdCostWithResolution(usage, registry).costUsd;
}

export interface CostResolution {
  readonly costUsd: number;
  readonly known: boolean;
  readonly matchedKey?: string;
}

export function computeUsdCostWithResolution(
  usage: ModelUsage,
  registry: Readonly<Record<string, ModelCostEntry>>,
): CostResolution {
  const match = resolveModelCostEntry(usage, registry);
  const entry = match?.entry ?? DEFAULT_UNKNOWN_MODEL_COST;
  const fullRateInputTokens = entry.cachedInputIncludedInInputTokens
    ? Math.max(0, usage.inputTokens - usage.cachedInputTokens)
    : usage.inputTokens;
  const inputCost = (fullRateInputTokens / 1000) * entry.inputUsdPer1K;
  // gaphunt3 #12: reasoning tokens are reported as a SUBSET of output tokens
  // (OpenAI/xAI Responses convention: output_tokens_details.reasoning_tokens
  // ⊆ output_tokens). When a separate reasoning rate is defined, charge the
  // full output rate only on the non-reasoning portion and bill the reasoning
  // portion at reasoningOutputUsdPer1K — otherwise the reasoning tokens are
  // double-charged (once at the output rate, once at the reasoning rate).
  const fullRateOutputTokens =
    entry.reasoningOutputUsdPer1K !== undefined
      ? Math.max(0, usage.outputTokens - usage.reasoningOutputTokens)
      : usage.outputTokens;
  const outputCost = (fullRateOutputTokens / 1000) * entry.outputUsdPer1K;
  const cachedCost =
    entry.cachedInputUsdPer1K !== undefined
      ? (usage.cachedInputTokens / 1000) * entry.cachedInputUsdPer1K
      : 0;
  const cacheCreationCost =
    entry.cacheCreationUsdPer1K !== undefined
      ? (usage.cacheCreationInputTokens / 1000) * entry.cacheCreationUsdPer1K
      : 0;
  const reasoningCost =
    entry.reasoningOutputUsdPer1K !== undefined
      ? (usage.reasoningOutputTokens / 1000) * entry.reasoningOutputUsdPer1K
      : 0;
  const webSearchCost =
    entry.webSearchUsdPerRequest !== undefined
      ? usage.webSearchRequests * entry.webSearchUsdPerRequest
      : 0;
  return {
    costUsd:
      inputCost +
      outputCost +
      cachedCost +
      cacheCreationCost +
      reasoningCost +
      webSearchCost,
    known: match !== null,
    ...(match ? { matchedKey: match.key } : {}),
  };
}

export function resolveModelCostEntry(
  usage: Pick<ModelUsage, "model" | "provider">,
  registry: Readonly<Record<string, ModelCostEntry>>,
): { readonly key: string; readonly entry: ModelCostEntry } | null {
  for (const key of costLookupKeys(usage.model, usage.provider)) {
    const entry = registry[key];
    if (entry) return { key, entry };
  }
  return null;
}

/**
 * Normalize model slug to a canonical key present in the registry.
 */
function canonicalModel(model: string): string {
  const normalized = model.trim().toLowerCase();
  if (normalized.startsWith("ollama:")) return "ollama";
  if (normalized.startsWith("lmstudio:")) return "lmstudio";
  const pathUnqualified = normalized.includes("/")
    ? normalized.slice(normalized.lastIndexOf("/") + 1)
    : normalized;
  const unqualified = pathUnqualified.includes(":")
    ? pathUnqualified.slice(pathUnqualified.lastIndexOf(":") + 1)
    : pathUnqualified;
  if (unqualified.startsWith("grok-4-fast")) return "grok-4-fast";
  // Non-reasoning grok-4.x variants are priced explicitly below; route them to
  // their own keys so they are NOT collapsed onto the reasoning entry (which
  // would wrongly add the reasoning surcharge and skew dollar_cap budgets).
  if (unqualified.startsWith("grok-4.5")) return "grok-4.5";
  if (unqualified.startsWith("grok-4.3")) return "grok-4.3";
  if (unqualified.startsWith("grok-4.20-0309-non-reasoning")) {
    return "grok-4.20-0309-non-reasoning";
  }
  if (unqualified.startsWith("grok-4.20-multi-agent")) {
    return "grok-4.20-multi-agent-0309";
  }
  // Only collapse remaining grok-4.x slugs to the reasoning entry when they are
  // a reasoning variant; otherwise leave unmatched so unknown variants surface
  // as unknown-cost rather than silently inheriting the reasoning surcharge.
  if (unqualified.startsWith("grok-4") && unqualified.includes("reasoning")) {
    return "grok-4.20-0309-reasoning";
  }
  if (unqualified.startsWith("gpt-5.4-mini")) return "gpt-5.4-mini";
  if (unqualified.startsWith("gpt-5.4-nano")) return "gpt-5.4-nano";
  if (unqualified.startsWith("gpt-5.4")) return "gpt-5.4";
  if (unqualified.startsWith("gpt-5.2")) return "gpt-5.2";
  if (unqualified.startsWith("gpt-5.1")) return "gpt-5.1";
  if (unqualified.startsWith("gpt-5-mini")) return "gpt-5-mini";
  if (unqualified.startsWith("gpt-5-nano")) return "gpt-5-nano";
  if (unqualified.startsWith("gpt-5")) return "gpt-5";
  if (unqualified.startsWith("o1-mini")) return "o1-mini";
  if (unqualified.startsWith("o1-preview")) return "o1-preview";
  if (unqualified.startsWith("o1-pro")) return "o1-pro";
  if (unqualified.startsWith("o1")) return "o1";
  if (unqualified.startsWith("o3-mini")) return "o3-mini";
  if (unqualified.startsWith("o3")) return "o3";
  if (unqualified.startsWith("o4-mini")) return "o4-mini";
  if (unqualified.startsWith("gpt-4.1-mini")) return "gpt-4.1-mini";
  if (unqualified.startsWith("gpt-4.1-nano")) return "gpt-4.1-nano";
  if (unqualified.startsWith("gpt-4.1")) return "gpt-4.1";
  if (unqualified.startsWith("gpt-4o-mini")) return "gpt-4o-mini";
  if (unqualified.startsWith("gpt-4o")) return "gpt-4o";
  // branding-scan: allow documented Anthropic API model identifier
  if (unqualified.startsWith("claude-haiku-4-5")) return "claude-haiku-4-5";
  // branding-scan: allow documented Anthropic API model identifier
  if (unqualified.startsWith("claude-sonnet-4")) return "claude-sonnet-4-6";
  // branding-scan: allow documented Anthropic API model identifier
  if (unqualified.startsWith("claude-opus-4")) return "claude-opus-4-7";
  return normalized;
}

function normalizeProvider(provider: string | undefined): string | undefined {
  const trimmed = provider?.trim().toLowerCase();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function usageKey(model: string, provider: string | undefined): string {
  const normalizedProvider = normalizeProvider(provider);
  return normalizedProvider ? `${normalizedProvider}:${model}` : model;
}

function costLookupKeys(
  model: string,
  provider: string | undefined,
): string[] {
  const normalizedProvider = normalizeProvider(provider);
  const canonical = canonicalModel(model);
  const keys: string[] = [];
  if (normalizedProvider) {
    keys.push(`${normalizedProvider}:${model}`);
    if (canonical !== model) keys.push(`${normalizedProvider}:${canonical}`);
    keys.push(normalizedProvider);
  }
  keys.push(model);
  if (canonical !== model) keys.push(canonical);
  return [...new Set(keys)];
}

// ─────────────────────────────────────────────────────────────────────
// Per-agent cost estimation (D7 fleet-panel spend column)
// ─────────────────────────────────────────────────────────────────────

/**
 * Default split assumption used when only a TOTAL token count is known for a
 * spawned agent. The TUI fan-out rail surfaces `progress.tokenCount`
 * (= `live.tokenUsage.totalTokens`) but NOT the input/output breakdown, so a
 * single rate can't be applied directly. A 3:1 input:output ratio is the
 * conventional shape of a tool-using coding turn (large prompt + context,
 * smaller completion). The resulting figure is always surfaced as an
 * ESTIMATE — never presented as a billed amount.
 */
const AGENT_COST_ESTIMATE_INPUT_SHARE = 0.75;

export interface AgentCostEstimate {
  readonly costUsd: number;
  /** True only when the model resolved to a known registry entry. */
  readonly known: boolean;
}

/**
 * Estimate the USD cost of a spawned agent from its total token count and
 * model slug, reusing the same {@link computeUsdCostWithResolution} machinery
 * the live cost sidecar and per-agent dollar caps use. Returns `null` when no
 * usable token count is available (so the caller renders a dash rather than a
 * fabricated `$0.00`).
 *
 * The split between input/output tokens is unknown on the TUI side, so this
 * applies {@link AGENT_COST_ESTIMATE_INPUT_SHARE} and flags the result as an
 * estimate. Honesty contract: callers MUST label the output (e.g. trailing
 * "est.") and MUST dash when this returns `null`.
 */
export function estimateAgentCostUsd(params: {
  readonly totalTokens: number | undefined;
  readonly model: string | undefined;
  readonly provider?: string;
  readonly registry?: Readonly<Record<string, ModelCostEntry>>;
}): AgentCostEstimate | null {
  const total = params.totalTokens;
  if (total === undefined || !Number.isFinite(total) || total <= 0) return null;
  const model = params.model?.trim();
  if (model === undefined || model.length === 0) return null;
  const inputTokens = Math.round(total * AGENT_COST_ESTIMATE_INPUT_SHARE);
  const outputTokens = Math.max(0, total - inputTokens);
  const usage: ModelUsage = {
    model,
    ...(params.provider !== undefined ? { provider: params.provider } : {}),
    inputTokens,
    outputTokens,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    reasoningOutputTokens: 0,
    webSearchRequests: 0,
    totalTokens: total,
    turns: 0,
  };
  const resolved = computeUsdCostWithResolution(
    usage,
    params.registry ?? DEFAULT_MODEL_COSTS,
  );
  return { costUsd: resolved.costUsd, known: resolved.known };
}

// ─────────────────────────────────────────────────────────────────────
// Formatting helpers
// ─────────────────────────────────────────────────────────────────────

export function formatUsdCost(cost: number): string {
  if (cost === 0) return "$0.00";
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  if (cost < 1) return `$${cost.toFixed(3)}`;
  return `$${cost.toFixed(2)}`;
}

export function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function formatDuration(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) {
    const mins = Math.floor(ms / 60_000);
    const secs = Math.round((ms % 60_000) / 1000);
    return `${mins}m${secs}s`;
  }
  const hrs = Math.floor(ms / 3_600_000);
  const mins = Math.round((ms % 3_600_000) / 60_000);
  return `${hrs}h${mins}m`;
}

// ─────────────────────────────────────────────────────────────────────
// Cross-session persistence (T6 gap: cost totals survive resume).
//
// Layout: ~/.agenc/projects/<slug>/cost-totals.json
//
//   {
//     "version": 1,
//     "totalUsage": { inputTokens, outputTokens, cacheReadTokens, ... },
//     "totalCostUsd": N,
//     "sessions": [
//       { sessionId, startedAtMs, endedAtMs, usage, modelUsage, costUsd }
//     ],
//     "updatedAtMs": N
//   }
//
// Writes are atomic via tmp+fsync+rename so a crash mid-save leaves
// either the previous or the new file intact.
// ─────────────────────────────────────────────────────────────────────

export const COST_TOTALS_FILENAME = "cost-totals.json";
export const COST_TOTALS_SCHEMA_VERSION = 1;

/** Aggregate token totals used by lifetime totals and per-session records. */
export interface CostTotals {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens?: number;
  readonly reasoningOutputTokens: number;
  readonly webSearchRequests?: number;
  readonly totalTokens: number;
}

export interface SessionCostRecord {
  readonly sessionId: string;
  readonly startedAtMs: number;
  readonly endedAtMs: number;
  readonly usage: CostTotals;
  readonly costUsd: number;
  readonly modelUsage?: ReadonlyArray<SessionCostModelUsage>;
  readonly durationMs?: number;
  readonly apiDurationMs?: number;
  readonly apiDurationWithoutRetriesMs?: number;
  readonly toolDurationMs?: number;
  readonly linesAdded?: number;
  readonly linesRemoved?: number;
  readonly fpsAverage?: number;
  readonly fpsLow1Pct?: number;
}

export interface SessionCostModelUsage {
  readonly model: string;
  readonly provider?: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
  readonly reasoningOutputTokens: number;
  readonly webSearchRequests: number;
  readonly totalTokens: number;
  readonly turns: number;
  readonly costUsd: number;
}

export interface CostTotalsFile {
  readonly version: number;
  readonly totalUsage: CostTotals;
  readonly totalCostUsd: number;
  readonly sessions: ReadonlyArray<SessionCostRecord>;
  readonly updatedAtMs: number;
}

function emptyTotals(): CostTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    reasoningOutputTokens: 0,
    webSearchRequests: 0,
    totalTokens: 0,
  };
}

function coerceTotals(raw: Partial<CostTotals> | undefined): CostTotals {
  return {
    inputTokens: normalizeCounter(raw?.inputTokens),
    outputTokens: normalizeCounter(raw?.outputTokens),
    cacheReadTokens: normalizeCounter(raw?.cacheReadTokens),
    cacheCreationTokens: normalizeCounter(raw?.cacheCreationTokens),
    reasoningOutputTokens: normalizeCounter(raw?.reasoningOutputTokens),
    webSearchRequests: normalizeCounter(raw?.webSearchRequests),
    totalTokens: normalizeCounter(raw?.totalTokens),
  };
}

function coerceSessionModelUsage(
  raw: unknown,
): SessionCostModelUsage | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  if (typeof row.model !== "string" || row.model.length === 0) return null;
  return {
    model: row.model,
    ...(typeof row.provider === "string" && row.provider.length > 0
      ? { provider: row.provider }
      : {}),
    inputTokens: normalizeCounter(row.inputTokens as number | undefined),
    outputTokens: normalizeCounter(row.outputTokens as number | undefined),
    cacheReadTokens: normalizeCounter(row.cacheReadTokens as number | undefined),
    cacheCreationTokens: normalizeCounter(
      row.cacheCreationTokens as number | undefined,
    ),
    reasoningOutputTokens: normalizeCounter(
      row.reasoningOutputTokens as number | undefined,
    ),
    webSearchRequests: normalizeCounter(
      row.webSearchRequests as number | undefined,
    ),
    totalTokens: normalizeCounter(row.totalTokens as number | undefined),
    turns: normalizeCounter(row.turns as number | undefined),
    costUsd: normalizeCost(row.costUsd as number | undefined),
  };
}

function coerceSessionRecord(raw: unknown): SessionCostRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.sessionId !== "string" || record.sessionId.length === 0) {
    return null;
  }
  if (!record.usage || typeof record.usage !== "object") return null;
  const startedAtMs = normalizeWallMs(record.startedAtMs as number | undefined);
  const endedAtMs = normalizeWallMs(record.endedAtMs as number | undefined);
  if (startedAtMs === null || endedAtMs === null) return null;
  const modelUsage = Array.isArray(record.modelUsage)
    ? record.modelUsage
      .map((row) => coerceSessionModelUsage(row))
      .filter((row): row is SessionCostModelUsage => row !== null)
    : undefined;
  const durationMs = normalizeDuration(record.durationMs as number | undefined);
  const apiDurationMs = normalizeDuration(
    record.apiDurationMs as number | undefined,
  );
  const apiDurationWithoutRetriesMs = normalizeDuration(
    record.apiDurationWithoutRetriesMs as number | undefined,
  );
  const toolDurationMs = normalizeDuration(
    record.toolDurationMs as number | undefined,
  );
  return {
    sessionId: record.sessionId,
    startedAtMs,
    endedAtMs,
    usage: coerceTotals(record.usage as Partial<CostTotals>),
    costUsd: normalizeCost(record.costUsd as number | undefined),
    ...(modelUsage !== undefined ? { modelUsage } : {}),
    ...(durationMs !== null ? { durationMs } : {}),
    ...(apiDurationMs !== null ? { apiDurationMs } : {}),
    ...(apiDurationWithoutRetriesMs !== null
      ? { apiDurationWithoutRetriesMs }
      : {}),
    ...(toolDurationMs !== null ? { toolDurationMs } : {}),
    linesAdded: normalizeCounter(record.linesAdded as number | undefined),
    linesRemoved: normalizeCounter(record.linesRemoved as number | undefined),
    ...(typeof record.fpsAverage === "number" && Number.isFinite(record.fpsAverage)
      ? { fpsAverage: record.fpsAverage }
      : {}),
    ...(typeof record.fpsLow1Pct === "number" && Number.isFinite(record.fpsLow1Pct)
      ? { fpsLow1Pct: record.fpsLow1Pct }
      : {}),
  };
}

function addTotals(a: CostTotals, b: CostTotals): CostTotals {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0),
    cacheCreationTokens:
      (a.cacheCreationTokens ?? 0) + (b.cacheCreationTokens ?? 0),
    reasoningOutputTokens: a.reasoningOutputTokens + b.reasoningOutputTokens,
    webSearchRequests: (a.webSearchRequests ?? 0) + (b.webSearchRequests ?? 0),
    totalTokens: a.totalTokens + b.totalTokens,
  };
}

function subtractTotals(a: CostTotals, b: CostTotals): CostTotals {
  return {
    inputTokens: Math.max(0, a.inputTokens - b.inputTokens),
    outputTokens: Math.max(0, a.outputTokens - b.outputTokens),
    cacheReadTokens: Math.max(
      0,
      (a.cacheReadTokens ?? 0) - (b.cacheReadTokens ?? 0),
    ),
    cacheCreationTokens: Math.max(
      0,
      (a.cacheCreationTokens ?? 0) - (b.cacheCreationTokens ?? 0),
    ),
    reasoningOutputTokens: Math.max(
      0,
      a.reasoningOutputTokens - b.reasoningOutputTokens,
    ),
    webSearchRequests: Math.max(
      0,
      (a.webSearchRequests ?? 0) - (b.webSearchRequests ?? 0),
    ),
    totalTokens: Math.max(0, a.totalTokens - b.totalTokens),
  };
}

function normalizeDuration(durationMs: number | undefined): number | null {
  if (durationMs === undefined || !Number.isFinite(durationMs)) return null;
  return Math.max(0, Math.trunc(durationMs));
}

function normalizeCounter(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

function normalizeCost(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  return Math.max(0, value);
}

function normalizeWallMs(value: number | undefined): number | null {
  if (value === undefined || !Number.isFinite(value)) return null;
  return Math.max(0, Math.trunc(value));
}

function validateTotalsFile(raw: unknown): CostTotalsFile | null {
  if (!raw || typeof raw !== "object") return null;
  const f = raw as Partial<CostTotalsFile>;
  if (typeof f.version !== "number") return null;
  if (!f.totalUsage || typeof f.totalUsage !== "object") return null;
  if (typeof f.totalCostUsd !== "number") return null;
  if (!Array.isArray(f.sessions)) return null;
  if (typeof f.updatedAtMs !== "number") return null;
  return f as CostTotalsFile;
}

/**
 * Atomic write helper — write to `<path>.tmp`, fsync, rename over
 * `path`. Mirrors the pattern used by `session-store.ts`
 * `writeIndexSnapshot` but self-contained so cost.ts has no dep on
 * SessionStore. Uses node:fs/promises so the CostSidecar save path
 * is async and doesn't block the event loop.
 */
export async function atomicWriteJson(
  path: string,
  content: string,
): Promise<void> {
  const tmp = `${path}.tmp`;
  let handle: Awaited<ReturnType<typeof fsp.open>> | null = await fsp.open(
    tmp,
    "w",
    0o600,
  );
  try {
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = null;
    await fsp.rename(tmp, path);
  } catch (err) {
    if (handle !== null) {
      try {
        await handle.close();
      } catch {
        // best effort; preserve the original write/rename failure
      }
    }
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────────────
// CostSidecar
// ─────────────────────────────────────────────────────────────────────

export interface CostSidecarOpts {
  readonly registry?: Readonly<Record<string, ModelCostEntry>>;
  /** Initial model when sidecar registration starts after session setup. */
  readonly defaultModel?: string;
  /** Initial provider when sidecar registration starts after session setup. */
  readonly defaultProvider?: string;
  /**
   * Install the cost summary process-exit hook while the sidecar is
   * running. Disabled by default for unit fixtures; the live CLI
   * enables it during bootstrap.
   */
  readonly exitSummary?: CostSummaryExitHookOptions | false;
  /** Optional BudgetTracker to receive token totals (I-22 integration). */
  readonly budgetTracker?: BudgetTracker | null;
  /**
   * Project directory for cross-session persistence. When set, the
   * sidecar loads/saves `cost-totals.json` under this directory. When
   * unset, the sidecar is in-memory only (compatibility behavior, tests).
   */
  readonly projectDir?: string;
  /** Session id stamped onto the per-session record on save. */
  readonly sessionId?: string;
  /**
   * Optional diagnostic sink for load/save failures. Matches the
   * sidecar-manager `SidecarDiagnostic` shape but stays a plain
   * callback so cost.ts stays UI-layer agnostic.
   */
  readonly onDiagnostic?: (d: {
    readonly level: "warning" | "error";
    readonly cause: string;
    readonly message: string;
  }) => void;
  /**
   * Test-only seam — override the atomic write implementation to
   * simulate disk failures. Falls back to `atomicWriteJson`.
   */
  readonly writeImpl?: (path: string, content: string) => Promise<void>;
}

export class CostSidecar implements Sidecar {
  readonly name = "cost";
  private readonly registry: Readonly<Record<string, ModelCostEntry>>;
  private readonly budgetTracker: BudgetTracker | null;
  private readonly perModel = new Map<string, ModelUsage>();
  private totalApiDurationMs = 0;
  private totalApiDurationWithoutRetriesMs = 0;
  private totalToolDurationMs = 0;
  private readonly toolStartedAtByCallId = new Map<string, number>();
  private readonly startedAtMs = monotonicMs();
  private lastTurnStartMs: number | null = null;
  private currentModel: string | null = null;
  private currentProvider: string | null = null;
  private lastUsageKey: string | null = null;
  private readonly unknownCostModels = new Set<string>();
  private readonly exitSummaryOpts: CostSummaryExitHookOptions | false;
  private disposeExitSummary: (() => void) | null = null;
  private exitSummaryPrinted = false;

  // ── cross-session persistence state ──
  private projectDir: string | null;
  private sessionId: string | null;
  private readonly onDiagnostic?: (d: {
    readonly level: "warning" | "error";
    readonly cause: string;
    readonly message: string;
  }) => void;
  private readonly writeImpl: (path: string, content: string) => Promise<void>;
  private sessionStartedAtWallMs = Date.now();
  /** Lifetime snapshot from disk (does not include current session). */
  private loadedTotalUsage: CostTotals = emptyTotals();
  private loadedTotalCostUsd = 0;
  private loadedSessions: SessionCostRecord[] = [];
  /**
   * Aggregate restored baseline used only when an older session record has
   * no per-model buckets. Records with modelUsage are restored into
   * `perModel` so model/provider attribution remains inspectable.
   */
  private restoredAggregateBaseline: CostTotals = emptyTotals();
  private restoredCostAdjustmentUsd = 0;
  private restoredPerModelBaselines = new Map<string, ModelUsage>();
  private restoredPerModelCostUsd = new Map<string, number>();
  private explicitPerModelUsage = new Map<string, ModelUsage>();
  private explicitPerModelCostUsd = new Map<string, number>();
  private restoredSessionId: string | null = null;
  private restoredWallDurationMs = 0;
  private restoredApiDurationMs = 0;
  private restoredApiDurationWithoutRetriesMs = 0;
  private restoredToolDurationMs = 0;
  private restoredLinesAdded = 0;
  private restoredLinesRemoved = 0;
  private currentLinesAdded = 0;
  private currentLinesRemoved = 0;
  private apiDurationObservedThisTurn = false;
  private fpsAverage: number | undefined;
  private fpsLow1Pct: number | undefined;
  private fpsMetricsProvider: (() => CostFpsMetrics | undefined) | null = null;
  /** True once loadFromDisk has run (success or absent-file). */
  private loaded = false;
  private saveDegraded = false;

  constructor(opts: CostSidecarOpts = {}) {
    this.registry = opts.registry ?? DEFAULT_MODEL_COSTS;
    this.budgetTracker = opts.budgetTracker ?? null;
    this.currentModel = opts.defaultModel ?? null;
    this.currentProvider = normalizeProvider(opts.defaultProvider) ?? null;
    this.exitSummaryOpts = opts.exitSummary ?? false;
    this.projectDir = opts.projectDir ?? null;
    this.sessionId = opts.sessionId ?? null;
    this.onDiagnostic = opts.onDiagnostic;
    this.writeImpl = opts.writeImpl ?? atomicWriteJson;
  }

  onEvent(event: Event): void {
    const msg = event.msg;
    switch (msg.type) {
      case "turn_started": {
        this.lastTurnStartMs = monotonicMs();
        this.lastUsageKey = null;
        this.apiDurationObservedThisTurn = false;
        break;
      }
      case "turn_context": {
        this.currentModel = msg.payload.model;
        if (msg.payload.modelProviderId) {
          this.currentProvider = normalizeProvider(msg.payload.modelProviderId) ?? null;
        }
        break;
      }
      case "session_configured": {
        this.currentModel = msg.payload.model;
        this.currentProvider = normalizeProvider(msg.payload.modelProviderId) ?? null;
        break;
      }
      case "session_meta": {
        if (msg.payload.model) this.currentModel = msg.payload.model;
        if (msg.payload.modelProvider) {
          this.currentProvider = normalizeProvider(msg.payload.modelProvider) ?? null;
        }
        break;
      }
      case "token_count": {
        const model = msg.payload.model ?? this.currentModel ?? "unknown";
        const provider =
          normalizeProvider(msg.payload.provider) ?? this.currentProvider ?? undefined;
        const key = usageKey(model, provider);
        const usage = this.perModel.get(key) ?? emptyModelUsage(model, provider);
        usage.inputTokens += msg.payload.promptTokens ?? 0;
        usage.outputTokens += msg.payload.completionTokens ?? 0;
        usage.cachedInputTokens += msg.payload.cachedInputTokens ?? 0;
        usage.cacheCreationInputTokens += msg.payload.cacheCreationInputTokens ?? 0;
        usage.reasoningOutputTokens += msg.payload.reasoningOutputTokens ?? 0;
        usage.webSearchRequests += msg.payload.webSearchRequests ?? 0;
        usage.totalTokens += msg.payload.totalTokens ?? 0;
        this.perModel.set(key, usage);
        this.currentModel = model;
        this.currentProvider = provider ?? null;
        this.lastUsageKey = key;
        if (!computeUsdCostWithResolution(usage, this.registry).known) {
          this.unknownCostModels.add(key);
        }
        if (this.budgetTracker) {
          this.budgetTracker.addEmitted(
            (msg.payload.completionTokens ?? 0) +
              (msg.payload.reasoningOutputTokens ?? 0),
          );
        }
        break;
      }
      case "tool_call_started": {
        this.toolStartedAtByCallId.set(msg.payload.callId, monotonicMs());
        break;
      }
      case "tool_call_completed": {
        this.addCompletedToolDuration(msg.payload.callId);
        break;
      }
      case "turn_complete": {
        const model = this.currentModel ?? "unknown";
        const key = this.lastUsageKey ?? usageKey(model, this.currentProvider ?? undefined);
        const usage = this.perModel.get(key);
        if (usage) usage.turns += 1;
        if (!this.apiDurationObservedThisTurn) {
          const duration = normalizeDuration(msg.payload.durationMs);
          if (duration !== null) {
            this.totalApiDurationMs += duration;
            this.totalApiDurationWithoutRetriesMs += duration;
          } else if (this.lastTurnStartMs !== null) {
            const elapsed = monotonicMs() - this.lastTurnStartMs;
            this.totalApiDurationMs += elapsed;
            this.totalApiDurationWithoutRetriesMs += elapsed;
          }
        }
        this.lastTurnStartMs = null;
        break;
      }
      default:
        break;
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Accessors (consumed by /status command + T12 TUI status line)
  // ─────────────────────────────────────────────────────────────────

  getTotalCostUsd(): number {
    let total = 0;
    for (const usage of this.perModel.values()) {
      total += this.getModelUsageCostUsd(usage);
    }
    return total + this.restoredCostAdjustmentUsd;
  }

  getPerModelUsage(): ReadonlyArray<ModelUsage> {
    return Array.from(this.perModel.values());
  }

  getSessionModelUsage(): ReadonlyArray<SessionCostModelUsage> {
    return this.getPerModelUsage().map((usage) => ({
      model: usage.model,
      ...(usage.provider !== undefined ? { provider: usage.provider } : {}),
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cachedInputTokens,
      cacheCreationTokens: usage.cacheCreationInputTokens,
      reasoningOutputTokens: usage.reasoningOutputTokens,
      webSearchRequests: usage.webSearchRequests,
      totalTokens: usage.totalTokens,
      turns: usage.turns,
      costUsd: this.getModelUsageCostUsd(usage),
    }));
  }

  private getModelUsageCostUsd(usage: ModelUsage): number {
    const key = usageKey(usage.model, usage.provider);
    const restoredBaseline = this.restoredPerModelBaselines.get(key);
    const restoredCostUsd = this.restoredPerModelCostUsd.get(key);
    const explicitUsage = this.explicitPerModelUsage.get(key);
    const explicitCostUsd = this.explicitPerModelCostUsd.get(key) ?? 0;
    let computedUsage = usage;
    let total = explicitCostUsd;
    if (restoredBaseline !== undefined && restoredCostUsd !== undefined) {
      total += restoredCostUsd;
      computedUsage = subtractModelUsage(computedUsage, restoredBaseline);
    }
    if (explicitUsage !== undefined) {
      computedUsage = subtractModelUsage(computedUsage, explicitUsage);
    }
    return total + computeUsdCost(computedUsage, this.registry);
  }

  hasUnknownModelCost(): boolean {
    return this.unknownCostModels.size > 0;
  }

  getUnknownCostModels(): ReadonlyArray<string> {
    return Array.from(this.unknownCostModels).sort();
  }

  getTotalInputTokens(): number {
    let total = this.restoredAggregateBaseline.inputTokens;
    for (const usage of this.perModel.values()) total += usage.inputTokens;
    return total;
  }

  getTotalOutputTokens(): number {
    let total = this.restoredAggregateBaseline.outputTokens;
    for (const usage of this.perModel.values()) total += usage.outputTokens;
    return total;
  }

  getTotalCachedInputTokens(): number {
    let total = this.restoredAggregateBaseline.cacheReadTokens;
    for (const usage of this.perModel.values()) total += usage.cachedInputTokens;
    return total;
  }

  getTotalCacheCreationInputTokens(): number {
    let total = this.restoredAggregateBaseline.cacheCreationTokens ?? 0;
    for (const usage of this.perModel.values())
      total += usage.cacheCreationInputTokens;
    return total;
  }

  getTotalReasoningOutputTokens(): number {
    let total = this.restoredAggregateBaseline.reasoningOutputTokens;
    for (const usage of this.perModel.values())
      total += usage.reasoningOutputTokens;
    return total;
  }

  getTotalWebSearchRequests(): number {
    let total = this.restoredAggregateBaseline.webSearchRequests ?? 0;
    for (const usage of this.perModel.values()) total += usage.webSearchRequests;
    return total;
  }

  getTotalTurns(): number {
    let total = 0;
    for (const usage of this.perModel.values()) total += usage.turns;
    return total;
  }

  getTotalDurationMs(): number {
    return this.restoredWallDurationMs + monotonicMs() - this.startedAtMs;
  }

  getTotalApiDurationMs(): number {
    return this.restoredApiDurationMs + this.totalApiDurationMs;
  }

  getTotalApiDurationWithoutRetriesMs(): number {
    return (
      this.restoredApiDurationWithoutRetriesMs +
      this.totalApiDurationWithoutRetriesMs
    );
  }

  getTotalToolDurationMs(): number {
    return this.restoredToolDurationMs + this.totalToolDurationMs;
  }

  addToTotalApiDuration(durationMs: number): void {
    const duration = normalizeDuration(durationMs);
    if (duration === null) return;
    this.totalApiDurationMs += duration;
    this.apiDurationObservedThisTurn = true;
  }

  addToTotalApiDurationWithoutRetries(durationMs: number): void {
    const duration = normalizeDuration(durationMs);
    if (duration !== null) this.totalApiDurationWithoutRetriesMs += duration;
  }

  addToTotalToolDuration(durationMs: number): void {
    const duration = normalizeDuration(durationMs);
    if (duration !== null) this.totalToolDurationMs += duration;
  }

  private addCompletedToolDuration(callId: string): void {
    const startedAt = this.toolStartedAtByCallId.get(callId);
    if (startedAt === undefined) return;
    this.toolStartedAtByCallId.delete(callId);
    this.addToTotalToolDuration(monotonicMs() - startedAt);
  }

  addToTotalLinesChanged(added: number, removed: number): void {
    if (Number.isFinite(added)) {
      this.currentLinesAdded += Math.max(0, Math.trunc(added));
    }
    if (Number.isFinite(removed)) {
      this.currentLinesRemoved += Math.max(0, Math.trunc(removed));
    }
  }

  addTokenUsage(delta: TokenUsageDelta): void {
    const provider =
      normalizeProvider(delta.provider) ?? this.currentProvider ?? undefined;
    const key = usageKey(delta.model, provider);
    const usage = this.perModel.get(key) ?? emptyModelUsage(delta.model, provider);
    const promptTokens = normalizeCounter(delta.promptTokens);
    const completionTokens = normalizeCounter(delta.completionTokens);
    const reasoningOutputTokens = normalizeCounter(delta.reasoningOutputTokens);
    const totalTokens =
      delta.totalTokens === undefined
        ? promptTokens + completionTokens + reasoningOutputTokens
        : normalizeCounter(delta.totalTokens);
    usage.inputTokens += promptTokens;
    usage.outputTokens += completionTokens;
    usage.cachedInputTokens += normalizeCounter(delta.cachedInputTokens);
    usage.cacheCreationInputTokens += normalizeCounter(
      delta.cacheCreationInputTokens,
    );
    usage.reasoningOutputTokens += reasoningOutputTokens;
    usage.webSearchRequests += normalizeCounter(delta.webSearchRequests);
    usage.totalTokens += totalTokens;
    this.perModel.set(key, usage);
    this.currentModel = delta.model;
    this.currentProvider = provider ?? null;
    this.lastUsageKey = key;

    const costUsd = normalizeCost(delta.costUsd);
    if (costUsd > 0) {
      const explicit =
        this.explicitPerModelUsage.get(key) ?? emptyModelUsage(delta.model, provider);
      explicit.inputTokens += promptTokens;
      explicit.outputTokens += completionTokens;
      explicit.cachedInputTokens += normalizeCounter(delta.cachedInputTokens);
      explicit.cacheCreationInputTokens += normalizeCounter(
        delta.cacheCreationInputTokens,
      );
      explicit.reasoningOutputTokens += reasoningOutputTokens;
      explicit.webSearchRequests += normalizeCounter(delta.webSearchRequests);
      explicit.totalTokens += totalTokens;
      this.explicitPerModelUsage.set(key, explicit);
      this.explicitPerModelCostUsd.set(
        key,
        (this.explicitPerModelCostUsd.get(key) ?? 0) + costUsd,
      );
    }

    if (!computeUsdCostWithResolution(usage, this.registry).known) {
      this.unknownCostModels.add(key);
    }
  }

  getTotalLinesAdded(): number {
    return this.restoredLinesAdded + this.currentLinesAdded;
  }

  getTotalLinesRemoved(): number {
    return this.restoredLinesRemoved + this.currentLinesRemoved;
  }

  setFpsMetrics(metrics: CostFpsMetrics | undefined): void {
    this.fpsAverage = metrics?.averageFps;
    this.fpsLow1Pct = metrics?.low1PctFps;
  }

  setFpsMetricsProvider(
    provider: (() => CostFpsMetrics | undefined) | null,
  ): () => void {
    this.fpsMetricsProvider = provider;
    return () => {
      if (this.fpsMetricsProvider === provider) {
        this.fpsMetricsProvider = null;
      }
    };
  }

  /** One-line session cost summary for `/status`. */
  formatSummary(): string {
    const cost = this.getTotalCostUsd();
    const input = this.getTotalInputTokens();
    const output = this.getTotalOutputTokens();
    const turns = this.getTotalTurns();
    const duration = formatDuration(this.getTotalDurationMs());
    const unknown = this.hasUnknownModelCost() ? " • unknown-cost" : "";
    return `${formatUsdCost(cost)} • in=${formatTokenCount(input)} out=${formatTokenCount(output)} • turns=${turns} • ${duration}${unknown}`;
  }

  /** Multi-line summary equivalent to the upstream exit cost summary. */
  formatTotalCost(): string {
    const modelLines = this.getPerModelUsage().map((usage) => {
      const cost = this.getModelUsageCostUsd(usage);
      const label = usage.provider
        ? `${usage.provider}/${usage.model}`
        : usage.model;
      const usageParts = [
        `${formatTokenCount(usage.inputTokens)} input`,
        `${formatTokenCount(usage.outputTokens)} output`,
      ];
      if (usage.cachedInputTokens > 0) {
        usageParts.push(`${formatTokenCount(usage.cachedInputTokens)} cache read`);
      }
      if (usage.cacheCreationInputTokens > 0) {
        usageParts.push(
          `${formatTokenCount(usage.cacheCreationInputTokens)} cache write`,
        );
      }
      if (usage.webSearchRequests > 0) {
        usageParts.push(
          `${formatTokenCount(usage.webSearchRequests)} web search`,
        );
      }
      return `${label}: ${usageParts.join(", ")} (${formatUsdCost(cost)})`;
    });
    const unknownSuffix = this.hasUnknownModelCost()
      ? " (costs may be inaccurate due to unknown model pricing)"
      : "";
    return [
      `Total cost: ${formatUsdCost(this.getTotalCostUsd())}${unknownSuffix}`,
      `Total duration (API): ${formatDuration(this.getTotalApiDurationMs())}`,
      `Total duration (wall): ${formatDuration(this.getTotalDurationMs())}`,
      `Total code changes: ${formatTokenCount(this.getTotalLinesAdded())} lines added, ${formatTokenCount(this.getTotalLinesRemoved())} lines removed`,
      modelLines.length > 0
        ? "Usage by model:"
        : `Usage: ${formatTokenCount(this.getTotalInputTokens())} input, ${formatTokenCount(this.getTotalOutputTokens())} output`,
      ...modelLines.map((line) => `  ${line}`),
    ].join("\n");
  }

  /** Reset state (for `/clear` and tests). */
  reset(): void {
    this.perModel.clear();
    this.totalApiDurationMs = 0;
    this.totalApiDurationWithoutRetriesMs = 0;
    this.totalToolDurationMs = 0;
    this.toolStartedAtByCallId.clear();
    this.lastTurnStartMs = null;
    this.currentModel = null;
    this.currentProvider = null;
    this.lastUsageKey = null;
    this.unknownCostModels.clear();
    this.restoredAggregateBaseline = emptyTotals();
    this.restoredCostAdjustmentUsd = 0;
    this.restoredPerModelBaselines = new Map();
    this.restoredPerModelCostUsd = new Map();
    this.explicitPerModelUsage = new Map();
    this.explicitPerModelCostUsd = new Map();
    this.restoredSessionId = null;
    this.restoredWallDurationMs = 0;
    this.restoredApiDurationMs = 0;
    this.restoredApiDurationWithoutRetriesMs = 0;
    this.restoredToolDurationMs = 0;
    this.restoredLinesAdded = 0;
    this.restoredLinesRemoved = 0;
    this.currentLinesAdded = 0;
    this.currentLinesRemoved = 0;
    this.apiDurationObservedThisTurn = false;
    this.fpsAverage = undefined;
    this.fpsLow1Pct = undefined;
  }

  isDegraded(): boolean {
    return this.saveDegraded;
  }

  // ─────────────────────────────────────────────────────────────────
  // Cross-session persistence
  // ─────────────────────────────────────────────────────────────────

  /**
   * Configure (or reconfigure) the persistence target. Useful when the
   * sidecar is constructed before the project dir / session id are
   * known (e.g., tests mutate it later).
   */
  setPersistenceContext(opts: {
    readonly projectDir: string;
    readonly sessionId: string;
  }): void {
    this.projectDir = opts.projectDir;
    this.sessionId = opts.sessionId;
  }

  setCurrentSessionId(sessionId: string): void {
    this.sessionId = sessionId;
    this.sessionStartedAtWallMs = Date.now();
  }

  private get totalsPath(): string | null {
    return this.projectDir
      ? join(this.projectDir, COST_TOTALS_FILENAME)
      : null;
  }

  /**
   * Load lifetime totals from disk. Missing file → empty state (no
   * warning). Malformed JSON or bad schema → empty state + warning
   * diagnostic. Safe to call before the sidecar is wired into the
   * event log.
   */
  async loadFromDisk(): Promise<void> {
    this.loaded = true;
    const path = this.totalsPath;
    if (!path) return;
    let raw: string;
    try {
      raw = await fsp.readFile(path, "utf8");
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "ENOENT") return; // first-run, start empty
      this.onDiagnostic?.({
        level: "warning",
        cause: "cost_load_failed",
        message: `cost-totals read failed: ${code ?? (err as Error).message}`,
      });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      this.onDiagnostic?.({
        level: "warning",
        cause: "cost_load_corrupt",
        message: `cost-totals JSON parse failed: ${(err as Error).message}`,
      });
      return;
    }
    const validated = validateTotalsFile(parsed);
    if (!validated) {
      this.onDiagnostic?.({
        level: "warning",
        cause: "cost_load_corrupt",
        message: "cost-totals schema invalid",
      });
      return;
    }
    // Coerce partial totalUsage (forward-compat: missing fields → 0).
    this.loadedTotalUsage = coerceTotals(validated.totalUsage);
    this.loadedTotalCostUsd = normalizeCost(validated.totalCostUsd);
    this.loadedSessions = validated.sessions
      .map((record) => coerceSessionRecord(record))
      .filter((record): record is SessionCostRecord => record !== null);
  }

  /** Current session's in-memory totals, in `CostTotals` shape. */
  getSessionTotals(): CostTotals {
    return addTotals(this.restoredAggregateBaseline, this.getPerModelTotals());
  }

  private getPerModelTotals(): CostTotals {
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheCreationTokens = 0;
    let reasoningOutputTokens = 0;
    let webSearchRequests = 0;
    let totalTokens = 0;
    for (const usage of this.perModel.values()) {
      inputTokens += usage.inputTokens;
      outputTokens += usage.outputTokens;
      cacheReadTokens += usage.cachedInputTokens;
      cacheCreationTokens += usage.cacheCreationInputTokens;
      reasoningOutputTokens += usage.reasoningOutputTokens;
      webSearchRequests += usage.webSearchRequests;
      totalTokens += usage.totalTokens;
    }
    return {
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      reasoningOutputTokens,
      webSearchRequests,
      totalTokens,
    };
  }

  private buildSessionRecord(): SessionCostRecord | null {
    if (!this.projectDir || !this.sessionId) return null;
    return {
      sessionId: this.sessionId,
      startedAtMs: this.sessionStartedAtWallMs,
      endedAtMs: Date.now(),
      usage: this.getSessionTotals(),
      costUsd: this.getTotalCostUsd(),
      modelUsage: this.getSessionModelUsage(),
      durationMs: this.getTotalDurationMs(),
      apiDurationMs: this.getTotalApiDurationMs(),
      apiDurationWithoutRetriesMs: this.getTotalApiDurationWithoutRetriesMs(),
      toolDurationMs: this.getTotalToolDurationMs(),
      linesAdded: this.getTotalLinesAdded(),
      linesRemoved: this.getTotalLinesRemoved(),
      ...(this.fpsAverage !== undefined ? { fpsAverage: this.fpsAverage } : {}),
      ...(this.fpsLow1Pct !== undefined ? { fpsLow1Pct: this.fpsLow1Pct } : {}),
    };
  }

  /**
   * Lifetime totals — loaded-from-disk totals plus the current
   * session's in-memory tally. Returned values are tokens, not cost.
   */
  getLifetimeTotals(): CostTotals {
    return addTotals(this.loadedTotalUsage, this.getSessionTotals());
  }

  getLifetimeCostUsd(): number {
    return this.loadedTotalCostUsd + this.getTotalCostUsd();
  }

  /**
   * Append a finished session's totals to the sessions[] array. Does
   * not itself write to disk — call `saveToDisk()` afterward.
   */
  appendSessionRecord(summary: SessionCostRecord): void {
    this.loadedSessions.push(summary);
    this.loadedTotalUsage = addTotals(this.loadedTotalUsage, summary.usage);
    this.loadedTotalCostUsd += summary.costUsd;
  }

  replaceSessionRecord(summary: SessionCostRecord): void {
    const index = this.loadedSessions.findIndex(
      (record) => record.sessionId === summary.sessionId,
    );
    if (index >= 0) {
      const previous = this.loadedSessions[index]!;
      this.loadedTotalUsage = subtractTotals(
        this.loadedTotalUsage,
        coerceTotals(previous.usage),
      );
      this.loadedTotalCostUsd = Math.max(
        0,
        this.loadedTotalCostUsd - previous.costUsd,
      );
      this.loadedSessions[index] = summary;
    } else {
      this.loadedSessions.push(summary);
    }
    this.loadedTotalUsage = addTotals(this.loadedTotalUsage, summary.usage);
    this.loadedTotalCostUsd += summary.costUsd;
  }

  restoreSessionCostsForSession(sessionId: string): boolean {
    if (this.restoredSessionId === sessionId) {
      return true;
    }
    if (this.hasCurrentSessionCostState()) {
      return false;
    }
    if (!this.loaded) {
      return false;
    }

    const index = this.loadedSessions.findIndex(
      (record) => record.sessionId === sessionId,
    );
    if (index < 0) {
      return false;
    }
    const [record] = this.loadedSessions.splice(index, 1);
    if (!record) {
      return false;
    }

    const restoredUsage = coerceTotals(record.usage);
    this.loadedTotalUsage = subtractTotals(this.loadedTotalUsage, restoredUsage);
    this.loadedTotalCostUsd = Math.max(
      0,
      this.loadedTotalCostUsd - record.costUsd,
    );
    this.sessionId = sessionId;
    this.sessionStartedAtWallMs = record.startedAtMs;
    this.restoredSessionId = sessionId;
    this.restoredWallDurationMs =
      record.durationMs ?? Math.max(0, record.endedAtMs - record.startedAtMs);
    this.restoredApiDurationMs = record.apiDurationMs ?? 0;
    this.restoredApiDurationWithoutRetriesMs =
      record.apiDurationWithoutRetriesMs ?? record.apiDurationMs ?? 0;
    this.restoredToolDurationMs = record.toolDurationMs ?? 0;
    this.restoredLinesAdded = record.linesAdded ?? 0;
    this.restoredLinesRemoved = record.linesRemoved ?? 0;
    this.fpsAverage = record.fpsAverage;
    this.fpsLow1Pct = record.fpsLow1Pct;

    const modelUsage = (record.modelUsage ?? [])
      .map((row) => coerceSessionModelUsage(row))
      .filter((row): row is SessionCostModelUsage => row !== null);
    if (modelUsage.length === 0) {
      this.restoredAggregateBaseline = restoredUsage;
      this.restoredCostAdjustmentUsd = record.costUsd;
      return true;
    }

    let restoredModelCostUsd = 0;
    for (const row of modelUsage) {
      const usage: ModelUsage = {
        model: row.model,
        ...(row.provider !== undefined ? { provider: row.provider } : {}),
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        cachedInputTokens: row.cacheReadTokens,
        cacheCreationInputTokens: row.cacheCreationTokens,
        reasoningOutputTokens: row.reasoningOutputTokens,
        webSearchRequests: row.webSearchRequests,
        totalTokens: row.totalTokens,
        turns: row.turns,
      };
      const key = usageKey(usage.model, usage.provider);
      this.perModel.set(key, usage);
      this.restoredPerModelBaselines.set(key, { ...usage });
      this.restoredPerModelCostUsd.set(key, row.costUsd);
      const resolution = computeUsdCostWithResolution(usage, this.registry);
      if (!resolution.known) {
        this.unknownCostModels.add(key);
      }
      restoredModelCostUsd += row.costUsd;
    }
    this.restoredAggregateBaseline = emptyTotals();
    this.restoredCostAdjustmentUsd = record.costUsd - restoredModelCostUsd;
    return true;
  }

  getStoredSessionRecord(sessionId: string): SessionCostRecord | undefined {
    return this.loadedSessions.find((record) => record.sessionId === sessionId);
  }

  private hasCurrentSessionCostState(): boolean {
    return (
      this.perModel.size > 0 ||
      this.restoredSessionId !== null ||
      this.currentLinesAdded > 0 ||
      this.currentLinesRemoved > 0 ||
      this.totalApiDurationMs > 0 ||
      this.totalApiDurationWithoutRetriesMs > 0 ||
      this.totalToolDurationMs > 0 ||
      this.toolStartedAtByCallId.size > 0
    );
  }

  async saveCurrentSessionCosts(): Promise<void> {
    if (!this.projectDir || !this.sessionId) return;
    this.setFpsMetrics(this.fpsMetricsProvider?.());
    if (!this.loaded) await this.loadFromDisk();
    const record = this.buildSessionRecord();
    if (!record) return;
    this.replaceSessionRecord(record);
    await this.saveToDisk();
  }

  /**
   * Atomically write the current lifetime totals to disk. Tolerates
   * disk failure: emits `cost_save_failed` warning and flags the
   * sidecar degraded but keeps the in-memory totals intact so the
   * next save attempt can succeed.
   */
  async saveToDisk(): Promise<void> {
    const path = this.totalsPath;
    if (!path) return;
    if (!this.loaded) await this.loadFromDisk();
    const payload: CostTotalsFile = {
      version: COST_TOTALS_SCHEMA_VERSION,
      totalUsage: this.loadedTotalUsage,
      totalCostUsd: this.loadedTotalCostUsd,
      sessions: this.loadedSessions,
      updatedAtMs: Date.now(),
    };
    try {
      await fsp.mkdir(this.projectDir!, { recursive: true });
      await this.writeImpl(path, JSON.stringify(payload));
      this.saveDegraded = false;
    } catch (err) {
      this.saveDegraded = true;
      this.onDiagnostic?.({
        level: "warning",
        cause: "cost_save_failed",
        message: `cost-totals atomic write failed: ${(err as { code?: string }).code ?? (err as Error).message}`,
      });
    }
  }

  /**
   * Sidecar lifecycle hook invoked by `SidecarManager.stop()` during
   * session shutdown. Finalizes the current session into `sessions[]`
   * and flushes to disk. Called before the event-log is closed so
   * any diagnostic emissions still land in the rollout.
   */
  async stop(): Promise<void> {
    this.disposeExitSummary?.();
    this.disposeExitSummary = null;
    this.writeExitSummary();
    await this.saveCurrentSessionCosts();
  }

  start(): void {
    if (this.exitSummaryOpts === false || this.disposeExitSummary) return;
    const processLike = this.exitSummaryOpts.processLike ?? process;
    const onExit = (): void => {
      this.writeExitSummary();
    };
    processLike.on("exit", onExit);
    this.disposeExitSummary = () => {
      processLike.off("exit", onExit);
    };
  }

  private writeExitSummary(): void {
    if (this.exitSummaryOpts === false || this.exitSummaryPrinted) return;
    const shouldPrint = this.exitSummaryOpts.shouldPrint ?? (() => true);
    if (!shouldPrint()) return;
    const processLike = this.exitSummaryOpts.processLike ?? process;
    const getSummary =
      this.exitSummaryOpts.getSummary ?? (() => this.formatTotalCost());
    processLike.stdout.write(`\n${getSummary()}\n`);
    this.exitSummaryPrinted = true;
  }
}

export function registerCostSummaryOnExit(
  sidecar: CostSidecar,
  opts: CostSummaryExitHookOptions = {},
): () => void {
  const processLike = opts.processLike ?? process;
  const shouldPrint = opts.shouldPrint ?? (() => true);
  const getSummary = opts.getSummary ?? (() => sidecar.formatTotalCost());
  const onExit = (): void => {
    if (!shouldPrint()) return;
    processLike.stdout.write(`\n${getSummary()}\n`);
  };
  processLike.on("exit", onExit);
  return () => {
    processLike.off("exit", onExit);
  };
}
