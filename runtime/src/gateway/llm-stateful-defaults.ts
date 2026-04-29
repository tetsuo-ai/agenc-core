import { getAutoCompactThresholdTokens } from "../llm/compact/context-window.js";

const DEFAULT_GROK_COMPACTION_THRESHOLD_FALLBACK = 16_000;

/**
 * Resolve the default auto-compact threshold for Grok requests when no
 * explicit value is configured. Used by the supervisor to decide when
 * local history compaction fires.
 */
export function resolveDefaultGrokCompactionThreshold(
  contextWindowTokens?: number,
  maxOutputTokens?: number,
): number {
  if (
    typeof contextWindowTokens === "number" &&
    Number.isFinite(contextWindowTokens) &&
    contextWindowTokens > 0
  ) {
    return getAutoCompactThresholdTokens({
      contextWindowTokens,
      maxOutputTokens,
    });
  }
  return DEFAULT_GROK_COMPACTION_THRESHOLD_FALLBACK;
}
