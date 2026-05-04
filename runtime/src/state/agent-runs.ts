import type { StateSqliteDriver } from "./sqlite-driver.js";
import type { JsonObject } from "../app-server/protocol/index.js";

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
}

export function upsertAgentRun(
  driver: StateSqliteDriver,
  run: AgenCStateAgentRunRecord,
): void {
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
}

export function updateAgentRunStatus(
  driver: StateSqliteDriver,
  update: AgenCStateAgentRunStatusUpdate,
): void {
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
}
