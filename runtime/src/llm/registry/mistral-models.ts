/**
 * Mistral's distinct chat/tool deployments returned by GET /v1/models on
 * 2026-09-29. Alias groups and exact served context lengths come from that
 * endpoint. Prices: https://docs.mistral.ai/inference/pricing and
 * https://docs.mistral.ai/models/voxtral-small-25-07.
 * Output is intentionally unspecified when Mistral publishes only a shared
 * input/output context window. Leanstral says 128k without an exact integer.
 */
import type { RegisteredModelCatalogEntry } from "./model-catalog.js";

export interface MistralChatModel {
  readonly model: string;
  readonly displayName: string;
  readonly aliases: readonly string[];
  readonly contextWindow: number;
  readonly maxOutputTokens?: number;
  readonly vision: boolean;
  readonly audio?: boolean;
  readonly adjustableReasoning?: boolean;
  /** Standard text rates per million tokens, including cached input. */
  readonly rates: readonly [input: number, output: number, cached?: number];
  readonly free?: boolean;
}

export const MISTRAL_CHAT_MODELS: readonly MistralChatModel[] = Object.freeze([
  { model: "mistral-medium-latest", displayName: "Mistral Medium 3.5", aliases: ["mistral-medium", "mistral-medium-3-5", "mistral-medium-3.5", "mistral-medium-3", "mistral-medium-2604", "mistral-vibe-cli-latest", "mistral-vibe-cli-with-tools", "magistral-medium-latest"], contextWindow: 262_144, vision: true, adjustableReasoning: true, rates: [1.5, 7.5, 0.15] },
  { model: "mistral-small-latest", displayName: "Mistral Small 4", aliases: ["mistral-small-2603", "mistral-vibe-cli-fast", "magistral-small-latest"], contextWindow: 262_144, vision: true, adjustableReasoning: true, rates: [0.15, 0.6, 0.015] },
  // The live endpoint serves 256000, while the Codestral model card still says
  // 128k. Prefer deployment metadata over the older static card.
  { model: "codestral-latest", displayName: "Codestral", aliases: ["codestral-2508", "mistral-code-latest", "mistral-code-fim-latest"], contextWindow: 256_000, vision: false, rates: [0.3, 0.9, 0.03] },
  { model: "ministral-14b-latest", displayName: "Ministral 3 14B", aliases: ["ministral-14b-2512"], contextWindow: 262_144, vision: true, rates: [0.2, 0.2, 0.02] },
  { model: "ministral-8b-latest", displayName: "Ministral 3 8B", aliases: ["ministral-8b-2512"], contextWindow: 262_144, vision: true, rates: [0.15, 0.15, 0.015] },
  { model: "ministral-3b-latest", displayName: "Ministral 3 3B", aliases: ["ministral-3b-2512"], contextWindow: 131_072, vision: true, rates: [0.1, 0.1, 0.01] },
  { model: "voxtral-small-latest", displayName: "Voxtral Small", aliases: ["voxtral-small-2507"], contextWindow: 32_768, vision: false, audio: true, rates: [0.1, 0.4] },
  { model: "labs-leanstral-1-5", displayName: "Leanstral 1.5", aliases: ["labs-leanstral-1-5-1"], contextWindow: 262_144, vision: true, rates: [0, 0, 0], free: true },
]);

export function resolveMistralChatModel(model: string | undefined): MistralChatModel | undefined {
  const normalized = model?.trim().toLowerCase();
  return MISTRAL_CHAT_MODELS.find((entry) => entry.model === normalized || entry.aliases.includes(normalized ?? ""));
}

export const MISTRAL_MODEL_CATALOG: readonly RegisteredModelCatalogEntry[] = Object.freeze(
  MISTRAL_CHAT_MODELS.map((entry, priority) => Object.freeze({
    provider: "mistral", model: entry.model, displayName: entry.displayName,
    contextWindow: entry.contextWindow, maxContextWindow: entry.contextWindow,
    ...(entry.maxOutputTokens === undefined ? {} : {maxOutputTokens: entry.maxOutputTokens}),
    // The Core message envelope currently has no audio part, so Voxtral's
    // audio API remains outside the exposed chat capability surface.
    inputModalities: entry.vision ? ["text", "image"] as const : ["text"] as const,
    supportsToolUse: true, supportsParallelToolCalls: true,
    supportsStructuredOutput: true, supportsSearchTool: false,
    supportsVerbosity: false, webSearchToolType: "none" as const,
    supportsReasoningSummaries: false, defaultReasoningSummary: "none" as const,
    supportedReasoningLevels: entry.adjustableReasoning ? ["none", "high"] as const : [],
    ...(entry.adjustableReasoning ? {defaultReasoningLevel: "none" as const} : {}),
    additionalSpeedTiers: [], priority, visibility: "list" as const,
  })),
);
