/**
 * In-flight call input compaction extracted from `ChatExecutor`
 * (Phase F PR-6 of the plan in TODO.MD).
 *
 * `maybeCompactInFlightCallInput` inspects the current session's
 * token-budget state and, if the hard or soft threshold has been
 * crossed, rewrites the pending call messages to a compacted form
 * before handing them to the provider. When the in-flight messages
 * come from the live execution ctx, the rewritten history is also
 * mirrored back onto `ctx.messages`, `ctx.reconciliationMessages`,
 * and `ctx.messageSections` so subsequent calls reuse the compacted
 * state.
 *
 * Threaded as a free function that takes the executor state
 * (sessionTokens, cooldowns, budget thresholds) plus a compaction
 * helper dependency. Keeps the cooldown snapshot/restore semantics
 * identical to the pre-Phase-F class implementation: on soft-threshold
 * failure the cooldowns are restored to the pre-call snapshot so the
 * fallback chain is not degraded by the failed compaction attempt
 * alone.
 *
 * @module
 */

import { findInFlightCompactionTailStartIndex } from "./chat-executor-tool-loop.js";
import {
  type CooldownEntry,
  type ExecutionContext,
} from "./chat-executor-types.js";
import { buildCurrentContextUsageSnapshot } from "./compact/context-window.js";
import type {
  HistoryCompactionDependencies,
} from "./chat-executor-history-compaction.js";
import {
  compactHistory,
  shouldSkipHistoryCompactionForCircuitBreaker,
  trySessionMemoryCompaction,
} from "./chat-executor-history-compaction.js";
import type { LLMMessage } from "./types.js";
import type { PromptBudgetSection } from "./prompt-budget.js";
import {
  markAutocompactFailure,
  markAutocompactSuccess,
} from "./compact/autocompact.js";
import { runPostCompactCleanup } from "./compact/post-compact-cleanup.js";

/**
 * Dependency struct for `maybeCompactInFlightCallInput`.
 * Bundles the executor state plus the downstream history compaction
 * config so the helper can summon the durable state summary itself
 * when the soft/hard session budget has been crossed.
 */
export interface InFlightCompactionDependencies
  extends HistoryCompactionDependencies {
  readonly sessionTokens: Map<string, number>;
  readonly sessionTokenBudget: number | undefined;
  readonly sessionCompactionThreshold: number | undefined;
}

/**
 * Helper callbacks that mutate executor state outside the scope of
 * this module. Only `resetSessionTokens` is needed — cooldowns are
 * mutated directly via the deps Map because the snapshot/restore
 * path is localized to this function.
 */
export interface InFlightCompactionHelpers {
  readonly resetSessionTokens: (sessionId: string) => void;
}

/**
 * Attempt to compact the in-flight call input when the session's
 * token budget has been crossed. Returns the (possibly rewritten)
 * call messages/sections/reconciliation-messages shape that the
 * provider call should use.
 *
 * Phase F extraction (PR-6). Previously
 * `ChatExecutor.maybeCompactInFlightCallInput`.
 */
export async function maybeCompactInFlightCallInput(
  ctx: ExecutionContext,
  input: {
    readonly callMessages: readonly LLMMessage[];
    readonly callReconciliationMessages?: readonly LLMMessage[];
    readonly callSections?: readonly PromptBudgetSection[];
    readonly statefulHistoryCompacted?: boolean;
  },
  deps: InFlightCompactionDependencies,
  helpers: InFlightCompactionHelpers,
): Promise<{
  readonly callMessages: readonly LLMMessage[];
  readonly callReconciliationMessages?: readonly LLMMessage[];
  readonly callSections?: readonly PromptBudgetSection[];
  readonly statefulHistoryCompacted: boolean;
}> {
  const compactionState = buildCurrentContextUsageSnapshot({
    messages: input.callMessages,
    contextWindowTokens: deps.promptBudget.contextWindowTokens,
    maxOutputTokens: deps.promptBudget.maxOutputTokens,
    lastResponseUsage: ctx.response?.usage,
  });
  const statefulHistoryCompacted =
    input.statefulHistoryCompacted === true || ctx.compacted;
  if (
    compactionState.isAboveAutocompactThreshold &&
    shouldSkipHistoryCompactionForCircuitBreaker(
      ctx.perIterationCompaction.autocompact.consecutiveFailures,
    )
  ) {
    return {
      callMessages: input.callMessages,
      callReconciliationMessages: input.callReconciliationMessages,
      callSections: input.callSections,
      statefulHistoryCompacted,
    };
  }
  if (
    !compactionState.isAboveAutocompactThreshold
  ) {
    return {
      callMessages: input.callMessages,
      callReconciliationMessages: input.callReconciliationMessages,
      callSections: input.callSections,
      statefulHistoryCompacted,
    };
  }

  const usesLiveExecutionMessages =
    input.callMessages === ctx.messages &&
    (
      input.callSections === undefined ||
      input.callSections === ctx.messageSections
    ) &&
    (
      input.callReconciliationMessages === undefined ||
      input.callReconciliationMessages === ctx.reconciliationMessages
    );
  if (!usesLiveExecutionMessages) {
    return {
      callMessages: input.callMessages,
      callReconciliationMessages: input.callReconciliationMessages,
      callSections: input.callSections,
      statefulHistoryCompacted,
    };
  }

  const replayTailStartIndex = findInFlightCompactionTailStartIndex(
    input.callMessages,
    input.callSections,
  );
  const replayTail = input.callMessages.slice(replayTailStartIndex);
  const inFlightKeepTailCount = 3;
  if (replayTail.length <= inFlightKeepTailCount) {
    return {
      callMessages: input.callMessages,
      callReconciliationMessages: input.callReconciliationMessages,
      callSections: input.callSections,
      statefulHistoryCompacted,
    };
  }

  const cooldownSnapshot = new Map<string, CooldownEntry>(deps.cooldowns);
  try {
    const compacted =
      trySessionMemoryCompaction({
        history: replayTail,
        sessionId: ctx.sessionId,
        existingArtifactContext: ctx.compactedArtifactContext,
        keepTailCount: inFlightKeepTailCount,
        thresholdTokens: compactionState.autocompactThresholdTokens,
      }) ??
      await compactHistory(
        replayTail,
        ctx.sessionId,
        deps,
        {
          ...(ctx.trace ? { trace: ctx.trace } : {}),
          ...(ctx.compactedArtifactContext
            ? { existingArtifactContext: ctx.compactedArtifactContext }
            : {}),
          keepTailCount: inFlightKeepTailCount,
        },
      );
    const retainedTailCount = Math.max(0, compacted.history.length - 1);
    const replayTailReconciliationMessages = (
      input.callReconciliationMessages ?? ctx.reconciliationMessages
    ).slice(replayTailStartIndex);
    const replayTailSections = (
      input.callSections ?? ctx.messageSections
    ).slice(replayTailStartIndex);
    const compactedReconciliationMessages: readonly LLMMessage[] = [
      {
        role: "system",
        content:
          typeof compacted.history[0]?.content === "string"
            ? compacted.history[0].content
            : "",
      },
      ...replayTailReconciliationMessages.slice(-retainedTailCount),
    ];
    const compactedSections: readonly PromptBudgetSection[] = [
      "memory_working",
      ...replayTailSections.slice(-retainedTailCount),
    ];
    const nextMessages = [
      ...input.callMessages.slice(0, replayTailStartIndex),
      ...compacted.history,
    ];
    const nextReconciliationMessages = [
      ...(input.callReconciliationMessages ?? ctx.reconciliationMessages).slice(
        0,
        replayTailStartIndex,
      ),
      ...compactedReconciliationMessages,
    ];
    const nextSections = [
      ...(input.callSections ?? ctx.messageSections).slice(
        0,
        replayTailStartIndex,
      ),
      ...compactedSections,
    ];
    ctx.messages = [...nextMessages];
    ctx.reconciliationMessages = [...nextReconciliationMessages];
    ctx.messageSections = [...nextSections];
    ctx.compacted = true;
    ctx.compactedArtifactContext = compacted.artifactContext;
    runPostCompactCleanup(ctx.sessionId);
    ctx.perIterationCompaction = {
      ...ctx.perIterationCompaction,
      autocompact: markAutocompactSuccess(
        ctx.perIterationCompaction.autocompact,
      ),
    };
    helpers.resetSessionTokens(ctx.sessionId);
    return {
      callMessages: ctx.messages,
      callReconciliationMessages: ctx.reconciliationMessages,
      callSections: ctx.messageSections,
      statefulHistoryCompacted: true,
    };
  } catch (error) {
    ctx.perIterationCompaction = {
      ...ctx.perIterationCompaction,
      autocompact: markAutocompactFailure(
        ctx.perIterationCompaction.autocompact,
      ),
    };
    deps.cooldowns.clear();
    for (const [providerName, cooldown] of cooldownSnapshot.entries()) {
      deps.cooldowns.set(providerName, cooldown);
    }
    return {
      callMessages: input.callMessages,
      callReconciliationMessages: input.callReconciliationMessages,
      callSections: input.callSections,
      statefulHistoryCompacted,
    };
  }
}
