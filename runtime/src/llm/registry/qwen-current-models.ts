/**
 * Current PAYG chat/tool deployments from the owner's live /models inventory,
 * checked 2026-09-29 against Alibaba's model cards and Function Calling guide.
 * Sources and conflicting regional capability labels: docs/models/qwen-current-2026-09-29.md.
 * Exact numeric limits come from the cards, never from shorthand K/M labels.
 */
import type { RegisteredModelCatalogEntry } from "./model-catalog.js";
import type { ReasoningEffort } from "../../session/turn-context.js";

export interface QwenCurrentModel {
  readonly model: string;
  readonly displayName: string;
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
  readonly maxOutputTokensUpperLimit?: number;
  readonly vision: boolean;
  readonly thinking: "always" | "hybrid" | "none";
  readonly totalOutputCap: boolean;
  readonly bufferedChat?: boolean;
  readonly toolStream?: boolean;
  readonly reasoningLevels?: readonly ReasoningEffort[];
  readonly defaultReasoningLevel?: ReasoningEffort;
  /** Singapore text/image rates per million; omit unsupported billing dimensions. */
  readonly rates?: readonly QwenCurrentRate[];
}

export interface QwenCurrentRate {
  readonly aboveInputTokens: number;
  readonly input: number;
  readonly output: number;
  readonly cached?: number;
}

export const QWEN_CURRENT_MODELS: readonly QwenCurrentModel[] = Object.freeze([
  {"model": "qwen3-coder-plus-2025-09-23", "displayName": "Qwen3 Coder Plus (2025-09-23 snapshot)", "contextWindow": 1000000, "maxOutputTokens": 65536, "vision": false, "thinking": "none", "totalOutputCap": false, "rates": [{"aboveInputTokens": 0, "input": 1, "output": 5}, {"aboveInputTokens": 32000, "input": 1.8, "output": 9}, {"aboveInputTokens": 128000, "input": 3, "output": 15}, {"aboveInputTokens": 256000, "input": 6, "output": 60}]},
  {"model": "qwen3.5-plus-2026-04-20", "displayName": "Qwen3.5 Plus (2026-04-20 snapshot)", "contextWindow": 1000000, "maxOutputTokens": 65536, "vision": true, "thinking": "hybrid", "totalOutputCap": true, "bufferedChat": true, "rates": [{"aboveInputTokens": 0, "input": 0.4, "output": 2.4}, {"aboveInputTokens": 256000, "input": 0.5, "output": 3}]},
  {"model": "qwen3.8-max-0902", "displayName": "Qwen3.8 Max (0902 snapshot)", "contextWindow": 1000000, "maxOutputTokens": 131072, "vision": true, "thinking": "hybrid", "totalOutputCap": true, "reasoningLevels": ["low", "medium", "xhigh"], "defaultReasoningLevel": "xhigh", "rates": [{"aboveInputTokens": 0, "input": 2, "output": 6, "cached": 0.25}]},
  {"model": "deepseek-v4-flash-0731", "displayName": "deepseek-v4-flash-0731 (snapshot)", "contextWindow": 1000000, "maxOutputTokens": 393216, "vision": false, "thinking": "hybrid", "totalOutputCap": true, "reasoningLevels": ["low", "high", "max"], "defaultReasoningLevel": "high"},
  {"model": "deepseek-v4-pro-0813", "displayName": "deepseek-v4-pro-0813 (snapshot)", "contextWindow": 1000000, "maxOutputTokens": 393216, "vision": false, "thinking": "hybrid", "totalOutputCap": true, "reasoningLevels": ["low", "high", "max"], "defaultReasoningLevel": "high"},
  {"model": "qwen3.7-max-2026-06-08", "displayName": "Qwen3.7 Max Vision (2026-06-08 snapshot)", "contextWindow": 1000000, "maxOutputTokens": 131072, "vision": true, "thinking": "hybrid", "totalOutputCap": true, "rates": [{"aboveInputTokens": 0, "input": 2.5, "output": 7.5, "cached": 0.5}]},
  {"model": "qwen3.7-max-preview", "displayName": "Qwen3.7 Max Preview", "contextWindow": 1000000, "maxOutputTokens": 131072, "vision": false, "thinking": "always", "totalOutputCap": true, "rates": [{"aboveInputTokens": 0, "input": 2.5, "output": 7.5}]},
  {"model": "glm-5.3-prime", "displayName": "GLM-5.3 Prime", "vision": false, "thinking": "always", "totalOutputCap": true, "toolStream": true, "rates": [{"aboveInputTokens": 0, "input": 2.8, "output": 8.8, "cached": 0.56}]},
  {"model": "glm-5.3", "displayName": "GLM-5.3", "contextWindow": 1048576, "maxOutputTokens": 131072, "vision": false, "thinking": "always", "totalOutputCap": true, "bufferedChat": false, "toolStream": true, "reasoningLevels": ["low", "high", "max"], "defaultReasoningLevel": "max", "rates": [{"aboveInputTokens": 0, "input": 1.4, "output": 4.4, "cached": 0.28}]},
  {"model": "deepseek-v4.1-flash", "displayName": "DeepSeek-v4.1-flash", "contextWindow": 1000000, "maxOutputTokens": 393216, "vision": true, "thinking": "hybrid", "totalOutputCap": true, "bufferedChat": false, "reasoningLevels": ["low", "high", "max"], "defaultReasoningLevel": "high"},
  {"model": "kimi-k3", "displayName": "Kimi-k3", "contextWindow": 1048576, "maxOutputTokens": 1048576, "vision": true, "thinking": "always", "totalOutputCap": true, "bufferedChat": false, "reasoningLevels": ["low", "high", "max"], "defaultReasoningLevel": "max", "rates": [{"aboveInputTokens": 0, "input": 3.0, "output": 15.0, "cached": 0.3}]},
  {"model": "glm-5.2-fast-preview", "displayName": "GLM-5.2-fast-preview", "contextWindow": 1048576, "maxOutputTokens": 131072, "vision": false, "thinking": "hybrid", "totalOutputCap": true, "bufferedChat": false, "toolStream": true, "reasoningLevels": ["none", "minimal", "low", "medium", "high", "xhigh", "max"], "defaultReasoningLevel": "high", "rates": [{"aboveInputTokens": 0, "input": 2.8, "output": 8.8, "cached": 0.56}]},
  {"model": "kimi-k2.7-code", "displayName": "Kimi-k2.7-code", "contextWindow": 262144, "maxOutputTokens": 16384, "vision": true, "thinking": "always", "totalOutputCap": true, "bufferedChat": false, "rates": [{"aboveInputTokens": 0, "input": 0.95, "output": 4.0, "cached": 0.19}]},
  {"model": "glm-5.2", "displayName": "GLM-5.2", "contextWindow": 1048576, "maxOutputTokens": 131072, "vision": false, "thinking": "hybrid", "totalOutputCap": true, "bufferedChat": false, "toolStream": true, "reasoningLevels": ["none", "minimal", "low", "medium", "high", "xhigh", "max"], "defaultReasoningLevel": "high", "rates": [{"aboveInputTokens": 0, "input": 1.4, "output": 4.4, "cached": 0.28}]},
  {"model": "glm-5.1", "displayName": "GLM-5.1", "contextWindow": 202745, "maxOutputTokens": 131072, "vision": false, "thinking": "hybrid", "totalOutputCap": true, "bufferedChat": false, "toolStream": true, "reasoningLevels": ["none", "minimal", "low", "medium", "high", "xhigh"], "defaultReasoningLevel": "high", "rates": [{"aboveInputTokens": 0, "input": 1.4, "output": 4.4, "cached": 0.26}]},
  {"model": "deepseek-v4-flash", "displayName": "DeepSeek-v4-flash", "contextWindow": 1000000, "maxOutputTokens": 393216, "vision": false, "thinking": "hybrid", "totalOutputCap": true, "bufferedChat": false, "reasoningLevels": ["high", "max"], "defaultReasoningLevel": "high", "rates": [{"aboveInputTokens": 0, "input": 0.2, "output": 0.4, "cached": 0.04}]},
  {"model": "deepseek-v4-pro", "displayName": "DeepSeek-v4-pro", "contextWindow": 1000000, "maxOutputTokens": 393216, "vision": false, "thinking": "hybrid", "totalOutputCap": true, "bufferedChat": false, "reasoningLevels": ["high", "max"], "defaultReasoningLevel": "high", "rates": [{"aboveInputTokens": 0, "input": 2.4, "output": 4.8, "cached": 0.2}]},
  {"model": "qwen3.6-27b", "displayName": "Qwen3.6-27b", "contextWindow": 262144, "maxOutputTokens": 65536, "vision": true, "thinking": "hybrid", "totalOutputCap": false, "bufferedChat": true, "rates": [{"aboveInputTokens": 0, "input": 0.6, "output": 3.6}]},
  {"model": "qwen3.6-max-preview", "displayName": "Qwen3.6-max-preview", "contextWindow": 262144, "maxOutputTokens": 65536, "vision": false, "thinking": "hybrid", "totalOutputCap": false, "bufferedChat": true, "rates": [{"aboveInputTokens": 0, "input": 1.3, "output": 7.8}, {"aboveInputTokens": 128000, "input": 2.0, "output": 12.0}]},
  {"model": "qwen3.6-35b-a3b", "displayName": "Qwen3.6-35b-a3b", "contextWindow": 262144, "maxOutputTokens": 65536, "vision": true, "thinking": "hybrid", "totalOutputCap": false, "bufferedChat": true, "rates": [{"aboveInputTokens": 0, "input": 0.375, "output": 2.25}]},
  {"model": "qwen3.5-omni-plus", "displayName": "Qwen3.5-omni-plus", "contextWindow": 262144, "maxOutputTokens": 65536, "vision": true, "thinking": "none", "totalOutputCap": false, "bufferedChat": true, "rates": [{"aboveInputTokens": 0, "input": 1.4, "output": 8.3}]},
  {"model": "qwen3.5-omni-flash", "displayName": "Qwen3.5-omni-flash", "contextWindow": 262144, "maxOutputTokens": 65536, "vision": true, "thinking": "none", "totalOutputCap": false, "bufferedChat": true, "rates": [{"aboveInputTokens": 0, "input": 0.4, "output": 2.2}]},
  {"model": "deepseek-v3.2", "displayName": "DeepSeek-v3.2", "contextWindow": 131072, "maxOutputTokens": 65536, "vision": false, "thinking": "hybrid", "totalOutputCap": true, "bufferedChat": false, "rates": [{"aboveInputTokens": 0, "input": 0.57, "output": 1.71, "cached": 0.114}]},
  {"model": "qwen3.5-flash", "displayName": "Qwen3.5-flash", "contextWindow": 1000000, "maxOutputTokens": 65536, "vision": true, "thinking": "hybrid", "totalOutputCap": true, "bufferedChat": true, "rates": [{"aboveInputTokens": 0, "input": 0.1, "output": 0.4}]},
  {"model": "qwen3.5-122b-a10b", "displayName": "Qwen3.5-122b-a10b", "contextWindow": 262144, "maxOutputTokens": 65536, "vision": true, "thinking": "hybrid", "totalOutputCap": false, "bufferedChat": true, "rates": [{"aboveInputTokens": 0, "input": 0.4, "output": 3.2}]},
  {"model": "qwen3.5-35b-a3b", "displayName": "Qwen3.5-35b-a3b", "contextWindow": 262144, "maxOutputTokens": 65536, "vision": true, "thinking": "hybrid", "totalOutputCap": false, "bufferedChat": true, "rates": [{"aboveInputTokens": 0, "input": 0.25, "output": 2.0}]},
  {"model": "qwen3.5-27b", "displayName": "Qwen3.5-27b", "contextWindow": 262144, "maxOutputTokens": 65536, "vision": true, "thinking": "hybrid", "totalOutputCap": false, "bufferedChat": true, "rates": [{"aboveInputTokens": 0, "input": 0.3, "output": 2.4}]},
  {"model": "qwen3.5-397b-a17b", "displayName": "Qwen3.5-397b-a17b", "contextWindow": 262144, "maxOutputTokens": 65536, "vision": true, "thinking": "hybrid", "totalOutputCap": false, "bufferedChat": true, "rates": [{"aboveInputTokens": 0, "input": 0.6, "output": 3.6}]},
  {"model": "qwen3.5-plus", "displayName": "Qwen3.5-plus", "contextWindow": 1000000, "maxOutputTokens": 65536, "vision": true, "thinking": "hybrid", "totalOutputCap": true, "bufferedChat": true, "rates": [{"aboveInputTokens": 0, "input": 0.4, "output": 2.4}, {"aboveInputTokens": 256000, "input": 0.5, "output": 3.0}]},
  {"model": "qwen-flash", "displayName": "Qwen-flash", "contextWindow": 1000000, "maxOutputTokens": 32768, "vision": false, "thinking": "hybrid", "totalOutputCap": false, "bufferedChat": false, "rates": [{"aboveInputTokens": 0, "input": 0.05, "output": 0.4, "cached": 0.01}, {"aboveInputTokens": 256000, "input": 0.25, "output": 2.0, "cached": 0.05}]},
  {"model": "qwen3-vl-flash", "displayName": "Qwen3-vl-flash", "contextWindow": 262144, "maxOutputTokens": 32768, "vision": true, "thinking": "hybrid", "totalOutputCap": false, "bufferedChat": true, "rates": [{"aboveInputTokens": 0, "input": 0.05, "output": 0.4, "cached": 0.01}, {"aboveInputTokens": 32000, "input": 0.075, "output": 0.6, "cached": 0.015}, {"aboveInputTokens": 128000, "input": 0.12, "output": 0.96, "cached": 0.024}]},
  {"model": "qwen3-omni-flash", "displayName": "Qwen3-omni-flash", "contextWindow": 65536, "maxOutputTokens": 16384, "vision": true, "thinking": "hybrid", "totalOutputCap": false, "bufferedChat": true},
  {"model": "qwen-coder-plus", "displayName": "Qwen-coder-plus", "contextWindow": 131072, "maxOutputTokens": 8192, "vision": false, "thinking": "none", "totalOutputCap": false, "bufferedChat": false},
  {"model": "qwen3-8b", "displayName": "Qwen3-8b", "contextWindow": 131072, "maxOutputTokens": 8192, "vision": false, "thinking": "hybrid", "totalOutputCap": false, "bufferedChat": true},
  {"model": "qwen3-30b-a3b", "displayName": "Qwen3-30b-a3b", "contextWindow": 131072, "maxOutputTokens": 8192, "vision": false, "thinking": "hybrid", "totalOutputCap": false, "bufferedChat": true},
  {"model": "qwen3-235b-a22b", "displayName": "Qwen3-235b-a22b", "contextWindow": 131072, "maxOutputTokens": 16384, "vision": false, "thinking": "hybrid", "totalOutputCap": false, "bufferedChat": true},
  {"model": "qwen3-coder-480b-a35b-instruct", "displayName": "Qwen3-coder-480b-a35b-instruct", "contextWindow": 262144, "maxOutputTokens": 65536, "vision": false, "thinking": "none", "totalOutputCap": false, "bufferedChat": false, "rates": [{"aboveInputTokens": 0, "input": 1.5, "output": 7.5}, {"aboveInputTokens": 32000, "input": 2.7, "output": 13.5}, {"aboveInputTokens": 128000, "input": 4.5, "output": 22.5}]},
  {"model": "qwen3-235b-a22b-instruct-2507", "displayName": "Qwen3-235b-a22b-instruct-2507", "contextWindow": 131072, "maxOutputTokens": 32768, "vision": false, "thinking": "none", "totalOutputCap": false, "bufferedChat": true, "rates": [{"aboveInputTokens": 0, "input": 0.23, "output": 0.92}]},
  {"model": "qwen3-235b-a22b-thinking-2507", "displayName": "Qwen3-235b-a22b-thinking-2507", "contextWindow": 131072, "maxOutputTokens": 32768, "vision": false, "thinking": "always", "totalOutputCap": false, "bufferedChat": true, "rates": [{"aboveInputTokens": 0, "input": 0.23, "output": 2.3}]},
  {"model": "qwen3-coder-flash", "displayName": "Qwen3-coder-flash", "contextWindow": 1000000, "maxOutputTokens": 65536, "vision": false, "thinking": "none", "totalOutputCap": false, "bufferedChat": false, "rates": [{"aboveInputTokens": 0, "input": 0.3, "output": 1.5, "cached": 0.06}, {"aboveInputTokens": 32000, "input": 0.5, "output": 2.5, "cached": 0.1}, {"aboveInputTokens": 128000, "input": 0.8, "output": 4.0, "cached": 0.16}, {"aboveInputTokens": 256000, "input": 1.6, "output": 9.6, "cached": 0.32}]},
  {"model": "qwen3-max", "displayName": "Qwen3-max", "contextWindow": 262144, "maxOutputTokens": 32768, "maxOutputTokensUpperLimit": 65536, "vision": false, "thinking": "hybrid", "totalOutputCap": false, "bufferedChat": false, "rates": [{"aboveInputTokens": 0, "input": 1.2, "output": 6.0, "cached": 0.24}, {"aboveInputTokens": 32000, "input": 2.4, "output": 12.0, "cached": 0.48}, {"aboveInputTokens": 128000, "input": 3.0, "output": 15.0, "cached": 0.6}]},
  {"model": "qwen3-vl-plus", "displayName": "Qwen3-vl-plus", "contextWindow": 262144, "maxOutputTokens": 32768, "vision": true, "thinking": "hybrid", "totalOutputCap": false, "bufferedChat": true, "rates": [{"aboveInputTokens": 0, "input": 0.2, "output": 1.6, "cached": 0.04}, {"aboveInputTokens": 32000, "input": 0.3, "output": 2.4, "cached": 0.06}, {"aboveInputTokens": 128000, "input": 0.6, "output": 4.8, "cached": 0.12}]},
  {"model": "qwen3-vl-235b-a22b-instruct", "displayName": "Qwen3-vl-235b-a22b-instruct", "contextWindow": 131072, "maxOutputTokens": 32768, "vision": true, "thinking": "none", "totalOutputCap": false, "bufferedChat": true, "rates": [{"aboveInputTokens": 0, "input": 0.4, "output": 1.6}]},
  {"model": "qwen3-vl-235b-a22b-thinking", "displayName": "Qwen3-vl-235b-a22b-thinking", "contextWindow": 131072, "maxOutputTokens": 32768, "vision": true, "thinking": "always", "totalOutputCap": false, "bufferedChat": true, "rates": [{"aboveInputTokens": 0, "input": 0.4, "output": 4.0}]},
  {"model": "qwen3-30b-a3b-thinking-2507", "displayName": "Qwen3-30b-a3b-thinking-2507", "contextWindow": 81920, "maxOutputTokens": 32768, "vision": false, "thinking": "always", "totalOutputCap": false, "bufferedChat": true, "rates": [{"aboveInputTokens": 0, "input": 0.2, "output": 2.4}]},
  {"model": "qwen3-30b-a3b-instruct-2507", "displayName": "Qwen3-30b-a3b-instruct-2507", "contextWindow": 131072, "maxOutputTokens": 32768, "vision": false, "thinking": "none", "totalOutputCap": false, "bufferedChat": true, "rates": [{"aboveInputTokens": 0, "input": 0.2, "output": 0.8}]},
  {"model": "qwen3-14b", "displayName": "Qwen3-14b", "contextWindow": 131072, "maxOutputTokens": 8192, "vision": false, "thinking": "hybrid", "totalOutputCap": false, "bufferedChat": true},
  {"model": "qwen3-32b", "displayName": "Qwen3-32b", "contextWindow": 131072, "maxOutputTokens": 8192, "vision": false, "thinking": "hybrid", "totalOutputCap": false, "bufferedChat": true, "rates": [{"aboveInputTokens": 0, "input": 0.16, "output": 0.64}]},
  {"model": "qwen3-next-80b-a3b-thinking", "displayName": "Qwen3-next-80b-a3b-thinking", "contextWindow": 131072, "maxOutputTokens": 32768, "vision": false, "thinking": "always", "totalOutputCap": false, "bufferedChat": true, "rates": [{"aboveInputTokens": 0, "input": 0.15, "output": 1.2}]},
  {"model": "qwen3-next-80b-a3b-instruct", "displayName": "Qwen3-next-80b-a3b-instruct", "contextWindow": 131072, "maxOutputTokens": 32768, "vision": false, "thinking": "none", "totalOutputCap": false, "bufferedChat": true, "rates": [{"aboveInputTokens": 0, "input": 0.15, "output": 1.2}]},
  {"model": "qwen-max", "displayName": "Qwen-max", "contextWindow": 32768, "maxOutputTokens": 8192, "vision": false, "thinking": "none", "totalOutputCap": false, "bufferedChat": false, "rates": [{"aboveInputTokens": 0, "input": 1.6, "output": 6.4, "cached": 0.32}]},
  {"model": "qwen-plus", "displayName": "Qwen-plus", "contextWindow": 1000000, "maxOutputTokens": 32768, "vision": false, "thinking": "hybrid", "totalOutputCap": false, "bufferedChat": false},
  {"model": "qwen-turbo", "displayName": "Qwen-turbo", "contextWindow": 131072, "maxOutputTokens": 16384, "vision": false, "thinking": "hybrid", "totalOutputCap": false, "bufferedChat": false},
  {"model": "ZHIPU/GLM-5.3", "displayName": "GLM-5.3 (Zhipu)", "vision": false, "thinking": "always", "totalOutputCap": false, "reasoningLevels": ["low", "high", "max"], "defaultReasoningLevel": "max"},
  {"model": "kimi/kimi-k3", "displayName": "Kimi K3 (Moonshot, Beijing)", "vision": true, "thinking": "always", "totalOutputCap": false, "reasoningLevels": ["max"], "defaultReasoningLevel": "max"},
]);

export function resolveQwenCurrentModel(model: string | undefined): QwenCurrentModel | undefined {
  const normalized = model?.trim().toLowerCase();
  return QWEN_CURRENT_MODELS.find((entry) => entry.model.toLowerCase() === normalized);
}

export const QWEN_CURRENT_MODEL_CATALOG: readonly RegisteredModelCatalogEntry[] = Object.freeze(
  QWEN_CURRENT_MODELS.map((entry, priority) => Object.freeze({
    provider: "qwen", model: entry.model, displayName: entry.displayName,
    ...(entry.contextWindow === undefined ? {} : {contextWindow: entry.contextWindow, maxContextWindow: entry.contextWindow}),
    ...(entry.maxOutputTokens === undefined ? {} : {maxOutputTokens: entry.maxOutputTokens}),
    ...(entry.maxOutputTokensUpperLimit === undefined ? {} : {maxOutputTokensUpperLimit: entry.maxOutputTokensUpperLimit, maxOutputTokensCappedDefault: true}),
    inputModalities: entry.vision ? ["text", "image"] as const : ["text"] as const,
    supportsToolUse: true, supportsParallelToolCalls: true,
    // JSON object support does not establish the JSON Schema contract Core uses.
    supportsStructuredOutput: false, supportsSearchTool: false,
    supportsVerbosity: false, webSearchToolType: "none" as const,
    supportsReasoningSummaries: false, defaultReasoningSummary: "none" as const,
    supportedReasoningLevels: entry.reasoningLevels ?? [],
    ...(entry.defaultReasoningLevel ? {defaultReasoningLevel: entry.defaultReasoningLevel} : {}),
    additionalSpeedTiers: [], priority: priority + 12, visibility: entry.model === "kimi/kimi-k3" ? "none" as const : "list" as const,
  })),
);

/** Existing picker models with newly verified Singapore prices. */
export const QWEN_EXISTING_RATE_ROWS: Readonly<Record<string, readonly QwenCurrentRate[]>> = Object.freeze({
  "qwen3.7-max": [
    {
      "aboveInputTokens": 0,
      "input": 2.5,
      "output": 7.5,
      "cached": 0.5
    }
  ],
  "qwen3.7-plus": [
    {
      "aboveInputTokens": 0,
      "input": 0.4,
      "output": 1.6,
      "cached": 0.08
    },
    {
      "aboveInputTokens": 256000,
      "input": 1.2,
      "output": 4.8,
      "cached": 0.24
    }
  ],
  "qwen3.7-flash": [
    {
      "aboveInputTokens": 0,
      "input": 0.03,
      "output": 0.13,
      "cached": 0.006
    },
    {
      "aboveInputTokens": 32000,
      "input": 0.1,
      "output": 0.4,
      "cached": 0.02
    },
    {
      "aboveInputTokens": 256000,
      "input": 0.2,
      "output": 0.8,
      "cached": 0.04
    }
  ],
  "qwen3.6-plus": [
    {
      "aboveInputTokens": 0,
      "input": 0.5,
      "output": 3.0
    },
    {
      "aboveInputTokens": 256000,
      "input": 2.0,
      "output": 6.0
    }
  ],
  "qwen3.6-flash": [
    {
      "aboveInputTokens": 0,
      "input": 0.25,
      "output": 1.5
    },
    {
      "aboveInputTokens": 256000,
      "input": 1.0,
      "output": 4.0
    }
  ],
  "qwen3-coder-plus": [
    {
      "aboveInputTokens": 0,
      "input": 1.0,
      "output": 5.0,
      "cached": 0.2
    },
    {
      "aboveInputTokens": 32000,
      "input": 1.8,
      "output": 9.0,
      "cached": 0.36
    },
    {
      "aboveInputTokens": 128000,
      "input": 3.0,
      "output": 15.0,
      "cached": 0.6
    },
    {
      "aboveInputTokens": 256000,
      "input": 6.0,
      "output": 60.0,
      "cached": 1.2
    }
  ],
  "qwen3-coder-next": [
    {
      "aboveInputTokens": 0,
      "input": 0.3,
      "output": 1.5
    },
    {
      "aboveInputTokens": 32000,
      "input": 0.5,
      "output": 2.5
    },
    {
      "aboveInputTokens": 128000,
      "input": 0.8,
      "output": 4.0
    }
  ],
  "qwen3.8-flash": [
    {
      "aboveInputTokens": 0,
      "input": 0.15,
      "output": 0.47
    }
  ]
});
