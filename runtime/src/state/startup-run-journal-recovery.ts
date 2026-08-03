import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";

import type {
  EffectBoundary,
  EffectNoEffectProof,
  EffectReviewResolution,
  RunTerminalResult,
  RunTerminalStatus,
  RunUsageTotals,
} from "../contracts/run-contracts.js";
import type { JsonObject } from "../app-server/protocol/index.js";
import type { ToolRecoveryCategory } from "../tools/types.js";
import { asRecord } from "../utils/record.js";
import { updateAgentRunStatus } from "./agent-runs.js";
import {
  withPreparedPinnedRolloutRun,
  type BackfillPinnedRolloutSource,
} from "./backfill.js";
import { RecoveryOperationalError } from "./recovery-contract.js";
import { RecoveryDescriptorBudget } from "./recovery-file.js";
import {
  StartupRecoveryBudget,
  persistRecoveryFailure,
  persistStartupBudgetExclusion,
  type RecoveryCutoverOptions,
} from "./recovery-cutover.js";
import {
  getRecoveryRunExclusion,
  recoveryRunIsExecutableSql,
  type RecoveryRunExclusion,
} from "./recovery-exclusions.js";
import { StateRunDurabilityRepository } from "./run-durability.js";
import type { RunJournalBinding } from "./run-durability.js";
import type { StateSqliteDriver } from "./sqlite-driver.js";
import { sqlPlaceholders } from "./sql.js";
import { StateThreadRepository } from "./threads.js";
import {
  recordInFlightToolCallCompletion,
  recordInFlightToolCallUnknownOutcome,
} from "./tool-output-rotation.js";
import { resolveUnknownOutcomeEffect } from "./unknown-outcome-gate.js";
import { cancelAgentRunTree } from "./run-cancellation.js";

const DEFAULT_MAX_STARTUP_RUNS = 4_096;
const DEFAULT_MAX_ROLLOUT_FILES_PER_RUN = 32;

const JOURNAL_EVENT_TYPES = [
  "effect_intent",
  "effect_result",
  "effect_unknown_outcome",
  "effect_review_resolved",
  "run_cancel_requested",
  "run_reopened",
  "run_terminal",
] as const;

type JournalEventType = (typeof JOURNAL_EVENT_TYPES)[number];

interface RecoverableRunRow {
  readonly id: string;
  readonly status: string;
  readonly started_at: string;
  readonly current_session_id: string | null;
}

interface BoundRunSeedRow {
  readonly opened_at: string;
  readonly session_id: string;
}

interface PendingEffectReviewRunRow {
  readonly run_id: string;
}

interface ProjectionRow {
  readonly thread_id: string;
  readonly source_path: string;
  readonly item_index: number;
  readonly event_id: string;
  readonly event_seq: number;
  readonly payload_json: string;
}

interface CanonicalIdentityRow {
  readonly thread_id: string;
  readonly source_path: string;
  readonly item_index: number;
  readonly event_id: string | null;
  readonly event_seq: number | null;
  readonly payload_json: string;
}

interface SourceBoundsRow {
  readonly first_sequence: number | null;
  readonly last_sequence: number | null;
}

export interface StartupRunJournalRecoveryResult {
  readonly runsScanned: number;
  readonly filesScanned: number;
  readonly eventsProjected: number;
  readonly terminalRunsSuppressed: number;
  readonly exclusions: readonly RecoveryRunExclusion[];
}

export interface CanonicalRunJournalProjectionResult {
  readonly filesScanned: number;
  readonly eventsProjected: number;
  readonly terminalSuppressed: boolean;
  readonly exclusion?: RecoveryRunExclusion;
}

type StrictRecoveryOptions = RecoveryCutoverOptions;

/** Refresh and strictly project one run for an on-demand status/replay read. */
export function recoverCanonicalRunJournalForRun(
  driver: StateSqliteDriver,
  runId: string,
  options: {
    readonly maxRolloutFiles?: number;
    readonly strict?: StrictRecoveryOptions;
  } = {},
): CanonicalRunJournalProjectionResult {
  const durableExclusion = getRecoveryRunExclusion(driver, runId);
  if (durableExclusion !== undefined) {
    return emptyProjectionResult(durableExclusion);
  }
  const agentRun = driver
    .prepareState<[string], RecoverableRunRow>(
      `SELECT id, status, started_at, current_session_id
       FROM agent_runs AS runs
       WHERE id = ?
         AND ${recoveryRunIsExecutableSql("runs.id")}
       LIMIT 1`,
    )
    .get(runId);
  const run = agentRun ?? recoverableBoundRun(driver, runId);
  if (run === undefined) {
    return emptyProjectionResult();
  }
  const maxFiles = positiveBound(
    options.maxRolloutFiles ?? DEFAULT_MAX_ROLLOUT_FILES_PER_RUN,
    "maxRolloutFiles",
  );
  const threads = new StateThreadRepository(driver);
  const selection = selectRolloutCandidates(
    driver,
    threads,
    run,
    maxFiles,
    options.strict,
  );
  if (selection.exclusion !== undefined) {
    return emptyProjectionResult(selection.exclusion);
  }
  const sources = selection.sources;
  return recoverStrictRun(driver, threads, run, sources, options.strict);
}

/**
 * Project the bounded set of review-locked runs independently of executable
 * run status. Offline human review may append leased audit evidence after the
 * final automatic execution event, so a terminal agent_runs row is not proof
 * that its effect projection is current.
 */
export function recoverPendingEffectReviewsOnStartup(
  driver: StateSqliteDriver,
  options: {
    readonly maxRuns?: number;
    readonly maxRolloutFilesPerRun?: number;
    readonly strict?: StrictRecoveryOptions;
  } = {},
): StartupRunJournalRecoveryResult {
  const maxRuns = positiveBound(
    options.maxRuns ?? DEFAULT_MAX_STARTUP_RUNS,
    "maxRuns",
  );
  const maxFiles = positiveBound(
    options.maxRolloutFilesPerRun ?? DEFAULT_MAX_ROLLOUT_FILES_PER_RUN,
    "maxRolloutFilesPerRun",
  );
  const rows = driver
    .prepareState<[number], PendingEffectReviewRunRow>(
      `SELECT DISTINCT effect.run_id
       FROM run_effects AS effect
       WHERE effect.review_status = 'pending'
       ORDER BY effect.run_id ASC
       LIMIT ?`,
    )
    .all(maxRuns + 1);
  if (rows.length > maxRuns) {
    throw new Error(
      `daemon startup pending-effect review recovery exceeds the bounded run limit (${maxRuns})`,
    );
  }

  let filesScanned = 0;
  let eventsProjected = 0;
  let terminalRunsSuppressed = 0;
  const exclusions: RecoveryRunExclusion[] = [];
  for (const row of rows) {
    const projected = recoverCanonicalRunJournalForRun(driver, row.run_id, {
      maxRolloutFiles: maxFiles,
      ...(options.strict !== undefined ? { strict: options.strict } : {}),
    });
    if (projected.exclusion !== undefined) {
      exclusions.push(projected.exclusion);
      continue;
    }
    if (projected.filesScanned === 0) {
      throw new Error(
        `run ${row.run_id} has a pending effect review without retained canonical journal evidence`,
      );
    }
    filesScanned += projected.filesScanned;
    eventsProjected += projected.eventsProjected;
    terminalRunsSuppressed += projected.terminalSuppressed ? 1 : 0;
  }
  return {
    runsScanned: rows.length,
    filesScanned,
    eventsProjected,
    terminalRunsSuppressed,
    exclusions: Object.freeze(exclusions),
  };
}

/**
 * In-process child and reviewer runs own lifecycle/binding rows even though
 * they are not daemon-managed `agent_runs`. On-demand replay must still be
 * able to rebuild their consumer-visible projection from the canonical JSONL.
 */
function recoverableBoundRun(
  driver: StateSqliteDriver,
  runId: string,
): RecoverableRunRow | undefined {
  const seed = driver
    .prepareState<[string, string], BoundRunSeedRow>(
      `SELECT epoch.opened_at,
              (
                SELECT binding.session_id
                FROM run_journal_bindings AS binding
                WHERE binding.run_id = ?
                ORDER BY binding.active DESC, binding.epoch DESC,
                         binding.updated_at DESC
                LIMIT 1
              ) AS session_id
       FROM run_lifecycle_epochs AS epoch
       WHERE epoch.run_id = ?
         AND ${recoveryRunIsExecutableSql("epoch.run_id")}
         AND EXISTS (
           SELECT 1 FROM run_journal_bindings AS binding
           WHERE binding.run_id = epoch.run_id
         )
       ORDER BY epoch.epoch ASC
       LIMIT 1`,
    )
    .get(runId, runId);
  if (seed === undefined) return undefined;
  return {
    id: runId,
    status: "running",
    started_at: seed.opened_at,
    current_session_id: seed.session_id,
  };
}

/**
 * Rebuild M4's SQLite run/effect projection from the canonical rollout tail
 * before daemon startup is allowed to restore a stale `agent_runs` row.
 *
 * The search is deliberately bounded. Normal M4 writers bind the exact
 * rollout path before the first durable event, so directory discovery is only
 * a compatibility fallback for rows created before the binding landed. If a
 * fallback would exceed the bound, startup fails closed instead of silently
 * restoring a run whose terminal evidence may be in an unscanned file.
 */
export function recoverCanonicalRunJournalsOnStartup(
  driver: StateSqliteDriver,
  options: {
    readonly recoverableStatuses: readonly string[];
    readonly maxRuns?: number;
    readonly maxRolloutFilesPerRun?: number;
    /** Restrict the bounded scan to rows whose current epoch has no result. */
    readonly onlyMissingTerminalResults?: boolean;
    /** Restrict compatibility recovery to runs with an explicit M4 binding. */
    readonly requireJournalBinding?: boolean;
    readonly strict?: StrictRecoveryOptions;
  },
): StartupRunJournalRecoveryResult {
  if (options.recoverableStatuses.length === 0) {
    return emptyRecoveryResult();
  }
  const maxRuns = positiveBound(
    options.maxRuns ?? DEFAULT_MAX_STARTUP_RUNS,
    "maxRuns",
  );
  const maxFiles = positiveBound(
    options.maxRolloutFilesPerRun ?? DEFAULT_MAX_ROLLOUT_FILES_PER_RUN,
    "maxRolloutFilesPerRun",
  );
  const runs = driver
    .prepareState<unknown[], RecoverableRunRow>(
      `SELECT id, status, started_at, current_session_id
       FROM agent_runs AS runs
       WHERE status IN (${sqlPlaceholders(options.recoverableStatuses.length)})
       AND ${recoveryRunIsExecutableSql("runs.id")}
       ${
         options.onlyMissingTerminalResults === true
           ? `AND NOT EXISTS (
              SELECT 1 FROM run_terminal_results AS terminal
              WHERE terminal.run_id = runs.id
                AND terminal.epoch = (
                  SELECT MAX(epoch) FROM run_lifecycle_epochs
                  WHERE run_id = runs.id
                )
            )`
           : ""
       }
       ${
         options.requireJournalBinding === true
           ? `AND EXISTS (
              SELECT 1 FROM run_journal_bindings AS binding
              WHERE binding.run_id = runs.id
            )`
           : ""
       }
       ORDER BY last_active_at ASC, id ASC
       LIMIT ?`,
    )
    .all(...options.recoverableStatuses, maxRuns + 1);
  if (runs.length > maxRuns) {
    throw new Error(
      `daemon startup run-journal recovery exceeds the bounded run limit (${maxRuns})`,
    );
  }

  const threads = new StateThreadRepository(driver);
  const descriptorBudget =
    options.strict?.descriptorBudget ?? new RecoveryDescriptorBudget();
  const nowMilliseconds = options.strict?.nowMilliseconds ?? Date.now;
  const startupBudget =
    options.strict?.startupBudget ??
    new StartupRecoveryBudget({ nowMilliseconds });
  let filesScanned = 0;
  let eventsProjected = 0;
  let terminalRunsSuppressed = 0;
  const exclusions: RecoveryRunExclusion[] = [];
  for (const run of runs) {
    const durableExclusion = getRecoveryRunExclusion(driver, run.id);
    if (durableExclusion !== undefined) {
      exclusions.push(durableExclusion);
      continue;
    }
    const selection = selectRolloutCandidates(driver, threads, run, maxFiles, {
      ...options.strict,
      descriptorBudget,
      nowMilliseconds,
      startupBudget,
    });
    if (selection.exclusion !== undefined) {
      exclusions.push(selection.exclusion);
      continue;
    }
    const sources = selection.sources;
    if (sources.length === 0) continue;
    const projected = recoverStrictRun(driver, threads, run, sources, {
      ...options.strict,
      descriptorBudget,
      nowMilliseconds,
      startupBudget,
    });
    if (projected.exclusion !== undefined) {
      exclusions.push(projected.exclusion);
      continue;
    }
    filesScanned += projected.filesScanned;
    eventsProjected += projected.eventsProjected;
    terminalRunsSuppressed += projected.terminalSuppressed ? 1 : 0;
  }
  return {
    runsScanned: runs.length,
    filesScanned,
    eventsProjected,
    terminalRunsSuppressed,
    exclusions: Object.freeze(exclusions),
  };
}

function rolloutCandidates(
  driver: StateSqliteDriver,
  threads: StateThreadRepository,
  run: RecoverableRunRow,
  maxFiles: number,
): readonly BackfillPinnedRolloutSource[] {
  const repository = new StateRunDurabilityRepository(driver);
  const known = new Set<string>();
  const bindings = repository.listJournalBindings(run.id);
  for (const binding of bindings) {
    // `active = 0` also means a newer source superseded this still-canonical
    // historical source. Skip only a fully retired range with explicit gap
    // evidence; otherwise every retained binding remains rebuild input.
    const fullyRetired =
      !binding.active &&
      binding.gapReason !== undefined &&
      binding.retiredThroughSequence !== undefined &&
      binding.firstAvailableSequence === undefined;
    if (fullyRetired) continue;
    known.add(binding.sourcePath);
  }
  if (bindings.length > 0) {
    if (known.size > maxFiles) {
      throw tooManyRollouts(run.id, known, maxFiles);
    }
    return sourcesFromBindings(bindings, [...known].sort(), run.id);
  }
  for (const threadId of runThreadIds(run)) {
    const indexed = threads.getThread(threadId);
    if (indexed?.rolloutPath !== undefined && existsSync(indexed.rolloutPath)) {
      known.add(indexed.rolloutPath);
    }
    if (
      indexed?.archivedRolloutPath !== undefined &&
      existsSync(indexed.archivedRolloutPath)
    ) {
      known.add(indexed.archivedRolloutPath);
    }
  }
  if (known.size > maxFiles) {
    throw tooManyRollouts(run.id, known, maxFiles);
  }
  if (known.size > 0) return fallbackSources(sortedByMtime(known), run.id);

  const discovered = new Set<string>();
  for (const threadId of runThreadIds(run)) {
    if (basename(threadId) !== threadId) continue;
    for (const root of ["sessions", "archived_sessions"] as const) {
      const directory = join(driver.projectDir, root, threadId);
      if (!existsSync(directory)) continue;
      for (const name of readdirSync(directory).sort()) {
        if (!name.startsWith("rollout-") || !name.endsWith(".jsonl")) continue;
        const path = join(directory, name);
        if (!statSync(path).isFile()) continue;
        discovered.add(path);
        if (discovered.size > maxFiles) {
          throw tooManyRollouts(run.id, discovered, maxFiles);
        }
      }
    }
  }
  return fallbackSources(sortedByMtime(discovered), run.id);
}

function selectRolloutCandidates(
  driver: StateSqliteDriver,
  threads: StateThreadRepository,
  run: RecoverableRunRow,
  maxFiles: number,
  strict: StrictRecoveryOptions = {},
):
  | {
      readonly sources: readonly BackfillPinnedRolloutSource[];
      readonly exclusion?: never;
    }
  | { readonly sources?: never; readonly exclusion: RecoveryRunExclusion } {
  try {
    return { sources: rolloutCandidates(driver, threads, run, maxFiles) };
  } catch (error) {
    const source =
      error instanceof RolloutCandidateOperationalError
        ? error.source
        : defaultRecoverySource(driver, run);
    const operational =
      error instanceof RecoveryOperationalError
        ? error
        : new RecoveryOperationalError(
            "recovery_storage_unavailable",
            "canonical recovery source discovery failed",
            error instanceof Error ? error.name : "RECOVERY_DISCOVERY",
          );
    return {
      exclusion: persistRecoveryFailure(
        driver,
        run.id,
        [source],
        strict,
        operational,
      ),
    };
  }
}

function defaultRecoverySource(
  driver: StateSqliteDriver,
  run: RecoverableRunRow,
): BackfillPinnedRolloutSource {
  const sessionId = run.current_session_id ?? run.id;
  return Object.freeze({
    sessionId,
    rolloutPath: join(
      driver.projectDir,
      "sessions",
      sessionId,
      "canonical-rollout-unavailable.jsonl",
    ),
    expectedRunId: run.id,
  });
}

function sourcesFromBindings(
  bindings: readonly RunJournalBinding[],
  paths: readonly string[],
  runId: string,
): readonly BackfillPinnedRolloutSource[] {
  return paths.map((rolloutPath) => {
    const matches = bindings.filter(
      (binding) => binding.sourcePath === rolloutPath,
    );
    const binding = matches[0]!;
    return Object.freeze({
      sessionId: binding.sessionId,
      rolloutPath,
      archived: rolloutPath.includes(`${sep}archived_sessions${sep}`),
      expectedRunId: runId,
    });
  });
}

function fallbackSources(
  paths: readonly string[],
  runId: string,
): readonly BackfillPinnedRolloutSource[] {
  return paths.map((rolloutPath) =>
    Object.freeze({
      sessionId: basename(dirname(rolloutPath)),
      rolloutPath,
      archived: rolloutPath.includes(`${sep}archived_sessions${sep}`),
      expectedRunId: runId,
    }),
  );
}

function recoverStrictRun(
  driver: StateSqliteDriver,
  threads: StateThreadRepository,
  run: RecoverableRunRow,
  sources: readonly BackfillPinnedRolloutSource[],
  strict: StrictRecoveryOptions = {},
): CanonicalRunJournalProjectionResult & { readonly readBytes: number } {
  if (sources.length === 0) {
    return { ...emptyProjectionResult(), readBytes: 0 };
  }
  const remaining = strict.startupBudget?.remaining();
  if (
    remaining !== undefined &&
    (remaining.maxReadBytes <= 0 || remaining.maxMilliseconds <= 0)
  ) {
    return {
      ...emptyProjectionResult(
        persistStartupBudgetExclusion(
          driver,
          run.id,
          sources[0]!,
          remaining.maxReadBytes <= 0
            ? "startup_byte_budget"
            : "startup_time_budget",
          (strict.nowMilliseconds ?? Date.now)(),
        ),
      ),
      readBytes: 0,
    };
  }
  const limits =
    remaining === undefined
      ? strict.limits
      : {
          ...strict.limits,
          maxReadBytes: Math.min(
            strict.limits?.maxReadBytes ?? remaining.maxReadBytes,
            remaining.maxReadBytes,
          ),
          maxScanMilliseconds: Math.min(
            strict.limits?.maxScanMilliseconds ?? remaining.maxMilliseconds,
            remaining.maxMilliseconds,
          ),
        };
  try {
    const result = withPreparedPinnedRolloutRun(
      {
        projectDir: driver.projectDir,
        sources,
        threads,
        ...(limits !== undefined ? { limits } : {}),
        ...(strict.descriptorBudget !== undefined
          ? { descriptorBudget: strict.descriptorBudget }
          : {}),
        ...(strict.nowMilliseconds !== undefined
          ? { nowMilliseconds: strict.nowMilliseconds }
          : {}),
      },
      (prepared) =>
        driver.transactionImmediate(() => {
          const projectedSources = prepared.projectAll();
          const projected = projectRunEvents(
            driver,
            run,
            prepared.sources.map(({ rolloutPath }) => rolloutPath),
          );
          prepared.assertPinned();
          return {
            filesScanned: prepared.sources.length,
            ...projected,
            readBytes: projectedSources.reduce(
              (total, source) => total + source.proof.sourceByteLength * 2,
              0,
            ),
          };
        }),
    );
    strict.startupBudget?.consume(result.readBytes);
    return result;
  } catch (error) {
    return {
      ...emptyProjectionResult(
        persistRecoveryFailure(driver, run.id, sources, strict, error),
      ),
      readBytes: 0,
    };
  }
}

function emptyProjectionResult(
  exclusion?: RecoveryRunExclusion,
): CanonicalRunJournalProjectionResult {
  return {
    filesScanned: 0,
    eventsProjected: 0,
    terminalSuppressed: false,
    ...(exclusion !== undefined ? { exclusion } : {}),
  };
}

function projectRunEvents(
  driver: StateSqliteDriver,
  run: RecoverableRunRow,
  sourcePaths: readonly string[],
): { readonly eventsProjected: number; readonly terminalSuppressed: boolean } {
  if (sourcePaths.length === 0) {
    return { eventsProjected: 0, terminalSuppressed: false };
  }
  const identityRows = driver
    .prepareState<unknown[], CanonicalIdentityRow>(
      `SELECT thread_id, source_path, item_index, event_id, event_seq,
              payload_json
       FROM thread_rollout_items
       WHERE source_path IN (${sqlPlaceholders(sourcePaths.length)})
         AND item_type = 'event_msg'
       ORDER BY event_seq ASC, source_path ASC, item_index ASC`,
    )
    .all(...sourcePaths);
  validateCanonicalIdentities(identityRows, run.id);
  const rows = identityRows.filter(
    (row): row is ProjectionRow =>
      row.event_id !== null &&
      row.event_seq !== null &&
      isJournalProjectionType(row.payload_json),
  );
  const relevant = deduplicateRowsForRun(rows, run.id);
  if (relevant.length === 0) {
    return { eventsProjected: 0, terminalSuppressed: false };
  }

  const repository = new StateRunDurabilityRepository(driver);
  if (repository.currentEpoch(run.id) === undefined) {
    repository.ensureInitialEpoch({
      runId: run.id,
      openedAt: run.started_at,
    });
  }
  // Reconstruct the event-time epoch independently of whatever partial
  // projection already exists. Starting from currentEpoch() would assign old
  // pre-reopen effect intents to the newest epoch during an idempotent rebuild.
  let projectionEpoch = 1;
  let projectionOpenedAt = run.started_at;
  let pendingCancellation:
    { readonly reason: string; readonly requestedAt: string } | undefined;
  for (const row of relevant) {
    const message = journalMessage(row, run.id);
    if (message === undefined) {
      throw invalidEvent(row, run.id, "event envelope is invalid");
    }
    const type = message.type;
    const payload = message.payload;
    if (type === "effect_intent") {
      bindSource(
        driver,
        repository,
        run.id,
        projectionEpoch,
        row,
        projectionOpenedAt,
      );
      projectEffectIntent(repository, run.id, projectionEpoch, row, payload);
      continue;
    }
    if (type === "effect_result") {
      projectEffectResult(driver, repository, run.id, row, payload);
      continue;
    }
    if (type === "effect_unknown_outcome") {
      projectUnknownEffect(driver, repository, run.id, row, payload);
      continue;
    }
    if (type === "effect_review_resolved") {
      projectEffectReview(driver, repository, run.id, row, payload);
      continue;
    }
    if (type === "run_cancel_requested") {
      const epoch = requirePositiveInteger(payload.epoch, "epoch");
      if (epoch !== projectionEpoch) {
        throw invalidEvent(
          row,
          run.id,
          "run_cancel_requested epoch is out of order",
        );
      }
      bindSource(
        driver,
        repository,
        run.id,
        projectionEpoch,
        row,
        projectionOpenedAt,
      );
      pendingCancellation = {
        reason: requireString(payload.reason, "reason"),
        requestedAt: requireString(payload.requestedAt, "requestedAt"),
      };
      continue;
    }
    if (type === "run_reopened") {
      const previousEpoch = requirePositiveInteger(
        payload.previousEpoch,
        "previousEpoch",
      );
      const epoch = requirePositiveInteger(payload.epoch, "epoch");
      if (epoch !== previousEpoch + 1 || previousEpoch !== projectionEpoch) {
        throw invalidEvent(row, run.id, "run_reopened epoch is not contiguous");
      }
      const reopenedAt = requireString(payload.reopenedAt, "reopenedAt");
      repository.reopenRun({
        runId: run.id,
        fromEpoch: previousEpoch,
        openedAt: reopenedAt,
        eventId: row.event_id,
        reason: requireString(payload.reason, "reason"),
      });
      projectionEpoch = epoch;
      projectionOpenedAt = reopenedAt;
      pendingCancellation = undefined;
      continue;
    }
    const epoch = requirePositiveInteger(payload.epoch, "epoch");
    if (epoch !== projectionEpoch) {
      throw invalidEvent(row, run.id, "run_terminal epoch is out of order");
    }
    bindSource(driver, repository, run.id, epoch, row, projectionOpenedAt);
    repository.recordTerminalResult({
      epoch,
      result: terminalResult(row, run.id, payload),
      eventId: row.event_id,
    });
  }

  const terminal = repository.getCurrentTerminalResult(run.id);
  if (terminal === undefined) {
    if (pendingCancellation !== undefined) {
      // The daemon crossed the durable cancellation-intent boundary but died
      // before its terminal tail. Never restore that run as executable work;
      // preserve unavailable output until a canonical terminal is recovered.
      cancelAgentRunTree(driver, {
        runId: run.id,
        reason: pendingCancellation.reason,
        cancelledAt: pendingCancellation.requestedAt,
      });
    }
    return { eventsProjected: relevant.length, terminalSuppressed: false };
  }
  updateAgentRunStatus(driver, {
    id: run.id,
    status: terminal.status,
    lastActiveAt: terminal.finishedAt,
    ...(run.current_session_id !== null
      ? { currentSessionId: run.current_session_id }
      : {}),
  });
  return { eventsProjected: relevant.length, terminalSuppressed: true };
}

/**
 * Validate the identity plane before selecting M4 lifecycle/effect messages.
 * A user-facing event and a terminal/effect event share the same per-run
 * sequence namespace, and event IDs are global within that canonical run.
 * Filtering first would let an unrelated event hide an ambiguous terminal or
 * reuse a durable effect identity without startup noticing.
 */
function validateCanonicalIdentities(
  rows: readonly CanonicalIdentityRow[],
  runId: string,
): void {
  const bySequence = new Map<
    number,
    { readonly eventId: string | null; readonly payloadJson: string }
  >();
  const byEventId = new Map<
    string,
    { readonly sequence: number | null; readonly payloadJson: string }
  >();
  for (const row of rows) {
    if (row.event_seq !== null) {
      if (!Number.isSafeInteger(row.event_seq) || row.event_seq <= 0) {
        throw invalidIdentityEvent(
          row,
          runId,
          `event has invalid sequence ${String(row.event_seq)}`,
        );
      }
      const owner = bySequence.get(row.event_seq);
      if (
        owner !== undefined &&
        (owner.eventId !== row.event_id ||
          owner.payloadJson !== row.payload_json)
      ) {
        throw invalidIdentityEvent(
          row,
          runId,
          `sequence is also claimed by event ${owner.eventId ?? "<missing>"}`,
        );
      }
      bySequence.set(row.event_seq, {
        eventId: row.event_id,
        payloadJson: row.payload_json,
      });
    }
    if (row.event_id === null) continue;
    const prior = byEventId.get(row.event_id);
    if (
      prior !== undefined &&
      (prior.sequence !== row.event_seq ||
        prior.payloadJson !== row.payload_json)
    ) {
      // Legacy rollouts predate durable event identities — synthetic ids like
      // "system" recur across DISTINCT events. A payload conflict on an event
      // WITHOUT a sequence is the old format, not corruption: both entries are
      // valid journal content, so dedupe identical copies and keep the rest.
      // Only sequenced identities fail closed. Matches the admission-recovery
      // and effect-review validators.
      if (row.event_seq !== null) {
        throw invalidIdentityEvent(
          row,
          runId,
          "event ID has conflicting content",
        );
      }
      continue;
    }
    byEventId.set(row.event_id, {
      sequence: row.event_seq,
      payloadJson: row.payload_json,
    });
  }
}

function isJournalProjectionType(payloadJson: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson);
  } catch {
    return false;
  }
  const message = asRecord(asRecord(parsed)?.msg);
  return (
    typeof message?.type === "string" &&
    (JOURNAL_EVENT_TYPES as readonly string[]).includes(message.type)
  );
}

function projectEffectIntent(
  repository: StateRunDurabilityRepository,
  runId: string,
  epoch: number,
  row: ProjectionRow,
  payload: JsonObject,
): void {
  const category = requireRecoveryCategory(payload.recoveryCategory);
  const sessionId = row.thread_id;
  const idempotencyKey = optionalString(payload.idempotencyKey);
  repository.beginEffect({
    runId,
    epoch,
    stepId: requireString(payload.stepId, "stepId"),
    ...(sessionId !== runId ? { childRunId: sessionId } : {}),
    sessionId,
    callId: requireString(payload.callId, "callId"),
    toolName: requireString(payload.toolName, "toolName"),
    recoveryCategory: category,
    ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
    intentDigest: requireString(payload.intentDigest, "intentDigest"),
    eventId: row.event_id,
    eventSequence: row.event_seq,
    intentAt: requireString(payload.recordedAt, "recordedAt"),
    effectFormatVersion: effectFormatVersion(payload),
    ...(optionalString(payload.minimumReaderRuntime) !== undefined
      ? {
          minimumReaderRuntime: optionalString(payload.minimumReaderRuntime),
        }
      : {}),
    projection: "canonical_replay",
  });
}

function projectEffectResult(
  driver: StateSqliteDriver,
  repository: StateRunDurabilityRepository,
  runId: string,
  row: ProjectionRow,
  payload: JsonObject,
): void {
  const stepId = requireString(payload.stepId, "stepId");
  const callId = requireString(payload.callId, "callId");
  const toolName = requireString(payload.toolName, "toolName");
  const category = requireRecoveryCategory(payload.recoveryCategory);
  const recordedAt = requireString(payload.recordedAt, "recordedAt");
  const outcome = requireEffectResultOutcome(payload.outcome);
  const formatVersion = effectFormatVersion(payload);
  const boundary = effectBoundary(payload);
  const existing = repository.getEffect(runId, stepId);
  if (
    existing === undefined ||
    existing.callId !== callId ||
    existing.toolName !== toolName ||
    existing.recoveryCategory !== category ||
    existing.intentSequence !==
      requirePositiveInteger(payload.intentEventSeq, "intentEventSeq") ||
    existing.idempotencyKey !== optionalString(payload.idempotencyKey)
  ) {
    throw invalidEvent(row, runId, "effect_result has no matching intent");
  }
  if (formatVersion === 2 && boundary === undefined) {
    throw invalidEvent(
      row,
      runId,
      "effect_result format v2 requires effectBoundary",
    );
  }
  if (
    formatVersion === 1 &&
    category !== "idempotent" &&
    (outcome === "failed" || outcome === "cancelled")
  ) {
    repository.markEffectUnknown({
      runId,
      stepId,
      eventId: row.event_id,
      eventSequence: row.event_seq,
      reason: "legacy_ambiguous_terminal_evidence",
      ...(payload.evidence !== undefined ? { evidence: payload.evidence } : {}),
      observedAt: recordedAt,
    });
    recordInFlightToolCallUnknownOutcome(driver, {
      sessionId: existing.sessionId,
      agentId: runId,
      toolCallId: callId,
      toolName,
      observedAt: recordedAt,
      recoveryCategory: category,
    });
    return;
  }
  repository.completeEffect({
    runId,
    stepId,
    outcome,
    effectBoundary: boundary ?? "crossed",
    ...(payload.noEffectEvidence !== undefined
      ? {
          noEffectEvidence:
            payload.noEffectEvidence as unknown as EffectNoEffectProof,
        }
      : {}),
    eventId: row.event_id,
    eventSequence: row.event_seq,
    ...(optionalString(payload.resultDigest) !== undefined
      ? { resultDigest: optionalString(payload.resultDigest) }
      : {}),
    ...(payload.evidence !== undefined ? { evidence: payload.evidence } : {}),
    completedAt: recordedAt,
  });
  // The acknowledgement is canonical even when the older snapshot writer did
  // not run. Make the legacy recovery row terminal before stale-call recovery
  // can classify it for replay.
  recordInFlightToolCallCompletion(driver, {
    sessionId: existing.sessionId,
    agentId: runId,
    toolCallId: callId,
    toolName,
    result: null,
    isError: outcome !== "committed",
    completedAt: recordedAt,
    recoveryCategory: category,
  });
}

function projectUnknownEffect(
  driver: StateSqliteDriver,
  repository: StateRunDurabilityRepository,
  runId: string,
  row: ProjectionRow,
  payload: JsonObject,
): void {
  const stepId = requireString(payload.stepId, "stepId");
  const callId = requireString(payload.callId, "callId");
  const toolName = requireString(payload.toolName, "toolName");
  const category = requireRecoveryCategory(payload.recoveryCategory);
  if (category === "idempotent") {
    throw invalidEvent(row, runId, "idempotent effect has unknown outcome");
  }
  const existing = repository.getEffect(runId, stepId);
  if (
    existing === undefined ||
    existing.callId !== callId ||
    existing.toolName !== toolName ||
    existing.recoveryCategory !== category ||
    existing.intentSequence !==
      requirePositiveInteger(payload.intentEventSeq, "intentEventSeq") ||
    existing.idempotencyKey !== optionalString(payload.idempotencyKey)
  ) {
    throw invalidEvent(
      row,
      runId,
      "effect_unknown_outcome has no matching intent",
    );
  }
  const recordedAt = requireString(payload.recordedAt, "recordedAt");
  repository.markEffectUnknown({
    runId,
    stepId,
    eventId: row.event_id,
    eventSequence: row.event_seq,
    reason: requireString(payload.reason, "reason"),
    evidence: {
      requiresReview: payload.requiresReview === true,
      ...(payload.callerStop === "timeout" || payload.callerStop === "abort"
        ? { callerStop: payload.callerStop }
        : {}),
      ...(optionalString(payload.callerStoppedAt) !== undefined
        ? { callerStoppedAt: optionalString(payload.callerStoppedAt) }
        : {}),
      ...(optionalString(payload.reservationId) !== undefined
        ? { reservationId: optionalString(payload.reservationId) }
        : {}),
    },
    observedAt: recordedAt,
  });
  recordInFlightToolCallUnknownOutcome(driver, {
    sessionId: existing.sessionId,
    agentId: runId,
    toolCallId: callId,
    toolName,
    observedAt: recordedAt,
    recoveryCategory: category,
  });
}

function projectEffectReview(
  driver: StateSqliteDriver,
  repository: StateRunDurabilityRepository,
  runId: string,
  row: ProjectionRow,
  payload: JsonObject,
): void {
  const stepId = requireString(payload.stepId, "stepId");
  const callId = requireString(payload.callId, "callId");
  if (typeof payload.resolution === "string") {
    // Legacy arbitrary review labels are evidence only; they cannot prove a
    // disposition or lift the mutation gate.
    return;
  }
  const resolution = effectReviewResolution(payload.resolution);
  const existing = repository.getEffect(runId, stepId);
  if (
    existing === undefined ||
    existing.callId !== callId ||
    existing.sessionId !== row.thread_id ||
    existing.outcome !== "unknown_outcome" ||
    existing.resultSequence === undefined ||
    row.event_seq <= existing.resultSequence
  ) {
    throw invalidEvent(row, runId, "effect review has no matching intent");
  }
  driver.transactionImmediate(() => {
    repository.resolveEffectReview({
      runId,
      stepId,
      resolution,
      eventId: row.event_id,
      evidence: {
        callId,
        sequence: row.event_seq,
        source: "canonical_run_journal",
      },
    });
    if (resolution.workflowStatus !== "pending") {
      resolveUnknownOutcomeEffect(driver, {
        sessionId: existing.sessionId,
        toolCallId: callId,
      });
    }
  });
}

function effectFormatVersion(payload: JsonObject): 1 | 2 {
  if (payload.formatVersion === undefined) return 1;
  if (payload.formatVersion === 2) return 2;
  throw new TypeError(
    `unsupported effect evidence format ${String(payload.formatVersion)}`,
  );
}

function effectBoundary(payload: JsonObject): EffectBoundary | undefined {
  if (payload.effectBoundary === undefined) return undefined;
  if (
    payload.effectBoundary === "not_crossed" ||
    payload.effectBoundary === "crossed"
  ) {
    return payload.effectBoundary;
  }
  throw new TypeError("invalid effect boundary evidence");
}

function effectReviewResolution(value: unknown): EffectReviewResolution {
  const record = asRecord(value);
  if (record === undefined) {
    throw new TypeError("effect review resolution must be an object");
  }
  return record as unknown as EffectReviewResolution;
}

function bindSource(
  driver: StateSqliteDriver,
  repository: StateRunDurabilityRepository,
  runId: string,
  epoch: number,
  row: ProjectionRow,
  boundAt: string,
): void {
  const bounds = driver
    .prepareState<[string], SourceBoundsRow>(
      `SELECT MIN(event_seq) AS first_sequence,
              MAX(event_seq) AS last_sequence
       FROM thread_rollout_items
       WHERE source_path = ? AND event_seq IS NOT NULL`,
    )
    .get(row.source_path);
  if (
    bounds?.first_sequence === null ||
    bounds?.first_sequence === undefined ||
    bounds.last_sequence === null
  ) {
    return;
  }
  const existing = repository.getJournalBinding(row.source_path);
  if (existing === undefined) {
    repository.bindJournalSource({
      runId,
      epoch,
      childRunId: row.thread_id,
      sessionId: row.thread_id,
      sourcePath: row.source_path,
      firstAvailableSequence: bounds.first_sequence,
      lastSequence: bounds.last_sequence,
      boundAt,
    });
    return;
  }
  if (
    existing.runId !== runId ||
    existing.childRunId !== row.thread_id ||
    existing.sessionId !== row.thread_id ||
    existing.epoch > epoch
  ) {
    throw invalidEvent(
      row,
      runId,
      "rollout source is bound to a different run, session, or later epoch",
    );
  }
  if (
    existing.firstAvailableSequence === undefined ||
    existing.lastSequence === undefined ||
    existing.firstAvailableSequence > bounds.first_sequence ||
    existing.lastSequence < bounds.last_sequence
  ) {
    repository.updateJournalBounds({
      sourcePath: row.source_path,
      firstAvailableSequence: bounds.first_sequence,
      lastSequence: bounds.last_sequence,
      updatedAt: boundAt,
    });
  }
}

function terminalResult(
  row: ProjectionRow,
  runId: string,
  payload: JsonObject,
): RunTerminalResult {
  return {
    runId,
    status: requireTerminalStatus(payload.status),
    exitCode: nullableFiniteNumber(payload.exitCode, "exitCode"),
    stopReason: nullableString(payload.stopReason, "stopReason"),
    finalMessage: nullableString(payload.finalMessage, "finalMessage"),
    usage: nullableUsage(payload.usage),
    lastSequence: row.event_seq,
    finishedAt: requireString(payload.finishedAt, "finishedAt"),
  };
}

function deduplicateRowsForRun(
  rows: readonly ProjectionRow[],
  runId: string,
): readonly ProjectionRow[] {
  const seen = new Map<string, string>();
  const seenSequences = new Map<
    number,
    { readonly eventId: string; readonly payloadJson: string }
  >();
  const result: ProjectionRow[] = [];
  for (const row of rows) {
    const message = journalMessage(row, runId, false);
    if (message === undefined || message.payload.runId !== runId) continue;
    const signature = `${row.event_seq}:${row.payload_json}`;
    const sequenceOwner = seenSequences.get(row.event_seq);
    if (
      sequenceOwner !== undefined &&
      (sequenceOwner.eventId !== row.event_id ||
        sequenceOwner.payloadJson !== row.payload_json)
    ) {
      throw invalidEvent(
        row,
        runId,
        `sequence is also claimed by event ${sequenceOwner.eventId}`,
      );
    }
    const prior = seen.get(row.event_id);
    if (prior !== undefined) {
      if (prior !== signature) {
        throw invalidEvent(row, runId, "event ID has conflicting content");
      }
      continue;
    }
    seen.set(row.event_id, signature);
    seenSequences.set(row.event_seq, {
      eventId: row.event_id,
      payloadJson: row.payload_json,
    });
    result.push(row);
  }
  return result;
}

function journalMessage(
  row: ProjectionRow,
  runId: string,
  required = true,
):
  | { readonly type: JournalEventType; readonly payload: JsonObject }
  | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.payload_json);
  } catch {
    if (!required) return undefined;
    throw invalidEvent(row, runId, "event envelope is not JSON");
  }
  const envelope = asRecord(parsed);
  const message = asRecord(envelope?.msg);
  const payload = asRecord(message?.payload);
  const type = message?.type;
  if (
    payload === null ||
    typeof type !== "string" ||
    !(JOURNAL_EVENT_TYPES as readonly string[]).includes(type)
  ) {
    if (!required) return undefined;
    throw invalidEvent(row, runId, "event envelope is invalid");
  }
  return { type: type as JournalEventType, payload: payload as JsonObject };
}

function runThreadIds(run: RecoverableRunRow): readonly string[] {
  return [
    ...new Set(
      [run.id, run.current_session_id].filter(
        (value): value is string => value !== null && value.length > 0,
      ),
    ),
  ];
}

function sortedByMtime(paths: ReadonlySet<string>): readonly string[] {
  const entries = [...paths].map((sourcePath) => {
    try {
      return { sourcePath, mtimeMs: statSync(sourcePath).mtimeMs };
    } catch (error) {
      throw candidateStorageError(sourcePath, error);
    }
  });
  entries.sort((left, right) => {
    const time = left.mtimeMs - right.mtimeMs;
    return time === 0 ? left.sourcePath.localeCompare(right.sourcePath) : time;
  });
  return entries.map(({ sourcePath }) => sourcePath);
}

function tooManyRollouts(
  runId: string,
  paths: ReadonlySet<string>,
  max: number,
): RolloutCandidateOperationalError {
  const sourcePath = [...paths].sort()[0]!;
  return new RolloutCandidateOperationalError(
    {
      sessionId: basename(dirname(sourcePath)),
      rolloutPath: sourcePath,
      expectedRunId: runId,
    },
    "concurrency_limit",
    `run ${runId} startup recovery discovered ${paths.size} rollout files; bounded limit is ${max}`,
    "RECOVERY_SOURCE_LIMIT",
  );
}

function candidateStorageError(
  sourcePath: string,
  error: unknown,
): RolloutCandidateOperationalError {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return new RolloutCandidateOperationalError(
    {
      sessionId: basename(dirname(sourcePath)),
      rolloutPath: sourcePath,
    },
    "recovery_storage_unavailable",
    `canonical recovery source metadata is unavailable: ${sourcePath}`,
    typeof code === "string" ? code : "RECOVERY_SOURCE_STAT",
  );
}

class RolloutCandidateOperationalError extends RecoveryOperationalError {
  constructor(
    readonly source: BackfillPinnedRolloutSource,
    reasonCode: ConstructorParameters<typeof RecoveryOperationalError>[0],
    message: string,
    errorClass: string,
  ) {
    super(reasonCode, message, errorClass);
    this.name = "RolloutCandidateOperationalError";
  }
}

function invalidEvent(
  row: ProjectionRow,
  runId: string,
  detail: string,
): Error {
  return new Error(
    `invalid canonical event ${row.event_id} at sequence ${row.event_seq} for run ${runId}: ${detail}`,
  );
}

function invalidIdentityEvent(
  row: CanonicalIdentityRow,
  runId: string,
  detail: string,
): Error {
  return new Error(
    `invalid canonical event ${row.event_id ?? "<missing>"} at sequence ${row.event_seq ?? "<missing>"} for run ${runId}: ${detail}`,
  );
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requirePositiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value as number;
}

function positiveBound(value: number, name: string): number {
  return requirePositiveInteger(value, name);
}

function requireRecoveryCategory(value: unknown): ToolRecoveryCategory {
  if (
    value !== "idempotent" &&
    value !== "side-effecting" &&
    value !== "interactive"
  ) {
    throw new TypeError("recoveryCategory is invalid");
  }
  return value;
}

function requireEffectResultOutcome(
  value: unknown,
): "committed" | "failed" | "cancelled" {
  if (value !== "committed" && value !== "failed" && value !== "cancelled") {
    throw new TypeError("effect result outcome is invalid");
  }
  return value;
}

function requireTerminalStatus(value: unknown): RunTerminalStatus {
  if (
    value !== "completed" &&
    value !== "failed" &&
    value !== "cancelled" &&
    value !== "unknown_outcome"
  ) {
    throw new TypeError("run terminal status is invalid");
  }
  return value;
}

function nullableString(value: unknown, name: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw new TypeError(`${name} is invalid`);
  return value;
}

function nullableFiniteNumber(value: unknown, name: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function nullableUsage(value: unknown): RunUsageTotals | null {
  if (value === null) return null;
  const usage = asRecord(value);
  if (usage === null) throw new TypeError("usage is invalid");
  return {
    inputTokens: requireNonNegativeNumber(usage.inputTokens, "inputTokens"),
    outputTokens: requireNonNegativeNumber(usage.outputTokens, "outputTokens"),
    totalTokens: requireNonNegativeNumber(usage.totalTokens, "totalTokens"),
    costUsd: requireNonNegativeNumber(usage.costUsd, "costUsd"),
  };
}

function requireNonNegativeNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`usage.${name} is invalid`);
  }
  return value;
}

function emptyRecoveryResult(): StartupRunJournalRecoveryResult {
  return {
    runsScanned: 0,
    filesScanned: 0,
    eventsProjected: 0,
    terminalRunsSuppressed: 0,
    exclusions: Object.freeze([]),
  };
}
