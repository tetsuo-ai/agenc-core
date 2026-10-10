import type { LLMUsage } from "../llm/types.js";

export function cumulativeUsage(acc: LLMUsage, next: LLMUsage | undefined): LLMUsage {
  if (!next) return acc;
  return {
    promptTokens: acc.promptTokens + (next.promptTokens ?? 0),
    completionTokens: acc.completionTokens + (next.completionTokens ?? 0),
    totalTokens: acc.totalTokens + (next.totalTokens ?? 0),
    cachedInputTokens:
      (acc.cachedInputTokens ?? 0) + (next.cachedInputTokens ?? 0),
    cacheCreationInputTokens:
      (acc.cacheCreationInputTokens ?? 0) +
      (next.cacheCreationInputTokens ?? 0),
    ...(acc.cacheCreation1hInputTokens !== undefined || next.cacheCreation1hInputTokens !== undefined
      ? { cacheCreation1hInputTokens: (acc.cacheCreation1hInputTokens ?? 0) + (next.cacheCreation1hInputTokens ?? 0) }
      : {}),
    reasoningOutputTokens:
      (acc.reasoningOutputTokens ?? 0) + (next.reasoningOutputTokens ?? 0),
    webSearchRequests:
      (acc.webSearchRequests ?? 0) + (next.webSearchRequests ?? 0),
  };
}
