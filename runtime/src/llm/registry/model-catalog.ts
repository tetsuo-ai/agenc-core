/**
 * Ports upstream runtime model catalog semantics onto AgenC's
 * provider-neutral registry.
 *
 * Shape difference from upstream:
 *   - The donor catalog includes prompt/personality text. AgenC stores only
 *     executable model metadata here; prompts remain owned by the prompt layer.
 */

import type { ReasoningEffort, ReasoningSummary } from "../../session/turn-context.js";

export type ModelInputModality = "text" | "image" | "audio";
export type ModelWebSearchToolType = "none" | "text" | "text_and_image";

export interface RegisteredModelCatalogEntry {
  readonly provider: string;
  readonly model: string;
  readonly displayName: string;
  readonly contextWindow?: number;
  readonly maxContextWindow?: number;
  readonly maxOutputTokens?: number;
  readonly inputModalities: readonly ModelInputModality[];
  readonly supportsToolUse: boolean;
  readonly supportsParallelToolCalls: boolean;
  readonly supportsStructuredOutput: boolean;
  readonly supportsSearchTool: boolean;
  readonly supportsVerbosity: boolean;
  readonly webSearchToolType: ModelWebSearchToolType;
  readonly supportsReasoningSummaries: boolean;
  readonly defaultReasoningSummary: ReasoningSummary;
  readonly supportedReasoningLevels: readonly ReasoningEffort[];
  readonly defaultReasoningLevel?: ReasoningEffort;
  readonly additionalSpeedTiers: readonly string[];
  readonly priority: number;
  readonly visibility: "list" | "hide" | "none";
}

export interface ModelCatalogMetadata {
  readonly contextWindow?: number;
  readonly maxContextWindow?: number;
  readonly maxOutputTokens?: number;
  readonly maxOutputTokensUpperLimit?: number;
}

export interface ModelCapabilityHints {
  readonly supportsToolUse?: boolean;
  readonly supportsImageInput?: boolean;
  readonly supportsStructuredOutput?: boolean;
  readonly supportsStructuredOutputWithTools?: boolean;
  readonly supportsProviderNativeWebSearch?: boolean;
  readonly acceptsImageHistory?: boolean;
  readonly acceptsReasoningEffort?: boolean;
}

const OPENAI_REASONING_LEVELS = Object.freeze([
  "low",
  "medium",
  "high",
  "xhigh",
] as const satisfies readonly ReasoningEffort[]);
const TEXT_IMAGE_MODALITIES = Object.freeze([
  "text",
  "image",
] as const satisfies readonly ModelInputModality[]);
const FAST_SPEED_TIER = Object.freeze(["fast"] as const);
const NO_ADDITIONAL_SPEED_TIERS = Object.freeze([] as const);

export const REGISTERED_MODEL_CATALOG: readonly RegisteredModelCatalogEntry[] =
  Object.freeze([
    {
      provider: "openai",
      model: "gpt-5.5",
      displayName: "GPT-5.5",
      contextWindow: 272_000,
      maxContextWindow: 272_000,
      inputModalities: TEXT_IMAGE_MODALITIES,
      supportsToolUse: true,
      supportsParallelToolCalls: true,
      supportsStructuredOutput: true,
      supportsSearchTool: true,
      supportsVerbosity: true,
      webSearchToolType: "text_and_image",
      supportsReasoningSummaries: true,
      defaultReasoningSummary: "none",
      supportedReasoningLevels: OPENAI_REASONING_LEVELS,
      defaultReasoningLevel: "medium",
      additionalSpeedTiers: FAST_SPEED_TIER,
      priority: 0,
      visibility: "list",
    },
    {
      provider: "openai",
      model: "gpt-5.4",
      displayName: "gpt-5.4",
      contextWindow: 272_000,
      maxContextWindow: 1_000_000,
      inputModalities: TEXT_IMAGE_MODALITIES,
      supportsToolUse: true,
      supportsParallelToolCalls: true,
      supportsStructuredOutput: true,
      supportsSearchTool: true,
      supportsVerbosity: true,
      webSearchToolType: "text_and_image",
      supportsReasoningSummaries: true,
      defaultReasoningSummary: "none",
      supportedReasoningLevels: OPENAI_REASONING_LEVELS,
      defaultReasoningLevel: "xhigh",
      additionalSpeedTiers: FAST_SPEED_TIER,
      priority: 2,
      visibility: "list",
    },
    {
      provider: "openai",
      model: "gpt-5.4-mini",
      displayName: "GPT-5.4-Mini",
      contextWindow: 272_000,
      maxContextWindow: 272_000,
      inputModalities: TEXT_IMAGE_MODALITIES,
      supportsToolUse: true,
      supportsParallelToolCalls: true,
      supportsStructuredOutput: true,
      supportsSearchTool: true,
      supportsVerbosity: true,
      webSearchToolType: "text_and_image",
      supportsReasoningSummaries: true,
      defaultReasoningSummary: "none",
      supportedReasoningLevels: OPENAI_REASONING_LEVELS,
      defaultReasoningLevel: "medium",
      additionalSpeedTiers: NO_ADDITIONAL_SPEED_TIERS,
      priority: 4,
      visibility: "list",
    },
    {
      provider: "openai",
      model: "gpt-5.3-codex", // branding-scan: allow OpenAI model identifier
      displayName: "gpt-5.3-codex", // branding-scan: allow OpenAI model display identifier
      contextWindow: 272_000,
      maxContextWindow: 272_000,
      inputModalities: TEXT_IMAGE_MODALITIES,
      supportsToolUse: true,
      supportsParallelToolCalls: true,
      supportsStructuredOutput: true,
      supportsSearchTool: true,
      supportsVerbosity: true,
      webSearchToolType: "text",
      supportsReasoningSummaries: true,
      defaultReasoningSummary: "none",
      supportedReasoningLevels: OPENAI_REASONING_LEVELS,
      defaultReasoningLevel: "medium",
      additionalSpeedTiers: NO_ADDITIONAL_SPEED_TIERS,
      priority: 6,
      visibility: "list",
    },
    {
      provider: "openai",
      model: "gpt-5.2",
      displayName: "gpt-5.2",
      contextWindow: 272_000,
      maxContextWindow: 272_000,
      inputModalities: TEXT_IMAGE_MODALITIES,
      supportsToolUse: true,
      supportsParallelToolCalls: true,
      supportsStructuredOutput: true,
      supportsSearchTool: true,
      supportsVerbosity: true,
      webSearchToolType: "text",
      supportsReasoningSummaries: true,
      defaultReasoningSummary: "auto",
      supportedReasoningLevels: OPENAI_REASONING_LEVELS,
      defaultReasoningLevel: "medium",
      additionalSpeedTiers: NO_ADDITIONAL_SPEED_TIERS,
      priority: 10,
      visibility: "list",
    },
    {
      provider: "openai",
      model: "codex-auto-review", // branding-scan: allow OpenAI model identifier
      displayName: "AgenC Auto Review",
      contextWindow: 272_000,
      maxContextWindow: 1_000_000,
      inputModalities: TEXT_IMAGE_MODALITIES,
      supportsToolUse: true,
      supportsParallelToolCalls: true,
      supportsStructuredOutput: true,
      supportsSearchTool: true,
      supportsVerbosity: true,
      webSearchToolType: "text_and_image",
      supportsReasoningSummaries: true,
      defaultReasoningSummary: "none",
      supportedReasoningLevels: OPENAI_REASONING_LEVELS,
      defaultReasoningLevel: "medium",
      additionalSpeedTiers: NO_ADDITIONAL_SPEED_TIERS,
      priority: 29,
      visibility: "hide",
    },
  ]);

export function listRegisteredModelCatalogEntries(
  provider?: string,
): readonly RegisteredModelCatalogEntry[] {
  const normalizedProvider = normalizeId(provider ?? "");
  return Object.freeze(
    REGISTERED_MODEL_CATALOG.filter(
      (entry) =>
        normalizedProvider.length === 0 ||
        normalizeId(entry.provider) === normalizedProvider,
    ),
  );
}

export function resolveRegisteredModelCatalogEntry(input: {
  readonly provider: string | undefined;
  readonly model: string | undefined;
}): RegisteredModelCatalogEntry | undefined {
  const provider = normalizeProvider(input.provider);
  const model = input.model?.trim() ?? "";
  if (provider.length === 0 || model.length === 0) return undefined;
  const candidates = REGISTERED_MODEL_CATALOG.filter(
    (entry) => normalizeProvider(entry.provider) === provider,
  );
  return (
    findExactModel(model, candidates) ??
    findNamespacedSuffix(model, candidates) ??
    findLongestPrefix(model, candidates)
  );
}

export function resolveModelCatalogMetadata(input: {
  readonly provider: string | undefined;
  readonly model: string | undefined;
}): ModelCatalogMetadata | undefined {
  const entry = resolveRegisteredModelCatalogEntry(input);
  if (entry === undefined) return undefined;
  return {
    ...(entry.contextWindow !== undefined
      ? { contextWindow: entry.contextWindow }
      : {}),
    ...(entry.maxContextWindow !== undefined
      ? { maxContextWindow: entry.maxContextWindow }
      : {}),
    ...(entry.maxOutputTokens !== undefined
      ? {
        maxOutputTokens: entry.maxOutputTokens,
        maxOutputTokensUpperLimit: entry.maxOutputTokens,
      }
      : {}),
  };
}

export function resolveModelCapabilityHints(input: {
  readonly provider: string | undefined;
  readonly model: string | undefined;
}): ModelCapabilityHints | undefined {
  const entry = resolveRegisteredModelCatalogEntry(input);
  if (entry === undefined) return undefined;
  const supportsImageInput = entry.inputModalities.includes("image");
  return {
    supportsToolUse: entry.supportsToolUse,
    supportsImageInput,
    supportsStructuredOutput: entry.supportsStructuredOutput,
    supportsStructuredOutputWithTools: entry.supportsStructuredOutput &&
      entry.supportsToolUse,
    supportsProviderNativeWebSearch: entry.supportsSearchTool,
    acceptsImageHistory: supportsImageInput,
    acceptsReasoningEffort: entry.supportedReasoningLevels.length > 0,
  };
}

function findExactModel(
  model: string,
  candidates: readonly RegisteredModelCatalogEntry[],
): RegisteredModelCatalogEntry | undefined {
  const normalized = normalizeId(model);
  return candidates.find((entry) => normalizeId(entry.model) === normalized);
}

function findNamespacedSuffix(
  model: string,
  candidates: readonly RegisteredModelCatalogEntry[],
): RegisteredModelCatalogEntry | undefined {
  const [namespace, suffix, extra] = model.split("/");
  if (extra !== undefined || suffix === undefined) return undefined;
  if (!/^\w+$/.test(namespace)) return undefined;
  return findExactModel(suffix, candidates) ??
    findLongestPrefix(suffix, candidates);
}

function findLongestPrefix(
  model: string,
  candidates: readonly RegisteredModelCatalogEntry[],
): RegisteredModelCatalogEntry | undefined {
  const normalized = normalizeId(model);
  return candidates
    .filter((entry) => normalized.startsWith(normalizeId(entry.model)))
    .sort((left, right) => right.model.length - left.model.length)[0];
}

function normalizeProvider(provider: string | undefined): string {
  const normalized = normalizeId(provider ?? "");
  return normalized === "xai" ? "grok" : normalized;
}

function normalizeId(value: string): string {
  return value.trim().toLowerCase();
}
