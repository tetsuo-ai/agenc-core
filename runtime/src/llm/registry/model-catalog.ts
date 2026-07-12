/**
 * Ports upstream runtime model catalog semantics onto AgenC's
 * provider-neutral registry.
 *
 * Shape difference from upstream:
 *   - AgenC keeps full prompt text in the prompt layer. This catalog carries
 *     only the per-model personality template surface needed to splice the
 *     current prompt into model-specific instructions.
 */

import {
  BASE_INSTRUCTIONS_PLACEHOLDER,
  PERSONALITY_PLACEHOLDER,
  type ModelMessages,
} from "../../context/personality-spec-instructions.js";
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
  readonly modelMessages?: ModelMessages;
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
const NO_REASONING_LEVELS = Object.freeze(
  [] as const satisfies readonly ReasoningEffort[],
);
// Grok 4.3 and 4.5 accept these depth controls. The multi-agent family uses
// the same values to control agent count rather than thinking depth.
const GROK_REASONING_LEVELS = Object.freeze([
  "low",
  "medium",
  "high",
] as const satisfies readonly ReasoningEffort[]);
const GROK_MULTI_AGENT_REASONING_LEVELS = Object.freeze([
  "low",
  "medium",
  "high",
] as const satisfies readonly ReasoningEffort[]);
const OPENAI_FRIENDLY_PERSONALITY =
  "You optimize for team morale and being a supportive teammate as much as code quality.";
const OPENAI_PRAGMATIC_PERSONALITY =
  "You are a deeply pragmatic, effective software engineer.";
const OPENAI_PERSONALITY_MESSAGES: ModelMessages = Object.freeze({
  instructionsTemplate:
    `${PERSONALITY_PLACEHOLDER}\n\n${BASE_INSTRUCTIONS_PLACEHOLDER}`,
  instructionsVariables: Object.freeze({
    personalityDefault: OPENAI_PRAGMATIC_PERSONALITY,
    personalityFriendly: OPENAI_FRIENDLY_PERSONALITY,
    personalityPragmatic: OPENAI_PRAGMATIC_PERSONALITY,
  }),
});

export const REGISTERED_MODEL_CATALOG: readonly RegisteredModelCatalogEntry[] =
  Object.freeze([
    {
      // openai built-in provider default (BUILT_IN_PROVIDER_DEFAULT_MODELS.openai).
      // Registered here so the default resolves through the single-source
      // registry instead of falling back to heuristics: "gpt-5" is not a prefix
      // of "gpt-5.5"/"gpt-5.4"/... (those are longer), so findLongestPrefix
      // cannot recover it without an explicit entry. Lowest priority so it
      // leads the openai catalog ordering in deriveFlatCatalog.
      provider: "openai",
      model: "gpt-5",
      displayName: "GPT-5",
      contextWindow: 272_000,
      maxContextWindow: 272_000,
      inputModalities: TEXT_IMAGE_MODALITIES,
      supportsToolUse: true,
      supportsParallelToolCalls: true,
      supportsStructuredOutput: true,
      supportsSearchTool: true,
      supportsVerbosity: true,
      modelMessages: OPENAI_PERSONALITY_MESSAGES,
      webSearchToolType: "text_and_image",
      supportsReasoningSummaries: true,
      defaultReasoningSummary: "none",
      supportedReasoningLevels: OPENAI_REASONING_LEVELS,
      defaultReasoningLevel: "medium",
      additionalSpeedTiers: FAST_SPEED_TIER,
      priority: -1,
      visibility: "list",
    },
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
      modelMessages: OPENAI_PERSONALITY_MESSAGES,
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
      modelMessages: OPENAI_PERSONALITY_MESSAGES,
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
      modelMessages: OPENAI_PERSONALITY_MESSAGES,
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
      modelMessages: OPENAI_PERSONALITY_MESSAGES,
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
      modelMessages: OPENAI_PERSONALITY_MESSAGES,
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
    {
      provider: "grok",
      model: "grok-4.5",
      displayName: "Grok 4.5",
      contextWindow: 500_000,
      maxContextWindow: 500_000,
      inputModalities: TEXT_IMAGE_MODALITIES,
      supportsToolUse: true,
      supportsParallelToolCalls: true,
      supportsStructuredOutput: true,
      supportsSearchTool: true,
      supportsVerbosity: false,
      webSearchToolType: "none",
      supportsReasoningSummaries: false,
      defaultReasoningSummary: "none",
      supportedReasoningLevels: GROK_REASONING_LEVELS,
      defaultReasoningLevel: "high",
      additionalSpeedTiers: NO_ADDITIONAL_SPEED_TIERS,
      priority: 30,
      visibility: "list",
    },
    {
      // Served ONLY through ACP (the Grok Build CLI, `grok agent stdio`) per
      // xAI — the factory routes composer models to GrokAcpProvider, never
      // to the direct inference endpoints. No agenc tool use: the CLI runs
      // its own loop and agenc keeps workspace authority.
      provider: "grok",
      model: "grok-composer-2.5-fast",
      displayName: "Grok Composer 2.5 fast",
      contextWindow: 200_000,
      maxContextWindow: 200_000,
      inputModalities: TEXT_IMAGE_MODALITIES,
      supportsToolUse: false,
      supportsParallelToolCalls: false,
      supportsStructuredOutput: false,
      supportsSearchTool: false,
      supportsVerbosity: false,
      webSearchToolType: "none",
      supportsReasoningSummaries: false,
      defaultReasoningSummary: "none",
      supportedReasoningLevels: NO_REASONING_LEVELS,
      additionalSpeedTiers: NO_ADDITIONAL_SPEED_TIERS,
      // Sorts after the direct-inference grok family: it is a specialty
      // ACP-only route, not a general chat pick.
      priority: 36,
      visibility: "list",
    },
    {
      // New model — added as a single registry entry. Sorts first within the
      // pre-4.5 grok family entries.
      provider: "grok",
      model: "grok-build-0.1",
      displayName: "Grok Build 0.1",
      contextWindow: 1_000_000,
      maxContextWindow: 1_000_000,
      inputModalities: TEXT_IMAGE_MODALITIES,
      supportsToolUse: true,
      supportsParallelToolCalls: true,
      supportsStructuredOutput: true,
      supportsSearchTool: false,
      supportsVerbosity: false,
      webSearchToolType: "none",
      supportsReasoningSummaries: false,
      defaultReasoningSummary: "none",
      supportedReasoningLevels: NO_REASONING_LEVELS,
      additionalSpeedTiers: NO_ADDITIONAL_SPEED_TIERS,
      priority: 31,
      visibility: "list",
    },
    {
      provider: "grok",
      model: "grok-4.3",
      displayName: "grok-4.3",
      // Live grok adapter path (_deps/context-window.ts) uses 1_000_000 for
      // grok-4.3. Match that so context-window is consistent everywhere.
      contextWindow: 1_000_000,
      maxContextWindow: 1_000_000,
      // Capability flags below mirror the existing grok capability functions
      // (resolveGrokImageHistory / supportsXaiStructuredOutputs /
      // supportsGrokServerSideTools) so migrated models behave identically.
      inputModalities: TEXT_IMAGE_MODALITIES,
      supportsToolUse: true,
      supportsParallelToolCalls: true,
      supportsStructuredOutput: true,
      supportsSearchTool: true,
      supportsVerbosity: false,
      webSearchToolType: "none",
      supportsReasoningSummaries: false,
      defaultReasoningSummary: "none",
      supportedReasoningLevels: GROK_REASONING_LEVELS,
      defaultReasoningLevel: "low",
      additionalSpeedTiers: NO_ADDITIONAL_SPEED_TIERS,
      priority: 32,
      visibility: "list",
    },
    {
      provider: "grok",
      model: "grok-4.20-0309-reasoning",
      displayName: "grok-4.20-0309-reasoning",
      contextWindow: 2_000_000,
      maxContextWindow: 2_000_000,
      inputModalities: TEXT_IMAGE_MODALITIES,
      supportsToolUse: true,
      supportsParallelToolCalls: true,
      supportsStructuredOutput: true,
      supportsSearchTool: true,
      supportsVerbosity: false,
      webSearchToolType: "none",
      supportsReasoningSummaries: false,
      defaultReasoningSummary: "none",
      supportedReasoningLevels: NO_REASONING_LEVELS,
      additionalSpeedTiers: NO_ADDITIONAL_SPEED_TIERS,
      priority: 33,
      visibility: "list",
    },
    {
      provider: "grok",
      model: "grok-4.20-0309-non-reasoning",
      displayName: "grok-4.20-0309-non-reasoning",
      contextWindow: 2_000_000,
      maxContextWindow: 2_000_000,
      inputModalities: TEXT_IMAGE_MODALITIES,
      supportsToolUse: true,
      supportsParallelToolCalls: true,
      supportsStructuredOutput: true,
      supportsSearchTool: true,
      supportsVerbosity: false,
      webSearchToolType: "none",
      supportsReasoningSummaries: false,
      defaultReasoningSummary: "none",
      supportedReasoningLevels: NO_REASONING_LEVELS,
      additionalSpeedTiers: NO_ADDITIONAL_SPEED_TIERS,
      priority: 34,
      visibility: "list",
    },
    {
      // reasoning_effort controls agent count (4 vs 16), not reasoning depth.
      // xAI multi-agent does NOT support client-side function calling — only
      // built-in server tools + remote MCP. supportsToolUse is false so the
      // UI/catalog do not advertise AgenC LIVE tools for this model.
      provider: "grok",
      model: "grok-4.20-multi-agent-0309",
      displayName: "grok-4.20-multi-agent-0309",
      contextWindow: 2_000_000,
      maxContextWindow: 2_000_000,
      inputModalities: TEXT_IMAGE_MODALITIES,
      supportsToolUse: false,
      supportsParallelToolCalls: false,
      supportsStructuredOutput: true,
      supportsSearchTool: true,
      supportsVerbosity: false,
      webSearchToolType: "none",
      supportsReasoningSummaries: false,
      defaultReasoningSummary: "none",
      supportedReasoningLevels: GROK_MULTI_AGENT_REASONING_LEVELS,
      additionalSpeedTiers: NO_ADDITIONAL_SPEED_TIERS,
      priority: 35,
      visibility: "list",
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

/**
 * Groups REGISTERED_MODEL_CATALOG entries by provider into the flat
 * `{ provider: string[] }` shape consumed by BUILT_IN_PROVIDER_MODEL_CATALOG
 * and the model-registry catalog. Entries with `visibility: "none"` are
 * omitted (they should not appear in any catalog listing). `visibility: "hide"`
 * entries are KEPT here so they remain resolvable (e.g. `/model <hidden>` and
 * default-model resolution still work). They are NOT user-selectable: each
 * picker is responsible for excluding "hide" models from its offered options
 * (see `providerRows` in commands/model-menu.tsx and the visibility filters in
 * models-manager.ts / utils/model/modelOptions.ts). Order within a provider
 * follows ascending `priority`.
 *
 * This makes REGISTERED_MODEL_CATALOG the single source of truth: adding one
 * entry here surfaces the model in every flat-catalog consumer.
 */
export function deriveFlatCatalog(): Readonly<Record<string, readonly string[]>> {
  const byProvider = new Map<string, RegisteredModelCatalogEntry[]>();
  for (const entry of REGISTERED_MODEL_CATALOG) {
    if (entry.visibility === "none") continue;
    const key = normalizeProvider(entry.provider);
    const list = byProvider.get(key);
    if (list) {
      list.push(entry);
    } else {
      byProvider.set(key, [entry]);
    }
  }
  const result: Record<string, readonly string[]> = {};
  for (const [provider, entries] of byProvider) {
    const ordered = [...entries].sort(
      (left, right) => left.priority - right.priority,
    );
    result[provider] = Object.freeze(ordered.map((entry) => entry.model));
  }
  return Object.freeze(result);
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
    .filter((entry) => {
      const entryId = normalizeId(entry.model);
      return (
        normalized === entryId ||
        (normalized.startsWith(entryId) &&
          /[-.:/]/.test(normalized.charAt(entryId.length)))
      );
    })
    .sort((left, right) => right.model.length - left.model.length)[0];
}

function normalizeProvider(provider: string | undefined): string {
  const normalized = normalizeId(provider ?? "");
  return normalized === "xai" ? "grok" : normalized;
}

function normalizeId(value: string): string {
  return value.trim().toLowerCase();
}
