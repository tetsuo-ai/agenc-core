/**
 * Runtime shapes for the daemon-owned M3 admission kernel.
 *
 * The frozen public vocabulary lives in `contracts/run-contracts.ts`.  This
 * module only adds the execution scope needed to enforce that contract across
 * a daemon (workspace/session/parent/provider concurrency, deadlines and
 * hierarchical allocations) plus the durable ledger representation.
 */

import type {
  AdmissionDecision,
  AdmissionKind,
  AdmissionRequest,
  BudgetReservation,
  RunStepIdentity,
} from "../contracts/run-contracts.js";

export interface AdmissionConcurrencyLimits {
  readonly global: number;
  readonly workspace: number;
  readonly session: number;
  readonly parent: number;
  readonly provider: number;
}

export interface AdmissionBudgetScope {
  /** Stable account key (`global:...`, `run:...`, `parent:...`, etc.). */
  readonly key: string;
  /** Optional durable hierarchy edge for diagnostics and allocation listing. */
  readonly parentKey?: string;
  /** Undefined means this scope has no dollar allocation. */
  readonly maxCostUsd?: number;
  /** Undefined means this scope has no token allocation. */
  readonly maxTokens?: number;
}

export interface RuntimeAdmissionRequest extends AdmissionRequest {
  readonly workspaceId: string;
  readonly sessionId: string;
  /** Stable root-agent identity for cumulative calendar-window allocations. */
  readonly budgetIdentity?: string;
  /** Immediate execution parent. Defaults to the session id. */
  readonly parentScopeId?: string;
  readonly autonomous: boolean;
  /** Absolute ISO-8601 deadline. Expired work is cancelled, never dispatched. */
  readonly deadlineAt?: string;
  /** All accounts are debited atomically; shared ancestors conserve siblings. */
  readonly budgetScopes?: readonly AdmissionBudgetScope[];
  /** Optional policy gate. The kernel persists this decision like every other. */
  readonly approvalRequired?: boolean;
  /** Boundary preflight failure that must still become a durable deny row. */
  readonly denialReason?: string;
}

export interface AdmissionJournalEvent {
  readonly sequence: number;
  readonly eventId: string;
  readonly timestamp: string;
  readonly runId: string;
  readonly stepId: string;
  readonly kind: AdmissionKind;
  readonly event:
    | "queued"
    | "allowed"
    | "denied"
    | "approval_required"
    | "dispatched"
    | "reconciled"
    | "voided"
    | "held_unknown"
    | "provider_overrun"
    | "cancelled"
    | "recovered"
    | "fallback";
  readonly reason?: string;
  readonly reservationId?: string;
  readonly model?: string;
  readonly provider?: string;
  readonly reservedCostUsd?: number;
  readonly reservedTokens?: number;
  readonly actualCostUsd?: number;
  readonly actualTokens?: number;
  readonly details?: Readonly<Record<string, unknown>>;
}

export type AdmissionEventListener = (event: AdmissionJournalEvent) => void;

/** Durable allow result produced by the SQLite repository. */
export interface AdmissionGrant {
  readonly decision: "allow";
  readonly reservation: BudgetReservation;
  readonly request: RuntimeAdmissionRequest;
}

/**
 * Live daemon lease. The signal composes caller cancellation, the admitted
 * deadline, parent/run cancellation, and kernel shutdown.
 */
export interface AdmissionLease extends AdmissionGrant {
  readonly signal: AbortSignal;
}

export interface AdmissionUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Null means the provider/model could not be priced after the fact. */
  readonly costUsd: number | null;
}

export type AdmissionReconcileInput =
  | {
      readonly kind: "reported";
      readonly usage: AdmissionUsage;
      readonly providerRequestId?: string;
      readonly reason?: string;
    }
  | {
      readonly kind: "provider_overrun";
      readonly usage: AdmissionUsage;
      readonly providerRequestId?: string;
      readonly reason?: string;
    }
  | { readonly kind: "void"; readonly reason: string }
  | { readonly kind: "unknown"; readonly reason: string };

export type AdmissionReconcileResult =
  | {
      readonly applied: true;
      readonly outcome: "reconciled" | "voided" | "held_unknown";
    }
  | {
      readonly applied: true;
      readonly outcome: "provider_overrun";
      readonly reservedTokens: number;
      readonly actualTokens: number;
      readonly reservedCostUsd: number;
      readonly actualCostUsd: number | null;
    }
  | {
      readonly applied: false;
      readonly outcome: "duplicate";
      readonly existingStatus:
        "reconciled" | "voided" | "held_unknown" | "provider_overrun";
    };

export type AdmissionClaimResult =
  | { readonly kind: "claimed"; readonly lease: AdmissionGrant }
  | { readonly kind: "empty" }
  | {
      readonly kind: "not_claimed";
      readonly reason:
        | "not_queued"
        | "deadline_expired"
        | "budget_exceeded"
        | "unpriced_under_hard_cap"
        | "allocation_blocked"
        | "cancelled";
      readonly record: PersistedAdmissionRecord;
    };

export interface AdmissionCancellationReport {
  readonly runId: string;
  readonly affectedRunIds: readonly string[];
  readonly cancelledJobIds: readonly string[];
  readonly voidedReservationIds: readonly string[];
  readonly heldUnknownReservationIds: readonly string[];
}

export interface AdmissionRecoveryReport {
  readonly requeuedJobIds: readonly string[];
  readonly heldUnknownReservationIds: readonly string[];
  readonly cancelledExpiredJobIds: readonly string[];
  readonly detachedQueuedJobIds: readonly string[];
  readonly repairedAllocationKeys: readonly string[];
}

export type PersistedAdmissionStatus =
  | "queued"
  | "running"
  | "reconciled"
  | "voided"
  | "held_unknown"
  | "provider_overrun"
  | "denied"
  | "approval_required"
  | "cancelled";

export interface PersistedAdmissionRecord {
  /** Physical row id in the shared `agent_jobs` queue. */
  readonly jobId: string;
  /** Stable logical key derived from runId + stepId. */
  readonly key: string;
  readonly request: RuntimeAdmissionRequest;
  status: PersistedAdmissionStatus;
  readonly priority: number;
  readonly availableAt: string;
  readonly queueSequence: number;
  readonly enqueuedAt: string;
  /** Process owner. Dead owners are recovered without refunding usage. */
  ownerPid: number;
  ownerId: string;
  attached: boolean;
  reservation?: BudgetReservation;
  admittedAt?: string;
  completedAt?: string;
  reason?: string;
  actualTokens?: number;
  actualCostUsd?: number | null;
}

export interface PersistedAdmissionAccount {
  readonly key: string;
  usedTokens: number;
  usedCostUsd: number;
  maxTokens?: number;
  maxCostUsd?: number;
  blockedByProviderOverrun?: boolean;
}

export interface PersistedRunCancellation {
  readonly runId: string;
  readonly reason: string;
  readonly cancelledAt: string;
}

export interface PersistedAdmissionState {
  readonly version: 1;
  nextQueueSequence: number;
  nextJournalSequence: number;
  records: Record<string, PersistedAdmissionRecord>;
  accounts: Record<string, PersistedAdmissionAccount>;
  cancellations: Record<string, PersistedRunCancellation>;
  journal: AdmissionJournalEvent[];
}

export interface AdmissionAttempt {
  readonly decision: AdmissionDecision;
  readonly record: PersistedAdmissionRecord;
}

export function admissionRecordKey(step: RunStepIdentity): string {
  return `${step.runId}\u0000${step.stepId}`;
}

export function admissionPeriodScopeKey(
  budgetIdentity: string,
  period: "day" | "month",
  window: string,
): string {
  return `period:agent:${encodeURIComponent(budgetIdentity)}:${period}:${window}`;
}
