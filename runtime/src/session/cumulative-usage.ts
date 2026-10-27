import type { LLMUsage } from "../llm/types.js";

/** The charge known for these tokens: none were used, or the provider reported it. */
function knownCharge(usage: LLMUsage): number | undefined {
  return usage.providerCostUsd ??
    (usage.promptTokens === 0 && usage.completionTokens === 0 && usage.totalTokens === 0 ? 0 : undefined);
}

export function cumulativeUsage(acc: LLMUsage, next: LLMUsage | undefined): LLMUsage {
  if (!next) return acc;
  const accCharge = knownCharge(acc);
  const nextCharge = knownCharge(next);
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
    // A sum is only the turn's charge when every call in it was reported.
    ...(accCharge !== undefined && nextCharge !== undefined &&
      (acc.providerCostUsd !== undefined || next.providerCostUsd !== undefined)
      ? { providerCostUsd: accCharge + nextCharge }
      : {}),
  };
}
