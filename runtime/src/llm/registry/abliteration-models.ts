/**
 * abliteration.ai catalog. Limits, modalities and prices come from
 * docs.abliteration.ai (models, pricing and thinking pages) and match the
 * authenticated `GET /v1/models` list. Large Flash was checked on 2026-10-23;
 * the other rows were checked on 2026-10-22.
 * https://docs.abliteration.ai/models
 * https://docs.abliteration.ai/pricing
 * https://docs.abliteration.ai/capabilities/thinking
 *
 * With a key, discovery reads `GET /v1/models` and records its rows through
 * published-model-catalog and published-model-costs; this snapshot is the
 * offline fallback.
 */
import type { ReasoningEffort } from "../../session/turn-context.js";
import type { ModelCostEntry } from "../../session/cost.js";
import { asRecord } from "../../utils/record.js";
import type { RegisteredModelCatalogEntry } from "./model-catalog.js";

const ABLITERATION_PROVIDER_ID = "abliteration";
export const ABLITERATION_BASE_URL = "https://api.abliteration.ai/v1";
/** `ABLIT_KEY` is the name the provider documents; the Hermes and Codex guides use the long one. */
export const ABLITERATION_API_KEY_ENV_VARS = Object.freeze(["ABLIT_KEY", "ABLITERATION_API_KEY"] as const);
export const ABLITERATION_BASE_URL_ENV_VARS = Object.freeze(["ABLITERATION_BASE_URL"] as const);
/** The provider's default large model, which its OpenCode guide picks for coding. */
export const ABLITERATION_DEFAULT_MODEL = "abliterated-model-large-v2";

/**
 * AgenC's output reservation for one call. Reasoning and the answer share
 * `max_tokens`. The documented maximum stays available to an explicit setting
 * and to max-output recovery.
 */
const OUTPUT_RESERVATION_TOKENS = 65_536;

export interface AbliterationModel {
  readonly model: string;
  readonly displayName: string;
  readonly contextWindow?: number;
  /** The largest completion the model returns, reachable only with a small prompt. */
  readonly maxOutputTokens?: number;
  readonly vision: boolean;
  readonly thinking: boolean;
  /** The reasoning modes the model runs. AgenC sends no other level. */
  readonly reasoningLevels: readonly ReasoningEffort[];
  /** The mode a session runs without a choice of its own. */
  readonly defaultReasoningLevel?: ReasoningEffort;
  readonly cost?: ModelCostEntry;
}

function rates(input: number, cachedInput: number, output: number): ModelCostEntry {
  // Published per million tokens. Core accounts per thousand. Cache reads are
  // part of prompt_tokens on Chat Completions, as on OpenAI's API.
  return Object.freeze({
    inputUsdPer1K: input / 1000,
    outputUsdPer1K: output / 1000,
    cachedInputUsdPer1K: cachedInput / 1000,
    cachedInputIncludedInInputTokens: true,
  });
}

/**
 * Chat Completions takes the whole `reasoning_effort` ladder on every model and
 * maps it to the modes the model runs. AgenC offers those modes only:
 * - abliterated-model: every level is distinct, and `none` turns reasoning off.
 *   With no level the model reasons at its native depth, so none is sent.
 * - abliterated-model-large-v2: three modes. none, minimal and low run low;
 *   medium and high run high; xhigh and max run max. It cannot turn reasoning
 *   off. The provider runs max when no level is sent; AgenC sends high (see
 *   docs/reference/providers.md).
 * - abliterated-model-large: two modes. minimal through high run high; xhigh
 *   and max run max. The provider's default is high.
 * - abliterated-model-large-flash: none turns reasoning off; low, high and
 *   max are distinct modes. The provider's default is high.
 */
export const ABLITERATION_MODELS: readonly AbliterationModel[] = Object.freeze([
  Object.freeze({
    model: "abliterated-model-large-v2",
    displayName: "Abliterated Large v2",
    contextWindow: 1_000_000,
    maxOutputTokens: 999_990,
    vision: false,
    thinking: true,
    reasoningLevels: Object.freeze(["low", "high", "max"] as const),
    defaultReasoningLevel: "high",
    cost: rates(3, 0.3, 5),
  }),
  Object.freeze({
    model: "abliterated-model",
    displayName: "Abliterated Model",
    contextWindow: 262_144,
    maxOutputTokens: 262_134,
    vision: true,
    thinking: true,
    reasoningLevels: Object.freeze(["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const),
    cost: rates(1, 0.1, 3),
  }),
  Object.freeze({
    model: "abliterated-model-large",
    displayName: "Abliterated Large",
    contextWindow: 1_000_000,
    maxOutputTokens: 999_990,
    vision: false,
    thinking: true,
    reasoningLevels: Object.freeze(["high", "max"] as const),
    defaultReasoningLevel: "high",
    cost: rates(3, 0.3, 5),
  }),
  Object.freeze({
    model: "abliterated-model-large-flash",
    displayName: "Abliterated Large Flash",
    contextWindow: 1_048_576,
    maxOutputTokens: 262_144,
    vision: true,
    thinking: true,
    reasoningLevels: Object.freeze(["none", "low", "high", "max"] as const),
    defaultReasoningLevel: "high",
    cost: rates(1, 0.1, 2),
  }),
]);

function abliterationModel(model: string | undefined): AbliterationModel | undefined {
  const id = model?.trim().toLowerCase();
  return ABLITERATION_MODELS.find(entry => entry.model === id);
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function strings(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;
}

/** `pricing` holds USD per token as decimal strings. Core accounts per thousand. */
function perThousand(value: unknown): number | undefined {
  const usd = typeof value === "string" && value.trim().length > 0 ? Number(value) : Number.NaN;
  return Number.isFinite(usd) && usd >= 0 ? Number((usd * 1000).toPrecision(12)) : undefined;
}

function publishedCost(pricing: Record<string, unknown> | null): ModelCostEntry | undefined {
  const inputUsdPer1K = perThousand(pricing?.prompt);
  const outputUsdPer1K = perThousand(pricing?.completion);
  if (inputUsdPer1K === undefined || outputUsdPer1K === undefined) return undefined;
  const cachedInputUsdPer1K = perThousand(pricing?.input_cache_read);
  return Object.freeze({
    inputUsdPer1K,
    outputUsdPer1K,
    ...(cachedInputUsdPer1K === undefined ? {} : { cachedInputUsdPer1K, cachedInputIncludedInInputTokens: true }),
  });
}

/**
 * Models from `GET /v1/models` an AgenC session can use: available to the
 * key's project, not locked, ready, text out, and listing `tools` among their
 * features (a session depends on tool calls). A bundled model keeps its
 * reasoning modes and default; the provider does not publish levels, so a
 * model only the live list has gets no effort control. Limits, modalities,
 * reasoning and prices are the listed ones. The default model leads.
 */
export function parseAbliterationModels(payload: unknown): readonly AbliterationModel[] {
  const data = asRecord(payload)?.data;
  if (!Array.isArray(data)) return [];
  const models = new Map<string, AbliterationModel>();
  for (const value of data) {
    const row = asRecord(value);
    const id = typeof row?.id === "string" ? row.id.trim() : "";
    const access = asRecord(row?.access);
    if (!row || id.length === 0 || access?.available !== true || access.locked === true || row.is_ready !== true) continue;
    const output = strings(row.output_modalities);
    if (output !== undefined && !output.includes("text")) continue;
    const features = strings(row.supported_features);
    if (features !== undefined && !features.includes("tools")) continue;
    const known = abliterationModel(id);
    const input = strings(row.input_modalities);
    const thinking = features?.includes("reasoning") ?? known?.thinking ?? false;
    const contextWindow = positiveInteger(row.context_length) ?? known?.contextWindow;
    const maxOutputTokens = positiveInteger(row.max_output_length) ?? known?.maxOutputTokens;
    const displayName = typeof row.display_name === "string" && row.display_name.trim().length > 0
      ? row.display_name.trim()
      : typeof row.name === "string" && row.name.trim().length > 0 ? row.name.trim() : known?.displayName ?? id;
    const cost = publishedCost(asRecord(row.pricing)) ?? known?.cost;
    const reasoningLevels = thinking ? known?.reasoningLevels ?? Object.freeze([]) : Object.freeze([]);
    models.set(id, Object.freeze({
      model: id,
      displayName,
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
      vision: input?.includes("image") ?? known?.vision ?? false,
      thinking,
      reasoningLevels,
      ...(thinking && known?.defaultReasoningLevel !== undefined ? { defaultReasoningLevel: known.defaultReasoningLevel } : {}),
      ...(cost === undefined ? {} : { cost }),
    }));
  }
  const rank = (model: string) => {
    const index = ABLITERATION_MODELS.findIndex(entry => entry.model === model);
    return index < 0 ? ABLITERATION_MODELS.length : index;
  };
  return Object.freeze([...models.values()].sort((a, b) => rank(a.model) - rank(b.model)));
}

/** Each listed model's published price, keyed by model ID (see published-model-costs). */
export function abliterationModelCosts(models: readonly AbliterationModel[]): ReadonlyMap<string, ModelCostEntry> {
  return new Map(models.flatMap(model => model.cost === undefined ? [] : [[model.model, model.cost] as const]));
}

const TEXT_IMAGE: readonly ("text" | "image")[] = Object.freeze(["text", "image"]);
const TEXT_ONLY: readonly ("text" | "image")[] = Object.freeze(["text"]);

/** One abliteration.ai model as a registered catalog entry (bundled or published). */
export function abliterationCatalogEntry(entry: AbliterationModel, priority: number): RegisteredModelCatalogEntry {
  return Object.freeze({
    provider: ABLITERATION_PROVIDER_ID,
    model: entry.model,
    displayName: entry.displayName,
    ...(entry.contextWindow === undefined ? {} : { contextWindow: entry.contextWindow, maxContextWindow: entry.contextWindow }),
    maxOutputTokens: entry.maxOutputTokens === undefined
      ? OUTPUT_RESERVATION_TOKENS
      : Math.min(OUTPUT_RESERVATION_TOKENS, entry.maxOutputTokens),
    ...(entry.maxOutputTokens === undefined ? {} : { maxOutputTokensUpperLimit: entry.maxOutputTokens }),
    maxOutputTokensCappedDefault: true,
    inputModalities: entry.vision ? TEXT_IMAGE : TEXT_ONLY,
    supportsToolUse: true,
    supportsThinking: entry.thinking,
    supportsParallelToolCalls: true,
    // The models page lists JSON Schema output, the FAQ says response_format is
    // ignored. Core does not request it until a live check settles that.
    supportsStructuredOutput: false,
    supportsStructuredOutputWithTools: false,
    supportsSearchTool: false,
    supportsVerbosity: false,
    webSearchToolType: "none",
    supportsReasoningSummaries: false,
    defaultReasoningSummary: "none",
    supportedReasoningLevels: entry.reasoningLevels,
    ...(entry.defaultReasoningLevel === undefined ? {} : { defaultReasoningLevel: entry.defaultReasoningLevel }),
    additionalSpeedTiers: Object.freeze([]),
    priority,
    visibility: "list",
  });
}
