import type { BackgroundTaskSnapshot } from "./lifecycle.js";
import type { LocalAgentTaskState, TaskState } from "./types.js";

// Result-board retention for terminal local_agent rows — keep in sync with
// PANEL_GRACE_MS in utils/task/framework.ts. A long window so a finished
// fan-out agent's row + result survives review instead of self-erasing.
const PANEL_GRACE_MS = 1_800_000;

export interface TaskAppStateBridge {
  setAppState?: (updater: (prev: unknown) => unknown) => void;
}

type AppStateWithTasks = {
  readonly tasks?: Record<string, TaskState>;
};

function stringMetadata(
  metadata: Readonly<Record<string, unknown>> | undefined,
  key: string,
): string | undefined {
  const value = metadata?.[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function localAgentTaskFromSnapshot(
  snapshot: BackgroundTaskSnapshot,
  previous: TaskState | undefined,
): LocalAgentTaskState | null {
  if (snapshot.type !== "local_agent") return null;
  const previousAgent =
    previous?.type === "local_agent" ? (previous as LocalAgentTaskState) : undefined;
  const threadName = stringMetadata(snapshot.metadata, "threadName");
  const agentRole = stringMetadata(snapshot.metadata, "agentRole");
  const model = stringMetadata(snapshot.metadata, "model");
  const finalMessage = stringMetadata(snapshot.metadata, "finalMessage");
  const cwd = stringMetadata(snapshot.metadata, "cwd") ?? previousAgent?.cwd;
  const worktreePath =
    stringMetadata(snapshot.metadata, "worktreePath") ??
    previousAgent?.worktreePath;
  const path = stringMetadata(snapshot.metadata, "path") ?? previousAgent?.path;
  const terminal =
    snapshot.status === "completed" ||
    snapshot.status === "failed" ||
    snapshot.status === "killed";
  const progress = finalMessage !== undefined
    ? {
        ...snapshot.progress,
        toolUseCount:
          snapshot.progress?.toolUseCount ??
          previousAgent?.progress?.toolUseCount ??
          0,
        tokenCount:
          snapshot.progress?.tokenCount ??
          previousAgent?.progress?.tokenCount ??
          0,
        summary: finalMessage,
      }
    : snapshot.progress;
  const evictAfter =
    terminal && previousAgent?.retain !== true
      ? previousAgent?.evictAfter ?? Date.now() + PANEL_GRACE_MS
      : previousAgent?.evictAfter;
  return {
    id: snapshot.id,
    type: "local_agent",
    status: snapshot.status,
    description: threadName ?? snapshot.description,
    ...(snapshot.toolUseId !== undefined ? { toolUseId: snapshot.toolUseId } : {}),
    startTime: snapshot.startedAtMs,
    ...(snapshot.endedAtMs !== undefined ? { endTime: snapshot.endedAtMs } : {}),
    outputFile: snapshot.output.uri,
    outputOffset: snapshot.outputOffset,
    notified: snapshot.notified,
    agentId: snapshot.id,
    prompt: stringMetadata(snapshot.metadata, "taskPrompt") ?? snapshot.description,
    agentType: agentRole ?? previousAgent?.agentType ?? "agent",
    ...(cwd !== undefined ? { cwd } : {}),
    ...(worktreePath !== undefined ? { worktreePath } : {}),
    ...(path !== undefined ? { path } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(snapshot.error !== undefined ? { error: snapshot.error } : {}),
    ...(progress !== undefined ? { progress } : {}),
    retrieved: previousAgent?.retrieved ?? false,
    ...(previousAgent?.messages !== undefined ? { messages: previousAgent.messages } : {}),
    lastReportedToolCount:
      progress?.toolUseCount ?? previousAgent?.lastReportedToolCount ?? 0,
    lastReportedTokenCount:
      progress?.tokenCount ?? previousAgent?.lastReportedTokenCount ?? 0,
    isBackgrounded: previousAgent?.isBackgrounded ?? true,
    pendingMessages: previousAgent?.pendingMessages ?? [],
    retain: previousAgent?.retain ?? false,
    diskLoaded: previousAgent?.diskLoaded ?? false,
    ...(previousAgent?.selectedAgent !== undefined
      ? { selectedAgent: previousAgent.selectedAgent }
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

export function syncBackgroundTaskSnapshotToAppState(
  bridge: TaskAppStateBridge | undefined,
  snapshot: BackgroundTaskSnapshot,
): void {
  const setAppState = bridge?.setAppState;
  if (typeof setAppState !== "function") return;
  setAppState((prev: unknown) => {
    if (prev === null || typeof prev !== "object") return prev;
    const state = prev as AppStateWithTasks;
    const previousTasks = state.tasks ?? {};
    const task = localAgentTaskFromSnapshot(snapshot, previousTasks[snapshot.id]);
    if (task === null) return prev;
    return {
      ...state,
      tasks: {
        ...previousTasks,
        [snapshot.id]: task,
      },
    };
  });
}
