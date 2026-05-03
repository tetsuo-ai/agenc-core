import type { JsonValue } from "../app-server/protocol/index.js";
import { writeSessionSnapshotAtomically } from "./atomic-snapshot-writes.js";
import type { StateSqliteDriver } from "./sqlite-driver.js";

export const AGENC_STATE_EXPORT_FORMAT = "agenc.state.export";
export const AGENC_STATE_EXPORT_SCHEMA_VERSION = 1;

export interface AgenCStateExportAgentRun {
  readonly id: string;
  readonly objective: string;
  readonly status: string;
  readonly startedAt: string;
  readonly lastActiveAt: string;
  readonly currentSessionId?: string;
  readonly createdByClient?: string;
  readonly lastSnapshotAt?: string;
}

export interface AgenCStateExportSessionSnapshot {
  readonly sessionId: string;
  readonly snapshotAt: string;
  readonly conversation: JsonValue;
  readonly toolState: JsonValue;
  readonly mcpConnectionState: JsonValue;
}

export interface AgenCStateExportInFlightToolCall {
  readonly sessionId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args: JsonValue;
  readonly status: string;
  readonly outputPartial?: string;
  readonly startedAt: string;
}

export interface AgenCStateExportPayload {
  readonly format: typeof AGENC_STATE_EXPORT_FORMAT;
  readonly schemaVersion: typeof AGENC_STATE_EXPORT_SCHEMA_VERSION;
  readonly exportedAt: string;
  readonly projectDir: string;
  readonly agentRun: AgenCStateExportAgentRun;
  readonly sessionStateSnapshots: readonly AgenCStateExportSessionSnapshot[];
  readonly inFlightToolCalls: readonly AgenCStateExportInFlightToolCall[];
}

export interface AgenCStateImportResult {
  readonly agentId: string;
  readonly projectDir: string;
  readonly sessionIds: readonly string[];
  readonly snapshotCount: number;
  readonly toolCallCount: number;
}

interface AgentRunRow {
  readonly id: string;
  readonly objective: string;
  readonly status: string;
  readonly started_at: string;
  readonly last_active_at: string;
  readonly current_session_id: string | null;
  readonly created_by_client: string | null;
  readonly last_snapshot_at: string | null;
}

interface SessionStateSnapshotRow {
  readonly session_id: string;
  readonly snapshot_at: string;
  readonly conversation_json: string;
  readonly tool_state_json: string;
  readonly mcp_connection_state_json: string;
}

interface InFlightToolCallRow {
  readonly session_id: string;
  readonly tool_call_id: string;
  readonly tool_name: string;
  readonly args_json: string;
  readonly status: string;
  readonly output_partial: string | null;
  readonly started_at: string;
}

export class AgenCStateExportImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgenCStateExportImportError";
  }
}

export function exportAgentState(
  driver: StateSqliteDriver,
  agentId: string,
  options: { readonly now?: () => string } = {},
): AgenCStateExportPayload {
  const row = driver
    .prepareState<[string], AgentRunRow>(
      `SELECT
         id,
         objective,
         status,
         started_at,
         last_active_at,
         current_session_id,
         created_by_client,
         last_snapshot_at
       FROM agent_runs
       WHERE id = ?`,
    )
    .get(agentId);
  if (row === undefined) {
    throw new AgenCStateExportImportError(
      `agent state not found for agent id: ${agentId}`,
    );
  }

  const sessionIds =
    row.current_session_id === null ? [] : [row.current_session_id];
  return {
    format: AGENC_STATE_EXPORT_FORMAT,
    schemaVersion: AGENC_STATE_EXPORT_SCHEMA_VERSION,
    exportedAt: options.now?.() ?? new Date().toISOString(),
    projectDir: driver.projectDir,
    agentRun: agentRunFromRow(row),
    sessionStateSnapshots: loadSnapshots(driver, sessionIds),
    inFlightToolCalls: loadToolCalls(driver, sessionIds),
  };
}

export function importAgentState(
  driver: StateSqliteDriver,
  payload: AgenCStateExportPayload | unknown,
): AgenCStateImportResult {
  const normalized = normalizeExportPayload(payload);
  const importedSessionIds = sessionIdsForImport(normalized);
  const sessionIdsToReplace = mergeSessionIds(
    importedSessionIds,
    existingCurrentSessionId(driver, normalized.agentRun.id),
  );
  assertSessionIdsOwnedByImportAgent(
    driver,
    normalized.agentRun.id,
    sessionIdsToReplace,
  );

  driver.transaction(() => {
    for (const sessionId of sessionIdsToReplace) {
      driver
        .prepareState<[string]>(
          "DELETE FROM session_state_snapshots WHERE session_id = ?",
        )
        .run(sessionId);
      driver
        .prepareState<[string]>(
          "DELETE FROM in_flight_tool_calls WHERE session_id = ?",
        )
        .run(sessionId);
    }
    upsertAgentRun(driver, normalized.agentRun);
    insertSnapshots(driver, normalized.sessionStateSnapshots);
    insertToolCalls(driver, normalized.inFlightToolCalls);
  });

  return {
    agentId: normalized.agentRun.id,
    projectDir: driver.projectDir,
    sessionIds: importedSessionIds,
    snapshotCount: normalized.sessionStateSnapshots.length,
    toolCallCount: normalized.inFlightToolCalls.length,
  };
}

export function parseAgenCStateExportPayload(
  input: string,
): AgenCStateExportPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch (error) {
    throw new AgenCStateExportImportError(
      `state import payload is not valid JSON: ${errorMessage(error)}`,
    );
  }
  return normalizeExportPayload(parsed);
}

function agentRunFromRow(row: AgentRunRow): AgenCStateExportAgentRun {
  return {
    id: row.id,
    objective: row.objective,
    status: row.status,
    startedAt: row.started_at,
    lastActiveAt: row.last_active_at,
    ...(row.current_session_id !== null
      ? { currentSessionId: row.current_session_id }
      : {}),
    ...(row.created_by_client !== null
      ? { createdByClient: row.created_by_client }
      : {}),
    ...(row.last_snapshot_at !== null
      ? { lastSnapshotAt: row.last_snapshot_at }
      : {}),
  };
}

function loadSnapshots(
  driver: StateSqliteDriver,
  sessionIds: readonly string[],
): AgenCStateExportSessionSnapshot[] {
  if (sessionIds.length === 0) return [];
  return driver
    .prepareState<string[], SessionStateSnapshotRow>(
      `SELECT
         session_id,
         snapshot_at,
         conversation_json,
         tool_state_json,
         mcp_connection_state_json
       FROM session_state_snapshots
       WHERE session_id IN (${placeholders(sessionIds.length)})
       ORDER BY session_id ASC, snapshot_at ASC`,
    )
    .all(...sessionIds)
    .map((row) => ({
      sessionId: row.session_id,
      snapshotAt: row.snapshot_at,
      conversation: parseJsonField(row.conversation_json, "conversation_json"),
      toolState: parseJsonField(row.tool_state_json, "tool_state_json"),
      mcpConnectionState: parseJsonField(
        row.mcp_connection_state_json,
        "mcp_connection_state_json",
      ),
    }));
}

function loadToolCalls(
  driver: StateSqliteDriver,
  sessionIds: readonly string[],
): AgenCStateExportInFlightToolCall[] {
  if (sessionIds.length === 0) return [];
  return driver
    .prepareState<string[], InFlightToolCallRow>(
      `SELECT
         session_id,
         tool_call_id,
         tool_name,
         args_json,
         status,
         output_partial,
         started_at
       FROM in_flight_tool_calls
       WHERE session_id IN (${placeholders(sessionIds.length)})
       ORDER BY session_id ASC, started_at ASC, tool_call_id ASC`,
    )
    .all(...sessionIds)
    .map((row) => ({
      sessionId: row.session_id,
      toolCallId: row.tool_call_id,
      toolName: row.tool_name,
      args: parseJsonField(row.args_json, "args_json"),
      status: row.status,
      ...(row.output_partial !== null ? { outputPartial: row.output_partial } : {}),
      startedAt: row.started_at,
    }));
}

function upsertAgentRun(
  driver: StateSqliteDriver,
  run: AgenCStateExportAgentRun,
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
        last_snapshot_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        objective = excluded.objective,
        status = excluded.status,
        started_at = excluded.started_at,
        last_active_at = excluded.last_active_at,
        current_session_id = excluded.current_session_id,
        created_by_client = excluded.created_by_client,
        last_snapshot_at = excluded.last_snapshot_at`,
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
    );
}

function insertSnapshots(
  driver: StateSqliteDriver,
  snapshots: readonly AgenCStateExportSessionSnapshot[],
): void {
  for (const snapshot of snapshots) {
    writeSessionSnapshotAtomically(
      driver,
      {
        sessionId: snapshot.sessionId,
        snapshotAt: snapshot.snapshotAt,
        conversationJson: stringifyJsonValue(
          snapshot.conversation,
          "conversation",
        ),
        toolStateJson: stringifyJsonValue(snapshot.toolState, "toolState"),
        mcpConnectionStateJson: stringifyJsonValue(
          snapshot.mcpConnectionState,
          "mcpConnectionState",
        ),
      },
      { replayOnStartup: false },
    );
  }
}

function insertToolCalls(
  driver: StateSqliteDriver,
  toolCalls: readonly AgenCStateExportInFlightToolCall[],
): void {
  const insert = driver.prepareState(
    `INSERT INTO in_flight_tool_calls (
      session_id,
      tool_call_id,
      tool_name,
      args_json,
      status,
      output_partial,
      started_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const call of toolCalls) {
    insert.run(
      call.sessionId,
      call.toolCallId,
      call.toolName,
      stringifyJsonValue(call.args, "args"),
      call.status,
      call.outputPartial ?? null,
      call.startedAt,
    );
  }
}

function normalizeExportPayload(value: unknown): AgenCStateExportPayload {
  const payload = expectObject(value, "state import payload");
  if (payload.format !== AGENC_STATE_EXPORT_FORMAT) {
    throw new AgenCStateExportImportError(
      `state import payload format must be ${AGENC_STATE_EXPORT_FORMAT}`,
    );
  }
  if (payload.schemaVersion !== AGENC_STATE_EXPORT_SCHEMA_VERSION) {
    throw new AgenCStateExportImportError(
      `state import payload schemaVersion must be ${AGENC_STATE_EXPORT_SCHEMA_VERSION}`,
    );
  }
  const normalized: AgenCStateExportPayload = {
    format: AGENC_STATE_EXPORT_FORMAT,
    schemaVersion: AGENC_STATE_EXPORT_SCHEMA_VERSION,
    exportedAt: expectString(payload.exportedAt, "exportedAt"),
    projectDir: expectString(payload.projectDir, "projectDir"),
    agentRun: normalizeAgentRun(payload.agentRun),
    sessionStateSnapshots: expectArray(
      payload.sessionStateSnapshots,
      "sessionStateSnapshots",
    ).map(normalizeSnapshot),
    inFlightToolCalls: expectArray(
      payload.inFlightToolCalls,
      "inFlightToolCalls",
    ).map(normalizeToolCall),
  };
  validatePayloadSessionConsistency(normalized);
  return normalized;
}

function normalizeAgentRun(value: unknown): AgenCStateExportAgentRun {
  const run = expectObject(value, "agentRun");
  return {
    id: expectString(run.id, "agentRun.id"),
    objective: expectString(run.objective, "agentRun.objective"),
    status: expectString(run.status, "agentRun.status"),
    startedAt: expectString(run.startedAt, "agentRun.startedAt"),
    lastActiveAt: expectString(run.lastActiveAt, "agentRun.lastActiveAt"),
    ...optionalString(run.currentSessionId, "agentRun.currentSessionId"),
    ...optionalString(run.createdByClient, "agentRun.createdByClient"),
    ...optionalString(run.lastSnapshotAt, "agentRun.lastSnapshotAt"),
  };
}

function normalizeSnapshot(value: unknown): AgenCStateExportSessionSnapshot {
  const snapshot = expectObject(value, "sessionStateSnapshots[]");
  return {
    sessionId: expectString(snapshot.sessionId, "snapshot.sessionId"),
    snapshotAt: expectString(snapshot.snapshotAt, "snapshot.snapshotAt"),
    conversation: expectJsonValue(snapshot.conversation, "snapshot.conversation"),
    toolState: expectJsonValue(snapshot.toolState, "snapshot.toolState"),
    mcpConnectionState: expectJsonValue(
      snapshot.mcpConnectionState,
      "snapshot.mcpConnectionState",
    ),
  };
}

function normalizeToolCall(value: unknown): AgenCStateExportInFlightToolCall {
  const call = expectObject(value, "inFlightToolCalls[]");
  return {
    sessionId: expectString(call.sessionId, "toolCall.sessionId"),
    toolCallId: expectString(call.toolCallId, "toolCall.toolCallId"),
    toolName: expectString(call.toolName, "toolCall.toolName"),
    args: expectJsonValue(call.args, "toolCall.args"),
    status: expectString(call.status, "toolCall.status"),
    ...optionalString(call.outputPartial, "toolCall.outputPartial"),
    startedAt: expectString(call.startedAt, "toolCall.startedAt"),
  };
}

function sessionIdsForImport(
  payload: AgenCStateExportPayload,
): readonly string[] {
  const sessionIds = new Set<string>();
  if (payload.agentRun.currentSessionId !== undefined) {
    sessionIds.add(payload.agentRun.currentSessionId);
  }
  for (const snapshot of payload.sessionStateSnapshots) {
    sessionIds.add(snapshot.sessionId);
  }
  for (const call of payload.inFlightToolCalls) {
    sessionIds.add(call.sessionId);
  }
  return [...sessionIds].sort();
}

function validatePayloadSessionConsistency(
  payload: AgenCStateExportPayload,
): void {
  const currentSessionId = payload.agentRun.currentSessionId;
  const rowSessionIds = [
    ...payload.sessionStateSnapshots.map((snapshot) => snapshot.sessionId),
    ...payload.inFlightToolCalls.map((call) => call.sessionId),
  ];
  if (currentSessionId === undefined) {
    if (rowSessionIds.length > 0) {
      throw new AgenCStateExportImportError(
        "state import payload includes session rows but agentRun.currentSessionId is absent",
      );
    }
    return;
  }
  const mismatched = rowSessionIds.find(
    (sessionId) => sessionId !== currentSessionId,
  );
  if (mismatched !== undefined) {
    throw new AgenCStateExportImportError(
      `state import payload session id ${mismatched} does not match agentRun.currentSessionId ${currentSessionId}`,
    );
  }
}

function existingCurrentSessionId(
  driver: StateSqliteDriver,
  agentId: string,
): string | undefined {
  const row = driver
    .prepareState<[string], { current_session_id: string | null }>(
      "SELECT current_session_id FROM agent_runs WHERE id = ?",
    )
    .get(agentId);
  return row?.current_session_id ?? undefined;
}

function assertSessionIdsOwnedByImportAgent(
  driver: StateSqliteDriver,
  agentId: string,
  sessionIds: readonly string[],
): void {
  if (sessionIds.length === 0) return;
  const conflict = driver
    .prepareState<unknown[], { id: string; current_session_id: string }>(
      `SELECT id, current_session_id
       FROM agent_runs
       WHERE current_session_id IN (${placeholders(sessionIds.length)})
         AND id != ?
       ORDER BY id ASC
       LIMIT 1`,
    )
    .get(...sessionIds, agentId);
  if (conflict === undefined) return;
  throw new AgenCStateExportImportError(
    `state import session id ${conflict.current_session_id} is already owned by agent ${conflict.id}`,
  );
}

function mergeSessionIds(
  left: readonly string[],
  right: string | undefined,
): readonly string[] {
  const merged = new Set(left);
  if (right !== undefined) merged.add(right);
  return [...merged].sort();
}

function expectObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new AgenCStateExportImportError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function expectArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new AgenCStateExportImportError(`${label} must be an array`);
  }
  return value;
}

function expectString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new AgenCStateExportImportError(`${label} must be a non-empty string`);
  }
  return value;
}

function optionalString(
  value: unknown,
  label: string,
): Record<string, string> {
  if (value === undefined) return {};
  return { [label.split(".").at(-1) ?? label]: expectString(value, label) };
}

function expectJsonValue(value: unknown, label: string): JsonValue {
  try {
    return JSON.parse(JSON.stringify(value)) as JsonValue;
  } catch (error) {
    throw new AgenCStateExportImportError(
      `${label} must be JSON-serializable: ${errorMessage(error)}`,
    );
  }
}

function stringifyJsonValue(value: JsonValue, label: string): string {
  try {
    return JSON.stringify(value);
  } catch (error) {
    throw new AgenCStateExportImportError(
      `${label} must be JSON-serializable: ${errorMessage(error)}`,
    );
  }
}

function parseJsonField(raw: string, label: string): JsonValue {
  try {
    return JSON.parse(raw) as JsonValue;
  } catch (error) {
    throw new AgenCStateExportImportError(
      `stored ${label} is not valid JSON: ${errorMessage(error)}`,
    );
  }
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
