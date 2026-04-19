/**
 * History compaction extracted from `ChatExecutor` (Phase F PR-6
 * of the plan in TODO.MD).
 *
 * `compactHistory` summarizes an existing conversation history into
 * a shorter "durable task state" form, then merges the summary into
 * the executor's artifact-backed compaction state. It is the
 * bottleneck that initializeExecutionContext() and the in-flight
 * compaction flow both share when the session's soft/hard token
 * budget is exceeded.
 *
 * Threaded as a pure free function that takes every class-state
 * reference as an explicit dependency (providers, cooldowns,
 * promptBudget, retry matrix, cooldown bounds, optional
 * onCompaction hook).
 *
 * @module
 */

import { annotateFailureError } from "./chat-executor-provider-retry.js";
import { getCompactPrompt, formatCompactSummary } from "./compact/prompt.js";
import { callWithFallback } from "./chat-executor-fallback.js";
import {
  compactHistoryIntoArtifactContext,
  createCompactBoundaryMessage,
  isCompactBoundaryMessage,
} from "./context-compaction.js";
import { MAX_COMPACT_INPUT } from "./chat-executor-constants.js";
import type { ArtifactCompactionState } from "../memory/artifact-store.js";
import type { CooldownEntry, ChatExecuteParams } from "./chat-executor-types.js";
import type { LLMMessage, LLMProvider } from "./types.js";
import type { LLMRetryPolicyMatrix } from "./policy.js";
import type { PromptBudgetConfig } from "./prompt-budget.js";
import { tokenCountWithEstimation } from "./compact/token-count.js";
import {
  MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES,
} from "./compact/autocompact.js";

/**
 * Dependency struct for `compactHistory`. Contains every
 * construction-time config value the summarization call needs,
 * plus the optional post-compaction hook.
 */
export interface HistoryCompactionDependencies {
  readonly providers: readonly LLMProvider[];
  readonly cooldowns: Map<string, CooldownEntry>;
  readonly promptBudget: PromptBudgetConfig;
  readonly retryPolicyMatrix: LLMRetryPolicyMatrix;
  readonly cooldownMs: number;
  readonly maxCooldownMs: number;
  readonly onCompaction?: (sessionId: string, summary: string) => void;
}

export interface SessionMemoryCompactionResult {
  readonly history: readonly LLMMessage[];
  readonly artifactContext: ArtifactCompactionState;
  readonly postCompactTokenCount: number;
  /** The newly-minted boundary message (the one produced by this pass). */
  readonly boundaryMessage: LLMMessage;
  /** Count of messages in `history` that come AFTER `boundaryMessage`. */
  readonly retainedAfterNewBoundaryCount: number;
}

const DEFAULT_SESSION_MEMORY_COMPACT_KEEP_TAIL = 3;
const CONTEXT_COLLAPSE_TRIGGER_FRACTION = 0.9;

/**
 * Summarize the durable task state out of an existing history and
 * merge it back into an artifact-backed compaction state. Preserves
 * the exact pre-Phase-F observable behavior: the narrative summary
 * is produced by a single `callWithFallback` call with `toolChoice:
 * "none"`, the durable state is recorded via
 * `compactHistoryIntoArtifactContext`, and the optional
 * `onCompaction` hook fires with the final summary text.
 *
 * Phase F extraction (PR-6). Previously
 * `ChatExecutor.compactHistory`.
 */
export async function compactHistory(
  history: readonly LLMMessage[],
  sessionId: string,
  deps: HistoryCompactionDependencies,
  options?: {
    readonly trace?: ChatExecuteParams["trace"];
    readonly existingArtifactContext?: ArtifactCompactionState;
    readonly keepTailCount?: number;
  },
): Promise<{
  readonly history: readonly LLMMessage[];
  readonly artifactContext?: ArtifactCompactionState;
  readonly boundaryMessage?: LLMMessage;
  readonly retainedAfterNewBoundaryCount?: number;
}> {
  const effectiveKeepTailCount = Math.max(1, options?.keepTailCount ?? 5);
  if (history.length <= effectiveKeepTailCount) {
    return {
      history: [...history],
      artifactContext: options?.existingArtifactContext,
    };
  }

  let narrativeSummary: string | undefined;
  const toSummarize = history.slice(0, history.length - effectiveKeepTailCount);
  // Skip pre-existing compact boundary markers — they have already been
  // summarized and re-feeding them to the summarizer produces nested
  // "summary of a summary" text that still changes turn-to-turn and
  // invalidates the provider's prompt cache past the first boundary.
  const summarizableMessages = toSummarize.filter(
    (message) => !isCompactBoundaryMessage(message),
  );
  let historyText = summarizableMessages
    .map((message) => {
      const content =
        typeof message.content === "string"
          ? message.content
          : message.content
              .filter(
                (part): part is { type: "text"; text: string } =>
                  part.type === "text",
              )
              .map((part) => part.text)
              .join(" ");
      return `[${message.role}] ${content.slice(0, 500)}`;
    })
    .join("\n");
  if (historyText.length > MAX_COMPACT_INPUT) {
    historyText = historyText.slice(-MAX_COMPACT_INPUT);
  }
  try {
    const compactResponse = await callWithFallback(
      {
        providers: deps.providers,
        cooldowns: deps.cooldowns,
        promptBudget: deps.promptBudget,
        retryPolicyMatrix: deps.retryPolicyMatrix,
        cooldownMs: deps.cooldownMs,
        maxCooldownMs: deps.maxCooldownMs,
      },
      [
        { role: "system", content: getCompactPrompt() },
        { role: "user", content: historyText },
      ],
      undefined,
      undefined,
      {
        ...(options?.trace
          ? {
              trace: options.trace,
              callIndex: 0,
              callPhase: "compaction" as const,
            }
          : {}),
        routedToolNames: [],
        toolChoice: "none",
        parallelToolCalls: false,
      },
    );
    narrativeSummary =
      formatCompactSummary(compactResponse.response.content).trim() || undefined;
  } catch (error) {
    throw annotateFailureError(error, "history compaction").error;
  }

  const compacted = compactHistoryIntoArtifactContext({
    sessionId,
    history,
    keepTailCount: effectiveKeepTailCount,
    source: "executor_compaction",
    existingState: options?.existingArtifactContext,
    ...(narrativeSummary ? { narrativeSummary } : {}),
  });

  if (deps.onCompaction) {
    try {
      deps.onCompaction(
        sessionId,
        narrativeSummary && narrativeSummary.trim().length > 0
          ? narrativeSummary
          : compacted.summaryText,
      );
    } catch {
      /* non-blocking */
    }
  }

  const newBoundaryIndex = compacted.compactedHistory.indexOf(
    compacted.boundaryMessage,
  );
  const retainedAfterNewBoundaryCount =
    newBoundaryIndex >= 0
      ? compacted.compactedHistory.length - newBoundaryIndex - 1
      : Math.max(0, compacted.compactedHistory.length - 1);
  return {
    history: compacted.compactedHistory,
    artifactContext: compacted.state,
    boundaryMessage: compacted.boundaryMessage,
    retainedAfterNewBoundaryCount,
  };
}

export function trySessionMemoryCompaction(params: {
  readonly history: readonly LLMMessage[];
  readonly sessionId: string;
  readonly existingArtifactContext?: ArtifactCompactionState;
  readonly keepTailCount?: number;
  readonly thresholdTokens?: number;
}): SessionMemoryCompactionResult | null {
  const keepTailCount = Math.max(
    1,
    params.keepTailCount ?? DEFAULT_SESSION_MEMORY_COMPACT_KEEP_TAIL,
  );
  if (params.history.length <= keepTailCount) {
    return null;
  }

  const compacted = compactHistoryIntoArtifactContext({
    sessionId: params.sessionId,
    history: params.history,
    keepTailCount,
    source: "executor_compaction",
    existingState: params.existingArtifactContext,
  });
  const postCompactTokenCount = tokenCountWithEstimation({
    messages: compacted.compactedHistory,
  });
  if (
    params.thresholdTokens !== undefined &&
    postCompactTokenCount >= params.thresholdTokens
  ) {
    return null;
  }
  const newBoundaryIndex = compacted.compactedHistory.indexOf(
    compacted.boundaryMessage,
  );
  const retainedAfterNewBoundaryCount =
    newBoundaryIndex >= 0
      ? compacted.compactedHistory.length - newBoundaryIndex - 1
      : Math.max(0, compacted.compactedHistory.length - 1);
  return {
    history: compacted.compactedHistory,
    artifactContext: compacted.state,
    postCompactTokenCount,
    boundaryMessage: compacted.boundaryMessage,
    retainedAfterNewBoundaryCount,
  };
}

export function tryProjectedContextCollapse(params: {
  readonly history: readonly LLMMessage[];
  readonly sessionId: string;
  readonly existingArtifactContext?: ArtifactCompactionState;
  readonly autocompactThresholdTokens?: number;
  readonly keepTailCount?: number;
}): {
  readonly history: readonly LLMMessage[];
  readonly artifactContext: ArtifactCompactionState;
  readonly boundary: LLMMessage;
} | null {
  const thresholdTokens = params.autocompactThresholdTokens;
  if (
    thresholdTokens === undefined ||
    thresholdTokens <= 0 ||
    tokenCountWithEstimation({ messages: params.history }) <
      Math.floor(thresholdTokens * CONTEXT_COLLAPSE_TRIGGER_FRACTION)
  ) {
    return null;
  }
  const collapsed = trySessionMemoryCompaction({
    history: params.history,
    sessionId: params.sessionId,
    existingArtifactContext: params.existingArtifactContext,
    keepTailCount: params.keepTailCount ?? 6,
    thresholdTokens,
  });
  if (!collapsed) {
    return null;
  }
  return {
    history: collapsed.history,
    artifactContext: collapsed.artifactContext,
    boundary: createCompactBoundaryMessage({
      boundaryId: collapsed.artifactContext.snapshotId,
      source: "executor_compaction",
      sourceMessageCount: collapsed.artifactContext.sourceMessageCount,
      retainedTailCount: collapsed.artifactContext.retainedTailCount,
      summaryText:
        "context-collapse projected older messages into the compact artifact snapshot",
    }),
  };
}

export function shouldSkipHistoryCompactionForCircuitBreaker(
  consecutiveFailures: number,
): boolean {
  return consecutiveFailures >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES;
}
