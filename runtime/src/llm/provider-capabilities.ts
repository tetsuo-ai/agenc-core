import type {
  LLMCompactionDiagnostics,
  LLMStatefulDiagnostics,
  LLMStatefulResponsesConfig,
} from "./types.js";
import { LLMProviderError } from "./errors.js";
import {
  supportsXaiReasoningEffortParam,
  supportsXaiStructuredOutputsWithTools,
} from "./structured-output.js";

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

export function resolveLLMStatefulResponsesConfig(
  config: LLMStatefulResponsesConfig | undefined,
): ResolvedLLMStatefulResponsesConfig {
  const enabled = config?.enabled === true;
  return {
    enabled,
    store: config?.store ?? true,
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

/**
 * Fail-closed gate for the xAI `reasoning_effort` request parameter.
 *
 * Per xAI docs, only `grok-4.20-multi-agent*` accepts `reasoning_effort`
 * (and there it controls agent count, not thinking depth). Every other
 * current Grok 4 model returns an API error when the field is sent.
 *
 * Rather than let the request hit xAI and bounce with a provider error
 * that the tool loop would then bake into history (wasted round-trip,
 * confusing surface), refuse at request-build time with a clear
 * LLMProviderError the caller can either catch + strip the field or
 * surface as a config mistake.
 */
export function assertXaiReasoningEffortCompatibility(input: {
  readonly providerName: string;
  readonly model?: string;
  readonly reasoningEffortRequested: boolean;
}): void {
  if (!input.reasoningEffortRequested) {
    return;
  }
  if (supportsXaiReasoningEffortParam(input.model)) {
    return;
  }
  throw new LLMProviderError(
    input.providerName,
    `xAI reasoning_effort is only supported on grok-4.20-multi-agent models; requested ${input.model ?? "unknown model"}. Remove reasoningEffort from the llm config or switch to a multi-agent variant.`,
    400,
  );
}
