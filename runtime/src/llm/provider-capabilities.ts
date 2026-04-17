import type { LLMCompactionDiagnostics } from "./types.js";
import { LLMProviderError } from "./errors.js";
import {
  supportsXaiReasoningEffortParam,
  supportsXaiStructuredOutputsWithTools,
} from "./structured-output.js";

const DEFAULT_COMPACTION_FALLBACK_ON_UNSUPPORTED = true;

export interface ResolvedLLMCompactionConfig {
  readonly enabled: boolean;
  readonly compactThreshold?: number;
  readonly fallbackOnUnsupported: boolean;
}

export function resolveLLMCompactionConfig(
  input?: {
    readonly enabled?: boolean;
    readonly compactThreshold?: number;
    readonly fallbackOnUnsupported?: boolean;
  },
): ResolvedLLMCompactionConfig {
  return {
    enabled: input?.enabled === true,
    compactThreshold:
      typeof input?.compactThreshold === "number" &&
        Number.isFinite(input.compactThreshold) &&
        input.compactThreshold > 0
        ? Math.floor(input.compactThreshold)
        : undefined,
    fallbackOnUnsupported:
      input?.fallbackOnUnsupported ?? DEFAULT_COMPACTION_FALLBACK_ON_UNSUPPORTED,
  };
}

export function buildUnsupportedCompactionDiagnostics(input: {
  readonly provider: string;
  readonly compaction: ResolvedLLMCompactionConfig;
}): LLMCompactionDiagnostics | undefined {
  const compaction = input.compaction;
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
