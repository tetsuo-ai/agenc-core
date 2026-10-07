import type { LLMUsage } from "./types.js";

/** Keep the reported cache TTL split in legacy Anthropic usage bridges. */
export function legacyCacheCreationUsage(
  usage: Pick<LLMUsage, "cacheCreationInputTokens" | "cacheCreation1hInputTokens">,
): { cache_creation?: { ephemeral_1h_input_tokens: number; ephemeral_5m_input_tokens: number } } {
  if (usage.cacheCreation1hInputTokens === undefined) return {};
  const total = Math.max(0, usage.cacheCreationInputTokens ?? 0);
  const oneHour = Math.min(total, Math.max(0, usage.cacheCreation1hInputTokens));
  return { cache_creation: { ephemeral_1h_input_tokens: oneHour, ephemeral_5m_input_tokens: total - oneHour } };
}
