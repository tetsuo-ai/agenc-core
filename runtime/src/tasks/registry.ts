/**
 * Ports donor `src/tasks.ts` registry dispatch onto AgenC's lifecycle-backed
 * task surface.
 *
 * Shape differences from the donor:
 *   - Registry entries are structural kill dispatchers. Concrete process
 *     ownership remains in `BackgroundTaskLifecycle`.
 *   - Lifecycle-only `monitor` and `generic` kinds are kept for existing
 *     AgenC background-task callers.
 *
 * Cross-cuts deliberately NOT carried:
 *   - Workflow, MCP monitor, and dream task registries are not shipped by the
 *     live runtime.
 */

import {
  isAgenCBackgroundTaskType,
  type AgenCBackgroundTaskType,
} from "./types.js";

export type TaskStopDelegate = (
  taskId: string,
  reason: string,
) => Promise<unknown> | unknown;

export interface TaskKillContext {
  readonly stopTask?: TaskStopDelegate;
  readonly reason?: string;
}

export interface RegisteredTask<T extends AgenCBackgroundTaskType = AgenCBackgroundTaskType> {
  readonly name: string;
  readonly type: T;
  kill(taskId: string, context: TaskKillContext): Promise<void>;
}

export class TaskRegistryError extends Error {
  constructor(
    message: string,
    public readonly code: "stop_failed",
  ) {
    super(message);
    this.name = "TaskRegistryError";
  }
}

async function killViaStopDelegate(
  taskId: string,
  context: TaskKillContext,
): Promise<void> {
  if (!context.stopTask) {
    throw new TaskRegistryError(
      `task ${taskId} has no backing stop delegate`,
      "stop_failed",
    );
  }
  try {
    await context.stopTask(taskId, context.reason ?? "stopped");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new TaskRegistryError(
      `task ${taskId} stop failed: ${message}`,
      "stop_failed",
    );
  }
}

function lifecycleTask<T extends AgenCBackgroundTaskType>(
  type: T,
  name: string,
): RegisteredTask<T> {
  return {
    name,
    type,
    kill: killViaStopDelegate,
  };
}

const TASK_REGISTRY = Object.freeze([
  lifecycleTask("local_bash", "local shell"),
  lifecycleTask("local_agent", "local agent"),
  lifecycleTask("in_process_teammate", "in-process teammate"),
  lifecycleTask("monitor", "monitor"),
  lifecycleTask("generic", "generic background task"),
] as const);

const TASKS_BY_TYPE = new Map<AgenCBackgroundTaskType, RegisteredTask>(
  TASK_REGISTRY.map((task) => [task.type, task]),
);

export function getAllTasks(): readonly RegisteredTask[] {
  return TASK_REGISTRY;
}

export function getTaskByType(
  type: string,
): RegisteredTask | undefined {
  if (!isAgenCBackgroundTaskType(type)) {
    return undefined;
  }
  return TASKS_BY_TYPE.get(type);
}
