import { AgenCDaemonRunInspectionError } from "./run-inspection-error.js";
export { AgenCDaemonRunInspectionError, type AgenCDaemonRunInspectionErrorCode } from "./run-inspection-error.js";
import { ALL_PERMISSION_MODES, type InternalPermissionMode } from "../types/permissions.js";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { openSqliteDatabase } from "../state/sqlite-engine.js";
import type BetterSqlite3 from "better-sqlite3";

import type {
  JsonObject,
  JsonValue,
  RunEvidenceBundle,
  RunEvidenceParams,
  RunEvidenceResult,
  RunIdAmbiguousReason,
  RunPartialAnswer,
  RunReplayParams,
  RunReplayResult,
  RunResultParams,
  RunResultResult,
  RunStatusParams,
  RunStatusResult,
  RunWorkflowArtifactPointer,
  RunWorkflowStatus,
  RunWorkflowRuntimeFailure,
} from "./protocol/index.js";
import type {
  RunArtifactPointer,
  RunTerminalStatus,
} from "../contracts/run-contracts.js";
import { isTerminalAgentRunStatus } from "../state/run-cancellation.js";
import type {
  DurableRunEffect,
  DurableRunTerminalRecord,
  DurableRunSuspension,
} from "../state/run-durability.js";
import type { EffectOutcome } from "../contracts/run-contracts.js";
import type { ToolRecoveryCategory } from "../tools/types.js";
import {
  openStateDatabasePaths,
  type StateDatabasePaths,
} from "../state/sqlite-driver.js";
import { countRunJournalHomes, hasCanonicalRunState, splitRunStrays } from "../state/split-run.js";
import { recoverCanonicalRunJournalForRun } from "../state/startup-run-journal-recovery.js";
import { buildCanonicalRunReplay, journalSourceScope } from "./run-journal-replay.js";
import { readWorkflowStepEvidence } from "./workflow/steps.js";
import { projectWorkflowStatus } from "./workflow/status-projection.js";

export const DEFAULT_RUN_REPLAY_LIMIT = 100;
export const MAX_RUN_REPLAY_LIMIT = 200;

export interface AgenCDaemonRunInspectionOptions {
  /** Read only from an already-owned live workflow session; never open or resume it. */
  readonly providerWait?: (runId: string, stepId: string) => import("../recovery/provider-wait.js").ProviderWait | undefined;
  readonly effectivePermissionMode?: (runId: string) => InternalPermissionMode | undefined;
  readonly pendingApprovals?: (runId: string) => readonly import("./protocol/index.js").PendingToolApproval[];
  /** Live stop observation only. Never used as a durable result or evidence source. */
  readonly runtimeFailure?: (runId: string) => RunWorkflowRuntimeFailure | undefined;
  /**
   * Fresh discovery on every request keeps projects created after daemon
   * startup visible. Callers should return only state DBs owned by this
   * daemon home; the service opens them read-only and never runs migrations.
   */
  readonly stateDatabasePaths: () => readonly StateDatabasePaths[];
  /**
   * Daemon home holding per-run workflow evidence ledgers
   * (`<agencHome>/run-evidence/<runId>/`). Optional: when absent,
   * `run.evidence` simply omits the M5 `bundle` summary.
   */
  readonly agencHome?: string;
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
  readonly admission?: {
    readonly paths: StateDatabasePaths;
    readonly summary: RunStatusResult["admission"];
    readonly lastSequence: number;
  };
  /** Set when other project databases hold stray rows of this split run. */
  readonly partial?: RunPartialAnswer;
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
  readonly estimated_count: number;
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
 * Inspect persisted runs, repairing their rebuildable SQLite projections from
 * the canonical journal before serving status, output, replay or evidence.
 * Reads never resume execution or synthesize an unpersisted terminal payload.
 */
export class AgenCDaemonRunInspectionService {
  readonly #providerWait: AgenCDaemonRunInspectionOptions["providerWait"];
  readonly #effectivePermissionMode: AgenCDaemonRunInspectionOptions["effectivePermissionMode"];
  readonly #pendingApprovals: AgenCDaemonRunInspectionOptions["pendingApprovals"];
  readonly #runtimeFailure: AgenCDaemonRunInspectionOptions["runtimeFailure"];
  readonly #stateDatabasePaths: () => readonly StateDatabasePaths[];
  readonly #agencHome: string | undefined;

  constructor(options: AgenCDaemonRunInspectionOptions) {
    this.#providerWait = options.providerWait;
    this.#effectivePermissionMode = options.effectivePermissionMode;
    this.#pendingApprovals = options.pendingApprovals;
    this.#runtimeFailure = options.runtimeFailure;
    this.#stateDatabasePaths = options.stateDatabasePaths;
    this.#agencHome = options.agencHome;
  }

  status(params: RunStatusParams): RunStatusResult {
    const runId = normalizeRunId(params.runId, "run.status");
    const observedStop = this.#runtimeFailure?.(runId) !== undefined;
    const result = this.#inspect(
      runId,
      (paths) => this.#refreshStatusProjection(paths, runId, observedStop),
      (db, located) => buildRunStatus(db, located, runId),
    );
    const runtimeFailure = result.workflow !== undefined && !result.terminal
      ? this.#runtimeFailure?.(runId) : undefined;
    const mode = result.workflow !== undefined && !result.terminal && runtimeFailure === undefined
      ? this.#effectivePermissionMode?.(runId)
      : undefined;
    return {
      ...result,
      ...(runtimeFailure !== undefined ? { status: "stopped", statusSource: "runtime_observation" as const } : {}),
      ...(result.workflow !== undefined ? {
        workflow: {
          ...result.workflow,
          ...(runtimeFailure !== undefined ? { runtimeFailure } : {}),
          ...(mode !== undefined && (ALL_PERMISSION_MODES as readonly string[]).includes(mode)
            ? { effectivePermissionMode: mode } : {}),
          steps: result.workflow.steps.map((step) => {
            const providerWait = !result.terminal && runtimeFailure === undefined && step.status === "running"
              ? this.#providerWait?.(runId, step.stepId)
              : undefined;
            return { ...step, ...(providerWait !== undefined ? { providerWait: { ...providerWait } } : {}) };
          }),
        },
      } : {}),
      ...(this.#pendingApprovals !== undefined
        ? { pendingRequests: result.terminal || runtimeFailure !== undefined ? [] : this.#pendingApprovals(runId) }
        : {}),
    };
  }

  replay(params: RunReplayParams): RunReplayResult {
    const runId = normalizeRunId(params.runId, "run.replay");
    const afterSequence = normalizeAfterSequence(params.afterSequence);
    const limit = normalizeReplayLimit(params.limit);
    return this.#inspect(runId, (paths) => refreshRunJournalProjection(paths, runId), (db, located) => {
      const page = buildRunReplay(db, located, runId, afterSequence, limit);
      return located.partial === undefined
        ? page
        : { ...page, source: { ...page.source, partial: located.partial } };
    });
  }

  result(params: RunResultParams): RunResultResult {
    const runId = normalizeRunId(params.runId, "run.result");
    return this.#inspect(runId, (paths) => refreshRunJournalProjection(paths, runId), (db, located) => {
      const run = readAgentRun(db, runId);
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
          source: runStateSource(located),
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
        source: runStateSource(located),
      };
    });
  }

  evidence(params: RunEvidenceParams): RunEvidenceResult {
    const runId = normalizeRunId(params.runId, "run.evidence");
    const afterSequence = normalizeAfterSequence(params.afterSequence);
    const limit = normalizeReplayLimit(params.limit);
    // The status summary and the journal page come from the snapshot the
    // proof was made on, without taking a write reservation.
    return this.#inspect(runId, (paths) => refreshRunJournalProjection(paths, runId), (db, located) => {
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
          : afterSequence > 0 || replay.hasMore || located.admission !== undefined ||
              located.partial !== undefined
            ? "partial"
            : "complete";
      const bundleDocument = {
        runId,
        source: canonicalJournal
          ? "canonical_run_journal"
          : "existing_m3_admission_state",
        completeness,
        ...(located.partial !== undefined ? { partial: located.partial } : {}),
        afterSequence,
        nextAfterSequence: replay.nextAfterSequence,
        runStateSha256,
        admissionSummarySha256,
        gap: replay.gap,
        gapSha256,
        eventHashes,
        ...(located.admission !== undefined
          ? { admissionSource: runStateSource(located) }
          : {}),
      } as const;
      const bundle = workflowEvidenceBundle(this.#agencHome, db, runId);
      const result: RunEvidenceResult = {
        runId,
        source: {
          kind: canonicalJournal
            ? "canonical_run_journal"
            : "existing_m3_admission_state",
          projectDir: located.paths.projectDir,
          ...(located.admission !== undefined
            ? {
                admissionProjectDir: located.admission.paths.projectDir,
                admissionLastSequence: located.admission.lastSequence,
              }
            : {}),
          admissionJournal: status.admission.sources.journal,
          workflowEvidenceIncluded: canonicalJournal,
          completeness,
          ...(located.partial !== undefined ? { partial: located.partial } : {}),
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
        ...(bundle !== undefined ? { bundle } : {}),
      };
      return result;
    });
  }

  #refreshStatusProjection(paths: StateDatabasePaths, runId: string, observedStop: boolean): void {
    try { refreshRunJournalProjection(paths, runId); }
    catch (error) {
      // A known storage failure may prevent rebuilding the durable projection.
      // Serve its last readable state plus the explicit live stop observation.
      if (!observedStop) throw error;
    }
  }

  /**
   * Locate the run, bring its projection up to the JSONL tail, then prove its
   * admission authority and read the answer in one read transaction of each
   * database they read: the answer is read from the snapshot the proof was
   * made on, so nothing written after the proof reaches it unproven.
   */
  #inspect<T>(
    runId: string,
    refresh: (paths: StateDatabasePaths) => void,
    read: (db: BetterSqlite3.Database, located: LocatedRun) => T,
  ): T {
    const layout = this.#locate(runId);
    refresh(layout.located.paths);
    return withRunSnapshot((snapshot) => {
      const located = proveRunAuthority(snapshot, layout, runId);
      return snapshot.read(located.paths, (db) => read(db, located));
    });
  }

  /**
   * Which project databases hold rows of the run, from one short read of
   * each. Nothing here is proven yet: {@link proveRunAuthority} proves the
   * run's admission authority in the snapshot the answer is read from.
   */
  #locate(runId: string): RunLayout {
    const matches: RunMatch[] = [];
    const discovered: StateDatabasePaths[] = [];
    const seen = new Set<string>();
    for (const paths of this.#stateDatabasePaths()) {
      if (seen.has(paths.stateDbPath)) continue;
      seen.add(paths.stateDbPath);
      if (!existsSync(paths.stateDbPath)) continue;
      discovered.push(paths);
      const match = withReadonlyStateDatabase(paths, (db) => {
        const run = readAgentRun(db, runId);
        const canonical = hasCanonicalRunState(db, runId);
        const hasAdmission = hasAdmissionState(db, runId);
        return run !== undefined || hasAdmission || canonical ? { paths, canonical, hasAdmission } : undefined;
      });
      if (match !== undefined) matches.push(match);
    }
    if (matches.length === 0) {
      throw new AgenCDaemonRunInspectionError(
        "RUN_NOT_FOUND",
        `no durable run or admission state found for id: ${runId}`,
      );
    }
    // A resume that found the run's project again from its folder, and got
    // another project, wrote rows of the run into that project's database
    // too. When all of them are bound to the run's rollout, read the project
    // that holds the rollout, leave the strays out and mark the answer partial.
    const strays = readSplitRunStrays(matches.filter((match) => match.canonical), runId);
    const isStray = (paths: StateDatabasePaths): boolean =>
      strays?.some((stray) => stray.stateDbPath === paths.stateDbPath) === true;
    const kept = matches.filter((match) => !isStray(match.paths));
    const canonicalMatches = kept.filter((match) => match.canonical);
    if (canonicalMatches.length === 0 && kept.length === 1) {
      return { located: kept[0]!, canonical: false, kept, discovered, strays: [] };
    }
    if (canonicalMatches.length !== 1) {
      const homes = journalHomes(canonicalMatches, runId);
      throw ambiguousRunOwner(runId, homes === undefined ? undefined : homes > 1 ? "duplicate_run_id" : "project_split");
    }
    const canonical = canonicalMatches[0]!;
    return {
      located: strays === undefined ? canonical : {
        ...canonical,
        partial: { reason: "split_run", omittedProjectDirs: strays.map((stray) => stray.projectDir).sort() },
      },
      canonical: true,
      kept,
      discovered,
      strays: strays ?? [],
    };
  }
}

interface RunMatch extends LocatedRun {
  readonly canonical: boolean;
  readonly hasAdmission: boolean;
}

/** Where a run's rows are, found before its authority is proven. */
interface RunLayout {
  /**
   * The database the answer is read from: the one with the run's canonical
   * journal, or the run's only database when none has one.
   */
  readonly located: LocatedRun;
  /** Whether {@link located} holds the run's canonical journal. */
  readonly canonical: boolean;
  /** The databases with rows of the run, the split run's strays left out. */
  readonly kept: readonly RunMatch[];
  /** Every project database found, for a declared admission owner. */
  readonly discovered: readonly StateDatabasePaths[];
  /** A split run's strays: their rows are left out, their journals still prove the run's admission. */
  readonly strays: readonly StateDatabasePaths[];
}

/**
 * Read-only connections, one per database, each in one read transaction from
 * its first read until {@link withRunSnapshot} ends, so every read of one
 * database sees the same snapshot. It lasts one call (the proof and the
 * answer, nothing else) and holds what any reader holds: in WAL mode, which
 * state databases use, writers go on, while a FULL or TRUNCATE checkpoint
 * waits for it up to its busy timeout; a database not in WAL mode would hold
 * other connections' commits until it ends.
 */
class RunSnapshot {
  readonly #databases = new Map<string, BetterSqlite3.Database>();

  read<T>(paths: StateDatabasePaths, fn: (db: BetterSqlite3.Database) => T): T {
    let db = this.#databases.get(paths.stateDbPath);
    if (db === undefined) {
      const opened = openReadonlyStateDatabase(paths);
      try {
        opened.exec("BEGIN");
      } catch (error) {
        opened.close();
        throw error;
      }
      this.#databases.set(paths.stateDbPath, opened);
      db = opened;
    }
    return fn(db);
  }

  /** End every read transaction and close every connection; returns the first failure to close one. */
  close(): unknown {
    let failure: unknown;
    for (const db of this.#databases.values()) {
      try {
        if (db.inTransaction) db.exec("ROLLBACK");
      } catch {
        // Closing the connection ends the read transaction anyway.
      }
      try {
        db.close();
      } catch (error) {
        failure ??= error;
      }
    }
    this.#databases.clear();
    return failure;
  }
}

/** A failure to close is thrown only when the read itself succeeded: it never replaces the read's own error. */
function withRunSnapshot<T>(fn: (snapshot: RunSnapshot) => T): T {
  const snapshot = new RunSnapshot();
  let result: T;
  try {
    result = fn(snapshot);
  } catch (error) {
    snapshot.close();
    throw error;
  }
  const failure = snapshot.close();
  if (failure !== undefined) throw failure;
  return result;
}

/**
 * Prove the run's admission authority in the snapshot: its admission
 * records in its bound rollout, read from the database the answer is read
 * from, and the journal rows and admission owner that prove them. Refuses
 * with RUN_ID_AMBIGUOUS when they are not proven.
 */
function proveRunAuthority(snapshot: RunSnapshot, layout: RunLayout, runId: string): LocatedRun {
  const { located, kept, discovered, strays } = layout;
  const authority = snapshot.read(located.paths, (db) => readRunAdmissionAuthority(db, runId));
  if (!layout.canonical || (kept.length === 1 && authority.owner === undefined)) {
    // One database holds the run: its own admission was journaled there,
    // or for a split run where each period's admission went. The session's
    // own compaction attempts are admitted where the session is; a split
    // run's earlier attempts, where its strays are.
    proveOwnAdmissions(snapshot, [located.paths, ...strays], authority.events, runId);
    proveCompactionAdmissions(snapshot, [located.paths, ...strays], authority.compactions, runId);
    return located;
  }
  const isStray = (paths: StateDatabasePaths): boolean =>
    strays.some((stray) => stray.stateDbPath === paths.stateDbPath);
  const admissionMatches = kept.filter((match) => match.hasAdmission);
  // Found with a short read of each database; the owner is proven again in
  // its snapshot below.
  const declaredOwners = authority.owner === undefined ? [] : discovered.filter((paths) => !isStray(paths) && (
    paths.projectDir === authority.owner?.workspaceId || withReadonlyStateDatabase(paths, (db) =>
      hasDeclaredAdmissionWorkspace(db, authority.owner!, runId),
    )),
  );
  if (declaredOwners.length > 1) throw ambiguousRunOwner(runId, "admission_owner_unproved");
  const declaredOwnerPaths = declaredOwners[0];
  const owner: { readonly paths: StateDatabasePaths } | undefined = authority.owner === undefined
    ? admissionMatches.length === 1 ? admissionMatches[0] : undefined
    : declaredOwnerPaths === undefined ? undefined : { paths: declaredOwnerPaths };
  // Rows of the run in another database, and no admission records anywhere
  // to name an owner: the records are split across databases.
  if (owner === undefined && authority.owner === undefined && admissionMatches.length === 0) {
    throw ambiguousRunOwner(runId, "project_split");
  }
  if (owner === undefined || !authority.identitiesValid) throw ambiguousRunOwner(runId, "admission_owner_unproved");
  if (kept.some((match) => match.paths.stateDbPath !== located.paths.stateDbPath && match.paths.stateDbPath !== owner.paths.stateDbPath)) {
    throw ambiguousRunOwner(runId, "project_split");
  }
  const admission = snapshot.read(owner.paths, (db) => {
    if (authority.owner !== undefined && owner.paths.projectDir !== authority.owner.workspaceId &&
        !hasDeclaredAdmissionWorkspace(db, authority.owner, runId)) {
      throw ambiguousRunOwner(runId, "admission_owner_unproved");
    }
    verifyRunAdmissionAuthority(db, authority, runId);
    const runIds = collectRunTreeIds(db, runId);
    const lastSequence = tableExists(db, "execution_admission_journal")
      ? db.prepare<unknown[], { last_sequence: number | null }>(
          `SELECT MAX(sequence) AS last_sequence FROM execution_admission_journal WHERE run_id IN (${placeholders(runIds.length)})`,
        ).get(...runIds)?.last_sequence ?? 0
      : 0;
    return { paths: owner.paths, summary: admissionSummary(db, runId), lastSequence };
  });
  proveCompactionAdmissions(snapshot, [owner.paths, ...strays], authority.compactions, runId);
  return owner.paths.stateDbPath === located.paths.stateDbPath ? located : { ...located, admission };
}

interface RunAdmissionAuthority {
  readonly identitiesValid: boolean;
  readonly owner?: { readonly workspaceId: string; readonly runId: string; readonly parentRunId?: string };
  /** The run's own admission events in its bound rollout. */
  readonly events: readonly JsonObject[];
  /**
   * Admission events of the session's own compaction attempts in its bound
   * rollout. They are never the run's own events: they prove no owner, and
   * each must be proven against an admission journal on its own.
   */
  readonly compactions: readonly JsonObject[];
}

/**
 * A compaction attempt is admitted under its own run id, `compact-<uuid>`,
 * as a child of the session's run, one step per summarizer call:
 * `compact:<attempt run id>:<call>` (services/compact/transaction.ts). Its
 * admission events are written into the session's rollout.
 */
const COMPACTION_ATTEMPT_RUN_ID = /^compact-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const COMPACTION_ATTEMPT_CALL = /^[1-9][0-9]{0,8}$/u;

function isCompactionAttemptEvent(event: JsonObject): boolean {
  const { runId, stepId } = event;
  if (typeof runId !== "string" || typeof stepId !== "string" || !COMPACTION_ATTEMPT_RUN_ID.test(runId)) return false;
  const prefix = `compact:${runId}:`;
  return stepId.startsWith(prefix) && COMPACTION_ATTEMPT_CALL.test(stepId.slice(prefix.length));
}

interface CompactionAdmissionJobRow {
  readonly admission_run_id: string | null;
  readonly admission_step_id: string | null;
  readonly admission_parent_run_id: string | null;
  readonly admission_session_id: string | null;
}

/**
 * Prove each compaction admission event of the session's rollout against an
 * admission journal: exactly one of the given databases holds its journal
 * row, the row is the event, and the row's admission job is that attempt's
 * step, a child of this run in this session. Anything else refuses.
 */
function proveCompactionAdmissions(
  snapshot: RunSnapshot,
  journals: readonly StateDatabasePaths[],
  events: readonly JsonObject[],
  runId: string,
): void {
  if (events.length === 0) return;
  const unique = journals.filter((paths, index) =>
    journals.findIndex((other) => other.stateDbPath === paths.stateDbPath) === index);
  const proven = new Map<string, number>();
  for (const paths of unique) {
    snapshot.read(paths, (db) => {
      if (!tableExists(db, "execution_admission_journal")) return;
      const jobsReadable = tableExists(db, "agent_jobs") &&
        ["admission_run_id", "admission_step_id", "admission_parent_run_id", "admission_session_id"]
          .every((column) => columnExists(db, "agent_jobs", column));
      const journalRow = db.prepare<[string], AdmissionJournalRow & { readonly job_id: string | null }>(
        "SELECT * FROM execution_admission_journal WHERE event_id = ?",
      );
      const jobRow = db.prepare<[string], CompactionAdmissionJobRow>(
        `SELECT admission_run_id, admission_step_id, admission_parent_run_id, admission_session_id
         FROM agent_jobs WHERE id = ?`,
      );
      for (const event of events) {
        const eventId = String(event.eventId);
        const row = journalRow.get(eventId);
        if (row === undefined) continue;
        if (row.run_id !== event.runId || row.step_id !== event.stepId) throw ambiguousRunOwner(runId, "admission_owner_unproved");
        const { category: ignoredCategory, ...admissionEvent } = legacyJournalEventFromRow(row);
        if (canonicalJson(admissionEvent) !== canonicalJson(event)) throw ambiguousRunOwner(runId, "admission_owner_unproved");
        const job = jobsReadable && row.job_id !== null ? jobRow.get(row.job_id) : undefined;
        if (job === undefined || job.admission_run_id !== row.run_id || job.admission_step_id !== row.step_id ||
            job.admission_parent_run_id !== runId || job.admission_session_id !== runId) {
          throw ambiguousRunOwner(runId, "admission_owner_unproved");
        }
        proven.set(eventId, (proven.get(eventId) ?? 0) + 1);
      }
    });
  }
  if (events.some((event) => proven.get(String(event.eventId)) !== 1)) throw ambiguousRunOwner(runId, "admission_owner_unproved");
}

/**
 * Prove each of the run's own admission events in its bound rollout against
 * an admission journal: exactly one of the given databases holds its journal
 * row, the row is the run's, and every copy of the event in the rollout is
 * that row. Anything else refuses. One event can be in more than one bound
 * rollout of the run (admission recovery accepts that); each copy must be
 * the row.
 */
function proveOwnAdmissions(
  snapshot: RunSnapshot,
  journals: readonly StateDatabasePaths[],
  events: readonly JsonObject[],
  runId: string,
): void {
  if (events.length === 0) return;
  const copies = new Map<string, JsonObject[]>();
  for (const event of events) {
    const eventId = String(event.eventId);
    const known = copies.get(eventId);
    if (known === undefined) copies.set(eventId, [event]);
    else known.push(event);
  }
  const unique = journals.filter((paths, index) =>
    journals.findIndex((other) => other.stateDbPath === paths.stateDbPath) === index);
  const holders = new Map<string, number>();
  for (const paths of unique) {
    snapshot.read(paths, (db) => {
      if (!tableExists(db, "execution_admission_journal")) return;
      const journalRow = db.prepare<[string], AdmissionJournalRow>(
        "SELECT * FROM execution_admission_journal WHERE event_id = ?",
      );
      for (const [eventId, eventCopies] of copies) {
        const row = journalRow.get(eventId);
        if (row === undefined) continue;
        if (row.run_id !== runId) throw ambiguousRunOwner(runId, "admission_owner_unproved");
        const { category: ignoredCategory, ...admissionEvent } = legacyJournalEventFromRow(row);
        const journaled = canonicalJson(admissionEvent);
        if (eventCopies.some((event) => canonicalJson(event) !== journaled)) throw ambiguousRunOwner(runId, "admission_owner_unproved");
        holders.set(eventId, (holders.get(eventId) ?? 0) + 1);
      }
    });
  }
  for (const eventId of copies.keys()) {
    if (holders.get(eventId) !== 1) throw ambiguousRunOwner(runId, "admission_owner_unproved");
  }
}

/**
 * The split run reader's strays. A database whose bindings cannot be read
 * makes it no split, so the run is refused as before instead of failing the
 * read with that error.
 */
function readSplitRunStrays(
  canonicalMatches: readonly { readonly paths: StateDatabasePaths }[],
  runId: string,
): readonly StateDatabasePaths[] | undefined {
  try {
    return splitRunStrays(canonicalMatches, runId);
  } catch {
    return undefined;
  }
}

/**
 * How many databases hold their own journal of the run, to tell two chats
 * with one id from a split; undefined when that cannot be read. The reason is
 * a best effort and the refusal is not.
 */
function journalHomes(canonicalMatches: readonly { readonly paths: StateDatabasePaths }[], runId: string): number | undefined {
  try {
    return countRunJournalHomes(canonicalMatches, runId);
  } catch {
    return undefined;
  }
}

/** The most admission records of a run's rollout that one read checks. */
const MAX_RUN_ADMISSION_RECORDS = 100_000;

const AMBIGUOUS_RUN_ID_REASONS: Readonly<Record<RunIdAmbiguousReason, string>> = {
  project_split: "its records are split across project databases",
  duplicate_run_id: "more than one project database holds a journal of this run id",
  admission_owner_unproved: "an admission owner or admission record of its journal is not proven",
  admission_record_limit: `its rollout holds more than ${MAX_RUN_ADMISSION_RECORDS} admission records`,
};

/** Without a reason when it could not be worked out: a client then words it as an older daemon's refusal. */
function ambiguousRunOwner(runId: string, reason: RunIdAmbiguousReason | undefined): AgenCDaemonRunInspectionError {
  return new AgenCDaemonRunInspectionError(
    "RUN_ID_AMBIGUOUS",
    `run id ${runId} has conflicting or unproved journal/admission owners${reason === undefined ? "" : `: ${AMBIGUOUS_RUN_ID_REASONS[reason]}`}`,
    reason,
  );
}

function isRunAuthorityObject(value: JsonValue | undefined): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * The run's admission records in the rollout items its replay reads
 * ({@link journalSourceScope}): the bound rollouts, or with no binding the
 * thread's own rollout. Only a bound rollout's session metadata can declare
 * an admission owner.
 */
function readRunAdmissionAuthority(db: BetterSqlite3.Database, runId: string): RunAdmissionAuthority {
  if (!tableExists(db, "thread_rollout_items")) {
    return { identitiesValid: false, events: [], compactions: [] };
  }
  const bindings = tableExists(db, "run_journal_bindings")
    ? db.prepare<[string], { child_run_id: string; session_id: string }>(
        "SELECT child_run_id, session_id FROM run_journal_bindings WHERE run_id = ? LIMIT 33",
      ).all(runId)
    : [];
  const identitiesValid = bindings.length > 0 && bindings.length <= 32 &&
    bindings.every((binding) => binding.child_run_id === runId && binding.session_id === runId);
  let owner: RunAdmissionAuthority["owner"];
  const scope = journalSourceScope(db, runId);
  const rows = db.prepare<unknown[], { item_type: string; payload_json: string }>(
    `SELECT item_type, payload_json FROM thread_rollout_items
     WHERE ${scope.predicate}
       AND (${scope.bound ? "item_type = 'session_meta' OR " : ""}
         (item_type = 'event_msg' AND json_extract(payload_json, '$.msg.type') = 'execution_admission'))
     ORDER BY source_path, line_number LIMIT ${MAX_RUN_ADMISSION_RECORDS + 1}`,
  ).all(...scope.params);
  if (rows.length > MAX_RUN_ADMISSION_RECORDS) throw ambiguousRunOwner(runId, "admission_record_limit");
  const events: JsonObject[] = [];
  const compactions: JsonObject[] = [];
  for (const row of rows) {
    const payload = parseJsonObject(row.payload_json);
    if (row.item_type === "session_meta") {
      if (payload.sessionId !== runId) throw ambiguousRunOwner(runId, "admission_owner_unproved");
      if (payload.admissionOwner === undefined) continue;
      const candidate = payload.admissionOwner;
      if (!isRunAuthorityObject(candidate) ||
          candidate.runId !== runId || typeof candidate.workspaceId !== "string" || candidate.workspaceId.length === 0 ||
          (candidate.parentRunId !== undefined && (typeof candidate.parentRunId !== "string" || candidate.parentRunId.length === 0 || candidate.parentRunId === runId))) {
        throw ambiguousRunOwner(runId, "admission_owner_unproved");
      }
      const current = { workspaceId: candidate.workspaceId, runId, ...(typeof candidate.parentRunId === "string" ? { parentRunId: candidate.parentRunId } : {}) };
      if (owner !== undefined && canonicalJson(owner) !== canonicalJson(current)) throw ambiguousRunOwner(runId, "admission_owner_unproved");
      owner = current;
    } else {
      const message = payload.msg;
      const event = isRunAuthorityObject(message) ? message.payload : undefined;
      if (!isRunAuthorityObject(event) ||
          typeof event.eventId !== "string" || event.eventId !== payload.eventId) throw ambiguousRunOwner(runId, "admission_owner_unproved");
      if (event.runId === runId) events.push(event);
      else if (isCompactionAttemptEvent(event)) compactions.push(event);
      else throw ambiguousRunOwner(runId, "admission_owner_unproved");
    }
  }
  return { identitiesValid, ...(owner !== undefined ? { owner } : {}), events, compactions };
}

function verifyRunAdmissionAuthority(db: BetterSqlite3.Database, authority: RunAdmissionAuthority, runId: string): void {
  if (authority.owner === undefined && authority.events.length === 0) throw ambiguousRunOwner(runId, "admission_owner_unproved");
  if (authority.events.length > 0 && !tableExists(db, "execution_admission_journal")) throw ambiguousRunOwner(runId, "admission_owner_unproved");
  for (const event of authority.events) {
    const row = db.prepare<[string], AdmissionJournalRow>(
      "SELECT * FROM execution_admission_journal WHERE event_id = ?",
    ).get(String(event.eventId));
    if (row === undefined || row.run_id !== runId) throw ambiguousRunOwner(runId, "admission_owner_unproved");
    const { category: ignoredCategory, ...admissionEvent } = legacyJournalEventFromRow(row);
    if (canonicalJson(admissionEvent) !== canonicalJson(event)) throw ambiguousRunOwner(runId, "admission_owner_unproved");
  }
  if (authority.owner?.parentRunId !== undefined && tableExists(db, "agent_jobs") && columnExists(db, "agent_jobs", "admission_parent_run_id")) {
    const parents = db.prepare<[string], { parent_run_id: string | null }>(
      "SELECT DISTINCT admission_parent_run_id AS parent_run_id FROM agent_jobs WHERE admission_run_id = ?",
    ).all(runId);
    if (parents.some((parent) => parent.parent_run_id !== authority.owner?.parentRunId)) throw ambiguousRunOwner(runId, "admission_owner_unproved");
  }
}

function hasDeclaredAdmissionWorkspace(
  db: BetterSqlite3.Database,
  owner: NonNullable<RunAdmissionAuthority["owner"]>,
  runId: string,
): boolean {
  if (!tableExists(db, "agent_jobs") || !columnExists(db, "agent_jobs", "admission_workspace_id")) return false;
  return db.prepare<[string, string, string], { present: number }>(
    `SELECT 1 AS present FROM agent_jobs
     WHERE admission_workspace_id = ? AND admission_run_id IN (?, ?) LIMIT 1`,
  ).get(owner.workspaceId, runId, owner.parentRunId ?? runId) !== undefined;
}

function buildRunStatus(
  db: BetterSqlite3.Database,
  located: LocatedRun,
  runId: string,
): RunStatusResult {
  const admission = located.admission?.summary ?? admissionSummary(db, runId);
  // The run row of the snapshot; the one found while locating the run was
  // read before it.
  const run = readAgentRun(db, runId);
  const currentLifecycleEpoch = readCurrentLifecycleEpoch(db, runId);
  const durableTerminal = readCurrentTerminalResult(db, runId);
  const workflow = workflowStatusProjection(db, runId, durableTerminal);
  const reopenedWithoutTerminal =
    currentLifecycleEpoch !== undefined && durableTerminal === undefined;
  const reviewNeeded = tableExists(db, "run_effects") && db.prepare(
    `SELECT 1 FROM run_effects WHERE session_id = ? AND review_status = 'pending'
       AND recovery_category IN ('side-effecting', 'interactive') LIMIT 1`,
  ).get(runId) !== undefined;
  const staleLegacyStatus = reopenedWithoutTerminal && run !== undefined && (
    isTerminalAgentRunStatus(run.status) ||
    (run.status === "suspended" && latestSuspensionResumed(db, runId, currentLifecycleEpoch))
  );
  return {
    runId,
    status:
      (reviewNeeded ? "review_needed" : durableTerminal?.status) ??
      (workflow?.control?.state === "paused" ? "paused" : staleLegacyStatus
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
    source: runStateSource(located),
    ...(workflow !== undefined ? { workflow } : {}),
  };
}

// ---------------------------------------------------------------------------
// M5 verified-change workflow projections (additive, read-only)
// ---------------------------------------------------------------------------

interface WorkflowEffectRow {
  readonly run_id: string;
  readonly step_id: string;
  readonly epoch: number;
  readonly child_run_id: string | null;
  readonly session_id: string;
  readonly call_id: string;
  readonly tool_name: string;
  readonly recovery_category: string;
  readonly idempotency_key: string | null;
  readonly intent_digest: string;
  readonly intent_event_id: string;
  readonly intent_sequence: number;
  readonly intent_at: string;
  readonly outcome: string | null;
  readonly result_sequence: number | null;
  readonly result_digest: string | null;
  readonly evidence_json: string | null;
  readonly unknown_reason: string | null;
  readonly completed_at: string | null;
}

/** Read the run's workflow effect rows into the shared durable-effect shape. */
function readWorkflowEffects(
  db: BetterSqlite3.Database,
  runId: string,
): DurableRunEffect[] {
  if (!tableExists(db, "run_effects")) return [];
  const rows = db
    .prepare<[string], WorkflowEffectRow>(
      `SELECT run_id, step_id, epoch, child_run_id, session_id, call_id,
              tool_name, recovery_category, idempotency_key, intent_digest,
              intent_event_id, intent_sequence, intent_at, outcome,
              result_sequence, result_digest, evidence_json, unknown_reason,
              completed_at
       FROM run_effects
       WHERE run_id = ? AND step_id LIKE 'workflow.%'
       ORDER BY intent_sequence ASC`,
    )
    .all(runId);
  return rows.map((row) => ({
    runId: row.run_id,
    stepId: row.step_id,
    epoch: row.epoch,
    ...(row.child_run_id !== null ? { childRunId: row.child_run_id } : {}),
    sessionId: row.session_id,
    callId: row.call_id,
    toolName: row.tool_name,
    recoveryCategory: row.recovery_category as ToolRecoveryCategory,
    ...(row.idempotency_key !== null
      ? { idempotencyKey: row.idempotency_key }
      : {}),
    intentDigest: row.intent_digest,
    intentEventId: row.intent_event_id,
    intentSequence: row.intent_sequence,
    intentAt: row.intent_at,
    // The inspection reader supports databases created before evidence-v2;
    // rows returned by this legacy projection therefore carry format v1.
    effectFormatVersion: 1,
    ...(row.outcome !== null ? { outcome: row.outcome as EffectOutcome } : {}),
    ...(row.result_sequence !== null
      ? { resultSequence: row.result_sequence }
      : {}),
    ...(row.result_digest !== null ? { resultDigest: row.result_digest } : {}),
    ...(row.evidence_json !== null
      ? { evidence: parseJsonUnknown(row.evidence_json) }
      : {}),
    ...(row.unknown_reason !== null
      ? { unknownReason: row.unknown_reason }
      : {}),
    ...(row.completed_at !== null ? { completedAt: row.completed_at } : {}),
    reviewStatus: "none" as const,
  }));
}

function durableTerminalRecordFromRow(
  row: RunTerminalRow,
): DurableRunTerminalRecord {
  return {
    runId: row.run_id,
    epoch: row.epoch,
    eventId: row.event_id,
    status: row.status as RunTerminalStatus,
    exitCode: row.exit_code,
    stopReason: row.stop_reason,
    finalMessage: row.final_message,
    usage: parseRunUsage(row.usage_json),
    lastSequence: row.last_sequence,
    finishedAt: row.finished_at,
  };
}

function workflowArtifactPointer(
  pointer: RunArtifactPointer,
): RunWorkflowArtifactPointer {
  return {
    step: {
      runId: pointer.step.runId,
      stepId: pointer.step.stepId,
      ...(pointer.step.parentRunId !== undefined
        ? { parentRunId: pointer.step.parentRunId }
        : {}),
    },
    role: pointer.role,
    digest: pointer.digest,
    bytes: pointer.bytes,
    storagePath: pointer.storagePath,
    recordedAt: pointer.recordedAt,
  };
}

/**
 * Additive M5 projection: the Phase 4 status projection applied read-only
 * to the run's durable `run_effects` rows. Present only for runs that
 * actually recorded workflow steps.
 */
function workflowStatusProjection(
  db: BetterSqlite3.Database,
  runId: string,
  terminal: RunTerminalRow | undefined,
): RunWorkflowStatus | undefined {
  const effects = readWorkflowEffects(db, runId);
  if (effects.length === 0) return undefined;
  const projected = projectWorkflowStatus({
    runId,
    effects,
    suspensions: tableExists(db, "run_suspensions") ? db.prepare<[string], DurableRunSuspension>(`
      SELECT run_id AS runId, epoch, suspension_event_id AS eventId,
        suspension_sequence AS suspensionSequence, reason, suspended_at AS suspendedAt,
        resume_event_id AS resumeEventId, resume_sequence AS resumeSequence,
        resume_reason AS resumeReason, resumed_at AS resumedAt
      FROM run_suspensions WHERE run_id = ? ORDER BY suspension_sequence ASC
    `).all(runId).map(row => Object.fromEntries(Object.entries(row).filter(([, value]) => value !== null)) as unknown as DurableRunSuspension) : [],
    ...(terminal !== undefined
      ? { terminal: durableTerminalRecordFromRow(terminal) }
      : {}),
  });
  return {
    control: projected.control,
    ...(projected.completedResult !== undefined ? { completedResult: projected.completedResult } : {}),
    ...(projected.continuationOf !== undefined ? { continuationOf: { ...projected.continuationOf,
      sourceUsage: projected.continuationOf.sourceUsage === null ? null : { ...projected.continuationOf.sourceUsage } } } : {}),
    steps: projected.steps.map((step) => ({
      stepId: step.stepId,
      stage: step.stage,
      status: step.status,
      attempts: step.attempts,
      ...(step.verdict !== undefined ? { verdict: step.verdict } : {}),
      ...(step.artifacts !== undefined && step.artifacts.length > 0
        ? { artifacts: step.artifacts.map(workflowArtifactPointer) }
        : {}),
    })),
    ...(projected.requestedPermissionMode !== undefined ? { requestedPermissionMode: projected.requestedPermissionMode } : {}),
    ...(projected.stopReason !== undefined
      ? { stopReason: projected.stopReason }
      : {}),
  };
}

const RUN_EVIDENCE_SEAL_FILE_PATTERN = /^sha256-[0-9a-f]{64}\.json$/u;

function sanitizeRunEvidenceIdentifier(value: string): string {
  return value.replace(/[^a-zA-Z0-9._:-]/g, "-");
}

/**
 * Additive M5 evidence-bundle summary: describes the run's evidence-ledger
 * directory (`<agencHome>/run-evidence/<runId>/`) when present. Artifact
 * pointers are re-read from the durable workflow effect evidence — the
 * exact pointers each producing step committed.
 */
function workflowEvidenceBundle(
  agencHome: string | undefined,
  db: BetterSqlite3.Database,
  runId: string,
): RunEvidenceBundle | undefined {
  if (agencHome === undefined) return undefined;
  const ledgerPath = join(
    agencHome,
    "run-evidence",
    sanitizeRunEvidenceIdentifier(runId),
  );
  if (!existsSync(ledgerPath)) return undefined;
  let sealed = false;
  try {
    for (const entry of readdirSync(ledgerPath)) {
      if (!entry.endsWith(".seals")) continue;
      const seals = readdirSync(join(ledgerPath, entry));
      if (seals.some((name) => RUN_EVIDENCE_SEAL_FILE_PATTERN.test(name))) {
        sealed = true;
        break;
      }
    }
  } catch {
    // An unreadable ledger dir reports as unsealed rather than failing the
    // whole evidence export.
  }
  let recordDigest: string | undefined;
  try {
    const record: unknown = JSON.parse(
      readFileSync(join(ledgerPath, "verified-change-record.json"), "utf8"),
    );
    if (
      typeof record === "object" &&
      record !== null &&
      typeof (record as { documentDigest?: unknown }).documentDigest ===
        "string"
    ) {
      recordDigest = (record as { documentDigest: string }).documentDigest;
    }
  } catch {
    // No persisted record yet (run still open or failed before finalize).
  }
  const artifacts: RunWorkflowArtifactPointer[] = [];
  const seen = new Set<string>();
  for (const effect of readWorkflowEffects(db, runId)) {
    const evidence = readWorkflowStepEvidence(effect);
    for (const pointer of evidence.artifacts ?? []) {
      const key = `${pointer.step.stepId}:${pointer.role}:${pointer.digest}`;
      if (seen.has(key)) continue;
      seen.add(key);
      artifacts.push(workflowArtifactPointer(pointer));
    }
  }
  return {
    ...(recordDigest !== undefined ? { recordDigest } : {}),
    sealed,
    ledgerPath,
    artifacts,
  };
}

function parseJsonUnknown(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
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
                  SUM(CASE WHEN resolution_reason = 'estimated_model_price' THEN 1 ELSE 0 END) AS estimated_count,
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
    ...(reservationAggregate.estimated_count > 0 ? { costEstimated: true } : {}),
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

/** A same-epoch resume supersedes the legacy rail's suspended snapshot. */
function latestSuspensionResumed(
  db: BetterSqlite3.Database,
  runId: string,
  epoch: number,
): boolean {
  if (!tableExists(db, "run_suspensions")) return false;
  const latest = db.prepare<[string, number], { readonly resume_event_id: string | null }>(`
    SELECT resume_event_id FROM run_suspensions
    WHERE run_id = ? AND epoch = ?
    ORDER BY suspension_sequence DESC LIMIT 1
  `).get(runId, epoch);
  return latest !== undefined && latest.resume_event_id !== null;
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
    readonly costKnown?: unknown;
    readonly costEstimated?: unknown;
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
    ...(typeof value.costKnown === "boolean" ? { costKnown: value.costKnown } : {}),
    ...(typeof value.costEstimated === "boolean"
      ? { costEstimated: value.costEstimated }
      : {}),
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

function runStateSource({ paths, admission, partial }: LocatedRun): RunStatusResult["source"] {
  return {
    kind: "existing_state_database",
    projectDir: paths.projectDir,
    ...(admission !== undefined
      ? { admissionProjectDir: admission.paths.projectDir, admissionLastSequence: admission.lastSequence }
      : {}),
    readonly: true,
    ...(partial !== undefined ? { partial } : {}),
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
    estimated_count: 0,
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
    // run.status/run.replay on a run this daemon is executing find the rollout
    // lease held by the live writer. That is not a recovery failure: serve
    // the projection as it stands and persist no deferral, since an active
    // run_recovery_deferred row would exclude the run from recovery at the
    // next daemon start ("pending operator recovery action").
    const recovered = recoverCanonicalRunJournalForRun(driver, runId, {
      strict: { liveSourceDeferral: "skip", projectionFailure: "throw" },
    });
    if (recovered.exclusion !== undefined && recovered.exclusion.reasonCode !== "source_not_quiescent") {
      throw new Error(`Cannot inspect run ${runId}: ${recovered.exclusion.safeDetail}`);
    }
  } catch (error) {
    // A detached failure can already be durable when a failed journal append
    // later drains during shutdown. Keep that honest terminal visible even if
    // its journal cannot be reconciled; never fall back to a nonterminal row.
    if (!withReadonlyStateDatabase(paths, db => readCurrentTerminalResult(db, runId) !== undefined)) throw error;
  } finally {
    driver.close();
  }
}

function withReadonlyStateDatabase<T>(
  paths: StateDatabasePaths,
  fn: (db: BetterSqlite3.Database) => T,
): T {
  const db = openReadonlyStateDatabase(paths);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function openReadonlyStateDatabase(paths: StateDatabasePaths): BetterSqlite3.Database {
  const db = openSqliteDatabase(paths.stateDbPath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    db.pragma("query_only = ON");
    db.pragma("busy_timeout = 250");
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
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
