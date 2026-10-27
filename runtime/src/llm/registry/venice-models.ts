import snapshot from "./venice-models.data.json" with { type: "json" };
import type { ReasoningEffort } from "../../session/turn-context.js";
import type { ModelCostEntry } from "../../session/cost.js";
import { asRecord } from "../../utils/record.js";
import type { RegisteredModelCatalogEntry } from "./model-catalog.js";

export interface VeniceModel {
  readonly model: string;
  readonly displayName: string;
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
  readonly supportsToolUse: boolean;
  readonly supportsReasoning: boolean;
  readonly supportsVision: boolean;
  readonly supportsStructuredOutput: boolean;
  readonly supportedReasoningLevels: readonly ReasoningEffort[];
  readonly defaultReasoningLevel?: ReasoningEffort;
  readonly functionCallingDefault: boolean;
  readonly privacy?: "private" | "anonymized";
  /** Anonymous routing alone makes no retention guarantee. */
  readonly zeroDataRetention?: true;
  readonly cost?: ModelCostEntry;
  /** Venice's announced removal date (`model_spec.deprecation`), YYYY-MM-DD. */
  readonly retiresOn?: string;
}
const EFFORTS: readonly string[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
function price(value: unknown): number | undefined {
  const usd = asRecord(value)?.usd;
  // Venice publishes USD per million tokens. Core accounts per thousand.
  return typeof usd === "number" && Number.isFinite(usd) && usd >= 0 ? usd / 1000 : undefined;
}

/**
 * One model's published price (`model_spec.pricing`). `extended` holds the
 * rates for a request above `context_token_threshold` input tokens. The
 * `cache_write` price is not used: AgenC asks Venice for no prompt caching and
 * Chat Completions cannot report cache writes, so pricing them would charge
 * every uncached input token at the write rate.
 */
function veniceCost(pricing: Record<string, unknown> | null | undefined): ModelCostEntry | undefined {
  const inputUsdPer1K = price(pricing?.input);
  const outputUsdPer1K = price(pricing?.output);
  if (inputUsdPer1K === undefined || outputUsdPer1K === undefined) return undefined;
  const cachedInputUsdPer1K = price(pricing?.cache_input);
  const extended = asRecord(pricing?.extended);
  const aboveInputTokens = positiveInteger(extended?.context_token_threshold);
  const longContextRates = aboveInputTokens === undefined ? undefined : veniceCost(extended);
  return Object.freeze({
    inputUsdPer1K,
    outputUsdPer1K,
    ...(cachedInputUsdPer1K === undefined ? {} : { cachedInputUsdPer1K, cachedInputIncludedInInputTokens: true }),
    ...(aboveInputTokens === undefined || longContextRates === undefined ? {} : {
      longContext: Object.freeze({ aboveInputTokens, rates: longContextRates }),
    }),
  });
}

/**
 * Text models Venice lists with function calling whose tool calls never
 * arrived as tool calls when probed (jobs/pv probes/venice-sweep and its
 * retest, 2026-10-20, three tries each). They are left out like the models
 * Venice lists without function calling, since an AgenC session depends on
 * tool calls:
 * - venice-uncensored-role-play answers "I will call the tool" and never does
 *   (it also rejects images although its row says supportsVision);
 * - qwen3-6-35b-a3b returns its call as `<tool_call>` text in the content;
 * - aion-labs-aion-3-5-mini made no tool call in three tries;
 * - e2ee-qwen3-vl-30b-a3b-p is answered 400 ("auto" tool choice is not
 *   enabled upstream) whenever tools are sent.
 */
export const VENICE_TOOL_CALLS_NOT_DELIVERED: ReadonlySet<string> = new Set([
  "venice-uncensored-role-play",
  "qwen3-6-35b-a3b",
  "aion-labs-aion-3-5-mini",
  "e2ee-qwen3-vl-30b-a3b-p",
]);

/** Parse only online text models explicitly advertising function calling. */
export function parseVeniceModels(payload: unknown): readonly VeniceModel[] {
  const data = asRecord(payload)?.data;
  if (!Array.isArray(data)) return [];
  const models = new Map<string, VeniceModel>();
  for (const value of data) {
    const row = asRecord(value);
    const spec = asRecord(row?.model_spec);
    const caps = asRecord(spec?.capabilities);
    if (row?.type !== "text" || typeof row.id !== "string" || !row.id.trim() ||
        !spec || spec.offline === true || caps?.supportsFunctionCalling !== true ||
        VENICE_TOOL_CALLS_NOT_DELIVERED.has(row.id)) continue;
    const supportedReasoningLevels = caps.supportsReasoning === true && caps.supportsReasoningEffort === true && Array.isArray(caps.reasoningEffortOptions)
      ? caps.reasoningEffortOptions.filter((value): value is ReasoningEffort => typeof value === "string" && EFFORTS.includes(value))
      : [];
    const defaultReasoningLevel = supportedReasoningLevels.find(value => value === caps.defaultReasoningEffort);
    const cost = veniceCost(asRecord(spec.pricing));
    const privacy = spec.privacy === "private" || spec.privacy === "anonymized" ? spec.privacy : undefined;
    const deprecation = asRecord(spec.deprecation);
    const removal = typeof deprecation?.removesAt === "string" ? deprecation.removesAt
      : typeof deprecation?.date === "string" ? deprecation.date : undefined;
    const retiresOn = removal !== undefined && /^\d{4}-\d{2}-\d{2}/.test(removal) ? removal.slice(0, 10) : undefined;
    models.set(row.id, Object.freeze({
      model: row.id,
      displayName: typeof spec.name === "string" ? spec.name : row.id,
      contextWindow: positiveInteger(spec.availableContextTokens),
      maxOutputTokens: positiveInteger(spec.maxCompletionTokens),
      supportsToolUse: true,
      supportsReasoning: caps.supportsReasoning === true,
      supportsVision: caps.supportsVision === true,
      supportsStructuredOutput: caps.supportsResponseSchema === true,
      supportedReasoningLevels: Object.freeze(supportedReasoningLevels),
      ...(defaultReasoningLevel === undefined ? {} : { defaultReasoningLevel }),
      functionCallingDefault: Array.isArray(spec.traits) && spec.traits.includes("function_calling_default"),
      ...(privacy === undefined ? {} : { privacy }),
      ...(privacy === "private" ? { zeroDataRetention: true as const } : {}),
      ...(cost === undefined ? {} : { cost }),
      ...(retiresOn === undefined ? {} : { retiresOn }),
    }));
  }
  // Put Venice's function-calling default first in selection menus.
  return Object.freeze([...models.values()].sort((a, b) => Number(b.functionCallingDefault) - Number(a.functionCallingDefault)));
}

/** Each listed model's published price, keyed by model ID (see published-model-costs). */
export function veniceModelCosts(models: readonly VeniceModel[]): ReadonlyMap<string, ModelCostEntry> {
  return new Map(models.flatMap(model => model.cost === undefined ? [] : [[model.model, model.cost] as const]));
}

/** Small offline snapshot from the public /models response on 2026-10-15. */
export const VENICE_MODELS = parseVeniceModels(snapshot);
export function veniceDefaultModel(models: readonly VeniceModel[]): string | undefined {
  return models.find(model => model.functionCallingDefault)?.model;
}

const TEXT_IMAGE: readonly ("text" | "image")[] = Object.freeze(["text", "image"]);
const TEXT_ONLY: readonly ("text" | "image")[] = Object.freeze(["text"]);

/** One Venice text model as a registered catalog entry (bundled or published). */
export function veniceCatalogEntry(entry: VeniceModel, priority: number): RegisteredModelCatalogEntry {
  return Object.freeze({
    provider: "venice",
    model: entry.model,
    displayName: entry.displayName,
    ...(entry.contextWindow === undefined ? {} : { contextWindow: entry.contextWindow, maxContextWindow: entry.contextWindow }),
    ...(entry.maxOutputTokens === undefined ? {} : { maxOutputTokens: entry.maxOutputTokens }),
    inputModalities: entry.supportsVision ? TEXT_IMAGE : TEXT_ONLY,
    supportsToolUse: true,
    supportsThinking: entry.supportsReasoning,
    ...(entry.retiresOn === undefined ? {} : { retiresOn: entry.retiresOn }),
    supportsParallelToolCalls: false,
    supportsStructuredOutput: entry.supportsStructuredOutput,
    supportsSearchTool: false,
    supportsVerbosity: false,
    webSearchToolType: "none",
    supportsReasoningSummaries: false,
    defaultReasoningSummary: "none",
    supportedReasoningLevels: entry.supportedReasoningLevels,
    ...(entry.defaultReasoningLevel === undefined ? {} : { defaultReasoningLevel: entry.defaultReasoningLevel }),
    additionalSpeedTiers: Object.freeze([]),
    priority,
    visibility: "list",
  });
}
