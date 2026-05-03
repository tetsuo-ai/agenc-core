import type { StateSqliteDriver } from "./sqlite-driver.js";

const RECOVERABLE_AGENT_RUN_STATUSES = [
  "pending",
  "running",
  "working",
  "paused",
  "blocked",
  "suspended",
] as const;

const TERMINAL_TOOL_CALL_STATUSES = [
  "completed",
  "failed",
  "cancelled",
] as const;

export type AgentRunRecoveryStatus =
  (typeof RECOVERABLE_AGENT_RUN_STATUSES)[number];

export interface RecoveredSessionStateSnapshot {
  readonly projectDir: string;
  readonly sessionId: string;
  readonly snapshotAt: string;
  readonly conversation: unknown;
  readonly toolState: unknown;
  readonly mcpConnectionState: unknown;
  readonly failedToolCalls: readonly FailedInFlightToolCall[];
}

export interface RecoveredAgentRun {
  readonly projectDir: string;
  readonly id: string;
  readonly objective: string;
  readonly status: AgentRunRecoveryStatus;
  readonly startedAt: string;
  readonly lastActiveAt: string;
  readonly currentSessionId?: string;
  readonly createdByClient?: string;
  readonly lastSnapshotAt?: string;
  readonly latestSnapshot?: RecoveredSessionStateSnapshot;
}

export interface FailedInFlightToolCall {
  readonly projectDir: string;
  readonly sessionId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args?: unknown;
  readonly statusBefore: string;
  readonly startedAt: string;
  readonly outputPartial?: string;
  readonly outputLogPath?: string;
  readonly outputLogBytes?: number;
}

export type DaemonStartupRecoveryWarningCode =
  | "snapshot_missing"
  | "snapshot_json_invalid"
  | "tool_args_json_invalid";

export interface DaemonStartupRecoveryWarning {
  readonly code: DaemonStartupRecoveryWarningCode;
  readonly message: string;
  readonly runId?: string;
  readonly sessionId?: string;
  readonly toolCallId?: string;
}

export interface DaemonStartupRecoveryReport {
  readonly recoveredAt: string;
  readonly recoveredRuns: readonly RecoveredAgentRun[];
  readonly failedToolCalls: readonly FailedInFlightToolCall[];
  readonly warnings: readonly DaemonStartupRecoveryWarning[];
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
  readonly output_log_path: string | null;
  readonly output_log_bytes: number;
  readonly started_at: string;
}

export function recoverDaemonStateOnStartup(
  driver: StateSqliteDriver,
  options: { readonly now?: () => string } = {},
): DaemonStartupRecoveryReport {
  const warnings: DaemonStartupRecoveryWarning[] = [];
  const recoveredAt = options.now?.() ?? new Date().toISOString();
  return driver.transaction(() => {
    const failedToolCalls = markStaleToolCallsFailed(driver, warnings);
    const recoveredRuns = loadRecoverableAgentRuns(
      driver,
      failedToolCalls,
      warnings,
    );
    return {
      recoveredAt,
      recoveredRuns,
      failedToolCalls,
      warnings,
    };
  });
}

function loadRecoverableAgentRuns(
  driver: StateSqliteDriver,
  failedToolCalls: readonly FailedInFlightToolCall[],
  warnings: DaemonStartupRecoveryWarning[],
): RecoveredAgentRun[] {
  const runs = driver
    .prepareState<string[], AgentRunRow>(
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
       WHERE status IN (${placeholders(RECOVERABLE_AGENT_RUN_STATUSES.length)})
       ORDER BY last_active_at ASC, id ASC`,
    )
    .all(...RECOVERABLE_AGENT_RUN_STATUSES);
  return runs.map((row) =>
    toRecoveredAgentRun(driver, row, failedToolCalls, warnings),
  );
}

function toRecoveredAgentRun(
  driver: StateSqliteDriver,
  row: AgentRunRow,
  failedToolCalls: readonly FailedInFlightToolCall[],
  warnings: DaemonStartupRecoveryWarning[],
): RecoveredAgentRun {
  const currentSessionId = nullableString(row.current_session_id);
  const createdByClient = nullableString(row.created_by_client);
  const lastSnapshotAt = nullableString(row.last_snapshot_at);
  const latestSnapshot =
    currentSessionId === undefined
      ? undefined
      : loadLatestSnapshot(
          driver,
          row.id,
          currentSessionId,
          failedToolCalls,
          warnings,
        );
  return {
    projectDir: driver.projectDir,
    id: row.id,
    objective: row.objective,
    status: row.status as AgentRunRecoveryStatus,
    startedAt: row.started_at,
    lastActiveAt: row.last_active_at,
    ...(currentSessionId !== undefined ? { currentSessionId } : {}),
    ...(createdByClient !== undefined ? { createdByClient } : {}),
    ...(lastSnapshotAt !== undefined ? { lastSnapshotAt } : {}),
    ...(latestSnapshot !== undefined ? { latestSnapshot } : {}),
  };
}

function loadLatestSnapshot(
  driver: StateSqliteDriver,
  runId: string,
  sessionId: string,
  failedToolCalls: readonly FailedInFlightToolCall[],
  warnings: DaemonStartupRecoveryWarning[],
): RecoveredSessionStateSnapshot | undefined {
  const row = driver
    .prepareState<[string], SessionStateSnapshotRow>(
      `SELECT
         session_id,
         snapshot_at,
         conversation_json,
         tool_state_json,
         mcp_connection_state_json
       FROM session_state_snapshots
       WHERE session_id = ?
       ORDER BY snapshot_at DESC
       LIMIT 1`,
    )
    .get(sessionId);
  if (row === undefined) {
    warnings.push({
      code: "snapshot_missing",
      runId,
      sessionId,
      message: `No session snapshot found for recoverable agent run ${runId}`,
    });
    return undefined;
  }
  try {
    const failedForSession = failedToolCalls.filter(
      (call) =>
        call.projectDir === driver.projectDir && call.sessionId === sessionId,
    );
    return {
      projectDir: driver.projectDir,
      sessionId: row.session_id,
      snapshotAt: row.snapshot_at,
      conversation: JSON.parse(row.conversation_json),
      toolState: JSON.parse(row.tool_state_json),
      mcpConnectionState: JSON.parse(row.mcp_connection_state_json),
      failedToolCalls: failedForSession,
    };
  } catch (error) {
    warnings.push({
      code: "snapshot_json_invalid",
      runId,
      sessionId,
      message: `Session snapshot for recoverable agent run ${runId} is not valid JSON: ${errorMessage(error)}`,
    });
    return undefined;
  }
}

function markStaleToolCallsFailed(
  driver: StateSqliteDriver,
  warnings: DaemonStartupRecoveryWarning[],
): FailedInFlightToolCall[] {
  const rows = driver
    .prepareState<string[], InFlightToolCallRow>(
      `SELECT
         session_id,
         tool_call_id,
         tool_name,
         args_json,
         status,
         output_partial,
         output_log_path,
         output_log_bytes,
         started_at
       FROM in_flight_tool_calls
       WHERE status NOT IN (${placeholders(TERMINAL_TOOL_CALL_STATUSES.length)})
       ORDER BY started_at ASC, session_id ASC, tool_call_id ASC`,
    )
    .all(...TERMINAL_TOOL_CALL_STATUSES);
  if (rows.length === 0) return [];

  const markFailed = driver.prepareState<[string, string, ...string[]]>(
    `UPDATE in_flight_tool_calls
     SET status = 'failed'
     WHERE session_id = ?
       AND tool_call_id = ?
       AND status NOT IN (${placeholders(TERMINAL_TOOL_CALL_STATUSES.length)})`,
  );
  for (const row of rows) {
    markFailed.run(
      row.session_id,
      row.tool_call_id,
      ...TERMINAL_TOOL_CALL_STATUSES,
    );
  }
  return rows.map((row) => toFailedToolCall(driver, row, warnings));
}

function toFailedToolCall(
  driver: StateSqliteDriver,
  row: InFlightToolCallRow,
  warnings: DaemonStartupRecoveryWarning[],
): FailedInFlightToolCall {
  let args: unknown;
  try {
    args = JSON.parse(row.args_json);
  } catch (error) {
    warnings.push({
      code: "tool_args_json_invalid",
      sessionId: row.session_id,
      toolCallId: row.tool_call_id,
      message: `In-flight tool call ${row.tool_call_id} arguments are not valid JSON: ${errorMessage(error)}`,
    });
  }
  return {
    projectDir: driver.projectDir,
    sessionId: row.session_id,
    toolCallId: row.tool_call_id,
    toolName: row.tool_name,
    ...(args !== undefined ? { args } : {}),
    statusBefore: row.status,
    startedAt: row.started_at,
    ...(row.output_partial !== null ? { outputPartial: row.output_partial } : {}),
    ...(row.output_log_path !== null ? { outputLogPath: row.output_log_path } : {}),
    ...(row.output_log_bytes > 0 ? { outputLogBytes: row.output_log_bytes } : {}),
  };
}

function placeholders(length: number): string {
  return Array.from({ length }, () => "?").join(", ");
}

function nullableString(value: string | null): string | undefined {
  return value === null || value.length === 0 ? undefined : value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
