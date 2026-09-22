/** Provider-scoped effort contract shared by session validation and wire gating.
 * Registered models retain their catalog levels and defaults. Hosted NIM
 * models have separate contracts, even when the model id names another vendor.
 */
import { supportsXaiReasoningEffortParam } from "./structured-output.js";
import { isOpenAiReasoningFamilyModel } from "./registry/openai-reasoning-models.js";
import { isAgenCDeepSeekModel, AGENC_DEEPSEEK_REASONING_LEVELS } from "./registry/agenc-deepseek.js";
import { isNativeDeepSeekModel, DEEPSEEK_REASONING_LEVELS } from "./registry/deepseek-models.js";
import { anthropicEffortLevels } from "../utils/model/anthropicThinkingControl.js";
import { normalizeProviderIdentity } from "../provider-identity.js";
import {
  bedrockConverseEffortLevels,
  resolveRegisteredModelCatalogEntry,
} from "./registry/model-catalog.js";
import type { ReasoningEffort } from "../session/turn-context.js";

/**
 * NVIDIA NIM hosts big-player models whose hosted OpenAPI schemas
 * (docs.api.nvidia.com/nim/reference/<slug>-infer) document a
 * top-level `reasoning_effort` — but each family with its own enum,
 * and no endpoint-wide contract. Families absent here (kimi-k2.x,
 * minimax-m3, plain llama instructs) control thinking through
 * `chat_template_kwargs` or not at all, so the field stays stripped
 * for them. Verified against the hosted schemas 2026-08.
 */
const NIM_REASONING_EFFORT_FAMILIES: readonly {
  readonly pattern: RegExp;
  readonly values: ReadonlySet<string>;
}[] = [
  {
    // moonshotai/kimi-k3: enum low|high|max, default max.
    pattern: /(?:^|\/)kimi-k3(?:$|[-.:])/i,
    values: new Set(["low", "high", "max"]),
  },
  {
    // deepseek-ai/deepseek-v4-{pro,flash}(+dated snapshots):
    // enum none|high|max (defaults differ: pro none, flash high).
    pattern: /(?:^|\/)deepseek-v4-(?:pro|flash)(?:$|[-.:])/i,
    values: new Set(["none", "high", "max"]),
  },
  {
    // openai/gpt-oss-20b|120b on NIM: enum low|medium|high.
    pattern: /(?:^|\/)gpt-oss-\d+b(?:$|[-.:])/i,
    values: new Set(["low", "medium", "high"]),
  },
  {
    // nvidia/nemotron-3-super-*: enum none|low|high.
    pattern: /(?:^|\/)nemotron-3-super(?:$|[-.:])/i,
    values: new Set(["none", "low", "high"]),
  },
  {
    // nvidia/nemotron-3-ultra-*: enum none|medium|high.
    pattern: /(?:^|\/)nemotron-3-ultra(?:$|[-.:])/i,
    values: new Set(["none", "medium", "high"]),
  },
];

function nimReasoningEffortValues(
  model: string | undefined,
): ReadonlySet<string> | undefined {
  if (model === undefined) return undefined;
  const trimmed = model.trim();
  return NIM_REASONING_EFFORT_FAMILIES.find((family) =>
    family.pattern.test(trimmed),
  )?.values;
}

// Conservative Muse Spark fallback. Exact registered models use their catalog
// enum below; newly documented tiers must not leak into unknown model variants.
const META_REASONING_EFFORT_VALUES = new Set([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

// Qwen3.8 exposes these values on both QwenCloud billing routes. Older
// families use different thinking controls, so they stay fail-closed rather
// than inheriting a field that their endpoint may reject.
const QWEN_38_REASONING_EFFORT_VALUES = new Set([
  "low",
  "medium",
  "xhigh",
]);

const CEREBRAS_QWEN_GEMMA_REASONING_EFFORT_VALUES = new Set([
  "none",
  "low",
  "medium",
  "high",
]);
const CEREBRAS_GPT_OSS_REASONING_EFFORT_VALUES = new Set([
  "low",
  "medium",
  "high",
]);
const ZAI_GLM_53_REASONING_EFFORT_VALUES = new Set([
  "low",
  "high",
  "max",
]);
const KIMI_K3_REASONING_EFFORT_VALUES = new Set(["low", "high", "max"]);
/** The same OpenAI reasoning family that capability gating uses. */
function isUpstreamReasoningModel(model: string | undefined): boolean {
  return model !== undefined && isOpenAiReasoningFamilyModel(model);
}

export function resolveReasoningEffort(input: {
  readonly provider: string | undefined;
  readonly model: string | undefined;
  readonly managedGateway?: boolean | undefined;
}): {
  readonly registered: boolean;
  readonly levels: readonly string[];
  readonly defaultLevel?: ReasoningEffort;
  readonly acceptsChatEffort: boolean;
  readonly chatLevels?: ReadonlySet<string>;
} {
  const slug = normalizeProviderIdentity(input.provider, "reasoning effort") ?? "";
  const model = input.model;
  const isManagedDeepSeek = input.managedGateway === true && slug === "openrouter" && isAgenCDeepSeekModel(model);
  const isNativeDeepSeek = slug === "deepseek" && isNativeDeepSeekModel(model);
  const isZai = slug === "zai" || slug === "zai-coding-plan";
  const isKimiK3 = slug === "kimi" && model?.trim().toLowerCase() === "kimi-k3";
  // Preserve the existing transport compatibility gates. OpenAI and Grok
  // family matching permits forwarding, but does not verify a session enum.
  let acceptsReasoningEffort = false;
  let reasoningEffortAllowedValues: ReadonlySet<string> | undefined;
  if (isManagedDeepSeek) {
    acceptsReasoningEffort = true;
    reasoningEffortAllowedValues = new Set(AGENC_DEEPSEEK_REASONING_LEVELS);
  } else if (isNativeDeepSeek) {
    acceptsReasoningEffort = true;
    reasoningEffortAllowedValues = new Set(DEEPSEEK_REASONING_LEVELS);
  } else if (slug === "openai") {
    acceptsReasoningEffort = isUpstreamReasoningModel(model);
  } else if (slug === "grok") {
    acceptsReasoningEffort = supportsXaiReasoningEffortParam(model);
  } else if (slug === "meta" && /(?:^|[/:])muse-spark-/i.test(model ?? "")) {
    const entry = resolveRegisteredModelCatalogEntry({ provider: slug, model });
    reasoningEffortAllowedValues = entry !== undefined
      ? new Set(entry.supportedReasoningLevels)
      : META_REASONING_EFFORT_VALUES;
    acceptsReasoningEffort = true;
  } else if (
    (slug === "qwen" || slug === "qwen-token-plan") &&
    /(?:^|[/:])qwen3\.8-(?:max|flash)(?:$|[-_.:])/i.test(model ?? "")
  ) {
    reasoningEffortAllowedValues = QWEN_38_REASONING_EFFORT_VALUES;
    acceptsReasoningEffort = true;
  } else if (
    slug === "cerebras" &&
    /(?:^|[/:])gpt-oss-120b$/i.test(model ?? "")
  ) {
    reasoningEffortAllowedValues =
      CEREBRAS_GPT_OSS_REASONING_EFFORT_VALUES;
    acceptsReasoningEffort = true;
  } else if (
    isZai &&
    /(?:^|[/:])glm-5\.3(?:-flash)?$/i.test(model ?? "")
  ) {
    reasoningEffortAllowedValues = ZAI_GLM_53_REASONING_EFFORT_VALUES;
    acceptsReasoningEffort = true;
  } else if (isKimiK3) {
    reasoningEffortAllowedValues = KIMI_K3_REASONING_EFFORT_VALUES;
    acceptsReasoningEffort = true;
  } else if (
    slug === "cerebras" &&
    /(?:^|[/:])(?:qwen-3\.8-27b|gemma-4-31b)$/i.test(model ?? "")
  ) {
    reasoningEffortAllowedValues =
      CEREBRAS_QWEN_GEMMA_REASONING_EFFORT_VALUES;
    acceptsReasoningEffort = true;
  } else if (slug === "ollama-cloud") {
    const entry = resolveRegisteredModelCatalogEntry({ provider: slug, model });
    reasoningEffortAllowedValues = new Set(entry?.supportedReasoningLevels ?? []);
    acceptsReasoningEffort = reasoningEffortAllowedValues.size > 0;
  } else if (slug === "nvidia-nim") {
    reasoningEffortAllowedValues = nimReasoningEffortValues(model);
    acceptsReasoningEffort = (reasoningEffortAllowedValues?.size ?? 0) > 0;
  } else if (
    slug === "amazon-bedrock" &&
    model !== undefined &&
    bedrockConverseEffortLevels(model).length > 0
  ) {
    // The Converse adapter sends effort only for models with a registered
    // Bedrock contract that has levels, so only those offer levels here.
    reasoningEffortAllowedValues = new Set(bedrockConverseEffortLevels(model));
    acceptsReasoningEffort = true;
  }

  const entry = resolveRegisteredModelCatalogEntry(input);
  // Validation needs a catalog entry or an explicit enum. A permissive
  // transport gate must never invent levels for an unregistered identity.
  const levels = entry?.supportedReasoningLevels ??
    (slug === "anthropic" && model !== undefined
      ? anthropicEffortLevels(model)
      : [...(reasoningEffortAllowedValues ?? [])]);
  const defaultLevel = entry?.defaultReasoningLevel;
  return {
    registered: entry !== undefined,
    levels,
    ...(defaultLevel !== undefined ? { defaultLevel } : {}),
    acceptsChatEffort: acceptsReasoningEffort,
    // Preserve existing chat hint shapes; OpenAI and Grok apply their
    // registered-model normalization before this transport boundary.
    ...(reasoningEffortAllowedValues !== undefined
      ? { chatLevels: reasoningEffortAllowedValues } : {}),
  };
}
