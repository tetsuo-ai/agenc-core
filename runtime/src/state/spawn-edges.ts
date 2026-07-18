import {
  AgentIdExistsError,
  InvalidAgentMetadataError,
  depthOfAgentPath,
  normalizeAgentMetadata,
  type AgentMetadata,
  type AgentPath,
  type ThreadId,
} from "../agents/registry.js";
import type { ThreadSpawnEdgeStatus } from "../session/rollout-store.js";
import type { StateSqliteDriver } from "./sqlite-driver.js";
import {
  checkSpawnAdmissionGate,
  SpawnAdmissionBlockedError,
} from "./run-cancellation.js";

/**
 * Admission-gate mode for {@link ThreadSpawnEdgeRepository.create}.
 * "enforce" (default) refuses a new edge whose nearest ancestor run is
 * cancel-locked (SpawnAdmissionBlockedError). "import" skips the check —
 * ONLY for historical-topology writers (legacy JSON edge import, state
 * export/import), which record edges that were admitted in the past
 * rather than admitting new work now.
 */
export type SpawnEdgeAdmissionGateMode = "enforce" | "import";

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
  readonly agent_role_workspace_id: string | null;
  readonly agent_role_fingerprint: string | null;
  readonly status: string;
}

export class ThreadSpawnEdgeRepository {
  constructor(private readonly driver: StateSqliteDriver) {}

  create(
    edge: IndexedThreadSpawnEdge,
    opts: { readonly admissionGate?: SpawnEdgeAdmissionGateMode } = {},
  ): IndexedThreadSpawnEdge {
    const normalized = normalizeIndexedThreadSpawnEdge(edge);
    // Gate check + INSERT run under ONE BEGIN IMMEDIATE transaction: the
    // write lock is held across the check, so a concurrent cross-process
    // run.cancel cannot commit between the admission decision and the edge
    // landing (the TOCTOU that would admit a child under a cancelled
    // parent that the cascade never enumerated).
    return this.driver.transactionImmediate(() => {
      if ((opts.admissionGate ?? "enforce") === "enforce") {
        const decision = checkSpawnAdmissionGate(this.driver, {
          parentThreadId: normalized.parentThreadId,
        });
        if (!decision.allowed) {
          throw new SpawnAdmissionBlockedError(
            normalized.childThreadId,
            decision.parentRunId,
            decision.parentStatus,
          );
        }
      }
      const metadata = normalized.metadata;
      const result = this.driver
        .prepareState(
          `INSERT INTO thread_spawn_edges (
            child_thread_id,
            parent_thread_id,
            parent_path,
            metadata_json,
            agent_role_workspace_id,
            agent_role_fingerprint,
            status
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(child_thread_id) DO NOTHING`,
        )
        .run(
          normalized.childThreadId,
          normalized.parentThreadId,
          normalized.parentPath,
          JSON.stringify(metadata),
          metadata.agentRoleWorkspaceId ?? null,
          metadata.agentRoleFingerprint ?? null,
          normalized.status,
        );
      if (result.changes === 0) {
        throw new AgentIdExistsError(normalized.childThreadId);
      }
      const persisted = this.get(normalized.childThreadId);
      if (!persisted) {
        throw new Error("persisted thread-spawn edge could not be read back");
      }
      return persisted;
    });
  }

  setStatus(
    childThreadId: ThreadId,
    status: ThreadSpawnEdgeStatus,
  ): IndexedThreadSpawnEdge {
    if (status !== "open" && status !== "closed") {
      throw new InvalidAgentMetadataError("invalid thread-spawn edge status");
    }
    if (status === "open") {
      const persisted = this.get(childThreadId);
      if (!persisted) {
        throw new InvalidAgentMetadataError(
          `thread-spawn edge does not exist: ${childThreadId}`,
        );
      }
      if (persisted.status === "closed") {
        throw new InvalidAgentMetadataError(
          `thread-spawn edge cannot transition from closed to open: ${childThreadId}`,
        );
      }
      return persisted;
    }

    // Closing is the only state mutation. The status predicate is the CAS:
    // concurrent closers serialize in SQLite, and losers acknowledge the
    // already-durable closed row below instead of reopening or failing.
    const result = this.driver
      .prepareState<[ThreadId]>(
        `UPDATE thread_spawn_edges
         SET status = 'closed',
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE child_thread_id = ? AND status = 'open'`,
      )
      .run(childThreadId);
    if (result.changes === 0) {
      const persisted = this.get(childThreadId);
      if (!persisted) {
        throw new InvalidAgentMetadataError(
          `thread-spawn edge does not exist: ${childThreadId}`,
        );
      }
      if (persisted.status !== "closed") {
        throw new InvalidAgentMetadataError(
          `thread-spawn edge could not transition to closed: ${childThreadId}`,
        );
      }
      return persisted;
    }
    const persisted = this.get(childThreadId);
    if (!persisted) {
      throw new Error("persisted thread-spawn edge could not be read back");
    }
    return persisted;
  }

  get(childThreadId: ThreadId): IndexedThreadSpawnEdge | undefined {
    const row = this.driver
      .prepareState<[ThreadId], SpawnEdgeRow>(
        `SELECT child_thread_id, parent_thread_id, parent_path, metadata_json,
                agent_role_workspace_id, agent_role_fingerprint, status
         FROM thread_spawn_edges
         WHERE child_thread_id = ?`,
      )
      .get(childThreadId);
    return row === undefined ? undefined : rowToEdge(row);
  }

  list(): ReadonlyArray<IndexedThreadSpawnEdge> {
    return this.driver
      .prepareState<[], SpawnEdgeRow>(
        `SELECT child_thread_id, parent_thread_id, parent_path, metadata_json,
                agent_role_workspace_id, agent_role_fingerprint, status
         FROM thread_spawn_edges
         ORDER BY child_thread_id ASC`,
      )
      .all()
      .map((row: SpawnEdgeRow) => rowToEdge(row));
  }
}

function rowToEdge(row: SpawnEdgeRow): IndexedThreadSpawnEdge {
  if (row.status !== "closed" && row.status !== "open") {
    throw new InvalidAgentMetadataError(
      `invalid thread-spawn edge status: ${row.status}`,
    );
  }
  const status = row.status;
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.metadata_json) as unknown;
  } catch (cause) {
    throw new InvalidAgentMetadataError("invalid agent metadata JSON", {
      cause,
    });
  }
  const metadata = normalizeAgentMetadata(parsed);
  const rawColumnWorkspaceId: unknown = row.agent_role_workspace_id;
  const rawColumnFingerprint: unknown = row.agent_role_fingerprint;
  if (
    rawColumnWorkspaceId !== null &&
    (typeof rawColumnWorkspaceId !== "string" ||
      rawColumnWorkspaceId.trim().length === 0 ||
      (metadata.agentRoleWorkspaceId !== undefined &&
        metadata.agentRoleWorkspaceId !== rawColumnWorkspaceId))
  ) {
    throw new InvalidAgentMetadataError(
      "invalid agent role workspace provenance column",
    );
  }
  const columnWorkspaceId = rawColumnWorkspaceId as string | null;
  if (
    rawColumnFingerprint !== null &&
    (typeof rawColumnFingerprint !== "string" ||
      rawColumnFingerprint.trim().length === 0 ||
      (metadata.agentRoleFingerprint !== undefined &&
        metadata.agentRoleFingerprint !== rawColumnFingerprint))
  ) {
    throw new InvalidAgentMetadataError(
      "invalid agent role fingerprint column",
    );
  }
  const columnFingerprint = rawColumnFingerprint as string | null;
  const recoveredMetadata =
    columnWorkspaceId === null && columnFingerprint === null
      ? metadata
      : normalizeAgentMetadata({
          ...metadata,
          ...(columnWorkspaceId !== null
            ? { agentRoleWorkspaceId: columnWorkspaceId }
            : {}),
          ...(columnFingerprint !== null
            ? { agentRoleFingerprint: columnFingerprint }
            : {}),
        });
  return normalizeIndexedThreadSpawnEdge({
    childThreadId: row.child_thread_id,
    parentThreadId: row.parent_thread_id,
    parentPath: row.parent_path,
    metadata: recoveredMetadata,
    status,
  });
}

function normalizeIndexedThreadSpawnEdge(
  edge: IndexedThreadSpawnEdge,
): IndexedThreadSpawnEdge {
  if (edge.status !== "open" && edge.status !== "closed") {
    throw new InvalidAgentMetadataError(
      `invalid thread-spawn edge status: ${String(edge.status)}`,
    );
  }
  const metadata = normalizeAgentMetadata(edge.metadata);
  if (
    edge.childThreadId.trim().length === 0 ||
    metadata.agentId !== edge.childThreadId
  ) {
    throw new InvalidAgentMetadataError(
      "thread-spawn edge child id must match metadata agentId",
    );
  }
  if (
    metadata.agentPath === undefined ||
    metadata.depth !== depthOfAgentPath(metadata.agentPath)
  ) {
    throw new InvalidAgentMetadataError(
      "thread-spawn edge path and depth are inconsistent",
    );
  }
  const separator = metadata.agentPath.lastIndexOf("/");
  const expectedParentPath = metadata.agentPath.slice(0, separator);
  if (
    edge.parentThreadId.trim().length === 0 ||
    edge.parentPath !== expectedParentPath
  ) {
    throw new InvalidAgentMetadataError(
      "thread-spawn edge parent identity is inconsistent",
    );
  }
  return {
    childThreadId: edge.childThreadId,
    parentThreadId: edge.parentThreadId,
    parentPath: edge.parentPath,
    metadata,
    status: edge.status,
  };
}
