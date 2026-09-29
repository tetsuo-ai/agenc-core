/** Current canonical tool models verified against OpenAI model pages, 2026-09-29.
 * Each row's source is https://developers.openai.com/api/docs/models/<model>.
 * Dated snapshots and retired ChatGPT/Codex aliases are not picker duplicates.
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
  { model: "gpt-5-pro", context: 400_000, output: 272_000, efforts: ["high"], defaultEffort: "high", search: true, verbosity: true },
  { model: "gpt-5-mini", context: 400_000, output: 128_000, efforts: GPT5, defaultEffort: "medium", search: true, verbosity: true },
  { model: "gpt-5-nano", context: 400_000, output: 128_000, efforts: GPT5, defaultEffort: "medium", search: true, verbosity: true },
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
  { model: "o3-pro", context: 200_000, output: 100_000, search: true },
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
export function openAiModelRequiresBufferedResponse(model: string): boolean {
  return matchesModel(model, ["o1-pro", "o3-pro"]);
}
