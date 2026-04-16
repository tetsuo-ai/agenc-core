import type { GatewayLLMConfig } from "./types.js";
import { getAutoCompactThresholdTokens } from "../llm/compact/context-window.js";

const DEFAULT_GROK_COMPACTION_THRESHOLD_FALLBACK = 16_000;

interface GatewayStatefulResponsesResolution {
  readonly config: GatewayLLMConfig["statefulResponses"];
  readonly usedDefaults: boolean;
}

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

export function resolveGatewayStatefulResponses(
  provider: GatewayLLMConfig["provider"],
  statefulResponses: GatewayLLMConfig["statefulResponses"],
): GatewayStatefulResponsesResolution {
  if (provider !== "grok") {
    return {
      config: statefulResponses,
      usedDefaults: false,
    };
  }

  if (statefulResponses?.enabled === false) {
    return {
      config: statefulResponses,
      usedDefaults: false,
    };
  }

  let usedDefaults = false;
  const enabled = statefulResponses?.enabled ?? true;
  if (statefulResponses?.enabled === undefined) usedDefaults = true;

  const store = statefulResponses?.store ?? true;
  if (statefulResponses?.store === undefined) usedDefaults = true;

  const fallbackToStateless = statefulResponses?.fallbackToStateless ?? true;
  if (statefulResponses?.fallbackToStateless === undefined) usedDefaults = true;

  const compactionEnabled = statefulResponses?.compaction?.enabled ?? true;
  if (statefulResponses?.compaction?.enabled === undefined) usedDefaults = true;

  const compactThreshold = statefulResponses?.compaction?.compactThreshold;
  if (compactThreshold === undefined) usedDefaults = true;

  const fallbackOnUnsupported =
    statefulResponses?.compaction?.fallbackOnUnsupported ?? true;
  if (statefulResponses?.compaction?.fallbackOnUnsupported === undefined) {
    usedDefaults = true;
  }

  return {
    config: {
      enabled,
      store,
      fallbackToStateless,
      compaction: {
        enabled: compactionEnabled,
        ...(compactThreshold !== undefined ? { compactThreshold } : {}),
        fallbackOnUnsupported,
      },
    },
    usedDefaults,
  };
}
