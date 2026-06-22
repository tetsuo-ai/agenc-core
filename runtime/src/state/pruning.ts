import {
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { isProcessRunning } from "../utils/genericProcessUtils.js";
import { StateThreadRepository } from "./threads.js";
import type { StateSqliteDriver } from "./sqlite-driver.js";
import { sqlPlaceholders } from "./sql.js";
import { agentIdFromThreadSourceJson } from "../thread-store/thread-source.js";

const COMPLETED_AGENT_RUN_STATUSES = ["completed", "stopped"] as const;
const FAILED_AGENT_RUN_STATUSES = ["failed", "error", "errored"] as const;
const MS_PER_DAY = 86_400_000;

export interface AgentRunRetentionPolicy {
  readonly completed_days?: number;
  readonly failed_days?: number;
  readonly snapshot_days?: number;
  readonly snapshot_max_count?: number;
  readonly snapshot_max_bytes?: number;
}

export interface AgentRunPruningOptions extends AgentRunRetentionPolicy {
  readonly now?: () => string;
}

export interface AgentSnapshotPruningReport {
  readonly prunedSnapshots: number;
  readonly prunedSessionIds: readonly string[];
}

export interface AgentRunPruningReport {
  readonly prunedRuns: number;
  readonly prunedCompletedRuns: number;
  readonly prunedFailedRuns: number;
  readonly prunedSnapshots: number;
  readonly prunedToolCalls: number;
  readonly prunedSessionIds: readonly string[];
}

interface AgentRunPruneCandidate {
  readonly id: string;
  readonly status: string;
  readonly current_session_id: string | null;
  readonly category: "completed" | "failed";
}

interface SessionSnapshotPruneCandidate {
  readonly session_id: string;
  readonly snapshot_at: string;
  readonly conversation_json: string;
  readonly tool_state_json: string;
  readonly mcp_connection_state_json: string;
  readonly linked_agent_id: string | null;
  readonly agent_run_id: string | null;
  readonly thread_source_json: string | null;
}

/**
 * Prunes terminal daemon agent-run state according to the configured retention
 * windows. Recoverable runs are deliberately out of scope.
 */
export function pruneTerminalAgentRuns(
  driver: StateSqliteDriver,
  options: AgentRunPruningOptions = {},
): AgentRunPruningReport {
  const now = options.now?.() ?? new Date().toISOString();
  const completedCutoff = cutoffIso(now, options.completed_days);
  const failedCutoff = cutoffIso(now, options.failed_days);
  if (completedCutoff === undefined && failedCutoff === undefined) {
    return emptyReport();
  }

  return driver.transaction(() => {
    const candidates: AgentRunPruneCandidate[] = [];
    if (completedCutoff !== undefined) {
      candidates.push(
        ...loadCandidates(
          driver,
          COMPLETED_AGENT_RUN_STATUSES,
          completedCutoff,
          "completed",
        ),
      );
    }
    if (failedCutoff !== undefined) {
      candidates.push(
        ...loadCandidates(
          driver,
          FAILED_AGENT_RUN_STATUSES,
          failedCutoff,
          "failed",
        ),
      );
    }
    if (candidates.length === 0) return emptyReport();

    const deleteSnapshots = driver.prepareState<[string]>(
      "DELETE FROM session_state_snapshots WHERE session_id = ?",
    );
    const deleteToolCalls = driver.prepareState<[string]>(
      "DELETE FROM in_flight_tool_calls WHERE session_id = ?",
    );
    const deleteSessionAgentLink = driver.prepareState<[string]>(
      "DELETE FROM session_agent_links WHERE session_id = ?",
    );
    const deleteRun = driver.prepareState<[string]>(
      "DELETE FROM agent_runs WHERE id = ?",
    );
    const sessionIds = [
      ...new Set(
        candidates
          .map((candidate) => candidate.current_session_id)
          .filter((sessionId): sessionId is string => sessionId !== null),
      ),
    ];

    let prunedSnapshots = 0;
    let prunedToolCalls = 0;
    for (const sessionId of sessionIds) {
      prunedSnapshots += deleteSnapshots.run(sessionId).changes;
      prunedToolCalls += deleteToolCalls.run(sessionId).changes;
      deleteSessionAgentLink.run(sessionId);
    }

    let prunedRuns = 0;
    for (const candidate of candidates) {
      prunedRuns += deleteRun.run(candidate.id).changes;
    }

    return {
      prunedRuns,
      prunedCompletedRuns: candidates.filter(
        (candidate) => candidate.category === "completed",
      ).length,
      prunedFailedRuns: candidates.filter(
        (candidate) => candidate.category === "failed",
      ).length,
      prunedSnapshots,
      prunedToolCalls,
      prunedSessionIds: sessionIds,
    };
  });
}

export function pruneSessionStateSnapshots(
  driver: StateSqliteDriver,
  options: AgentRunPruningOptions = {},
  sessionId?: string,
): AgentSnapshotPruningReport {
  const snapshotRetention = normalizeSnapshotRetention(options);
  if (
    snapshotRetention.cutoff === undefined &&
    snapshotRetention.maxCount === undefined &&
    snapshotRetention.maxBytes === undefined
  ) {
    return emptySnapshotReport();
  }

  return driver.transaction(() => {
    const rows = loadSnapshotPruneCandidates(driver, sessionId);
    if (rows.length === 0) return emptySnapshotReport();

    const deleteKeys = new Set<string>();
    for (const group of snapshotGroups(rows)) {
      markSnapshotsPastAgeOrCount(
        group,
        deleteKeys,
        snapshotRetention.cutoff,
        snapshotRetention.maxCount,
      );
      markSnapshotsPastByteCap(
        group,
        deleteKeys,
        snapshotRetention.maxBytes,
      );
    }

    if (deleteKeys.size === 0) return emptySnapshotReport();

    const deleteSnapshot = driver.prepareState<[string, string]>(
      `DELETE FROM session_state_snapshots
       WHERE session_id = ?
         AND snapshot_at = ?`,
    );
    const prunedSessionIds = new Set<string>();
    let prunedSnapshots = 0;
    for (const key of deleteKeys) {
      const [deleteSessionId, snapshotAt] = splitSnapshotKey(key);
      prunedSnapshots += deleteSnapshot.run(deleteSessionId, snapshotAt).changes;
      prunedSessionIds.add(deleteSessionId);
    }

    return {
      prunedSnapshots,
      prunedSessionIds: [...prunedSessionIds].sort(),
    };
  });
}

// ─────────────────────────────────────────────────────────────────────
// Rollout/session retention sweep
//
// Rollout JSONL files and their session directories are never rotated, so
// disk grows unbounded. This sweep deletes whole session directories whose
// newest rollout file is older than the configured retention window, and
// (in the same pass) drops the `thread_rollout_items` SQLite mirror rows that
// point at the removed rollout files so the index can't outlive its source.
//
// CONSERVATISM (this deletes user data):
//   - Disabled by default — `retention_days === undefined` is a no-op.
//   - Only sessions whose newest rollout mtime is strictly older than the
//     cutoff are eligible.
//   - The active session is never pruned.
//   - Each session dir is removed atomically (rename-aside, then recursive
//     rm) so a half-deleted directory is never observable.
//   - Bounded per sweep (`maxDeletions`) so a backlog drains gradually on a
//     throttled timer rather than stalling the daemon.
// ─────────────────────────────────────────────────────────────────────

/** Default ceiling on session dirs removed per sweep — drains a backlog over
 *  successive throttled timer ticks instead of in one blocking pass. */
export const DEFAULT_ROLLOUT_PRUNE_MAX_DELETIONS = 50;

export interface RolloutRetentionPolicy {
  /** Retention window in days. Undefined → sweep disabled (default). */
  readonly retention_days?: number;
}

export interface RolloutPruningOptions extends RolloutRetentionPolicy {
  /** Absolute path to `<projectDir>/sessions`. */
  readonly sessionsDir: string;
  /** Session id of the live session — never pruned even if past the cutoff. */
  readonly activeSessionId?: string;
  /** Upper bound on session dirs deleted in a single sweep. */
  readonly maxDeletions?: number;
  readonly now?: () => string;
  readonly onError?: (error: unknown) => void;
}

export interface RolloutPruningReport {
  readonly prunedSessions: number;
  readonly prunedRolloutFiles: number;
  readonly prunedMirrorRows: number;
  readonly prunedSessionIds: readonly string[];
}

/**
 * Delete session directories (rollout JSONL + index + sidecars) older than the
 * retention window, and the `thread_rollout_items` mirror rows that mirror the
 * removed rollout files. See the section header for the conservatism contract.
 */
export function pruneRolloutSessions(
  driver: StateSqliteDriver,
  options: RolloutPruningOptions,
): RolloutPruningReport {
  const cutoffMs = rolloutCutoffMs(
    options.now?.() ?? new Date().toISOString(),
    options.retention_days,
  );
  // Disabled by default: no retention window → never delete anything.
  if (cutoffMs === undefined) return emptyRolloutReport();
  if (!existsSync(options.sessionsDir)) return emptyRolloutReport();

  const onError = options.onError ?? (() => {});
  const maxDeletions = boundedDeletions(options.maxDeletions);

  let entries: string[];
  try {
    entries = readdirSync(options.sessionsDir);
  } catch (error) {
    onError(error);
    return emptyRolloutReport();
  }

  const threads = new StateThreadRepository(driver);
  const prunedSessionIds: string[] = [];
  let prunedRolloutFiles = 0;
  let prunedMirrorRows = 0;

  for (const sessionId of entries) {
    if (prunedSessionIds.length >= maxDeletions) break;
    // Never prune the live session, regardless of mtime.
    if (sessionId === options.activeSessionId) continue;

    const sessionDir = join(options.sessionsDir, sessionId);
    const rollout = describeSessionRollouts(sessionDir);
    // No rollout files → not a session dir we own; leave it untouched.
    if (rollout === undefined) continue;
    // Keep anything touched at/after the cutoff.
    if (rollout.newestMtimeMs >= cutoffMs) continue;
    // Live-writer guard: never prune a session whose rollout lock is held by a
    // live process. The daemon shares this sessions dir with separate foreground
    // processes; the mtime cutoff already spares actively-written sessions, and
    // this additionally protects an idle-but-open session from being removed out
    // from under a live file descriptor. A stale lock (dead holder) does not
    // block pruning, so a crashed session is still reclaimable.
    if (sessionHasLiveRolloutLock(sessionDir)) continue;

    // Drop the SQLite mirror rows first: if the FS removal later fails the
    // mirror is already gone (it can't outlive its source), and a re-index
    // would only re-add rows for files that still exist.
    let removedRows = 0;
    try {
      for (const sourcePath of rollout.rolloutPaths) {
        removedRows += threads.deleteRolloutItemsForSource(sourcePath);
      }
    } catch (error) {
      onError(error);
      continue;
    }

    // Atomic directory removal: rename aside so a crash mid-rm never leaves a
    // partially-deleted session dir under its real name, then recursive rm.
    if (!removeSessionDirAtomically(sessionDir, onError)) continue;

    prunedSessionIds.push(sessionId);
    prunedRolloutFiles += rollout.rolloutPaths.length;
    prunedMirrorRows += removedRows;
  }

  return {
    prunedSessions: prunedSessionIds.length,
    prunedRolloutFiles,
    prunedMirrorRows,
    prunedSessionIds,
  };
}

interface SessionRolloutSummary {
  readonly rolloutPaths: readonly string[];
  readonly newestMtimeMs: number;
}

function describeSessionRollouts(
  sessionDir: string,
): SessionRolloutSummary | undefined {
  let stat;
  try {
    stat = statSync(sessionDir);
  } catch {
    return undefined;
  }
  if (!stat.isDirectory()) return undefined;

  let files: string[];
  try {
    files = readdirSync(sessionDir).filter(
      (f) => f.startsWith("rollout-") && f.endsWith(".jsonl"),
    );
  } catch {
    return undefined;
  }
  if (files.length === 0) return undefined;

  const rolloutPaths: string[] = [];
  let newestMtimeMs = 0;
  for (const file of files) {
    const filePath = join(sessionDir, file);
    try {
      const fileStat = statSync(filePath);
      rolloutPaths.push(filePath);
      if (fileStat.mtimeMs > newestMtimeMs) newestMtimeMs = fileStat.mtimeMs;
    } catch {
      // Unreadable rollout — skip it; siblings still gate the decision.
    }
  }
  if (rolloutPaths.length === 0) return undefined;
  return { rolloutPaths, newestMtimeMs };
}

/**
 * True when the session directory holds a rollout lock (`rollout-*.jsonl.lock`)
 * owned by a process that is still alive. The lock file is JSON `{ pid, ... }`
 * (with a legacy bare-PID fallback) written by SessionLock in session-store.ts.
 * Mirrors that reader's liveness check: a stale lock (dead holder) is ignored so
 * a crashed session stays reclaimable; only a live holder spares the session.
 */
function sessionHasLiveRolloutLock(sessionDir: string): boolean {
  let lockFiles: string[];
  try {
    lockFiles = readdirSync(sessionDir).filter((f) =>
      f.endsWith(".jsonl.lock"),
    );
  } catch {
    return false;
  }
  for (const lockFile of lockFiles) {
    let raw: string;
    try {
      raw = readFileSync(join(sessionDir, lockFile), "utf8").trim();
    } catch {
      continue;
    }
    if (raw.length === 0) continue;
    const pid = parseLockHolderPid(raw);
    if (pid !== undefined && isProcessRunning(pid)) return true;
  }
  return false;
}

function parseLockHolderPid(raw: string): number | undefined {
  try {
    const parsed = JSON.parse(raw) as { pid?: unknown };
    if (
      typeof parsed.pid === "number" &&
      Number.isFinite(parsed.pid) &&
      parsed.pid > 0
    ) {
      return parsed.pid;
    }
    return undefined;
  } catch {
    // Legacy lockfile format: a bare PID on a single line.
    const pid = Number.parseInt(raw, 10);
    if (Number.isFinite(pid) && pid > 0) return pid;
    return undefined;
  }
}

function removeSessionDirAtomically(
  sessionDir: string,
  onError: (error: unknown) => void,
): boolean {
  const aside = `${sessionDir}.pruning-${process.pid}-${Date.now().toString(36)}`;
  try {
    renameSync(sessionDir, aside);
  } catch (error) {
    // EEXIST/ENOENT/EACCES — leave the dir in place; the next sweep retries.
    onError(error);
    return false;
  }
  try {
    rmSync(aside, { recursive: true, force: true });
  } catch (error) {
    // The live name is already gone (rename succeeded), so retention held;
    // only the renamed husk lingers. Report and move on.
    onError(error);
  }
  return true;
}

function rolloutCutoffMs(
  now: string,
  days: number | undefined,
): number | undefined {
  if (days === undefined) return undefined;
  // `days <= 0` means DISABLED, not "delete everything older than now". The
  // config validator accepts 0 (it shares the non-negative-days rule), and a
  // user setting 0 means "off", so a zero/negative/non-finite window must never
  // resolve to cutoff=now (which would make every non-active session eligible
  // for deletion). This intentionally differs from the sibling cutoffIso(),
  // whose days===0 semantics are load-bearing for the other pruning paths.
  if (!Number.isFinite(days) || days <= 0) return undefined;
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) return undefined;
  return nowMs - days * MS_PER_DAY;
}

function boundedDeletions(maxDeletions: number | undefined): number {
  if (
    maxDeletions === undefined ||
    !Number.isFinite(maxDeletions) ||
    maxDeletions < 1
  ) {
    return DEFAULT_ROLLOUT_PRUNE_MAX_DELETIONS;
  }
  return Math.floor(maxDeletions);
}

function emptyRolloutReport(): RolloutPruningReport {
  return {
    prunedSessions: 0,
    prunedRolloutFiles: 0,
    prunedMirrorRows: 0,
    prunedSessionIds: [],
  };
}

function loadCandidates(
  driver: StateSqliteDriver,
  statuses: readonly string[],
  cutoff: string,
  category: AgentRunPruneCandidate["category"],
): AgentRunPruneCandidate[] {
  return driver
    .prepareState<unknown[], Omit<AgentRunPruneCandidate, "category">>(
      `SELECT id, status, current_session_id
       FROM agent_runs
       WHERE status IN (${sqlPlaceholders(statuses.length)})
         AND last_active_at < ?
       ORDER BY last_active_at ASC, id ASC`,
    )
    .all(...statuses, cutoff)
    .map((row) => ({ ...row, category }));
}

function loadSnapshotPruneCandidates(
  driver: StateSqliteDriver,
  sessionId: string | undefined,
): SessionSnapshotPruneCandidate[] {
  const rows = driver
    .prepareState<[], SessionSnapshotPruneCandidate>(
      `SELECT
         snapshots.session_id,
         snapshots.snapshot_at,
         snapshots.conversation_json,
         snapshots.tool_state_json,
         snapshots.mcp_connection_state_json,
         session_agent_links.agent_id AS linked_agent_id,
         agent_runs.id AS agent_run_id,
         threads.source_json AS thread_source_json
       FROM session_state_snapshots AS snapshots
       LEFT JOIN session_agent_links
         ON session_agent_links.session_id = snapshots.session_id
       LEFT JOIN agent_runs
         ON agent_runs.current_session_id = snapshots.session_id
       LEFT JOIN threads
         ON threads.thread_id = snapshots.session_id`,
    )
    .all();
  const sortedRows = [...rows].sort(compareSnapshotPruneCandidates);
  if (sessionId === undefined) return sortedRows;
  const ownerKey = snapshotOwnerKey(
    sortedRows.find((row) => row.session_id === sessionId) ?? {
      session_id: sessionId,
      snapshot_at: "",
      conversation_json: "",
      tool_state_json: "",
      mcp_connection_state_json: "",
      linked_agent_id: null,
      agent_run_id: null,
      thread_source_json: null,
    },
  );
  return sortedRows.filter((row) => snapshotOwnerKey(row) === ownerKey);
}

function snapshotGroups(
  rows: readonly SessionSnapshotPruneCandidate[],
): SessionSnapshotPruneCandidate[][] {
  const groups: SessionSnapshotPruneCandidate[][] = [];
  let current: SessionSnapshotPruneCandidate[] = [];
  for (const row of rows) {
    if (
      current[0] !== undefined &&
      snapshotOwnerKey(current[0]) !== snapshotOwnerKey(row)
    ) {
      groups.push(current);
      current = [];
    }
    current.push(row);
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

function markSnapshotsPastAgeOrCount(
  group: readonly SessionSnapshotPruneCandidate[],
  deleteKeys: Set<string>,
  cutoff: string | undefined,
  maxCount: number | undefined,
): void {
  const latestKeys = latestSnapshotKeysForRecovery(group);
  for (const row of group) {
    if (row === undefined) continue;
    const key = snapshotKey(row);
    if (latestKeys.has(key)) continue;
    if (cutoff !== undefined && row.snapshot_at < cutoff) {
      deleteKeys.add(key);
    }
  }
  if (maxCount === undefined) return;

  let retainedCount = latestKeys.size;
  for (const row of group) {
    const key = snapshotKey(row);
    if (latestKeys.has(key) || deleteKeys.has(key)) continue;
    if (retainedCount >= maxCount) {
      deleteKeys.add(key);
      continue;
    }
    retainedCount += 1;
  }
}

function markSnapshotsPastByteCap(
  group: readonly SessionSnapshotPruneCandidate[],
  deleteKeys: Set<string>,
  maxBytes: number | undefined,
): void {
  if (maxBytes === undefined) return;

  const latestKeys = latestSnapshotKeysForRecovery(group);
  let retainedBytes = group.reduce(
    (total, row) =>
      latestKeys.has(snapshotKey(row)) ? total + snapshotBytes(row) : total,
    0,
  );
  for (const row of group) {
    const key = snapshotKey(row);
    if (latestKeys.has(key) || deleteKeys.has(key)) continue;
    if (retainedBytes + snapshotBytes(row) > maxBytes) {
      deleteKeys.add(key);
      continue;
    }
    retainedBytes += snapshotBytes(row);
  }
}

function latestSnapshotKeysForRecovery(
  group: readonly SessionSnapshotPruneCandidate[],
): Set<string> {
  const latestKeys = new Set<string>();
  const latest = group[0];
  if (latest !== undefined) latestKeys.add(snapshotKey(latest));
  const currentRunSessions = new Set<string>();
  for (const row of group) {
    if (row.agent_run_id !== null) currentRunSessions.add(row.session_id);
  }
  for (const row of group) {
    if (!currentRunSessions.has(row.session_id)) continue;
    latestKeys.add(snapshotKey(row));
    currentRunSessions.delete(row.session_id);
    if (currentRunSessions.size === 0) break;
  }
  return latestKeys;
}

function snapshotBytes(row: SessionSnapshotPruneCandidate): number {
  return (
    Buffer.byteLength(row.conversation_json, "utf8") +
    Buffer.byteLength(row.tool_state_json, "utf8") +
    Buffer.byteLength(row.mcp_connection_state_json, "utf8")
  );
}

function normalizeSnapshotRetention(options: AgentRunPruningOptions): {
  readonly cutoff?: string;
  readonly maxCount?: number;
  readonly maxBytes?: number;
} {
  const cutoff =
    options.snapshot_days === undefined
      ? undefined
      : cutoffIso(
          options.now?.() ?? new Date().toISOString(),
          options.snapshot_days,
        );
  return {
    ...(cutoff !== undefined ? { cutoff } : {}),
    ...optionalNumber("maxCount", positiveInteger(options.snapshot_max_count)),
    ...optionalNumber("maxBytes", positiveInteger(options.snapshot_max_bytes)),
  };
}

function optionalNumber<K extends string>(
  key: K,
  value: number | undefined,
): Record<K, number> | {} {
  return value === undefined ? {} : ({ [key]: value } as Record<K, number>);
}

function positiveInteger(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value < 1) return undefined;
  return Math.floor(value);
}

function compareSnapshotPruneCandidates(
  left: SessionSnapshotPruneCandidate,
  right: SessionSnapshotPruneCandidate,
): number {
  return (
    snapshotOwnerKey(left).localeCompare(snapshotOwnerKey(right)) ||
    right.snapshot_at.localeCompare(left.snapshot_at) ||
    left.session_id.localeCompare(right.session_id)
  );
}

function snapshotOwnerKey(row: SessionSnapshotPruneCandidate): string {
  const agentId =
    row.linked_agent_id ??
    row.agent_run_id ??
    agentIdFromThreadSourceJson(row.thread_source_json);
  return agentId === undefined
    ? `session:${row.session_id}`
    : `agent:${agentId}`;
}

function snapshotKey(
  row: Pick<SessionSnapshotPruneCandidate, "session_id" | "snapshot_at">,
): string {
  return `${row.session_id}\0${row.snapshot_at}`;
}

function splitSnapshotKey(key: string): readonly [string, string] {
  const [sessionId, snapshotAt] = key.split("\0", 2);
  if (sessionId === undefined || snapshotAt === undefined) {
    throw new Error("invalid snapshot pruning key");
  }
  return [sessionId, snapshotAt];
}

function cutoffIso(now: string, days: number | undefined): string | undefined {
  if (days === undefined) return undefined;
  if (!Number.isFinite(days) || days < 0) return undefined;
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) return undefined;
  return new Date(nowMs - days * MS_PER_DAY).toISOString();
}

function emptyReport(): AgentRunPruningReport {
  return {
    prunedRuns: 0,
    prunedCompletedRuns: 0,
    prunedFailedRuns: 0,
    prunedSnapshots: 0,
    prunedToolCalls: 0,
    prunedSessionIds: [],
  };
}

function emptySnapshotReport(): AgentSnapshotPruningReport {
  return {
    prunedSnapshots: 0,
    prunedSessionIds: [],
  };
}
