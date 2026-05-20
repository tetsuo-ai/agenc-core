import type { LocalAgentTaskState, TaskState, TaskStatus } from "../../tasks/types.js";

// Inlined from framework.ts; importing it creates a cycle through task UI.
const PANEL_GRACE_MS = 30_000;

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
  readonly title?: string;
  readonly prompt?: string;
  readonly role?: string;
  readonly model?: string;
  readonly error?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function collabStatusToTaskStatus(status: unknown): TaskStatus {
  if (isRecord(status)) {
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
  return isRecord(status) ? stringField(status, "error") : undefined;
}

function daemonStatusToTaskStatus(payload: Record<string, unknown>): TaskStatus {
  const runStatus = stringField(payload, "runStatus")
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

  const status = stringField(payload, "status")?.toLowerCase();
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
  if (!isRecord(event)) return null;
  const { type, payload } = event as EventLike;
  if (typeof type !== "string" || !isRecord(payload)) return null;

  if (type === "collab_agent_spawn_end") {
    const id = stringField(payload, "newThreadId");
    if (!id) return null;
    const title =
      stringField(payload, "newAgentNickname") ??
      stringField(payload, "newAgentPath") ??
      stringField(payload, "taskName") ??
      id;
    return {
      id,
      status: collabStatusToTaskStatus(payload.status),
      title,
      prompt: stringField(payload, "prompt"),
      role:
        stringField(payload, "newAgentRoleDisplayName") ??
        stringField(payload, "newAgentRole") ??
        stringField(payload, "agentType"),
      model: stringField(payload, "model"),
      error: collabStatusError(payload.status),
    };
  }

  if (type === "collab_agent_status") {
    const id = stringField(payload, "threadId");
    if (!id) return null;
    const status = collabStatusToTaskStatus(payload.status);
    return {
      id,
      status,
      requiresExisting: true,
      title:
        stringField(payload, "agentNickname") ??
        stringField(payload, "agentPath"),
      prompt: stringField(payload, "prompt"),
      role:
        stringField(payload, "agentRoleDisplayName") ??
        stringField(payload, "agentRole"),
      model: stringField(payload, "model"),
      error:
        collabStatusError(payload.status) ??
        (status === "failed" ? stringField(payload, "error") : undefined),
    };
  }

  if (
    type === "collab_agent_interaction_begin" ||
    type === "collab_agent_interaction_end"
  ) {
    const id = stringField(payload, "receiverThreadId");
    if (!id) return null;
    return {
      id,
      status:
        type === "collab_agent_interaction_begin"
          ? "running"
          : collabStatusToTaskStatus(payload.status),
      prompt: stringField(payload, "prompt"),
      role:
        stringField(payload, "receiverAgentRoleDisplayName") ??
        stringField(payload, "receiverAgentRole"),
      error: collabStatusError(payload.status),
    };
  }

  if (type === "background_agent_status") {
    const id = stringField(payload, "agentId");
    if (!id) return null;
    const status = daemonStatusToTaskStatus(payload);
    return {
      id,
      status,
      requiresExisting: true,
      ...(status === "failed" ? { error: stringField(payload, "message") } : {}),
    };
  }

  return null;
}

function patchesFromWaitingEnd(payload: Record<string, unknown>): CollabAgentTaskPatch[] {
  const statuses = payload.agentStatuses;
  if (!Array.isArray(statuses)) return [];
  return statuses.flatMap((entry): CollabAgentTaskPatch[] => {
    if (!isRecord(entry)) return [];
    const id = stringField(entry, "threadId");
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
  if (!isRecord(event)) return [];
  const { type, payload } = event as EventLike;
  if (type !== "collab_waiting_end" || !isRecord(payload)) return [];
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
  const title = patch.title ?? previousAgent?.description ?? patch.id;
  const prompt = patch.prompt ?? previousAgent?.prompt ?? title;
  const ended =
    patch.status === "completed" ||
    patch.status === "failed" ||
    patch.status === "killed";
  const evictAfter =
    ended && previousAgent?.retain !== true
      ? previousAgent?.evictAfter ?? now + PANEL_GRACE_MS
      : previousAgent?.evictAfter;
  return {
    id: patch.id,
    type: "local_agent",
    status: patch.status,
    description: title,
    startTime: previousAgent?.startTime ?? now,
    outputFile: previousAgent?.outputFile ?? outputUri(patch.id),
    outputOffset: previousAgent?.outputOffset ?? 0,
    notified: ended ? true : previousAgent?.notified ?? false,
    agentId: patch.id,
    prompt,
    agentType: patch.role ?? previousAgent?.agentType ?? "agent",
    ...(patch.model !== undefined ? { model: patch.model } : {}),
    ...(patch.error !== undefined ? { error: patch.error } : {}),
    retrieved: previousAgent?.retrieved ?? false,
    ...(previousAgent?.messages !== undefined ? { messages: previousAgent.messages } : {}),
    lastReportedToolCount: previousAgent?.lastReportedToolCount ?? 0,
    lastReportedTokenCount: previousAgent?.lastReportedTokenCount ?? 0,
    isBackgrounded: true,
    pendingMessages: previousAgent?.pendingMessages ?? [],
    retain: previousAgent?.retain ?? false,
    diskLoaded: previousAgent?.diskLoaded ?? false,
    selectedAgent: previousAgent?.selectedAgent ?? { name: title },
    ...(previousAgent?.progress !== undefined ? { progress: previousAgent.progress } : {}),
    ...(ended
      ? { endTime: previousAgent?.endTime ?? now }
      : previousAgent?.endTime !== undefined
        ? { endTime: previousAgent.endTime }
        : {}),
    ...(previousAgent?.abortController !== undefined
      ? { abortController: previousAgent.abortController }
      : {}),
    ...(previousAgent?.unregisterCleanup !== undefined
      ? { unregisterCleanup: previousAgent.unregisterCleanup }
      : {}),
    ...(previousAgent?.result !== undefined ? { result: previousAgent.result } : {}),
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
