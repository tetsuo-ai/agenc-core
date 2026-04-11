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
  ChatBudgetExceededError,
  type CooldownEntry,
  type ExecutionContext,
} from "./chat-executor-types.js";
import { getSessionCompactionState } from "./chat-executor-state.js";
import type {
  HistoryCompactionDependencies,
} from "./chat-executor-history-compaction.js";
import { compactHistory } from "./chat-executor-history-compaction.js";
import type { LLMMessage } from "./types.js";
import type { PromptBudgetSection } from "./prompt-budget.js";

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
  const compactionState = getSessionCompactionState(
    deps.sessionTokens,
    ctx.sessionId,
    deps.sessionTokenBudget,
    deps.sessionCompactionThreshold,
  );
  const statefulHistoryCompacted =
    input.statefulHistoryCompacted === true || ctx.compacted;
  if (
    !compactionState.hardBudgetReached &&
    !compactionState.softThresholdReached
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
    if (compactionState.hardBudgetReached) {
      throw new ChatBudgetExceededError(
        ctx.sessionId,
        compactionState.used,
        deps.sessionTokenBudget!,
      );
    }
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
    if (compactionState.hardBudgetReached) {
      throw new ChatBudgetExceededError(
        ctx.sessionId,
        compactionState.used,
        deps.sessionTokenBudget!,
      );
    }
    return {
      callMessages: input.callMessages,
      callReconciliationMessages: input.callReconciliationMessages,
      callSections: input.callSections,
      statefulHistoryCompacted,
    };
  }

  const cooldownSnapshot = compactionState.hardBudgetReached
    ? undefined
    : new Map<string, CooldownEntry>(deps.cooldowns);
  try {
    const compacted = await compactHistory(
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
    helpers.resetSessionTokens(ctx.sessionId);
    return {
      callMessages: ctx.messages,
      callReconciliationMessages: ctx.reconciliationMessages,
      callSections: ctx.messageSections,
      statefulHistoryCompacted: true,
    };
  } catch (error) {
    if (compactionState.hardBudgetReached) {
      if (error instanceof ChatBudgetExceededError) {
        throw error;
      }
      throw new ChatBudgetExceededError(
        ctx.sessionId,
        compactionState.used,
        deps.sessionTokenBudget!,
      );
    }
    if (cooldownSnapshot) {
      deps.cooldowns.clear();
      for (const [providerName, cooldown] of cooldownSnapshot.entries()) {
        deps.cooldowns.set(providerName, cooldown);
      }
    }
    return {
      callMessages: input.callMessages,
      callReconciliationMessages: input.callReconciliationMessages,
      callSections: input.callSections,
      statefulHistoryCompacted,
    };
  }
}
