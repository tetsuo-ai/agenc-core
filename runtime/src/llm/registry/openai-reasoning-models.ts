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
