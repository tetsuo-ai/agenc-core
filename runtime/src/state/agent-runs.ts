import type { StateSqliteDriver } from "./sqlite-driver.js";
import type { JsonObject } from "../app-server/protocol/index.js";
import { asRecord } from "../utils/record.js";
import { isCancelLockedAgentRunStatus } from "./run-cancellation.js";

/**
 * Outcome of a guarded agent-run write. `applied: false` with
 * `cancel_locked_status_sticky` means the existing row carries a
 * cancel-locked status (`cancelled` / `unknown_outcome`) and the incoming
 * write tried to move it to a different status — the write is a no-op
 * (never a throw: the sole production status writer is the post-hoc
 * snapshot observer relaying a dying agent's late transition, which must
 * lose silently to an explicit cancel). Same-status writes still land so
 * metadata patches on the locked record remain possible.
 */
export interface AgentRunWriteOutcome {
  readonly applied: boolean;
  readonly reason?: "cancel_locked_status_sticky";
  readonly existingStatus?: string;
}

const APPLIED: AgentRunWriteOutcome = { applied: true };

function cancelLockedExistingStatus(
  driver: StateSqliteDriver,
  id: string,
  incomingStatus: string,
): string | undefined {
  const existing = driver
    .prepareState<[string], { status?: string }>(
      "SELECT status FROM agent_runs WHERE id = ?",
    )
    .get(id)?.status;
  if (
    existing !== undefined &&
    existing !== incomingStatus &&
    isCancelLockedAgentRunStatus(existing)
  ) {
    return existing;
  }
  return undefined;
}

export interface AgenCStateAgentRunRecord {
  readonly id: string;
  readonly objective: string;
  readonly status: string;
  readonly startedAt: string;
  readonly lastActiveAt: string;
  readonly currentSessionId?: string;
  readonly createdByClient?: string;
  readonly lastSnapshotAt?: string;
  readonly metadata?: JsonObject;
}

export interface AgenCStateAgentRunStatusUpdate {
  readonly id: string;
  readonly status: string;
  readonly lastActiveAt: string;
  readonly currentSessionId?: string;
  readonly metadataPatch?: JsonObject;
}

export function upsertAgentRun(
  driver: StateSqliteDriver,
  run: AgenCStateAgentRunRecord,
): AgentRunWriteOutcome {
  const locked = cancelLockedExistingStatus(driver, run.id, run.status);
  if (locked !== undefined) {
    return {
      applied: false,
      reason: "cancel_locked_status_sticky",
      existingStatus: locked,
    };
  }
  driver
    .prepareState(
      `INSERT INTO agent_runs (
        id,
        objective,
        status,
        started_at,
        last_active_at,
        current_session_id,
        created_by_client,
        last_snapshot_at,
        metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        objective = excluded.objective,
        status = excluded.status,
        started_at = excluded.started_at,
        last_active_at = excluded.last_active_at,
        current_session_id = excluded.current_session_id,
        created_by_client = excluded.created_by_client,
        last_snapshot_at = excluded.last_snapshot_at,
        metadata_json = excluded.metadata_json`,
    )
    .run(
      run.id,
      run.objective,
      run.status,
      run.startedAt,
      run.lastActiveAt,
      run.currentSessionId ?? null,
      run.createdByClient ?? null,
      run.lastSnapshotAt ?? null,
      run.metadata === undefined ? null : JSON.stringify(run.metadata),
    );
  return APPLIED;
}

export function updateAgentRunStatus(
  driver: StateSqliteDriver,
  update: AgenCStateAgentRunStatusUpdate,
): AgentRunWriteOutcome {
  const locked = cancelLockedExistingStatus(driver, update.id, update.status);
  if (locked !== undefined) {
    return {
      applied: false,
      reason: "cancel_locked_status_sticky",
      existingStatus: locked,
    };
  }
  const metadataJson =
    update.metadataPatch === undefined
      ? undefined
      : mergedAgentRunMetadataJson(driver, update.id, update.metadataPatch);
  if (metadataJson !== undefined) {
    driver
      .prepareState<[string, string, string | null, string | null, string, string]>(
        `UPDATE agent_runs
         SET status = ?,
             last_active_at = ?,
             current_session_id = CASE
               WHEN ? IS NULL THEN current_session_id
               ELSE ?
             END,
             metadata_json = ?
         WHERE id = ?`,
      )
      .run(
        update.status,
        update.lastActiveAt,
        update.currentSessionId ?? null,
        update.currentSessionId ?? null,
        metadataJson,
        update.id,
      );
    return APPLIED;
  }
  driver
    .prepareState<[string, string, string | null, string | null, string]>(
      `UPDATE agent_runs
       SET status = ?,
           last_active_at = ?,
           current_session_id = CASE
             WHEN ? IS NULL THEN current_session_id
             ELSE ?
           END
       WHERE id = ?`,
    )
    .run(
      update.status,
      update.lastActiveAt,
      update.currentSessionId ?? null,
      update.currentSessionId ?? null,
      update.id,
    );
  return APPLIED;
}

function mergedAgentRunMetadataJson(
  driver: StateSqliteDriver,
  runId: string,
  patch: JsonObject,
): string {
  const row = driver
    .prepareState<[string], { metadata_json: string | null }>(
      "SELECT metadata_json FROM agent_runs WHERE id = ?",
    )
    .get(runId);
  const existing = parseJsonObject(row?.metadata_json);
  return JSON.stringify({ ...existing, ...patch });
}

function parseJsonObject(value: string | null | undefined): JsonObject {
  if (value === null || value === undefined || value.trim().length === 0) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(value);
    const parsedRecord = asRecord(parsed);
    return parsedRecord === null ? {} : (parsedRecord as JsonObject);
  } catch {
    return {};
  }
}
