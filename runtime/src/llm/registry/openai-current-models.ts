/** Current canonical tool models verified against OpenAI model pages, 2026-09-29
 * (o3 2026-11-20).
 * Each row's source is https://developers.openai.com/api/docs/models/<model>.
 * Dated snapshots and retired ChatGPT/Codex aliases are not picker duplicates.
 * Shutdown dates come from https://developers.openai.com/api/docs/deprecations
 * (read 2026-11-20).
 */
import type { RegisteredModelCatalogEntry } from "./model-catalog.js";
import type { ReasoningEffort } from "../../session/turn-context.js";

interface OpenAiCurrentModel {
  readonly model: string;
  readonly context: number;
  readonly output: number;
  readonly vision?: boolean;
  readonly structured?: boolean;
  readonly efforts?: readonly ReasoningEffort[];
  readonly defaultEffort?: ReasoningEffort;
  readonly search?: boolean;
  readonly verbosity?: boolean;
  /** OpenAI's shutdown date (developers.openai.com/api/docs/deprecations). */
  readonly retiresOn?: string;
}
const STANDARD = ["low", "medium", "high"] as const;
const GPT5 = ["minimal", ...STANDARD] as const;
const GPT51 = ["none", ...STANDARD] as const;
const GPT54 = [...GPT51, "xhigh"] as const;
const PRO = ["medium", "high", "xhigh"] as const;

const MODELS: readonly OpenAiCurrentModel[] = [
  { model: "gpt-5.5-pro", context: 1_050_000, output: 128_000, efforts: PRO, defaultEffort: "high", search: true, verbosity: true },
  { model: "gpt-5.4-pro", context: 1_050_000, output: 128_000, efforts: PRO, defaultEffort: "medium", structured: false, search: true, verbosity: true },
  { model: "gpt-5.4-nano", context: 400_000, output: 128_000, efforts: GPT54, defaultEffort: "none", search: true, verbosity: true },
  { model: "gpt-5.2-pro", context: 400_000, output: 128_000, efforts: PRO, structured: false, search: true, verbosity: true },
  { model: "gpt-5.1", context: 400_000, output: 128_000, efforts: GPT51, defaultEffort: "none", search: true, verbosity: true },
  // OpenAI shuts gpt-5-pro, gpt-5-mini and gpt-5-nano down on 2026-12-11
  // (replacements gpt-6.1-sol in pro mode, gpt-6.1-terra and gpt-6-luna).
  { model: "gpt-5-pro", context: 400_000, output: 272_000, efforts: ["high"], defaultEffort: "high", search: true, verbosity: true, retiresOn: "2026-12-11" },
  { model: "gpt-5-mini", context: 400_000, output: 128_000, efforts: GPT5, defaultEffort: "medium", search: true, verbosity: true, retiresOn: "2026-12-11" },
  { model: "gpt-5-nano", context: 400_000, output: 128_000, efforts: GPT5, defaultEffort: "medium", search: true, verbosity: true, retiresOn: "2026-12-11" },
  { model: "gpt-4.1", context: 1_047_576, output: 32_768, search: true },
  { model: "gpt-4.1-mini", context: 1_047_576, output: 32_768, search: true },
  { model: "gpt-4.1-nano", context: 1_047_576, output: 32_768 },
  { model: "gpt-4o", context: 128_000, output: 16_384, search: true },
  { model: "gpt-4o-mini", context: 128_000, output: 16_384, search: true },
  { model: "gpt-4-turbo", context: 128_000, output: 4_096, structured: false },
  { model: "o1", context: 200_000, output: 100_000, efforts: STANDARD, defaultEffort: "medium" },
  // Pro o-series pages verify reasoning but publish no effort enum. Leave
  // the dial unset instead of borrowing a sibling's unsupported settings.
  { model: "o1-pro", context: 200_000, output: 100_000 },
  // /api/docs/models/o3 (2026-11-20): 200,000 context, 100,000 output, text
  // and image in, function calling, structured outputs, reasoning tokens.
  // Deprecated: OpenAI shuts it down on 2026-12-11 (replacement gpt-6.1-sol).
  { model: "o3", context: 200_000, output: 100_000, efforts: STANDARD, defaultEffort: "medium", retiresOn: "2026-12-11" },
  // Shuts down on 2026-12-11 too (replacement gpt-6.1-sol in pro mode).
  { model: "o3-pro", context: 200_000, output: 100_000, search: true, retiresOn: "2026-12-11" },
  { model: "o3-mini", context: 200_000, output: 100_000, vision: false, efforts: STANDARD, defaultEffort: "medium" },
  { model: "o4-mini", context: 200_000, output: 100_000, efforts: STANDARD, defaultEffort: "medium", search: true },
  { model: "chat-latest", context: 400_000, output: 128_000, search: true },
];

export const OPENAI_CURRENT_MODEL_CATALOG: readonly RegisteredModelCatalogEntry[] =
  Object.freeze(MODELS.map((entry, index) => Object.freeze({
    provider: "openai",
    model: entry.model,
    displayName: entry.model,
    contextWindow: entry.context,
    maxContextWindow: entry.context,
    maxOutputTokens: entry.output,
    maxOutputTokensUpperLimit: entry.output,
    inputModalities: entry.vision === false ? ["text"] as const : ["text", "image"] as const,
    supportsToolUse: true,
    // Serial invocation is the conservative contract for older families.
    supportsParallelToolCalls: false,
    supportsStructuredOutput: entry.structured !== false,
    supportsSearchTool: entry.search === true,
    supportsVerbosity: entry.verbosity === true,
    webSearchToolType: entry.search ? "text" as const : "none" as const,
    supportsReasoningSummaries: Boolean(entry.efforts?.length),
    defaultReasoningSummary: "none" as const,
    supportedReasoningLevels: entry.efforts ?? [],
    ...(entry.defaultEffort ? { defaultReasoningLevel: entry.defaultEffort } : {}),
    additionalSpeedTiers: [],
    priority: 100 + index,
    visibility: "list" as const,
    ...(entry.retiresOn ? { retiresOn: entry.retiresOn } : {}),
  })));

/**
 * The dated snapshots OpenAI shuts down with their models on 2026-12-11. They
 * are date-only rows (model-catalog.ts, RETIREMENT_ONLY_MODEL_CATALOG): the
 * exact-id retirement lookup finds them, no list or capability lookup does,
 * so a snapshot keeps borrowing its model's contract until the date.
 */
const SHUT_DOWN_SNAPSHOTS: readonly (readonly [string, string])[] = [
  ["gpt-5-2025-08-07", "2026-12-11"],
  ["gpt-5-mini-2025-08-07", "2026-12-11"],
  ["gpt-5-nano-2025-08-07", "2026-12-11"],
  ["gpt-5-pro-2025-10-06", "2026-12-11"],
  ["o3-2025-04-16", "2026-12-11"],
  ["o3-pro-2025-06-10", "2026-12-11"],
];

export const OPENAI_SHUT_DOWN_SNAPSHOT_CATALOG: readonly RegisteredModelCatalogEntry[] =
  Object.freeze(SHUT_DOWN_SNAPSHOTS.map(([model, retiresOn], index) => Object.freeze({
    provider: "openai",
    model,
    displayName: model,
    inputModalities: ["text", "image"] as const,
    supportsToolUse: true,
    supportsParallelToolCalls: false,
    supportsStructuredOutput: false,
    supportsSearchTool: false,
    supportsVerbosity: false,
    webSearchToolType: "none" as const,
    supportsReasoningSummaries: false,
    defaultReasoningSummary: "none" as const,
    supportedReasoningLevels: [],
    additionalSpeedTiers: [],
    priority: 400 + index,
    visibility: "none" as const,
    retiresOn,
  })));

const RESPONSES_ONLY = ["gpt-5-pro", "gpt-5.2-pro", "gpt-5.4-pro", "gpt-5.5-pro", "o1-pro", "o3-pro"];
function matchesModel(model: string, ids: readonly string[]): boolean {
  const normalized = model.trim().toLowerCase().replace(/^openai[/:]/u, "");
  return ids.some((id) => normalized === id ||
    (normalized.startsWith(`${id}-`) && /^\d{4}-\d{2}-\d{2}$/u.test(normalized.slice(id.length + 1))));
}
export function openAiModelRequiresResponses(model: string): boolean {
  return matchesModel(model, RESPONSES_ONLY);
}
/** The id itself or one of its dated snapshots (`o3-2025-04-16`), never another variant. */
export function openAiModelIsSnapshotOf(model: string, id: string): boolean {
  return matchesModel(model, [id]);
}
export function openAiModelRequiresBufferedResponse(model: string): boolean {
  return matchesModel(model, ["o1-pro", "o3-pro"]);
}
