/**
 * Wave-B shared contracts: run identity, admission, budget reservations,
 * effect outcomes, and event cursors.
 *
 * This module is the FROZEN schema the M3 (admission kernel), M4 (durable
 * journal/replay), and M5 (verified-change workflow) implementations build
 * against. It intentionally contains types and constants only — no engine.
 * Implementations attach to the existing seams named in
 * docs/design/shared-run-contracts-v1.md; a parallel state store or second
 * orchestrator is a contract violation.
 *
 * Change control: extending these types is additive (new optional fields,
 * new union members with explicit fallback semantics). Renaming or removing
 * a frozen member requires a reviewed contract-change PR that updates every
 * implementation in the same change.
 */

import type { ToolRecoveryCategory } from "../tools/types.js";

// ---------------------------------------------------------------------------
// Run identity
// ---------------------------------------------------------------------------

/**
 * THE run identity: the root agent id (= the root ManagedThread threadId,
 * already the primary key of the durable `agent_runs` table). Every surface
 * (CLI one-shot, TUI, SDK, background agents, workflows, eval executor)
 * addresses a run by this id. Daemon sessionIds, rollout conv-ids, and
 * per-turn streamIds are subordinate identifiers that map to a RunId via
 * attachment records — they never substitute for it.
 */
export type RunId = string;

/** A single admitted unit of work inside a run (model turn, tool exec, spawn). */
export interface RunStepIdentity {
  readonly runId: RunId;
  /** Durable, unique per step within the run. */
  readonly stepId: string;
  /** The parent run when this run was spawned by another (spawn-edge tree). */
  readonly parentRunId?: RunId;
}

export const RUN_TERMINAL_STATUSES = [
  "completed",
  "failed",
  "cancelled",
  "unknown_outcome",
] as const;
export type RunTerminalStatus = (typeof RUN_TERMINAL_STATUSES)[number];

/**
 * The durable terminal record every run must produce and every surface must
 * be able to fetch AFTER its original connection is gone (M4/M5 done-when).
 */
export interface RunTerminalResult {
  readonly runId: RunId;
  readonly status: RunTerminalStatus;
  readonly exitCode: number | null;
  readonly stopReason: string | null;
  readonly finalMessage: string | null;
  readonly usage: RunUsageTotals | null;
  /** Highest journal sequence covered by this result (replay upper bound). */
  readonly lastSequence: number | null;
  readonly finishedAt: string;
}

export interface RunUsageTotals {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly costUsd: number;
}

// ---------------------------------------------------------------------------
// Admission (M3)
// ---------------------------------------------------------------------------

export const ADMISSION_KINDS = ["model_turn", "tool_exec", "spawn"] as const;
export type AdmissionKind = (typeof ADMISSION_KINDS)[number];

export interface AdmissionRequest {
  readonly step: RunStepIdentity;
  readonly kind: AdmissionKind;
  /**
   * Conservative worst-case charge for this step, reserved transactionally
   * before the work starts. Unpriced/unbounded work under a hard USD cap is
   * denied, never waved through.
   */
  readonly estimate: {
    readonly maxInputTokens: number;
    readonly maxOutputTokens: number;
    readonly maxCostUsd: number | null;
  };
  readonly model?: string;
  readonly provider?: string;
  /** Stable project/workspace scope used for budget and capacity accounting. */
  readonly workspaceId?: string;
  /** Subordinate daemon/session identity; never substitutes for `runId`. */
  readonly sessionId?: string;
  /** Immediate execution parent for parent-scoped capacity. */
  readonly parentScopeId?: string;
  /** Absolute deadline. Expired queued work is cancelled, not dispatched. */
  readonly deadlineAt?: string;
}

export const ADMISSION_DECISIONS = [
  "allow",
  "queue",
  "deny",
  "approval_required",
] as const;
export type AdmissionDecisionKind = (typeof ADMISSION_DECISIONS)[number];

export interface AdmissionDecision {
  readonly decision: AdmissionDecisionKind;
  /** Present exactly when decision === "allow". */
  readonly hold?: BudgetReservation;
  /** Machine-readable refusal/queue reason (single vocabulary, no prose-only). */
  readonly reason?: string;
}

/**
 * A durable, uniquely-identified budget hold. The reservation id is the
 * idempotency key for reconciliation: reconcile(reservationId, usage) must
 * be exactly-once in effect even when called twice (restart recovery), and a
 * crash between reserve and reconcile must be recoverable from the persisted
 * hold — never a silently stranded debit, never a free retry.
 */
export interface BudgetReservation {
  readonly reservationId: string;
  readonly step: RunStepIdentity;
  readonly reservedCostUsd: number;
  readonly reservedTokens: number;
  readonly reservedAt: string;
}

export const RESERVATION_RESOLUTIONS = [
  /** Provider-reported usage reconciled; difference refunded. */
  "reconciled",
  /** Work cancelled before any charge; full refund. */
  "voided",
  /**
   * Usage unknown (lost acknowledgement, crash mid-call). The FULL
   * reservation stays consumed until recorded policy explicitly releases
   * it — unknown usage is never refunded as if the call were free.
   */
  "held_unknown",
] as const;
export type ReservationResolution = (typeof RESERVATION_RESOLUTIONS)[number];

// ---------------------------------------------------------------------------
// Effects (M4)
// ---------------------------------------------------------------------------

/**
 * Effect outcome vocabulary. Uses the EXISTING ToolRecoveryCategory
 * (idempotent | side-effecting | interactive) for classification — this
 * contract adds outcome states, not a competing taxonomy. `unknown_outcome`
 * is terminal-but-unresolved: dependent mutations stop, review is required,
 * and no automatic replay may occur. It aligns by name with the eval
 * contract's `effect.unknown_outcome` evidence type so live runtime and
 * eval evidence converge on one vocabulary.
 */
export const EFFECT_OUTCOMES = [
  "committed",
  "failed",
  "cancelled",
  "unknown_outcome",
] as const;
export type EffectOutcome = (typeof EFFECT_OUTCOMES)[number];

export interface EffectRecord {
  readonly step: RunStepIdentity;
  readonly toolName: string;
  readonly recoveryCategory: ToolRecoveryCategory;
  /** Durable idempotency key; REQUIRED for idempotent effects, absent otherwise. */
  readonly idempotencyKey?: string;
  readonly outcome: EffectOutcome;
  /** Journal event names carrying this record (see EVENT names below). */
  readonly evidence?: Readonly<Record<string, unknown>>;
}

/** Journal event names for the effect lifecycle (EventMsg additions in M4). */
export const EFFECT_INTENT_EVENT = "effect_intent" as const;
export const EFFECT_RESULT_EVENT = "effect_result" as const;
export const EFFECT_UNKNOWN_OUTCOME_EVENT = "effect_unknown_outcome" as const;

// ---------------------------------------------------------------------------
// Events / journal cursors (M4)
// ---------------------------------------------------------------------------

/**
 * Cursor semantics: every journaled run event carries the already-declared
 * protocol fields `eventId` + `sequence` (AgenCEventBaseParams). This
 * contract makes them mandatory-in-effect for run events: producers MUST
 * populate `sequence` from the run journal's monotonic counter, and
 * consumers replay with `afterSequence` cursors. Retention gaps are
 * explicit: a reader that cannot be served a contiguous range receives a
 * gap marker instead of silently missing events.
 */
export interface RunEventCursor {
  readonly runId: RunId;
  /** Replay strictly-after this sequence; 0 replays from the beginning. */
  readonly afterSequence: number;
}

export interface RunEventGap {
  readonly runId: RunId;
  /** Events in (afterSequence, firstAvailableSequence) were retired. */
  readonly afterSequence: number;
  readonly firstAvailableSequence: number;
  readonly reason: "retention" | "corruption_truncated" | "compaction";
}

/** Journal event name for an explicit retention gap (EventMsg addition in M4). */
export const EVENT_GAP_EVENT = "event_gap" as const;

// ---------------------------------------------------------------------------
// Reserved daemon methods (implemented across M3/M4/M5)
// ---------------------------------------------------------------------------

/**
 * Reserved protocol method names. Implementations add them to
 * AGENC_DAEMON_METHODS + dispatcher routing when they land; the names are
 * frozen here so CLI/TUI/SDK surfaces target one vocabulary from day one.
 */
export const RESERVED_RUN_METHODS = [
  /** By-id durable status (no paging, works after restart). */
  "run.status",
  /** Durable terminal result fetch (works after the client disconnected). */
  "run.result",
  /** Cursor-based journal replay with explicit gap markers. */
  "run.replay",
  /** Machine-readable evidence bundle export (evidence-ledger backed). */
  "run.evidence",
  /** Tree-scoped cancel: parent + queued + running descendants. */
  "run.cancel",
  /** Start the M5 verified-change workflow as a durable run (contract-change PR, additive). */
  "run.start",
] as const;
export type ReservedRunMethod = (typeof RESERVED_RUN_METHODS)[number];

// ---------------------------------------------------------------------------
// Verified-change workflow (M5)
// ---------------------------------------------------------------------------

/**
 * The fixed verified-change pipeline. These are the durable `stepId` values
 * recorded in `run_effects` for a workflow run (retried stages append an
 * attempt suffix, e.g. `workflow.implement#2`; verification fan-out appends a
 * command index, e.g. `workflow.verify.cmd.3`). A general DAG engine is
 * deliberately out of contract — M5 ships exactly this pipeline.
 */
export const WORKFLOW_STEP_IDS = [
  "workflow.intake",
  "workflow.worktree",
  "workflow.plan",
  "workflow.implement",
  "workflow.verify",
  "workflow.review",
  "workflow.finalize",
] as const;
export type WorkflowStepId = (typeof WORKFLOW_STEP_IDS)[number];

/**
 * Static prerequisite map for the fixed pipeline (a linear chain today).
 * A stage may not begin until every prerequisite stage's effect is
 * `committed` AND its in-evidence verdicts pass; failed verification,
 * cancellation, budget exhaustion, and `unknown_outcome` all stop dependent
 * unlocks (the unknown-outcome mutation gate and terminal-epoch refusal in
 * the durability layer are the hard backstops).
 */
export const WORKFLOW_STEP_PREREQUISITES: Readonly<
  Record<WorkflowStepId, readonly WorkflowStepId[]>
> = Object.freeze({
  "workflow.intake": [],
  "workflow.worktree": ["workflow.intake"],
  "workflow.plan": ["workflow.worktree"],
  "workflow.implement": ["workflow.plan"],
  "workflow.verify": ["workflow.implement"],
  "workflow.review": ["workflow.verify"],
  "workflow.finalize": ["workflow.review"],
});

/** Projected status of one workflow stage (derived from run_effects rows). */
export const WORKFLOW_STEP_STATUSES = [
  "pending",
  "running",
  "committed",
  "failed",
  "cancelled",
  "unknown_outcome",
  /** Prerequisites terminally failed; this stage can never start. */
  "blocked",
] as const;
export type WorkflowStepStatus = (typeof WORKFLOW_STEP_STATUSES)[number];

/**
 * Machine-readable stop reasons for a workflow run that does not complete.
 * Recorded as `RunTerminalResult.stopReason`; never prose-only.
 */
export const WORKFLOW_STOP_REASONS = [
  "verification_failed",
  "review_rejected",
  "base_moved_conflict",
  "budget_exhausted",
  "policy_denied",
  /**
   * M5 approval semantics (frozen): the intake step resolves approvals up
   * front and rejects specs that would require interactive approval. If a
   * mid-pipeline admission still returns `approval_required`, the run
   * terminates `failed` with this reason — durable, honest, replayable.
   * There is NO approval-parking subsystem in M5; upgrading this to a
   * parked-and-resumable step is an explicit future contract change.
   */
  "approval_required",
  "unknown_outcome_effect",
  "evidence_invalid",
  "step_retries_exhausted",
] as const;
export type WorkflowStopReason = (typeof WORKFLOW_STOP_REASONS)[number];

/**
 * The workflow specification, frozen at intake. Persisted as the
 * `workflow.intake` effect's evidence (canonical JSON); its canonical digest
 * is the intake effect's intent digest and the spec's durable identity.
 * Resolved fields (reviewerModel, baseCommit) are never re-resolved later —
 * a moved base is detected against `baseCommit` and surfaced explicitly.
 */
export interface WorkflowSpec {
  readonly runId: RunId;
  /** The engineering goal / issue text driving the change. */
  readonly goal: string;
  /** Absolute git root of the target repository. */
  readonly repoPath: string;
  /** Exact base commit recorded before any work begins. */
  readonly baseCommit: string;
  /** Dirty-state summary of the user's checkout at intake (never mutated). */
  readonly baseDirty: {
    readonly dirty: boolean;
    /** sha256 of `git status --porcelain=v1 -z` output at intake. */
    readonly summaryDigest: string;
    readonly fileCount: number;
  };
  readonly model?: string;
  readonly provider?: string;
  /** Pinned reviewer configuration; resolved at intake, never re-resolved. */
  readonly reviewerModel: string;
  readonly permissionMode:
    | "default"
    | "plan"
    | "acceptEdits"
    | "bypassPermissions";
  readonly unattendedAllow?: readonly string[];
  readonly unattendedDeny?: readonly string[];
  readonly budget: {
    readonly maxCostUsd?: number;
    readonly maxTokens?: number;
    readonly deadlineAt?: string;
  };
  /** Required verification commands; every one must exit 0 for completion. */
  readonly requiredVerification: readonly {
    readonly label: string;
    readonly script: string;
  }[];
  /** Bounded re-implement attempts after failed verification (default 2). */
  readonly maxImplementAttempts: number;
}

/**
 * Durable pointer to a content-addressed artifact produced by a workflow
 * step. Persisted in the producing step's effect evidence AND in the run's
 * evidence ledger; `storagePath` is a portable `cas://sha256/<hex>` address
 * within the ledger, never a host path.
 */
export interface RunArtifactPointer {
  readonly step: RunStepIdentity;
  readonly role:
    | "patch"
    | "changed_files"
    | "test_result"
    | "independent_review"
    | "cost_usage"
    | "effect_log"
    | "risk_register"
    | "base_state"
    | "diagnostic";
  readonly digest: `sha256:${string}`;
  readonly bytes: number;
  readonly storagePath: string;
  readonly recordedAt: string;
}
