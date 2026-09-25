export {
  BackgroundTaskError,
  BackgroundTaskLifecycle,
  isTerminalTaskStatus,
  type BackgroundTaskNotification,
  type BackgroundTaskNotificationKind,
  type BackgroundTaskOutputRef,
  type BackgroundTaskSnapshot,
  type BackgroundTaskStatus,
  type BackgroundTaskType,
  type BindTaskPromiseOptions,
  type AgentProgress,
  type AgentToolActivity,
  type RegisterBackgroundTaskInput,
} from "./lifecycle.js";

export {
  createTaskStateBase,
  generateTaskId,
  isAgenCBackgroundTaskType,
  isBackgroundTask,
  isLocalShellTask,
  isStoppableTaskStatus,
  isTaskType,
  type AgenCBackgroundTaskType,
  type AgentProgressActivity,
  type AgentProgress as TaskStateAgentProgress,
  type BackgroundTaskState,
  type InProcessTeammateTaskState,
  type LifecycleOnlyTaskType,
  type LocalAgentTaskState,
  type LocalShellTaskState,
  type StoppableTaskStatus,
  type TaskState,
  type TaskStateBase,
  type TaskStatus,
  type TaskType,
  type TeammateIdentity,
} from "./types.js";

export {
  getAllTasks,
  getTaskByType,
  TaskRegistryError,
  type RegisteredTask,
  type TaskKillContext,
  type TaskStopDelegate,
} from "./registry.js";

export {
  stopTask,
  StopTaskError,
  type StopTaskContext,
  type StopTaskLookupState,
  type StopTaskResult,
} from "./stopTask.js";

export { getPillLabel } from "./pillLabel.js";

import { BackgroundTaskLifecycle } from "./lifecycle.js";

/** The lifecycle for callers that have no owning session. */
export const backgroundTaskLifecycle = new BackgroundTaskLifecycle();

const rootSessionLifecycles = new WeakMap<object, BackgroundTaskLifecycle>();

/**
 * The background task lifecycle of one root session (a conversation).
 *
 * Every agent a session spawns is registered with its agent path as an alias,
 * and agent paths come from that session's own tree: two sessions of one
 * daemon both name `/root/<task_name>`. In one daemon-wide lifecycle the
 * second registration collided with the first session's live alias, was
 * dropped, and the spawn then failed with `task <id> not found` after its
 * child already existed (luna-mac F1). TaskOutput and TaskStop could also
 * read or stop another session's agent by name. One lifecycle per root
 * session keeps ids, aliases, output and stop requests inside the session
 * that owns them. The entry lives as long as the session object.
 */
export function backgroundTaskLifecycleForSession(
  rootSession: object | null | undefined,
): BackgroundTaskLifecycle {
  if (typeof rootSession !== "object" || rootSession === null) {
    return backgroundTaskLifecycle;
  }
  let lifecycle = rootSessionLifecycles.get(rootSession);
  if (lifecycle === undefined) {
    lifecycle = new BackgroundTaskLifecycle();
    rootSessionLifecycles.set(rootSession, lifecycle);
  }
  return lifecycle;
}

export {
  observeAgentThreadTask,
  registerAgentThreadTask,
  type AgentThreadTaskHandle,
  type RegisterAgentThreadTaskOptions,
} from "./agent-thread.js";
