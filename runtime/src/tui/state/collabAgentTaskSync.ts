import type { LocalAgentTaskState, TaskState, TaskStatus } from "../../tasks/types.js";

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

  return null;
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
  return {
    id: patch.id,
    type: "local_agent",
    status: patch.status,
    description: title,
    startTime: previousAgent?.startTime ?? now,
    outputFile: previousAgent?.outputFile ?? outputUri(patch.id),
    outputOffset: previousAgent?.outputOffset ?? 0,
    notified: previousAgent?.notified ?? false,
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
    ...(previousAgent?.endTime !== undefined ? { endTime: previousAgent.endTime } : {}),
    ...(previousAgent?.abortController !== undefined
      ? { abortController: previousAgent.abortController }
      : {}),
    ...(previousAgent?.unregisterCleanup !== undefined
      ? { unregisterCleanup: previousAgent.unregisterCleanup }
      : {}),
    ...(previousAgent?.result !== undefined ? { result: previousAgent.result } : {}),
    ...(previousAgent?.evictAfter !== undefined
      ? { evictAfter: previousAgent.evictAfter }
      : {}),
  };
}

export function syncCollabAgentEventToAppState(
  event: unknown,
  setAppState: SetAppStateWithTasks,
  now: number = Date.now(),
): void {
  const patch = patchFromEvent(event);
  if (patch === null) return;
  setAppState((prev) => {
    if (prev === null || typeof prev !== "object") return prev;
    const tasks = prev.tasks ?? {};
    return {
      ...prev,
      tasks: {
        ...tasks,
        [patch.id]: applyPatch(tasks[patch.id], patch, now),
      },
    };
  });
}
