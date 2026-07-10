import type {
  LLMCompactionDiagnostics,
  LLMStructuredOutputRequest,
} from "./types.js";
import { LLMProviderError } from "./errors.js";
import {
  isStructuredOutputRequested,
  resolveProviderStructuredOutputMode,
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

export function assertProviderStructuredOutputCompatibility(input: {
  readonly providerName: string;
  readonly model?: string;
  readonly structuredOutput?: LLMStructuredOutputRequest;
  readonly toolsRequested?: boolean;
  readonly api?: "responses" | "chat_completions" | "messages";
}): void {
  if (!isStructuredOutputRequested(input.structuredOutput)) {
    return;
  }
  const mode = resolveProviderStructuredOutputMode({
    provider: input.providerName,
    model: input.model,
    api: input.api,
  });
  if (mode === "unsupported") {
    throw new LLMProviderError(
      input.providerName,
      `${input.providerName} structured outputs are not supported by ${input.model ?? "unknown model"}`,
      400,
    );
  }
  if (
    (input.providerName.trim().toLowerCase() === "grok" ||
      input.providerName.trim().toLowerCase() === "xai") &&
    input.toolsRequested
  ) {
    assertXaiStructuredOutputToolCompatibility({
      providerName: input.providerName,
      model: input.model,
      structuredOutputRequested: true,
      toolsRequested: true,
    });
  }
}

/**
 * Fail-closed gate for the xAI `reasoning_effort` request parameter.
 *
 * Per xAI docs, Grok 4.3 and Grok 4.5 accept `reasoning_effort` as a
 * reasoning-depth control. `grok-4.20-multi-agent*` accepts the same field
 * as an agent-count control. Unknown model families remain fail-closed.
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
    `xAI reasoning_effort is not supported by ${input.model ?? "unknown model"}. Remove reasoningEffort from the llm config or switch to Grok 4.3, Grok 4.5, or a Grok 4.20 multi-agent variant.`,
    400,
  );
}
