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
  /** Physical model calls, including unknown outcomes; shared with descendants. */
  readonly maxModelCalls?: number;
}

export interface RuntimeAdmissionRequest extends AdmissionRequest {
  readonly costEstimated?: boolean;
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

export interface AdmissionUsageTotals {
  readonly costEstimated?: boolean;
  readonly costUsd: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly modelCalls: number;
  readonly hasUnknownCost: boolean;
  readonly heldCostUsd: number;
}

/** Bounded diagnostic identities; observation only, never spending authority. */
export type UnpricedUsageCall = {
  readonly reservationId: string;
  readonly runId: string;
  readonly stepId: string;
  readonly kind: string;
  readonly model?: string;
  readonly provider?: string;
  readonly reason: string;
};

export interface AdmissionUsageSummary extends AdmissionUsageTotals {
  /** Display only: known cost adjusted by recorded per-call off-peak hours. Never budget authority. */
  readonly billedEstimateUsd?: number;
  /** Display only: at least one settled call has a recorded off-peak discount. */
  readonly hasOffPeakDiscount?: boolean;
  /** Display only: an eligible priced call has no usable dispatch time. */
  readonly hasMissingDispatchTime?: boolean;
  readonly runId: string;
  readonly sequence: number;
  readonly unpricedCalls?: readonly UnpricedUsageCall[];
  readonly unpricedCallCount?: number;
  readonly models: readonly (AdmissionUsageTotals & {
    readonly model: string;
    readonly provider?: string;
  })[];
  readonly agents: readonly (AdmissionUsageTotals & {
    readonly runId: string;
  })[];
}

/**
 * The model calls a tool makes for the session that called it, by the purpose
 * that leads their admission step id (`<purpose>:<session sub id>`):
 * WebSearch's Grok native search, XSearch, and web_fetch's prompt extraction.
 * Their spend belongs to the tool call, not to a turn.
 */
export const TOOL_MODEL_CALL_PURPOSES = Object.freeze([
  "web_search",
  "x_search",
  "web_fetch_extraction",
] as const);

export type ToolModelCallPurpose = (typeof TOOL_MODEL_CALL_PURPOSES)[number];

/**
 * The index just past the JSON string literal that opens at `start` in
 * `text` (escapes included), or undefined when it does not close.
 */
function endOfJsonString(text: string, start: number): number | undefined {
  let index = start + 1;
  while (index < text.length && text[index] !== '"') {
    index += text[index] === "\\" ? 2 : 1;
  }
  return index < text.length ? index + 1 : undefined;
}

/**
 * Whether a stored admission step id is a tool's model call. The kernel
 * stores a client's step as `[task:<JSON task id>:][session:<JSON session
 * id>:]...<step>` (execution-admission-kernel.ts stepIdFor and forSession),
 * so a call a task-bound client admitted reads
 * `task:"call_1":web_fetch_extraction:sub-7`. Each prefix is removed as a
 * whole (an id is one JSON string, so quotes or colons in it cannot end it
 * early) before the purpose is read. Session prefixes written before ids
 * were encoded (`session:<id>:`, never written by a production caller) get a
 * best-effort read: the id ends at its first colon.
 */
export function isToolModelCallStep(stepId: string): boolean {
  let rest = stepId;
  if (rest.startsWith('task:"')) {
    const end = endOfJsonString(rest, "task:".length);
    if (end === undefined || rest[end] !== ":") return false;
    rest = rest.slice(end + 1);
  }
  while (rest.startsWith("session:")) {
    const idStart = "session:".length;
    const end = rest[idStart] === '"'
      ? endOfJsonString(rest, idStart)
      : rest.indexOf(":", idStart);
    if (end === undefined || end < 0 || rest[end] !== ":") return false;
    rest = rest.slice(end + 1);
  }
  return TOOL_MODEL_CALL_PURPOSES.some((purpose) => rest.startsWith(`${purpose}:`));
}

/**
 * What one run's own tool calls were charged: the fees tools report on their
 * tool_exec reservations (web search and fetch, media generation) plus the
 * model calls tools make ({@link isToolModelCallStep}), including those its
 * task-bound clients admitted. Settled, priced reservations only; delegated
 * runs are not included.
 */
export interface AdmissionToolCharges {
  readonly costUsd: number;
}

/** Immutable observation at one admission revision, materialized at publication. */
export interface AdmissionUsageSnapshot {
  readonly runId: string;
  readonly sequence: number;
  /** Equality of all displayed fields, excluding the journal sequence. */
  readonly signature: string;
  read(): AdmissionUsageSummary;
}

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
  readonly costEstimated?: boolean;
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
        | "model_call_budget_exceeded"
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
  /** Cause of a parent_cancel_locked denial, recovered from its durable lock. */
  parentLockCause?: "cancellation" | "unknown_outcome" | "provider_overrun";
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
