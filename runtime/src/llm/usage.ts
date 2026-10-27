import type { LLMUsage } from "./types.js";

/** Physical billed tokens, preserving each wire's cache-counter convention.
 * Cache TTL and reasoning breakdowns are subsets, never extra usage.
 */
export function billableTokenUsage(usage: LLMUsage): { inputTokens: number; outputTokens: number } {
  const outputTokens = Math.max(usage.completionTokens, usage.reasoningOutputTokens ?? 0);
  const cacheTokens = (usage.cachedInputTokens ?? 0) + (usage.cacheCreationInputTokens ?? 0);
  const inputTokens = Math.max(
    usage.promptTokens + (usage.cacheInputExcludedFromPrompt ? cacheTokens : 0),
    cacheTokens,
    usage.totalTokens - outputTokens,
  );
  return { inputTokens, outputTokens };
}

/** Keep the reported cache TTL split in legacy Anthropic usage bridges. */
export function legacyCacheCreationUsage(
  usage: Pick<LLMUsage, "cacheCreationInputTokens" | "cacheCreation1hInputTokens">,
): { cache_creation?: { ephemeral_1h_input_tokens: number; ephemeral_5m_input_tokens: number } } {
  if (usage.cacheCreation1hInputTokens === undefined) return {};
  const total = Math.max(0, usage.cacheCreationInputTokens ?? 0);
  const oneHour = Math.min(total, Math.max(0, usage.cacheCreation1hInputTokens));
  return { cache_creation: { ephemeral_1h_input_tokens: oneHour, ephemeral_5m_input_tokens: total - oneHour } };
}
