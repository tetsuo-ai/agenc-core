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
  type BashTaskKind,
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

export const backgroundTaskLifecycle = new BackgroundTaskLifecycle();

export {
  registerAgentThreadTask,
  type AgentThreadTaskHandle,
  type RegisterAgentThreadTaskOptions,
} from "./agent-thread.js";
