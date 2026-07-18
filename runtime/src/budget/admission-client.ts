/** Session-facing facade for the daemon-owned execution admission kernel. */

import type { AdmissionKind } from "../contracts/run-contracts.js";
import type {
  AdmissionJournalEvent,
  AdmissionLease,
  AdmissionReconcileResult,
  AdmissionUsage,
} from "./admission-types.js";

export interface AdmissionClientScope {
  readonly runId: string;
  readonly workspaceId: string;
  readonly sessionId: string;
  /** Stable identity shared by all runs that consume one calendar budget. */
  readonly budgetIdentity: string;
  readonly parentRunId?: string;
  readonly parentScopeId?: string;
  readonly autonomous: boolean;
  readonly deadlineAt?: string;
  readonly maxCostUsd?: number;
  readonly maxTokens?: number;
  /** Any run or period allocation imposes a hard monetary ceiling. */
  readonly hasHardCostCap?: boolean;
  /** Any run or period allocation imposes a hard token ceiling. */
  readonly hasHardTokenCap?: boolean;
}

export interface AdmissionAcquireInput {
  readonly stepId: string;
  readonly kind: AdmissionKind;
  readonly sessionId?: string;
  readonly parentRunId?: string;
  readonly parentScopeId?: string;
  readonly model?: string;
  readonly provider?: string;
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  /** Null is an explicitly unpriced operation. */
  readonly maxCostUsd: number | null;
  readonly deadlineAt?: string;
  readonly approvalRequired?: boolean;
  /** Persist a fail-closed boundary preflight as an explicit deny decision. */
  readonly denialReason?: string;
}

export interface AdmissionDispatchEvidence {
  readonly boundary: "provider_wire" | "tool_effect" | "spawn_commit";
  readonly timestamp?: string;
  readonly providerRequestId?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface ExecutionAdmissionClient {
  readonly scope: AdmissionClientScope;
  /**
   * Enqueue and wait for an allow decision. Queue/deny/approval decisions are
   * journaled before this promise settles. Abort/deadline cancellation is
   * persisted before the promise rejects.
   */
  acquire(
    input: AdmissionAcquireInput,
    signal?: AbortSignal,
  ): Promise<AdmissionLease>;
  /** Exact dispatch boundary; idempotent for the reservation id. */
  markDispatched(
    reservationId: string,
    evidence: AdmissionDispatchEvidence,
  ): void;
  /** Exactly-once reported-usage reconciliation. */
  reconcile(
    reservationId: string,
    usage: AdmissionUsage,
  ): AdmissionReconcileResult;
  /** Post-dispatch missing/invalid usage. The full hold remains consumed. */
  holdUnknown(reservationId: string, reason: string): void;
  /**
   * Atomically cancel-lock this run and its durable descendants. Dispatched
   * reservations become `held_unknown`; canonical run/spawn state is cascaded
   * in the same SQLite transaction before this method returns.
   */
  cancelRun(reason: string): void;
  /** Pre-dispatch cancellation/failure. The reservation is fully released. */
  void(reservationId: string, reason: string): void;
  /**
   * Release only the live concurrency slot after the admitted boundary's
   * provider/tool/spawn promise has actually settled. Idempotent with durable
   * reconciliation; cancellation alone never performs this acknowledgement.
   */
  acknowledgeCompletion(reservationId: string): void;
  /** Durable, visible fallback/model-routing decision. */
  recordFallback(event: {
    readonly stepId: string;
    readonly fromModel: string;
    readonly toModel: string;
    readonly fromProvider?: string;
    readonly toProvider?: string;
    readonly reason: string;
  }): void;
  /** Bind subordinate session identity while conserving the same root budget. */
  forSession(options: {
    readonly runId?: string;
    readonly sessionId: string;
    readonly parentRunId?: string;
    readonly parentScopeId?: string;
    readonly deadlineAt?: string;
  }): ExecutionAdmissionClient;
  subscribe(listener: (event: AdmissionJournalEvent) => void): () => void;
}

export class AdmissionDeniedError extends Error {
  readonly code = "ADMISSION_DENIED" as const;

  constructor(
    readonly reason: string,
    readonly decision: "deny" | "approval_required" | "cancelled" = "deny",
  ) {
    super(`execution admission ${decision}: ${reason}`);
    this.name = "AdmissionDeniedError";
  }
}
