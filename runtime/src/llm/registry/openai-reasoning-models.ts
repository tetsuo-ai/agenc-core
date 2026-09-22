/**
 * Verified reasoning models missing from the legacy registry snapshot.
 * Source: https://developers.openai.com/api/docs/models/<model>, 2026-09-06
 * (GPT-5.6 and GPT-6 Astra) and 2026-09-22 (GPT-6 Sol and GPT-6 Luna).
 * GPT-6 Sol and Luna also document `none`, which the turn pipeline sends on
 * the wire for them (omitting the field would run their `medium` default).
 * Astra takes no `none`, and GPT-5.6 does not document it.
 * Desktop generates its matching rows from this module, not a second enum.
 */
const POSITIVE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
const EFFORTS_WITH_NONE = ["none", ...POSITIVE_EFFORTS] as const;

export const OPENAI_REASONING_MODELS = [
  { model: "gpt-5.6-sol", label: "GPT-5.6 Sol", efforts: POSITIVE_EFFORTS },
  { model: "gpt-5.6-terra", label: "GPT-5.6 Terra", efforts: POSITIVE_EFFORTS },
  { model: "gpt-5.6-luna", label: "GPT-5.6 Luna", efforts: POSITIVE_EFFORTS },
  // Keep the existing default order. Adding Astra must not select it for users.
  { model: "gpt-6-astra", label: "GPT-6 Astra", efforts: POSITIVE_EFFORTS },
  // Appended after Astra for the same reason: the first row stays GPT-5.6 Sol.
  { model: "gpt-6-sol", label: "GPT-6 Sol", efforts: EFFORTS_WITH_NONE },
  { model: "gpt-6-luna", label: "GPT-6 Luna", efforts: EFFORTS_WITH_NONE },
].map(({ model, label, efforts }) => ({
  model,
  label,
  contextWindow: 1_050_000,
  maxOutputTokens: 128_000,
  efforts,
  vision: true,
  chatgpt: true,
}));

export function isVerifiedOpenAiReasoningModel(model: string): boolean {
  const normalized = model.trim().toLowerCase().replace(/^openai[/:]/, "");
  return OPENAI_REASONING_MODELS.some((entry) => entry.model === normalized);
}

const OPENAI_REASONING_FAMILY =
  /(?:^|[/:])(?:gpt-5|o1|o3|o4|codex|chatgpt-5)(?:$|[-_.:])/i;

/**
 * OpenAI's reasoning family: the verified rows above plus the GPT-5, o1, o3,
 * o4, Codex and chatgpt-5 families. Capability gating, the effort resolver
 * and the Responses wire all read this one definition.
 */
export function isOpenAiReasoningFamilyModel(model: string): boolean {
  return (
    isVerifiedOpenAiReasoningModel(model) ||
    OPENAI_REASONING_FAMILY.test(model.trim())
  );
}

/**
 * Models whose model page documents `reasoning.effort` none as the default
 * (developers.openai.com, 2026-09-22). A request that omits the effort runs
 * these without reasoning; every other reasoning model defaults to a
 * reasoning tier or has no `none` at all.
 */
const OPENAI_MODELS_DEFAULTING_TO_NO_REASONING = Object.freeze([
  "gpt-5.1",
  "gpt-5.2",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.4-nano",
]);

/** The model itself or one of its dated snapshots, never a sibling like `-pro`. */
function isModelOrDatedSnapshot(candidate: string, model: string): boolean {
  return (
    candidate === model ||
    (candidate.startsWith(`${model}-`) &&
      /^\d{4}-\d{2}-\d{2}$/u.test(candidate.slice(model.length + 1)))
  );
}

export function openAiModelDefaultsToNoReasoning(model: string): boolean {
  const normalized = model.trim().toLowerCase().replace(/^openai[/:]/, "");
  return OPENAI_MODELS_DEFAULTING_TO_NO_REASONING.some((entry) =>
    isModelOrDatedSnapshot(normalized, entry)
  );
}

/**
 * OpenAI's reasoning models take `temperature` only when the effective
 * reasoning effort is `none` (developers.openai.com: GPT-5.4 parameter
 * compatibility and the GPT-6 migration notes); gpt-6-luna answers anything
 * else with 400 "Unsupported parameter: 'temperature' is not supported with
 * this model". An omitted effort runs the model's documented default, which
 * is `none` only for GPT-5.1, 5.2 and the 5.4 line. A caller's temperature
 * (MCP sampling, a programmatic provider default) is dropped otherwise, on
 * the Responses and the Chat Completions wire alike.
 */
export function openAiAcceptsSamplingTemperature(
  model: string,
  reasoningEffort: string | undefined,
): boolean {
  if (!isOpenAiReasoningFamilyModel(model)) return true;
  return reasoningEffort === undefined
    ? openAiModelDefaultsToNoReasoning(model)
    : reasoningEffort === "none";
}

/**
 * Chat Completions rejects function tools on GPT-6 Sol and Luna unless
 * `reasoning_effort` is `none` (their default is medium), and never accepts
 * them on GPT-6 Astra (Using GPT-6 guide, 2026-09-22; live: "Function tools
 * with reasoning_effort are not supported for gpt-6-sol in
 * /v1/chat/completions"). The Responses API takes them at every effort.
 */
export function openAiChatCompletionsRejectsFunctionTools(
  model: string,
  reasoningEffort: string | undefined,
): boolean {
  const normalized = model.trim().toLowerCase().replace(/^openai[/:]/, "");
  if (normalized === "gpt-6-astra") return true;
  if (normalized === "gpt-6-sol" || normalized === "gpt-6-luna") {
    return reasoningEffort !== "none";
  }
  return false;
}
