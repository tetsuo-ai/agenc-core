/**
 * Tree-scoped run cancellation + spawn admission gate (M3 final slice;
 * design: docs/design/run-cancel-cascade-and-spawn-admission.md).
 *
 * Cancellation is durable-first: `cancelAgentRunTree` walks the spawn tree
 * in ONE transaction and moves every non-terminal descendant (queued AND
 * running) to `cancelled`, closing open edges, without touching
 * `in_flight_tool_calls` (partial evidence is preserved and later
 * classified by the existing recovery category rules). Live interruption
 * is the daemon's second step and reuses `control.interrupt`'s cascade —
 * the frozen contract's single propagation primitive.
 *
 * Admission under a cancel-locked ancestor is refused fail-closed at the
 * durable commit point (`ThreadSpawnEdgeRepository.create`) with
 * {@link SpawnAdmissionBlockedError} — the same shape as the
 * unknown-outcome mutation gate. The refusal maps to the frozen
 * `AdmissionDecision` vocabulary as `deny` with a machine-readable reason.
 *
 * Only `cancelled` and `unknown_outcome` are cancel-locked. `completed`,
 * `errored`, and `stopped` runs stay revivable on purpose: a follow-up
 * message to a completed background agent legitimately flips its run back
 * to `running` via the snapshot writer.
 */

import type { StateSqliteDriver } from "./sqlite-driver.js";

/**
 * Statuses that stick: once a run carries one of these, no write may move
 * it to a different status (same-status metadata patches still land).
 */
export const CANCEL_LOCKED_AGENT_RUN_STATUSES = [
  "cancelled",
  "unknown_outcome",
] as const;

/** Terminal statuses the cascade must never rewrite (history is history). */
const TERMINAL_AGENT_RUN_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
  "unknown_outcome",
  "errored",
  "error",
  "stopped",
]);

/** Hard bound on ancestor walks; matches any realistic spawn depth cap. */
const MAX_ANCESTOR_WALK = 64;

export function isCancelLockedAgentRunStatus(status: string): boolean {
  return (CANCEL_LOCKED_AGENT_RUN_STATUSES as readonly string[]).includes(
    status,
  );
}

export function isTerminalAgentRunStatus(status: string): boolean {
  return TERMINAL_AGENT_RUN_STATUSES.has(status);
}

export type SpawnAdmissionDecision =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      /** Frozen AdmissionDecision vocabulary member. */
      readonly decision: "deny";
      /** Machine-readable refusal reason (no prose-only reasons). */
      readonly reason: "parent_cancel_locked";
      readonly parentRunId: string;
      readonly parentStatus: string;
    };

export class SpawnAdmissionBlockedError extends Error {
  readonly code = "SPAWN_ADMISSION_BLOCKED" as const;
  readonly childThreadId: string;
  readonly parentRunId: string;
  readonly parentStatus: string;

  constructor(
    childThreadId: string,
    parentRunId: string,
    parentStatus: string,
  ) {
    super(
      `spawn admission denied for child ${childThreadId}: ancestor run ` +
        `${parentRunId} is ${parentStatus}; new descendants cannot be ` +
        `admitted under a cancel-locked run (admission decision: deny, ` +
        `reason: parent_cancel_locked)`,
    );
    this.name = "SpawnAdmissionBlockedError";
    this.childThreadId = childThreadId;
    this.parentRunId = parentRunId;
    this.parentStatus = parentStatus;
  }
}

/**
 * Walk the ENTIRE ancestor chain of `parentThreadId` (inclusive) UP
 * `thread_spawn_edges`, regardless of edge status — a closed edge still
 * defines ancestry. Refuse when ANY ancestor with an `agent_runs` row is
 * cancel-locked: cancellation poisons the whole tree for new admissions,
 * so a terminal-but-revivable intermediate (e.g. a `completed` child of a
 * cancelled root) must not shield spawns below it. Allow when no run row
 * up the chain is cancel-locked (nothing durable forbids the admission).
 */
export function checkSpawnAdmissionGate(
  driver: StateSqliteDriver,
  options: { readonly parentThreadId: string },
): SpawnAdmissionDecision {
  const runStatusStmt = driver.prepareState<[string], { status?: string }>(
    "SELECT status FROM agent_runs WHERE id = ?",
  );
  const parentEdgeStmt = driver.prepareState<
    [string],
    { parent_thread_id?: string }
  >("SELECT parent_thread_id FROM thread_spawn_edges WHERE child_thread_id = ?");

  const seen = new Set<string>();
  let current: string | undefined = options.parentThreadId;
  for (let hop = 0; current !== undefined && hop < MAX_ANCESTOR_WALK; hop++) {
    if (seen.has(current)) break;
    seen.add(current);
    const status = runStatusStmt.get(current)?.status;
    if (status !== undefined && isCancelLockedAgentRunStatus(status)) {
      return {
        allowed: false,
        decision: "deny",
        reason: "parent_cancel_locked",
        parentRunId: current,
        parentStatus: status,
      };
    }
    current = parentEdgeStmt.get(current)?.parent_thread_id;
  }
  return { allowed: true };
}

export interface CancelAgentRunTreeReport {
  readonly runId: string;
  /** Root run row does not exist. Nothing was written. */
  readonly missing: boolean;
  /** Root was already cancel-locked/terminal. Nothing was written. */
  readonly alreadyTerminal: boolean;
  readonly rootStatusBefore: string | null;
  /**
   * The full spawn subtree (root included), reported even when
   * `alreadyTerminal` — a retried run.cancel after a crash between the
   * cascade and hold voiding uses this to void the stranded holds.
   */
  readonly subtreeRunIds: readonly string[];
  /** Every run (root included) moved to `cancelled` by this call. */
  readonly cancelledRunIds: readonly string[];
  /** Prior status of each cancelled run (queued-vs-running evidence). */
  readonly priorStatusById: Readonly<Record<string, string>>;
  /** Open edges closed by this call (child thread ids). */
  readonly closedEdgeChildIds: readonly string[];
}

/**
 * Cancel `runId` and its whole spawn subtree in one transaction: every
 * non-terminal run in the subtree becomes `cancelled` (terminal
 * descendants keep their status — cancellation never rewrites history),
 * every open subtree edge is closed, and `in_flight_tool_calls` rows are
 * left untouched so partial evidence survives for review.
 *
 * Idempotent: an already-terminal root reports `alreadyTerminal` and
 * mutates nothing; a missing root reports `missing` and mutates nothing.
 */
export function cancelAgentRunTree(
  driver: StateSqliteDriver,
  options: {
    readonly runId: string;
    readonly reason: string;
    readonly cancelledAt: string;
  },
): CancelAgentRunTreeReport {
  return driver.transaction(() =>
    cancelSubtreeLocked(driver, options.runId, options.reason, options.cancelledAt),
  );
}

function cancelSubtreeLocked(
  driver: StateSqliteDriver,
  runId: string,
  reason: string,
  cancelledAt: string,
): CancelAgentRunTreeReport {
  const runStatusStmt = driver.prepareState<[string], { status?: string }>(
    "SELECT status FROM agent_runs WHERE id = ?",
  );
  const rootStatus = runStatusStmt.get(runId)?.status;
  if (rootStatus === undefined) {
    return {
      runId,
      missing: true,
      alreadyTerminal: false,
      rootStatusBefore: null,
      subtreeRunIds: [],
      cancelledRunIds: [],
      priorStatusById: {},
      closedEdgeChildIds: [],
    };
  }
  const subtree = collectSubtreeThreadIds(driver, runId);
  if (isTerminalAgentRunStatus(rootStatus)) {
    return {
      runId,
      missing: false,
      alreadyTerminal: true,
      rootStatusBefore: rootStatus,
      subtreeRunIds: subtree,
      cancelledRunIds: [],
      priorStatusById: {},
      closedEdgeChildIds: [],
    };
  }

  const cancelledRunIds: string[] = [];
  const priorStatusById: Record<string, string> = {};
  const closedEdgeChildIds: string[] = [];

  const metadataStmt = driver.prepareState<
    [string],
    { metadata_json: string | null }
  >("SELECT metadata_json FROM agent_runs WHERE id = ?");
  // Status predicate is the CAS: the row is only cancelled from the exact
  // non-terminal status read above, inside the same transaction.
  const cancelStmt = driver.prepareState<[string, string, string, string]>(
    `UPDATE agent_runs
     SET status = 'cancelled',
         last_active_at = ?,
         metadata_json = ?
     WHERE id = ? AND status = ?`,
  );
  const closeEdgeStmt = driver.prepareState<[string]>(
    `UPDATE thread_spawn_edges
     SET status = 'closed',
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE child_thread_id = ? AND status = 'open'`,
  );

  for (const threadId of subtree) {
    const status = runStatusStmt.get(threadId)?.status;
    if (status !== undefined && !isTerminalAgentRunStatus(status)) {
      const merged = JSON.stringify({
        ...parseJsonObjectOrEmpty(metadataStmt.get(threadId)?.metadata_json),
        cancelReason: reason,
        cancelledBy: runId,
        cancelledAt,
        // The cascade is one transaction: when the root row says
        // cascadeComplete, the whole subtree was handled — startup repair
        // must never re-police this tree (it would re-kill descendants
        // that were legitimately revived later).
        ...(threadId === runId ? { cascadeComplete: true } : {}),
      });
      const result = cancelStmt.run(cancelledAt, merged, threadId, status);
      if (result.changes > 0) {
        cancelledRunIds.push(threadId);
        priorStatusById[threadId] = status;
      }
    }
    if (threadId !== runId) {
      const closed = closeEdgeStmt.run(threadId);
      if (closed.changes > 0) closedEdgeChildIds.push(threadId);
    }
  }

  return {
    runId,
    missing: false,
    alreadyTerminal: false,
    rootStatusBefore: rootStatus,
    subtreeRunIds: subtree,
    cancelledRunIds,
    priorStatusById,
    closedEdgeChildIds,
  };
}

/** BFS over thread_spawn_edges (any status), root first, cycle-guarded. */
function collectSubtreeThreadIds(
  driver: StateSqliteDriver,
  rootThreadId: string,
): readonly string[] {
  const childrenStmt = driver.prepareState<
    [string],
    { child_thread_id: string }
  >(
    `SELECT child_thread_id FROM thread_spawn_edges
     WHERE parent_thread_id = ?
     ORDER BY child_thread_id ASC`,
  );
  const ordered: string[] = [];
  const seen = new Set<string>();
  const queue: string[] = [rootThreadId];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    if (seen.has(current)) continue;
    seen.add(current);
    ordered.push(current);
    for (const row of childrenStmt.all(current)) {
      if (!seen.has(row.child_thread_id)) queue.push(row.child_thread_id);
    }
  }
  return ordered;
}

export interface RepairCancelledSubtreesReport {
  /** Runs moved to `cancelled` because a `cancelled` ancestor was found. */
  readonly repairedRunIds: readonly string[];
}

/**
 * One-shot repair for cancelled roots whose cascade never ran, executed
 * inside the startup-recovery transaction BEFORE recoverable runs are
 * loaded. `cancelAgentRunTree` is a single transaction and stamps
 * `cascadeComplete` on the root, so cascade-cancelled trees are never
 * touched here. What remains is a root that became `cancelled` via a
 * non-cascade writer (e.g. a relayed status transition): its surviving
 * non-terminal descendants are finished off ONCE, then the root is
 * stamped `cascadeComplete` so later startups never re-police the tree —
 * a descendant legitimately revived afterwards (completed → running via a
 * follow-up message) must not be re-killed forever. Scoped to `cancelled`
 * ancestors only — descendants of completed/errored parents are
 * legitimate survivors.
 */
export function repairCancelledSubtrees(
  driver: StateSqliteDriver,
  options: { readonly now: string },
): RepairCancelledSubtreesReport {
  const cancelledRoots = driver
    .prepareState<[], { id: string; metadata_json: string | null }>(
      `SELECT id, metadata_json FROM agent_runs
       WHERE status = 'cancelled'
       ORDER BY id ASC`,
    )
    .all();
  const repairedRunIds: string[] = [];
  const statusStmt = driver.prepareState<[string], { status?: string }>(
    "SELECT status FROM agent_runs WHERE id = ?",
  );
  const stampStmt = driver.prepareState<[string, string]>(
    "UPDATE agent_runs SET metadata_json = ? WHERE id = ? AND status = 'cancelled'",
  );
  for (const root of cancelledRoots) {
    const metadata = parseJsonObjectOrEmpty(root.metadata_json);
    if (metadata.cascadeComplete === true) continue;
    const subtree = collectSubtreeThreadIds(driver, root.id);
    for (const threadId of subtree) {
      if (threadId === root.id) continue;
      const status = statusStmt.get(threadId)?.status;
      if (status === undefined || isTerminalAgentRunStatus(status)) continue;
      const report = cancelSubtreeLocked(
        driver,
        threadId,
        "recovery_cascade_repair",
        options.now,
      );
      repairedRunIds.push(...report.cancelledRunIds);
    }
    stampStmt.run(
      JSON.stringify({ ...metadata, cascadeComplete: true }),
      root.id,
    );
  }
  return { repairedRunIds };
}

function parseJsonObjectOrEmpty(
  value: string | null | undefined,
): Record<string, unknown> {
  if (value === null || value === undefined || value.trim().length === 0) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
