import type { StrategicExecutionSummary, StrategicGoalRecord, StrategicWorkingNote } from "./goal-store.js";

export const ACTIVE_GOAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const TERMINAL_GOAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const EXECUTION_SUMMARY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const WORKING_NOTE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

const ACTIVE_STATUSES: ReadonlySet<StrategicGoalRecord["status"]> = new Set([
  "proposed",
  "pending",
  "executing",
]);

const TERMINAL_STATUSES: ReadonlySet<StrategicGoalRecord["status"]> = new Set([
  "completed",
  "failed",
  "cancelled",
  "rejected",
  "expired",
  "superseded",
]);

export function isActiveGoalStatus(
  status: StrategicGoalRecord["status"],
): boolean {
  return ACTIVE_STATUSES.has(status);
}

export function isTerminalGoalStatus(
  status: StrategicGoalRecord["status"],
): boolean {
  return TERMINAL_STATUSES.has(status);
}

function calculateGoalFreshnessScore(params: {
  readonly status: StrategicGoalRecord["status"];
  readonly now: number;
  readonly lastObservedAt: number;
  readonly expiresAt?: number;
}): number {
  if (isTerminalGoalStatus(params.status)) {
    return 0;
  }
  const ttlMs = Math.max(
    1,
    (params.expiresAt ?? params.lastObservedAt + ACTIVE_GOAL_TTL_MS) -
      params.lastObservedAt,
  );
  const ageMs = Math.max(0, params.now - params.lastObservedAt);
  return Math.max(0, Math.min(1, 1 - ageMs / ttlMs));
}

export function applyGoalHygiene(
  goals: readonly StrategicGoalRecord[],
  now: number,
): StrategicGoalRecord[] {
  const next: StrategicGoalRecord[] = [];
  for (const goal of goals) {
    if (
      goal.status === "superseded" &&
      goal.updatedAt < now - TERMINAL_GOAL_RETENTION_MS
    ) {
      continue;
    }
    if (
      isTerminalGoalStatus(goal.status) &&
      goal.updatedAt < now - TERMINAL_GOAL_RETENTION_MS
    ) {
      continue;
    }
    if (
      isActiveGoalStatus(goal.status) &&
      goal.freshness.expiresAt <= now
    ) {
      next.push({
        ...goal,
        status: "expired",
        updatedAt: now,
        freshness: {
          ...goal.freshness,
          score: 0,
        },
      });
      continue;
    }
    next.push({
      ...goal,
      freshness: {
        ...goal.freshness,
        score: calculateGoalFreshnessScore({
          status: goal.status,
          now,
          lastObservedAt: goal.freshness.lastObservedAt,
          expiresAt: goal.freshness.expiresAt,
        }),
      },
    });
  }
  return next.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function applyWorkingNoteHygiene(
  notes: readonly StrategicWorkingNote[],
  now: number,
): StrategicWorkingNote[] {
  return notes
    .filter((note) => note.updatedAt >= now - WORKING_NOTE_RETENTION_MS)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function applyExecutionSummaryHygiene(
  summaries: readonly StrategicExecutionSummary[],
  now: number,
): StrategicExecutionSummary[] {
  return summaries
    .filter((summary) => summary.createdAt >= now - EXECUTION_SUMMARY_RETENTION_MS)
    .sort((a, b) => b.createdAt - a.createdAt);
}
