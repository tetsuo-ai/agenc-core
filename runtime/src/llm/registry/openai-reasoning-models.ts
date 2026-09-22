/**
 * Verified reasoning models missing from the legacy registry snapshot.
 * Source: https://developers.openai.com/api/docs/models/<model>, 2026-09-06
 * (GPT-5.6 and GPT-6 Astra) and 2026-09-22 (GPT-6 Sol and GPT-6 Luna).
 * These are the positive effort levels supported by AgenC's OAuth path.
 * `none` is not offered here: the turn pipeline treats it as an omitted field.
 * GPT-6 Sol and Luna document `none` as well; omitting the field runs their
 * documented `medium` default, so offering it would be a mislabeled dial.
 * Desktop generates its matching rows from this module, not a second enum.
 */
export const OPENAI_REASONING_MODELS = [
  { model: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
  { model: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
  { model: "gpt-5.6-luna", label: "GPT-5.6 Luna" },
  // Keep the existing default order. Adding Astra must not select it for users.
  { model: "gpt-6-astra", label: "GPT-6 Astra" },
  // Appended after Astra for the same reason: the first row stays GPT-5.6 Sol.
  { model: "gpt-6-sol", label: "GPT-6 Sol" },
  { model: "gpt-6-luna", label: "GPT-6 Luna" },
].map((entry) => ({
  ...entry,
  contextWindow: 1_050_000,
  maxOutputTokens: 128_000,
  efforts: ["low", "medium", "high", "xhigh", "max"] as const,
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
