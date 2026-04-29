import type {
  AgentMetadata,
  AgentPath,
  ThreadId,
} from "../agents/registry.js";
import type { ThreadSpawnEdgeStatus } from "../session/rollout-store.js";
import type { StateSqliteDriver } from "./sqlite-driver.js";

export interface IndexedThreadSpawnEdge {
  readonly childThreadId: ThreadId;
  readonly parentThreadId: ThreadId;
  readonly parentPath: AgentPath;
  readonly metadata: AgentMetadata;
  readonly status: ThreadSpawnEdgeStatus;
}

interface SpawnEdgeRow {
  readonly child_thread_id: string;
  readonly parent_thread_id: string;
  readonly parent_path: string;
  readonly metadata_json: string;
  readonly status: string;
}

export class ThreadSpawnEdgeRepository {
  constructor(private readonly driver: StateSqliteDriver) {}

  upsert(edge: IndexedThreadSpawnEdge): void {
    this.driver
      .prepareState(
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
      .run(
        edge.childThreadId,
        edge.parentThreadId,
        edge.parentPath,
        JSON.stringify(edge.metadata),
        edge.status,
      );
  }

  get(childThreadId: ThreadId): IndexedThreadSpawnEdge | undefined {
    const row = this.driver
      .prepareState<[ThreadId], SpawnEdgeRow>(
        `SELECT child_thread_id, parent_thread_id, parent_path, metadata_json, status
         FROM thread_spawn_edges
         WHERE child_thread_id = ?`,
      )
      .get(childThreadId);
    return row === undefined ? undefined : rowToEdge(row);
  }

  list(): ReadonlyArray<IndexedThreadSpawnEdge> {
    return this.driver
      .prepareState<[], SpawnEdgeRow>(
        `SELECT child_thread_id, parent_thread_id, parent_path, metadata_json, status
         FROM thread_spawn_edges
         ORDER BY child_thread_id ASC`,
      )
      .all()
      .map((row) => rowToEdge(row));
  }
}

function rowToEdge(row: SpawnEdgeRow): IndexedThreadSpawnEdge {
  const status =
    row.status === "closed" || row.status === "open" ? row.status : "open";
  return {
    childThreadId: row.child_thread_id,
    parentThreadId: row.parent_thread_id,
    parentPath: row.parent_path,
    metadata: JSON.parse(row.metadata_json) as AgentMetadata,
    status,
  };
}
