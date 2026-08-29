import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  opendirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

import type {
  EffectBoundary,
  EffectNoEffectProof,
  EffectReviewResolution,
  RunResumeReason,
  RunRuntimeSettingsSnapshot,
  RunRuntimeSettingsChangeReason,
  RunSuspensionReason,
  RunTerminalResult,
  RunTerminalStatus,
  RunUsageTotals,
} from "../contracts/run-contracts.js";
import {
  RUN_RUNTIME_MODEL_VERBOSITIES,
  RUN_RUNTIME_PERMISSION_MODES,
  RUN_RUNTIME_REASONING_EFFORTS,
  RUN_RUNTIME_SERVICE_TIERS,
  RUN_RUNTIME_SETTINGS_CHANGE_REASONS,
} from "../contracts/run-contracts.js";
import type { JsonObject } from "../app-server/protocol/index.js";
import type { ToolRecoveryCategory } from "../tools/types.js";
import { asRecord } from "../utils/record.js";
import {
  createResumeRolloutDescriptorLease,
  hasSupportedFileIdentity,
  type ResumeRolloutDescriptorLease,
} from "../session/session-store.js";
import { updateAgentRunStatus } from "./agent-runs.js";
import {
  withPreparedPinnedRolloutRun,
  type BackfillPinnedRolloutSource,
  type PreparedPinnedRolloutRun,
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
/**
 * Each retained startup source owns two handles until the restore loop adopts
 * or closes it: one append-capable rollout fd and one pinned cwd directory fd.
 * Keep the aggregate staging cost well below ordinary per-process fd limits,
 * including the descriptors temporarily needed by the strict scanner.
 */
export const DEFAULT_MAX_RETAINED_STARTUP_RESUME_SOURCES = 32;
const MAX_ROLLOUT_DIRECTORY_ENTRIES = 4_096;

const JOURNAL_EVENT_TYPES = [
  "effect_intent",
  "effect_result",
  "effect_unknown_outcome",
  "effect_review_resolved",
  "run_cancel_requested",
  "run_reopened",
  "run_suspended",
  "run_resumed",
  "run_startup_activated",
  "run_runtime_settings_changed",
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

/** One-shot startup authority for the exact canonical root session. */
export interface StartupRunResumeSource {
  readonly runId: string;
  readonly sessionId: string;
  readonly agentPath: "/root";
  readonly rolloutPath: string;
  readonly rolloutIdentity: { readonly dev: string; readonly ino: string };
  readonly cwd: string;
  readonly activeEpoch: number;
  readonly lifecycleState: "open" | "suspended";
  readonly activeSuspensionEventId?: string;
  readonly activeStartupActivationResumeEventId?: string;
  readonly activeRuntimeSettings?: RunRuntimeSettingsSnapshot;
  readonly activeRuntimeSettingsEventId?: string;
  readonly legacyPermissionMode?: "plan";
  readonly rolloutLease: ResumeRolloutDescriptorLease;
  readonly cwdIdentity: { readonly dev: string; readonly ino: string };
  readonly cwdFd: number;
  close(): void;
}

/** Shared lifetime budget for exact startup resume descriptor pairs. */
export class StartupResumeSourceBudget {
  #retainedSources = 0;

  constructor(readonly limit = DEFAULT_MAX_RETAINED_STARTUP_RESUME_SOURCES) {
    if (
      !Number.isSafeInteger(limit) ||
      limit <= 0 ||
      limit > DEFAULT_MAX_RETAINED_STARTUP_RESUME_SOURCES
    ) {
      throw new TypeError(
        `startup resume source limit must be an integer in [1, ${DEFAULT_MAX_RETAINED_STARTUP_RESUME_SOURCES}]`,
      );
    }
  }

  get retainedSources(): number {
    return this.#retainedSources;
  }

  reserve(): () => void {
    if (this.#retainedSources >= this.limit) {
      throw new RecoveryOperationalError(
        "descriptor_limit",
        `startup resume source budget is limited to ${this.limit} retained source(s)`,
        "STARTUP_RESUME_DESCRIPTOR_BUDGET",
      );
    }
    this.#retainedSources += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#retainedSources -= 1;
    };
  }
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
    /** Retain an exact descriptor authority for daemon runtime restoration. */
    readonly onResumeSource?: (source: StartupRunResumeSource) => void;
    /** Aggregate lifetime budget shared across every startup state database. */
    readonly resumeSourceBudget?: StartupResumeSourceBudget;
    /** Test-only race seam after cwd fd open and before pathname reproof. */
    readonly afterStartupResumeCwdOpenForTestingOnly?: (cwd: string) => void;
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
    const projected = recoverStrictRun(
      driver,
      threads,
      run,
      sources,
      {
        ...options.strict,
        descriptorBudget,
        nowMilliseconds,
        startupBudget,
      },
      options.onResumeSource,
      options.resumeSourceBudget,
      options.afterStartupResumeCwdOpenForTestingOnly,
    );
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
  const known = new Map<string, RunJournalBinding>();
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
    const resolvedPath = resolveBoundRolloutPath(binding.sourcePath);
    const prior = known.get(resolvedPath);
    if (
      prior !== undefined &&
      (prior.runId !== binding.runId ||
        prior.epoch !== binding.epoch ||
        prior.childRunId !== binding.childRunId ||
        prior.sessionId !== binding.sessionId)
    ) {
      throw new RolloutCandidateOperationalError(
        {
          sessionId: binding.sessionId,
          rolloutPath: resolvedPath,
          expectedRunId: run.id,
        },
        "concurrency_limit",
        `multiple journal bindings resolve to the same startup source: ${resolvedPath}`,
        "RECOVERY_SOURCE_AMBIGUOUS",
      );
    }
    if (prior === undefined || (!prior.active && binding.active)) {
      known.set(resolvedPath, binding);
    }
  }
  if (bindings.length > 0) {
    if (known.size > maxFiles) {
      throw tooManyRollouts(run.id, new Set(known.keys()), maxFiles);
    }
    return sourcesFromBindings(known, run.id);
  }
  const fallback = new Set<string>();
  for (const threadId of runThreadIds(run)) {
    const indexed = threads.getThread(threadId);
    if (indexed?.rolloutPath !== undefined) {
      const resolved = resolveIndexedRolloutPath(indexed.rolloutPath);
      if (resolved !== undefined) fallback.add(resolved);
    }
    if (indexed?.archivedRolloutPath !== undefined) {
      const resolved = resolveIndexedRolloutPath(indexed.archivedRolloutPath);
      if (resolved !== undefined) fallback.add(resolved);
    }
  }
  if (fallback.size > maxFiles) {
    throw tooManyRollouts(run.id, fallback, maxFiles);
  }
  if (fallback.size > 0) {
    return fallbackSources(sortedByMtime(fallback), run.id);
  }

  const discovered = new Set<string>();
  for (const threadId of runThreadIds(run)) {
    if (basename(threadId) !== threadId) continue;
    for (const root of ["sessions", "archived_sessions"] as const) {
      const directory = join(driver.projectDir, root, threadId);
      if (!existsSync(directory)) continue;
      for (const path of preferredRolloutPaths(directory)) {
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
  bindingsByResolvedPath: ReadonlyMap<string, RunJournalBinding>,
  runId: string,
): readonly BackfillPinnedRolloutSource[] {
  return [...bindingsByResolvedPath.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([rolloutPath, binding]) =>
      Object.freeze({
        sessionId: binding.sessionId,
        rolloutPath,
        archived: rolloutPath.includes(`${sep}archived_sessions${sep}`),
        expectedRunId: runId,
        activeBinding: binding.active,
      }),
    );
}

/**
 * A descriptor-bound rewrite temporarily moves the bound normal pathname to a
 * recovery name. If the process dies before publishing the replacement, use
 * that same-directory recovery generation. Once any normal generation exists,
 * recovery names are stale cleanup artifacts and must not participate.
 */
function resolveBoundRolloutPath(sourcePath: string): string {
  const preferred = preferredRolloutPaths(dirname(sourcePath));
  if (preferred.length === 0) return sourcePath;
  if (
    existsSync(sourcePath) &&
    preferred.includes(sourcePath) &&
    !isRecoveryRolloutPath(sourcePath)
  ) {
    return sourcePath;
  }
  if (preferred.includes(sourcePath) && preferred.length === 1) {
    return sourcePath;
  }
  return sortedByMtime(new Set(preferred)).at(-1)!;
}

function resolveIndexedRolloutPath(sourcePath: string): string | undefined {
  const preferred = preferredRolloutPaths(dirname(sourcePath));
  if (preferred.length === 0) return undefined;
  if (preferred.includes(sourcePath) && !isRecoveryRolloutPath(sourcePath)) {
    return sourcePath;
  }
  return sortedByMtime(new Set(preferred)).at(-1);
}

function preferredRolloutPaths(directory: string): readonly string[] {
  const names: string[] = [];
  let handle: ReturnType<typeof opendirSync> | undefined;
  let primaryFailure: unknown;
  try {
    handle = opendirSync(directory);
    while (true) {
      const entry = handle.readSync();
      if (entry === null) break;
      if (names.length >= MAX_ROLLOUT_DIRECTORY_ENTRIES) {
        throw new RecoveryOperationalError(
          "recovery_storage_unavailable",
          `rollout directory exceeds ${MAX_ROLLOUT_DIRECTORY_ENTRIES} entries`,
          "RECOVERY_DIRECTORY_ENTRY_LIMIT",
        );
      }
      names.push(entry.name);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    primaryFailure = error;
    throw candidateStorageError(directory, error);
  } finally {
    if (handle !== undefined) {
      try {
        handle.closeSync();
      } catch (error) {
        if (primaryFailure !== undefined) {
          throw new AggregateError(
            [primaryFailure, error],
            "rollout directory scan and close failed",
            { cause: primaryFailure },
          );
        }
        throw candidateStorageError(directory, error);
      }
    }
  }
  names.sort();
  const candidates = names.flatMap((name) => {
    if (!name.startsWith("rollout-") || !name.endsWith(".jsonl")) return [];
    const sourcePath = join(directory, name);
    try {
      return statSync(sourcePath).isFile() ? [sourcePath] : [];
    } catch (error) {
      throw candidateStorageError(sourcePath, error);
    }
  });
  const normal = candidates.filter(
    (sourcePath) => !isRecoveryRolloutPath(sourcePath),
  );
  return normal.length > 0 ? normal : candidates;
}

function isRecoveryRolloutPath(sourcePath: string): boolean {
  return basename(sourcePath).startsWith("rollout-recovery-");
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

function authoritativeLifecycleProof(
  sources: readonly BackfillPinnedRolloutSource[],
  proofs: readonly {
    readonly activeEpoch: number;
    readonly activeLifecycleState: "open" | "suspended" | "terminal";
    readonly activeTerminalStatus?:
      "completed" | "failed" | "cancelled" | "unknown_outcome";
    readonly activeSuspensionEventId?: string;
    readonly activeCancellationRequestEventId?: string;
    readonly activeStartupActivationResumeEventId?: string;
    readonly activeRuntimeSettings?: RunRuntimeSettingsSnapshot;
    readonly activeRuntimeSettingsEventId?: string;
    readonly legacyPermissionMode?: "plan";
    readonly eventCount: number;
    readonly sourceByteLength: number;
    readonly sourceSha256: string;
  }[],
  runId: string,
): {
  readonly sourceIndex: number;
  readonly activeEpoch: number;
  readonly activeLifecycleState: "open" | "suspended" | "terminal";
  readonly activeTerminalStatus?:
    "completed" | "failed" | "cancelled" | "unknown_outcome";
  readonly activeSuspensionEventId?: string;
  readonly activeCancellationRequestEventId?: string;
  readonly activeStartupActivationResumeEventId?: string;
  readonly activeRuntimeSettings?: RunRuntimeSettingsSnapshot;
  readonly activeRuntimeSettingsEventId?: string;
  readonly legacyPermissionMode?: "plan";
} {
  if (sources.length !== proofs.length || proofs.length === 0) {
    throw new Error(`run ${runId} has no pinned canonical lifecycle proof`);
  }
  const entries = sources.map((source, index) => ({
    sourceIndex: index,
    source,
    proof: proofs[index]!,
  }));
  const rootEntries = entries.filter(
    ({ source }) =>
      source.sessionId === runId ||
      basename(dirname(source.rolloutPath)) === runId,
  );
  const rootCandidates = rootEntries.length > 0 ? rootEntries : entries;
  const activeRootCandidates = rootCandidates.filter(
    ({ source }) => source.activeBinding === true,
  );
  if (activeRootCandidates.length > 1) {
    throw new Error(`run ${runId} has multiple active root journal bindings`);
  }
  const candidates =
    activeRootCandidates.length === 1 ? activeRootCandidates : rootCandidates;
  candidates.sort(
    (left, right) =>
      right.proof.activeEpoch - left.proof.activeEpoch ||
      right.proof.eventCount - left.proof.eventCount ||
      right.proof.sourceByteLength - left.proof.sourceByteLength ||
      right.source.rolloutPath.localeCompare(left.source.rolloutPath),
  );
  const selected = candidates[0]!;
  const equallyAuthoritative = candidates.filter(
    ({ proof }) =>
      proof.activeEpoch === selected.proof.activeEpoch &&
      proof.eventCount === selected.proof.eventCount &&
      proof.sourceByteLength === selected.proof.sourceByteLength,
  );
  if (
    equallyAuthoritative.some(
      ({ proof }) =>
        proof.activeLifecycleState !== selected.proof.activeLifecycleState ||
        proof.activeTerminalStatus !== selected.proof.activeTerminalStatus ||
        proof.activeSuspensionEventId !==
          selected.proof.activeSuspensionEventId ||
        proof.activeCancellationRequestEventId !==
          selected.proof.activeCancellationRequestEventId ||
        proof.activeStartupActivationResumeEventId !==
          selected.proof.activeStartupActivationResumeEventId ||
        proof.activeRuntimeSettingsEventId !==
          selected.proof.activeRuntimeSettingsEventId ||
        proof.legacyPermissionMode !== selected.proof.legacyPermissionMode ||
        JSON.stringify(proof.activeRuntimeSettings) !==
          JSON.stringify(selected.proof.activeRuntimeSettings) ||
        proof.sourceSha256 !== selected.proof.sourceSha256,
    )
  ) {
    throw new Error(`run ${runId} has conflicting canonical lifecycle proofs`);
  }
  return {
    sourceIndex: selected.sourceIndex,
    activeEpoch: selected.proof.activeEpoch,
    activeLifecycleState: selected.proof.activeLifecycleState,
    ...(selected.proof.activeTerminalStatus !== undefined
      ? { activeTerminalStatus: selected.proof.activeTerminalStatus }
      : {}),
    ...(selected.proof.activeSuspensionEventId !== undefined
      ? { activeSuspensionEventId: selected.proof.activeSuspensionEventId }
      : {}),
    ...(selected.proof.activeCancellationRequestEventId !== undefined
      ? {
          activeCancellationRequestEventId:
            selected.proof.activeCancellationRequestEventId,
        }
      : {}),
    ...(selected.proof.activeStartupActivationResumeEventId !== undefined
      ? {
          activeStartupActivationResumeEventId:
            selected.proof.activeStartupActivationResumeEventId,
        }
      : {}),
    ...(selected.proof.activeRuntimeSettings !== undefined
      ? {
          activeRuntimeSettings: selected.proof.activeRuntimeSettings,
          activeRuntimeSettingsEventId:
            selected.proof.activeRuntimeSettingsEventId!,
        }
      : {}),
    ...(selected.proof.legacyPermissionMode !== undefined
      ? { legacyPermissionMode: selected.proof.legacyPermissionMode }
      : {}),
  };
}

function createStartupRunResumeSource(
  prepared: PreparedPinnedRolloutRun,
  lifecycle: {
    readonly sourceIndex: number;
    readonly activeEpoch: number;
    readonly activeLifecycleState: "open" | "suspended" | "terminal";
    readonly activeTerminalStatus?:
      "completed" | "failed" | "cancelled" | "unknown_outcome";
    readonly activeSuspensionEventId?: string;
    readonly activeCancellationRequestEventId?: string;
    readonly activeStartupActivationResumeEventId?: string;
    readonly activeRuntimeSettings?: RunRuntimeSettingsSnapshot;
    readonly activeRuntimeSettingsEventId?: string;
    readonly legacyPermissionMode?: "plan";
  },
  runId: string,
  budget?: StartupResumeSourceBudget,
  afterCwdOpenForTestingOnly?: (cwd: string) => void,
): StartupRunResumeSource {
  if (lifecycle.activeLifecycleState === "terminal") {
    throw new Error(`terminal run ${runId} cannot retain resume authority`);
  }
  const source = prepared.sources[lifecycle.sourceIndex];
  const metadata = prepared.initialSessionMetadata[lifecycle.sourceIndex];
  if (
    source === undefined ||
    metadata === undefined ||
    source.sessionId !== runId ||
    metadata.sessionId !== runId
  ) {
    throw new Error(
      `run ${runId} has no exact canonical root source for startup restore`,
    );
  }
  const releaseBudget = budget?.reserve() ?? (() => {});
  let budgetReleased = false;
  const releaseBudgetOnce = () => {
    if (budgetReleased) return;
    budgetReleased = true;
    releaseBudget();
  };
  let cwdProof:
    | {
        readonly fd: number;
        readonly identity: { readonly dev: string; readonly ino: string };
      }
    | undefined;
  let rolloutFd: number | undefined;
  try {
    cwdProof = openStartupResumeCwd(metadata.cwd, afterCwdOpenForTestingOnly);
    rolloutFd = prepared.openAppendDescriptor(lifecycle.sourceIndex);
    const rolloutStats = fstatSync(rolloutFd, { bigint: true });
    if (
      !rolloutStats.isFile() ||
      rolloutStats.nlink !== 1n ||
      !hasSupportedFileIdentity(rolloutStats)
    ) {
      throw new Error(
        `run ${runId} canonical rollout has no stable regular-file identity`,
      );
    }
    const rolloutIdentity = Object.freeze({
      dev: rolloutStats.dev.toString(),
      ino: rolloutStats.ino.toString(),
    });
    const rolloutLease = createResumeRolloutDescriptorLease(
      source.rolloutPath,
      rolloutFd,
    );
    rolloutFd = undefined;
    let openCwdFd: number | undefined = cwdProof.fd;
    return Object.freeze({
      runId,
      sessionId: source.sessionId,
      agentPath: "/root" as const,
      rolloutPath: source.rolloutPath,
      rolloutIdentity,
      cwd: metadata.cwd,
      activeEpoch: lifecycle.activeEpoch,
      lifecycleState: lifecycle.activeLifecycleState,
      ...(lifecycle.activeSuspensionEventId !== undefined
        ? { activeSuspensionEventId: lifecycle.activeSuspensionEventId }
        : {}),
      ...(lifecycle.activeStartupActivationResumeEventId !== undefined
        ? {
            activeStartupActivationResumeEventId:
              lifecycle.activeStartupActivationResumeEventId,
          }
        : {}),
      ...(lifecycle.activeRuntimeSettings !== undefined
        ? {
            activeRuntimeSettings: lifecycle.activeRuntimeSettings,
            activeRuntimeSettingsEventId:
              lifecycle.activeRuntimeSettingsEventId!,
          }
        : {}),
      ...(lifecycle.legacyPermissionMode !== undefined
        ? { legacyPermissionMode: lifecycle.legacyPermissionMode }
        : {}),
      rolloutLease,
      cwdIdentity: cwdProof.identity,
      cwdFd: cwdProof.fd,
      close: () => {
        const closeErrors: unknown[] = [];
        try {
          try {
            rolloutLease.closeUnclaimed();
          } catch (error) {
            closeErrors.push(error);
          }
          if (openCwdFd !== undefined) {
            const closing = openCwdFd;
            openCwdFd = undefined;
            try {
              closeSync(closing);
            } catch (error) {
              closeErrors.push(error);
            }
          }
        } finally {
          releaseBudgetOnce();
        }
        if (closeErrors.length > 0) {
          throw new AggregateError(
            closeErrors,
            "startup resume source cleanup failed",
          );
        }
      },
    });
  } catch (error) {
    const closeErrors: unknown[] = [];
    if (rolloutFd !== undefined) {
      try {
        closeSync(rolloutFd);
      } catch (closeError) {
        closeErrors.push(closeError);
      }
    }
    if (cwdProof !== undefined) {
      try {
        closeSync(cwdProof.fd);
      } catch (closeError) {
        closeErrors.push(closeError);
      }
    }
    releaseBudgetOnce();
    if (closeErrors.length > 0) {
      throw new AggregateError(
        [error, ...closeErrors],
        "startup resume source creation and cleanup failed",
        { cause: error },
      );
    }
    throw error;
  }
}

function openStartupResumeCwd(
  cwd: string,
  afterOpenForTestingOnly?: (cwd: string) => void,
): {
  readonly fd: number;
  readonly identity: { readonly dev: string; readonly ino: string };
} {
  if (!isAbsolute(cwd) || resolve(cwd) !== cwd) {
    throw new Error(
      "canonical startup resume cwd is not absolute and normalized",
    );
  }
  const before = lstatSync(cwd, { bigint: true });
  if (
    !before.isDirectory() ||
    before.isSymbolicLink() ||
    !hasSupportedFileIdentity(before) ||
    realpathSync(cwd) !== cwd
  ) {
    throw new Error(
      "canonical startup resume cwd is not a supported non-symlink directory",
    );
  }
  const noFollow =
    (fsConstants as typeof fsConstants & { readonly O_NOFOLLOW?: number })
      .O_NOFOLLOW ?? 0;
  const directoryOnly =
    (fsConstants as typeof fsConstants & { readonly O_DIRECTORY?: number })
      .O_DIRECTORY ?? 0;
  const fd = openSync(cwd, fsConstants.O_RDONLY | noFollow | directoryOnly);
  try {
    const opened = fstatSync(fd, { bigint: true });
    afterOpenForTestingOnly?.(cwd);
    const after = lstatSync(cwd, { bigint: true });
    if (
      !opened.isDirectory() ||
      !after.isDirectory() ||
      after.isSymbolicLink() ||
      !hasSupportedFileIdentity(opened) ||
      !hasSupportedFileIdentity(after) ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.dev !== after.dev ||
      opened.ino !== after.ino ||
      realpathSync(cwd) !== cwd
    ) {
      throw new Error("canonical startup resume cwd changed while pinned");
    }
    return {
      fd,
      identity: {
        dev: opened.dev.toString(10),
        ino: opened.ino.toString(10),
      },
    };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function recoverStrictRun(
  driver: StateSqliteDriver,
  threads: StateThreadRepository,
  run: RecoverableRunRow,
  sources: readonly BackfillPinnedRolloutSource[],
  strict: StrictRecoveryOptions = {},
  onResumeSource?: (source: StartupRunResumeSource) => void,
  resumeSourceBudget?: StartupResumeSourceBudget,
  afterStartupResumeCwdOpenForTestingOnly?: (cwd: string) => void,
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
  let retainedResumeSource: StartupRunResumeSource | undefined;
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
      (prepared) => {
        const projected = driver.transactionImmediate(() => {
          const projectedSources = prepared.projectAll();
          const canonicalLifecycle = authoritativeLifecycleProof(
            prepared.sources,
            prepared.proofs,
            run.id,
          );
          const eventProjection = projectRunEvents(
            driver,
            run,
            prepared.sources.map(({ rolloutPath }) => rolloutPath),
            canonicalLifecycle,
          );
          prepared.assertPinned();
          return {
            filesScanned: prepared.sources.length,
            ...eventProjection,
            readBytes: projectedSources.reduce(
              (total, source) => total + source.proof.sourceByteLength * 2,
              0,
            ),
          };
        });
        const canonicalLifecycle = authoritativeLifecycleProof(
          prepared.sources,
          prepared.proofs,
          run.id,
        );
        if (
          onResumeSource !== undefined &&
          canonicalLifecycle.activeLifecycleState !== "terminal" &&
          canonicalLifecycle.activeCancellationRequestEventId === undefined
        ) {
          try {
            retainedResumeSource = createStartupRunResumeSource(
              prepared,
              canonicalLifecycle,
              run.id,
              resumeSourceBudget,
              afterStartupResumeCwdOpenForTestingOnly,
            );
          } catch (error) {
            // Canonical projection already committed under the pinned source
            // proof. Failure to retain optional live-runtime descriptors (for
            // example an unavailable cwd) leaves the run listable and cold;
            // it must not launder that successful projection into a permanent
            // canonical exclusion. Cleanup failures remain fatal because they
            // can represent leaked authority.
            if (error instanceof AggregateError) throw error;
            retainedResumeSource = undefined;
          }
        }
        prepared.assertPinned();
        return projected;
      },
    );
    strict.startupBudget?.consume(result.readBytes);
    if (retainedResumeSource !== undefined) {
      onResumeSource?.(retainedResumeSource);
      retainedResumeSource = undefined;
    }
    return result;
  } catch (error) {
    retainedResumeSource?.close();
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
  canonicalLifecycle: {
    readonly activeEpoch: number;
    readonly activeLifecycleState: "open" | "suspended" | "terminal";
    readonly activeTerminalStatus?:
      "completed" | "failed" | "cancelled" | "unknown_outcome";
    readonly activeSuspensionEventId?: string;
    readonly activeCancellationRequestEventId?: string;
    readonly activeStartupActivationResumeEventId?: string;
    readonly activeRuntimeSettings?: RunRuntimeSettingsSnapshot;
    readonly activeRuntimeSettingsEventId?: string;
    readonly legacyPermissionMode?: "plan";
  },
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
    | {
        readonly eventId: string;
        readonly reason: string;
        readonly requestedAt: string;
      }
    | undefined;
  let lifecycleBoundaryAt: string | undefined;
  let pendingStartupActivationResumeEventId: string | undefined;
  let projectedRuntimeSettings: RunRuntimeSettingsSnapshot | undefined;
  let projectedRuntimeSettingsEventId: string | undefined;
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
        eventId: row.event_id,
        reason: requireString(payload.reason, "reason"),
        requestedAt: requireString(payload.requestedAt, "requestedAt"),
      };
      continue;
    }
    if (type === "run_reopened") {
      if (pendingCancellation !== undefined) {
        throw invalidEvent(
          row,
          run.id,
          "run_reopened follows a cancellation request",
        );
      }
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
    if (type === "run_suspended") {
      if (pendingCancellation !== undefined) {
        throw invalidEvent(
          row,
          run.id,
          "run_suspended follows a cancellation request",
        );
      }
      const epoch = requirePositiveInteger(payload.epoch, "epoch");
      if (epoch !== projectionEpoch) {
        throw invalidEvent(row, run.id, "run_suspended epoch is out of order");
      }
      bindSource(
        driver,
        repository,
        run.id,
        projectionEpoch,
        row,
        projectionOpenedAt,
      );
      const suspendedAt = requireString(payload.suspendedAt, "suspendedAt");
      repository.recordRunSuspended({
        runId: run.id,
        epoch,
        eventId: row.event_id,
        eventSequence: row.event_seq,
        reason: requireSuspensionReason(payload.reason),
        suspendedAt,
      });
      pendingStartupActivationResumeEventId = undefined;
      lifecycleBoundaryAt = suspendedAt;
      continue;
    }
    if (type === "run_resumed") {
      if (pendingCancellation !== undefined) {
        throw invalidEvent(
          row,
          run.id,
          "run_resumed follows a cancellation request",
        );
      }
      const epoch = requirePositiveInteger(payload.epoch, "epoch");
      if (epoch !== projectionEpoch) {
        throw invalidEvent(row, run.id, "run_resumed epoch is out of order");
      }
      bindSource(
        driver,
        repository,
        run.id,
        projectionEpoch,
        row,
        projectionOpenedAt,
      );
      const resumedAt = requireString(payload.resumedAt, "resumedAt");
      repository.recordRunResumed({
        runId: run.id,
        epoch,
        suspensionEventId: requireString(
          payload.suspensionEventId,
          "suspensionEventId",
        ),
        eventId: row.event_id,
        eventSequence: row.event_seq,
        reason: requireResumeReason(payload.reason),
        resumedAt,
      });
      pendingStartupActivationResumeEventId = row.event_id;
      lifecycleBoundaryAt = resumedAt;
      continue;
    }
    if (type === "run_startup_activated") {
      if (pendingCancellation !== undefined) {
        throw invalidEvent(
          row,
          run.id,
          "run_startup_activated follows a cancellation request",
        );
      }
      const epoch = requirePositiveInteger(payload.epoch, "epoch");
      if (epoch !== projectionEpoch) {
        throw invalidEvent(
          row,
          run.id,
          "run_startup_activated epoch is out of order",
        );
      }
      const resumeEventId = requireString(
        payload.resumeEventId,
        "resumeEventId",
      );
      if (resumeEventId !== pendingStartupActivationResumeEventId) {
        throw invalidEvent(
          row,
          run.id,
          "run_startup_activated does not match the pending resume",
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
      repository.recordRunStartupActivated({
        runId: run.id,
        epoch,
        resumeEventId,
        eventId: row.event_id,
        eventSequence: row.event_seq,
        activatedAt: requireString(payload.activatedAt, "activatedAt"),
      });
      pendingStartupActivationResumeEventId = undefined;
      continue;
    }
    if (type === "run_runtime_settings_changed") {
      if (pendingCancellation !== undefined) {
        throw invalidEvent(
          row,
          run.id,
          "run_runtime_settings_changed follows a cancellation request",
        );
      }
      const epoch = requirePositiveInteger(payload.epoch, "epoch");
      if (epoch !== projectionEpoch) {
        throw invalidEvent(
          row,
          run.id,
          "run_runtime_settings_changed epoch is out of order",
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
      const settings = runtimeSettingsProjectionPayload(payload);
      const previousSettingsEventId =
        optionalString(payload.previousSettingsEventId) ?? null;
      const rollbackOfSettingsEventId =
        optionalString(payload.rollbackOfSettingsEventId) ?? null;
      repository.recordRuntimeSettingsChanged({
        runId: run.id,
        epoch,
        eventId: row.event_id,
        eventSequence: row.event_seq,
        previousSettingsEventId,
        rollbackOfSettingsEventId,
        reason: requireRuntimeSettingsReason(payload.reason),
        changedAt: requireString(payload.changedAt, "changedAt"),
        settings,
      });
      projectedRuntimeSettings = settings;
      projectedRuntimeSettingsEventId = row.event_id;
      continue;
    }
    const epoch = requirePositiveInteger(payload.epoch, "epoch");
    if (epoch !== projectionEpoch) {
      throw invalidEvent(row, run.id, "run_terminal epoch is out of order");
    }
    if (
      pendingCancellation !== undefined &&
      payload.status !== "cancelled" &&
      payload.status !== "unknown_outcome"
    ) {
      throw invalidEvent(
        row,
        run.id,
        "run terminal conflicts with its cancellation request",
      );
    }
    bindSource(driver, repository, run.id, epoch, row, projectionOpenedAt);
    repository.recordTerminalResult({
      epoch,
      result: terminalResult(row, run.id, payload),
      eventId: row.event_id,
    });
    pendingStartupActivationResumeEventId = undefined;
  }

  const durableEpoch = repository.currentEpoch(run.id);
  if (
    durableEpoch === undefined ||
    durableEpoch.epoch !== projectionEpoch ||
    projectionEpoch !== canonicalLifecycle.activeEpoch
  ) {
    throw new Error(
      `run ${run.id} canonical lifecycle ends at epoch ${canonicalLifecycle.activeEpoch}, ordered replay reaches ${projectionEpoch}, and SQLite reaches ${durableEpoch?.epoch ?? "missing"}`,
    );
  }
  const activeSuspension = repository.getActiveSuspension(run.id);
  const pendingStartupActivation = repository.getPendingStartupActivation(
    run.id,
  );
  const durableRuntimeSettings = repository.getCurrentRuntimeSettings(run.id);
  const terminal = repository.getCurrentTerminalResult(run.id);
  const projectedLifecycleState =
    terminal !== undefined
      ? "terminal"
      : activeSuspension !== undefined
        ? "suspended"
        : "open";
  if (
    projectedLifecycleState !== canonicalLifecycle.activeLifecycleState ||
    terminal?.status !== canonicalLifecycle.activeTerminalStatus ||
    activeSuspension?.eventId !== canonicalLifecycle.activeSuspensionEventId ||
    pendingCancellation?.eventId !==
      canonicalLifecycle.activeCancellationRequestEventId ||
    pendingStartupActivation?.resumeEventId !==
      canonicalLifecycle.activeStartupActivationResumeEventId ||
    pendingStartupActivationResumeEventId !==
      canonicalLifecycle.activeStartupActivationResumeEventId ||
    projectedRuntimeSettingsEventId !==
      canonicalLifecycle.activeRuntimeSettingsEventId ||
    durableRuntimeSettings?.eventId !==
      canonicalLifecycle.activeRuntimeSettingsEventId ||
    JSON.stringify(projectedRuntimeSettings) !==
      JSON.stringify(canonicalLifecycle.activeRuntimeSettings) ||
    JSON.stringify(
      durableRuntimeSettings === undefined
        ? undefined
        : runtimeSettingsSnapshot(durableRuntimeSettings),
    ) !== JSON.stringify(canonicalLifecycle.activeRuntimeSettings)
  ) {
    throw new Error(
      `run ${run.id} lifecycle projection does not match its pinned canonical proof`,
    );
  }

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
      return { eventsProjected: relevant.length, terminalSuppressed: false };
    }
    const suspension = repository.getActiveSuspension(run.id);
    if (suspension !== undefined) {
      updateAgentRunStatus(driver, {
        id: run.id,
        status: "suspended",
        lastActiveAt: suspension.suspendedAt,
        ...(run.current_session_id !== null
          ? { currentSessionId: run.current_session_id }
          : {}),
      });
    } else if (lifecycleBoundaryAt !== undefined) {
      // Covers the crash window after run_resumed fsync but before its SQLite
      // projection/status write. The epoch remains unchanged and executable.
      updateAgentRunStatus(driver, {
        id: run.id,
        status: "running",
        lastActiveAt: lifecycleBoundaryAt,
        ...(run.current_session_id !== null
          ? { currentSessionId: run.current_session_id }
          : {}),
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

function requireSuspensionReason(value: unknown): RunSuspensionReason {
  if (value !== "daemon_shutdown_idle") {
    throw new TypeError("run suspension reason is invalid");
  }
  return value;
}

function requireResumeReason(value: unknown): RunResumeReason {
  if (value !== "daemon_startup_restore" && value !== "explicit_continue") {
    throw new TypeError("run resume reason is invalid");
  }
  return value;
}

function requireRuntimeSettingsReason(
  value: unknown,
): RunRuntimeSettingsChangeReason {
  if (!RUN_RUNTIME_SETTINGS_CHANGE_REASONS.includes(value as never)) {
    throw new TypeError("run runtime settings reason is invalid");
  }
  return value as RunRuntimeSettingsChangeReason;
}

function runtimeSettingsProjectionPayload(
  payload: JsonObject,
): RunRuntimeSettingsSnapshot {
  const permissionMode = payload.permissionMode;
  const prePlanMode = payload.prePlanMode;
  const reasoningEffort = payload.reasoningEffort;
  const modelVerbosity = payload.modelVerbosity;
  const serviceTier = payload.serviceTier;
  if (
    !RUN_RUNTIME_PERMISSION_MODES.includes(permissionMode as never) ||
    (prePlanMode !== null &&
      !RUN_RUNTIME_PERMISSION_MODES.includes(prePlanMode as never)) ||
    typeof payload.autoModeActive !== "boolean" ||
    typeof payload.autoModeAvailable !== "boolean" ||
    typeof payload.bypassPermissionsModeAvailable !== "boolean" ||
    (payload.bypassPermissionsWorkspace !== null &&
      typeof payload.bypassPermissionsWorkspace !== "string") ||
    (payload.bypassPermissionsConsentWorkspace !== null &&
      typeof payload.bypassPermissionsConsentWorkspace !== "string") ||
    (payload.profile !== null && typeof payload.profile !== "string") ||
    (reasoningEffort !== null &&
      !RUN_RUNTIME_REASONING_EFFORTS.includes(reasoningEffort as never)) ||
    (modelVerbosity !== null &&
      !RUN_RUNTIME_MODEL_VERBOSITIES.includes(modelVerbosity as never)) ||
    (serviceTier !== null &&
      !RUN_RUNTIME_SERVICE_TIERS.includes(serviceTier as never)) ||
    typeof payload.hooksDisabled !== "boolean"
  ) {
    throw new TypeError("run runtime settings snapshot is invalid");
  }
  return {
    permissionMode:
      permissionMode as RunRuntimeSettingsSnapshot["permissionMode"],
    prePlanMode: prePlanMode as RunRuntimeSettingsSnapshot["prePlanMode"],
    autoModeActive: payload.autoModeActive,
    autoModeAvailable: payload.autoModeAvailable,
    bypassPermissionsModeAvailable: payload.bypassPermissionsModeAvailable,
    bypassPermissionsWorkspace: payload.bypassPermissionsWorkspace as
      string | null,
    bypassPermissionsConsentWorkspace:
      payload.bypassPermissionsConsentWorkspace as string | null,
    model: requireString(payload.model, "model"),
    provider: requireString(payload.provider, "provider"),
    profile: payload.profile as string | null,
    reasoningEffort:
      reasoningEffort as RunRuntimeSettingsSnapshot["reasoningEffort"],
    modelVerbosity:
      modelVerbosity as RunRuntimeSettingsSnapshot["modelVerbosity"],
    serviceTier: serviceTier as RunRuntimeSettingsSnapshot["serviceTier"],
    hooksDisabled: payload.hooksDisabled,
  };
}

function runtimeSettingsSnapshot(
  settings: RunRuntimeSettingsSnapshot,
): RunRuntimeSettingsSnapshot {
  return {
    permissionMode: settings.permissionMode,
    prePlanMode: settings.prePlanMode,
    autoModeActive: settings.autoModeActive,
    autoModeAvailable: settings.autoModeAvailable,
    bypassPermissionsModeAvailable:
      settings.bypassPermissionsModeAvailable,
    bypassPermissionsWorkspace: settings.bypassPermissionsWorkspace,
    bypassPermissionsConsentWorkspace:
      settings.bypassPermissionsConsentWorkspace,
    model: settings.model,
    provider: settings.provider,
    profile: settings.profile,
    reasoningEffort: settings.reasoningEffort,
    modelVerbosity: settings.modelVerbosity,
    serviceTier: settings.serviceTier,
    hooksDisabled: settings.hooksDisabled,
  };
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
