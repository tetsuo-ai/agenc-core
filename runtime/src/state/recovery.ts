import type { StateSqliteDriver } from "./sqlite-driver.js";
import type { JsonObject } from "../app-server/protocol/index.js";
import type { ToolRecoveryCategory } from "../tools/types.js";
import { sqlPlaceholders } from "./sql.js";
import { normalizeToolRecoveryCategory } from "./tool-output-rotation.js";
import {
  cancelAgentRunTree,
  repairCancelledSubtrees,
} from "./run-cancellation.js";
import { asRecord } from "../utils/record.js";
import {
  recoverCanonicalRunJournalsOnStartup,
  recoverPendingEffectReviewsOnStartup,
} from "./startup-run-journal-recovery.js";

const RECOVERABLE_AGENT_RUN_STATUSES = [
  "pending",
  "running",
  "working",
  "paused",
  "blocked",
  "suspended",
] as const;

const MAX_ADMISSION_CANCEL_REPAIRS = 4_096;

const TERMINAL_TOOL_CALL_STATUSES = [
  "completed",
  "failed",
  "cancelled",
  "poisoned",
  "recovery_cancelled",
  // Written by explicit review of an unknown-outcome effect
  // (resolveUnknownOutcomeEffect): terminal AND deliberately absent from
  // RECOVERY_SURFACE_TOOL_CALL_STATUSES — a resolved effect stops
  // re-surfacing and the mutation gate lifts.
  "unknown_resolved",
] as const;

const RECOVERY_SURFACE_TOOL_CALL_STATUSES = [
  "poisoned",
  "replay_pending",
  "recovery_cancelled",
] as const;

export type ToolRecoveryAction = "replay" | "poison" | "cancel";

export type AgentRunRecoveryStatus =
  (typeof RECOVERABLE_AGENT_RUN_STATUSES)[number];

export interface RecoveredSessionStateSnapshot {
  readonly projectDir: string;
  readonly sessionId: string;
  readonly snapshotAt: string;
  readonly conversation: unknown;
  readonly toolState: unknown;
  readonly mcpConnectionState: unknown;
  readonly recoveredToolCalls: readonly RecoveredInFlightToolCall[];
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
  readonly metadata?: JsonObject;
  readonly latestSnapshot?: RecoveredSessionStateSnapshot;
}

export interface RecoveredInFlightToolCall {
  readonly projectDir: string;
  readonly sessionId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args?: unknown;
  readonly statusBefore: string;
  readonly statusAfter: string;
  readonly recoveryCategory: ToolRecoveryCategory;
  readonly recoveryAction: ToolRecoveryAction;
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
  readonly recoveredToolCalls: readonly RecoveredInFlightToolCall[];
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
  readonly metadata_json: string | null;
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
  readonly recovery_category: string;
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
  // The rollout JSONL is the M4 authority. Rebuild its SQLite projection
  // before stale tool classification or the recoverable-run load so a crash
  // after fsyncing `run_terminal`/`effect_result` cannot resurrect or replay
  // work merely because the legacy snapshot write did not happen.
  recoverCanonicalRunJournalsOnStartup(driver, {
    recoverableStatuses: RECOVERABLE_AGENT_RUN_STATUSES,
  });
  // Older run.cancel implementations could commit the SQLite cancellation
  // cascade immediately before the live writer projected its canonical
  // terminal. Repair only the bounded set of cancelled M4 runs that have an
  // explicit journal binding and still lack a current terminal result. This
  // avoids making all historical offline cancellations part of startup work.
  // If no canonical terminal is present, the row remains cancelled with
  // deliberately unavailable output; recovery never invents a result.
  recoverCanonicalRunJournalsOnStartup(driver, {
    recoverableStatuses: ["cancelled"],
    onlyMissingTerminalResults: true,
    requireJournalBinding: true,
  });
  // A stopped terminal run may later receive one explicitly leased operator
  // review event. Catch up that durable audit evidence independently of run
  // status so a crash after journal fsync cannot strand the mutation gate.
  recoverPendingEffectReviewsOnStartup(driver);
  return driver.transaction(() => {
    // A live two-phase cancellation settles admissions while the canonical
    // Session listener is still open, then writes the terminal tail, then
    // projects agent_runs/spawn edges. A crash between the first two phases
    // leaves an admission cancel-lock but must never restore runnable work.
    repairAdmissionCancelledAgentRuns(driver);
    // Crash-mid-cascade repair MUST precede the recoverable-run load: a
    // surviving descendant of a cancelled parent is finished off here so
    // the restore loop never resurrects it.
    repairCancelledSubtrees(driver, { now: recoveredAt });
    const recoveredToolCalls = recoverStaleToolCalls(driver, warnings);
    const recoveredRuns = loadRecoverableAgentRuns(
      driver,
      recoveredToolCalls,
      warnings,
    );
    return {
      recoveredAt,
      recoveredRuns,
      recoveredToolCalls,
      warnings,
    };
  });
}

function repairAdmissionCancelledAgentRuns(driver: StateSqliteDriver): void {
  const rows = driver
    .prepareState<
      unknown[],
      { readonly id: string; readonly reason: string; readonly cancelled_at: string }
    >(
      `SELECT runs.id, cancellation.reason, cancellation.cancelled_at
       FROM agent_runs AS runs
       JOIN execution_admission_cancellations AS cancellation
         ON cancellation.run_id = runs.id
       WHERE runs.status IN (${sqlPlaceholders(RECOVERABLE_AGENT_RUN_STATUSES.length)})
       ORDER BY cancellation.cancelled_at ASC, runs.id ASC
       LIMIT ?`,
    )
    .all(...RECOVERABLE_AGENT_RUN_STATUSES, MAX_ADMISSION_CANCEL_REPAIRS + 1);
  if (rows.length > MAX_ADMISSION_CANCEL_REPAIRS) {
    throw new Error(
      `daemon startup admission-cancellation repair exceeds ${MAX_ADMISSION_CANCEL_REPAIRS} runs`,
    );
  }
  for (const row of rows) {
    cancelAgentRunTree(driver, {
      runId: row.id,
      reason: row.reason,
      cancelledAt: row.cancelled_at,
    });
  }
}

function loadRecoverableAgentRuns(
  driver: StateSqliteDriver,
  recoveredToolCalls: readonly RecoveredInFlightToolCall[],
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
         last_snapshot_at,
         metadata_json
       FROM agent_runs
       WHERE status IN (${sqlPlaceholders(RECOVERABLE_AGENT_RUN_STATUSES.length)})
       ORDER BY last_active_at ASC, id ASC`,
    )
    .all(...RECOVERABLE_AGENT_RUN_STATUSES);
  return runs.map((row) =>
    toRecoveredAgentRun(driver, row, recoveredToolCalls, warnings),
  );
}

function toRecoveredAgentRun(
  driver: StateSqliteDriver,
  row: AgentRunRow,
  recoveredToolCalls: readonly RecoveredInFlightToolCall[],
  warnings: DaemonStartupRecoveryWarning[],
): RecoveredAgentRun {
  const currentSessionId = nullableString(row.current_session_id);
  const createdByClient = nullableString(row.created_by_client);
  const lastSnapshotAt = nullableString(row.last_snapshot_at);
  const metadata = parseJsonObject(row.metadata_json);
  const latestSnapshot =
    currentSessionId === undefined
      ? undefined
      : loadLatestSnapshot(
          driver,
          row.id,
          currentSessionId,
          recoveredToolCalls,
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
    ...(metadata !== undefined ? { metadata } : {}),
    ...(latestSnapshot !== undefined ? { latestSnapshot } : {}),
  };
}

function loadLatestSnapshot(
  driver: StateSqliteDriver,
  runId: string,
  sessionId: string,
  recoveredToolCalls: readonly RecoveredInFlightToolCall[],
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
    const recoveredForSession = recoveredToolCalls.filter(
      (call) =>
        call.projectDir === driver.projectDir && call.sessionId === sessionId,
    );
    return {
      projectDir: driver.projectDir,
      sessionId: row.session_id,
      snapshotAt: row.snapshot_at,
      conversation: JSON.parse(row.conversation_json),
      toolState: applyRecoveredToolState(
        JSON.parse(row.tool_state_json),
        recoveredForSession,
      ),
      mcpConnectionState: JSON.parse(row.mcp_connection_state_json),
      recoveredToolCalls: recoveredForSession,
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

function recoverStaleToolCalls(
  driver: StateSqliteDriver,
  warnings: DaemonStartupRecoveryWarning[],
): RecoveredInFlightToolCall[] {
  const rows = driver
    .prepareState<string[], InFlightToolCallRow>(
      `SELECT
         session_id,
         tool_call_id,
         tool_name,
         args_json,
         status,
         recovery_category,
         output_partial,
         output_log_path,
         output_log_bytes,
         started_at
       FROM in_flight_tool_calls
       WHERE status NOT IN (${sqlPlaceholders(TERMINAL_TOOL_CALL_STATUSES.length)})
       ORDER BY started_at ASC, session_id ASC, tool_call_id ASC`,
    )
    .all(...TERMINAL_TOOL_CALL_STATUSES);

  const freshlyRecovered = rows.map((row) =>
    toRecoveredToolCall(driver, row, warnings),
  );
  if (freshlyRecovered.length > 0) {
    const markRecovered = driver.prepareState<
      [string, string, string, ...string[]]
    >(
      `UPDATE in_flight_tool_calls
       SET status = ?
       WHERE session_id = ?
         AND tool_call_id = ?
         AND status NOT IN (${sqlPlaceholders(TERMINAL_TOOL_CALL_STATUSES.length)})`,
    );
    for (const call of freshlyRecovered) {
      markRecovered.run(
        call.statusAfter,
        call.sessionId,
        call.toolCallId,
        ...TERMINAL_TOOL_CALL_STATUSES,
      );
    }
  }
  const freshKeys = new Set(
    rows.map((row) => toolCallKey(row.session_id, row.tool_call_id)),
  );
  const surfacedEarlier = loadPreviouslyRecoveredToolCalls(
    driver,
    freshKeys,
    warnings,
  );
  return [...freshlyRecovered, ...surfacedEarlier];
}

function loadPreviouslyRecoveredToolCalls(
  driver: StateSqliteDriver,
  excludeKeys: ReadonlySet<string>,
  warnings: DaemonStartupRecoveryWarning[],
): RecoveredInFlightToolCall[] {
  const rows = driver
    .prepareState<string[], InFlightToolCallRow>(
      `SELECT
         session_id,
         tool_call_id,
         tool_name,
         args_json,
         status,
         recovery_category,
         output_partial,
         output_log_path,
         output_log_bytes,
         started_at
       FROM in_flight_tool_calls
       WHERE status IN (${sqlPlaceholders(RECOVERY_SURFACE_TOOL_CALL_STATUSES.length)})
       ORDER BY started_at ASC, session_id ASC, tool_call_id ASC`,
    )
    .all(...RECOVERY_SURFACE_TOOL_CALL_STATUSES);
  return rows
    .filter((row) => !excludeKeys.has(toolCallKey(row.session_id, row.tool_call_id)))
    .map((row) => toRecoveredToolCall(driver, row, warnings));
}

function toolCallKey(sessionId: string, toolCallId: string): string {
  return `${sessionId}\0${toolCallId}`;
}

function toRecoveredToolCall(
  driver: StateSqliteDriver,
  row: InFlightToolCallRow,
  warnings: DaemonStartupRecoveryWarning[],
): RecoveredInFlightToolCall {
  let args: unknown;
  let argsJsonInvalid = false;
  try {
    args = JSON.parse(row.args_json);
  } catch (error) {
    argsJsonInvalid = true;
    warnings.push({
      code: "tool_args_json_invalid",
      sessionId: row.session_id,
      toolCallId: row.tool_call_id,
      message: `In-flight tool call ${row.tool_call_id} arguments are not valid JSON: ${errorMessage(error)}`,
    });
  }
  const recoveryCategory = normalizeToolRecoveryCategory(row.recovery_category);
  const outcome =
    argsJsonInvalid && recoveryCategory === "idempotent"
      ? { action: "poison" as const, statusAfter: "poisoned" }
      : toolRecoveryOutcome(recoveryCategory);
  return {
    projectDir: driver.projectDir,
    sessionId: row.session_id,
    toolCallId: row.tool_call_id,
    toolName: row.tool_name,
    ...(args !== undefined ? { args } : {}),
    statusBefore: row.status,
    statusAfter: outcome.statusAfter,
    recoveryCategory,
    recoveryAction: outcome.action,
    startedAt: row.started_at,
    ...(row.output_partial !== null ? { outputPartial: row.output_partial } : {}),
    ...(row.output_log_path !== null ? { outputLogPath: row.output_log_path } : {}),
    ...(row.output_log_bytes > 0 ? { outputLogBytes: row.output_log_bytes } : {}),
  };
}

function toolRecoveryOutcome(
  recoveryCategory: ToolRecoveryCategory,
): {
  readonly action: ToolRecoveryAction;
  readonly statusAfter: string;
} {
  switch (recoveryCategory) {
    case "idempotent":
      return { action: "replay", statusAfter: "replay_pending" };
    case "interactive":
      return { action: "cancel", statusAfter: "recovery_cancelled" };
    case "side-effecting":
      return { action: "poison", statusAfter: "poisoned" };
  }
}

function applyRecoveredToolState(
  toolState: unknown,
  recoveredToolCalls: readonly RecoveredInFlightToolCall[],
): unknown {
  if (
    toolState === null ||
    typeof toolState !== "object" ||
    Array.isArray(toolState) ||
    recoveredToolCalls.length === 0
  ) {
    return toolState;
  }
  const state = { ...(toolState as Record<string, unknown>) };
  const recoveredIds = new Set(
    recoveredToolCalls.map((call) => call.toolCallId),
  );
  const pending = state.pending;
  if (Array.isArray(pending)) {
    state.pending = pending.filter(
      (value) => typeof value !== "string" || !recoveredIds.has(value),
    );
  }
  state.inFlight = reconcileRecoveredToolCallMap(
    state.inFlight,
    recoveredToolCalls,
    "inFlight",
  );
  state.completed = reconcileRecoveredToolCallMap(
    state.completed,
    recoveredToolCalls.filter((call) => call.recoveryAction !== "replay"),
    "completed",
  );
  return state;
}

function reconcileRecoveredToolCallMap(
  value: unknown,
  recoveredToolCalls: readonly RecoveredInFlightToolCall[],
  target: "inFlight" | "completed",
): Record<string, unknown> {
  const map = { ...(asRecord(value) ?? {}) };
  for (const call of recoveredToolCalls) {
    if (target === "inFlight" && call.recoveryAction !== "replay") {
      delete map[call.toolCallId];
      continue;
    }
    map[call.toolCallId] = {
      ...(valueAtKeyAsRecord(map, call.toolCallId) ?? {}),
      requestId: call.toolCallId,
      toolName: call.toolName,
      status: call.statusAfter,
      recoveryCategory: call.recoveryCategory,
      recoveryAction: call.recoveryAction,
    };
  }
  return map;
}

function valueAtKeyAsRecord(
  map: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = map[key];
  return asRecord(value) ?? undefined;
}

function nullableString(value: string | null): string | undefined {
  return value === null || value.length === 0 ? undefined : value;
}

function parseJsonObject(value: string | null): JsonObject | undefined {
  if (value === null || value.length === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    const parsedRecord = asRecord(parsed);
    if (parsedRecord !== null) return parsedRecord as JsonObject;
  } catch {
    return undefined;
  }
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
