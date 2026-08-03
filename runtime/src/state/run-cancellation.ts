/**
 * Tree-scoped run cancellation + spawn admission gate (M3 final slice;
 * design: docs/design/execution-admission-kernel.md).
 *
 * `cancelAgentRunTree` materializes the spawn tree with one bounded recursive
 * SQL set in ONE transaction and moves every non-terminal descendant (queued
 * AND running) to `cancelled`, closing open edges, without touching
 * `in_flight_tool_calls` (partial evidence is preserved and later
 * classified by the existing recovery category rules). Live daemon runs seal
 * their canonical rollout terminal before this rebuildable projection;
 * inactive runs use the transaction as their honest offline authority.
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

import { randomUUID } from "node:crypto";

import type { ExecutionAdmissionRepository } from "./execution-admission.js";
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

export const MAX_CANCELLATION_RUNS = 100_000;
export const MAX_CANCELLATION_EDGES = 1_000_000;
export const MAX_CANCELLATION_REPAIR_ROOTS = 4_096;
export const MAX_ANCESTOR_WALK = 64;

const CANCELLATION_SET_TABLE = "agenc_cancellation_operation_runs";
const CANCELLATION_GRAPH_SPAWN = "spawn";
const CANCELLATION_GRAPH_ADMISSION = "spawn_admission";

export type CancellationGraphKind =
  typeof CANCELLATION_GRAPH_SPAWN | typeof CANCELLATION_GRAPH_ADMISSION;

export interface CancellationOperation {
  readonly id: string;
}

export class CancellationSetLimitError extends Error {
  readonly code = "CANCELLATION_SET_LIMIT" as const;

  constructor(
    readonly graphKind: CancellationGraphKind,
    readonly dimension: "runs" | "edges",
    readonly observed: number,
    readonly limit: number,
  ) {
    super(
      `cancellation ${graphKind} ${dimension} exceed safety bound: ` +
        `${observed} > ${limit}`,
    );
    this.name = "CancellationSetLimitError";
  }
}

export class CancellationRepairDeferredError extends Error {
  readonly code = "CANCELLATION_REPAIR_DEFERRED" as const;

  constructor(
    readonly reason:
      | "repair_root_limit"
      | "cancellation_run_limit"
      | "cancellation_edge_limit",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CancellationRepairDeferredError";
  }
}

export function isCancelLockedAgentRunStatus(status: string): boolean {
  return (CANCEL_LOCKED_AGENT_RUN_STATUSES as readonly string[]).includes(
    status,
  );
}

export function isTerminalAgentRunStatus(status: string): boolean {
  return TERMINAL_AGENT_RUN_STATUSES.has(status);
}

export type CancellationAncestorDenialReason =
  | "parent_cancel_locked"
  | "ancestor_parent_ambiguous"
  | "ancestor_cycle"
  | "ancestor_depth_exceeded"
  | "ancestor_unresolved";

export type SpawnAdmissionDecision =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      /** Frozen AdmissionDecision vocabulary member. */
      readonly decision: "deny";
      /** Machine-readable refusal reason (no prose-only reasons). */
      readonly reason: CancellationAncestorDenialReason;
      readonly parentRunId: string;
      readonly parentStatus: string;
    };

export class SpawnAdmissionBlockedError extends Error {
  readonly code = "SPAWN_ADMISSION_BLOCKED" as const;
  readonly childThreadId: string;
  readonly parentRunId: string;
  readonly parentStatus: string;
  readonly reason: CancellationAncestorDenialReason;

  constructor(
    childThreadId: string,
    parentRunId: string,
    parentStatus: string,
    reason: CancellationAncestorDenialReason = "parent_cancel_locked",
  ) {
    super(
      `spawn admission denied for child ${childThreadId}: ancestor run ` +
        `${parentRunId} is ${parentStatus}; ancestry was not safely proved ` +
        `(admission decision: deny, reason: ${reason})`,
    );
    this.name = "SpawnAdmissionBlockedError";
    this.childThreadId = childThreadId;
    this.parentRunId = parentRunId;
    this.parentStatus = parentStatus;
    this.reason = reason;
  }
}

/**
 * Prove the bounded ancestor chain of `parentThreadId` (inclusive) UP
 * `thread_spawn_edges`, regardless of edge status — a closed edge still
 * defines ancestry. A root is proved by an agent-run row, an admission row,
 * or its canonical rollout lifecycle epoch. Refuse when ANY ancestor is
 * cancel-locked: cancellation poisons the whole tree for new admissions, so
 * a terminal-but-revivable intermediate (e.g. a `completed` child of a
 * cancelled root) must not shield spawns below it.
 */
export function checkSpawnAdmissionGate(
  driver: StateSqliteDriver,
  options: { readonly parentThreadId: string },
): SpawnAdmissionDecision {
  const denial = inspectCancellationAncestors(driver, {
    startRunId: options.parentThreadId,
    graphKind: CANCELLATION_GRAPH_SPAWN,
    allowUnpersistedStartRoot: false,
  });
  return denial === undefined
    ? { allowed: true }
    : { allowed: false, decision: "deny", ...denial };
}

interface AncestorInspectionRow {
  readonly run_id: string;
  readonly status: string | null;
  readonly cancelled: number;
  readonly durable_identity: number;
  readonly parents_json: string;
}

export interface CancellationAncestorDenial {
  readonly reason: CancellationAncestorDenialReason;
  readonly parentRunId: string;
  readonly parentStatus: string;
}

/**
 * Prove a bounded ancestor set with one indexed SQL walk. JavaScript only
 * classifies the at-most-65 returned identities; it never performs graph I/O.
 */
export function inspectCancellationAncestors(
  driver: StateSqliteDriver,
  options: {
    readonly startRunId: string;
    readonly graphKind: CancellationGraphKind;
    readonly explicitParentRunId?: string;
    readonly allowUnpersistedStartRoot: boolean;
  },
): CancellationAncestorDenial | undefined {
  const includeAdmission = options.graphKind === CANCELLATION_GRAPH_ADMISSION;
  const parentEdgesSql = includeAdmission
    ? `SELECT child_thread_id AS child_run_id,
              parent_thread_id AS parent_run_id
       FROM thread_spawn_edges
       UNION
       SELECT admission_run_id, admission_parent_run_id
       FROM agent_jobs
       WHERE admission_run_id IS NOT NULL
         AND admission_parent_run_id IS NOT NULL
       UNION
       SELECT ?, ? WHERE ? IS NOT NULL`
    : `SELECT child_thread_id AS child_run_id,
              parent_thread_id AS parent_run_id
       FROM thread_spawn_edges`;
  const params: unknown[] = [];
  if (includeAdmission) {
    params.push(
      options.startRunId,
      options.explicitParentRunId ?? null,
      options.explicitParentRunId ?? null,
    );
  }
  params.push(options.startRunId, MAX_ANCESTOR_WALK + 1);
  const rows = driver
    .prepareState<unknown[], AncestorInspectionRow>(
      `WITH RECURSIVE
         parent_edges(child_run_id, parent_run_id) AS (
           ${parentEdgesSql}
         ),
         ancestors(run_id) AS (
           VALUES (?)
           UNION
           SELECT edge.parent_run_id
           FROM parent_edges AS edge
           JOIN ancestors AS child ON child.run_id = edge.child_run_id
           LIMIT ?
         )
       SELECT ancestor.run_id,
              run.status,
              EXISTS (
                SELECT 1 FROM execution_admission_cancellations AS locked
                WHERE locked.run_id = ancestor.run_id
              ) AS cancelled,
              (
                run.id IS NOT NULL OR EXISTS (
                  SELECT 1 FROM agent_jobs AS identity_job
                  WHERE identity_job.admission_run_id = ancestor.run_id
                  LIMIT 1
                ) OR EXISTS (
                  SELECT 1 FROM run_lifecycle_epochs AS lifecycle
                  WHERE lifecycle.run_id = ancestor.run_id
                  LIMIT 1
                )
              ) AS durable_identity,
              COALESCE(
                json_group_array(edge.parent_run_id)
                  FILTER (WHERE edge.parent_run_id IS NOT NULL),
                '[]'
              ) AS parents_json
       FROM ancestors AS ancestor
       LEFT JOIN agent_runs AS run ON run.id = ancestor.run_id
       LEFT JOIN parent_edges AS edge ON edge.child_run_id = ancestor.run_id
       GROUP BY ancestor.run_id
       ORDER BY ancestor.run_id COLLATE BINARY`,
    )
    .all(...params);
  const ancestorIds = new Set(rows.map((row) => row.run_id));
  const parentsById = new Map<string, readonly string[]>();
  for (const row of rows) {
    const parents = parseAncestorParents(row.parents_json);
    parentsById.set(row.run_id, parents);
    if (
      row.cancelled !== 0 ||
      (row.status !== null &&
        (isCancelLockedAgentRunStatus(row.status) ||
          row.status === "provider_overrun"))
    ) {
      return {
        reason: "parent_cancel_locked",
        parentRunId: row.run_id,
        parentStatus: row.status ?? "cancelled",
      };
    }
  }
  for (const row of rows) {
    const parents = parentsById.get(row.run_id) ?? [];
    if (parents.length > 1) {
      return {
        reason: "ancestor_parent_ambiguous",
        parentRunId: row.run_id,
        parentStatus: "unproved",
      };
    }
  }
  if (ancestorGraphHasCycle(parentsById)) {
    return {
      reason: "ancestor_cycle",
      parentRunId: options.startRunId,
      parentStatus: "unproved",
    };
  }
  for (const row of rows) {
    const outsideParent = (parentsById.get(row.run_id) ?? []).find(
      (parentRunId) => !ancestorIds.has(parentRunId),
    );
    if (outsideParent !== undefined) {
      return {
        reason: "ancestor_depth_exceeded",
        parentRunId: outsideParent,
        parentStatus: "unproved",
      };
    }
  }
  for (const row of rows) {
    const parents = parentsById.get(row.run_id) ?? [];
    const unpersistedDeclaredRoot =
      (row.run_id === options.startRunId &&
        options.explicitParentRunId === undefined &&
        options.allowUnpersistedStartRoot) ||
      row.run_id === options.explicitParentRunId;
    if (
      parents.length === 0 &&
      row.durable_identity === 0 &&
      !unpersistedDeclaredRoot
    ) {
      return {
        reason: "ancestor_unresolved",
        parentRunId: row.run_id,
        parentStatus: "unproved",
      };
    }
  }
  return undefined;
}

export function withCancellationOperation<T>(
  driver: StateSqliteDriver,
  operation: (context: CancellationOperation) => T,
): T {
  ensureCancellationSetTable(driver);
  const context = Object.freeze({ id: randomUUID() });
  try {
    return operation(context);
  } finally {
    driver
      .prepareState<[string]>(
        `DELETE FROM temp.${CANCELLATION_SET_TABLE} WHERE operation_id = ?`,
      )
      .run(context.id);
  }
}

export function materializeCancellationSet(
  driver: StateSqliteDriver,
  operation: CancellationOperation,
  graphKind: CancellationGraphKind,
  rootRunIds: readonly string[],
): { readonly runCount: number; readonly edgeCount: number } {
  const roots = [...new Set(rootRunIds)].sort(binaryCompare);
  if (roots.length === 0) return { runCount: 0, edgeCount: 0 };
  const graphSql =
    graphKind === CANCELLATION_GRAPH_SPAWN
      ? `SELECT edge.child_thread_id
         FROM thread_spawn_edges AS edge
         JOIN reachable AS parent ON parent.run_id = edge.parent_thread_id`
      : `SELECT edge.child_thread_id
         FROM thread_spawn_edges AS edge
         JOIN reachable AS parent ON parent.run_id = edge.parent_thread_id
         UNION
         SELECT job.admission_run_id
         FROM agent_jobs AS job
         JOIN reachable AS parent
           ON parent.run_id = job.admission_parent_run_id
         WHERE job.admission_run_id IS NOT NULL`;
  const rootValues = roots.map(() => "(?)").join(", ");
  driver
    .prepareState<[string, CancellationGraphKind]>(
      `DELETE FROM temp.${CANCELLATION_SET_TABLE}
       WHERE operation_id = ? AND graph_kind = ?`,
    )
    .run(operation.id, graphKind);
  driver
    .prepareState<unknown[]>(
      `WITH RECURSIVE
         roots(run_id) AS (VALUES ${rootValues}),
         reachable(run_id) AS (
           SELECT run_id FROM roots
           UNION
           ${graphSql}
           LIMIT ?
         )
       INSERT INTO temp.${CANCELLATION_SET_TABLE} (
         operation_id, graph_kind, run_id, is_root
       )
       SELECT ?, ?, reachable.run_id,
              EXISTS (SELECT 1 FROM roots WHERE roots.run_id = reachable.run_id)
       FROM reachable`,
    )
    .run(...roots, MAX_CANCELLATION_RUNS + 1, operation.id, graphKind);
  const runCount = materializedCancellationCount(driver, operation, graphKind);
  if (runCount > MAX_CANCELLATION_RUNS) {
    throw new CancellationSetLimitError(
      graphKind,
      "runs",
      runCount,
      MAX_CANCELLATION_RUNS,
    );
  }
  const edgeCount = countMaterializedCancellationEdges(
    driver,
    operation,
    graphKind,
  );
  if (edgeCount > MAX_CANCELLATION_EDGES) {
    throw new CancellationSetLimitError(
      graphKind,
      "edges",
      edgeCount,
      MAX_CANCELLATION_EDGES,
    );
  }
  return { runCount, edgeCount };
}

export function materializedCancellationRunIds(
  driver: StateSqliteDriver,
  operation: CancellationOperation,
  graphKind: CancellationGraphKind,
): readonly string[] {
  return driver
    .prepareState<[string, CancellationGraphKind], { readonly run_id: string }>(
      `SELECT run_id FROM temp.${CANCELLATION_SET_TABLE}
       WHERE operation_id = ? AND graph_kind = ?
       ORDER BY is_root DESC, run_id COLLATE BINARY`,
    )
    .all(operation.id, graphKind)
    .map((row) => row.run_id);
}

export function cancellationSetMembershipSql(runIdExpression: string): string {
  if (!/^[a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)?$/u.test(runIdExpression)) {
    throw new TypeError("cancellation run-id SQL expression is invalid");
  }
  return `EXISTS (
    SELECT 1 FROM temp.${CANCELLATION_SET_TABLE} AS cancellation_set
    WHERE cancellation_set.operation_id = ?
      AND cancellation_set.graph_kind = ?
      AND cancellation_set.run_id = ${runIdExpression}
  )`;
}

export const SPAWN_CANCELLATION_GRAPH = CANCELLATION_GRAPH_SPAWN;
export const ADMISSION_CANCELLATION_GRAPH = CANCELLATION_GRAPH_ADMISSION;

export interface CancelAgentRunTreeReport {
  readonly runId: string;
  /** No durable agent-run or admission state exists. Nothing was written. */
  readonly missing: boolean;
  /** The public run exists only through execution-admission evidence. */
  readonly admissionOnly?: boolean;
  /**
   * Root was already cancel-locked/terminal when this call began. An older
   * incomplete cancellation may still repair non-terminal descendants.
   */
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
  /** Admission reservations voided atomically with this run cascade. */
  readonly admissionVoidedReservations?: number;
  /** Dispatched reservations conservatively held atomically with the cascade. */
  readonly admissionHeldUnknownReservations?: number;
  /** Set cardinality captured before mutation for cancellation telemetry. */
  readonly cancellationNodeCount?: number;
  /** Reachable graph-edge count captured from the same materialized set. */
  readonly cancellationEdgeCount?: number;
}

/**
 * Cancel `runId` and its whole spawn subtree in one transaction: every
 * non-terminal run in the subtree becomes `cancelled` (terminal
 * descendants keep their status — cancellation never rewrites history),
 * every open subtree edge is closed, and `in_flight_tool_calls` rows are
 * left untouched so partial evidence survives for review.
 *
 * Idempotent: a fully-cascaded terminal root reports `alreadyTerminal` and
 * mutates nothing. A cancelled root missing the `cascadeComplete` marker is
 * repaired once (covering canonical-first cancellation and legacy crash
 * gaps). A missing root reports `missing` and mutates nothing.
 */
export function cancelAgentRunTree(
  driver: StateSqliteDriver,
  options: {
    readonly runId: string;
    readonly reason: string;
    readonly cancelledAt: string;
  },
): CancelAgentRunTreeReport {
  return withCancellationOperation(driver, (operation) =>
    driver.transactionImmediate(() =>
      cancelAgentRunTreeInOperation(driver, operation, options),
    ),
  );
}

/** Atomic-composition seam; the caller owns the surrounding operation/txn. */
export function cancelAgentRunTreeInOperation(
  driver: StateSqliteDriver,
  operation: CancellationOperation,
  options: {
    readonly runId: string;
    readonly reason: string;
    readonly cancelledAt: string;
  },
): CancelAgentRunTreeReport {
  const { runId, reason, cancelledAt } = options;
  const root = driver
    .prepareState<
      [string],
      { readonly status: string; readonly metadata_json: string | null }
    >("SELECT status, metadata_json FROM agent_runs WHERE id = ?")
    .get(runId);
  const rootStatus = root?.status;
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
      cancellationNodeCount: 0,
      cancellationEdgeCount: 0,
    };
  }
  const materialized = materializeCancellationSet(
    driver,
    operation,
    CANCELLATION_GRAPH_SPAWN,
    [runId],
  );
  const subtree = materializedCancellationRunIds(
    driver,
    operation,
    CANCELLATION_GRAPH_SPAWN,
  );
  const rootMetadata = parseJsonObjectOrEmpty(root!.metadata_json);
  const repairIncompleteCancelledRoot =
    rootStatus === "cancelled" && rootMetadata.cascadeComplete !== true;
  if (isTerminalAgentRunStatus(rootStatus) && !repairIncompleteCancelledRoot) {
    return {
      runId,
      missing: false,
      alreadyTerminal: true,
      rootStatusBefore: rootStatus,
      subtreeRunIds: subtree,
      cancelledRunIds: [],
      priorStatusById: {},
      closedEdgeChildIds: [],
      cancellationNodeCount: materialized.runCount,
      cancellationEdgeCount: materialized.edgeCount,
    };
  }
  const preState = readCancellationRunPreState(
    driver,
    operation,
    CANCELLATION_GRAPH_SPAWN,
  );
  const changedIds = new Set(
    driver
      .prepareState<
        [string, string, string, string, string, CancellationGraphKind],
        { readonly id: string }
      >(
        `UPDATE agent_runs
         SET status = 'cancelled',
             last_active_at = ?,
             metadata_json = json_set(
               CASE
                 WHEN metadata_json IS NOT NULL
                  AND json_valid(metadata_json)
                  AND json_type(metadata_json) = 'object'
                 THEN metadata_json ELSE '{}'
               END,
               '$.cancelReason', ?,
               '$.cancelledBy', ?,
               '$.cancelledAt', ?
             )
         WHERE status NOT IN (
                 'completed', 'failed', 'cancelled', 'unknown_outcome',
                 'errored', 'error', 'stopped'
               )
           AND EXISTS (
             SELECT 1 FROM temp.${CANCELLATION_SET_TABLE} AS cancellation_set
             WHERE cancellation_set.operation_id = ?
               AND cancellation_set.graph_kind = ?
               AND cancellation_set.run_id = agent_runs.id
           )
         RETURNING id`,
      )
      .all(
        cancelledAt,
        reason,
        runId,
        cancelledAt,
        operation.id,
        CANCELLATION_GRAPH_SPAWN,
      )
      .map((row) => row.id),
  );
  const closedIds = new Set(
    driver
      .prepareState<
        [string, string, string, CancellationGraphKind],
        { readonly child_thread_id: string }
      >(
        `UPDATE thread_spawn_edges
         SET status = 'closed', updated_at = ?
         WHERE child_thread_id <> ?
           AND status = 'open'
           AND EXISTS (
             SELECT 1 FROM temp.${CANCELLATION_SET_TABLE} AS cancellation_set
             WHERE cancellation_set.operation_id = ?
               AND cancellation_set.graph_kind = ?
               AND cancellation_set.run_id = thread_spawn_edges.child_thread_id
           )
         RETURNING child_thread_id`,
      )
      .all(cancelledAt, runId, operation.id, CANCELLATION_GRAPH_SPAWN)
      .map((row) => row.child_thread_id),
  );
  // The marker lands last, after every bulk mutation succeeds.
  driver
    .prepareState<[string, string, string, string, string]>(
      `UPDATE agent_runs
       SET last_active_at = ?,
           metadata_json = json_set(
             CASE
               WHEN metadata_json IS NOT NULL
                AND json_valid(metadata_json)
                AND json_type(metadata_json) = 'object'
               THEN metadata_json ELSE '{}'
             END,
             '$.cancelReason', ?,
             '$.cancelledBy', ?,
             '$.cancelledAt', ?,
             '$.cascadeComplete', json('true')
           )
       WHERE id = ? AND status = 'cancelled'`,
    )
    .run(cancelledAt, reason, runId, cancelledAt, runId);
  const cancelledRunIds = subtree.filter((id) => changedIds.has(id));
  const priorStatusById: Record<string, string> = {};
  for (const row of preState) {
    if (changedIds.has(row.id)) priorStatusById[row.id] = row.status;
  }
  const closedEdgeChildIds = subtree.filter((id) => closedIds.has(id));

  return {
    runId,
    missing: false,
    alreadyTerminal: repairIncompleteCancelledRoot,
    rootStatusBefore: rootStatus,
    subtreeRunIds: subtree,
    cancelledRunIds,
    priorStatusById,
    closedEdgeChildIds,
    cancellationNodeCount: materialized.runCount,
    cancellationEdgeCount: materialized.edgeCount,
  };
}

export interface RepairCancelledSubtreesReport {
  /** Runs moved to `cancelled` because a `cancelled` ancestor was found. */
  readonly repairedRunIds: readonly string[];
}

/**
 * One-shot repair for cancelled roots whose cascade never ran, executed
 * inside the startup-recovery transaction BEFORE recoverable runs are
 * loaded. One admission-union set drives run/edge repair plus durable
 * admission locking and settlement. `cascadeComplete` lands only after every
 * projection succeeds. A quiescent revivable terminal descendant is not
 * given a direct cancellation lock, so a later explicit revival is not
 * re-killed by startup repair; an active admission beneath that same identity
 * is still settled and locked. Scoped to `cancelled` ancestors only —
 * descendants of completed/errored parents are legitimate survivors.
 */
export function repairCancelledSubtrees(
  driver: StateSqliteDriver,
  admissions: ExecutionAdmissionRepository,
  options: { readonly now: string },
): RepairCancelledSubtreesReport {
  try {
    return withCancellationOperation(driver, (operation) =>
      driver.transactionImmediate(() => {
        const cancelledRoots = driver
          .prepareState<[], { readonly id: string }>(
            `SELECT id FROM agent_runs
             WHERE status = 'cancelled'
               AND (
                 metadata_json IS NULL OR NOT json_valid(metadata_json)
                 OR COALESCE(
                   json_extract(metadata_json, '$.cascadeComplete'), 0
                 ) <> 1
               )
             ORDER BY id COLLATE BINARY
             LIMIT ${MAX_CANCELLATION_REPAIR_ROOTS + 1}`,
          )
          .all();
        if (cancelledRoots.length > MAX_CANCELLATION_REPAIR_ROOTS) {
          throw new CancellationRepairDeferredError(
            "repair_root_limit",
            `cancelled-subtree repair roots exceed safety bound: ` +
              `${cancelledRoots.length} > ${MAX_CANCELLATION_REPAIR_ROOTS}`,
          );
        }
        if (cancelledRoots.length === 0) return { repairedRunIds: [] };
        materializeCancellationSet(
          driver,
          operation,
          CANCELLATION_GRAPH_ADMISSION,
          cancelledRoots.map((root) => root.id),
        );
        const ordered = materializedCancellationRunIds(
          driver,
          operation,
          CANCELLATION_GRAPH_ADMISSION,
        );
        admissions.settleMaterializedCancellationInOperation(operation, {
          reason: "recovery_cascade_repair",
          cancelledAt: options.now,
          lockScope: "repair_targets",
        });
        const changed = new Set(
          driver
            .prepareState<
              [string, string, string, CancellationGraphKind],
              { readonly id: string }
            >(
              `UPDATE agent_runs
               SET status = 'cancelled', last_active_at = ?,
                   metadata_json = json_set(
                     CASE
                       WHEN metadata_json IS NOT NULL
                        AND json_valid(metadata_json)
                        AND json_type(metadata_json) = 'object'
                       THEN metadata_json ELSE '{}'
                     END,
                     '$.cancelReason', 'recovery_cascade_repair',
                     '$.cancelledBy', 'recovery_cascade_repair',
                     '$.cancelledAt', ?
                   )
               WHERE status NOT IN (
                       'completed', 'failed', 'cancelled', 'unknown_outcome',
                       'errored', 'error', 'stopped'
                     )
                 AND EXISTS (
                   SELECT 1 FROM temp.${CANCELLATION_SET_TABLE} AS cancellation_set
                   WHERE cancellation_set.operation_id = ?
                     AND cancellation_set.graph_kind = ?
                     AND cancellation_set.run_id = agent_runs.id
                 )
               RETURNING id`,
            )
            .all(
              options.now,
              options.now,
              operation.id,
              CANCELLATION_GRAPH_ADMISSION,
            )
            .map((row) => row.id),
        );
        driver
          .prepareState<
            [
              string,
              string,
              CancellationGraphKind,
              string,
              CancellationGraphKind,
            ]
          >(
            `UPDATE thread_spawn_edges
             SET status = 'closed', updated_at = ?
             WHERE status = 'open'
               AND EXISTS (
                 SELECT 1 FROM temp.${CANCELLATION_SET_TABLE} AS child_set
                 WHERE child_set.operation_id = ?
                   AND child_set.graph_kind = ?
                   AND child_set.run_id = thread_spawn_edges.child_thread_id
               )
               AND EXISTS (
                 SELECT 1 FROM temp.${CANCELLATION_SET_TABLE} AS parent_set
                 WHERE parent_set.operation_id = ?
                   AND parent_set.graph_kind = ?
                   AND parent_set.run_id = thread_spawn_edges.parent_thread_id
               )`,
          )
          .run(
            options.now,
            operation.id,
            CANCELLATION_GRAPH_ADMISSION,
            operation.id,
            CANCELLATION_GRAPH_ADMISSION,
          );
        // Stamp every incomplete root together, and only after both bulk
        // mutations and admission settlement have succeeded.
        driver
          .prepareState<[string, CancellationGraphKind]>(
            `UPDATE agent_runs
             SET metadata_json = json_set(
               CASE
                 WHEN metadata_json IS NOT NULL
                  AND json_valid(metadata_json)
                  AND json_type(metadata_json) = 'object'
                 THEN metadata_json ELSE '{}'
               END,
               '$.cascadeComplete', json('true')
             )
             WHERE status = 'cancelled'
               AND EXISTS (
                 SELECT 1 FROM temp.${CANCELLATION_SET_TABLE} AS cancellation_set
                 WHERE cancellation_set.operation_id = ?
                   AND cancellation_set.graph_kind = ?
                   AND cancellation_set.is_root = 1
                   AND cancellation_set.run_id = agent_runs.id
               )`,
          )
          .run(operation.id, CANCELLATION_GRAPH_ADMISSION);
        return { repairedRunIds: ordered.filter((id) => changed.has(id)) };
      }),
    );
  } catch (error) {
    if (!(error instanceof CancellationSetLimitError)) throw error;
    throw new CancellationRepairDeferredError(
      error.dimension === "runs"
        ? "cancellation_run_limit"
        : "cancellation_edge_limit",
      error.message,
      { cause: error },
    );
  }
}

function parseJsonObjectOrEmpty(
  value: string | null | undefined,
): Record<string, unknown> {
  if (value === null || value === undefined || value.trim().length === 0) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

interface CancellationRunPreStateRow {
  readonly id: string;
  readonly status: string;
}

function readCancellationRunPreState(
  driver: StateSqliteDriver,
  operation: CancellationOperation,
  graphKind: CancellationGraphKind,
): readonly CancellationRunPreStateRow[] {
  return driver
    .prepareState<[string, CancellationGraphKind], CancellationRunPreStateRow>(
      `SELECT run.id, run.status
       FROM temp.${CANCELLATION_SET_TABLE} AS cancellation_set
       JOIN agent_runs AS run ON run.id = cancellation_set.run_id
       WHERE cancellation_set.operation_id = ?
         AND cancellation_set.graph_kind = ?
       ORDER BY cancellation_set.is_root DESC, run.id COLLATE BINARY`,
    )
    .all(operation.id, graphKind);
}

function ensureCancellationSetTable(driver: StateSqliteDriver): void {
  driver
    .prepareState(
      `CREATE TEMP TABLE IF NOT EXISTS ${CANCELLATION_SET_TABLE} (
       operation_id TEXT NOT NULL,
       graph_kind TEXT NOT NULL,
       run_id TEXT COLLATE BINARY NOT NULL,
       is_root INTEGER NOT NULL CHECK (is_root IN (0, 1)),
       PRIMARY KEY (operation_id, graph_kind, run_id)
     ) WITHOUT ROWID`,
    )
    .run();
}

function materializedCancellationCount(
  driver: StateSqliteDriver,
  operation: CancellationOperation,
  graphKind: CancellationGraphKind,
): number {
  return (
    driver
      .prepareState<
        [string, CancellationGraphKind],
        { readonly count: number }
      >(
        `SELECT COUNT(*) AS count
         FROM temp.${CANCELLATION_SET_TABLE}
         WHERE operation_id = ? AND graph_kind = ?`,
      )
      .get(operation.id, graphKind)?.count ?? 0
  );
}

function countMaterializedCancellationEdges(
  driver: StateSqliteDriver,
  operation: CancellationOperation,
  graphKind: CancellationGraphKind,
): number {
  const admissionEdges =
    graphKind === CANCELLATION_GRAPH_ADMISSION
      ? `UNION
         SELECT job.admission_parent_run_id, job.admission_run_id
         FROM agent_jobs AS job
         JOIN temp.${CANCELLATION_SET_TABLE} AS parent_set
           ON parent_set.operation_id = ?
          AND parent_set.graph_kind = ?
          AND parent_set.run_id = job.admission_parent_run_id
         JOIN temp.${CANCELLATION_SET_TABLE} AS child_set
           ON child_set.operation_id = parent_set.operation_id
          AND child_set.graph_kind = parent_set.graph_kind
          AND child_set.run_id = job.admission_run_id
         WHERE job.admission_parent_run_id IS NOT NULL
           AND job.admission_run_id IS NOT NULL`
      : "";
  const params: unknown[] = [operation.id, graphKind];
  if (graphKind === CANCELLATION_GRAPH_ADMISSION) {
    params.push(operation.id, graphKind);
  }
  params.push(MAX_CANCELLATION_EDGES + 1);
  return (
    driver
      .prepareState<unknown[], { readonly count: number }>(
        `SELECT COUNT(*) AS count FROM (
           SELECT edge.parent_thread_id, edge.child_thread_id
           FROM thread_spawn_edges AS edge
           JOIN temp.${CANCELLATION_SET_TABLE} AS parent_set
             ON parent_set.operation_id = ?
            AND parent_set.graph_kind = ?
            AND parent_set.run_id = edge.parent_thread_id
           JOIN temp.${CANCELLATION_SET_TABLE} AS child_set
             ON child_set.operation_id = parent_set.operation_id
            AND child_set.graph_kind = parent_set.graph_kind
            AND child_set.run_id = edge.child_thread_id
           ${admissionEdges}
           LIMIT ?
         )`,
      )
      .get(...params)?.count ?? 0
  );
}

function parseAncestorParents(value: string): readonly string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("ancestor SQL returned invalid parent JSON");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("ancestor SQL returned a non-array parent set");
  }
  return [
    ...new Set(
      parsed.filter((item): item is string => typeof item === "string"),
    ),
  ].sort(binaryCompare);
}

function ancestorGraphHasCycle(
  parentsById: ReadonlyMap<string, readonly string[]>,
): boolean {
  const complete = new Set<string>();
  for (const start of parentsById.keys()) {
    if (complete.has(start)) continue;
    const path = new Set<string>();
    let current: string | undefined = start;
    while (current !== undefined && parentsById.has(current)) {
      if (path.has(current)) return true;
      if (complete.has(current)) break;
      path.add(current);
      current = parentsById.get(current)?.[0];
    }
    for (const visited of path) complete.add(visited);
  }
  return false;
}

function binaryCompare(left: string, right: string): number {
  return Buffer.from(left).compare(Buffer.from(right));
}
