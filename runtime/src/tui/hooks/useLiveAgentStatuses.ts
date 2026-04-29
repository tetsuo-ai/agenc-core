import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";

import type { AgentStatus } from "../../agents/status.js";
import type { ManagedThread, ThreadManager } from "../../agents/thread-manager.js";
import type {
  LiveAgentStatus,
  LiveAgentStatusKind,
} from "../transcript/messages/CoordinatorAgentStatus.js";
import { useAnimationTick } from "./useAnimationTick.js";

interface SessionWithThreadManager {
  readonly services?: {
    readonly permissionModeRegistry?: unknown;
    readonly threadManager?: ThreadManager;
  };
}

function bump(setVersion: Dispatch<SetStateAction<number>>): void {
  setVersion((value) => value + 1);
}

function readModel(config: Record<string, unknown> | undefined): string | undefined {
  const model = config?.model;
  return typeof model === "string" && model.length > 0 ? model : undefined;
}

function lastPathSegment(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const parts = path.split("/").filter(Boolean);
  return parts.at(-1);
}

function statusKind(status: AgentStatus): LiveAgentStatusKind | null {
  switch (status.status) {
    case "pending_init":
    case "idle":
    case "running":
    case "completed":
    case "errored":
    case "shutdown":
    case "interrupted":
      return status.status;
    case "not_found":
      return null;
  }
}

function startedAtMs(status: AgentStatus): number | undefined {
  return status.status === "running" ? status.startedAtMs : undefined;
}

function endedAtMs(status: AgentStatus): number | undefined {
  switch (status.status) {
    case "completed":
    case "errored":
    case "interrupted":
    case "shutdown":
      return status.endedAtMs;
    default:
      return undefined;
  }
}

function taskDescription(status: AgentStatus): string | undefined {
  switch (status.status) {
    case "completed":
      return status.lastMessage;
    case "errored":
      return status.error;
    case "interrupted":
      return status.reason;
    default:
      return undefined;
  }
}

function toLiveAgentStatus(
  manager: ThreadManager,
  thread: ManagedThread,
): LiveAgentStatus | null {
  if (thread.kind !== "agent") return null;
  const status = thread.status();
  const kind = statusKind(status);
  if (kind === null) return null;

  const live = manager.state.control?.getLive(thread.threadId);
  const metadata = live?.metadata;
  const role =
    live?.role.name ??
    metadata?.agentRole ??
    lastPathSegment(thread.agentPath) ??
    "agent";
  const nickname = live?.nickname ?? metadata?.agentNickname;
  const totalTokens = live?.tokenUsage.totalTokens;
  const description = taskDescription(status) ?? metadata?.lastTaskMessage;
  const model = readModel(live?.configSnapshot);

  return {
    threadId: thread.threadId,
    role,
    ...(nickname !== undefined ? { nickname } : {}),
    ...(model !== undefined ? { model } : {}),
    status: kind,
    ...(startedAtMs(status) !== undefined
      ? { startedAtMs: startedAtMs(status) }
      : {}),
    ...(endedAtMs(status) !== undefined ? { endedAtMs: endedAtMs(status) } : {}),
    ...(typeof totalTokens === "number" && totalTokens > 0
      ? { tokens: totalTokens }
      : {}),
    ...(description !== undefined ? { taskDescription: description } : {}),
  };
}

export function useLiveAgentStatuses(
  session: SessionWithThreadManager,
): readonly LiveAgentStatus[] {
  const manager = session.services?.threadManager;
  const [version, setVersion] = useState(0);
  const { tick } = useAnimationTick(1);

  useEffect(() => {
    if (manager === undefined) return undefined;
    const statusUnsubscribers = new Map<string, () => void>();

    const subscribeThread = (threadId: string): void => {
      if (statusUnsubscribers.has(threadId)) return;
      let thread: ManagedThread;
      try {
        thread = manager.getThread(threadId);
      } catch {
        return;
      }
      if (thread.kind !== "agent") return;
      statusUnsubscribers.set(
        threadId,
        thread.subscribeStatus(() => bump(setVersion)),
      );
    };

    for (const threadId of manager.listThreadIds()) {
      subscribeThread(threadId);
    }

    const unsubscribeCreated = manager.subscribeThreadCreated((threadId) => {
      subscribeThread(threadId);
      bump(setVersion);
    });
    bump(setVersion);

    return () => {
      unsubscribeCreated();
      for (const unsubscribe of statusUnsubscribers.values()) {
        unsubscribe();
      }
      statusUnsubscribers.clear();
    };
  }, [manager]);

  return useMemo(() => {
    void version;
    void tick;
    if (manager === undefined) return [];
    return manager
      .listThreadIds()
      .map((threadId) => {
        try {
          return toLiveAgentStatus(manager, manager.getThread(threadId));
        } catch {
          return null;
        }
      })
      .filter((agent): agent is LiveAgentStatus => agent !== null)
      .sort((left, right) => left.threadId.localeCompare(right.threadId));
  }, [manager, tick, version]);
}
