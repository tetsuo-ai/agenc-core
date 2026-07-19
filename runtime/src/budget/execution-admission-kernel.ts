import { randomUUID } from "node:crypto";

import type {
  AdmissionAttempt,
  AdmissionBudgetScope,
  AdmissionGrant,
  AdmissionJournalEvent,
  AdmissionLease,
  AdmissionReconcileResult,
  AdmissionUsage,
  PersistedAdmissionRecord,
  RuntimeAdmissionRequest,
} from "./admission-types.js";
import {
  admissionPeriodScopeKey,
  admissionRecordKey,
} from "./admission-types.js";
import type {
  AdmissionAcquireInput,
  AdmissionClientScope,
  AdmissionDispatchEvidence,
  ExecutionAdmissionClient,
} from "./admission-client.js";
import { AdmissionDeniedError } from "./admission-client.js";
import type { AdmissionConcurrencyLimits } from "./admission-types.js";
import type { ExecutionAdmissionBudgetPolicy } from "./admission-config.js";
import { DEFAULT_ADMISSION_CONCURRENCY_LIMITS } from "./admission-config.js";
import {
  ExecutionAdmissionRepository,
  type PersistedAdmissionReservation,
} from "../state/execution-admission.js";
import {
  cancelRunTreeAndAdmission,
  reconcileAdmissionAndRunTree,
} from "../state/run-admission-cancellation.js";
import {
  discoverStateDatabasePaths,
  openStateDatabasePaths,
  resolveStateDatabasePaths,
  type StateDatabasePaths,
  type StateSqliteDriver,
} from "../state/sqlite-driver.js";
import { AsyncLock } from "../utils/async-lock.js";
import { hitM4DurabilityFailpoint } from "../durability/failpoints.js";
import { recoverExecutionAdmissionCanonicalJournals } from "../state/execution-admission-canonical-recovery.js";

const DEFAULT_QUEUE_AGING_MS = 30_000;
const JOURNAL_PAGE_SIZE = 1_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

interface DeadlineTimer {
  cancel(): void;
}

interface WorkspaceBinding {
  readonly workspaceId: string;
  readonly paths: StateDatabasePaths;
  readonly driver: StateSqliteDriver;
  readonly repository: ExecutionAdmissionRepository;
  readonly aliases: Set<string>;
  lastJournalSequence: number;
}

interface ActiveCapacity {
  readonly reservationId: string;
  readonly key: string;
  readonly binding: WorkspaceBinding;
  readonly runId: string;
  readonly parentRunId?: string;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly parentScopeId: string;
  readonly provider?: string;
  readonly controller: AbortController;
  readonly sourceSignal?: AbortSignal;
  onSourceAbort?: () => void;
  deadlineTimer?: DeadlineTimer;
}

interface PendingAdmission {
  readonly key: string;
  readonly binding: WorkspaceBinding;
  readonly record: PersistedAdmissionRecord;
  resolve?: (lease: AdmissionLease) => void;
  reject?: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
  deadlineTimer?: DeadlineTimer;
}

interface ClientBudgetState {
  readonly scopes: readonly AdmissionBudgetScope[];
  readonly runAllocationKey: string;
  /** Durable root-agent identity for cumulative calendar-window caps. */
  readonly periodIdentity: string;
  readonly periodPolicy?: Pick<
    ExecutionAdmissionBudgetPolicy,
    "dailyUsd" | "monthlyUsd" | "dailyTokens" | "monthlyTokens"
  >;
}

interface ClientBinding {
  readonly workspace: WorkspaceBinding;
  readonly scope: AdmissionClientScope;
  readonly budget: ClientBudgetState;
  readonly stepPrefix?: string;
}

export interface ExecutionAdmissionKernelOptions {
  readonly agencHome: string;
  readonly limits?: AdmissionConcurrencyLimits;
  readonly queueAgingMs?: number;
  readonly ownerId?: string;
  readonly ownerPid?: number;
  readonly now?: () => Date;
  readonly id?: () => string;
}

export interface BindExecutionAdmissionClientOptions {
  readonly cwd: string;
  readonly workspaceId?: string;
  /**
   * Stable root-agent identity for daily/monthly caps. Defaults to the durable
   * workspace identity so creating a new conversation cannot mint headroom.
   */
  readonly budgetIdentity?: string;
  readonly projectRootMarkers?: readonly string[];
  readonly scope: Omit<AdmissionClientScope, "workspaceId" | "budgetIdentity">;
  readonly budget?: ExecutionAdmissionBudgetPolicy;
}

export interface ExecutionAdmissionRecoverySummary {
  readonly databases: number;
  readonly requeued: number;
  readonly heldUnknown: number;
  readonly expired: number;
  readonly detachedQueued: number;
}

export interface ExecutionAdmissionCancellationSummary {
  readonly affectedRunIds: readonly string[];
  readonly voidedReservations: number;
  readonly heldUnknownReservations: number;
}

/**
 * The single process-wide authority for model, tool and spawn execution.
 *
 * SQLite owns durable ordering, budget conservation and state transitions;
 * this daemon-owned layer owns cross-workspace capacity and wakeups. No work
 * reaches a provider/tool/spawn commit boundary without an allowed lease.
 */
export class ExecutionAdmissionKernel {
  readonly #agencHome: string;
  readonly #ownerId: string;
  readonly #ownerPid: number;
  readonly #now: () => Date;
  readonly #id: () => string;
  readonly #queueAgingMs: number;
  readonly #scheduler = new AsyncLock<void>(undefined);
  readonly #byStatePath = new Map<string, WorkspaceBinding>();
  readonly #byWorkspace = new Map<string, WorkspaceBinding>();
  readonly #runStatePath = new Map<string, string>();
  readonly #active = new Map<string, ActiveCapacity>();
  readonly #pending = new Map<string, PendingAdmission>();
  readonly #listeners = new Map<
    string,
    Set<(event: AdmissionJournalEvent) => void>
  >();
  readonly #criticalListeners = new Map<
    string,
    Set<(event: AdmissionJournalEvent) => void>
  >();
  #limits: AdmissionConcurrencyLimits;
  #drainScheduled = false;
  #closed = false;

  constructor(options: ExecutionAdmissionKernelOptions) {
    this.#agencHome = options.agencHome;
    this.#ownerId = options.ownerId ?? `daemon:${process.pid}:${randomUUID()}`;
    this.#ownerPid = options.ownerPid ?? process.pid;
    this.#now = options.now ?? (() => new Date());
    this.#id = options.id ?? randomUUID;
    this.#queueAgingMs = normalizePositiveInteger(
      options.queueAgingMs,
      DEFAULT_QUEUE_AGING_MS,
    );
    this.#limits = normalizeLimits(
      options.limits ?? DEFAULT_ADMISSION_CONCURRENCY_LIMITS,
    );
  }

  get limits(): AdmissionConcurrencyLimits {
    return this.#limits;
  }

  get activeCount(): number {
    return this.#active.size;
  }

  get queuedCount(): number {
    return this.#pending.size;
  }

  /** Open and recover every existing project DB before daemon readiness. */
  initializeExistingState(): ExecutionAdmissionRecoverySummary {
    this.#assertOpen();
    const totals = {
      databases: 0,
      requeued: 0,
      heldUnknown: 0,
      expired: 0,
      detachedQueued: 0,
    };
    for (const paths of discoverStateDatabasePaths(this.#agencHome)) {
      const binding = this.#registerPaths(paths, paths.projectDir, false);
      const report = binding.repository.recover({
        now: this.#timestamp(),
        activeOwnerIds: new Set(),
      });
      totals.databases += 1;
      totals.requeued += report.requeuedJobIds.length;
      totals.heldUnknown += report.heldUnknownReservationIds.length;
      totals.expired += report.cancelledExpiredJobIds.length;
      totals.detachedQueued += report.detachedQueuedJobIds.length;
      recoverExecutionAdmissionCanonicalJournals(
        binding.driver,
        binding.repository,
      );
      this.#hydrateQueued(binding);
      this.#publishNewJournal(binding);
    }
    return totals;
  }

  bindClient(
    options: BindExecutionAdmissionClientOptions,
  ): ExecutionAdmissionClient {
    this.#assertOpen();
    const paths = resolveStateDatabasePaths({
      cwd: options.cwd,
      agencHome: this.#agencHome,
      ...(options.projectRootMarkers !== undefined
        ? { projectRootMarkers: options.projectRootMarkers }
        : {}),
    });
    const workspaceId = options.workspaceId ?? paths.projectDir;
    const workspace = this.#registerPaths(paths, workspaceId);
    this.#bindRunWorkspace(options.scope.runId, workspace);
    const deadlineAt = workspace.repository.bindRunDeadline(
      options.scope.runId,
      earliestDeadline(options.scope.deadlineAt, options.budget?.deadlineAt),
    );
    const scope: AdmissionClientScope = {
      ...options.scope,
      workspaceId: workspace.workspaceId,
      budgetIdentity: normalizeBudgetIdentity(
        options.budgetIdentity ?? workspace.workspaceId,
      ),
      ...(deadlineAt !== undefined ? { deadlineAt } : {}),
      ...(minimumDefined(
        options.scope.maxCostUsd,
        options.budget?.runMaxCostUsd,
      ) !== undefined
        ? {
            maxCostUsd: minimumDefined(
              options.scope.maxCostUsd,
              options.budget?.runMaxCostUsd,
            ),
          }
        : {}),
      ...(minimumDefined(
        options.scope.maxTokens,
        options.budget?.runMaxTokens,
      ) !== undefined
        ? {
            maxTokens: minimumDefined(
              options.scope.maxTokens,
              options.budget?.runMaxTokens,
            ),
          }
        : {}),
      ...(options.scope.maxCostUsd !== undefined ||
      options.budget?.dailyUsd !== undefined ||
      options.budget?.monthlyUsd !== undefined ||
      options.budget?.runMaxCostUsd !== undefined
        ? { hasHardCostCap: true }
        : {}),
      ...(options.scope.maxTokens !== undefined ||
      options.budget?.dailyTokens !== undefined ||
      options.budget?.monthlyTokens !== undefined ||
      options.budget?.runMaxTokens !== undefined
        ? { hasHardTokenCap: true }
        : {}),
    };
    if (deadlineAt !== undefined && deadlineAt <= this.#timestamp()) {
      this.cancelRun(options.scope.runId, "deadline_expired");
    }
    const budget = rootBudgetState(scope, options.budget);
    return new KernelAdmissionClient(this, { workspace, scope, budget });
  }

  updateLimits(limits: AdmissionConcurrencyLimits): void {
    this.#limits = normalizeLimits(limits);
    this.#scheduleDrain();
  }

  /** Durable explicit decision API, useful for protocol/contract adapters. */
  admit(
    binding: ClientBinding,
    input: AdmissionAcquireInput,
  ): AdmissionAttempt {
    this.#assertOpen();
    const request = requestFor(binding, input, this.#now());
    const attempt = binding.workspace.repository.enqueue(request, {
      ownerId: this.#ownerId,
      ownerPid: this.#ownerPid,
      attached: true,
    });
    this.#publishNewJournal(binding.workspace);
    return attempt;
  }

  acquire(
    binding: ClientBinding,
    input: AdmissionAcquireInput,
    signal?: AbortSignal,
  ): Promise<AdmissionLease> {
    const attempt = this.admit(binding, input);
    if (attempt.decision.decision === "deny") {
      return Promise.reject(
        new AdmissionDeniedError(attempt.decision.reason ?? "denied"),
      );
    }
    if (attempt.decision.decision === "approval_required") {
      return Promise.reject(
        new AdmissionDeniedError(
          attempt.decision.reason ?? "approval_required",
          "approval_required",
        ),
      );
    }
    if (
      attempt.decision.decision === "allow" &&
      attempt.record.reservation !== undefined
    ) {
      if (this.#active.has(attempt.record.reservation.reservationId)) {
        return Promise.reject(
          new AdmissionDeniedError("admission_step_already_running"),
        );
      }
      return Promise.resolve(
        this.#activateGrant(
          binding.workspace,
          {
            decision: "allow",
            reservation: attempt.record.reservation,
            request: attempt.record.request,
          },
          signal,
        ),
      );
    }

    const existing = this.#pending.get(attempt.record.key);
    if (existing !== undefined) {
      if (existing.resolve !== undefined || existing.reject !== undefined) {
        return Promise.reject(
          new AdmissionDeniedError("admission_step_already_waiting"),
        );
      }
      if (
        existing.binding.paths.stateDbPath !==
        binding.workspace.paths.stateDbPath
      ) {
        return Promise.reject(
          new AdmissionDeniedError("admission_step_workspace_conflict"),
        );
      }
      return this.#attachPending(existing, signal);
    }

    const pending = this.#createDetachedPending(
      binding.workspace,
      attempt.record,
    );
    this.#pending.set(pending.key, pending);
    return this.#attachPending(pending, signal);
  }

  markDispatched(
    reservationId: string,
    evidence: AdmissionDispatchEvidence,
  ): void {
    const active = this.#active.get(reservationId);
    if (active?.controller.signal.aborted === true) {
      throw new AdmissionDeniedError(
        abortReason(active.controller.signal, "admission_cancelled"),
        "cancelled",
      );
    }
    const found = this.#findReservation(reservationId);
    if (found === undefined) {
      throw new AdmissionDeniedError("reservation_not_found");
    }
    const record = found.binding.repository.markDispatched(reservationId, {
      ...(evidence.timestamp !== undefined
        ? { dispatchedAt: evidence.timestamp }
        : {}),
      ...(evidence.providerRequestId !== undefined
        ? { providerRequestId: evidence.providerRequestId }
        : {}),
      details: {
        ...(evidence.details ?? {}),
        boundary: evidence.boundary,
      },
    });
    this.#publishNewJournal(found.binding);
    if (record.status !== "running") {
      const error = new AdmissionDeniedError(
        record.reason ?? "admission_no_longer_active",
        "cancelled",
      );
      // Cancellation is durable at this point, but the caller still owns the
      // admitted boundary. Keep its capacity occupied until that boundary
      // acknowledges termination through void/holdUnknown/reconcile. Otherwise
      // an abort-ignoring provider or tool can overlap replacement work.
      if (active !== undefined) this.#abortActive(active, error);
      throw error;
    }
  }

  reconcile(
    reservationId: string,
    usage: AdmissionUsage,
  ): AdmissionReconcileResult {
    const found = this.#requireReservation(reservationId);
    const reconciled = reconcileAdmissionAndRunTree(
      found.binding.driver,
      found.binding.repository,
      {
        reservationId,
        input: { kind: "reported", usage },
        reconciledAt: this.#timestamp(),
      },
    );
    const result = reconciled.admission;
    this.#finishCapacity(reservationId);
    this.#publishNewJournal(found.binding);
    if (reconciled.run !== undefined) {
      // The durable agent/admission cascade already committed atomically.
      // Reuse cancelRun for live controllers and queues; its durable retry is
      // idempotent and repairs any additional registered workspace bindings.
      this.cancelRun(
        found.reservation.reservation.step.runId,
        "provider_overrun",
      );
      return result;
    }
    this.#scheduleDrain();
    return result;
  }

  holdUnknown(reservationId: string, reason: string): void {
    const found = this.#requireReservation(reservationId);
    found.binding.repository.holdUnknown(reservationId, reason);
    this.#finishCapacity(reservationId);
    this.#publishNewJournal(found.binding);
    this.#scheduleDrain();
  }

  void(reservationId: string, reason: string): void {
    const found = this.#requireReservation(reservationId);
    found.binding.repository.void(reservationId, reason);
    this.#finishCapacity(reservationId);
    this.#publishNewJournal(found.binding);
    this.#scheduleDrain();
  }

  acknowledgeCompletion(reservationId: string): void {
    // Durable settlement methods also release capacity on their success path.
    // Keeping this acknowledgement idempotent lets boundary `finally` blocks
    // cover cancellation-only and settlement-error paths exactly once.
    this.#finishCapacity(reservationId);
    this.#scheduleDrain();
  }

  recordFallback(
    binding: ClientBinding,
    event: Parameters<ExecutionAdmissionClient["recordFallback"]>[0],
  ): void {
    const key = admissionRecordKey({
      runId: binding.scope.runId,
      stepId: stepIdFor(binding, event.stepId),
      ...(binding.scope.parentRunId !== undefined
        ? { parentRunId: binding.scope.parentRunId }
        : {}),
    });
    binding.workspace.repository.recordFallback(key, {
      reason: event.reason,
      model: event.toModel,
      ...(event.toProvider !== undefined ? { provider: event.toProvider } : {}),
      details: {
        fromModel: event.fromModel,
        toModel: event.toModel,
        ...(event.fromProvider !== undefined
          ? { fromProvider: event.fromProvider }
          : {}),
        ...(event.toProvider !== undefined
          ? { toProvider: event.toProvider }
          : {}),
      },
    });
    this.#publishNewJournal(binding.workspace);
  }

  forSession(
    binding: ClientBinding,
    options: Parameters<ExecutionAdmissionClient["forSession"]>[0],
  ): ExecutionAdmissionClient {
    const runId = options.runId ?? binding.scope.runId;
    const createsChildRun = runId !== binding.scope.runId;
    const expectedParentRunId = createsChildRun
      ? binding.scope.runId
      : binding.scope.parentRunId;
    if (
      options.parentRunId !== undefined &&
      options.parentRunId !== expectedParentRunId
    ) {
      throw new AdmissionDeniedError("admission_parent_run_conflict");
    }
    const parentRunId = options.parentRunId ?? expectedParentRunId;
    this.#bindRunWorkspace(runId, binding.workspace);
    const deadlineAt = binding.workspace.repository.bindRunDeadline(
      runId,
      earliestDeadline(binding.scope.deadlineAt, options.deadlineAt),
    );
    const scope: AdmissionClientScope = {
      ...binding.scope,
      runId,
      sessionId: options.sessionId,
      parentRunId,
      ...(options.parentScopeId !== undefined
        ? { parentScopeId: options.parentScopeId }
        : {}),
      ...(deadlineAt !== undefined ? { deadlineAt } : {}),
    };
    if (deadlineAt !== undefined && deadlineAt <= this.#timestamp()) {
      this.cancelRun(runId, "deadline_expired");
    }
    const runAllocationKey = allocationKey(runId);
    const budget: ClientBudgetState = createsChildRun
      ? {
          ...binding.budget,
          scopes: [
            ...binding.budget.scopes,
            {
              key: runAllocationKey,
              parentKey: binding.budget.runAllocationKey,
            },
          ],
          runAllocationKey,
        }
      : binding.budget;
    const stepPrefix = createsChildRun
      ? undefined
      : options.sessionId === binding.scope.sessionId
        ? binding.stepPrefix
        : `${binding.stepPrefix ?? ""}session:${options.sessionId}:`;
    return new KernelAdmissionClient(this, {
      workspace: binding.workspace,
      scope,
      budget,
      ...(stepPrefix !== undefined ? { stepPrefix } : {}),
    });
  }

  subscribe(
    runId: string,
    listener: (event: AdmissionJournalEvent) => void,
  ): () => void {
    const listeners = this.#listeners.get(runId) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(runId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.#listeners.delete(runId);
    };
  }

  subscribeCritical(
    runId: string,
    listener: (event: AdmissionJournalEvent) => void,
  ): () => void {
    const listeners = this.#criticalListeners.get(runId) ?? new Set();
    listeners.add(listener);
    this.#criticalListeners.set(runId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.#criticalListeners.delete(runId);
    };
  }

  replayClientJournal(
    binding: ClientBinding,
    options: {
      readonly afterSequence?: number;
      readonly limit?: number;
    } = {},
  ): readonly AdmissionJournalEvent[] {
    return binding.workspace.repository.listJournal({
      runId: binding.scope.runId,
      ...(options.afterSequence !== undefined
        ? { afterSequence: options.afterSequence }
        : {}),
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
    });
  }

  cancelRun(
    runId: string,
    reason: string,
  ): ExecutionAdmissionCancellationSummary {
    this.#assertOpen();
    const affected = new Set<string>();
    let voidedReservations = 0;
    let heldUnknownReservations = 0;
    for (const binding of this.#byStatePath.values()) {
      const report = cancelRunTreeAndAdmission(
        binding.driver,
        binding.repository,
        {
          runId,
          reason,
          cancelledAt: this.#timestamp(),
        },
      ).admission;
      for (const id of report.affectedRunIds) affected.add(id);
      voidedReservations += report.voidedReservationIds.length;
      heldUnknownReservations += report.heldUnknownReservationIds.length;
      this.#publishNewJournal(binding);
    }
    this.#abortCancelledAdmissionWork(affected, reason);
    return {
      affectedRunIds: [...affected],
      voidedReservations,
      heldUnknownReservations,
    };
  }

  /**
   * Settle admission work without advancing the legacy agent-run projection.
   * The live run.cancel path calls this while its Session critical listener is
   * still attached, so every resulting journal row is fsync-projected before
   * the run terminal seals the canonical tail.
   */
  cancelAdmissions(
    runId: string,
    reason: string,
  ): ExecutionAdmissionCancellationSummary {
    this.#assertOpen();
    const affected = new Set<string>();
    let voidedReservations = 0;
    let heldUnknownReservations = 0;
    for (const binding of this.#byStatePath.values()) {
      const report = binding.repository.cancel(runId, {
        reason,
        cancelledAt: this.#timestamp(),
      });
      for (const id of report.affectedRunIds) affected.add(id);
      voidedReservations += report.voidedReservationIds.length;
      heldUnknownReservations += report.heldUnknownReservationIds.length;
      this.#publishNewJournal(binding);
    }
    this.#abortCancelledAdmissionWork(affected, reason);
    return {
      affectedRunIds: [...affected],
      voidedReservations,
      heldUnknownReservations,
    };
  }

  #abortCancelledAdmissionWork(
    affected: ReadonlySet<string>,
    reason: string,
  ): void {
    for (const [key, pending] of this.#pending) {
      if (
        !affected.has(pending.record.request.step.runId) &&
        (pending.record.request.step.parentRunId === undefined ||
          !affected.has(pending.record.request.step.parentRunId))
      ) {
        continue;
      }
      this.#settlePending(
        pending,
        new AdmissionDeniedError(reason, "cancelled"),
      );
      this.#pending.delete(key);
    }
    for (const active of this.#active.values()) {
      if (
        affected.has(active.runId) ||
        (active.parentRunId !== undefined && affected.has(active.parentRunId))
      ) {
        // Durable cancellation and budget holding happen above. Capacity is a
        // live-process fact and remains occupied until the admitted boundary's
        // promise actually settles and calls reconcile/holdUnknown/void.
        this.#abortActive(
          active,
          new AdmissionDeniedError(reason, "cancelled"),
        );
      }
    }
    this.#scheduleDrain();
  }

  listJournal(params: {
    readonly cwd: string;
    readonly projectRootMarkers?: readonly string[];
    readonly runId?: string;
    readonly afterSequence?: number;
    readonly limit?: number;
  }): readonly AdmissionJournalEvent[] {
    const paths = resolveStateDatabasePaths({
      cwd: params.cwd,
      agencHome: this.#agencHome,
      ...(params.projectRootMarkers !== undefined
        ? { projectRootMarkers: params.projectRootMarkers }
        : {}),
    });
    const binding = this.#registerPaths(paths, paths.projectDir);
    return binding.repository.listJournal({
      ...(params.runId !== undefined ? { runId: params.runId } : {}),
      ...(params.afterSequence !== undefined
        ? { afterSequence: params.afterSequence }
        : {}),
      ...(params.limit !== undefined ? { limit: params.limit } : {}),
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#pending.values()) {
      // Queue rows are durable work. Closing a daemon rejects only the live
      // waiter; startup recovery detaches the stale owner and preserves the
      // original queue sequence for reattachment.
      this.#settlePending(
        pending,
        new AdmissionDeniedError("admission_kernel_closed"),
      );
    }
    for (const active of this.#active.values()) {
      active.binding.repository.cancelStep(active.key, {
        reason: "admission_kernel_closed",
      });
      this.#publishNewJournal(active.binding);
      this.#abortAndReleaseActive(
        active,
        new AdmissionDeniedError("admission_kernel_closed", "cancelled"),
      );
    }
    this.#pending.clear();
    this.#active.clear();
    this.#listeners.clear();
    this.#criticalListeners.clear();
    for (const binding of this.#byStatePath.values()) {
      binding.driver.close();
    }
    this.#byStatePath.clear();
    this.#byWorkspace.clear();
    this.#runStatePath.clear();
  }

  #registerPaths(
    paths: StateDatabasePaths,
    workspaceAlias: string,
    recover = true,
  ): WorkspaceBinding {
    const existing = this.#byStatePath.get(paths.stateDbPath);
    if (existing !== undefined) {
      existing.aliases.add(workspaceAlias);
      this.#byWorkspace.set(workspaceAlias, existing);
      return existing;
    }
    const driver = openStateDatabasePaths(paths);
    const binding: WorkspaceBinding = {
      workspaceId: paths.projectDir,
      paths,
      driver,
      repository: new ExecutionAdmissionRepository(driver, {
        now: this.#now,
        id: this.#id,
        ownerId: this.#ownerId,
        ownerPid: this.#ownerPid,
      }),
      aliases: new Set([workspaceAlias, paths.projectDir]),
      lastJournalSequence: 0,
    };
    this.#byStatePath.set(paths.stateDbPath, binding);
    for (const alias of binding.aliases) this.#byWorkspace.set(alias, binding);
    for (const runId of binding.repository.listBoundRunIds()) {
      this.#bindRunWorkspace(runId, binding);
    }
    if (recover) {
      // A newly discovered workspace is recovered before its first admission.
      binding.repository.recover({
        now: this.#timestamp(),
        activeOwnerIds: new Set([this.#ownerId]),
      });
      recoverExecutionAdmissionCanonicalJournals(
        binding.driver,
        binding.repository,
      );
      this.#hydrateQueued(binding);
      this.#publishNewJournal(binding);
    }
    return binding;
  }

  #bindRunWorkspace(runId: string, binding: WorkspaceBinding): void {
    const existing = this.#runStatePath.get(runId);
    if (existing !== undefined && existing !== binding.paths.stateDbPath) {
      throw new AdmissionDeniedError("admission_run_workspace_conflict");
    }
    this.#runStatePath.set(runId, binding.paths.stateDbPath);
  }

  #scheduleDrain(): void {
    if (this.#drainScheduled || this.#closed) return;
    this.#drainScheduled = true;
    queueMicrotask(() => {
      void this.#scheduler
        .with(() => {
          this.#drainScheduled = false;
          this.#drainQueue();
        })
        .catch((error: unknown) => this.#handleSchedulerFailure(error));
    });
  }

  #handleSchedulerFailure(error: unknown): void {
    this.#drainScheduled = false;
    const detail = error instanceof Error ? error.message : String(error);
    const failure = new AdmissionDeniedError(
      `admission_scheduler_failed:${detail}`,
    );
    for (const [key, pending] of this.#pending) {
      if (pending.resolve === undefined && pending.reject === undefined) {
        continue;
      }
      this.#settlePending(pending, failure);
      this.#pending.delete(key);
    }
  }

  #drainQueue(): void {
    if (this.#closed || this.#pending.size === 0) return;
    const nowMs = this.#now().getTime();
    const pending = [...this.#pending.values()].sort((left, right) =>
      comparePending(left, right, nowMs, this.#queueAgingMs),
    );
    let earliestAvailableAt: number | undefined;
    let madeProgress = false;
    for (const entry of pending) {
      const availableAt = Date.parse(entry.record.availableAt);
      if (availableAt > nowMs) {
        earliestAvailableAt = Math.min(
          earliestAvailableAt ?? availableAt,
          availableAt,
        );
        continue;
      }
      // A recovered durable row has no executable closure until its owning
      // surface retries acquire. It retains its durable priority/sequence for
      // reattachment, but is ineligible rather than head-of-line blocking all
      // runnable work forever.
      if (entry.resolve === undefined || entry.reject === undefined) continue;
      if (!this.#hasCapacity(entry.record.request)) continue;
      // `claim()` is the transaction that creates the budget reservation and
      // changes the job from queued to running. Queue insertion is durable too,
      // but it is not a reservation commit and must not be labelled as one in
      // crash-injection evidence.
      hitM4DurabilityFailpoint("before_reservation_commit");
      const result = entry.binding.repository.claim({
        key: entry.key,
        ownerId: this.#ownerId,
        ownerPid: this.#ownerPid,
        attached: true,
        now: this.#timestamp(),
      });
      if (result.kind === "claimed") {
        // The reservation is committed while no live lease or journal
        // subscriber has been notified yet. Restart must recover solely from
        // the durable hold if the process dies here.
        hitM4DurabilityFailpoint("after_reservation_commit");
      }
      this.#publishNewJournal(entry.binding);
      if (result.kind === "claimed") {
        this.#pending.delete(entry.key);
        const lease = this.#activateGrant(
          entry.binding,
          result.lease,
          entry.signal,
        );
        this.#settlePending(entry, undefined, lease);
        madeProgress = true;
        continue;
      }
      if (result.kind === "not_claimed") {
        this.#pending.delete(entry.key);
        this.#settlePending(entry, new AdmissionDeniedError(result.reason));
        madeProgress = true;
      }
    }
    if (earliestAvailableAt !== undefined) {
      scheduleAt(earliestAvailableAt, this.#now, () => this.#scheduleDrain());
    }
    if (madeProgress && this.#pending.size > 0) this.#scheduleDrain();
  }

  #hasCapacity(request: RuntimeAdmissionRequest): boolean {
    let workspace = 0;
    let session = 0;
    let parent = 0;
    let provider = 0;
    const parentScopeId = request.parentScopeId ?? request.sessionId;
    for (const active of this.#active.values()) {
      if (active.workspaceId === request.workspaceId) workspace += 1;
      if (active.sessionId === request.sessionId) session += 1;
      if (
        active.workspaceId === request.workspaceId &&
        active.parentScopeId === parentScopeId
      ) {
        parent += 1;
      }
      if (
        request.provider !== undefined &&
        active.provider === request.provider
      ) {
        provider += 1;
      }
    }
    return (
      this.#active.size < this.#limits.global &&
      workspace < this.#limits.workspace &&
      session < this.#limits.session &&
      parent < this.#limits.parent &&
      (request.provider === undefined || provider < this.#limits.provider)
    );
  }

  #activateGrant(
    binding: WorkspaceBinding,
    grant: AdmissionGrant,
    sourceSignal?: AbortSignal,
  ): AdmissionLease {
    const reservationId = grant.reservation.reservationId;
    const controller = new AbortController();
    const active: ActiveCapacity = {
      reservationId,
      key: admissionRecordKey(grant.request.step),
      binding,
      runId: grant.request.step.runId,
      ...(grant.request.step.parentRunId !== undefined
        ? { parentRunId: grant.request.step.parentRunId }
        : {}),
      workspaceId: grant.request.workspaceId,
      sessionId: grant.request.sessionId,
      parentScopeId: grant.request.parentScopeId ?? grant.request.sessionId,
      ...(grant.request.provider !== undefined
        ? { provider: grant.request.provider }
        : {}),
      controller,
      ...(sourceSignal !== undefined ? { sourceSignal } : {}),
    };
    this.#active.set(reservationId, active);

    if (sourceSignal !== undefined) {
      active.onSourceAbort = () =>
        this.#cancelActiveStep(
          reservationId,
          abortReason(sourceSignal, "abort_signal"),
        );
      if (sourceSignal.aborted) {
        active.onSourceAbort();
      } else {
        sourceSignal.addEventListener("abort", active.onSourceAbort, {
          once: true,
        });
      }
    }

    if (
      this.#active.has(reservationId) &&
      grant.request.deadlineAt !== undefined
    ) {
      active.deadlineTimer = scheduleAt(
        Date.parse(grant.request.deadlineAt),
        this.#now,
        () => this.#cancelActiveRun(reservationId, "deadline_expired"),
      );
    }

    return { ...grant, signal: controller.signal };
  }

  #finishCapacity(reservationId: string): void {
    const active = this.#active.get(reservationId);
    if (active === undefined) return;
    this.#releaseActive(active);
  }

  #cancelActiveRun(reservationId: string, reason: string): void {
    const active = this.#active.get(reservationId);
    if (active === undefined) return;
    this.cancelRun(active.runId, reason);
  }

  #cancelActiveStep(reservationId: string, reason: string): void {
    const active = this.#active.get(reservationId);
    if (active === undefined) return;
    active.binding.repository.cancelStep(active.key, { reason });
    this.#publishNewJournal(active.binding);
    this.#abortActive(active, new AdmissionDeniedError(reason, "cancelled"));
  }

  #abortActive(active: ActiveCapacity, reason: unknown): void {
    if (!active.controller.signal.aborted) active.controller.abort(reason);
  }

  #abortAndReleaseActive(active: ActiveCapacity, reason: unknown): void {
    this.#abortActive(active, reason);
    this.#releaseActive(active);
  }

  #releaseActive(active: ActiveCapacity): void {
    if (active.deadlineTimer !== undefined) {
      active.deadlineTimer.cancel();
    }
    if (
      active.sourceSignal !== undefined &&
      active.onSourceAbort !== undefined
    ) {
      active.sourceSignal.removeEventListener("abort", active.onSourceAbort);
    }
    this.#active.delete(active.reservationId);
  }

  #hydrateQueued(binding: WorkspaceBinding): void {
    let afterQueueSequence: number | undefined;
    while (true) {
      const records = binding.repository.list({
        statuses: ["queued"],
        ...(afterQueueSequence !== undefined ? { afterQueueSequence } : {}),
        limit: 1_000,
      });
      for (const record of records) {
        const existing = this.#pending.get(record.key);
        if (existing !== undefined) {
          if (
            existing.binding.paths.stateDbPath !== binding.paths.stateDbPath
          ) {
            throw new AdmissionDeniedError("admission_step_workspace_conflict");
          }
          continue;
        }
        this.#pending.set(
          record.key,
          this.#createDetachedPending(binding, record),
        );
      }
      if (records.length < 1_000) break;
      const last = records.at(-1);
      if (last === undefined) break;
      afterQueueSequence = last.queueSequence;
    }
  }

  #createDetachedPending(
    binding: WorkspaceBinding,
    record: PersistedAdmissionRecord,
  ): PendingAdmission {
    const pending: PendingAdmission = {
      key: record.key,
      binding,
      record,
    };
    const deadline = record.request.deadlineAt;
    if (deadline !== undefined) {
      pending.deadlineTimer = scheduleAt(Date.parse(deadline), this.#now, () =>
        this.#cancelPendingRun(pending, "deadline_expired"),
      );
    }
    return pending;
  }

  #attachPending(
    pending: PendingAdmission,
    signal?: AbortSignal,
  ): Promise<AdmissionLease> {
    return new Promise<AdmissionLease>((resolve, reject) => {
      pending.resolve = resolve;
      pending.reject = reject;
      if (signal !== undefined) {
        pending.signal = signal;
        pending.onAbort = () =>
          this.#cancelPendingStep(pending, abortReason(signal, "abort_signal"));
        if (signal.aborted) {
          pending.onAbort();
          return;
        }
        signal.addEventListener("abort", pending.onAbort, { once: true });
      }
      this.#scheduleDrain();
    });
  }

  #cancelPendingRun(pending: PendingAdmission, reason: string): void {
    if (this.#pending.get(pending.key) !== pending) return;
    this.cancelRun(pending.record.request.step.runId, reason);
  }

  #cancelPendingStep(pending: PendingAdmission, reason: string): void {
    if (this.#pending.get(pending.key) !== pending) return;
    pending.binding.repository.cancelStep(pending.key, { reason });
    this.#publishNewJournal(pending.binding);
    this.#settlePending(pending, new AdmissionDeniedError(reason, "cancelled"));
    this.#pending.delete(pending.key);
    this.#scheduleDrain();
  }

  #settlePending(
    pending: PendingAdmission,
    error?: Error,
    lease?: AdmissionLease,
  ): void {
    if (pending.deadlineTimer !== undefined) {
      pending.deadlineTimer.cancel();
      delete pending.deadlineTimer;
    }
    if (pending.signal !== undefined && pending.onAbort !== undefined) {
      pending.signal.removeEventListener("abort", pending.onAbort);
    }
    const resolve = pending.resolve;
    const reject = pending.reject;
    delete pending.resolve;
    delete pending.reject;
    delete pending.signal;
    delete pending.onAbort;
    if (error !== undefined) reject?.(error);
    else if (lease !== undefined) resolve?.(lease);
  }

  #findReservation(reservationId: string):
    | {
        readonly binding: WorkspaceBinding;
        readonly reservation: PersistedAdmissionReservation;
      }
    | undefined {
    const active = this.#active.get(reservationId);
    if (active !== undefined) {
      const reservation =
        active.binding.repository.getReservation(reservationId);
      if (reservation !== undefined) {
        return { binding: active.binding, reservation };
      }
    }
    for (const binding of this.#byStatePath.values()) {
      const reservation = binding.repository.getReservation(reservationId);
      if (reservation !== undefined) return { binding, reservation };
    }
    return undefined;
  }

  #requireReservation(reservationId: string): {
    readonly binding: WorkspaceBinding;
    readonly reservation: PersistedAdmissionReservation;
  } {
    const found = this.#findReservation(reservationId);
    if (found === undefined) {
      throw new AdmissionDeniedError("reservation_not_found");
    }
    return found;
  }

  #publishNewJournal(binding: WorkspaceBinding): void {
    while (true) {
      const events = binding.repository.listJournal({
        afterSequence: binding.lastJournalSequence,
        limit: JOURNAL_PAGE_SIZE,
      });
      if (events.length === 0) return;
      for (const event of events) {
        // Admission SQLite has already committed at this point. Canonical
        // journal projection is nevertheless a physical-work boundary: a
        // critical listener must fsync the event before acquire/dispatch may
        // continue. Keep the cursor on this event when that append fails so a
        // later call can retry the idempotent projection.
        hitM4DurabilityFailpoint(
          "after_admission_sqlite_commit_before_canonical_append",
        );
        for (const listener of this.#criticalListeners.get(event.runId) ?? []) {
          listener(event);
        }
        binding.lastJournalSequence = Math.max(
          binding.lastJournalSequence,
          event.sequence,
        );
        for (const listener of this.#listeners.get(event.runId) ?? []) {
          try {
            listener(event);
          } catch {
            // Observers never get to roll back a committed admission event.
          }
        }
      }
      if (events.length < JOURNAL_PAGE_SIZE) return;
    }
  }

  #timestamp(): string {
    return this.#now().toISOString();
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new AdmissionDeniedError("admission_kernel_closed");
    }
  }
}

class KernelAdmissionClient implements ExecutionAdmissionClient {
  constructor(
    private readonly kernel: ExecutionAdmissionKernel,
    private readonly binding: ClientBinding,
  ) {}

  get scope(): AdmissionClientScope {
    return this.binding.scope;
  }

  acquire(
    input: AdmissionAcquireInput,
    signal?: AbortSignal,
  ): Promise<AdmissionLease> {
    return this.kernel.acquire(this.binding, input, signal);
  }

  markDispatched(
    reservationId: string,
    evidence: AdmissionDispatchEvidence,
  ): void {
    this.kernel.markDispatched(reservationId, evidence);
  }

  reconcile(
    reservationId: string,
    usage: AdmissionUsage,
  ): AdmissionReconcileResult {
    return this.kernel.reconcile(reservationId, usage);
  }

  holdUnknown(reservationId: string, reason: string): void {
    this.kernel.holdUnknown(reservationId, reason);
  }

  cancelRun(reason: string): void {
    this.kernel.cancelRun(this.scope.runId, reason);
  }

  cancelAdmissions(reason: string): ExecutionAdmissionCancellationSummary {
    return this.kernel.cancelAdmissions(this.scope.runId, reason);
  }

  void(reservationId: string, reason: string): void {
    this.kernel.void(reservationId, reason);
  }

  acknowledgeCompletion(reservationId: string): void {
    this.kernel.acknowledgeCompletion(reservationId);
  }

  recordFallback(
    event: Parameters<ExecutionAdmissionClient["recordFallback"]>[0],
  ): void {
    this.kernel.recordFallback(this.binding, event);
  }

  forSession(
    options: Parameters<ExecutionAdmissionClient["forSession"]>[0],
  ): ExecutionAdmissionClient {
    return this.kernel.forSession(this.binding, options);
  }

  subscribe(listener: (event: AdmissionJournalEvent) => void): () => void {
    return this.kernel.subscribe(this.scope.runId, listener);
  }

  subscribeCritical(
    listener: (event: AdmissionJournalEvent) => void,
  ): () => void {
    return this.kernel.subscribeCritical(this.scope.runId, listener);
  }

  replayJournal(options?: {
    readonly afterSequence?: number;
    readonly limit?: number;
  }): readonly AdmissionJournalEvent[] {
    return this.kernel.replayClientJournal(this.binding, options);
  }
}

function requestFor(
  binding: ClientBinding,
  input: AdmissionAcquireInput,
  now: Date,
): RuntimeAdmissionRequest {
  const deadlineAt = earliestDeadline(
    binding.scope.deadlineAt,
    input.deadlineAt,
  );
  if (
    input.parentRunId !== undefined &&
    input.parentRunId !== binding.scope.parentRunId
  ) {
    throw new AdmissionDeniedError("admission_parent_run_conflict");
  }
  const parentRunId = binding.scope.parentRunId;
  return {
    step: {
      runId: binding.scope.runId,
      stepId: stepIdFor(binding, input.stepId),
      ...(parentRunId !== undefined ? { parentRunId } : {}),
    },
    kind: input.kind,
    estimate: {
      maxInputTokens: input.maxInputTokens,
      maxOutputTokens: input.maxOutputTokens,
      maxCostUsd: input.maxCostUsd,
    },
    workspaceId: binding.workspace.workspaceId,
    sessionId: input.sessionId ?? binding.scope.sessionId,
    budgetIdentity: binding.scope.budgetIdentity,
    parentScopeId:
      input.parentScopeId ??
      binding.scope.parentScopeId ??
      input.sessionId ??
      binding.scope.sessionId,
    autonomous: binding.scope.autonomous,
    budgetScopes: budgetScopesFor(binding.budget, now),
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.provider !== undefined ? { provider: input.provider } : {}),
    ...(deadlineAt !== undefined ? { deadlineAt } : {}),
    ...(input.approvalRequired !== undefined
      ? { approvalRequired: input.approvalRequired }
      : {}),
    ...(input.denialReason !== undefined
      ? { denialReason: input.denialReason }
      : {}),
  };
}

function stepIdFor(binding: ClientBinding, stepId: string): string {
  return binding.stepPrefix === undefined
    ? stepId
    : `${binding.stepPrefix}${stepId}`;
}

function rootBudgetState(
  scope: AdmissionClientScope,
  policy: ExecutionAdmissionBudgetPolicy | undefined,
): ClientBudgetState {
  const scopes: AdmissionBudgetScope[] = [];
  const runAllocationKey = allocationKey(scope.runId);
  const runMaxCostUsd = minimumDefined(scope.maxCostUsd, policy?.runMaxCostUsd);
  const runMaxTokens = minimumDefined(scope.maxTokens, policy?.runMaxTokens);
  scopes.push({
    key: runAllocationKey,
    ...(runMaxCostUsd !== undefined ? { maxCostUsd: runMaxCostUsd } : {}),
    ...(runMaxTokens !== undefined ? { maxTokens: runMaxTokens } : {}),
  });
  const periodPolicy = periodPolicyFor(policy);
  return {
    scopes,
    runAllocationKey,
    periodIdentity: scope.budgetIdentity,
    ...(periodPolicy !== undefined ? { periodPolicy } : {}),
  };
}

function periodPolicyFor(
  policy: ExecutionAdmissionBudgetPolicy | undefined,
): ClientBudgetState["periodPolicy"] | undefined {
  if (
    policy?.dailyUsd === undefined &&
    policy?.monthlyUsd === undefined &&
    policy?.dailyTokens === undefined &&
    policy?.monthlyTokens === undefined
  ) {
    return undefined;
  }
  return {
    ...(policy.dailyUsd !== undefined ? { dailyUsd: policy.dailyUsd } : {}),
    ...(policy.monthlyUsd !== undefined
      ? { monthlyUsd: policy.monthlyUsd }
      : {}),
    ...(policy.dailyTokens !== undefined
      ? { dailyTokens: policy.dailyTokens }
      : {}),
    ...(policy.monthlyTokens !== undefined
      ? { monthlyTokens: policy.monthlyTokens }
      : {}),
  };
}

function budgetScopesFor(
  budget: ClientBudgetState,
  now: Date,
): readonly AdmissionBudgetScope[] {
  const policy = budget.periodPolicy;
  if (policy === undefined) return budget.scopes;
  const day = now.toISOString().slice(0, 10);
  const month = day.slice(0, 7);
  const periods: AdmissionBudgetScope[] = [];
  if (policy.dailyUsd !== undefined || policy.dailyTokens !== undefined) {
    periods.push({
      key: admissionPeriodScopeKey(budget.periodIdentity, "day", day),
      ...(policy.dailyUsd !== undefined ? { maxCostUsd: policy.dailyUsd } : {}),
      ...(policy.dailyTokens !== undefined
        ? { maxTokens: policy.dailyTokens }
        : {}),
    });
  }
  if (policy.monthlyUsd !== undefined || policy.monthlyTokens !== undefined) {
    periods.push({
      key: admissionPeriodScopeKey(budget.periodIdentity, "month", month),
      ...(policy.monthlyUsd !== undefined
        ? { maxCostUsd: policy.monthlyUsd }
        : {}),
      ...(policy.monthlyTokens !== undefined
        ? { maxTokens: policy.monthlyTokens }
        : {}),
    });
  }
  return [...periods, ...budget.scopes];
}

function allocationKey(runId: string): string {
  return `run:${runId}`;
}

function normalizeBudgetIdentity(value: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AdmissionDeniedError("admission_budget_identity_invalid");
  }
  return value;
}

function comparePending(
  left: PendingAdmission,
  right: PendingAdmission,
  nowMs: number,
  agingMs: number,
): number {
  const leftAge = Math.max(0, nowMs - Date.parse(left.record.enqueuedAt));
  const rightAge = Math.max(0, nowMs - Date.parse(right.record.enqueuedAt));
  const leftStarved = leftAge >= agingMs;
  const rightStarved = rightAge >= agingMs;
  if (leftStarved !== rightStarved) return leftStarved ? -1 : 1;
  if (!leftStarved && left.record.priority !== right.record.priority) {
    return right.record.priority - left.record.priority;
  }
  const byTime = left.record.enqueuedAt.localeCompare(right.record.enqueuedAt);
  if (byTime !== 0) return byTime;
  return left.record.queueSequence - right.record.queueSequence;
}

function earliestDeadline(
  ...values: readonly (string | undefined)[]
): string | undefined {
  let earliest: string | undefined;
  let earliestMs = Number.POSITIVE_INFINITY;
  for (const value of values) {
    if (value === undefined) continue;
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) return value;
    if (parsed < earliestMs) {
      earliest = new Date(parsed).toISOString();
      earliestMs = parsed;
    }
  }
  return earliest;
}

function minimumDefined(
  ...values: readonly (number | undefined)[]
): number | undefined {
  const defined = values.filter(
    (value): value is number => value !== undefined,
  );
  return defined.length === 0 ? undefined : Math.min(...defined);
}

function abortReason(signal: AbortSignal, fallback: string): string {
  const reason = (signal as AbortSignal & { readonly reason?: unknown }).reason;
  if (typeof reason === "string" && reason.trim().length > 0) return reason;
  if (reason instanceof AdmissionDeniedError) return reason.reason;
  if (reason instanceof Error && reason.message.trim().length > 0) {
    return reason.message;
  }
  return fallback;
}

function scheduleAt(
  targetMs: number,
  now: () => Date,
  callback: () => void,
): DeadlineTimer {
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const scheduleNext = (): void => {
    if (cancelled) return;
    const remaining = Math.max(0, targetMs - now().getTime());
    if (remaining === 0) {
      timer = setTimeout(() => {
        timer = undefined;
        if (!cancelled) callback();
      }, 0);
      timer.unref?.();
      return;
    }
    timer = setTimeout(
      () => {
        timer = undefined;
        scheduleNext();
      },
      Math.min(remaining, MAX_TIMER_DELAY_MS),
    );
    timer.unref?.();
  };
  scheduleNext();
  return {
    cancel() {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
}

function normalizePositiveInteger(
  value: number | undefined,
  fallback: number,
): number {
  return Number.isSafeInteger(value) && (value as number) > 0
    ? (value as number)
    : fallback;
}

function normalizeLimits(
  limits: AdmissionConcurrencyLimits,
): AdmissionConcurrencyLimits {
  return {
    global: normalizePositiveInteger(
      limits.global,
      DEFAULT_ADMISSION_CONCURRENCY_LIMITS.global,
    ),
    workspace: normalizePositiveInteger(
      limits.workspace,
      DEFAULT_ADMISSION_CONCURRENCY_LIMITS.workspace,
    ),
    session: normalizePositiveInteger(
      limits.session,
      DEFAULT_ADMISSION_CONCURRENCY_LIMITS.session,
    ),
    parent: normalizePositiveInteger(
      limits.parent,
      DEFAULT_ADMISSION_CONCURRENCY_LIMITS.parent,
    ),
    provider: normalizePositiveInteger(
      limits.provider,
      DEFAULT_ADMISSION_CONCURRENCY_LIMITS.provider,
    ),
  };
}
