import type { StateSqliteDriver } from "./sqlite-driver.js";

const COMPLETED_AGENT_RUN_STATUSES = ["completed", "stopped"] as const;
const FAILED_AGENT_RUN_STATUSES = ["failed", "error"] as const;
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

function loadCandidates(
  driver: StateSqliteDriver,
  statuses: readonly [string, string],
  cutoff: string,
  category: AgentRunPruneCandidate["category"],
): AgentRunPruneCandidate[] {
  return driver
    .prepareState<[string, string, string], Omit<AgentRunPruneCandidate, "category">>(
      `SELECT id, status, current_session_id
       FROM agent_runs
       WHERE status IN (?, ?)
         AND last_active_at < ?
       ORDER BY last_active_at ASC, id ASC`,
    )
    .all(statuses[0], statuses[1], cutoff)
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
    agentIdFromThreadSource(row.thread_source_json);
  return agentId === undefined
    ? `session:${row.session_id}`
    : `agent:${agentId}`;
}

function agentIdFromThreadSource(raw: string | null): string | undefined {
  if (raw === null) return undefined;
  let source: unknown;
  try {
    source = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (source === "agent" || source === "agent_thread") return undefined;
  if (!isRecord(source)) return undefined;
  const direct = stringField(source, "agentId") ?? stringField(source, "agent_id");
  if (direct !== undefined) return direct;
  const nested = source.source;
  if (!isRecord(nested)) return undefined;
  return (
    stringField(nested, "agentId") ??
    stringField(nested, "agent_id") ??
    stringField(nested, "parentThreadId")
  );
}

function stringField(
  record: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
