import type { StateSqliteDriver } from "./sqlite-driver.js";
import type { JsonObject } from "../app-server/protocol/index.js";
import { asRecord } from "../utils/record.js";

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
    return;
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
