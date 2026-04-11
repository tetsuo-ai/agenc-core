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
import { callWithFallback } from "./chat-executor-fallback.js";
import { compactHistoryIntoArtifactContext } from "./context-compaction.js";
import { MAX_COMPACT_INPUT } from "./chat-executor-constants.js";
import type { ArtifactCompactionState } from "../memory/artifact-store.js";
import type { CooldownEntry, ChatExecuteParams } from "./chat-executor-types.js";
import type { LLMMessage, LLMProvider } from "./types.js";
import type { LLMRetryPolicyMatrix } from "./policy.js";
import type { PromptBudgetConfig } from "./prompt-budget.js";

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
  let historyText = toSummarize
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
        {
          role: "system",
          content:
            "Summarize only the durable task state from this history. Preserve key decisions, important tool outcomes, current artifacts, explicit blockers, and unfinished implementation or verification work. " +
            "If the history contains stubs, placeholders, partial work, denied commands, or anything still needing verification, list that as unresolved work. " +
            "Never say there is no unresolved work unless the history explicitly shows final completion and verification closure. Omit pleasantries.",
        },
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
    narrativeSummary = compactResponse.response.content.trim() || undefined;
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

  return {
    history: compacted.compactedHistory,
    artifactContext: compacted.state,
  };
}
