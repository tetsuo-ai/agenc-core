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
  };
  join(): Promise<RunAgentResult>;
}

export interface RegisterAgentThreadTaskOptions {
  readonly toolUseId?: string;
  readonly description?: string;
  readonly onStop?: (thread: AgentThreadTaskHandle, reason: string) => Promise<void> | void;
  readonly onSnapshot?: (snapshot: BackgroundTaskSnapshot) => void;
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

  const unsubscribe =
    typeof thread.live.status.subscribe === "function"
      ? thread.live.status.subscribe((status) => {
          const snapshot = mapAgentStatus(lifecycle, threadId, status);
          if (snapshot !== undefined) notifySnapshot(snapshot);
          if (isTerminalAgentStatus(status)) stopSummary();
        })
      : () => {};

  const joinPromise = thread.join();
  if (joinPromise && typeof joinPromise.then === "function") {
    lifecycle.bindPromise(threadId, joinPromise, {
      onFulfilled: (result) => {
        stopSummary();
        unsubscribe();
        switch (result.outcome) {
          case "completed":
            return {
              output: result.finalMessage,
              metadata: {
                durationMs: result.durationMs,
                outcome: result.outcome,
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
        stopSummary();
        unsubscribe();
        return { error: error instanceof Error ? error.message : String(error) };
      },
      onSnapshot: notifySnapshot,
    });
  }

  const snapshot = mapAgentStatus(lifecycle, threadId, thread.live.status.value);
  if (snapshot !== undefined) notifySnapshot(snapshot);
  if (isTerminalAgentStatus(thread.live.status.value)) stopSummary();
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
        return lifecycle.complete(taskId, status.lastMessage);
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
