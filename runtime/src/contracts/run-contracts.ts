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
] as const;
export type ReservedRunMethod = (typeof RESERVED_RUN_METHODS)[number];
