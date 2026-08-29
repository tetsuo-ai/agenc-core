/**
 * Automatic compact threshold and warning logic.
 *
 * Source snapshot: `src/services/compact/autoCompact.ts` at
 * `0ca43335375beec6e58711b797d5b0c4bb5019b8`.
 */

import type { CompactContext, CompactionResult, RuntimeMessage } from "./types.js";
import { compactConversation } from "./compact.js";
import { CompactionReconstructionRequiredError } from "./transaction-types.js";
import {
  estimateMessagesTokens,
  isTruthyEnv,
  lookupContextWindowForModel,
  positiveInteger,
  positiveNumber,
} from "./_deps/runtime.js";
import { getSelectedProviderEnvironment } from "../../utils/model/providers.js";
import type { ProviderEnvironment } from "../../llm/provider-options.js";

export type AutoCompactTrackingState = {
  readonly compacted?: boolean;
  readonly turnCounter?: number;
  readonly turnId?: string;
  readonly consecutiveFailures?: number;
};

export type AutoCompactOptions = {
  readonly force?: boolean;
};

export const AUTOCOMPACT_BUFFER_TOKENS = 13_000;

/**
 * Ceiling on how much of the context window may be used before auto-compaction
 * must fire, expressed as a fraction rather than a fixed token buffer.
 *
 * A fixed buffer assumes compaction's view of "full" matches admission's. It
 * does not. Admission compares accountingResult.totalTokens — which is
 * inputTokens ALREADY inflated by safetyMarginForTokens() (10% + 256) plus the
 * reserved output — against its own contextWindowTokens, resolved from
 * options/profile/session before REGISTERED_MODEL_CATALOG. Observed on
 * grok-4.5 (catalogued at 500k): a turn counted 435,227 was admitted and the
 * next at 444,458 was denied `context_window_exceeded`, putting the real cut
 * near 476k — while `window - 13_000` would not have compacted until 487k.
 *
 * The safety net sat 11k BEHIND the trap, so it could never fire: two long
 * sessions were killed mid-run with compaction_retention_pins still at 0.
 * Taking the stricter of the two keeps compaction ahead of admission without
 * having to predict admission's exact number.
 */
// 0.85 was not enough. Measured on the third session killed by
// `context_window_exceeded` (grok-4.5, 500k window): the last admitted turn
// carried 423,740 input tokens — one turn UNDER the 425k threshold — and the
// very next user message weighed 445,857 + 32,000 reserved output and was
// denied. Admission compares margin-inflated totals (input × 1.1 + 256 +
// 32k output), so its effective ceiling sits ~75k below the catalog window.
// 0.75 fires ~50k before the measured kill line, leaving room for BOTH one
// more oversized turn AND the compaction request itself, whose input is the
// full history it is trying to shrink.
export const AUTOCOMPACT_MAX_WINDOW_FRACTION = 0.75;
const WARNING_THRESHOLD_BUFFER_TOKENS = 20_000;
const ERROR_THRESHOLD_BUFFER_TOKENS = 20_000;
export const MANUAL_COMPACT_BUFFER_TOKENS = 3_000;

const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3;

export async function autoCompactIfNeeded(
  messages: RuntimeMessage[],
  context: CompactContext,
  _cacheSafeParams?: unknown,
  querySource?: string,
  tracking?: AutoCompactTrackingState,
  snipTokensFreed = 0,
  options: AutoCompactOptions = {},
): Promise<{
  readonly wasCompacted: boolean;
  readonly compactionResult?: CompactionResult;
  readonly consecutiveFailures?: number;
}> {
  if (querySource === "compact" || querySource === "session_memory") {
    return { wasCompacted: false };
  }
  if (!isAutoCompactEnabled()) {
    return { wasCompacted: false };
  }
  if ((tracking?.consecutiveFailures ?? 0) >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES) {
    return {
      wasCompacted: false,
      consecutiveFailures: tracking?.consecutiveFailures,
    };
  }
  const tokenCount = Math.max(
    0,
    estimateMessagesTokens(messages, context) - snipTokensFreed,
  );
  if (options.force !== true && tokenCount < autoCompactThreshold(context)) {
    return { wasCompacted: false, consecutiveFailures: 0 };
  }
  try {
    // Every destructive compaction uses the canonical transaction. Session
    // memory remains recall input; it is never an unauthenticated replacement
    // history or a bypass around pin/intent/provider validation/commit.
    const compactionResult = await compactConversation(messages, context);
    return {
      wasCompacted: true,
      compactionResult,
      consecutiveFailures: 0,
    };
  } catch (error) {
    // gaphunt3 #41: a user/provider abort mid-compaction is a cancellation,
    // not a compaction failure. Re-throw it so the cancel propagates instead
    // of being swallowed, and do NOT increment consecutiveFailures (which
    // would otherwise trip the 3-strike circuit breaker and disable
    // auto-compaction for the rest of the turn on benign cancels).
    if (
      error instanceof CompactionReconstructionRequiredError ||
      isAbortError(context, error)
    ) {
      throw error;
    }
    return {
      wasCompacted: false,
      consecutiveFailures: (tracking?.consecutiveFailures ?? 0) + 1,
    };
  }
}

function isAbortError(context: CompactContext, error: unknown): boolean {
  if (context.abortController?.signal.aborted === true) return true;
  if (error instanceof Error) {
    if (error.name === "AbortError") return true;
    const message = error.message.toLowerCase();
    if (message.includes("abort")) return true;
  }
  return false;
}

export function getEffectiveContextWindowSize(
  modelOrContext?: string | CompactContext,
): number {
  return getEffectiveContextWindowSizeForEnvironment(
    modelOrContext,
    getSelectedProviderEnvironment(),
  );
}

export function getEffectiveContextWindowSizeForEnvironment(
  modelOrContext: string | CompactContext | undefined,
  environment: ProviderEnvironment,
): number {
  const context = typeof modelOrContext === "object" ? modelOrContext : undefined;
  const modelFallback = contextWindowForModel(
    typeof modelOrContext === "string"
      ? modelOrContext
      : context?.options?.mainLoopModel,
  );
  const envWindow = positiveInteger(environment.AGENC_AUTO_COMPACT_WINDOW);
  return envWindow ?? context?.options?.contextWindowTokens ?? modelFallback;
}

export function getAutoCompactThreshold(
  modelOrContext?: string | CompactContext,
): number {
  return getAutoCompactThresholdForEnvironment(
    modelOrContext,
    getSelectedProviderEnvironment(),
  );
}

export function getAutoCompactThresholdForEnvironment(
  modelOrContext: string | CompactContext | undefined,
  environment: ProviderEnvironment,
): number {
  const contextWindow = getEffectiveContextWindowSizeForEnvironment(
    modelOrContext,
    environment,
  );
  const percentOverride = positiveNumber(
    environment.AGENC_AUTOCOMPACT_PCT_OVERRIDE,
  );
  const bufferThreshold = contextWindow > AUTOCOMPACT_BUFFER_TOKENS
    ? contextWindow - AUTOCOMPACT_BUFFER_TOKENS
    : Math.floor(contextWindow * 0.8);
  // Whichever fires first. See AUTOCOMPACT_MAX_WINDOW_FRACTION: on a large
  // window the fixed buffer lands past the point where admission already
  // denies the turn, and compaction never gets to run.
  const defaultThreshold = Math.min(
    bufferThreshold,
    Math.floor(contextWindow * AUTOCOMPACT_MAX_WINDOW_FRACTION),
  );
  if (percentOverride !== undefined && percentOverride > 0 && percentOverride <= 100) {
    return Math.max(1, Math.min(
      Math.floor(contextWindow * (percentOverride / 100)),
      defaultThreshold,
    ));
  }
  return Math.max(1, defaultThreshold);
}

export function calculateTokenWarningState(
  tokenUsage: number,
  model: string,
): ReturnType<typeof calculateTokenWarningStateForEnvironment> {
  return calculateTokenWarningStateForEnvironment(
    tokenUsage,
    model,
    getSelectedProviderEnvironment(),
  );
}

export function calculateTokenWarningStateForEnvironment(
  tokenUsage: number,
  model: string,
  environment: ProviderEnvironment,
): {
  readonly percentLeft: number;
  readonly isAboveWarningThreshold: boolean;
  readonly isAboveErrorThreshold: boolean;
  readonly isAboveAutoCompactThreshold: boolean;
  readonly isAtBlockingLimit: boolean;
} {
  const rawContextWindow = contextWindowForModel(model);
  const threshold = isAutoCompactEnabledForEnvironment(environment)
    ? getAutoCompactThresholdForEnvironment(model, environment)
    : getEffectiveContextWindowSizeForEnvironment(model, environment);
  const percentLeft = Math.max(
    0,
    Math.round(((rawContextWindow - tokenUsage) / rawContextWindow) * 100),
  );
  const warningThreshold = threshold - WARNING_THRESHOLD_BUFFER_TOKENS;
  const errorThreshold = threshold - ERROR_THRESHOLD_BUFFER_TOKENS;
  const blockingLimitOverride = positiveInteger(
    environment.AGENC_COMPACT_BLOCKING_LIMIT_OVERRIDE ??
      environment.AGENC_BLOCKING_LIMIT_OVERRIDE,
  );
  const blockingLimit = blockingLimitOverride ??
    (getEffectiveContextWindowSizeForEnvironment(model, environment) - MANUAL_COMPACT_BUFFER_TOKENS);
  return {
    percentLeft,
    isAboveWarningThreshold: tokenUsage >= warningThreshold,
    isAboveErrorThreshold: tokenUsage >= errorThreshold,
    isAboveAutoCompactThreshold:
      isAutoCompactEnabledForEnvironment(environment) &&
      tokenUsage >= getAutoCompactThresholdForEnvironment(model, environment),
    isAtBlockingLimit: tokenUsage >= blockingLimit,
  };
}

export function isAutoCompactEnabled(): boolean {
  return isAutoCompactEnabledForEnvironment(getSelectedProviderEnvironment());
}

export function isAutoCompactEnabledForEnvironment(
  environment: ProviderEnvironment,
): boolean {
  return !isTruthyEnv(environment.AGENC_DISABLE_COMPACT) &&
    !isTruthyEnv(environment.AGENC_DISABLE_AUTO_COMPACT);
}

function autoCompactThreshold(context: CompactContext): number {
  return getAutoCompactThreshold(context);
}

/**
 * Resolve the context window for a model id when no live config window
 * is available. Delegates to {@link lookupContextWindowForModel} which
 * combines family-literal shortcuts (haiku/sonnet/opus → 200k), the
 * shared openai-compatible table (qwen/llama/gemma/mistral/deepseek/
 * gpt/gemini/glm/kimi/...), and a 128k last-resort default for truly
 * unknown models. Previously this returned a hard-coded 32k for
 * everything outside the three family-string matches, which caused
 * every other provider to silently fall back to a stale haiku-era
 * window.
 */
function contextWindowForModel(model: string | undefined): number {
  return lookupContextWindowForModel(model);
}
