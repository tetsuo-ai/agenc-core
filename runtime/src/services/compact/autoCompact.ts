export { AUTOCOMPACT_BUFFER_TOKENS, AUTOCOMPACT_MAX_WINDOW_FRACTION, MANUAL_COMPACT_BUFFER_TOKENS, getEffectiveContextWindowSize, getEffectiveContextWindowSizeForEnvironment, getAutoCompactThreshold, getAutoCompactThresholdForEnvironment, calculateTokenWarningState, calculateTokenWarningStateForEnvironment, isAutoCompactEnabled, isAutoCompactEnabledForEnvironment } from "./thresholds.js";
import { getAutoCompactThreshold, isAutoCompactEnabled } from "./thresholds.js";
/**
 * Automatic compact threshold and warning logic.
 *
 * Source snapshot: `src/services/compact/autoCompact.ts` at
 * `0ca43335375beec6e58711b797d5b0c4bb5019b8`.
 */

import type { CompactContext, CompactionResult, RuntimeMessage } from "./types.js";
import { readCompactionTransactionAdapter } from "./transaction-adapter.js";
import {
  compactionFailureDetails,
  type CompactionFailureDetails,
} from "./failure-details.js";
import { isTransientProviderError } from "../../recovery/api-errors.js";
import {
  CompactionCannotReduceError,
  CompactionFailurePersistenceError,
  CompactionReconstructionRequiredError,
  CompactionSummaryRejectedError,
  CompactionTransactionError,
} from "./transaction-types.js";
import {
  estimateMessagesTokens,
} from "./_deps/runtime.js";
import {
  AGGRESSIVE_COMPACTION_FOCUS,
  EMERGENCY_COMPACTION_FOCUS,
  type CompactionLadderTier,
} from "./ladder.js";
import { usesLocalToolProfile } from "../../llm/wire/capability-gating.js";

export type AutoCompactTrackingState = {
  readonly compacted?: boolean;
  readonly turnCounter?: number;
  readonly turnId?: string;
  readonly consecutiveFailures?: number;
};

export type AutoCompactOptions = {
  readonly force?: boolean;
  /** Degraded compaction ladder tier (#2497); `standard` when absent. */
  readonly tier?: CompactionLadderTier;
};

const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3;

/**
 * One immediate retry of the summarizer call when it fails on a transient
 * provider error (a dropped connection, a body cut mid-stream). A turn that
 * has run past the context limit has exactly one way forward, and a single
 * network blip used to end it: the attempt was recorded as a failure and the
 * turn went on sampling a prompt the provider would not serve (desktop soak,
 * 2026-09-06). Only one retry: the transaction refuses further automatic
 * attempts after two durable failures for the same history.
 */
const MAX_TRANSIENT_COMPACTION_RETRIES = 1;
const TRANSIENT_COMPACTION_RETRY_DELAY_MS = 1_000;

function transientRetryDelay(context: CompactContext): Promise<void> {
  const signal = context.abortController?.signal;
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, TRANSIENT_COMPACTION_RETRY_DELAY_MS);
    timer.unref?.();
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

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
  /**
   * Why a compaction attempt did not compact. The turn loop reports this
   * to the user: without it a failed attempt reached the transcript as a
   * bare "compact skipped" and the reason — computed, then discarded —
   * was unavailable to anyone trying to act on it.
   */
  readonly skippedReason?: string;
  readonly skippedCode?: CompactionCannotReduceError["code"];
  /** Transaction failure reason, when the decline was a typed transaction failure. */
  readonly skippedFailureReason?: CompactionTransactionError["reason"];
  /** Flattened error chain and facts behind `skippedReason` (#2499). */
  readonly skippedDetails?: CompactionFailureDetails;
  /** Proven terminal summary rejection with unchanged canonical history. */
  readonly advisoryFailure?: "summary_rejected";
}> {
  const tier: CompactionLadderTier = options.tier ?? "standard";
  if (querySource === "compact" || querySource === "session_memory") {
    return { wasCompacted: false };
  }
  if (!isAutoCompactEnabled()) {
    return { wasCompacted: false, skippedReason: "auto-compaction is disabled" };
  }
  // The ladder is its own bound (each tier at most once per episode); the
  // three-strike breaker applies to standard attempts only.
  if (tier === "standard" && (tracking?.consecutiveFailures ?? 0) >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES) {
    return {
      wasCompacted: false,
      consecutiveFailures: tracking?.consecutiveFailures,
      skippedReason: `auto-compaction gave up after ${MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES} consecutive failures`,
    };
  }
  const tokenCount = Math.max(
    0,
    estimateMessagesTokens(messages, context, {
      // Local admission already fits the output reservation to remaining room.
      // The proactive threshold separately reserves context headroom; charging
      // the nominal output again can compact a single short first message.
      // Forced/reactive and model-downshift paths retain their full accounting.
      inputOnly: options.force !== true && querySource !== "model_downshift" &&
        usesLocalToolProfile(context.provider?.name),
    }) - snipTokensFreed,
  );
  if (options.force !== true && tokenCount < autoCompactThreshold(context)) {
    return { wasCompacted: false, consecutiveFailures: 0 };
  }
  const { compactConversation } = await import("./compact.js");
  let transientRetries = 0;
  for (;;) {
    try {
      // Every destructive compaction uses the canonical transaction. Session
      // memory remains recall input; it is never an unauthenticated replacement
      // history or a bypass around pin/intent/provider validation/commit.
      const compactionResult = await compactConversation(
        messages,
        context,
        tier === "aggressive_summary"
          ? AGGRESSIVE_COMPACTION_FOCUS
          : tier === "emergency_local"
            ? EMERGENCY_COMPACTION_FOCUS
            : "",
        tier === "standard"
          ? {}
          : {
              keepCount: 0,
              ...(tier === "emergency_local"
                ? { summarizer: (await import("./emergency-summarizer.js")).createRuntimeEmergencySummarizer() }
                : {}),
            },
      );
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
        error instanceof CompactionFailurePersistenceError ||
        (error instanceof CompactionTransactionError &&
          (["intent_failed", "commit_failed", "recovery_interrupted"].includes(error.reason) ||
            (error.reason === "pin_failed" && readCompactionTransactionAdapter(context) !== undefined))) ||
        isAbortError(context, error)
      ) {
        throw error;
      }
      if (
        transientRetries < MAX_TRANSIENT_COMPACTION_RETRIES &&
        isTransientProviderError(error) &&
        context.abortController?.signal.aborted !== true
      ) {
        transientRetries += 1;
        await transientRetryDelay(context);
        continue;
      }
      return {
        wasCompacted: false,
        // Tier attempts neither read nor bump the standard breaker.
        consecutiveFailures:
          tier === "standard"
            ? (tracking?.consecutiveFailures ?? 0) + 1
            : (tracking?.consecutiveFailures ?? 0),
        ...(error instanceof CompactionCannotReduceError
          ? { skippedCode: error.code }
          : {}),
        ...(error instanceof CompactionTransactionError
          ? { skippedFailureReason: error.reason }
          : {}),
        ...(error instanceof CompactionSummaryRejectedError
          ? { advisoryFailure: "summary_rejected" as const }
          : {}),
        skippedReason:
          error instanceof Error && error.message.trim().length > 0
            ? error.message
            : String(error),
        skippedDetails: compactionFailureDetails(error),
      };
    }
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

function autoCompactThreshold(context: CompactContext): number {
  return getAutoCompactThreshold(context);
}
