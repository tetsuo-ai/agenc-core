import type { StateSqliteDriver } from "./sqlite-driver.js";

const COMPLETED_AGENT_RUN_STATUSES = ["completed", "stopped"] as const;
const FAILED_AGENT_RUN_STATUSES = ["failed", "error"] as const;
const MS_PER_DAY = 86_400_000;

export interface AgentRunRetentionPolicy {
  readonly completed_days?: number;
  readonly failed_days?: number;
}

export interface AgentRunPruningOptions extends AgentRunRetentionPolicy {
  readonly now?: () => string;
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
