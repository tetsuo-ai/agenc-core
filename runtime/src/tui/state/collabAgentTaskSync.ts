import type { LocalAgentTaskState, TaskState, TaskStatus } from "../../tasks/types.js";
import {
  isTaskRecord,
  taskNumberField,
  taskStringField,
} from "../../tasks/record-fields.js";

// Inlined from framework.ts; importing it creates a cycle through task UI.
// Result-board retention for terminal local_agent rows — keep in sync with
// PANEL_GRACE_MS in utils/task/framework.ts. A long window so a finished
// fan-out agent's row + result survives review instead of self-erasing.
const PANEL_GRACE_MS = 1_800_000;

export type SetAppStateWithTasks = (
  updater: (prev: { readonly tasks?: Record<string, TaskState> }) => unknown,
) => void;

type EventLike = {
  readonly type?: unknown;
  readonly payload?: unknown;
};

type CollabAgentTaskPatch = {
  readonly id: string;
  readonly status: TaskStatus;
  readonly requiresExisting?: boolean;
  readonly preserveCompletedOnTermination?: boolean;
  readonly title?: string;
  readonly prompt?: string;
  readonly role?: string;
  readonly model?: string;
  readonly error?: string;
  readonly toolUseCount?: number;
  readonly tokenCount?: number;
};

function collabStatusToTaskStatus(status: unknown): TaskStatus {
  if (isTaskRecord(status)) {
    return collabStatusToTaskStatus(status.status);
  }
  if (typeof status !== "string") return "running";
  switch (status.trim().toLowerCase().replaceAll("_", "-")) {
    case "pending-init":
    case "pending":
    case "starting":
      return "pending";
    case "running":
    case "interrupted":
      return "running";
    case "completed":
    case "complete":
    case "idle":
      return "completed";
    case "shutdown":
    case "killed":
    case "cancelled":
    case "canceled":
      return "killed";
    case "errored":
    case "error":
    case "failed":
    case "not-found":
      return "failed";
    default:
      return "running";
  }
}

function collabStatusError(status: unknown): string | undefined {
  return isTaskRecord(status) ? taskStringField(status, "error") : undefined;
}

function daemonStatusToTaskStatus(payload: Record<string, unknown>): TaskStatus {
  const runStatus = taskStringField(payload, "runStatus")
    ?.toLowerCase()
    .replaceAll("_", "-");
  switch (runStatus) {
    case "pending":
      return "pending";
    case "running":
    case "working":
    case "paused":
    case "blocked":
    case "suspended":
      return "running";
    case "completed":
      return "completed";
    case "errored":
      return "failed";
    case "stopped":
      return "killed";
  }

  const status = taskStringField(payload, "status")?.toLowerCase();
  switch (status) {
    case "running":
      return "running";
    case "error":
      return "failed";
    case "stopping":
    case "stopped":
      return "killed";
    case "idle":
      return "completed";
    default:
      return "running";
  }
}

function patchFromEvent(event: unknown): CollabAgentTaskPatch | null {
  if (!isTaskRecord(event)) return null;
  const { type, payload } = event as EventLike;
  if (typeof type !== "string" || !isTaskRecord(payload)) return null;

  if (type === "collab_agent_spawn_end") {
    const id = taskStringField(payload, "newThreadId");
    if (!id) return null;
    const title =
      taskStringField(payload, "newAgentNickname") ??
      taskStringField(payload, "newAgentPath") ??
      taskStringField(payload, "taskName") ??
      id;
    return {
      id,
      status: collabStatusToTaskStatus(payload.status),
      title,
      prompt: taskStringField(payload, "prompt"),
      role:
        taskStringField(payload, "newAgentRoleDisplayName") ??
        taskStringField(payload, "newAgentRole") ??
        taskStringField(payload, "agentType"),
      model: taskStringField(payload, "model"),
      error: collabStatusError(payload.status),
    };
  }

  if (type === "collab_agent_status") {
    const id = taskStringField(payload, "threadId");
    if (!id) return null;
    const status = collabStatusToTaskStatus(payload.status);
    const toolUseCount = taskNumberField(payload, "toolUseCount");
    const tokenCount = taskNumberField(payload, "tokenCount");
    return {
      id,
      status,
      requiresExisting: true,
      preserveCompletedOnTermination:
        status === "failed" || status === "killed",
      title:
        taskStringField(payload, "agentNickname") ??
        taskStringField(payload, "agentPath"),
      prompt: taskStringField(payload, "prompt"),
      role:
        taskStringField(payload, "agentRoleDisplayName") ??
        taskStringField(payload, "agentRole"),
      model: taskStringField(payload, "model"),
      // Live per-agent activity counts forwarded by the daemon collab event
      // (spawn.ts emitTaskStatus). These are what make the fan-out rail show
      // real `tools N tokens N` for a daemon-spawned agent instead of 0.
      ...(toolUseCount !== undefined ? { toolUseCount } : {}),
      ...(tokenCount !== undefined ? { tokenCount } : {}),
      error:
        collabStatusError(payload.status) ??
        (status === "failed" ? taskStringField(payload, "error") : undefined),
    };
  }

  if (
    type === "collab_agent_interaction_begin" ||
    type === "collab_agent_interaction_end"
  ) {
    const id = taskStringField(payload, "receiverThreadId");
    if (!id) return null;
    return {
      id,
      status:
        type === "collab_agent_interaction_begin"
          ? "running"
          : collabStatusToTaskStatus(payload.status),
      prompt: taskStringField(payload, "prompt"),
      role:
        taskStringField(payload, "receiverAgentRoleDisplayName") ??
        taskStringField(payload, "receiverAgentRole"),
      error: collabStatusError(payload.status),
    };
  }

  if (type === "background_agent_status") {
    const id = taskStringField(payload, "agentId");
    if (!id) return null;
    const status = daemonStatusToTaskStatus(payload);
    return {
      id,
      status,
      requiresExisting: true,
      preserveCompletedOnTermination:
        status === "failed" || status === "killed",
      ...(status === "failed" ? { error: taskStringField(payload, "message") } : {}),
    };
  }

  return null;
}

function patchesFromWaitingEnd(payload: Record<string, unknown>): CollabAgentTaskPatch[] {
  const statuses = payload.agentStatuses;
  if (!Array.isArray(statuses)) return [];
  return statuses.flatMap((entry): CollabAgentTaskPatch[] => {
    if (!isTaskRecord(entry)) return [];
    const id = taskStringField(entry, "threadId");
    if (!id) return [];
    return [
      {
        id,
        status: collabStatusToTaskStatus(entry.status),
        error: collabStatusError(entry.status),
        requiresExisting: true,
      },
    ];
  });
}

function patchesFromEvent(event: unknown): CollabAgentTaskPatch[] {
  const patch = patchFromEvent(event);
  if (patch !== null) return [patch];
  if (!isTaskRecord(event)) return [];
  const { type, payload } = event as EventLike;
  if (type !== "collab_waiting_end" || !isTaskRecord(payload)) return [];
  return patchesFromWaitingEnd(payload);
}

function outputUri(id: string): string {
  return `urn:agenc:task:${encodeURIComponent(id)}:output`;
}

function applyPatch(
  previous: TaskState | undefined,
  patch: CollabAgentTaskPatch,
  now: number,
): LocalAgentTaskState {
  const previousAgent =
    previous?.type === "local_agent" ? (previous as LocalAgentTaskState) : undefined;
  const preserveCompleted =
    previousAgent?.status === "completed" &&
    patch.preserveCompletedOnTermination === true &&
    (patch.status === "failed" || patch.status === "killed");
  const status = preserveCompleted ? "completed" : patch.status;
  const error = preserveCompleted ? undefined : patch.error;
  const title = patch.title ?? previousAgent?.description ?? patch.id;
  const prompt = patch.prompt ?? previousAgent?.prompt ?? title;
  const ended =
    status === "completed" ||
    status === "failed" ||
    status === "killed";
  // Merge live tool-use/token counts (forwarded by the daemon collab status
  // event) into the task's progress so AgentsRail renders real per-agent
  // activity. Carry the latest non-undefined count forward; never regress a
  // known count back to 0 when a later patch omits it.
  const nextToolUseCount =
    patch.toolUseCount ?? previousAgent?.progress?.toolUseCount;
  const nextTokenCount =
    patch.tokenCount ?? previousAgent?.progress?.tokenCount;
  const progress =
    nextToolUseCount !== undefined || nextTokenCount !== undefined
      ? {
          ...previousAgent?.progress,
          toolUseCount: nextToolUseCount ?? 0,
          tokenCount: nextTokenCount ?? 0,
        }
      : previousAgent?.progress;
  const evictAfter =
    ended && previousAgent?.retain !== true
      ? previousAgent?.evictAfter ?? now + PANEL_GRACE_MS
      : undefined;
  return {
    id: patch.id,
    type: "local_agent",
    status,
    description: title,
    startTime: previousAgent?.startTime ?? now,
    outputFile: previousAgent?.outputFile ?? outputUri(patch.id),
    outputOffset: previousAgent?.outputOffset ?? 0,
    notified: ended ? true : false,
    agentId: patch.id,
    prompt,
    agentType: patch.role ?? previousAgent?.agentType ?? "agent",
    ...(patch.model !== undefined ? { model: patch.model } : {}),
    ...(error !== undefined ? { error } : {}),
    retrieved: previousAgent?.retrieved ?? false,
    ...(previousAgent?.messages !== undefined ? { messages: previousAgent.messages } : {}),
    lastReportedToolCount:
      progress?.toolUseCount ?? previousAgent?.lastReportedToolCount ?? 0,
    lastReportedTokenCount:
      progress?.tokenCount ?? previousAgent?.lastReportedTokenCount ?? 0,
    isBackgrounded: true,
    pendingMessages: previousAgent?.pendingMessages ?? [],
    retain: previousAgent?.retain ?? false,
    diskLoaded: previousAgent?.diskLoaded ?? false,
    selectedAgent: previousAgent?.selectedAgent ?? { name: title },
    ...(progress !== undefined ? { progress } : {}),
    ...(ended ? { endTime: previousAgent?.endTime ?? now } : {}),
    ...(previousAgent?.abortController !== undefined
      ? { abortController: previousAgent.abortController }
      : {}),
    ...(previousAgent?.unregisterCleanup !== undefined
      ? { unregisterCleanup: previousAgent.unregisterCleanup }
      : {}),
    ...(ended && previousAgent?.result !== undefined ? { result: previousAgent.result } : {}),
    ...(evictAfter !== undefined ? { evictAfter } : {}),
  };
}

export function syncCollabAgentEventToAppState(
  event: unknown,
  setAppState: SetAppStateWithTasks,
  now: number = Date.now(),
): void {
  const patches = patchesFromEvent(event);
  if (patches.length === 0) return;
  setAppState((prev) => {
    if (prev === null || typeof prev !== "object") return prev;
    let tasks = prev.tasks ?? {};
    let changed = false;
    for (const patch of patches) {
      if (
        patch.requiresExisting === true &&
        tasks[patch.id]?.type !== "local_agent"
      ) {
        continue;
      }
      tasks = {
        ...tasks,
        [patch.id]: applyPatch(tasks[patch.id], patch, now),
      };
      changed = true;
    }
    if (!changed) return prev;
    return {
      ...prev,
      tasks,
    };
  });
}
