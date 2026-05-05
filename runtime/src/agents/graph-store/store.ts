import type { ThreadId } from "../registry.js";
import type { ThreadSpawnEdgeStatus } from "./types.js";

export interface AgentGraphStore {
  upsertThreadSpawnEdge(
    parentThreadId: ThreadId,
    childThreadId: ThreadId,
    status: ThreadSpawnEdgeStatus,
  ): Promise<void>;

  setThreadSpawnEdgeStatus(
    childThreadId: ThreadId,
    status: ThreadSpawnEdgeStatus,
  ): Promise<void>;

  listThreadSpawnChildren(
    parentThreadId: ThreadId,
    statusFilter?: ThreadSpawnEdgeStatus | null,
  ): Promise<ThreadId[]>;

  listThreadSpawnDescendants(
    rootThreadId: ThreadId,
    statusFilter?: ThreadSpawnEdgeStatus | null,
  ): Promise<ThreadId[]>;
}
