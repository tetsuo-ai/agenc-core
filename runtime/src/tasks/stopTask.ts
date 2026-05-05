/**
 * Ports donor `src/tasks/stopTask.ts` validation and registry dispatch onto
 * AgenC's lifecycle stop delegate.
 *
 * Shape differences from the donor:
 *   - A real stop delegate is required. This helper never marks a task killed
 *     as a substitute for cancelling the backing work.
 *   - Lifecycle-backed callers may stop `pending` tasks because the existing
 *     `BackgroundTaskLifecycle` contract supports it.
 *
 * Cross-cuts deliberately NOT carried:
 *   - Donor SDK event queue emission is not exposed by the live runtime.
 */

import { getTaskByType, TaskRegistryError, type TaskStopDelegate } from "./registry.js";
import { isLocalShellTask, type TaskStatus } from "./types.js";

export class StopTaskError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "not_found"
      | "not_running"
      | "unsupported_type"
      | "stop_failed",
  ) {
    super(message);
    this.name = "StopTaskError";
  }
}

export interface StopTaskLookupState {
  readonly id?: string;
  readonly type: string;
  readonly status: TaskStatus;
  readonly description: string;
  readonly toolUseId?: string;
  readonly notified?: boolean;
  readonly command?: string;
}

export interface StopTaskContext {
  readonly getTask: (taskId: string) => StopTaskLookupState | undefined;
  readonly stopTask?: TaskStopDelegate;
  readonly markTaskNotified?: (taskId: string) => void;
  readonly allowPending?: boolean;
  readonly reason?: string;
}

export interface StopTaskResult {
  readonly taskId: string;
  readonly taskType: string;
  readonly command: string | undefined;
}

function isStoppableStatus(
  status: TaskStatus,
  allowPending: boolean,
): boolean {
  return status === "running" || (allowPending && status === "pending");
}

export async function stopTask(
  taskId: string,
  context: StopTaskContext,
): Promise<StopTaskResult> {
  const task = context.getTask(taskId);

  if (!task) {
    throw new StopTaskError(`No task found with ID: ${taskId}`, "not_found");
  }

  if (!isStoppableStatus(task.status, context.allowPending === true)) {
    throw new StopTaskError(
      `task ${taskId} is not running (status: ${task.status})`,
      "not_running",
    );
  }

  const taskImpl = getTaskByType(task.type);
  if (!taskImpl) {
    throw new StopTaskError(
      `Unsupported task type: ${task.type}`,
      "unsupported_type",
    );
  }

  try {
    await taskImpl.kill(taskId, {
      stopTask: context.stopTask,
      reason: context.reason ?? "stopped",
    });
  } catch (error) {
    if (error instanceof TaskRegistryError) {
      throw new StopTaskError(error.message, error.code);
    }
    throw new StopTaskError(
      error instanceof Error ? error.message : String(error),
      "stop_failed",
    );
  }

  if (isLocalShellTask(task)) {
    context.markTaskNotified?.(task.id ?? taskId);
  }

  const command =
    isLocalShellTask(task) && typeof task.command === "string"
      ? task.command
      : task.description;

  return {
    taskId: task.id ?? taskId,
    taskType: task.type,
    command,
  };
}
