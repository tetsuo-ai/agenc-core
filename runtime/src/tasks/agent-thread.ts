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
import type { BackgroundTaskSnapshot } from "./lifecycle.js";
import { BackgroundTaskLifecycle } from "./lifecycle.js";

export interface AgentThreadTaskHandle {
  readonly threadId?: string;
  readonly threadName?: string;
  readonly nickname?: string;
  readonly agentPath?: string;
  readonly taskPrompt: string;
  readonly worktreePath?: string;
  readonly worktreeBranch?: string;
  readonly live: {
    readonly agentId: string;
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
}

export function registerAgentThreadTask(
  lifecycle: BackgroundTaskLifecycle,
  thread: AgentThreadTaskHandle,
  opts: RegisterAgentThreadTaskOptions = {},
): BackgroundTaskSnapshot {
  const threadId = thread.threadId ?? thread.live.agentId;
  const description = opts.description ?? thread.taskPrompt;
  const task = lifecycle.register({
    id: threadId,
    type: "local_agent",
    description,
    source: "agent_thread",
    toolUseId: opts.toolUseId,
    ...(thread.live.abortController !== undefined
      ? { abortController: thread.live.abortController }
      : {}),
    metadata: {
      threadName: thread.threadName ?? thread.nickname ?? thread.threadId,
      ...(thread.agentPath !== undefined ? { agentPath: thread.agentPath } : {}),
      ...(thread.worktreePath !== undefined
        ? { worktreePath: thread.worktreePath }
        : {}),
      ...(thread.worktreeBranch !== undefined
        ? { worktreeBranch: thread.worktreeBranch }
        : {}),
    },
    onStop: async (reason) => {
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
  });

  const unsubscribe =
    typeof thread.live.status.subscribe === "function"
      ? thread.live.status.subscribe((status) => {
          mapAgentStatus(lifecycle, threadId, status);
        })
      : () => {};

  const joinPromise = thread.join();
  if (joinPromise && typeof joinPromise.then === "function") {
    lifecycle.bindPromise(threadId, joinPromise, {
    onFulfilled: (result) => {
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
      unsubscribe();
      return { error: error instanceof Error ? error.message : String(error) };
    },
    });
  }

  mapAgentStatus(lifecycle, threadId, thread.live.status.value);
  return task;
}

function mapAgentStatus(
  lifecycle: BackgroundTaskLifecycle,
  taskId: string,
  status: AgentStatus,
): void {
  try {
    switch (status.status) {
      case "pending_init":
      case "idle":
        return;
      case "running":
        lifecycle.markRunning(taskId, { turnId: status.turnId });
        return;
      case "interrupted":
        lifecycle.appendOutput(taskId, `\n[agent interrupted: ${status.reason}]\n`);
        return;
      case "completed":
        lifecycle.complete(taskId, status.lastMessage);
        return;
      case "errored":
        lifecycle.fail(taskId, status.error);
        return;
      case "shutdown":
        void lifecycle.stop(taskId, "agent shutdown").catch(() => {});
        return;
      case "not_found":
        lifecycle.fail(taskId, "agent not found");
        return;
    }
  } catch {
    // The lifecycle may already be terminal when a late AgentStatus arrives.
  }
}
