import snapshot from "./trustedrouter-models.data.json" with { type: "json" };
import type { ReasoningEffort } from "../../session/turn-context.js";
import type { ModelCostEntry } from "../../session/cost.js";
import { asRecord } from "../../utils/record.js";
import type { RegisteredModelCatalogEntry } from "./model-catalog.js";

const TRUSTEDROUTER_PROVIDER_ID = "trustedrouter";
export const TRUSTEDROUTER_BASE_URL = "https://api.trustedrouter.com/v1";
export const TRUSTEDROUTER_API_KEY_ENV_VARS = Object.freeze([
  "TRUSTEDROUTER_API_KEY",
] as const);
export const TRUSTEDROUTER_BASE_URL_ENV_VARS = Object.freeze([
  "TRUSTEDROUTER_BASE_URL",
] as const);
export const TRUSTEDROUTER_DEFAULT_MODEL = "trustedrouter/auto";

const FEATURED_PRESET_ORDER: readonly string[] = Object.freeze([
  "trustedrouter/auto",
  "trustedrouter/zdr",
  "trustedrouter/e2e",
  "trustedrouter/fast",
  "trustedrouter/cheap",
  "trustedrouter/free",
]);

const FEATURED_ALIAS_ORDER: readonly string[] = Object.freeze([
  "nyte/auto",
  "nyte/zdr",
  "nyte/e2e",
  "nyte/fast",
  "nyte/cheap",
  "nyte/free",
]);

export interface TrustedRouterModel {
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
  readonly isDefault: boolean;
  readonly isFree?: true;
  readonly privacyTier?: number;
  readonly privacyTierLabel?: string;
  /** True only when the model's headline route enforces zero data retention. */
  readonly zeroDataRetention?: true;
  readonly confidentialCompute?: true;
  readonly e2ee?: true;
  readonly aliases: readonly string[];
  readonly aliasOf?: string;
  readonly cost?: ModelCostEntry;
}

const EFFORTS: readonly string[] = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function strings(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

/** `pricing` holds USD per token as decimal strings. Core accounts per thousand. */
function perThousand(value: unknown): number | undefined {
  const usd =
    typeof value === "string" && value.trim().length > 0
      ? Number(value)
      : typeof value === "number"
        ? value
        : Number.NaN;
  return Number.isFinite(usd) && usd >= 0
    ? Number((usd * 1000).toPrecision(12))
    : undefined;
}

function tierCost(
  tiers: readonly Record<string, unknown>[],
  index: number,
): ModelCostEntry | undefined {
  const tier = tiers[index];
  if (tier === undefined) return undefined;
  const inputUsdPer1K = perThousand(tier.prompt);
  const outputUsdPer1K = perThousand(tier.completion);
  if (inputUsdPer1K === undefined || outputUsdPer1K === undefined) return undefined;
  const cachedInputUsdPer1K = perThousand(tier.input_cache_read);
  const aboveInputTokens = positiveInteger(tier.max_prompt_tokens);
  const nextRates =
    aboveInputTokens !== undefined ? tierCost(tiers, index + 1) : undefined;
  return Object.freeze({
    inputUsdPer1K,
    outputUsdPer1K,
    ...(cachedInputUsdPer1K === undefined
      ? {}
      : { cachedInputUsdPer1K, cachedInputIncludedInInputTokens: true }),
    ...(aboveInputTokens === undefined || nextRates === undefined
      ? {}
      : {
          longContext: Object.freeze({
            aboveInputTokens,
            rates: nextRates,
          }),
        }),
  });
}

function trustedRouterCost(
  pricing: Record<string, unknown> | null | undefined,
): ModelCostEntry | undefined {
  const inputUsdPer1K = perThousand(pricing?.prompt);
  const outputUsdPer1K = perThousand(pricing?.completion);
  if (inputUsdPer1K === undefined || outputUsdPer1K === undefined) return undefined;
  const cachedInputUsdPer1K = perThousand(pricing?.input_cache_read);
  const rawTiers = Array.isArray(pricing?.tiers)
    ? pricing.tiers
        .map((entry) => asRecord(entry))
        .filter((entry): entry is Record<string, unknown> => entry !== null)
    : [];
  const firstThreshold = positiveInteger(rawTiers[0]?.max_prompt_tokens);
  const longContextRates =
    firstThreshold !== undefined && rawTiers.length >= 2
      ? tierCost(rawTiers, 1)
      : undefined;
  return Object.freeze({
    inputUsdPer1K,
    outputUsdPer1K,
    ...(cachedInputUsdPer1K === undefined
      ? {}
      : { cachedInputUsdPer1K, cachedInputIncludedInInputTokens: true }),
    ...(firstThreshold === undefined || longContextRates === undefined
      ? {}
      : {
          longContext: Object.freeze({
            aboveInputTokens: firstThreshold,
            rates: longContextRates,
          }),
        }),
  });
}

function parseEfforts(value: unknown): readonly ReasoningEffort[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<ReasoningEffort>();
  for (const item of value) {
    if (typeof item === "string" && EFFORTS.includes(item)) {
      seen.add(item as ReasoningEffort);
    }
  }
  return Object.freeze([...seen]);
}

function sortRank(entry: TrustedRouterModel, canonicalIndex: number): number {
  if (entry.aliasOf === undefined) {
    const featured = FEATURED_PRESET_ORDER.indexOf(entry.model);
    return featured >= 0 ? featured : FEATURED_PRESET_ORDER.length + canonicalIndex;
  }
  const featuredAlias = FEATURED_ALIAS_ORDER.indexOf(entry.model);
  return (
    1_000_000 +
    (featuredAlias >= 0
      ? featuredAlias
      : FEATURED_ALIAS_ORDER.length + canonicalIndex)
  );
}

/**
 * Parse TrustedRouter's `GET /v1/models` catalog, excluding internal-only,
 * hidden, synthetic-monitor, and non-chat rows, while exposing all public chat
 * models, `trustedrouter/*` routing presets, and `nyte/*` aliases.
 */
export function parseTrustedRouterModels(
  payload: unknown,
): readonly TrustedRouterModel[] {
  const data = asRecord(payload)?.data;
  if (!Array.isArray(data)) return [];
  const canonical = new Map<string, TrustedRouterModel>();
  const aliases = new Map<string, TrustedRouterModel>();

  for (const value of data) {
    const row = asRecord(value);
    const id = typeof row?.id === "string" ? row.id.trim() : "";
    if (!row || id.length === 0 || /[\s\x00-\x1f\x7f]/u.test(id)) continue;

    const tr = asRecord(row.trustedrouter);
    if (
      tr?.internal_only === true ||
      tr?.configuration_hidden === true ||
      tr?.synthetic_monitor === true ||
      tr?.supports_chat === false ||
      row.supports_chat === false
    ) {
      continue;
    }

    const caps = asRecord(tr?.capabilities);
    const arch = asRecord(row.architecture);
    const topProvider = asRecord(row.top_provider);
    const reasoning = asRecord(row.reasoning);
    const params = strings(row.supported_parameters);
    const inputModalities = strings(arch?.input_modalities);

    // `trustedrouter.capabilities.reasoning_effort` is `[]` when every route is
    // verified to reject reasoning_effort, an ordered list of verified values
    // when supported, or null/omitted when unverified (fall back to `reasoning`).
    const supportedReasoningLevels = Array.isArray(caps?.reasoning_effort)
      ? parseEfforts(caps.reasoning_effort)
      : parseEfforts(reasoning?.supported_efforts);
    const defaultReasoningLevel =
      typeof reasoning?.default_effort === "string"
        ? supportedReasoningLevels.find(
            (level) => level === reasoning.default_effort,
          )
        : undefined;
    const supportsReasoning =
      supportedReasoningLevels.length > 0 ||
      reasoning?.mandatory === true ||
      reasoning?.default_enabled === true ||
      params.some((parameter) =>
        ["reasoning", "include_reasoning", "reasoning_effort"].includes(
          parameter,
        ),
      );
    const supportsToolUse =
      caps?.tools === true || params.includes("tools");
    const supportsVision =
      caps?.vision === true || inputModalities.includes("image");
    const supportsStructuredOutput =
      params.includes("structured_outputs") ||
      params.includes("response_format");

    const contextWindow =
      positiveInteger(row.context_length) ??
      positiveInteger(topProvider?.context_length);
    const maxOutputTokens = positiveInteger(topProvider?.max_completion_tokens);
    const cost = trustedRouterCost(asRecord(row.pricing));
    const isFree =
      cost !== undefined &&
      cost.inputUsdPer1K === 0 &&
      cost.outputUsdPer1K === 0
        ? (true as const)
        : undefined;

    const privacyTier =
      typeof tr?.privacy_tier === "number" && Number.isFinite(tr.privacy_tier)
        ? tr.privacy_tier
        : undefined;
    const privacyTierLabel =
      typeof tr?.privacy_tier_label === "string" &&
      tr.privacy_tier_label.trim().length > 0
        ? tr.privacy_tier_label.trim()
        : undefined;
    const zeroDataRetention =
      tr?.provider_zero_data_retention === true &&
      (privacyTier === undefined || privacyTier >= 2)
        ? (true as const)
        : undefined;
    const confidentialCompute =
      tr?.provider_confidential_compute === true ? (true as const) : undefined;
    const e2ee = tr?.provider_e2ee === true ? (true as const) : undefined;

    const rowAliases = Object.freeze(
      strings(tr?.aliases)
        .map((alias) => alias.trim())
        .filter(
          (alias, index, all) =>
            alias.length > 0 &&
            alias !== id &&
            !/[\s\x00-\x1f\x7f]/u.test(alias) &&
            all.indexOf(alias) === index,
        ),
    );

    const displayName =
      typeof row.name === "string" && row.name.trim().length > 0
        ? row.name.trim()
        : id;

    const entry: TrustedRouterModel = Object.freeze({
      model: id,
      displayName,
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
      supportsToolUse,
      supportsReasoning,
      supportsVision,
      supportsStructuredOutput,
      supportedReasoningLevels,
      ...(defaultReasoningLevel === undefined ? {} : { defaultReasoningLevel }),
      isDefault: id === TRUSTEDROUTER_DEFAULT_MODEL,
      ...(isFree === undefined ? {} : { isFree }),
      ...(privacyTier === undefined ? {} : { privacyTier }),
      ...(privacyTierLabel === undefined ? {} : { privacyTierLabel }),
      ...(zeroDataRetention === undefined ? {} : { zeroDataRetention }),
      ...(confidentialCompute === undefined ? {} : { confidentialCompute }),
      ...(e2ee === undefined ? {} : { e2ee }),
      aliases: rowAliases,
      ...(cost === undefined ? {} : { cost }),
    });

    canonical.set(id, entry);
    for (const alias of rowAliases) {
      if (!aliases.has(alias)) {
        aliases.set(
          alias,
          Object.freeze({
            ...entry,
            model: alias,
            displayName: `${displayName} (${alias})`,
            isDefault: false,
            aliases: Object.freeze([]),
            aliasOf: id,
          }),
        );
      }
    }
  }

  const combined: TrustedRouterModel[] = [...canonical.values()];
  for (const [alias, entry] of aliases) {
    if (!canonical.has(alias)) combined.push(entry);
  }

  return Object.freeze(
    combined
      .map((entry, index) => ({ entry, rank: sortRank(entry, index) }))
      .sort((a, b) => a.rank - b.rank)
      .map((item) => item.entry),
  );
}

/** Each listed model's published price, keyed by model ID (see published-model-costs). */
export function trustedRouterModelCosts(
  models: readonly TrustedRouterModel[],
): ReadonlyMap<string, ModelCostEntry> {
  return new Map(
    models.flatMap((model) =>
      model.cost === undefined ? [] : [[model.model, model.cost] as const],
    ),
  );
}

/** Small offline snapshot from the public /v1/models response. */
export const TRUSTEDROUTER_MODELS = parseTrustedRouterModels(snapshot);

export function trustedRouterDefaultModel(
  models: readonly TrustedRouterModel[],
): string | undefined {
  return (
    models.find((model) => model.isDefault)?.model ??
    models.find((model) => model.aliasOf === undefined)?.model
  );
}

const TEXT_IMAGE: readonly ("text" | "image")[] = Object.freeze([
  "text",
  "image",
]);
const TEXT_ONLY: readonly ("text" | "image")[] = Object.freeze(["text"]);

/** One TrustedRouter model as a registered catalog entry (bundled or published). */
export function trustedRouterCatalogEntry(
  entry: TrustedRouterModel,
  priority: number,
): RegisteredModelCatalogEntry {
  return Object.freeze({
    provider: TRUSTEDROUTER_PROVIDER_ID,
    model: entry.model,
    displayName: entry.displayName,
    ...(entry.contextWindow === undefined
      ? {}
      : { contextWindow: entry.contextWindow, maxContextWindow: entry.contextWindow }),
    ...(entry.maxOutputTokens === undefined
      ? {}
      : { maxOutputTokens: entry.maxOutputTokens }),
    inputModalities: entry.supportsVision ? TEXT_IMAGE : TEXT_ONLY,
    supportsToolUse: entry.supportsToolUse,
    ...(entry.isFree === true ? { isFree: true } : {}),
    supportsThinking: entry.supportsReasoning,
    supportsParallelToolCalls: false,
    supportsStructuredOutput: entry.supportsStructuredOutput,
    supportsSearchTool: false,
    supportsVerbosity: false,
    webSearchToolType: "none",
    supportsReasoningSummaries: false,
    defaultReasoningSummary: "none",
    supportedReasoningLevels: entry.supportedReasoningLevels,
    ...(entry.defaultReasoningLevel === undefined
      ? {}
      : { defaultReasoningLevel: entry.defaultReasoningLevel }),
    additionalSpeedTiers: Object.freeze([]),
    priority,
    visibility: "list",
  });
}
