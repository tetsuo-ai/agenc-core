import { randomUUID } from "node:crypto";

import type {
  AdmissionAttempt,
  AdmissionBudgetScope,
  AdmissionCancellationReport,
  AdmissionClaimResult,
  AdmissionJournalEvent,
  AdmissionReconcileInput,
  AdmissionReconcileResult,
  AdmissionRecoveryReport,
  AdmissionUsage,
  PersistedAdmissionRecord,
  PersistedAdmissionStatus,
  RuntimeAdmissionRequest,
} from "../budget/admission-types.js";
import {
  admissionPeriodScopeKey,
  admissionRecordKey,
} from "../budget/admission-types.js";
import type { BudgetReservation } from "../contracts/run-contracts.js";
import { sqlPlaceholders } from "./sql.js";
import type { StateSqliteDriver } from "./sqlite-driver.js";

export const NANO_USD_PER_USD = 1_000_000_000;
const MAX_LIST_LIMIT = 1_000;
const MAX_ANCESTOR_WALK = 64;

const FINAL_RESERVATION_STATUSES = new Set([
  "reconciled",
  "voided",
  "held_unknown",
  "provider_overrun",
]);

const FINAL_JOB_STATUSES = new Set<PersistedAdmissionStatus>([
  "reconciled",
  "voided",
  "held_unknown",
  "provider_overrun",
  "denied",
  "cancelled",
]);

export class ExecutionAdmissionStateError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ExecutionAdmissionStateError";
  }
}

export class AdmissionStepConflictError extends ExecutionAdmissionStateError {
  constructor(runId: string, stepId: string) {
    super(
      `admission step identity already exists with different request data: ${runId}/${stepId}`,
    );
    this.name = "AdmissionStepConflictError";
  }
}

export class AdmissionAllocationConflictError extends ExecutionAdmissionStateError {
  constructor(scopeKey: string, field: string) {
    super(`admission allocation ${scopeKey} has conflicting ${field}`);
    this.name = "AdmissionAllocationConflictError";
  }
}

export interface ExecutionAdmissionRepositoryOptions {
  readonly now?: () => Date;
  readonly id?: () => string;
  readonly ownerId?: string;
  readonly ownerPid?: number;
}

export interface EnqueueAdmissionOptions {
  readonly priority?: number;
  readonly availableAt?: string;
  readonly ownerId?: string;
  readonly ownerPid?: number;
  readonly attached?: boolean;
}

export interface ClaimAdmissionOptions {
  /** Logical admission key or physical `agent_jobs.id`. Omit for queue head. */
  readonly key?: string;
  readonly ownerId?: string;
  readonly ownerPid?: number;
  readonly attached?: boolean;
  readonly now?: string;
}

export interface MarkAdmissionDispatchedOptions {
  readonly dispatchedAt?: string;
  readonly providerRequestId?: string;
  /** Boundary-specific evidence persisted with the dispatch journal event. */
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface ReconcileAdmissionOptions {
  readonly at?: string;
}

export interface CancelAdmissionOptions {
  readonly reason: string;
  readonly cancelledAt?: string;
}

export interface RecordAdmissionFallbackOptions {
  readonly reason: string;
  readonly at?: string;
  readonly model?: string;
  readonly provider?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface RecoverAdmissionOptions {
  readonly now?: string;
  /** Owners known to still be executing; all other running rows are stale. */
  readonly activeOwnerIds?: ReadonlySet<string>;
}

export interface ListAdmissionOptions {
  readonly statuses?: readonly PersistedAdmissionStatus[];
  readonly runId?: string;
  readonly workspaceId?: string;
  readonly sessionId?: string;
  readonly provider?: string;
  readonly afterQueueSequence?: number;
  readonly limit?: number;
}

export interface PersistedAdmissionReservation {
  readonly reservationId: string;
  readonly jobId: string;
  readonly attempt: number;
  readonly reservation: BudgetReservation;
  readonly kind: RuntimeAdmissionRequest["kind"];
  readonly model?: string;
  readonly provider?: string;
  readonly status:
    | "reserved"
    | "dispatched"
    | "reconciled"
    | "voided"
    | "held_unknown"
    | "provider_overrun";
  readonly reservedInputTokens: number;
  readonly reservedOutputTokens: number;
  readonly actualInputTokens?: number;
  readonly actualOutputTokens?: number;
  readonly actualTokens?: number;
  readonly actualCostUsd?: number | null;
  readonly providerRequestId?: string;
  readonly dispatchedAt?: string;
  readonly resolvedAt?: string;
  readonly resolutionReason?: string;
  readonly updatedAt: string;
}

export interface PersistedAdmissionAllocation {
  readonly key: string;
  readonly ownerRunId: string;
  readonly parentKey?: string;
  readonly maxTokens?: number;
  readonly maxCostUsd?: number;
  readonly usedTokens: number;
  readonly usedCostUsd: number;
  readonly heldTokens: number;
  readonly heldCostUsd: number;
  readonly blockedByProviderOverrun: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ListAdmissionJournalOptions {
  readonly runId?: string;
  readonly stepId?: string;
  readonly afterSequence?: number;
  readonly limit?: number;
}

interface AgentJobRow {
  readonly id: string;
  readonly kind: string;
  readonly status: string;
  readonly priority: number;
  readonly input_json: string;
  readonly result_json: string | null;
  readonly error: string | null;
  readonly worker_id: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly available_at: string;
  readonly admission_run_id: string;
  readonly admission_step_id: string;
  readonly admission_parent_run_id: string | null;
  readonly admission_workspace_id: string;
  readonly admission_session_id: string;
  readonly admission_parent_id: string | null;
  readonly admission_provider: string | null;
  readonly admission_model: string | null;
  readonly admission_autonomous: number;
  readonly admission_deadline_at: string | null;
  readonly admission_approval_required: number;
  readonly admission_max_input_tokens: number;
  readonly admission_max_output_tokens: number;
  readonly admission_max_cost_nanos: number | null;
  readonly admission_attempts: number;
  readonly admission_queue_sequence: number;
  readonly admission_owner_pid: number | null;
  readonly admission_owner_id: string | null;
  readonly admission_attached: number;
  readonly admission_admitted_at: string | null;
  readonly admission_dispatched_at: string | null;
  readonly admission_completed_at: string | null;
  readonly admission_reason: string | null;
  readonly admission_reservation_id: string | null;
}

interface ReservationRow {
  readonly reservation_id: string;
  readonly job_id: string;
  readonly run_id: string;
  readonly step_id: string;
  readonly attempt: number;
  readonly parent_run_id: string | null;
  readonly kind: string;
  readonly model: string | null;
  readonly provider: string | null;
  readonly status: string;
  readonly reserved_input_tokens: number;
  readonly reserved_output_tokens: number;
  readonly reserved_tokens: number;
  readonly reserved_cost_nanos: number;
  readonly actual_input_tokens: number | null;
  readonly actual_output_tokens: number | null;
  readonly actual_tokens: number | null;
  readonly actual_cost_nanos: number | null;
  readonly provider_request_id: string | null;
  readonly dispatched_at: string | null;
  readonly resolved_at: string | null;
  readonly resolution_reason: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface AllocationRow {
  readonly scope_key: string;
  readonly owner_run_id: string;
  readonly parent_scope_key: string | null;
  readonly max_tokens: number | null;
  readonly max_cost_nanos: number | null;
  readonly used_tokens: number;
  readonly used_cost_nanos: number;
  readonly held_tokens: number;
  readonly held_cost_nanos: number;
  readonly blocked_by_provider_overrun: number;
  readonly created_at: string;
  readonly updated_at: string;
}

interface ReservationAllocationRow {
  readonly reservation_id: string;
  readonly scope_key: string;
  readonly reserved_tokens: number;
  readonly reserved_cost_nanos: number;
}

interface JournalRow {
  readonly sequence: number;
  readonly event_id: string;
  readonly timestamp: string;
  readonly job_id: string | null;
  readonly reservation_id: string | null;
  readonly run_id: string;
  readonly step_id: string;
  readonly kind: string;
  readonly event: string;
  readonly reason: string | null;
  readonly model: string | null;
  readonly provider: string | null;
  readonly reserved_tokens: number | null;
  readonly reserved_cost_nanos: number | null;
  readonly actual_tokens: number | null;
  readonly actual_cost_nanos: number | null;
  readonly details_json: string;
}

interface JournalInsert {
  readonly timestamp: string;
  readonly jobId?: string;
  readonly reservationId?: string;
  readonly request: RuntimeAdmissionRequest;
  readonly event: AdmissionJournalEvent["event"];
  readonly reason?: string;
  readonly reservedTokens?: number;
  readonly reservedCostNanos?: number;
  readonly actualTokens?: number;
  readonly actualCostNanos?: number;
  readonly details?: Readonly<Record<string, unknown>>;
}

interface ResolutionCharge {
  readonly tokens: number;
  readonly costNanos: number;
  readonly blockByProviderOverrun: boolean;
}

const JOB_COLUMNS = `
  id, kind, status, priority, input_json, result_json, error, worker_id,
  created_at, updated_at, available_at,
  admission_run_id, admission_step_id, admission_parent_run_id,
  admission_workspace_id, admission_session_id, admission_parent_id,
  admission_provider, admission_model, admission_autonomous,
  admission_deadline_at, admission_approval_required,
  admission_max_input_tokens, admission_max_output_tokens,
  admission_max_cost_nanos, admission_attempts, admission_queue_sequence,
  admission_owner_pid, admission_owner_id, admission_attached,
  admission_admitted_at, admission_dispatched_at, admission_completed_at,
  admission_reason, admission_reservation_id
`;

/**
 * SQLite repository for M3 execution admission.
 *
 * Every read-check-write transition is enclosed by `BEGIN IMMEDIATE`. The
 * repository deliberately exposes transition methods instead of mutable row
 * handles so callers cannot reconcile twice or refund a dispatched request.
 */
export class ExecutionAdmissionRepository {
  readonly #driver: StateSqliteDriver;
  readonly #now: () => Date;
  readonly #id: () => string;
  readonly #ownerId: string;
  readonly #ownerPid: number;

  constructor(
    driver: StateSqliteDriver,
    options: ExecutionAdmissionRepositoryOptions = {},
  ) {
    this.#driver = driver;
    this.#now = options.now ?? (() => new Date());
    this.#id = options.id ?? randomUUID;
    this.#ownerId = requireNonEmpty(
      options.ownerId ?? `pid:${process.pid}`,
      "ownerId",
    );
    this.#ownerPid = normalizeOwnerPid(options.ownerPid ?? process.pid);
  }

  /**
   * Return whether this database already contains durable admission evidence
   * for a run. This is intentionally read-only: callers use it inside their
   * own transaction before deciding whether a public run cancellation is
   * allowed to create a permanent cancellation lock.
   */
  hasRunState(runId: string): boolean {
    requireNonEmpty(runId, "hasRunState.runId");
    const probes = [
      ["agent_jobs", "admission_run_id"],
      ["agent_jobs", "admission_parent_run_id"],
      ["execution_admission_reservations", "run_id"],
      ["execution_admission_allocations", "owner_run_id"],
      ["execution_admission_run_limits", "run_id"],
      ["execution_admission_cancellations", "run_id"],
      ["execution_admission_journal", "run_id"],
    ] as const;
    return probes.some(([table, column]) =>
      this.#driver
        .prepareState<[string], { readonly found: number }>(
          `SELECT 1 AS found FROM ${table} WHERE ${column} = ? LIMIT 1`,
        )
        .get(runId) !== undefined,
    );
  }

  isRunCancellationLocked(runId: string): boolean {
    requireNonEmpty(runId, "isRunCancellationLocked.runId");
    return (
      this.#driver
        .prepareState<[string], { readonly found: number }>(
          `SELECT 1 AS found FROM execution_admission_cancellations
           WHERE run_id = ? LIMIT 1`,
        )
        .get(runId) !== undefined
    );
  }

  /**
   * Persist a run's absolute deadline once. Rebinding may tighten the limit,
   * but can never extend or remove it, so daemon restart does not grant a new
   * wall-clock window.
   */
  bindRunDeadline(runId: string, proposed?: string): string | undefined {
    const normalizedRunId = requireNonEmpty(runId, "bindRunDeadline.runId");
    const normalizedProposed =
      proposed === undefined
        ? undefined
        : normalizeTimestamp(proposed, "bindRunDeadline.proposed");
    const at = this.#timestamp();
    return this.#driver.transactionImmediate(() => {
      const existing = this.#driver
        .prepareState<
          [string],
          { readonly deadline_at: string | null }
        >(
          `SELECT deadline_at FROM execution_admission_run_limits
           WHERE run_id = ?`,
        )
        .get(normalizedRunId);
      if (existing === undefined) {
        this.#driver
          .prepareState(
            `INSERT INTO execution_admission_run_limits (
              run_id, deadline_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?)`,
          )
          .run(normalizedRunId, normalizedProposed ?? null, at, at);
        return normalizedProposed;
      }
      const persisted =
        existing.deadline_at === null
          ? undefined
          : normalizeTimestamp(
              existing.deadline_at,
              "execution_admission_run_limits.deadline_at",
            );
      const effective = earliestTimestamp(persisted, normalizedProposed);
      if (effective !== persisted) {
        this.#driver
          .prepareState(
            `UPDATE execution_admission_run_limits
             SET deadline_at = ?, updated_at = ? WHERE run_id = ?`,
          )
          .run(effective ?? null, at, normalizedRunId);
      }
      return effective;
    });
  }

  listBoundRunIds(): readonly string[] {
    return this.#driver
      .prepareState<[], { readonly run_id: string }>(
        `SELECT run_id FROM execution_admission_run_limits ORDER BY run_id ASC`,
      )
      .all()
      .map((row) => row.run_id);
  }

  enqueue(
    rawRequest: RuntimeAdmissionRequest,
    options: EnqueueAdmissionOptions = {},
  ): AdmissionAttempt {
    const request = normalizeAdmissionRequest(rawRequest);
    const now = this.#timestamp();
    const availableAt = normalizeTimestamp(
      options.availableAt ?? now,
      "availableAt",
    );
    const priority = normalizePriority(options.priority ?? 0);
    const ownerId = requireNonEmpty(
      options.ownerId ?? this.#ownerId,
      "enqueue.ownerId",
    );
    const ownerPid = normalizeOwnerPid(options.ownerPid ?? this.#ownerPid);
    const attached = options.attached === true;

    return this.#driver.transactionImmediate(() => {
      const existing = this.#jobByStepLocked(
        request.step.runId,
        request.step.stepId,
      );
      if (existing !== undefined) {
        if (!requestsMatch(parseRequest(existing.input_json), request)) {
          throw new AdmissionStepConflictError(
            request.step.runId,
            request.step.stepId,
          );
        }
        return attemptForRecord(this.#recordFromRowLocked(existing));
      }

      let status: PersistedAdmissionStatus = "queued";
      let event: AdmissionJournalEvent["event"] = "queued";
      let reason: string | undefined;
      if (this.#isCancellationLocked(request)) {
        status = "denied";
        event = "denied";
        reason = "parent_cancel_locked";
      } else if (
        request.deadlineAt !== undefined &&
        request.deadlineAt <= now
      ) {
        status = "cancelled";
        event = "cancelled";
        reason = "deadline_expired";
      } else if (request.denialReason !== undefined) {
        status = "denied";
        event = "denied";
        reason = request.denialReason;
      } else if (request.approvalRequired === true) {
        status = "approval_required";
        event = "approval_required";
        reason = "approval_required";
      }

      const jobId = this.#id();
      const maxCostNanos =
        request.estimate.maxCostUsd === null
          ? null
          : usdToNanos(request.estimate.maxCostUsd);
      this.#driver
        .prepareState(
          `INSERT INTO agent_jobs (
            id, kind, status, priority, input_json, result_json, error,
            worker_id, created_at, updated_at, available_at,
            admission_run_id, admission_step_id, admission_parent_run_id,
            admission_workspace_id, admission_session_id, admission_parent_id,
            admission_provider, admission_model, admission_autonomous,
            admission_deadline_at, admission_approval_required,
            admission_max_input_tokens, admission_max_output_tokens,
            admission_max_cost_nanos, admission_attempts,
            admission_queue_sequence,
            admission_owner_pid, admission_owner_id, admission_attached,
            admission_reason
          ) VALUES (
            ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?,
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?, ?
          )`,
        )
        .run(
          jobId,
          request.kind,
          status,
          priority,
          JSON.stringify(request),
          ownerId,
          now,
          now,
          availableAt,
          request.step.runId,
          request.step.stepId,
          request.step.parentRunId ?? null,
          request.workspaceId,
          request.sessionId,
          request.parentScopeId ?? request.sessionId,
          request.provider ?? null,
          request.model ?? null,
          request.autonomous ? 1 : 0,
          request.deadlineAt ?? null,
          request.approvalRequired === true ? 1 : 0,
          request.estimate.maxInputTokens,
          request.estimate.maxOutputTokens,
          maxCostNanos,
          ownerPid,
          ownerId,
          attached ? 1 : 0,
          reason ?? null,
        );
      const journal = this.#appendJournalLocked({
        timestamp: now,
        jobId,
        request,
        event,
        ...(reason !== undefined ? { reason } : {}),
      });
      this.#driver
        .prepareState<[number, string]>(
          `UPDATE agent_jobs
           SET admission_queue_sequence = ?
           WHERE id = ? AND admission_queue_sequence IS NULL`,
        )
        .run(journal.sequence, jobId);
      const persisted = this.#requireJobByIdLocked(jobId);
      return attemptForRecord(this.#recordFromRowLocked(persisted));
    });
  }

  claim(options: ClaimAdmissionOptions = {}): AdmissionClaimResult {
    const now = normalizeTimestamp(
      options.now ?? this.#timestamp(),
      "claim.now",
    );
    const ownerId = requireNonEmpty(
      options.ownerId ?? this.#ownerId,
      "claim.ownerId",
    );
    const ownerPid = normalizeOwnerPid(options.ownerPid ?? this.#ownerPid);
    const attached = options.attached === true;

    return this.#driver.transactionImmediate(() => {
      const row =
        options.key === undefined
          ? this.#nextQueuedJobLocked(now)
          : this.#jobByKeyLocked(options.key);
      if (row === undefined) return { kind: "empty" };

      if (row.status === "running" && row.admission_reservation_id !== null) {
        if (row.admission_owner_id === ownerId) {
          const record = this.#recordFromRowLocked(row);
          if (record.reservation !== undefined) {
            return {
              kind: "claimed",
              lease: {
                decision: "allow",
                reservation: record.reservation,
                request: record.request,
              },
            };
          }
        }
        return {
          kind: "not_claimed",
          reason: "not_queued",
          record: this.#recordFromRowLocked(row),
        };
      }
      if (row.status !== "queued") {
        return {
          kind: "not_claimed",
          reason: "not_queued",
          record: this.#recordFromRowLocked(row),
        };
      }

      const request = parseRequest(row.input_json);
      if (this.#isCancellationLocked(request)) {
        const denied = this.#finishUnclaimedJobLocked(
          row,
          request,
          "denied",
          "parent_cancel_locked",
          now,
        );
        return { kind: "not_claimed", reason: "cancelled", record: denied };
      }
      if (request.deadlineAt !== undefined && request.deadlineAt <= now) {
        const cancelled = this.#finishUnclaimedJobLocked(
          row,
          request,
          "cancelled",
          "deadline_expired",
          now,
        );
        return {
          kind: "not_claimed",
          reason: "deadline_expired",
          record: cancelled,
        };
      }

      const reservedTokens = checkedTokenSum(
        request.estimate.maxInputTokens,
        request.estimate.maxOutputTokens,
      );
      const reservedCostNanos =
        request.estimate.maxCostUsd === null
          ? null
          : usdToNanos(request.estimate.maxCostUsd);
      const budgetScopes = this.#effectiveBudgetScopesLocked(request, now);
      const allocationResult = this.#prepareAllocationHoldsLocked(
        request,
        budgetScopes,
        reservedTokens,
        reservedCostNanos,
        now,
      );
      if (allocationResult !== null) {
        const denied = this.#finishUnclaimedJobLocked(
          row,
          request,
          "denied",
          allocationResult,
          now,
        );
        return {
          kind: "not_claimed",
          reason: allocationResult,
          record: denied,
        };
      }

      const reservationId = this.#id();
      const attempt = row.admission_attempts + 1;
      const persistedCostNanos = reservedCostNanos ?? 0;
      this.#driver
        .prepareState(
          `INSERT INTO execution_admission_reservations (
            reservation_id, job_id, run_id, step_id, attempt, parent_run_id,
            kind, model, provider, status, reserved_input_tokens,
            reserved_output_tokens, reserved_tokens, reserved_cost_nanos,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          reservationId,
          row.id,
          request.step.runId,
          request.step.stepId,
          attempt,
          request.step.parentRunId ?? null,
          request.kind,
          request.model ?? null,
          request.provider ?? null,
          request.estimate.maxInputTokens,
          request.estimate.maxOutputTokens,
          reservedTokens,
          persistedCostNanos,
          now,
          now,
        );
      for (const scope of this.#allocationClosureLocked(budgetScopes)) {
        this.#driver
          .prepareState(
            `INSERT INTO execution_admission_reservation_allocations (
              reservation_id, scope_key, reserved_tokens, reserved_cost_nanos
            ) VALUES (?, ?, ?, ?)`,
          )
          .run(
            reservationId,
            scope.scope_key,
            reservedTokens,
            persistedCostNanos,
          );
        this.#driver
          .prepareState(
            `UPDATE execution_admission_allocations
             SET held_tokens = held_tokens + ?,
                 held_cost_nanos = held_cost_nanos + ?,
                 updated_at = ?
             WHERE scope_key = ?`,
          )
          .run(reservedTokens, persistedCostNanos, now, scope.scope_key);
      }
      this.#driver
        .prepareState(
          `UPDATE agent_jobs
           SET status = 'running', worker_id = ?, admission_attempts = ?, updated_at = ?,
               admission_owner_pid = ?, admission_owner_id = ?,
               admission_attached = ?, admission_admitted_at = ?,
               admission_completed_at = NULL, admission_reason = NULL,
               admission_reservation_id = ?
           WHERE id = ? AND status = 'queued'`,
        )
        .run(
          ownerId,
          attempt,
          now,
          ownerPid,
          ownerId,
          attached ? 1 : 0,
          now,
          reservationId,
          row.id,
        );
      this.#appendJournalLocked({
        timestamp: now,
        jobId: row.id,
        reservationId,
        request,
        event: "allowed",
        reservedTokens,
        reservedCostNanos: persistedCostNanos,
        details: { attempt },
      });
      const claimed = this.#recordFromRowLocked(
        this.#requireJobByIdLocked(row.id),
      );
      if (claimed.reservation === undefined) {
        throw new ExecutionAdmissionStateError(
          `claimed admission is missing reservation: ${row.id}`,
        );
      }
      return {
        kind: "claimed",
        lease: {
          decision: "allow",
          reservation: claimed.reservation,
          request: claimed.request,
        },
      };
    });
  }

  markDispatched(
    reservationId: string,
    options: MarkAdmissionDispatchedOptions = {},
  ): PersistedAdmissionRecord {
    requireNonEmpty(reservationId, "reservationId");
    const evidenceAt =
      options.dispatchedAt === undefined
        ? undefined
        : normalizeTimestamp(options.dispatchedAt, "dispatchedAt");
    return this.#driver.transactionImmediate(() => {
      // Sample the repository clock only after BEGIN IMMEDIATE has acquired the
      // writer lock. Time spent waiting behind another writer cannot become a
      // loophole that dispatches work after its deadline.
      const observedAt = this.#timestamp();
      const at = evidenceAt ?? observedAt;
      // A caller-provided evidence timestamp may predate the repository's clock,
      // but it must never extend a deadline. Use the later observation for the
      // final policy check while preserving `at` as audit evidence.
      const decisionAt = observedAt < at ? at : observedAt;
      const reservation = this.#requireReservationLocked(reservationId);
      const job = this.#requireJobByIdLocked(reservation.job_id);
      const request = parseRequest(job.input_json);
      if (reservation.status === "reserved") {
        const stopReason = this.#isCancellationLocked(request)
          ? "parent_cancel_locked"
          : request.deadlineAt !== undefined && request.deadlineAt <= decisionAt
            ? "deadline_expired"
            : undefined;
        if (stopReason !== undefined) {
          // Linearize cancellation/deadline policy against dispatch under the
          // same BEGIN IMMEDIATE lock. A winning cancel voids the untouched
          // hold and permanently locks the run before the caller reaches wire.
          this.#cancelRunLocked(request.step.runId, stopReason, decisionAt);
          return this.#recordFromRowLocked(
            this.#requireJobByIdLocked(job.id),
          );
        }
        this.#driver
          .prepareState(
            `UPDATE execution_admission_reservations
             SET status = 'dispatched', dispatched_at = ?, updated_at = ?,
                 provider_request_id = COALESCE(?, provider_request_id)
             WHERE reservation_id = ? AND status = 'reserved'`,
          )
          .run(at, at, options.providerRequestId ?? null, reservationId);
        this.#driver
          .prepareState(
            `UPDATE agent_jobs
             SET admission_dispatched_at = ?, updated_at = ?
             WHERE id = ? AND admission_reservation_id = ?`,
          )
          .run(at, at, job.id, reservationId);
        this.#appendJournalLocked({
          timestamp: at,
          jobId: job.id,
          reservationId,
          request,
          event: "dispatched",
          reservedTokens: reservation.reserved_tokens,
          reservedCostNanos: reservation.reserved_cost_nanos,
          ...(options.details !== undefined ||
          options.providerRequestId !== undefined
            ? {
                details: {
                  ...options.details,
                  ...(options.providerRequestId !== undefined
                    ? { providerRequestId: options.providerRequestId }
                    : {}),
                },
              }
            : {}),
        });
      } else if (reservation.status === "dispatched") {
        if (
          options.providerRequestId !== undefined &&
          reservation.provider_request_id === null
        ) {
          this.#driver
            .prepareState(
              `UPDATE execution_admission_reservations
               SET provider_request_id = ?, updated_at = ?
               WHERE reservation_id = ? AND provider_request_id IS NULL`,
            )
            .run(options.providerRequestId, at, reservationId);
        } else if (
          options.providerRequestId !== undefined &&
          reservation.provider_request_id !== options.providerRequestId
        ) {
          throw new ExecutionAdmissionStateError(
            `reservation ${reservationId} was already dispatched with a different provider request id`,
          );
        }
      } else if (!FINAL_RESERVATION_STATUSES.has(reservation.status)) {
        throw new ExecutionAdmissionStateError(
          `invalid reservation status at dispatch: ${reservation.status}`,
        );
      }
      return this.#recordFromRowLocked(this.#requireJobByIdLocked(job.id));
    });
  }

  reconcile(
    reservationId: string,
    input: AdmissionReconcileInput,
    options: ReconcileAdmissionOptions = {},
  ): AdmissionReconcileResult {
    requireNonEmpty(reservationId, "reservationId");
    const at = normalizeTimestamp(
      options.at ?? this.#timestamp(),
      "reconcile.at",
    );
    return this.#driver.transactionImmediate(() =>
      this.#resolveReservationLocked(reservationId, input, at),
    );
  }

  void(
    reservationId: string,
    reason: string,
    options: ReconcileAdmissionOptions = {},
  ): AdmissionReconcileResult {
    requireNonEmpty(reason, "void.reason");
    return this.reconcile(reservationId, { kind: "void", reason }, options);
  }

  holdUnknown(
    reservationId: string,
    reason: string,
    options: ReconcileAdmissionOptions = {},
  ): AdmissionReconcileResult {
    requireNonEmpty(reason, "unknown.reason");
    return this.reconcile(reservationId, { kind: "unknown", reason }, options);
  }

  reportProviderOverrun(
    reservationId: string,
    usage: AdmissionUsage,
    options: ReconcileAdmissionOptions & {
      readonly providerRequestId?: string;
      readonly reason?: string;
    } = {},
  ): AdmissionReconcileResult {
    return this.reconcile(
      reservationId,
      {
        kind: "provider_overrun",
        usage,
        ...(options.providerRequestId !== undefined
          ? { providerRequestId: options.providerRequestId }
          : {}),
        ...(options.reason !== undefined ? { reason: options.reason } : {}),
      },
      options,
    );
  }

  cancel(
    runId: string,
    options: CancelAdmissionOptions,
  ): AdmissionCancellationReport {
    requireNonEmpty(runId, "cancel.runId");
    requireNonEmpty(options.reason, "cancel.reason");
    const at = normalizeTimestamp(
      options.cancelledAt ?? this.#timestamp(),
      "cancel.cancelledAt",
    );
    return this.#driver.transactionImmediate(() =>
      this.#cancelRunLocked(runId, options.reason, at),
    );
  }

  cancelStep(
    key: string,
    options: CancelAdmissionOptions,
  ): PersistedAdmissionRecord | undefined {
    requireNonEmpty(key, "cancelStep.key");
    requireNonEmpty(options.reason, "cancelStep.reason");
    const at = normalizeTimestamp(
      options.cancelledAt ?? this.#timestamp(),
      "cancelStep.cancelledAt",
    );
    return this.#driver.transactionImmediate(() => {
      const row = this.#jobByKeyLocked(key);
      if (row === undefined) return undefined;
      this.#cancelJobLocked(row, options.reason, at);
      return this.#recordFromRowLocked(this.#requireJobByIdLocked(row.id));
    });
  }

  recordFallback(
    key: string,
    options: RecordAdmissionFallbackOptions,
  ): AdmissionJournalEvent | undefined {
    requireNonEmpty(key, "recordFallback.key");
    requireNonEmpty(options.reason, "recordFallback.reason");
    const at = normalizeTimestamp(
      options.at ?? this.#timestamp(),
      "recordFallback.at",
    );
    return this.#driver.transactionImmediate(() => {
      const row = this.#jobByKeyLocked(key);
      if (row === undefined) return undefined;
      const request = parseRequest(row.input_json);
      const eventRequest: RuntimeAdmissionRequest = {
        ...request,
        ...(options.model !== undefined
          ? { model: requireNonEmpty(options.model, "recordFallback.model") }
          : {}),
        ...(options.provider !== undefined
          ? {
              provider: requireNonEmpty(
                options.provider,
                "recordFallback.provider",
              ),
            }
          : {}),
      };
      return this.#appendJournalLocked({
        timestamp: at,
        jobId: row.id,
        ...(row.admission_reservation_id !== null
          ? { reservationId: row.admission_reservation_id }
          : {}),
        request: eventRequest,
        event: "fallback",
        reason: options.reason,
        ...(options.details !== undefined ? { details: options.details } : {}),
      });
    });
  }

  recover(options: RecoverAdmissionOptions = {}): AdmissionRecoveryReport {
    const now = normalizeTimestamp(
      options.now ?? this.#timestamp(),
      "recover.now",
    );
    const activeOwners = options.activeOwnerIds ?? new Set<string>();
    return this.#driver.transactionImmediate(() => {
      const requeuedJobIds: string[] = [];
      const heldUnknownReservationIds: string[] = [];
      const cancelledExpiredJobIds: string[] = [];
      const detachedQueuedJobIds: string[] = [];
      const expiredRuns = this.#driver
        .prepareState<[string], { readonly run_id: string }>(
          `SELECT run_id FROM execution_admission_run_limits
           WHERE deadline_at IS NOT NULL AND deadline_at <= ?
           ORDER BY deadline_at ASC, run_id ASC`,
        )
        .all(now);
      for (const { run_id: runId } of expiredRuns) {
        const cancellation = this.#cancelRunLocked(
          runId,
          "deadline_expired_during_recovery",
          now,
        );
        cancelledExpiredJobIds.push(...cancellation.cancelledJobIds);
      }
      const candidates = this.#driver
        .prepareState<[], AgentJobRow>(
          `SELECT ${JOB_COLUMNS}
           FROM agent_jobs
           WHERE admission_run_id IS NOT NULL
             AND status IN ('queued', 'approval_required', 'running')
           ORDER BY admission_queue_sequence ASC`,
        )
        .all();

      for (const row of candidates) {
        const request = parseRequest(row.input_json);
        const expired =
          request.deadlineAt !== undefined && request.deadlineAt <= now;
        if (row.status === "queued" || row.status === "approval_required") {
          if (expired) {
            this.#finishUnclaimedJobLocked(
              row,
              request,
              "cancelled",
              "deadline_expired_during_recovery",
              now,
            );
            if (!cancelledExpiredJobIds.includes(row.id)) {
              cancelledExpiredJobIds.push(row.id);
            }
            continue;
          }
          if (
            row.admission_owner_id !== null ||
            row.admission_owner_pid !== null ||
            row.admission_attached !== 0
          ) {
            this.#driver
              .prepareState(
                `UPDATE agent_jobs
                 SET worker_id = NULL, admission_owner_id = NULL,
                     admission_owner_pid = NULL, admission_attached = 0,
                     updated_at = ?
                 WHERE id = ?`,
              )
              .run(now, row.id);
            this.#appendJournalLocked({
              timestamp: now,
              jobId: row.id,
              request,
              event: "recovered",
              reason: "queued_owner_detached",
            });
            detachedQueuedJobIds.push(row.id);
          }
          continue;
        }

        if (
          row.admission_owner_id !== null &&
          activeOwners.has(row.admission_owner_id)
        ) {
          continue;
        }
        const reservation =
          row.admission_reservation_id === null
            ? undefined
            : this.#reservationLocked(row.admission_reservation_id);
        if (reservation?.status === "dispatched") {
          this.#resolveReservationLocked(
            reservation.reservation_id,
            {
              kind: "unknown",
              reason: expired
                ? "deadline_expired_after_dispatch"
                : "daemon_restarted_after_dispatch",
            },
            now,
          );
          heldUnknownReservationIds.push(reservation.reservation_id);
          if (expired && !cancelledExpiredJobIds.includes(row.id)) {
            cancelledExpiredJobIds.push(row.id);
          }
          continue;
        }
        if (expired) {
          if (reservation?.status === "reserved") {
            this.#resolveReservationLocked(
              reservation.reservation_id,
              { kind: "void", reason: "deadline_expired_before_dispatch" },
              now,
            );
          }
          this.#driver
            .prepareState(
              `UPDATE agent_jobs
               SET status = 'cancelled', worker_id = NULL,
                   admission_owner_id = NULL, admission_owner_pid = NULL,
                   admission_attached = 0, admission_completed_at = ?,
                   admission_reason = 'deadline_expired_during_recovery',
                   updated_at = ?
               WHERE id = ?`,
            )
            .run(now, now, row.id);
          this.#appendJournalLocked({
            timestamp: now,
            jobId: row.id,
            request,
            event: "cancelled",
            reason: "deadline_expired_during_recovery",
          });
          if (!cancelledExpiredJobIds.includes(row.id)) {
            cancelledExpiredJobIds.push(row.id);
          }
          continue;
        }
        if (reservation?.status === "reserved") {
          this.#resolveReservationLocked(
            reservation.reservation_id,
            { kind: "void", reason: "daemon_restarted_before_dispatch" },
            now,
          );
        } else if (
          reservation !== undefined &&
          FINAL_RESERVATION_STATUSES.has(reservation.status)
        ) {
          this.#driver
            .prepareState(
              `UPDATE agent_jobs
               SET status = ?, admission_completed_at = COALESCE(admission_completed_at, ?),
                   admission_reason = COALESCE(admission_reason, ?), updated_at = ?
               WHERE id = ?`,
            )
            .run(
              reservation.status,
              now,
              reservation.resolution_reason ?? "recovered_final_reservation",
              now,
              row.id,
            );
          continue;
        }
        this.#driver
          .prepareState(
            `UPDATE agent_jobs
             SET status = 'queued', worker_id = NULL, result_json = NULL,
                 error = NULL,
                 admission_owner_id = NULL, admission_owner_pid = NULL,
                 admission_attached = 0, admission_admitted_at = NULL,
                 admission_dispatched_at = NULL,
                 admission_completed_at = NULL, admission_reason = NULL,
                 admission_reservation_id = NULL, updated_at = ?
             WHERE id = ?`,
          )
          .run(now, row.id);
        this.#appendJournalLocked({
          timestamp: now,
          jobId: row.id,
          request,
          event: "recovered",
          reason: "requeued_before_dispatch",
        });
        requeuedJobIds.push(row.id);
      }

      const repairedAllocationKeys = this.#rebuildAllocationsLocked(now);
      return {
        requeuedJobIds,
        heldUnknownReservationIds,
        cancelledExpiredJobIds,
        detachedQueuedJobIds,
        repairedAllocationKeys,
      };
    });
  }

  get(key: string): PersistedAdmissionRecord | undefined {
    requireNonEmpty(key, "admission key");
    return this.#driver.transactionImmediate(() => {
      const row = this.#jobByKeyLocked(key);
      return row === undefined ? undefined : this.#recordFromRowLocked(row);
    });
  }

  list(
    options: ListAdmissionOptions = {},
  ): readonly PersistedAdmissionRecord[] {
    const limit = normalizeLimit(options.limit);
    return this.#driver.transactionImmediate(() => {
      const where = ["admission_run_id IS NOT NULL"];
      const params: unknown[] = [];
      if (options.statuses !== undefined && options.statuses.length > 0) {
        where.push(`status IN (${sqlPlaceholders(options.statuses.length)})`);
        params.push(...options.statuses);
      }
      if (options.runId !== undefined) {
        where.push("admission_run_id = ?");
        params.push(options.runId);
      }
      if (options.workspaceId !== undefined) {
        where.push("admission_workspace_id = ?");
        params.push(options.workspaceId);
      }
      if (options.sessionId !== undefined) {
        where.push("admission_session_id = ?");
        params.push(options.sessionId);
      }
      if (options.provider !== undefined) {
        where.push("admission_provider = ?");
        params.push(options.provider);
      }
      if (options.afterQueueSequence !== undefined) {
        where.push("admission_queue_sequence > ?");
        params.push(
          normalizeNonNegativeInteger(
            options.afterQueueSequence,
            "afterQueueSequence",
          ),
        );
      }
      params.push(limit);
      return this.#driver
        .prepareState<unknown[], AgentJobRow>(
          `SELECT ${JOB_COLUMNS}
           FROM agent_jobs
           WHERE ${where.join(" AND ")}
           ORDER BY admission_queue_sequence ASC
           LIMIT ?`,
        )
        .all(...params)
        .map((row) => this.#recordFromRowLocked(row));
    });
  }

  getReservation(
    reservationId: string,
  ): PersistedAdmissionReservation | undefined {
    requireNonEmpty(reservationId, "reservationId");
    return this.#driver.transactionImmediate(() => {
      const row = this.#reservationLocked(reservationId);
      return row === undefined ? undefined : reservationFromRow(row);
    });
  }

  listReservations(
    options: {
      readonly runId?: string;
      readonly statuses?: readonly PersistedAdmissionReservation["status"][];
      readonly limit?: number;
    } = {},
  ): readonly PersistedAdmissionReservation[] {
    const limit = normalizeLimit(options.limit);
    return this.#driver.transactionImmediate(() => {
      const where = ["1 = 1"];
      const params: unknown[] = [];
      if (options.runId !== undefined) {
        where.push("run_id = ?");
        params.push(options.runId);
      }
      if (options.statuses !== undefined && options.statuses.length > 0) {
        where.push(`status IN (${sqlPlaceholders(options.statuses.length)})`);
        params.push(...options.statuses);
      }
      params.push(limit);
      return this.#driver
        .prepareState<unknown[], ReservationRow>(
          `SELECT * FROM execution_admission_reservations
           WHERE ${where.join(" AND ")}
           ORDER BY created_at ASC, reservation_id ASC
           LIMIT ?`,
        )
        .all(...params)
        .map(reservationFromRow);
    });
  }

  listAllocations(
    options: {
      readonly ownerRunId?: string;
      readonly limit?: number;
    } = {},
  ): readonly PersistedAdmissionAllocation[] {
    const limit = normalizeLimit(options.limit);
    return this.#driver.transactionImmediate(() => {
      const rows =
        options.ownerRunId === undefined
          ? this.#driver
              .prepareState<[number], AllocationRow>(
                `SELECT * FROM execution_admission_allocations
                 ORDER BY scope_key ASC LIMIT ?`,
              )
              .all(limit)
          : this.#driver
              .prepareState<[string, number], AllocationRow>(
                `SELECT * FROM execution_admission_allocations
                 WHERE owner_run_id = ? ORDER BY scope_key ASC LIMIT ?`,
              )
              .all(options.ownerRunId, limit);
      return rows.map(allocationFromRow);
    });
  }

  listJournal(
    options: ListAdmissionJournalOptions = {},
  ): readonly AdmissionJournalEvent[] {
    const limit = normalizeLimit(options.limit);
    return this.#driver.transactionImmediate(() => {
      const where = ["1 = 1"];
      const params: unknown[] = [];
      if (options.runId !== undefined) {
        where.push("run_id = ?");
        params.push(options.runId);
      }
      if (options.stepId !== undefined) {
        where.push("step_id = ?");
        params.push(options.stepId);
      }
      if (options.afterSequence !== undefined) {
        where.push("sequence > ?");
        params.push(
          normalizeNonNegativeInteger(options.afterSequence, "afterSequence"),
        );
      }
      params.push(limit);
      return this.#driver
        .prepareState<unknown[], JournalRow>(
          `SELECT * FROM execution_admission_journal
           WHERE ${where.join(" AND ")}
           ORDER BY sequence ASC LIMIT ?`,
        )
        .all(...params)
        .map(journalFromRow);
    });
  }

  #timestamp(): string {
    return this.#now().toISOString();
  }

  #jobByStepLocked(runId: string, stepId: string): AgentJobRow | undefined {
    return this.#driver
      .prepareState<[string, string], AgentJobRow>(
        `SELECT ${JOB_COLUMNS}
         FROM agent_jobs
         WHERE admission_run_id = ? AND admission_step_id = ?`,
      )
      .get(runId, stepId);
  }

  #jobByKeyLocked(key: string): AgentJobRow | undefined {
    const byId = this.#driver
      .prepareState<[string], AgentJobRow>(
        `SELECT ${JOB_COLUMNS} FROM agent_jobs
         WHERE id = ? AND admission_run_id IS NOT NULL`,
      )
      .get(key);
    if (byId !== undefined) return byId;
    const separator = key.indexOf("\u0000");
    if (separator < 1 || separator === key.length - 1) return undefined;
    return this.#jobByStepLocked(
      key.slice(0, separator),
      key.slice(separator + 1),
    );
  }

  #requireJobByIdLocked(jobId: string): AgentJobRow {
    const row = this.#driver
      .prepareState<[string], AgentJobRow>(
        `SELECT ${JOB_COLUMNS} FROM agent_jobs
         WHERE id = ? AND admission_run_id IS NOT NULL`,
      )
      .get(jobId);
    if (row === undefined) {
      throw new ExecutionAdmissionStateError(
        `execution admission job does not exist: ${jobId}`,
      );
    }
    return row;
  }

  #nextQueuedJobLocked(now: string): AgentJobRow | undefined {
    return this.#driver
      .prepareState<[string, string], AgentJobRow>(
        `SELECT ${JOB_COLUMNS}
         FROM agent_jobs
         WHERE admission_run_id IS NOT NULL
           AND status = 'queued'
           AND available_at <= ?
           AND (admission_deadline_at IS NULL OR admission_deadline_at > ?)
         ORDER BY priority DESC, admission_queue_sequence ASC
         LIMIT 1`,
      )
      .get(now, now);
  }

  #reservationLocked(reservationId: string): ReservationRow | undefined {
    return this.#driver
      .prepareState<[string], ReservationRow>(
        `SELECT * FROM execution_admission_reservations
         WHERE reservation_id = ?`,
      )
      .get(reservationId);
  }

  #requireReservationLocked(reservationId: string): ReservationRow {
    const row = this.#reservationLocked(reservationId);
    if (row === undefined) {
      throw new ExecutionAdmissionStateError(
        `execution admission reservation does not exist: ${reservationId}`,
      );
    }
    return row;
  }

  #recordFromRowLocked(row: AgentJobRow): PersistedAdmissionRecord {
    const request = parseRequest(row.input_json);
    const reservation =
      row.admission_reservation_id === null
        ? undefined
        : this.#reservationLocked(row.admission_reservation_id);
    const status = normalizePersistedStatus(row.status);
    return {
      jobId: row.id,
      key: admissionRecordKey(request.step),
      request,
      status,
      priority: row.priority,
      availableAt: row.available_at,
      queueSequence: row.admission_queue_sequence,
      enqueuedAt: row.created_at,
      ownerPid: row.admission_owner_pid ?? 0,
      ownerId: row.admission_owner_id ?? "",
      attached: row.admission_attached === 1,
      ...(reservation !== undefined
        ? { reservation: budgetReservationFromRow(reservation) }
        : {}),
      ...(row.admission_admitted_at !== null
        ? { admittedAt: row.admission_admitted_at }
        : {}),
      ...(row.admission_completed_at !== null
        ? { completedAt: row.admission_completed_at }
        : {}),
      ...(row.admission_reason !== null
        ? { reason: row.admission_reason }
        : {}),
      ...(reservation?.actual_tokens !== null &&
      reservation?.actual_tokens !== undefined
        ? { actualTokens: reservation.actual_tokens }
        : {}),
      ...(reservation !== undefined && reservation.actual_cost_nanos !== null
        ? { actualCostUsd: nanosToUsd(reservation.actual_cost_nanos) }
        : reservation !== undefined &&
            reservation.actual_tokens !== null &&
            reservation.actual_cost_nanos === null
          ? { actualCostUsd: null }
          : {}),
    };
  }

  #finishUnclaimedJobLocked(
    row: AgentJobRow,
    request: RuntimeAdmissionRequest,
    status: "denied" | "cancelled",
    reason: string,
    at: string,
  ): PersistedAdmissionRecord {
    this.#driver
      .prepareState(
        `UPDATE agent_jobs
         SET status = ?, error = ?, worker_id = NULL, updated_at = ?,
             admission_owner_pid = NULL, admission_owner_id = NULL,
             admission_attached = 0, admission_completed_at = ?,
             admission_reason = ?
         WHERE id = ? AND status IN ('queued', 'approval_required')`,
      )
      .run(status, reason, at, at, reason, row.id);
    this.#appendJournalLocked({
      timestamp: at,
      jobId: row.id,
      request,
      event: status === "denied" ? "denied" : "cancelled",
      reason,
    });
    return this.#recordFromRowLocked(this.#requireJobByIdLocked(row.id));
  }

  #prepareAllocationHoldsLocked(
    request: RuntimeAdmissionRequest,
    scopes: readonly AdmissionBudgetScope[],
    reservedTokens: number,
    reservedCostNanos: number | null,
    now: string,
  ):
    | "budget_exceeded"
    | "unpriced_under_hard_cap"
    | "allocation_blocked"
    | null {
    for (const scope of scopes) {
      this.#ensureAllocationLocked(request.step.runId, scope, now);
    }
    const closure = this.#allocationClosureLocked(scopes);
    for (const allocation of closure) {
      if (allocation.blocked_by_provider_overrun === 1) {
        return "allocation_blocked";
      }
      if (
        allocation.max_tokens !== null &&
        checkedTokenSum(
          allocation.used_tokens,
          allocation.held_tokens,
          reservedTokens,
        ) > allocation.max_tokens
      ) {
        return "budget_exceeded";
      }
      if (allocation.max_cost_nanos !== null) {
        if (reservedCostNanos === null) return "unpriced_under_hard_cap";
        if (
          checkedNanoSum(
            allocation.used_cost_nanos,
            allocation.held_cost_nanos,
            reservedCostNanos,
          ) > allocation.max_cost_nanos
        ) {
          return "budget_exceeded";
        }
      }
    }
    return null;
  }

  /**
   * Once a calendar allocation exists, omitting its current config cannot make
   * it disappear from later requests. Discover the two deterministic window
   * keys while holding the same SQLite writer lock used for reservation.
   */
  #effectiveBudgetScopesLocked(
    request: RuntimeAdmissionRequest,
    now: string,
  ): readonly AdmissionBudgetScope[] {
    const scopes = [...(request.budgetScopes ?? [])];
    const seen = new Set(scopes.map((scope) => scope.key));
    const day = now.slice(0, 10);
    const month = day.slice(0, 7);
    const identity = budgetIdentityForRequest(request);
    for (const [period, window] of [
      ["day", day],
      ["month", month],
    ] as const) {
      const key = admissionPeriodScopeKey(identity, period, window);
      if (seen.has(key) || this.#allocationLocked(key) === undefined) continue;
      scopes.push({ key });
      seen.add(key);
    }
    return scopes;
  }

  #ensureAllocationLocked(
    ownerRunId: string,
    scope: AdmissionBudgetScope,
    now: string,
  ): AllocationRow {
    const key = requireNonEmpty(scope.key, "budget scope key");
    const parentKey =
      scope.parentKey === undefined
        ? undefined
        : requireNonEmpty(scope.parentKey, "budget scope parentKey");
    if (parentKey === key) {
      throw new AdmissionAllocationConflictError(key, "self parent");
    }
    const maxTokens =
      scope.maxTokens === undefined
        ? undefined
        : normalizeNonNegativeInteger(scope.maxTokens, `${key}.maxTokens`);
    const maxCostNanos =
      scope.maxCostUsd === undefined ? undefined : usdToNanos(scope.maxCostUsd);
    const existing = this.#allocationLocked(key);
    if (existing === undefined) {
      this.#driver
        .prepareState(
          `INSERT INTO execution_admission_allocations (
            scope_key, owner_run_id, parent_scope_key, max_tokens,
            max_cost_nanos, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          key,
          ownerRunId,
          parentKey ?? null,
          maxTokens ?? null,
          maxCostNanos ?? null,
          now,
          now,
        );
      return this.#requireAllocationLocked(key);
    }
    if (
      parentKey !== undefined &&
      existing.parent_scope_key !== parentKey
    ) {
      throw new AdmissionAllocationConflictError(key, "parentKey");
    }
    if (
      maxTokens !== undefined &&
      existing.max_tokens !== maxTokens
    ) {
      throw new AdmissionAllocationConflictError(key, "maxTokens");
    }
    if (
      maxCostNanos !== undefined &&
      existing.max_cost_nanos !== maxCostNanos
    ) {
      throw new AdmissionAllocationConflictError(key, "maxCostUsd");
    }
    return this.#requireAllocationLocked(key);
  }

  #allocationLocked(key: string): AllocationRow | undefined {
    return this.#driver
      .prepareState<[string], AllocationRow>(
        `SELECT * FROM execution_admission_allocations WHERE scope_key = ?`,
      )
      .get(key);
  }

  #requireAllocationLocked(key: string): AllocationRow {
    const row = this.#allocationLocked(key);
    if (row === undefined) {
      throw new ExecutionAdmissionStateError(
        `admission allocation parent does not exist: ${key}`,
      );
    }
    return row;
  }

  #allocationClosureLocked(
    scopes: readonly AdmissionBudgetScope[],
  ): readonly AllocationRow[] {
    const ordered: AllocationRow[] = [];
    const seen = new Set<string>();
    const queue = scopes.map((scope) => scope.key);
    for (let hops = 0; queue.length > 0; hops++) {
      if (hops >= MAX_ANCESTOR_WALK * Math.max(1, scopes.length)) {
        throw new ExecutionAdmissionStateError(
          "admission allocation hierarchy exceeds cycle/depth bound",
        );
      }
      const key = queue.shift() as string;
      if (seen.has(key)) continue;
      seen.add(key);
      const allocation = this.#requireAllocationLocked(key);
      ordered.push(allocation);
      if (allocation.parent_scope_key !== null) {
        queue.push(allocation.parent_scope_key);
      }
    }
    return ordered;
  }

  #resolveReservationLocked(
    reservationId: string,
    rawInput: AdmissionReconcileInput,
    at: string,
  ): AdmissionReconcileResult {
    const reservation = this.#requireReservationLocked(reservationId);
    const requestedProviderRequestId =
      (rawInput.kind === "reported" || rawInput.kind === "provider_overrun") &&
      rawInput.providerRequestId !== undefined
        ? requireNonEmpty(
            rawInput.providerRequestId,
            "reconcile.providerRequestId",
          )
        : undefined;
    if (
      requestedProviderRequestId !== undefined &&
      reservation.provider_request_id !== null &&
      reservation.provider_request_id !== requestedProviderRequestId
    ) {
      throw new ExecutionAdmissionStateError(
        `reservation ${reservationId} was already dispatched with a different provider request id`,
      );
    }
    const resolvesHeldUnknown =
      reservation.status === "held_unknown" &&
      (rawInput.kind === "reported" || rawInput.kind === "provider_overrun");
    if (
      FINAL_RESERVATION_STATUSES.has(reservation.status) &&
      !resolvesHeldUnknown
    ) {
      return {
        applied: false,
        outcome: "duplicate",
        existingStatus: normalizeFinalReservationStatus(reservation.status),
      };
    }
    if (
      reservation.status !== "reserved" &&
      reservation.status !== "dispatched" &&
      !resolvesHeldUnknown
    ) {
      throw new ExecutionAdmissionStateError(
        `invalid reservation status at reconcile: ${reservation.status}`,
      );
    }
    const job = this.#requireJobByIdLocked(reservation.job_id);
    const request = parseRequest(job.input_json);

    // A caller may discover cancellation after it requested a void. Once the
    // provider/tool boundary was crossed, a full refund is forbidden.
    const input: AdmissionReconcileInput =
      rawInput.kind === "void" && reservation.status === "dispatched"
        ? { kind: "unknown", reason: `void_after_dispatch:${rawInput.reason}` }
        : rawInput;

    let finalStatus: PersistedAdmissionReservation["status"];
    let event: AdmissionJournalEvent["event"];
    let reason: string | undefined;
    let actualInputTokens: number | null = null;
    let actualOutputTokens: number | null = null;
    let actualTokens: number | null = null;
    let actualCostNanos: number | null = null;
    let providerRequestId: string | undefined;
    let charge: ResolutionCharge;
    let overrun = false;

    if (input.kind === "void") {
      finalStatus = "voided";
      event = "voided";
      reason = input.reason;
      charge = { tokens: 0, costNanos: 0, blockByProviderOverrun: false };
    } else if (input.kind === "unknown") {
      finalStatus = "held_unknown";
      event = "held_unknown";
      reason = input.reason;
      charge = {
        tokens: reservation.reserved_tokens,
        costNanos: reservation.reserved_cost_nanos,
        blockByProviderOverrun: false,
      };
    } else {
      const usage = normalizeUsage(input.usage);
      actualInputTokens = usage.inputTokens;
      actualOutputTokens = usage.outputTokens;
      actualTokens = checkedTokenSum(usage.inputTokens, usage.outputTokens);
      actualCostNanos =
        usage.costUsd === null ? null : usdToNanos(usage.costUsd);
      providerRequestId = requestedProviderRequestId;
      overrun =
        input.kind === "provider_overrun" ||
        actualTokens > reservation.reserved_tokens ||
        (actualCostNanos !== null &&
          actualCostNanos > reservation.reserved_cost_nanos);
      if (actualCostNanos === null && !overrun) {
        finalStatus = "held_unknown";
        event = "held_unknown";
        reason = input.reason ?? "reported_usage_cost_unknown";
        charge = {
          tokens: reservation.reserved_tokens,
          costNanos: reservation.reserved_cost_nanos,
          blockByProviderOverrun: false,
        };
      } else {
        finalStatus = overrun ? "provider_overrun" : "reconciled";
        event = overrun ? "provider_overrun" : "reconciled";
        reason =
          input.reason ?? (overrun ? "provider_reported_overrun" : undefined);
        charge = {
          tokens: actualTokens,
          // Unknown provider cost is never treated as free. An explicit or
          // token-detected overrun keeps at least the full monetary reservation.
          costNanos:
            actualCostNanos ?? reservation.reserved_cost_nanos,
          blockByProviderOverrun: overrun,
        };
      }
    }

    if (resolvesHeldUnknown && finalStatus === "held_unknown") {
      return {
        applied: false,
        outcome: "duplicate",
        existingStatus: "held_unknown",
      };
    }

    if (resolvesHeldUnknown) {
      this.#replaceHeldUnknownChargeLocked(reservation, charge, at);
    } else {
      this.#applyResolutionChargeLocked(reservation, charge, at);
    }
    this.#driver
      .prepareState(
        `UPDATE execution_admission_reservations
         SET status = ?, actual_input_tokens = ?, actual_output_tokens = ?,
             actual_tokens = ?, actual_cost_nanos = ?,
             provider_request_id = COALESCE(provider_request_id, ?),
             resolved_at = ?, resolution_reason = ?, updated_at = ?
         WHERE reservation_id = ? AND status IN ('reserved', 'dispatched', 'held_unknown')`,
      )
      .run(
        finalStatus,
        actualInputTokens,
        actualOutputTokens,
        actualTokens,
        actualCostNanos,
        providerRequestId ?? null,
        at,
        reason ?? null,
        at,
        reservationId,
      );
    this.#driver
      .prepareState(
        `UPDATE agent_jobs
         SET status = ?, result_json = ?, error = ?, worker_id = NULL,
             updated_at = ?, admission_owner_pid = NULL,
             admission_owner_id = NULL, admission_attached = 0,
             admission_completed_at = ?, admission_reason = ?
         WHERE id = ? AND admission_reservation_id = ?`,
      )
      .run(
        finalStatus,
        actualTokens === null
          ? null
          : JSON.stringify({
              inputTokens: actualInputTokens,
              outputTokens: actualOutputTokens,
              totalTokens: actualTokens,
              costUsd:
                actualCostNanos === null ? null : nanosToUsd(actualCostNanos),
            }),
        finalStatus === "reconciled" ? null : (reason ?? finalStatus),
        at,
        at,
        reason ?? null,
        job.id,
        reservationId,
      );
    this.#appendJournalLocked({
      timestamp: at,
      jobId: job.id,
      reservationId,
      request,
      event,
      ...(reason !== undefined ? { reason } : {}),
      reservedTokens: reservation.reserved_tokens,
      reservedCostNanos: reservation.reserved_cost_nanos,
      ...(actualTokens !== null ? { actualTokens } : {}),
      ...(actualCostNanos !== null ? { actualCostNanos } : {}),
      ...(providerRequestId !== undefined
        ? { details: { providerRequestId } }
        : {}),
    });

    if (overrun) {
      this.#cancelRunLocked(reservation.run_id, "provider_overrun", at);
      return {
        applied: true,
        outcome: "provider_overrun",
        reservedTokens: reservation.reserved_tokens,
        actualTokens: actualTokens as number,
        reservedCostUsd: nanosToUsd(reservation.reserved_cost_nanos),
        actualCostUsd:
          actualCostNanos === null ? null : nanosToUsd(actualCostNanos),
      };
    }
    return {
      applied: true,
      outcome:
        finalStatus === "voided"
          ? "voided"
          : finalStatus === "held_unknown"
            ? "held_unknown"
            : "reconciled",
    };
  }

  #applyResolutionChargeLocked(
    reservation: ReservationRow,
    charge: ResolutionCharge,
    at: string,
  ): void {
    const links = this.#driver
      .prepareState<[string], ReservationAllocationRow>(
        `SELECT reservation_id, scope_key, reserved_tokens, reserved_cost_nanos
         FROM execution_admission_reservation_allocations
         WHERE reservation_id = ? ORDER BY scope_key ASC`,
      )
      .all(reservation.reservation_id);
    for (const link of links) {
      const allocation = this.#requireAllocationLocked(link.scope_key);
      if (
        allocation.held_tokens < link.reserved_tokens ||
        allocation.held_cost_nanos < link.reserved_cost_nanos
      ) {
        throw new ExecutionAdmissionStateError(
          `allocation hold underflow for ${link.scope_key}/${reservation.reservation_id}`,
        );
      }
      checkedTokenSum(allocation.used_tokens, charge.tokens);
      checkedNanoSum(allocation.used_cost_nanos, charge.costNanos);
      this.#driver
        .prepareState(
          `UPDATE execution_admission_allocations
           SET held_tokens = held_tokens - ?,
               held_cost_nanos = held_cost_nanos - ?,
               used_tokens = used_tokens + ?,
               used_cost_nanos = used_cost_nanos + ?,
               blocked_by_provider_overrun = CASE
                 WHEN ? = 1 THEN 1 ELSE blocked_by_provider_overrun
               END,
               updated_at = ?
           WHERE scope_key = ?`,
        )
        .run(
          link.reserved_tokens,
          link.reserved_cost_nanos,
          charge.tokens,
          charge.costNanos,
          charge.blockByProviderOverrun ? 1 : 0,
          at,
          link.scope_key,
        );
    }
  }

  /** Replace the conservative full charge retained by `held_unknown`. */
  #replaceHeldUnknownChargeLocked(
    reservation: ReservationRow,
    charge: ResolutionCharge,
    at: string,
  ): void {
    const links = this.#driver
      .prepareState<[string], ReservationAllocationRow>(
        `SELECT reservation_id, scope_key, reserved_tokens, reserved_cost_nanos
         FROM execution_admission_reservation_allocations
         WHERE reservation_id = ? ORDER BY scope_key ASC`,
      )
      .all(reservation.reservation_id);
    for (const link of links) {
      const allocation = this.#requireAllocationLocked(link.scope_key);
      if (
        allocation.used_tokens < link.reserved_tokens ||
        allocation.used_cost_nanos < link.reserved_cost_nanos
      ) {
        throw new ExecutionAdmissionStateError(
          `allocation unknown-charge underflow for ${link.scope_key}/${reservation.reservation_id}`,
        );
      }
      checkedTokenSum(
        allocation.used_tokens - link.reserved_tokens,
        charge.tokens,
      );
      checkedNanoSum(
        allocation.used_cost_nanos - link.reserved_cost_nanos,
        charge.costNanos,
      );
      this.#driver
        .prepareState(
          `UPDATE execution_admission_allocations
           SET used_tokens = used_tokens - ? + ?,
               used_cost_nanos = used_cost_nanos - ? + ?,
               blocked_by_provider_overrun = CASE
                 WHEN ? = 1 THEN 1 ELSE blocked_by_provider_overrun
               END,
               updated_at = ?
           WHERE scope_key = ?`,
        )
        .run(
          link.reserved_tokens,
          charge.tokens,
          link.reserved_cost_nanos,
          charge.costNanos,
          charge.blockByProviderOverrun ? 1 : 0,
          at,
          link.scope_key,
        );
    }
  }

  #cancelRunLocked(
    runId: string,
    reason: string,
    at: string,
  ): AdmissionCancellationReport {
    const affectedRunIds = this.#collectDescendantRunIdsLocked(runId);
    for (const affectedRunId of affectedRunIds) {
      this.#driver
        .prepareState(
          `INSERT INTO execution_admission_cancellations (
            run_id, reason, cancelled_at
          ) VALUES (?, ?, ?)
          ON CONFLICT(run_id) DO NOTHING`,
        )
        .run(affectedRunId, reason, at);
    }
    if (affectedRunIds.length === 0) {
      return {
        runId,
        affectedRunIds: [],
        cancelledJobIds: [],
        voidedReservationIds: [],
        heldUnknownReservationIds: [],
      };
    }
    const jobs = this.#driver
      .prepareState<unknown[], AgentJobRow>(
        `SELECT ${JOB_COLUMNS}
         FROM agent_jobs
         WHERE admission_run_id IN (${sqlPlaceholders(affectedRunIds.length)})
         ORDER BY admission_queue_sequence ASC`,
      )
      .all(...affectedRunIds);
    const cancelledJobIds: string[] = [];
    const voidedReservationIds: string[] = [];
    const heldUnknownReservationIds: string[] = [];
    for (const job of jobs) {
      const before =
        job.admission_reservation_id === null
          ? undefined
          : this.#reservationLocked(job.admission_reservation_id);
      const changed = this.#cancelJobLocked(job, reason, at);
      if (!changed) continue;
      cancelledJobIds.push(job.id);
      if (before?.status === "reserved") {
        voidedReservationIds.push(before.reservation_id);
      } else if (before?.status === "dispatched") {
        heldUnknownReservationIds.push(before.reservation_id);
      }
    }
    return {
      runId,
      affectedRunIds,
      cancelledJobIds,
      voidedReservationIds,
      heldUnknownReservationIds,
    };
  }

  #cancelJobLocked(row: AgentJobRow, reason: string, at: string): boolean {
    const status = normalizePersistedStatus(row.status);
    if (FINAL_JOB_STATUSES.has(status)) return false;
    const request = parseRequest(row.input_json);
    const reservation =
      row.admission_reservation_id === null
        ? undefined
        : this.#reservationLocked(row.admission_reservation_id);
    if (reservation?.status === "dispatched") {
      this.#resolveReservationLocked(
        reservation.reservation_id,
        { kind: "unknown", reason: `cancelled_after_dispatch:${reason}` },
        at,
      );
    } else if (reservation?.status === "reserved") {
      this.#resolveReservationLocked(
        reservation.reservation_id,
        { kind: "void", reason: `cancelled_before_dispatch:${reason}` },
        at,
      );
    } else {
      this.#driver
        .prepareState(
          `UPDATE agent_jobs
           SET status = 'cancelled', error = ?, worker_id = NULL,
               updated_at = ?, admission_owner_pid = NULL,
               admission_owner_id = NULL, admission_attached = 0,
               admission_completed_at = ?, admission_reason = ?
           WHERE id = ? AND status IN ('queued', 'approval_required', 'running')`,
        )
        .run(reason, at, at, reason, row.id);
    }
    this.#appendJournalLocked({
      timestamp: at,
      jobId: row.id,
      ...(reservation !== undefined
        ? { reservationId: reservation.reservation_id }
        : {}),
      request,
      event: "cancelled",
      reason,
    });
    return true;
  }

  #collectDescendantRunIdsLocked(rootRunId: string): readonly string[] {
    const seen = new Set<string>();
    const ordered: string[] = [];
    const queue = [rootRunId];
    const spawnChildren = this.#driver.prepareState<
      [string],
      { readonly child_thread_id: string }
    >(
      `SELECT child_thread_id FROM thread_spawn_edges
       WHERE parent_thread_id = ? ORDER BY child_thread_id ASC`,
    );
    const admissionChildren = this.#driver.prepareState<
      [string],
      { readonly admission_run_id: string }
    >(
      `SELECT DISTINCT admission_run_id FROM agent_jobs
       WHERE admission_parent_run_id = ? AND admission_run_id IS NOT NULL
       ORDER BY admission_run_id ASC`,
    );
    while (queue.length > 0) {
      const current = queue.shift() as string;
      if (seen.has(current)) continue;
      if (seen.size >= 100_000) {
        throw new ExecutionAdmissionStateError(
          `admission cancellation subtree exceeds safety bound: ${rootRunId}`,
        );
      }
      seen.add(current);
      ordered.push(current);
      for (const child of spawnChildren.all(current)) {
        if (!seen.has(child.child_thread_id)) queue.push(child.child_thread_id);
      }
      for (const child of admissionChildren.all(current)) {
        if (!seen.has(child.admission_run_id))
          queue.push(child.admission_run_id);
      }
    }
    return ordered;
  }

  #isCancellationLocked(request: RuntimeAdmissionRequest): boolean {
    const seen = new Set<string>();
    const queue = [
      request.step.runId,
      ...(request.step.parentRunId !== undefined
        ? [request.step.parentRunId]
        : []),
    ];
    const cancellation = this.#driver.prepareState<
      [string],
      { readonly run_id: string }
    >(`SELECT run_id FROM execution_admission_cancellations WHERE run_id = ?`);
    const runStatus = this.#driver.prepareState<
      [string],
      { readonly status: string }
    >("SELECT status FROM agent_runs WHERE id = ?");
    const spawnParent = this.#driver.prepareState<
      [string],
      { readonly parent_thread_id: string }
    >(
      `SELECT parent_thread_id FROM thread_spawn_edges
       WHERE child_thread_id = ?`,
    );
    const admissionParent = this.#driver.prepareState<
      [string],
      { readonly admission_parent_run_id: string | null }
    >(
      `SELECT admission_parent_run_id FROM agent_jobs
       WHERE admission_run_id = ? AND admission_parent_run_id IS NOT NULL
       ORDER BY admission_queue_sequence ASC LIMIT 1`,
    );
    while (queue.length > 0 && seen.size < MAX_ANCESTOR_WALK) {
      const current = queue.shift() as string;
      if (seen.has(current)) continue;
      seen.add(current);
      if (cancellation.get(current) !== undefined) return true;
      const status = runStatus.get(current)?.status;
      if (
        status === "cancelled" ||
        status === "unknown_outcome" ||
        status === "provider_overrun"
      ) {
        return true;
      }
      const parent =
        spawnParent.get(current)?.parent_thread_id ??
        admissionParent.get(current)?.admission_parent_run_id ??
        undefined;
      if (parent !== undefined && !seen.has(parent)) queue.push(parent);
    }
    if (queue.length > 0) {
      throw new ExecutionAdmissionStateError(
        `admission ancestor walk exceeds safety bound: ${request.step.runId}`,
      );
    }
    return false;
  }

  #rebuildAllocationsLocked(at: string): readonly string[] {
    const allocations = this.#driver
      .prepareState<[], AllocationRow>(
        `SELECT * FROM execution_admission_allocations ORDER BY scope_key ASC`,
      )
      .all();
    this.#driver
      .prepareState(
        `UPDATE execution_admission_allocations
         SET used_tokens = 0, used_cost_nanos = 0,
             held_tokens = 0, held_cost_nanos = 0,
             blocked_by_provider_overrun = 0, updated_at = ?`,
      )
      .run(at);
    const links = this.#driver
      .prepareState<
        [],
        ReservationAllocationRow & {
          readonly status: string;
          readonly actual_tokens: number | null;
          readonly actual_cost_nanos: number | null;
        }
      >(
        `SELECT ra.reservation_id, ra.scope_key, ra.reserved_tokens,
                ra.reserved_cost_nanos, r.status, r.actual_tokens,
                r.actual_cost_nanos
         FROM execution_admission_reservation_allocations ra
         JOIN execution_admission_reservations r
           ON r.reservation_id = ra.reservation_id
         ORDER BY ra.scope_key ASC, ra.reservation_id ASC`,
      )
      .all();
    const totals = new Map<
      string,
      {
        usedTokens: number;
        usedCostNanos: number;
        heldTokens: number;
        heldCostNanos: number;
        blocked: boolean;
      }
    >();
    for (const allocation of allocations) {
      totals.set(allocation.scope_key, {
        usedTokens: 0,
        usedCostNanos: 0,
        heldTokens: 0,
        heldCostNanos: 0,
        blocked: false,
      });
    }
    for (const link of links) {
      const total = totals.get(link.scope_key);
      if (total === undefined) {
        throw new ExecutionAdmissionStateError(
          `reservation references missing allocation: ${link.scope_key}`,
        );
      }
      if (link.status === "reserved" || link.status === "dispatched") {
        total.heldTokens = checkedTokenSum(
          total.heldTokens,
          link.reserved_tokens,
        );
        total.heldCostNanos = checkedNanoSum(
          total.heldCostNanos,
          link.reserved_cost_nanos,
        );
      } else if (link.status === "held_unknown") {
        total.usedTokens = checkedTokenSum(
          total.usedTokens,
          link.reserved_tokens,
        );
        total.usedCostNanos = checkedNanoSum(
          total.usedCostNanos,
          link.reserved_cost_nanos,
        );
      } else if (
        link.status === "reconciled" ||
        link.status === "provider_overrun"
      ) {
        total.usedTokens = checkedTokenSum(
          total.usedTokens,
          link.actual_tokens ?? 0,
        );
        total.usedCostNanos = checkedNanoSum(
          total.usedCostNanos,
          link.actual_cost_nanos ??
            (link.status === "provider_overrun" ? link.reserved_cost_nanos : 0),
        );
        if (link.status === "provider_overrun") total.blocked = true;
      } else if (link.status !== "voided") {
        throw new ExecutionAdmissionStateError(
          `unknown reservation status during recovery: ${link.status}`,
        );
      }
    }
    for (const [key, total] of totals) {
      this.#driver
        .prepareState(
          `UPDATE execution_admission_allocations
           SET used_tokens = ?, used_cost_nanos = ?, held_tokens = ?,
               held_cost_nanos = ?, blocked_by_provider_overrun = ?,
               updated_at = ?
           WHERE scope_key = ?`,
        )
        .run(
          total.usedTokens,
          total.usedCostNanos,
          total.heldTokens,
          total.heldCostNanos,
          total.blocked ? 1 : 0,
          at,
          key,
        );
    }
    return allocations.map((allocation) => allocation.scope_key);
  }

  #appendJournalLocked(input: JournalInsert): AdmissionJournalEvent {
    const eventId = this.#id();
    const result = this.#driver
      .prepareState(
        `INSERT INTO execution_admission_journal (
          event_id, timestamp, job_id, reservation_id, run_id, step_id,
          kind, event, reason, model, provider, reserved_tokens,
          reserved_cost_nanos, actual_tokens, actual_cost_nanos, details_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        eventId,
        input.timestamp,
        input.jobId ?? null,
        input.reservationId ?? null,
        input.request.step.runId,
        input.request.step.stepId,
        input.request.kind,
        input.event,
        input.reason ?? null,
        input.request.model ?? null,
        input.request.provider ?? null,
        input.reservedTokens ?? null,
        input.reservedCostNanos ?? null,
        input.actualTokens ?? null,
        input.actualCostNanos ?? null,
        JSON.stringify(input.details ?? {}),
      );
    const sequence = Number(result.lastInsertRowid);
    const row = this.#driver
      .prepareState<[number], JournalRow>(
        `SELECT * FROM execution_admission_journal WHERE sequence = ?`,
      )
      .get(sequence);
    if (row === undefined) {
      throw new ExecutionAdmissionStateError(
        `admission journal event could not be read back: ${eventId}`,
      );
    }
    return journalFromRow(row);
  }
}

export function usdToNanos(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new ExecutionAdmissionStateError(
      "USD value must be a finite non-negative number",
    );
  }
  // Convert the number's canonical decimal spelling instead of multiplying in
  // binary floating point. `nanosToUsd(n)` must round-trip to exactly `n`;
  // otherwise a retried durable request can gain a nano on each parse and
  // conflict with its own `(runId, stepId)` identity.
  const nanos = decimalToScaledIntegerCeil(Object.is(value, -0) ? "0" : value.toString(), 9);
  if (nanos > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ExecutionAdmissionStateError(
      "USD value exceeds the safe nano-USD range",
    );
  }
  return Number(nanos);
}

function decimalToScaledIntegerCeil(value: string, scale: number): bigint {
  const match = /^(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(value);
  if (match === null) {
    throw new ExecutionAdmissionStateError("USD value has an invalid decimal representation");
  }
  const whole = match[1] ?? "0";
  const fraction = match[2] ?? "";
  const exponent = Number.parseInt(match[3] ?? "0", 10);
  if (!Number.isSafeInteger(exponent)) {
    throw new ExecutionAdmissionStateError("USD value exponent is outside the safe range");
  }
  const digits = BigInt(`${whole}${fraction}`);
  const power = exponent - fraction.length + scale;
  if (power >= 0) return digits * 10n ** BigInt(power);
  const divisor = 10n ** BigInt(-power);
  return (digits + divisor - 1n) / divisor;
}

export function nanosToUsd(value: number): number {
  normalizeNonNegativeInteger(value, "nano-USD value");
  return value / NANO_USD_PER_USD;
}

function normalizeAdmissionRequest(
  request: RuntimeAdmissionRequest,
  options: { readonly allowLegacyParentId?: boolean } = {},
): RuntimeAdmissionRequest {
  if (
    request.kind !== "model_turn" &&
    request.kind !== "tool_exec" &&
    request.kind !== "spawn"
  ) {
    throw new ExecutionAdmissionStateError(
      `invalid admission kind: ${String(request.kind)}`,
    );
  }
  const runId = requireNonEmpty(request.step.runId, "request.step.runId");
  const stepId = requireNonEmpty(request.step.stepId, "request.step.stepId");
  const parentRunId =
    request.step.parentRunId === undefined
      ? undefined
      : requireNonEmpty(request.step.parentRunId, "request.step.parentRunId");
  if (parentRunId === runId) {
    throw new ExecutionAdmissionStateError(
      "request.step.parentRunId cannot equal runId",
    );
  }
  const workspaceId = requireNonEmpty(
    request.workspaceId,
    "request.workspaceId",
  );
  const sessionId = requireNonEmpty(request.sessionId, "request.sessionId");
  const budgetIdentity =
    request.budgetIdentity === undefined
      ? undefined
      : requireNonEmpty(request.budgetIdentity, "request.budgetIdentity");
  const legacyParentId = (
    request as RuntimeAdmissionRequest & {
      readonly parentId?: unknown;
    }
  ).parentId;
  if (legacyParentId !== undefined && options.allowLegacyParentId !== true) {
    throw new ExecutionAdmissionStateError(
      "request.parentId is obsolete; use request.parentScopeId",
    );
  }
  if (legacyParentId !== undefined && typeof legacyParentId !== "string") {
    throw new ExecutionAdmissionStateError(
      "legacy request.parentId must be a string",
    );
  }
  const normalizedLegacyParentId =
    legacyParentId === undefined
      ? undefined
      : requireNonEmpty(legacyParentId, "legacy request.parentId");
  const declaredParentScopeId =
    request.parentScopeId === undefined
      ? undefined
      : requireNonEmpty(request.parentScopeId, "request.parentScopeId");
  if (
    declaredParentScopeId !== undefined &&
    normalizedLegacyParentId !== undefined &&
    declaredParentScopeId !== normalizedLegacyParentId
  ) {
    throw new ExecutionAdmissionStateError(
      "persisted request parent scope fields conflict",
    );
  }
  const parentScopeId = declaredParentScopeId ?? normalizedLegacyParentId;
  if (typeof request.autonomous !== "boolean") {
    throw new ExecutionAdmissionStateError(
      "request.autonomous must be boolean",
    );
  }
  if (
    request.approvalRequired !== undefined &&
    typeof request.approvalRequired !== "boolean"
  ) {
    throw new ExecutionAdmissionStateError(
      "request.approvalRequired must be boolean when provided",
    );
  }
  const denialReason =
    request.denialReason === undefined
      ? undefined
      : requireNonEmpty(request.denialReason, "request.denialReason");
  const maxInputTokens = normalizeNonNegativeInteger(
    request.estimate.maxInputTokens,
    "request.estimate.maxInputTokens",
  );
  const maxOutputTokens = normalizeNonNegativeInteger(
    request.estimate.maxOutputTokens,
    "request.estimate.maxOutputTokens",
  );
  checkedTokenSum(maxInputTokens, maxOutputTokens);
  const maxCostUsd =
    request.estimate.maxCostUsd === null
      ? null
      : nanosToUsd(usdToNanos(request.estimate.maxCostUsd));
  const deadlineAt =
    request.deadlineAt === undefined
      ? undefined
      : normalizeTimestamp(request.deadlineAt, "request.deadlineAt");
  const model =
    request.model === undefined
      ? undefined
      : requireNonEmpty(request.model, "request.model");
  const provider =
    request.provider === undefined
      ? undefined
      : requireNonEmpty(request.provider, "request.provider");
  const seenScopes = new Set<string>();
  const budgetScopes = request.budgetScopes?.map((scope) => {
    const key = requireNonEmpty(scope.key, "budget scope key");
    if (seenScopes.has(key)) {
      throw new ExecutionAdmissionStateError(
        `duplicate admission budget scope: ${key}`,
      );
    }
    seenScopes.add(key);
    const normalized: AdmissionBudgetScope = {
      key,
      ...(scope.parentKey !== undefined
        ? { parentKey: requireNonEmpty(scope.parentKey, `${key}.parentKey`) }
        : {}),
      ...(scope.maxTokens !== undefined
        ? {
            maxTokens: normalizeNonNegativeInteger(
              scope.maxTokens,
              `${key}.maxTokens`,
            ),
          }
        : {}),
      ...(scope.maxCostUsd !== undefined
        ? { maxCostUsd: nanosToUsd(usdToNanos(scope.maxCostUsd)) }
        : {}),
    };
    return normalized;
  });
  return {
    step: {
      runId,
      stepId,
      ...(parentRunId !== undefined ? { parentRunId } : {}),
    },
    kind: request.kind,
    estimate: { maxInputTokens, maxOutputTokens, maxCostUsd },
    workspaceId,
    sessionId,
    ...(budgetIdentity !== undefined ? { budgetIdentity } : {}),
    autonomous: request.autonomous,
    ...(parentScopeId !== undefined ? { parentScopeId } : {}),
    ...(deadlineAt !== undefined ? { deadlineAt } : {}),
    ...(budgetScopes !== undefined ? { budgetScopes } : {}),
    ...(request.approvalRequired !== undefined
      ? { approvalRequired: request.approvalRequired === true }
      : {}),
    ...(denialReason !== undefined ? { denialReason } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(provider !== undefined ? { provider } : {}),
  };
}

function parseRequest(value: string): RuntimeAdmissionRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (cause) {
    throw new ExecutionAdmissionStateError(
      "persisted admission request is invalid JSON",
      { cause },
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ExecutionAdmissionStateError(
      "persisted admission request is not an object",
    );
  }
  // M3 development builds briefly persisted `parentId`. Decode that durable
  // shape only at the storage boundary and immediately normalize it to the
  // frozen `parentScopeId` contract; new enqueue callers must use the contract.
  return normalizeAdmissionRequest(parsed as RuntimeAdmissionRequest, {
    allowLegacyParentId: true,
  });
}

function requestsMatch(
  left: RuntimeAdmissionRequest,
  right: RuntimeAdmissionRequest,
): boolean {
  // Requests persisted by pre-budget-identity M3 development builds have no
  // identity field. Permit their original logical step to reattach after an
  // upgrade; every newly persisted request carries and compares the field.
  if (left.budgetIdentity === undefined) {
    const { budgetIdentity: _leftIdentity, ...legacyLeft } = left;
    const { budgetIdentity: _rightIdentity, ...compatibleRight } = right;
    return JSON.stringify(legacyLeft) === JSON.stringify(compatibleRight);
  }
  return JSON.stringify(left) === JSON.stringify(right);
}

function budgetIdentityForRequest(request: RuntimeAdmissionRequest): string {
  if (request.budgetIdentity !== undefined) return request.budgetIdentity;
  for (const scope of request.budgetScopes ?? []) {
    const match = /^period:agent:(.*):(day|month):[^:]+$/.exec(scope.key);
    if (match?.[1] !== undefined) {
      try {
        return decodeURIComponent(match[1]);
      } catch {
        return match[1];
      }
    }
  }
  const rootRunScope = (request.budgetScopes ?? []).find(
    (scope) => scope.parentKey === undefined && scope.key.startsWith("run:"),
  );
  return rootRunScope?.key.slice("run:".length) ?? request.step.runId;
}

function attemptForRecord(record: PersistedAdmissionRecord): AdmissionAttempt {
  if (record.status === "queued") {
    return { decision: { decision: "queue", reason: record.reason }, record };
  }
  if (record.status === "approval_required") {
    return {
      decision: { decision: "approval_required", reason: record.reason },
      record,
    };
  }
  if (record.status === "running" && record.reservation !== undefined) {
    return {
      decision: { decision: "allow", hold: record.reservation },
      record,
    };
  }
  return {
    decision: {
      decision: "deny",
      reason:
        record.reason ??
        (FINAL_JOB_STATUSES.has(record.status)
          ? "admission_already_terminal"
          : "admission_not_claimable"),
    },
    record,
  };
}

function budgetReservationFromRow(row: ReservationRow): BudgetReservation {
  return {
    reservationId: row.reservation_id,
    step: {
      runId: row.run_id,
      stepId: row.step_id,
      ...(row.parent_run_id !== null ? { parentRunId: row.parent_run_id } : {}),
    },
    reservedCostUsd: nanosToUsd(row.reserved_cost_nanos),
    reservedTokens: row.reserved_tokens,
    reservedAt: row.created_at,
  };
}

function reservationFromRow(
  row: ReservationRow,
): PersistedAdmissionReservation {
  const status = normalizeReservationStatus(row.status);
  return {
    reservationId: row.reservation_id,
    jobId: row.job_id,
    attempt: row.attempt,
    reservation: budgetReservationFromRow(row),
    kind: normalizeAdmissionKind(row.kind),
    status,
    reservedInputTokens: row.reserved_input_tokens,
    reservedOutputTokens: row.reserved_output_tokens,
    updatedAt: row.updated_at,
    ...(row.model !== null ? { model: row.model } : {}),
    ...(row.provider !== null ? { provider: row.provider } : {}),
    ...(row.actual_input_tokens !== null
      ? { actualInputTokens: row.actual_input_tokens }
      : {}),
    ...(row.actual_output_tokens !== null
      ? { actualOutputTokens: row.actual_output_tokens }
      : {}),
    ...(row.actual_tokens !== null ? { actualTokens: row.actual_tokens } : {}),
    ...(row.actual_tokens !== null
      ? {
          actualCostUsd:
            row.actual_cost_nanos === null
              ? null
              : nanosToUsd(row.actual_cost_nanos),
        }
      : {}),
    ...(row.provider_request_id !== null
      ? { providerRequestId: row.provider_request_id }
      : {}),
    ...(row.dispatched_at !== null ? { dispatchedAt: row.dispatched_at } : {}),
    ...(row.resolved_at !== null ? { resolvedAt: row.resolved_at } : {}),
    ...(row.resolution_reason !== null
      ? { resolutionReason: row.resolution_reason }
      : {}),
  };
}

function allocationFromRow(row: AllocationRow): PersistedAdmissionAllocation {
  return {
    key: row.scope_key,
    ownerRunId: row.owner_run_id,
    usedTokens: row.used_tokens,
    usedCostUsd: nanosToUsd(row.used_cost_nanos),
    heldTokens: row.held_tokens,
    heldCostUsd: nanosToUsd(row.held_cost_nanos),
    blockedByProviderOverrun: row.blocked_by_provider_overrun === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.parent_scope_key !== null
      ? { parentKey: row.parent_scope_key }
      : {}),
    ...(row.max_tokens !== null ? { maxTokens: row.max_tokens } : {}),
    ...(row.max_cost_nanos !== null
      ? { maxCostUsd: nanosToUsd(row.max_cost_nanos) }
      : {}),
  };
}

function journalFromRow(row: JournalRow): AdmissionJournalEvent {
  const details = parseDetails(row.details_json);
  return {
    sequence: row.sequence,
    eventId: row.event_id,
    timestamp: row.timestamp,
    runId: row.run_id,
    stepId: row.step_id,
    kind: normalizeAdmissionKind(row.kind),
    event: normalizeJournalEvent(row.event),
    ...(row.reason !== null ? { reason: row.reason } : {}),
    ...(row.reservation_id !== null
      ? { reservationId: row.reservation_id }
      : {}),
    ...(row.model !== null ? { model: row.model } : {}),
    ...(row.provider !== null ? { provider: row.provider } : {}),
    ...(row.reserved_cost_nanos !== null
      ? { reservedCostUsd: nanosToUsd(row.reserved_cost_nanos) }
      : {}),
    ...(row.reserved_tokens !== null
      ? { reservedTokens: row.reserved_tokens }
      : {}),
    ...(row.actual_cost_nanos !== null
      ? { actualCostUsd: nanosToUsd(row.actual_cost_nanos) }
      : {}),
    ...(row.actual_tokens !== null ? { actualTokens: row.actual_tokens } : {}),
    ...(Object.keys(details).length > 0 ? { details } : {}),
  };
}

function parseDetails(value: string): Readonly<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (cause) {
    throw new ExecutionAdmissionStateError(
      "persisted admission journal details are invalid JSON",
      { cause },
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ExecutionAdmissionStateError(
      "persisted admission journal details are not an object",
    );
  }
  return parsed as Readonly<Record<string, unknown>>;
}

function normalizePersistedStatus(value: string): PersistedAdmissionStatus {
  switch (value) {
    case "queued":
    case "running":
    case "reconciled":
    case "voided":
    case "held_unknown":
    case "provider_overrun":
    case "denied":
    case "approval_required":
    case "cancelled":
      return value;
    default:
      throw new ExecutionAdmissionStateError(
        `invalid persisted admission status: ${value}`,
      );
  }
}

function normalizeReservationStatus(
  value: string,
): PersistedAdmissionReservation["status"] {
  switch (value) {
    case "reserved":
    case "dispatched":
    case "reconciled":
    case "voided":
    case "held_unknown":
    case "provider_overrun":
      return value;
    default:
      throw new ExecutionAdmissionStateError(
        `invalid persisted reservation status: ${value}`,
      );
  }
}

function normalizeFinalReservationStatus(
  value: string,
): "reconciled" | "voided" | "held_unknown" | "provider_overrun" {
  if (
    value === "reconciled" ||
    value === "voided" ||
    value === "held_unknown" ||
    value === "provider_overrun"
  ) {
    return value;
  }
  throw new ExecutionAdmissionStateError(`reservation is not final: ${value}`);
}

function normalizeAdmissionKind(
  value: string,
): RuntimeAdmissionRequest["kind"] {
  if (value === "model_turn" || value === "tool_exec" || value === "spawn") {
    return value;
  }
  throw new ExecutionAdmissionStateError(
    `invalid persisted admission kind: ${value}`,
  );
}

function normalizeJournalEvent(value: string): AdmissionJournalEvent["event"] {
  switch (value) {
    case "queued":
    case "allowed":
    case "denied":
    case "approval_required":
    case "dispatched":
    case "reconciled":
    case "voided":
    case "held_unknown":
    case "provider_overrun":
    case "cancelled":
    case "recovered":
    case "fallback":
      return value;
    default:
      throw new ExecutionAdmissionStateError(
        `invalid persisted admission journal event: ${value}`,
      );
  }
}

function normalizeUsage(usage: AdmissionUsage): AdmissionUsage {
  const inputTokens = normalizeNonNegativeInteger(
    usage.inputTokens,
    "usage.inputTokens",
  );
  const outputTokens = normalizeNonNegativeInteger(
    usage.outputTokens,
    "usage.outputTokens",
  );
  checkedTokenSum(inputTokens, outputTokens);
  const costUsd =
    usage.costUsd === null ? null : nanosToUsd(usdToNanos(usage.costUsd));
  return { inputTokens, outputTokens, costUsd };
}

function requireNonEmpty(value: string, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ExecutionAdmissionStateError(
      `${field} must be a non-empty string`,
    );
  }
  return value;
}

function normalizeTimestamp(value: string, field: string): string {
  requireNonEmpty(value, field);
  const time = Date.parse(value);
  if (!Number.isFinite(time)) {
    throw new ExecutionAdmissionStateError(`${field} must be an ISO timestamp`);
  }
  return new Date(time).toISOString();
}

function earliestTimestamp(
  left: string | undefined,
  right: string | undefined,
): string | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return left <= right ? left : right;
}

function normalizeNonNegativeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ExecutionAdmissionStateError(
      `${field} must be a non-negative safe integer`,
    );
  }
  return value;
}

function normalizePriority(value: number): number {
  if (!Number.isSafeInteger(value)) {
    throw new ExecutionAdmissionStateError("priority must be a safe integer");
  }
  return value;
}

function normalizeOwnerPid(value: number): number {
  return normalizeNonNegativeInteger(value, "ownerPid");
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined) return 100;
  if (!Number.isInteger(value) || value <= 0 || value > MAX_LIST_LIMIT) {
    throw new ExecutionAdmissionStateError(
      `limit must be an integer from 1 through ${MAX_LIST_LIMIT}`,
    );
  }
  return value;
}

function checkedTokenSum(...values: readonly number[]): number {
  let total = 0;
  for (const value of values) {
    normalizeNonNegativeInteger(value, "token count");
    total += value;
    if (!Number.isSafeInteger(total)) {
      throw new ExecutionAdmissionStateError(
        "token sum exceeds safe integer range",
      );
    }
  }
  return total;
}

function checkedNanoSum(...values: readonly number[]): number {
  let total = 0;
  for (const value of values) {
    normalizeNonNegativeInteger(value, "nano-USD count");
    total += value;
    if (!Number.isSafeInteger(total)) {
      throw new ExecutionAdmissionStateError(
        "nano-USD sum exceeds safe integer range",
      );
    }
  }
  return total;
}
