import {
  ROOT_AGENT_PATH,
  type AgentMetadata,
  type AgentPath,
  type ThreadId,
} from "../registry.js";
import type { StateSqliteDriver } from "../../state/sqlite-driver.js";
import { AgentGraphStoreError } from "./errors.js";
import type { AgentGraphStore } from "./store.js";
import {
  isThreadSpawnEdgeStatus,
  type ThreadSpawnEdgeStatus,
} from "./types.js";

interface ThreadSpawnEdgeRow {
  readonly child_thread_id: string;
  readonly parent_thread_id: string;
  readonly parent_path: string;
  readonly metadata_json: string;
  readonly status: string;
}

export interface LocalAgentGraphStoreOptions {
  readonly defaultParentPath?: AgentPath;
  readonly defaultMetadataForEdge?: (edge: {
    readonly parentThreadId: ThreadId;
    readonly childThreadId: ThreadId;
  }) => AgentMetadata;
}

export class LocalAgentGraphStore implements AgentGraphStore {
  private readonly defaultParentPath: AgentPath;
  private readonly defaultMetadataForEdge: NonNullable<
    LocalAgentGraphStoreOptions["defaultMetadataForEdge"]
  >;

  constructor(
    private readonly driver: StateSqliteDriver,
    options: LocalAgentGraphStoreOptions = {},
  ) {
    this.defaultParentPath = options.defaultParentPath ?? ROOT_AGENT_PATH;
    this.defaultMetadataForEdge =
      options.defaultMetadataForEdge ??
      ((edge) => ({ agentId: edge.childThreadId, depth: 0 }));
  }

  async upsertThreadSpawnEdge(
    parentThreadId: ThreadId,
    childThreadId: ThreadId,
    status: ThreadSpawnEdgeStatus,
  ): Promise<void> {
    this.assertStatus(status);
    this.runMutation(() => {
      const existing = this.rowForChild(childThreadId);
      const metadataJson =
        existing?.metadata_json ??
        JSON.stringify(
          this.defaultMetadataForEdge({ parentThreadId, childThreadId }),
        );
      const parentPath = existing?.parent_path ?? this.defaultParentPath;
      this.driver
        .prepareState<[string, string, string, string, string]>(
          `INSERT INTO thread_spawn_edges (
            child_thread_id,
            parent_thread_id,
            parent_path,
            metadata_json,
            status
          ) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(child_thread_id) DO UPDATE SET
            parent_thread_id = excluded.parent_thread_id,
            parent_path = excluded.parent_path,
            metadata_json = excluded.metadata_json,
            status = excluded.status,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
        )
        .run(childThreadId, parentThreadId, parentPath, metadataJson, status);
    });
  }

  async setThreadSpawnEdgeStatus(
    childThreadId: ThreadId,
    status: ThreadSpawnEdgeStatus,
  ): Promise<void> {
    this.assertStatus(status);
    this.runMutation(() => {
      this.driver
        .prepareState<[string, string]>(
          `UPDATE thread_spawn_edges
           SET status = ?,
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
           WHERE child_thread_id = ?`,
        )
        .run(status, childThreadId);
    });
  }

  async listThreadSpawnChildren(
    parentThreadId: ThreadId,
    statusFilter?: ThreadSpawnEdgeStatus | null,
  ): Promise<ThreadId[]> {
    const normalizedStatus = statusFilter ?? null;
    if (normalizedStatus !== null) this.assertStatus(normalizedStatus);
    try {
      return this.readRowsForParent(parentThreadId, normalizedStatus).map(
        (row) => row.child_thread_id,
      );
    } catch (cause) {
      throw AgentGraphStoreError.internal(cause);
    }
  }

  async listThreadSpawnDescendants(
    rootThreadId: ThreadId,
    statusFilter?: ThreadSpawnEdgeStatus | null,
  ): Promise<ThreadId[]> {
    const normalizedStatus = statusFilter ?? null;
    if (normalizedStatus !== null) this.assertStatus(normalizedStatus);
    let rows: ThreadSpawnEdgeRow[];
    try {
      rows = this.readRows(normalizedStatus);
    } catch (cause) {
      throw AgentGraphStoreError.internal(cause);
    }
    const childrenByParent = new Map<ThreadId, ThreadSpawnEdgeRow[]>();
    for (const edge of rows) {
      const bucket = childrenByParent.get(edge.parent_thread_id) ?? [];
      bucket.push(edge);
      childrenByParent.set(edge.parent_thread_id, bucket);
    }
    for (const bucket of childrenByParent.values()) {
      bucket.sort(compareRowsByChildThreadId);
    }

    const descendants: ThreadId[] = [];
    const seen = new Set<ThreadId>([rootThreadId]);
    let level = [...(childrenByParent.get(rootThreadId) ?? [])];
    while (level.length > 0) {
      level.sort(compareRowsByChildThreadId);
      const nextLevel: ThreadSpawnEdgeRow[] = [];
      for (const edge of level) {
        if (seen.has(edge.child_thread_id)) continue;
        seen.add(edge.child_thread_id);
        descendants.push(edge.child_thread_id);
        nextLevel.push(...(childrenByParent.get(edge.child_thread_id) ?? []));
      }
      level = nextLevel;
    }
    return descendants;
  }

  private rowForChild(childThreadId: ThreadId): ThreadSpawnEdgeRow | undefined {
    return this.driver
      .prepareState<[string], ThreadSpawnEdgeRow>(
        `SELECT child_thread_id, parent_thread_id, parent_path, metadata_json, status
         FROM thread_spawn_edges
         WHERE child_thread_id = ?`,
      )
      .get(childThreadId);
  }

  private readRowsForParent(
    parentThreadId: ThreadId,
    statusFilter: ThreadSpawnEdgeStatus | null,
  ): ThreadSpawnEdgeRow[] {
    if (statusFilter === null) {
      return this.driver
        .prepareState<[string], ThreadSpawnEdgeRow>(
          `SELECT child_thread_id, parent_thread_id, parent_path, metadata_json, status
           FROM thread_spawn_edges
           WHERE parent_thread_id = ?
           ORDER BY child_thread_id ASC`,
        )
        .all(parentThreadId);
    }
    return this.driver
      .prepareState<[string, string], ThreadSpawnEdgeRow>(
        `SELECT child_thread_id, parent_thread_id, parent_path, metadata_json, status
         FROM thread_spawn_edges
         WHERE parent_thread_id = ? AND status = ?
         ORDER BY child_thread_id ASC`,
      )
      .all(parentThreadId, statusFilter);
  }

  private readRows(
    statusFilter: ThreadSpawnEdgeStatus | null,
  ): ThreadSpawnEdgeRow[] {
    if (statusFilter === null) {
      return this.driver
        .prepareState<[], ThreadSpawnEdgeRow>(
          `SELECT child_thread_id, parent_thread_id, parent_path, metadata_json, status
           FROM thread_spawn_edges
           ORDER BY child_thread_id ASC`,
        )
        .all();
    }
    return this.driver
      .prepareState<[string], ThreadSpawnEdgeRow>(
        `SELECT child_thread_id, parent_thread_id, parent_path, metadata_json, status
         FROM thread_spawn_edges
         WHERE status = ?
         ORDER BY child_thread_id ASC`,
      )
      .all(statusFilter);
  }

  private assertStatus(status: ThreadSpawnEdgeStatus): void {
    if (!isThreadSpawnEdgeStatus(status)) {
      throw AgentGraphStoreError.invalidRequest(`unknown edge status: ${status}`);
    }
  }

  private runMutation(fn: () => void): void {
    try {
      this.driver.transaction(fn);
    } catch (cause) {
      if (cause instanceof AgentGraphStoreError) throw cause;
      throw AgentGraphStoreError.internal(cause);
    }
  }
}

function compareRowsByChildThreadId(
  left: ThreadSpawnEdgeRow,
  right: ThreadSpawnEdgeRow,
): number {
  return left.child_thread_id.localeCompare(right.child_thread_id);
}
