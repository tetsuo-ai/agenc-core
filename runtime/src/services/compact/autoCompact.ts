/**
 * Automatic compact threshold and warning logic.
 *
 * Source snapshot: `src/services/compact/autoCompact.ts` at
 * `0ca43335375beec6e58711b797d5b0c4bb5019b8`.
 */

import type { CompactContext, CompactionResult, RuntimeMessage } from "./types.js";
import { compactConversation } from "./compact.js";
import { runPostCompactCleanup } from "./postCompactCleanup.js";
import { trySessionMemoryCompaction } from "./sessionMemoryCompact.js";
import {
  estimateMessagesTokens,
  isTruthyEnv,
  positiveInteger,
  positiveNumber,
} from "./_deps/runtime.js";

export type AutoCompactTrackingState = {
  readonly compacted?: boolean;
  readonly turnCounter?: number;
  readonly turnId?: string;
  readonly consecutiveFailures?: number;
};

export const AUTOCOMPACT_BUFFER_TOKENS = 13_000;
export const WARNING_THRESHOLD_BUFFER_TOKENS = 20_000;
export const ERROR_THRESHOLD_BUFFER_TOKENS = 20_000;
export const MANUAL_COMPACT_BUFFER_TOKENS = 3_000;

const DEFAULT_CONTEXT_WINDOW_TOKENS = 32_000;
const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3;

export async function autoCompactIfNeeded(
  messages: RuntimeMessage[],
  context: CompactContext,
  _cacheSafeParams?: unknown,
  querySource?: string,
  tracking?: AutoCompactTrackingState,
  snipTokensFreed = 0,
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
  if (tokenCount < autoCompactThreshold(context)) {
    return { wasCompacted: false, consecutiveFailures: 0 };
  }
  try {
    const compactionResult =
      await trySessionMemoryCompaction(messages, context) ??
      await compactConversation(messages, context);
    runPostCompactCleanup(context.deps?.cleanup);
    return {
      wasCompacted: true,
      compactionResult,
      consecutiveFailures: 0,
    };
  } catch {
    return {
      wasCompacted: false,
      consecutiveFailures: (tracking?.consecutiveFailures ?? 0) + 1,
    };
  }
}

export function getEffectiveContextWindowSize(
  modelOrContext?: string | CompactContext,
): number {
  const context = typeof modelOrContext === "object" ? modelOrContext : undefined;
  const modelFallback = contextWindowForModel(
    typeof modelOrContext === "string"
      ? modelOrContext
      : context?.options?.mainLoopModel,
  );
  const envWindow = positiveInteger(process.env.AGENC_AUTO_COMPACT_WINDOW);
  return envWindow ?? context?.options?.contextWindowTokens ?? modelFallback;
}

export function getAutoCompactThreshold(
  modelOrContext?: string | CompactContext,
): number {
  const contextWindow = getEffectiveContextWindowSize(modelOrContext);
  const percentOverride = positiveNumber(process.env.AGENC_AUTOCOMPACT_PCT_OVERRIDE);
  const defaultThreshold = contextWindow > AUTOCOMPACT_BUFFER_TOKENS
    ? contextWindow - AUTOCOMPACT_BUFFER_TOKENS
    : Math.floor(contextWindow * 0.8);
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
): {
  readonly percentLeft: number;
  readonly isAboveWarningThreshold: boolean;
  readonly isAboveErrorThreshold: boolean;
  readonly isAboveAutoCompactThreshold: boolean;
  readonly isAtBlockingLimit: boolean;
} {
  const rawContextWindow = contextWindowForModel(model);
  const threshold = isAutoCompactEnabled()
    ? getAutoCompactThreshold(model)
    : getEffectiveContextWindowSize(model);
  const percentLeft = Math.max(
    0,
    Math.round(((rawContextWindow - tokenUsage) / rawContextWindow) * 100),
  );
  const warningThreshold = threshold - WARNING_THRESHOLD_BUFFER_TOKENS;
  const errorThreshold = threshold - ERROR_THRESHOLD_BUFFER_TOKENS;
  const blockingLimitOverride = positiveInteger(
    process.env.AGENC_COMPACT_BLOCKING_LIMIT_OVERRIDE ??
      process.env.AGENC_BLOCKING_LIMIT_OVERRIDE,
  );
  const blockingLimit = blockingLimitOverride ??
    (getEffectiveContextWindowSize(model) - MANUAL_COMPACT_BUFFER_TOKENS);
  return {
    percentLeft,
    isAboveWarningThreshold: tokenUsage >= warningThreshold,
    isAboveErrorThreshold: tokenUsage >= errorThreshold,
    isAboveAutoCompactThreshold:
      isAutoCompactEnabled() && tokenUsage >= getAutoCompactThreshold(model),
    isAtBlockingLimit: tokenUsage >= blockingLimit,
  };
}

export function isAutoCompactEnabled(): boolean {
  return !isTruthyEnv(process.env.DISABLE_COMPACT) &&
    !isTruthyEnv(process.env.AGENC_DISABLE_COMPACT) &&
    !isTruthyEnv(process.env.DISABLE_AUTO_COMPACT) &&
    !isTruthyEnv(process.env.AGENC_DISABLE_AUTO_COMPACT);
}

function autoCompactThreshold(context: CompactContext): number {
  return getAutoCompactThreshold(context);
}

function contextWindowForModel(model: string | undefined): number {
  if (model === undefined || model.trim().length === 0) {
    return DEFAULT_CONTEXT_WINDOW_TOKENS;
  }
  const normalized = model.toLowerCase();
  if (normalized.includes("haiku")) return 200_000;
  if (normalized.includes("sonnet")) return 200_000;
  if (normalized.includes("opus")) return 200_000;
  return DEFAULT_CONTEXT_WINDOW_TOKENS;
}
