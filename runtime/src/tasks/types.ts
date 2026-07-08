/**
 * Ports donor `src/Task.ts` and `src/tasks/types.ts` task discriminators onto
 * AgenC's live task subsystem.
 *
 * Shape differences from the donor:
 *   - AgenC keeps lifecycle-only `monitor` and `generic` task kinds separate
 *     from AppState task kinds.
 *   - Output paths use the in-process task-output URI shape because the live
 *     runtime does not own the donor disk-output layout.
 */

import { randomInt } from "node:crypto";

export type TaskType =
  | "local_bash"
  | "local_agent"
  | "in_process_teammate";

export type LifecycleOnlyTaskType = "monitor" | "generic";

export type AgenCBackgroundTaskType = TaskType | LifecycleOnlyTaskType;

export type TaskStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "killed";

export type StoppableTaskStatus = Extract<TaskStatus, "pending" | "running">;

export interface TaskStateBase<T extends TaskType = TaskType> {
  readonly id: string;
  readonly type: T;
  readonly status: TaskStatus;
  readonly description: string;
  readonly toolUseId?: string;
  readonly startTime: number;
  readonly endTime?: number;
  readonly totalPausedMs?: number;
  readonly outputFile: string;
  readonly outputOffset: number;
  readonly notified: boolean;
}

export type BashTaskKind = "bash" | "monitor";

export interface LocalShellTaskState extends TaskStateBase<"local_bash"> {
  readonly command: string;
  readonly result?: {
    readonly code: number;
    readonly interrupted: boolean;
  };
  readonly completionStatusSentInAttachment?: boolean;
  readonly shellCommand?: unknown;
  readonly unregisterCleanup?: () => void;
  readonly cleanupTimeoutId?: ReturnType<typeof setTimeout>;
  readonly lastReportedTotalLines?: number;
  readonly isBackgrounded?: boolean;
  readonly agentId?: string;
  readonly kind?: BashTaskKind;
}

export interface AgentProgressActivity {
  readonly toolName?: string;
  readonly input?: unknown;
  readonly activityDescription?: string;
}

export interface AgentProgress {
  readonly toolUseCount?: number;
  readonly tokenCount?: number;
  readonly summary?: string;
  readonly lastActivity?: AgentProgressActivity;
  readonly recentActivities?: readonly AgentProgressActivity[];
}

export interface LocalAgentTaskState extends TaskStateBase<"local_agent"> {
  readonly agentId: string;
  readonly prompt: string;
  readonly cwd?: string;
  readonly worktreePath?: string;
  readonly path?: string;
  readonly selectedAgent?: unknown;
  readonly agentType: string;
  readonly model?: string;
  readonly abortController?: AbortController;
  readonly unregisterCleanup?: () => void;
  readonly error?: string;
  readonly result?: unknown;
  readonly progress?: AgentProgress;
  readonly retrieved: boolean;
  readonly messages?: readonly unknown[];
  readonly lastReportedToolCount: number;
  readonly lastReportedTokenCount: number;
  readonly isBackgrounded?: boolean;
  readonly pendingMessages: readonly string[];
  readonly retain: boolean;
  readonly diskLoaded: boolean;
  readonly evictAfter?: number;
}

export interface TeammateIdentity {
  readonly agentId: string;
  readonly agentName: string;
  readonly teamName: string;
  readonly color?: string;
  readonly planModeRequired: boolean;
  readonly parentSessionId: string;
}

export interface InProcessTeammateTaskState
  extends TaskStateBase<"in_process_teammate"> {
  readonly identity: TeammateIdentity;
  readonly prompt: string;
  readonly model?: string;
  readonly selectedAgent?: unknown;
  readonly abortController?: AbortController;
  readonly currentWorkAbortController?: AbortController;
  readonly unregisterCleanup?: () => void;
  readonly awaitingPlanApproval: boolean;
  readonly permissionMode: string;
  readonly error?: string;
  readonly result?: unknown;
  readonly progress?: AgentProgress;
  readonly messages?: readonly unknown[];
  readonly inProgressToolUseIDs?: ReadonlySet<string>;
  readonly pendingUserMessages: readonly string[];
  readonly spinnerVerb?: string;
  readonly pastTenseVerb?: string;
  readonly isIdle: boolean;
  readonly shutdownRequested: boolean;
  readonly onIdleCallbacks?: readonly (() => void)[];
  readonly lastReportedToolCount: number;
  readonly lastReportedTokenCount: number;
}

export type TaskState =
  | LocalShellTaskState
  | LocalAgentTaskState
  | InProcessTeammateTaskState;

export type BackgroundTaskState = TaskState;

const TASK_ID_PREFIXES: Record<AgenCBackgroundTaskType, string> = {
  local_bash: "b",
  local_agent: "a",
  in_process_teammate: "t",
  monitor: "m",
  generic: "t",
};

const TASK_ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

const APP_STATE_TASK_TYPES = new Set<string>([
  "local_bash",
  "local_agent",
  "in_process_teammate",
]);

const BACKGROUND_TASK_TYPES = new Set<string>([
  ...APP_STATE_TASK_TYPES,
  "monitor",
  "generic",
]);

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return status === "completed" || status === "failed" || status === "killed";
}

export function isStoppableTaskStatus(status: TaskStatus): status is StoppableTaskStatus {
  return status === "pending" || status === "running";
}

export function isTaskType(type: string): type is TaskType {
  return APP_STATE_TASK_TYPES.has(type);
}

export function isAgenCBackgroundTaskType(
  type: string,
): type is AgenCBackgroundTaskType {
  return BACKGROUND_TASK_TYPES.has(type);
}

export function generateTaskId(type: AgenCBackgroundTaskType): string {
  let id = TASK_ID_PREFIXES[type] ?? "x";
  for (let index = 0; index < 8; index += 1) {
    id += TASK_ID_ALPHABET[randomInt(TASK_ID_ALPHABET.length)]!;
  }
  return id;
}

export function createTaskStateBase<T extends TaskType>(
  id: string,
  type: T,
  description: string,
  toolUseId?: string,
): TaskStateBase<T> {
  return {
    id,
    type,
    status: "pending",
    description,
    ...(toolUseId !== undefined ? { toolUseId } : {}),
    startTime: Date.now(),
    outputFile: `urn:agenc:task:${encodeURIComponent(id)}:output`,
    outputOffset: 0,
    notified: false,
  };
}

export function isLocalShellTask(task: unknown): task is LocalShellTaskState {
  return (
    typeof task === "object" &&
    task !== null &&
    "type" in task &&
    task.type === "local_bash"
  );
}

export function isBackgroundTask(task: unknown): task is BackgroundTaskState {
  if (typeof task !== "object" || task === null) {
    return false;
  }
  const candidate = task as {
    readonly type?: unknown;
    readonly status?: unknown;
    readonly isBackgrounded?: unknown;
  };
  if (typeof candidate.type !== "string" || !isTaskType(candidate.type)) {
    return false;
  }
  if (
    candidate.status !== "running" &&
    candidate.status !== "pending"
  ) {
    return false;
  }
  return candidate.isBackgrounded !== false;
}
