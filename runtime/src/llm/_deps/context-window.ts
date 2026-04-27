/**
 * Local _deps stub for the gut/AgenC crossing of
 * `../gateway/context-window.js`. The full gateway resolver lives in
 * the AgenC port; this lean stub re-exposes only the surface that
 * the LLM subsystem actually consumes:
 *   - GatewayLLMConfig type (minimal field set)
 *   - normalizeGrokModel (legacy alias rewrite)
 *   - resolveContextWindowProfile (heuristic-only path)
 *
 * The rebuilt gateway tranche will replace this with the canonical
 * resolver. For now keep behavior conservative: never throw, return
 * heuristic answers, and skip the catalog/dynamic-fetch paths.
 */

import type { LLMProviderExecutionProfile } from "../types.js";

export interface GatewayLLMConfig {
  readonly provider?: "grok" | "ollama" | "openai-compat" | string;
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly model?: string;
  readonly contextWindowTokens?: number;
  readonly maxTokens?: number;
  readonly promptHardMaxChars?: number;
  readonly promptSafetyMarginTokens?: number;
  readonly promptCharPerToken?: number;
  readonly requestTimeoutMs?: number;
  readonly maxReasoningTokens?: number;
  readonly webSearch?: boolean;
  readonly apiKeyEnv?: string;
  readonly modelRoute?: unknown;
  readonly reasoningEffort?: string;
  readonly xai?: unknown;
}

const DEFAULT_GROK_CONTEXT_WINDOW_TOKENS = 256_000;
const DEFAULT_OLLAMA_CONTEXT_WINDOW_TOKENS = 4_096;
const DEFAULT_OLLAMA_MODEL = "llama3";

const LEGACY_GROK_MODEL_ALIASES: Record<string, string> = {
  "grok-4": "grok-4-1-fast-reasoning",
  "grok-4-fast-reasoning": "grok-4-1-fast-reasoning",
  "grok-4-fast-non-reasoning": "grok-4-1-fast-non-reasoning",
  "grok-4.20-beta-0309-reasoning": "grok-4.20-0309-reasoning",
  "grok-4.20-beta-0309-non-reasoning": "grok-4.20-0309-non-reasoning",
  "grok-4.20-multi-agent-beta-0309": "grok-4.20-multi-agent-0309",
};

const GROK_CONTEXT_WINDOW_BY_PREFIX: ReadonlyArray<{
  readonly prefix: string;
  readonly contextWindowTokens: number;
}> = [
  { prefix: "grok-4.20-multi-agent-0309", contextWindowTokens: 2_000_000 },
  { prefix: "grok-4.20-0309-reasoning", contextWindowTokens: 2_000_000 },
  { prefix: "grok-4.20-0309-non-reasoning", contextWindowTokens: 2_000_000 },
  { prefix: "grok-4-1-fast", contextWindowTokens: 2_000_000 },
  { prefix: "grok-4-fast", contextWindowTokens: 2_000_000 },
  { prefix: "grok-code-fast-1", contextWindowTokens: 256_000 },
  { prefix: "grok-4-0709", contextWindowTokens: 256_000 },
  { prefix: "grok-3-mini", contextWindowTokens: 131_072 },
  { prefix: "grok-3", contextWindowTokens: 131_072 },
];

export function normalizeGrokModel(
  model: string | undefined,
): string | undefined {
  if (!model) return undefined;
  const trimmed = model.trim();
  return LEGACY_GROK_MODEL_ALIASES[trimmed] ?? trimmed;
}

function inferGrokContextWindowTokens(model: string | undefined): number {
  const normalized = normalizeGrokModel(model);
  if (!normalized) return DEFAULT_GROK_CONTEXT_WINDOW_TOKENS;
  for (const entry of GROK_CONTEXT_WINDOW_BY_PREFIX) {
    if (normalized.startsWith(entry.prefix)) return entry.contextWindowTokens;
  }
  return DEFAULT_GROK_CONTEXT_WINDOW_TOKENS;
}

function normalizeOptionalPositiveInt(
  value: number | undefined,
): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : undefined;
}

function parseContextTokenValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    const normalized = Math.floor(value);
    return normalized > 0 ? normalized : undefined;
  }
  return undefined;
}

export async function resolveContextWindowProfile(
  llmConfig: GatewayLLMConfig | undefined,
  _options?: unknown,
): Promise<LLMProviderExecutionProfile | undefined> {
  if (!llmConfig) return undefined;
  const explicit = parseContextTokenValue(llmConfig.contextWindowTokens);
  if (llmConfig.provider === "grok") {
    const model = normalizeGrokModel(llmConfig.model);
    if (explicit !== undefined) {
      return {
        provider: "grok",
        ...(model ? { model } : {}),
        contextWindowTokens: explicit,
        contextWindowSource: "explicit_config",
        maxOutputTokens: normalizeOptionalPositiveInt(llmConfig.maxTokens),
      };
    }
    return {
      provider: "grok",
      ...(model ? { model } : {}),
      contextWindowTokens: inferGrokContextWindowTokens(model),
      contextWindowSource: "grok_model_heuristic",
      maxOutputTokens: normalizeOptionalPositiveInt(llmConfig.maxTokens),
    };
  }
  if (llmConfig.provider === "ollama") {
    const model = llmConfig.model?.trim() || DEFAULT_OLLAMA_MODEL;
    return {
      provider: "ollama",
      model,
      contextWindowTokens: explicit ?? DEFAULT_OLLAMA_CONTEXT_WINDOW_TOKENS,
      contextWindowSource: "ollama_request_num_ctx",
      maxOutputTokens: normalizeOptionalPositiveInt(llmConfig.maxTokens),
    };
  }
  if (explicit !== undefined && llmConfig.model) {
    return {
      provider: llmConfig.provider ?? "unknown",
      model: llmConfig.model,
      contextWindowTokens: explicit,
      contextWindowSource: "explicit_config",
      maxOutputTokens: normalizeOptionalPositiveInt(llmConfig.maxTokens),
    };
  }
  return undefined;
}
