/**
 * Ports the donor TaskOutput/TaskStop background-task tools onto AgenC's
 * BackgroundTaskLifecycle.
 *
 * Shape differences from the donor tools:
 *   - AgenC reads from the in-process lifecycle output buffer rather than the
 *     donor task-output disk layout.
 *   - Rendering is handled by the existing model-facing Tool result contract;
 *     this file owns command semantics only.
 *
 * Cross-cuts deliberately NOT carried:
 *   - Donor React/Ink render components.
 *   - Deprecated donor shell output aliases beyond the `shell_id` input alias.
 */

import {
  backgroundTaskLifecycle,
  isTerminalTaskStatus,
  type BackgroundTaskLifecycle,
} from "../../tasks/index.js";
import type { Tool } from "../types.js";
import {
  TASK_CONCURRENCY,
  numberValue,
  stringValue,
  taskStrictArgs,
  taskTextResult,
  toolMetadata,
} from "./helpers.js";

async function waitForBackgroundTask(
  lifecycle: BackgroundTaskLifecycle,
  taskId: string,
  timeoutMs: number,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const task = lifecycle.get(taskId);
    if (!task || isTerminalTaskStatus(task.status)) return;
    await new Promise<void>((resolvePromise) => {
      setTimeout(resolvePromise, 100);
    });
  }
}

function formatTaskOutputContent(payload: {
  readonly retrieval_status: string;
  readonly task: {
    readonly task_id: string;
    readonly task_type: string;
    readonly status: string;
    readonly output: string;
    readonly error?: string;
  } | null;
}): string {
  const parts = [`<retrieval_status>${payload.retrieval_status}</retrieval_status>`];
  if (payload.task) {
    parts.push(`<task_id>${payload.task.task_id}</task_id>`);
    parts.push(`<task_type>${payload.task.task_type}</task_type>`);
    parts.push(`<status>${payload.task.status}</status>`);
    if (payload.task.output.trim()) {
      parts.push(`<output>\n${payload.task.output.trimEnd()}\n</output>`);
    }
    if (payload.task.error) {
      parts.push(`<error>${payload.task.error}</error>`);
    }
  }
  return parts.join("\n\n");
}

export function createBackgroundTaskTools(
  lifecycle: BackgroundTaskLifecycle = backgroundTaskLifecycle,
): readonly Tool[] {
  return [
    {
      name: "TaskOutput",
      description:
        "Read output from a running or completed AgenC background task such as a spawned AgenC agent.",
      metadata: toolMetadata("task", {
        deferred: true,
        keywords: ["task", "output", "agent", "background"],
      }),
      isReadOnly: true,
      timeoutBehavior: "tool",
      inputSchema: {
        type: "object",
        properties: {
          task_id: { type: "string" },
          block: { type: "boolean" },
          timeout: { type: "number" },
        },
        required: ["task_id"],
        additionalProperties: false,
      },
      execute: async (args) => {
        const strict = taskStrictArgs(args, {
          allowed: new Set(["task_id", "block", "timeout"]),
          required: ["task_id"],
        });
        if (strict) return strict;
        const taskId = stringValue(args.task_id);
        if (!taskId) {
          return taskTextResult(
            "task_id is required",
            { error: "task_id is required" },
            true,
          );
        }
        if (args.block !== undefined && typeof args.block !== "boolean") {
          return taskTextResult(
            "block must be a boolean",
            { error: "block must be a boolean" },
            true,
          );
        }
        const timeout = numberValue(args.timeout);
        if (
          args.timeout !== undefined &&
          (timeout === undefined || timeout < 0 || timeout > 600_000)
        ) {
          return taskTextResult(
            "timeout must be a number between 0 and 600000",
            { error: "timeout must be a number between 0 and 600000" },
            true,
          );
        }
        if (args.block !== false) {
          await waitForBackgroundTask(
            lifecycle,
            taskId,
            timeout ?? 30_000,
          );
        }
        const task = lifecycle.get(taskId);
        if (!task) {
          return taskTextResult(
            `No task found with ID: ${taskId}`,
            { retrieval_status: "not_ready", task: null },
            true,
          );
        }
        const output = lifecycle.readOutput(taskId);
        const retrievalStatus = isTerminalTaskStatus(task.status)
          ? "success"
          : args.block === false
            ? "not_ready"
            : "timeout";
        const payload = {
          retrieval_status: retrievalStatus,
          task: {
            task_id: task.id,
            task_type: task.type,
            status: task.status,
            description: task.description,
            output,
            ...(task.error !== undefined ? { error: task.error } : {}),
          },
        };
        return taskTextResult(
          formatTaskOutputContent(payload),
          payload,
        );
      },
    },
    {
      name: "TaskStop",
      description: "Stop a running AgenC background task by ID.",
      metadata: toolMetadata("task", {
        mutating: true,
        deferred: true,
        keywords: ["task", "stop", "agent", "background"],
      }),
      concurrencyClass: TASK_CONCURRENCY,
      inputSchema: {
        type: "object",
        properties: {
          task_id: { type: "string" },
          shell_id: { type: "string" },
        },
        additionalProperties: false,
      },
      execute: async (args) => {
        const strict = taskStrictArgs(args, {
          allowed: new Set(["task_id", "shell_id"]),
        });
        if (strict) return strict;
        const taskId = stringValue(args.task_id) ?? stringValue(args.shell_id);
        if (!taskId) {
          return taskTextResult(
            "Missing required parameter: task_id",
            { error: "Missing required parameter: task_id" },
            true,
          );
        }
        try {
          const stopped = await lifecycle.stop(taskId, "stopped by TaskStop");
          return taskTextResult(
            `Successfully stopped task: ${stopped.id} (${stopped.description})`,
            {
              message: `Successfully stopped task: ${stopped.id} (${stopped.description})`,
              task_id: stopped.id,
              task_type: stopped.type,
              command: stopped.description,
            },
          );
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          return taskTextResult(message, { error: message }, true);
        }
      },
    },
  ];
}
