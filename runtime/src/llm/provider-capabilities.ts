import type {
  LLMCompactionDiagnostics,
  LLMProviderCapabilities,
  LLMStatefulDiagnostics,
  LLMStatefulResponsesConfig,
} from "./types.js";
import { LLMProviderError } from "./errors.js";
import { supportsXaiStructuredOutputsWithTools } from "./structured-output.js";

const DEFAULT_STATEFUL_RECONCILIATION_WINDOW = 48;
const MAX_STATEFUL_RECONCILIATION_WINDOW = 256;
const DEFAULT_COMPACTION_FALLBACK_ON_UNSUPPORTED = true;

export interface ResolvedLLMCompactionConfig {
  readonly enabled: boolean;
  readonly compactThreshold?: number;
  readonly fallbackOnUnsupported: boolean;
}

export interface ResolvedLLMStatefulResponsesConfig {
  readonly enabled: boolean;
  readonly store: boolean;
  readonly fallbackToStateless: boolean;
  readonly reconciliationWindow: number;
  readonly compaction: ResolvedLLMCompactionConfig;
}

export const UNSUPPORTED_STATEFUL_CAPABILITIES: LLMProviderCapabilities["stateful"] = {
  assistantPhase: false,
  previousResponseId: false,
  encryptedReasoning: false,
  storedResponseRetrieval: false,
  storedResponseDeletion: false,
  opaqueCompaction: false,
  deterministicFallback: true,
};

export function resolveLLMStatefulResponsesConfig(
  config: LLMStatefulResponsesConfig | undefined,
): ResolvedLLMStatefulResponsesConfig {
  const enabled = config?.enabled === true;
  return {
    enabled,
    store: config?.store ?? false,
    fallbackToStateless: config?.fallbackToStateless ?? true,
    reconciliationWindow: Math.min(
      MAX_STATEFUL_RECONCILIATION_WINDOW,
      Math.max(1, Math.floor(config?.reconciliationWindow ?? DEFAULT_STATEFUL_RECONCILIATION_WINDOW)),
    ),
    compaction: {
      enabled: config?.compaction?.enabled === true,
      compactThreshold:
        typeof config?.compaction?.compactThreshold === "number" &&
          Number.isFinite(config.compaction.compactThreshold) &&
          config.compaction.compactThreshold > 0
          ? Math.floor(config.compaction.compactThreshold)
          : undefined,
      fallbackOnUnsupported:
        config?.compaction?.fallbackOnUnsupported ??
        DEFAULT_COMPACTION_FALLBACK_ON_UNSUPPORTED,
    },
  };
}

export function buildUnsupportedStatefulDiagnostics(input: {
  readonly provider: string;
  readonly config: ResolvedLLMStatefulResponsesConfig;
  readonly hasSessionId: boolean;
}): LLMStatefulDiagnostics | undefined {
  if (!input.config.enabled || !input.hasSessionId) {
    return undefined;
  }
  return {
    enabled: true,
    attempted: false,
    continued: false,
    store: input.config.store,
    fallbackToStateless: input.config.fallbackToStateless,
    fallbackReason: "unsupported",
    events: [
      {
        type: "stateful_fallback",
        reason: "unsupported",
        detail:
          `${input.provider} does not support provider-managed previous_response_id continuation`,
      },
    ],
  };
}

export function buildUnsupportedCompactionDiagnostics(input: {
  readonly provider: string;
  readonly config: ResolvedLLMStatefulResponsesConfig;
}): LLMCompactionDiagnostics | undefined {
  const compaction = input.config.compaction;
  if (!compaction.enabled || compaction.compactThreshold === undefined) {
    return undefined;
  }
  return {
    enabled: true,
    requested: true,
    active: false,
    mode: "provider_managed_state",
    threshold: compaction.compactThreshold,
    observedItemCount: 0,
    fallbackReason: "unsupported",
  };
}

export function assertXaiStructuredOutputToolCompatibility(input: {
  readonly providerName: string;
  readonly model?: string;
  readonly structuredOutputRequested: boolean;
  readonly toolsRequested: boolean;
}): void {
  if (!input.structuredOutputRequested || !input.toolsRequested) {
    return;
  }
  if (supportsXaiStructuredOutputsWithTools(input.model)) {
    return;
  }
  throw new LLMProviderError(
    input.providerName,
    `xAI structured outputs with tools require a Grok 4 model; requested ${input.model ?? "unknown model"}`,
    400,
  );
}
