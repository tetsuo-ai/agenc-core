import { createHash } from "node:crypto";
import { existsSync } from "node:fs";

import Database from "better-sqlite3";
import type BetterSqlite3 from "better-sqlite3";

import type {
  JsonObject,
  JsonValue,
  RunEvidenceParams,
  RunEvidenceResult,
  RunReplayParams,
  RunReplayResult,
  RunResultParams,
  RunResultResult,
  RunStatusParams,
  RunStatusResult,
} from "./protocol/index.js";
import { isTerminalAgentRunStatus } from "../state/run-cancellation.js";
import {
  openStateDatabasePaths,
  type StateDatabasePaths,
} from "../state/sqlite-driver.js";
import { recoverCanonicalRunJournalForRun } from "../state/startup-run-journal-recovery.js";
import { buildCanonicalRunReplay } from "./run-journal-replay.js";

export const DEFAULT_RUN_REPLAY_LIMIT = 100;
export const MAX_RUN_REPLAY_LIMIT = 200;

export type AgenCDaemonRunInspectionErrorCode =
  | "INVALID_ARGUMENT"
  | "RUN_ID_AMBIGUOUS"
  | "RUN_NOT_FOUND"
  | "RUN_NOT_TERMINAL";

export class AgenCDaemonRunInspectionError extends Error {
  readonly code: AgenCDaemonRunInspectionErrorCode;

  constructor(code: AgenCDaemonRunInspectionErrorCode, message: string) {
    super(message);
    this.name = "AgenCDaemonRunInspectionError";
    this.code = code;
  }
}

export interface AgenCDaemonRunInspectionOptions {
  /**
   * Fresh discovery on every request keeps projects created after daemon
   * startup visible. Callers should return only state DBs owned by this
   * daemon home; the service opens them read-only and never runs migrations.
   */
  readonly stateDatabasePaths: () => readonly StateDatabasePaths[];
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

interface LocatedRun {
  readonly paths: StateDatabasePaths;
  readonly run?: AgentRunRow;
}

interface RunTerminalRow {
  readonly run_id: string;
  readonly epoch: number;
  readonly status: string;
  readonly exit_code: number | null;
  readonly stop_reason: string | null;
  readonly final_message: string | null;
  readonly usage_json: string | null;
  readonly last_sequence: number | null;
  readonly finished_at: string;
  readonly event_id: string;
}

interface CountByStatusRow {
  readonly status: string;
  readonly count: number;
}

interface AdmissionStepAggregateRow {
  readonly count: number;
  readonly updated_at: string | null;
}

interface ReservationAggregateRow {
  readonly count: number;
  readonly open_count: number;
  readonly reserved_tokens: number;
  readonly reserved_cost_nanos: number;
  readonly actual_tokens: number;
  readonly actual_cost_nanos: number;
  readonly unpriced_actual_count: number;
  readonly used_tokens: number;
  readonly held_tokens: number;
  readonly used_cost_nanos: number;
  readonly held_cost_nanos: number;
}

interface AllocationAggregateRow {
  readonly count: number;
  readonly blocked_count: number;
}

interface JournalBoundsRow {
  readonly first_sequence: number | null;
  readonly last_sequence: number | null;
}

interface AdmissionJournalRow {
  readonly sequence: number;
  readonly event_id: string;
  readonly timestamp: string;
  readonly run_id: string;
  readonly step_id: string;
  readonly kind: string;
  readonly event: string;
  readonly reason: string | null;
  readonly reservation_id: string | null;
  readonly model: string | null;
  readonly provider: string | null;
  readonly reserved_tokens: number | null;
  readonly reserved_cost_nanos: number | null;
  readonly actual_tokens: number | null;
  readonly actual_cost_nanos: number | null;
  readonly details_json: string;
}

const NANO_USD_PER_USD = 1_000_000_000;
const MAX_RUN_TREE_IDS = 1_000;

/**
 * Read-only implementation of the first public run introspection slice.
 *
 * Deliberately narrow: the existing `agent_runs` row is the terminal-run
 * authority and the existing execution-admission journal is the replay and
 * evidence source. This service does not synthesize an M4 workflow journal or
 * a terminal assistant payload that was never persisted.
 */
export class AgenCDaemonRunInspectionService {
  readonly #stateDatabasePaths: () => readonly StateDatabasePaths[];

  constructor(options: AgenCDaemonRunInspectionOptions) {
    this.#stateDatabasePaths = options.stateDatabasePaths;
  }

  status(params: RunStatusParams): RunStatusResult {
    const runId = normalizeRunId(params.runId, "run.status");
    const located = this.#locate(runId);
    refreshRunJournalProjection(located.paths, runId);
    return withReadonlyStateDatabase(located.paths, (db) =>
      buildRunStatus(db, located, runId),
    );
  }

  replay(params: RunReplayParams): RunReplayResult {
    const runId = normalizeRunId(params.runId, "run.replay");
    const afterSequence = normalizeAfterSequence(params.afterSequence);
    const limit = normalizeReplayLimit(params.limit);
    const located = this.#locate(runId);
    refreshRunJournalProjection(located.paths, runId);
    return withReadonlyStateDatabase(located.paths, (db) =>
      buildRunReplay(db, located, runId, afterSequence, limit),
    );
  }

  result(params: RunResultParams): RunResultResult {
    const runId = normalizeRunId(params.runId, "run.result");
    const located = this.#locate(runId);
    refreshRunJournalProjection(located.paths, runId);
    return withReadonlyStateDatabase(located.paths, (db) => {
      const run = readAgentRun(db, runId) ?? located.run;
      const durableTerminal = readCurrentTerminalResult(db, runId);
      const status = buildRunStatus(db, located, runId);
      if (
        durableTerminal === undefined &&
        (run === undefined || !status.terminal)
      ) {
        throw new AgenCDaemonRunInspectionError(
          "RUN_NOT_TERMINAL",
          `run.result: run ${runId} is not durably terminal (status: ${status.status})`,
        );
      }
      if (durableTerminal !== undefined) {
        return {
          runId,
          status: durableTerminal.status,
          terminal: true,
          terminalAt: durableTerminal.finished_at,
          outcome: terminalOutcome(durableTerminal.status),
          epoch: durableTerminal.epoch,
          ...(run !== undefined ? { durableRun: durableRunFromRow(run) } : {}),
          output: {
            available: true,
            exitCode: durableTerminal.exit_code,
            stopReason: durableTerminal.stop_reason,
            finalMessage: durableTerminal.final_message,
            usage: parseRunUsage(durableTerminal.usage_json),
            lastSequence: durableTerminal.last_sequence,
          },
          source: runStateSource(located.paths),
        };
      }
      if (run === undefined) {
        // The guard above makes this unreachable, but keep the fallback branch
        // explicitly narrowed so canonical-only terminal rows never require a
        // fabricated legacy agent_runs record.
        throw new AgenCDaemonRunInspectionError(
          "RUN_NOT_TERMINAL",
          `run.result: run ${runId} has no legacy terminal projection`,
        );
      }
      return {
        runId,
        status: run.status,
        terminal: true,
        terminalAt: run.last_active_at,
        outcome: terminalOutcome(run.status),
        durableRun: durableRunFromRow(run),
        output: {
          available: false,
          reason: "terminal_output_not_persisted_in_existing_state",
        },
        source: runStateSource(located.paths),
      };
    });
  }

  evidence(params: RunEvidenceParams): RunEvidenceResult {
    const runId = normalizeRunId(params.runId, "run.evidence");
    const afterSequence = normalizeAfterSequence(params.afterSequence);
    const limit = normalizeReplayLimit(params.limit);
    const located = this.#locate(runId);
    refreshRunJournalProjection(located.paths, runId);
    return withReadonlyStateDatabase(located.paths, (db) => {
      // A single read transaction gives the status summary and journal page a
      // coherent SQLite snapshot without taking a write reservation.
      return db.transaction(() => {
        const status = buildRunStatus(db, located, runId);
        const replay = buildRunReplay(db, located, runId, afterSequence, limit);
        const eventHashes = replay.events.map((event) => ({
          sequence: event.sequence,
          eventId: event.eventId,
          sha256: sha256(event),
        }));
        const runStateSha256 = sha256({
          durableRun: status.durableRun ?? null,
          status: status.status,
          terminal: status.terminal,
        });
        const admissionSummarySha256 = sha256(status.admission);
        const gapSha256 = sha256(replay.gap);
        const canonicalJournal =
          replay.source.available && replay.source.kind === "run_journal";
        const completeness: RunEvidenceResult["source"]["completeness"] =
          !replay.source.available
            ? "admission_source_unavailable"
            : replay.gap !== null
              ? "journal_gap"
            : afterSequence > 0 || replay.hasMore
              ? "partial"
              : "complete";
        const bundleDocument = {
          runId,
          source: canonicalJournal
            ? "canonical_run_journal"
            : "existing_m3_admission_state",
          completeness,
          afterSequence,
          nextAfterSequence: replay.nextAfterSequence,
          runStateSha256,
          admissionSummarySha256,
          gap: replay.gap,
          gapSha256,
          eventHashes,
        } as const;
        const result: RunEvidenceResult = {
          runId,
          source: {
            kind: canonicalJournal
              ? "canonical_run_journal"
              : "existing_m3_admission_state",
            projectDir: located.paths.projectDir,
            admissionJournal: status.admission.sources.journal,
            workflowEvidenceIncluded: canonicalJournal,
            completeness,
          },
          cursor: {
            afterSequence,
            nextAfterSequence: replay.nextAfterSequence,
            limit,
          },
          hasMore: replay.hasMore,
          gap: replay.gap,
          events: replay.events,
          hashes: {
            algorithm: "sha256",
            runStateSha256,
            admissionSummarySha256,
            gapSha256,
            eventHashes,
            bundleSha256: sha256(bundleDocument),
          },
        };
        return result;
      })();
    });
  }

  #locate(runId: string): LocatedRun {
    const matches: LocatedRun[] = [];
    const seen = new Set<string>();
    for (const paths of this.#stateDatabasePaths()) {
      if (seen.has(paths.stateDbPath)) continue;
      seen.add(paths.stateDbPath);
      if (!existsSync(paths.stateDbPath)) continue;
      const match = withReadonlyStateDatabase(paths, (db) => {
        const run = readAgentRun(db, runId);
        return run !== undefined ||
          hasAdmissionState(db, runId) ||
          hasCanonicalRunState(db, runId)
          ? { paths, ...(run !== undefined ? { run } : {}) }
          : undefined;
      });
      if (match !== undefined) matches.push(match);
    }
    if (matches.length === 0) {
      throw new AgenCDaemonRunInspectionError(
        "RUN_NOT_FOUND",
        `no durable run or admission state found for id: ${runId}`,
      );
    }
    if (matches.length > 1) {
      throw new AgenCDaemonRunInspectionError(
        "RUN_ID_AMBIGUOUS",
        `run id ${runId} exists in multiple project state databases`,
      );
    }
    return matches[0]!;
  }
}

function hasCanonicalRunState(
  db: BetterSqlite3.Database,
  runId: string,
): boolean {
  for (const [table, column] of [
    ["run_lifecycle_epochs", "run_id"],
    ["run_terminal_results", "run_id"],
    ["run_effects", "run_id"],
    ["run_journal_bindings", "run_id"],
  ] as const) {
    if (!tableExists(db, table)) continue;
    const row = db
      .prepare<[string], { readonly present: number }>(
        `SELECT 1 AS present FROM ${table} WHERE ${column} = ? LIMIT 1`,
      )
      .get(runId);
    if (row !== undefined) return true;
  }
  return false;
}

function buildRunStatus(
  db: BetterSqlite3.Database,
  located: LocatedRun,
  runId: string,
): RunStatusResult {
  const admission = admissionSummary(db, runId);
  const run = readAgentRun(db, runId) ?? located.run;
  const currentLifecycleEpoch = readCurrentLifecycleEpoch(db, runId);
  const durableTerminal = readCurrentTerminalResult(db, runId);
  const reopenedWithoutTerminal =
    currentLifecycleEpoch !== undefined && durableTerminal === undefined;
  return {
    runId,
    status:
      durableTerminal?.status ??
      (reopenedWithoutTerminal && run !== undefined && isTerminalAgentRunStatus(run.status)
        ? "running"
        : run?.status ?? "admission_only"),
    terminal:
      durableTerminal !== undefined ||
      (currentLifecycleEpoch === undefined &&
        run !== undefined &&
        isTerminalAgentRunStatus(run.status) &&
        !admission.active),
    statusSource:
      durableTerminal !== undefined
        ? "run_terminal_result"
        : currentLifecycleEpoch !== undefined
          ? "run_lifecycle_epoch"
        : run === undefined
          ? "admission_state"
          : "agent_run",
    ...(run !== undefined ? { durableRun: durableRunFromRow(run) } : {}),
    admission,
    source: runStateSource(located.paths),
  };
}

function buildRunReplay(
  db: BetterSqlite3.Database,
  located: LocatedRun,
  runId: string,
  afterSequence: number,
  limit: number,
): RunReplayResult {
  const canonical = buildCanonicalRunReplay(
    db,
    located.paths,
    runId,
    afterSequence,
    limit,
  );
  if (canonical.source.available) return canonical;
  return buildLegacyAdmissionReplay(
    db,
    located,
    runId,
    afterSequence,
    limit,
  );
}

/** Pre-M4 compatibility reader. New writes are projected into the rollout. */
function buildLegacyAdmissionReplay(
  db: BetterSqlite3.Database,
  located: LocatedRun,
  runId: string,
  afterSequence: number,
  limit: number,
): RunReplayResult {
  if (!tableExists(db, "execution_admission_journal")) {
    return buildCanonicalRunReplay(
      db,
      located.paths,
      runId,
      afterSequence,
      limit,
    );
  }
  const runIds = collectRunTreeIds(db, runId);
  const ids = placeholders(runIds.length);
  const bounds = db
    .prepare<unknown[], JournalBoundsRow>(
      `SELECT MIN(sequence) AS first_sequence,
              MAX(sequence) AS last_sequence
       FROM execution_admission_journal
       WHERE run_id IN (${ids})`,
    )
    .get(...runIds) ?? { first_sequence: null, last_sequence: null };
  const lastAvailableSequence = bounds.last_sequence ?? 0;
  if (afterSequence > lastAvailableSequence) {
    return {
      runId,
      afterSequence,
      limit,
      events: [],
      hasMore: false,
      nextAfterSequence: afterSequence,
      ...(bounds.first_sequence !== null
        ? { firstAvailableSequence: bounds.first_sequence }
        : {}),
      lastAvailableSequence,
      gap: {
        kind: "cursor_ahead",
        runId,
        afterSequence,
        lastAvailableSequence,
        reason: "cursor_ahead",
      },
      source: {
        kind: "execution_admission_journal",
        available: true,
        sequenceScope: "project_state_database",
        projectDir: located.paths.projectDir,
      },
    };
  }
  const rows = db
    .prepare<unknown[], AdmissionJournalRow>(
      `SELECT sequence, event_id, timestamp, run_id, step_id, kind, event,
              reason, reservation_id, model, provider, reserved_tokens,
              reserved_cost_nanos, actual_tokens, actual_cost_nanos,
              details_json
       FROM execution_admission_journal
       WHERE run_id IN (${ids}) AND sequence > ?
       ORDER BY sequence ASC
       LIMIT ?`,
    )
    .all(...runIds, afterSequence, limit + 1);
  const events = rows.slice(0, limit).map(legacyJournalEventFromRow);
  return {
    runId,
    afterSequence,
    limit,
    events,
    hasMore: rows.length > limit,
    nextAfterSequence: events.at(-1)?.sequence ?? afterSequence,
    ...(bounds.first_sequence !== null
      ? { firstAvailableSequence: bounds.first_sequence }
      : {}),
    ...(bounds.last_sequence !== null
      ? { lastAvailableSequence: bounds.last_sequence }
      : {}),
    gap: null,
    source: {
      kind: "execution_admission_journal",
      available: true,
      sequenceScope: "project_state_database",
      projectDir: located.paths.projectDir,
    },
  };
}

function admissionSummary(
  db: BetterSqlite3.Database,
  runId: string,
): RunStatusResult["admission"] {
  const runIds = collectRunTreeIds(db, runId);
  const runIdPlaceholders = placeholders(runIds.length);
  const jobsAvailable =
    tableExists(db, "agent_jobs") &&
    columnExists(db, "agent_jobs", "admission_run_id");
  const reservationsAvailable = tableExists(
    db,
    "execution_admission_reservations",
  );
  const allocationsAvailable = tableExists(
    db,
    "execution_admission_allocations",
  );
  const journalAvailable = tableExists(db, "execution_admission_journal");

  const stepRows = jobsAvailable
    ? db
        .prepare<unknown[], CountByStatusRow>(
          `SELECT status, COUNT(*) AS count
           FROM agent_jobs
           WHERE admission_run_id IN (${runIdPlaceholders})
           GROUP BY status
           ORDER BY status ASC`,
        )
        .all(...runIds)
    : [];
  const stepAggregate = jobsAvailable
    ? (db
        .prepare<unknown[], AdmissionStepAggregateRow>(
          `SELECT COUNT(*) AS count, MAX(updated_at) AS updated_at
           FROM agent_jobs
           WHERE admission_run_id IN (${runIdPlaceholders})`,
        )
        .get(...runIds) ?? { count: 0, updated_at: null })
    : { count: 0, updated_at: null };
  const reservationRows = reservationsAvailable
    ? db
        .prepare<unknown[], CountByStatusRow>(
          `SELECT status, COUNT(*) AS count
           FROM execution_admission_reservations
           WHERE run_id IN (${runIdPlaceholders})
           GROUP BY status
           ORDER BY status ASC`,
        )
        .all(...runIds)
    : [];
  const reservationAggregate = reservationsAvailable
    ? (db
        .prepare<unknown[], ReservationAggregateRow>(
          `SELECT COUNT(*) AS count,
                  COALESCE(SUM(CASE WHEN status IN ('reserved', 'dispatched')
                    THEN 1 ELSE 0 END), 0) AS open_count,
                  COALESCE(SUM(reserved_tokens), 0) AS reserved_tokens,
                  COALESCE(SUM(reserved_cost_nanos), 0) AS reserved_cost_nanos,
                  COALESCE(SUM(actual_tokens), 0) AS actual_tokens,
                  COALESCE(SUM(actual_cost_nanos), 0) AS actual_cost_nanos,
                  COALESCE(SUM(CASE WHEN actual_tokens IS NOT NULL
                    AND actual_cost_nanos IS NULL THEN 1 ELSE 0 END), 0)
                    AS unpriced_actual_count,
                  COALESCE(SUM(CASE
                    WHEN status IN ('reserved', 'dispatched')
                      THEN reserved_tokens ELSE 0 END), 0) AS held_tokens,
                  COALESCE(SUM(CASE
                    WHEN status = 'held_unknown' THEN reserved_tokens
                    WHEN status IN ('reconciled', 'provider_overrun')
                      THEN COALESCE(actual_tokens, reserved_tokens)
                    ELSE 0 END), 0) AS used_tokens,
                  COALESCE(SUM(CASE
                    WHEN status IN ('reserved', 'dispatched')
                      THEN reserved_cost_nanos ELSE 0 END), 0)
                    AS held_cost_nanos,
                  COALESCE(SUM(CASE
                    WHEN status = 'held_unknown' THEN reserved_cost_nanos
                    WHEN status IN ('reconciled', 'provider_overrun')
                      THEN COALESCE(actual_cost_nanos, reserved_cost_nanos)
                    ELSE 0 END), 0) AS used_cost_nanos
           FROM execution_admission_reservations
           WHERE run_id IN (${runIdPlaceholders})`,
        )
        .get(...runIds) ?? emptyReservationAggregate())
    : emptyReservationAggregate();
  const allocationAggregate = allocationsAvailable
    ? (db
        .prepare<unknown[], AllocationAggregateRow>(
          `SELECT COUNT(*) AS count,
                  COALESCE(SUM(blocked_by_provider_overrun), 0) AS blocked_count
           FROM execution_admission_allocations
           WHERE scope_key IN (${runIdPlaceholders})`,
        )
        .get(...runIds.map((id) => `run:${id}`)) ?? emptyAllocationAggregate())
    : emptyAllocationAggregate();
  const fallbackCount = journalAvailable
    ? (db
        .prepare<unknown[], { readonly count: number }>(
          `SELECT COUNT(*) AS count
           FROM execution_admission_journal
           WHERE run_id IN (${runIdPlaceholders}) AND event = 'fallback'`,
        )
        .get(...runIds)?.count ?? 0)
    : 0;
  const stepStatusCounts = countsByStatus(stepRows);
  const reservationStatusCounts = countsByStatus(reservationRows);
  return {
    present:
      stepAggregate.count > 0 ||
      reservationAggregate.count > 0 ||
      allocationAggregate.count > 0 ||
      (journalAvailable && journalHasRun(db, runIds)),
    currentStatus: currentAdmissionStatus(stepStatusCounts),
    active:
      (stepStatusCounts.queued ?? 0) > 0 ||
      (stepStatusCounts.running ?? 0) > 0 ||
      (stepStatusCounts.approval_required ?? 0) > 0,
    stepCount: stepAggregate.count,
    stepStatusCounts,
    reservationCount: reservationAggregate.count,
    reservationStatusCounts,
    openReservationCount: reservationAggregate.open_count,
    reservedTokens: reservationAggregate.reserved_tokens,
    reservedCostUsd: nanosToUsd(reservationAggregate.reserved_cost_nanos),
    actualTokens: reservationAggregate.actual_tokens,
    actualCostUsd: nanosToUsd(reservationAggregate.actual_cost_nanos),
    unpricedActualReservationCount: reservationAggregate.unpriced_actual_count,
    allocationCount: allocationAggregate.count,
    usedTokens: reservationAggregate.used_tokens,
    heldTokens: reservationAggregate.held_tokens,
    usedCostUsd: nanosToUsd(reservationAggregate.used_cost_nanos),
    heldCostUsd: nanosToUsd(reservationAggregate.held_cost_nanos),
    providerOverrunBlockedAllocationCount: allocationAggregate.blocked_count,
    fallbackCount,
    sources: {
      jobs: jobsAvailable,
      reservations: reservationsAvailable,
      allocations: allocationsAvailable,
      journal: journalAvailable,
    },
    ...(stepAggregate.updated_at !== null
      ? { updatedAt: stepAggregate.updated_at }
      : {}),
  };
}

function readAgentRun(
  db: BetterSqlite3.Database,
  runId: string,
): AgentRunRow | undefined {
  if (!tableExists(db, "agent_runs")) return undefined;
  return db
    .prepare<[string], AgentRunRow>(
      `SELECT id, objective, status, started_at, last_active_at,
              current_session_id, created_by_client, last_snapshot_at,
              metadata_json
       FROM agent_runs
       WHERE id = ?
       LIMIT 1`,
    )
    .get(runId);
}

function readCurrentTerminalResult(
  db: BetterSqlite3.Database,
  runId: string,
): RunTerminalRow | undefined {
  if (
    !tableExists(db, "run_lifecycle_epochs") ||
    !tableExists(db, "run_terminal_results")
  ) {
    return undefined;
  }
  return db
    .prepare<[string], RunTerminalRow>(
      `SELECT terminal.run_id, terminal.epoch, terminal.status,
              terminal.exit_code, terminal.stop_reason,
              terminal.final_message, terminal.usage_json,
              terminal.last_sequence, terminal.finished_at,
              terminal.event_id
       FROM run_terminal_results AS terminal
       JOIN run_lifecycle_epochs AS lifecycle
         ON lifecycle.run_id = terminal.run_id
        AND lifecycle.epoch = terminal.epoch
       WHERE terminal.run_id = ?
         AND lifecycle.epoch = (
           SELECT MAX(current.epoch)
           FROM run_lifecycle_epochs AS current
           WHERE current.run_id = terminal.run_id
         )
       LIMIT 1`,
    )
    .get(runId);
}

function readCurrentLifecycleEpoch(
  db: BetterSqlite3.Database,
  runId: string,
): number | undefined {
  if (!tableExists(db, "run_lifecycle_epochs")) return undefined;
  return db
    .prepare<[string], { readonly epoch: number }>(
      `SELECT epoch
       FROM run_lifecycle_epochs
       WHERE run_id = ?
       ORDER BY epoch DESC
       LIMIT 1`,
    )
    .get(runId)?.epoch;
}

function parseRunUsage(
  json: string | null,
): Extract<RunResultResult["output"], { readonly available: true }>["usage"] {
  if (json === null) return null;
  const value = JSON.parse(json) as {
    readonly inputTokens?: unknown;
    readonly outputTokens?: unknown;
    readonly totalTokens?: unknown;
    readonly costUsd?: unknown;
  };
  if (
    typeof value.inputTokens !== "number" ||
    typeof value.outputTokens !== "number" ||
    typeof value.totalTokens !== "number" ||
    typeof value.costUsd !== "number" ||
    !Number.isFinite(value.inputTokens) ||
    !Number.isFinite(value.outputTokens) ||
    !Number.isFinite(value.totalTokens) ||
    !Number.isFinite(value.costUsd)
  ) {
    throw new Error("durable run terminal usage is malformed");
  }
  return {
    inputTokens: value.inputTokens,
    outputTokens: value.outputTokens,
    totalTokens: value.totalTokens,
    costUsd: value.costUsd,
  };
}

function hasAdmissionState(db: BetterSqlite3.Database, runId: string): boolean {
  if (
    tableExists(db, "agent_jobs") &&
    columnExists(db, "agent_jobs", "admission_run_id")
  ) {
    const found = columnExists(
      db,
      "agent_jobs",
      "admission_parent_run_id",
    )
      ? db
          .prepare<[string, string], { readonly found: number }>(
            `SELECT 1 AS found FROM agent_jobs
             WHERE admission_run_id = ? OR admission_parent_run_id = ?
             LIMIT 1`,
          )
          .get(runId, runId)
      : db
          .prepare<[string], { readonly found: number }>(
            `SELECT 1 AS found FROM agent_jobs
             WHERE admission_run_id = ?
             LIMIT 1`,
          )
          .get(runId);
    if (found !== undefined) return true;
  }
  for (const [table, column] of [
    ["execution_admission_reservations", "run_id"],
    ["execution_admission_allocations", "owner_run_id"],
    ["execution_admission_journal", "run_id"],
  ] as const) {
    if (
      tableExists(db, table) &&
      db
        .prepare<[string], { readonly found: number }>(
          `SELECT 1 AS found FROM ${table} WHERE ${column} = ? LIMIT 1`,
        )
        .get(runId) !== undefined
    ) {
      return true;
    }
  }
  return false;
}

function journalHasRun(
  db: BetterSqlite3.Database,
  runIds: readonly string[],
): boolean {
  return (
    db
      .prepare<unknown[], { readonly found: number }>(
        `SELECT 1 AS found FROM execution_admission_journal
         WHERE run_id IN (${placeholders(runIds.length)}) LIMIT 1`,
      )
      .get(...runIds) !== undefined
  );
}

/**
 * Resolve the durable run subtree without assuming child work reuses the root
 * id. Both spawn provenance and admission parent edges participate so status,
 * replay, and evidence for the root cannot omit descendant decisions.
 */
function collectRunTreeIds(
  db: BetterSqlite3.Database,
  rootRunId: string,
): readonly string[] {
  const recursiveBranches: string[] = [];
  if (tableExists(db, "thread_spawn_edges")) {
    recursiveBranches.push(
      `SELECT edge.child_thread_id
       FROM thread_spawn_edges AS edge
       JOIN run_tree AS parent ON edge.parent_thread_id = parent.run_id`,
    );
  }
  if (
    tableExists(db, "agent_jobs") &&
    columnExists(db, "agent_jobs", "admission_parent_run_id")
  ) {
    recursiveBranches.push(
      `SELECT job.admission_run_id
       FROM agent_jobs AS job
       JOIN run_tree AS parent
         ON job.admission_parent_run_id = parent.run_id
       WHERE job.admission_run_id IS NOT NULL`,
    );
  }
  if (recursiveBranches.length === 0) return [rootRunId];
  const rows = db
    .prepare<[string, number], { readonly run_id: string }>(
      `WITH RECURSIVE run_tree(run_id) AS (
         VALUES (?)
         UNION
         ${recursiveBranches.join("\nUNION\n")}
       )
       SELECT run_id FROM run_tree ORDER BY run_id ASC LIMIT ?`,
    )
    .all(rootRunId, MAX_RUN_TREE_IDS + 1);
  if (rows.length > MAX_RUN_TREE_IDS) {
    throw new AgenCDaemonRunInspectionError(
      "INVALID_ARGUMENT",
      `run subtree exceeds inspection bound (${MAX_RUN_TREE_IDS}): ${rootRunId}`,
    );
  }
  return rows.map((row) => row.run_id);
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

function durableRunFromRow(
  row: AgentRunRow,
): NonNullable<RunStatusResult["durableRun"]> {
  return {
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
    ...(row.metadata_json !== null
      ? { metadata: parseJsonObject(row.metadata_json) }
      : {}),
  };
}

function legacyJournalEventFromRow(
  row: AdmissionJournalRow,
): RunReplayResult["events"][number] {
  return {
    sequence: row.sequence,
    eventId: row.event_id,
    timestamp: row.timestamp,
    runId: row.run_id,
    stepId: row.step_id,
    category: "admission",
    kind: row.kind,
    event: row.event,
    ...(row.reason !== null ? { reason: row.reason } : {}),
    ...(row.reservation_id !== null
      ? { reservationId: row.reservation_id }
      : {}),
    ...(row.model !== null ? { model: row.model } : {}),
    ...(row.provider !== null ? { provider: row.provider } : {}),
    ...(row.reserved_tokens !== null
      ? { reservedTokens: row.reserved_tokens }
      : {}),
    ...(row.reserved_cost_nanos !== null
      ? { reservedCostUsd: nanosToUsd(row.reserved_cost_nanos) }
      : {}),
    ...(row.actual_tokens !== null ? { actualTokens: row.actual_tokens } : {}),
    ...(row.actual_cost_nanos !== null
      ? { actualCostUsd: nanosToUsd(row.actual_cost_nanos) }
      : {}),
    ...(row.details_json !== "{}"
      ? { details: parseJsonObject(row.details_json) }
      : {}),
  };
}

function currentAdmissionStatus(
  counts: Readonly<Record<string, number>>,
): RunStatusResult["admission"]["currentStatus"] {
  for (const status of ["running", "queued", "approval_required"] as const) {
    if ((counts[status] ?? 0) > 0) return status;
  }
  for (const status of [
    "provider_overrun",
    "held_unknown",
    "cancelled",
    "denied",
  ] as const) {
    if ((counts[status] ?? 0) > 0) return status;
  }
  const populated = Object.entries(counts).filter(([, count]) => count > 0);
  if (populated.length === 0) return "none";
  if (populated.length === 1 && populated[0]![0] === "reconciled") {
    return "reconciled";
  }
  if (populated.length === 1 && populated[0]![0] === "voided") {
    return "voided";
  }
  return "terminal_mixed";
}

function countsByStatus(
  rows: readonly CountByStatusRow[],
): Readonly<Record<string, number>> {
  return Object.fromEntries(rows.map((row) => [row.status, row.count]));
}

function terminalOutcome(status: string): RunResultResult["outcome"] {
  if (status === "completed") return "completed";
  if (status === "cancelled") return "cancelled";
  if (status === "stopped") return "stopped";
  if (status === "unknown_outcome") return "unknown_outcome";
  return "failed";
}

function runStateSource(paths: StateDatabasePaths): RunStatusResult["source"] {
  return {
    kind: "existing_state_database",
    projectDir: paths.projectDir,
    readonly: true,
  };
}

function emptyReservationAggregate(): ReservationAggregateRow {
  return {
    count: 0,
    open_count: 0,
    reserved_tokens: 0,
    reserved_cost_nanos: 0,
    actual_tokens: 0,
    actual_cost_nanos: 0,
    unpriced_actual_count: 0,
    used_tokens: 0,
    held_tokens: 0,
    used_cost_nanos: 0,
    held_cost_nanos: 0,
  };
}

function emptyAllocationAggregate(): AllocationAggregateRow {
  return {
    count: 0,
    blocked_count: 0,
  };
}

function tableExists(db: BetterSqlite3.Database, name: string): boolean {
  return (
    db
      .prepare<[string], { readonly name: string }>(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name = ?`,
      )
      .get(name) !== undefined
  );
}

function columnExists(
  db: BetterSqlite3.Database,
  table: string,
  column: string,
): boolean {
  return db
    .prepare<[], { readonly name: string }>(`PRAGMA table_info(${table})`)
    .all()
    .some((row) => row.name === column);
}

/**
 * Bring the rebuildable SQLite projection up to the fsynced JSONL tail before
 * a cursor read. The scan is scoped to one run and bounded; the canonical file
 * is never rewritten here.
 */
function refreshRunJournalProjection(
  paths: StateDatabasePaths,
  runId: string,
): void {
  const driver = openStateDatabasePaths(paths);
  try {
    recoverCanonicalRunJournalForRun(driver, runId);
  } finally {
    driver.close();
  }
}

function withReadonlyStateDatabase<T>(
  paths: StateDatabasePaths,
  fn: (db: BetterSqlite3.Database) => T,
): T {
  const db = new Database(paths.stateDbPath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    db.pragma("query_only = ON");
    db.pragma("busy_timeout = 250");
    return fn(db);
  } finally {
    db.close();
  }
}

function normalizeRunId(value: string, method: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AgenCDaemonRunInspectionError(
      "INVALID_ARGUMENT",
      `${method} requires runId`,
    );
  }
  return value.trim();
}

function normalizeAfterSequence(value: number | undefined): number {
  const normalized = value ?? 0;
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw new AgenCDaemonRunInspectionError(
      "INVALID_ARGUMENT",
      "afterSequence must be a non-negative safe integer",
    );
  }
  return normalized;
}

function normalizeReplayLimit(value: number | undefined): number {
  const normalized = value ?? DEFAULT_RUN_REPLAY_LIMIT;
  if (
    !Number.isSafeInteger(normalized) ||
    normalized < 1 ||
    normalized > MAX_RUN_REPLAY_LIMIT
  ) {
    throw new AgenCDaemonRunInspectionError(
      "INVALID_ARGUMENT",
      `limit must be an integer from 1 through ${MAX_RUN_REPLAY_LIMIT}`,
    );
  }
  return normalized;
}

function parseJsonObject(value: string): JsonObject {
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return {};
    }
    return parsed as JsonObject;
  } catch {
    return {};
  }
}

function nanosToUsd(value: number): number {
  return value / NANO_USD_PER_USD;
}

function sha256(value: JsonValue | Readonly<Record<string, unknown>>): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}
