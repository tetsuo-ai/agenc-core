export {
  BackgroundTaskError,
  BackgroundTaskLifecycle,
  generateBackgroundTaskId,
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

import { BackgroundTaskLifecycle } from "./lifecycle.js";

export const backgroundTaskLifecycle = new BackgroundTaskLifecycle();

export {
  registerAgentThreadTask,
  type AgentThreadTaskHandle,
  type RegisterAgentThreadTaskOptions,
} from "./agent-thread.js";
