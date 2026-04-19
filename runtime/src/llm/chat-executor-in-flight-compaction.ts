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
import { reattachRecentFilesOnCompaction } from "./compact/post-compact-attachments.js";

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
    // Derive the number of items kept AFTER the newly-minted boundary
    // (preserved-multimodal + keep-tail messages). Falls back to the
    // legacy "everything except index 0" assumption for shapes that do
    // not expose the new-boundary split (e.g. the trivial-history
    // early-exit path).
    const retainedAfterNewBoundaryCount =
      compacted.retainedAfterNewBoundaryCount ??
      Math.max(0, compacted.history.length - 1);
    const newBoundaryMessage: LLMMessage =
      compacted.boundaryMessage ??
      ({
        role: "system" as const,
        content:
          typeof compacted.history[0]?.content === "string"
            ? (compacted.history[0].content as string)
            : "",
      });
    // Snapshot the top-N most-recently-read files and build anchor
    // messages to re-inject their bytes immediately after the boundary.
    // Mirrors Claude Code's `createPostCompactFileAttachments`: after
    // compaction, the raw tool_result bytes are gone from the prompt,
    // so the model would otherwise re-call `system.readFile` for the
    // same paths round after round. Anchors short-circuit that. Also
    // clears the in-memory read cache so the FILE_UNCHANGED_STUB
    // short-circuit does not point at content that has been
    // summarized away.
    const anchorFileMessages = reattachRecentFilesOnCompaction(ctx.sessionId);
    const replayTailReconciliationMessages = (
      input.callReconciliationMessages ?? ctx.reconciliationMessages
    ).slice(replayTailStartIndex);
    const replayTailSections = (
      input.callSections ?? ctx.messageSections
    ).slice(replayTailStartIndex);
    const anchorReconciliationMessages: readonly LLMMessage[] = anchorFileMessages.map(
      (message) => ({
        role: "system" as const,
        content:
          typeof message.content === "string"
            ? (message.content as string)
            : "",
      }),
    );
    const anchorSections: readonly PromptBudgetSection[] = anchorFileMessages.map(
      () => "memory_working",
    );
    const compactedReconciliationMessages: readonly LLMMessage[] = [
      {
        role: "system",
        content:
          typeof newBoundaryMessage.content === "string"
            ? newBoundaryMessage.content
            : "",
      },
      ...anchorReconciliationMessages,
      ...replayTailReconciliationMessages.slice(-retainedAfterNewBoundaryCount),
    ];
    const compactedSections: readonly PromptBudgetSection[] = [
      "memory_working",
      ...anchorSections,
      ...replayTailSections.slice(-retainedAfterNewBoundaryCount),
    ];
    // Build the final compacted history. Structure:
    //   [...head, ...priorBoundaries, newBoundary, ...anchors, ...preserved, ...toKeep]
    // The prior boundaries (if any) come from `compacted.history` up to
    // the new boundary. Anchors are spliced immediately after the new
    // boundary so they sit inside the cacheable prefix but before the
    // recent tail.
    const newBoundaryIndex = compacted.history.indexOf(newBoundaryMessage);
    const beforeNewBoundary =
      newBoundaryIndex >= 0
        ? compacted.history.slice(0, newBoundaryIndex + 1)
        : [compacted.history[0]].filter(
            (entry): entry is LLMMessage => entry !== undefined,
          );
    const afterNewBoundary =
      newBoundaryIndex >= 0
        ? compacted.history.slice(newBoundaryIndex + 1)
        : compacted.history.slice(1);
    const nextMessages = [
      ...input.callMessages.slice(0, replayTailStartIndex),
      ...beforeNewBoundary,
      ...anchorFileMessages,
      ...afterNewBoundary,
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
    // NOTE: we already cleared the read cache inside
    // `reattachRecentFilesOnCompaction`. `runPostCompactCleanup` is
    // retained for any additional per-session cleanup the compact
    // module may grow in the future (currently it only clears the
    // read cache, which is now a no-op on second call).
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
