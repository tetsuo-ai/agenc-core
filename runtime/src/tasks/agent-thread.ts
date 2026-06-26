/**
 * AgentThread adapter for the background task lifecycle.
 *
 * This file is intentionally structural. The lifecycle can be used by tests
 * and future model-facing TaskOutput/TaskStop tools without importing the
 * full agent control plane.
 *
 * @module
 */

import type { AgentStatus } from "../agents/status.js";
import type { RunAgentResult } from "../agents/run-agent.js";
import type { LLMMessage } from "../llm/types.js";
import type {
  CacheSafeParams,
  ForkedAgentResult,
} from "../services/PromptSuggestion/runtime.js";
import type { Message } from "../types/message.js";
import type { BackgroundTaskSnapshot } from "./lifecycle.js";
import { BackgroundTaskLifecycle } from "./lifecycle.js";
import {
  startAgentSummarization,
  type AgentSummaryHandle,
  type AgentSummaryRunForkedAgentParams,
} from "../services/AgentSummary/agentSummary.js";
import { llmMessageToAgentSummaryMessage } from "../services/AgentSummary/transcript.js";

function finalMessageMetadata(
  finalMessage: string | undefined,
): Readonly<Record<string, unknown>> | undefined {
  if (finalMessage === undefined || finalMessage.trim().length === 0) {
    return undefined;
  }
  return { finalMessage };
}

/**
 * Derive the live per-agent tool-use + token counts for a spawned
 * subagent. For DAEMON/collab-spawned agents the runner accumulates token
 * usage on `live.tokenUsage` and records tool calls in the live transcript;
 * this reads both so the fan-out rail reflects real activity instead of 0.
 * Returns `undefined` when neither signal is available (so we don't clobber
 * a previously-recorded progress with zeros).
 */
function liveAgentCounts(
  thread: AgentThreadTaskHandle,
): { readonly toolUseCount: number; readonly tokenCount: number } | undefined {
  const tokenCount = thread.live.tokenUsage?.totalTokens;
  const messages = thread.live.messages;
  let toolUseCount = 0;
  let sawMessages = false;
  if (messages !== undefined) {
    sawMessages = true;
    for (const message of messages) {
      const calls = message.toolCalls;
      if (calls !== undefined) toolUseCount += calls.length;
    }
  }
  if (tokenCount === undefined && !sawMessages) return undefined;
  return { toolUseCount, tokenCount: tokenCount ?? 0 };
}

export interface AgentThreadTaskHandle {
  readonly threadId?: string;
  readonly threadName?: string;
  readonly nickname?: string;
  readonly agentPath?: string;
  readonly taskPrompt: string;
  readonly worktreePath?: string;
  readonly worktreeBranch?: string;
  readonly messages?: ReadonlyArray<LLMMessage>;
  readonly summaryMessages?: ReadonlyArray<Message>;
  readonly summaryCacheSafeParams?: CacheSafeParams;
  onSummaryCacheSafeParams?(
    listener: (params: CacheSafeParams) => void,
  ): () => void;
  readonly live: {
    readonly agentId: string;
    readonly agentPath?: string;
    readonly abortController?: AbortController;
    readonly status: {
      readonly value: AgentStatus;
      subscribe?: (listener: (status: AgentStatus) => void) => () => void;
    };
    /**
     * Cumulative token usage for this live subagent. Populated by the
     * runner's per-turn `usage_update` accumulation (run-agent.ts). Read
     * each time a status snapshot is emitted so the fan-out rail shows
     * real per-agent token counts for DAEMON/collab-spawned agents, not 0.
     */
    readonly tokenUsage?: { readonly totalTokens?: number };
    /**
     * Live child transcript. Assistant messages carry `toolCalls`; their
     * total length is the per-agent tool-use count surfaced on the rail.
     */
    readonly messages?: ReadonlyArray<LLMMessage>;
  };
  join(): Promise<RunAgentResult>;
}

export interface RegisterAgentThreadTaskOptions {
  readonly toolUseId?: string;
  readonly description?: string;
  readonly onStop?: (thread: AgentThreadTaskHandle, reason: string) => Promise<void> | void;
  readonly onSnapshot?: (snapshot: BackgroundTaskSnapshot) => void;
  /**
   * Cadence (ms) for polling the live subagent's accumulated token/tool
   * counters and emitting refreshed progress snapshots. Defaults to 1000ms.
   * Set to `0` to disable the poller (tests that drive snapshots manually).
   */
  readonly progressIntervalMs?: number;
  readonly summary?: {
    readonly cacheSafeParams?: CacheSafeParams;
    readonly intervalMs?: number;
    readonly runForkedAgent?: (
      params: AgentSummaryRunForkedAgentParams,
    ) => Promise<ForkedAgentResult>;
    readonly logDebug?: (message: string) => void;
    readonly logError?: (error: unknown) => void;
  };
}

export function registerAgentThreadTask(
  lifecycle: BackgroundTaskLifecycle,
  thread: AgentThreadTaskHandle,
  opts: RegisterAgentThreadTaskOptions = {},
): BackgroundTaskSnapshot {
  const threadId = thread.threadId ?? thread.live.agentId;
  const description = opts.description ?? thread.taskPrompt;
  const agentPath = thread.agentPath ?? thread.live.agentPath;
  let summaryHandle: AgentSummaryHandle | null = null;
  let unsubscribeSummaryCacheSafeParams: (() => void) | null = null;
  const stopSummary = (): void => {
    summaryHandle?.stop();
    summaryHandle = null;
    unsubscribeSummaryCacheSafeParams?.();
    unsubscribeSummaryCacheSafeParams = null;
  };
  // Refresh the lifecycle record's progress from the live subagent's
  // accumulated counters before a snapshot is emitted. This is the hop that
  // was missing for DAEMON/collab-spawned agents: their token usage + tool
  // calls accumulate on the live handle, but nothing copied them into the
  // task progress the fan-out rail reads — so every row showed `tools 0
  // tokens 0`. `updateAgentProgress` is a no-op on terminal records, so the
  // final counts captured on the last running snapshot survive into the
  // completion snapshot.
  const refreshLiveProgress = (): BackgroundTaskSnapshot | undefined => {
    const counts = liveAgentCounts(thread);
    if (counts === undefined) return undefined;
    try {
      return lifecycle.updateAgentProgress(threadId, {
        toolUseCount: counts.toolUseCount,
        tokenCount: counts.tokenCount,
      });
    } catch {
      // The record may already be removed/terminal when a late status
      // transition arrives; dropping the progress update is harmless.
      return undefined;
    }
  };
  const notifySnapshot = (snapshot: BackgroundTaskSnapshot): BackgroundTaskSnapshot => {
    opts.onSnapshot?.(snapshot);
    return snapshot;
  };
  const task = notifySnapshot(lifecycle.register({
    id: threadId,
    type: "local_agent",
    description,
    source: "agent_thread",
    toolUseId: opts.toolUseId,
    ...(agentPath !== undefined ? { aliases: [agentPath] } : {}),
    ...(thread.live.abortController !== undefined
      ? { abortController: thread.live.abortController }
      : {}),
    metadata: {
      threadName: thread.threadName ?? thread.nickname ?? thread.threadId,
      ...(agentPath !== undefined ? { agentPath } : {}),
      ...(thread.worktreePath !== undefined
        ? { worktreePath: thread.worktreePath }
        : {}),
      ...(thread.worktreeBranch !== undefined
        ? { worktreeBranch: thread.worktreeBranch }
        : {}),
    },
    onStop: async (reason) => {
      stopProgressTimer();
      stopSummary();
      if (opts.onStop) {
        await opts.onStop(thread, reason);
        return;
      }
      if (
        thread.live.abortController !== undefined &&
        !thread.live.abortController.signal.aborted
      ) {
        thread.live.abortController.abort(reason);
      }
    },
  }));

  const startSummary = (cacheSafeParams: CacheSafeParams): void => {
    if (summaryHandle !== null) return;
    const summaryRuntime = opts.summary;
    summaryHandle = startAgentSummarization({
      taskId: threadId,
      agentId: thread.live.agentId,
      cacheSafeParams,
      getAgentTranscript: async () => agentTranscriptFromThread(thread),
      updateAgentSummary: (taskId, summary) => {
        lifecycle.updateAgentSummary(taskId, summary);
      },
      ...(summaryRuntime?.intervalMs !== undefined
        ? { intervalMs: summaryRuntime.intervalMs }
        : {}),
      ...(summaryRuntime?.runForkedAgent !== undefined
        ? { runForkedAgent: summaryRuntime.runForkedAgent }
        : {}),
      ...(summaryRuntime?.logDebug !== undefined
        ? { logDebug: summaryRuntime.logDebug }
        : {}),
      ...(summaryRuntime?.logError !== undefined
        ? { logError: summaryRuntime.logError }
        : {}),
    });
  };

  const immediateCacheSafeParams =
    opts.summary?.cacheSafeParams ?? thread.summaryCacheSafeParams;
  if (
    immediateCacheSafeParams !== undefined &&
    !isTerminalAgentStatus(thread.live.status.value)
  ) {
    startSummary(immediateCacheSafeParams);
  } else if (
    !isTerminalAgentStatus(thread.live.status.value) &&
    typeof thread.onSummaryCacheSafeParams === "function"
  ) {
    unsubscribeSummaryCacheSafeParams = thread.onSummaryCacheSafeParams(
      (cacheSafeParams) => {
        if (isTerminalAgentStatus(thread.live.status.value)) return;
        startSummary(cacheSafeParams);
      },
    );
  }

  // Status transitions alone are too coarse to surface live progress: a
  // collab/daemon subagent stays "running" for its whole turn, so without a
  // periodic refresh the rail would hold `tools 0 tokens 0` until completion.
  // Poll the live handle's accumulated counters on a modest cadence and emit
  // a refreshed snapshot whenever they advance, mirroring how the in-process
  // AgentTool path emits progress per assistant message.
  let lastEmittedToolUse = -1;
  let lastEmittedTokens = -1;
  const progressTimer: ReturnType<typeof setInterval> | undefined =
    opts.progressIntervalMs === 0
      ? undefined
      : setInterval(() => {
          if (isTerminalAgentStatus(thread.live.status.value)) return;
          const counts = liveAgentCounts(thread);
          if (counts === undefined) return;
          if (
            counts.toolUseCount === lastEmittedToolUse &&
            counts.tokenCount === lastEmittedTokens
          ) {
            return;
          }
          lastEmittedToolUse = counts.toolUseCount;
          lastEmittedTokens = counts.tokenCount;
          const snapshot = refreshLiveProgress();
          if (snapshot !== undefined) notifySnapshot(snapshot);
        }, opts.progressIntervalMs ?? 1_000);
  if (progressTimer !== undefined && typeof progressTimer.unref === "function") {
    progressTimer.unref();
  }
  const stopProgressTimer = (): void => {
    if (progressTimer !== undefined) clearInterval(progressTimer);
  };

  const unsubscribe =
    typeof thread.live.status.subscribe === "function"
      ? thread.live.status.subscribe((status) => {
          // Refresh live token/tool counts before mapping the status so the
          // resulting snapshot (markRunning/complete/fail) carries them. Runs
          // while the record is still non-terminal so the final counts land
          // on the record before a terminal transition freezes progress.
          refreshLiveProgress();
          const snapshot = mapAgentStatus(lifecycle, threadId, status);
          if (snapshot !== undefined) notifySnapshot(snapshot);
          if (isTerminalAgentStatus(status)) {
            stopProgressTimer();
            stopSummary();
          }
        })
      : () => {};

  const joinPromise = thread.join();
  if (joinPromise && typeof joinPromise.then === "function") {
    lifecycle.bindPromise(threadId, joinPromise, {
      onFulfilled: (result) => {
        // Capture the final live counts while the record is still
        // non-terminal; the imminent complete/fail transition freezes them.
        refreshLiveProgress();
        stopProgressTimer();
        stopSummary();
        unsubscribe();
        switch (result.outcome) {
          case "completed":
            return {
              output: result.finalMessage,
              metadata: {
                durationMs: result.durationMs,
                outcome: result.outcome,
                ...finalMessageMetadata(result.finalMessage),
              },
            };
          case "errored":
            return {
              status: "failed",
              error:
                result.error instanceof Error
                  ? result.error.message
                  : result.error !== undefined
                    ? String(result.error)
                    : "agent failed",
              metadata: {
                durationMs: result.durationMs,
                outcome: result.outcome,
              },
            };
          case "interrupted":
            return {
              status: "failed",
              error: "agent interrupted before completion",
              metadata: {
                durationMs: result.durationMs,
                outcome: result.outcome,
              },
            };
          case "aborted":
            return {
              status: "failed",
              error: "agent aborted before completion",
              metadata: {
                durationMs: result.durationMs,
                outcome: result.outcome,
              },
            };
        }
      },
      onRejected: (error) => {
        refreshLiveProgress();
        stopProgressTimer();
        stopSummary();
        unsubscribe();
        return { error: error instanceof Error ? error.message : String(error) };
      },
      onSnapshot: notifySnapshot,
    });
  }

  refreshLiveProgress();
  const snapshot = mapAgentStatus(lifecycle, threadId, thread.live.status.value);
  if (snapshot !== undefined) notifySnapshot(snapshot);
  if (isTerminalAgentStatus(thread.live.status.value)) {
    stopProgressTimer();
    stopSummary();
  }
  return task;
}

function agentTranscriptFromThread(thread: AgentThreadTaskHandle): {
  readonly messages: readonly Message[];
} {
  if (thread.summaryMessages !== undefined) {
    return { messages: [...thread.summaryMessages] };
  }
  return {
    messages: (thread.messages ?? []).map(llmMessageToAgentSummaryMessage),
  };
}

function isTerminalAgentStatus(status: AgentStatus): boolean {
  return (
    status.status === "completed" ||
    status.status === "errored" ||
    status.status === "shutdown" ||
    status.status === "not_found"
  );
}

function mapAgentStatus(
  lifecycle: BackgroundTaskLifecycle,
  taskId: string,
  status: AgentStatus,
): BackgroundTaskSnapshot | undefined {
  try {
    switch (status.status) {
      case "pending_init":
        return undefined;
      case "running":
        return lifecycle.markRunning(taskId, { turnId: status.turnId });
      case "interrupted":
        return lifecycle.appendOutput(taskId, `\n[agent interrupted: ${status.reason}]\n`);
      case "completed":
        return lifecycle.complete(
          taskId,
          status.lastMessage,
          finalMessageMetadata(status.lastMessage),
        );
      case "errored":
        return lifecycle.fail(taskId, status.error);
      case "shutdown":
        void lifecycle.stop(taskId, "agent shutdown").catch(() => {});
        return undefined;
      case "not_found":
        return lifecycle.fail(taskId, "agent not found");
    }
  } catch {
    // The lifecycle may already be terminal when a late AgentStatus arrives.
    return undefined;
  }
}
