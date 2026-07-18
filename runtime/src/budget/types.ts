/**
 * Budget enforcement types (TODO task 15).
 *
 * A daemon-owned budget layer that bounds autonomous-agent spend. Grounded in
 * the SOTA research in docs/design/budget-enforcement.md. Core invariants,
 * each traceable to that note:
 *   - external enforcement (never trust the model's self-estimate)   [BAGEN]
 *   - pre-flight admission gate; post-hoc accounting is reconciliation
 *   - debit worst-case up front, reconcile from the real usage
 *   - fail closed: pause + notify + explicit raise, never silent downgrade
 */

/** Where a resolved budget policy field came from. */
export type BudgetValueSource = "env" | "config" | "default";

/** A per-agent spend envelope. Caps of 0 or undefined mean "no cap". */
export interface BudgetCaps {
  /** Hard daily dollar cap (calendar day). */
  readonly dailyUsd?: number;
  /** Hard monthly dollar cap (calendar month). */
  readonly monthlyUsd?: number;
  /** Optional hard daily token cap (total tokens). */
  readonly dailyTokens?: number;
  /** Optional hard monthly token cap. */
  readonly monthlyTokens?: number;
}

export interface BudgetPolicy {
  readonly enabled: boolean;
  readonly caps: BudgetCaps;
  /**
   * Fraction of a cap [0,1) at which a one-shot soft warning fires. Default
   * 0.8. The hard cap is what pauses; the soft threshold only notifies.
   */
  readonly softThreshold: number;
  /**
   * When true, ALSO enforce on interactive turns; otherwise only autonomous
   * turns are gated ("manual turns unaffected unless configured").
   */
  readonly enforceInteractive: boolean;
}

export interface BudgetPolicySources {
  readonly enabled: BudgetValueSource;
  readonly dailyUsd: BudgetValueSource;
  readonly monthlyUsd: BudgetValueSource;
}

export interface ResolvedBudgetPolicy {
  readonly policy: BudgetPolicy;
  readonly sources: BudgetPolicySources;
}

/** One window's accumulated spend for one agent. */
export interface BudgetWindowSpend {
  /** Date key: `YYYY-MM-DD` for the day window, `YYYY-MM` for the month. */
  readonly key: string;
  usd: number;
  tokens: number;
}

/** An agent's persisted ledger entry. */
export interface AgentBudgetState {
  readonly agentId: string;
  day: BudgetWindowSpend;
  month: BudgetWindowSpend;
  /** Autonomy paused by a hard-cap breach until the operator resumes/raises. */
  paused: boolean;
  /** Soft warnings already emitted this window (so they fire once). */
  softWarned: { day: boolean; month: boolean };
}

/** Usage numbers used to price a call. */
export interface BudgetUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface AdmitRequest {
  readonly agentId: string;
  readonly model: string;
  /** Turn provenance: autonomous turns are gated by default. */
  readonly autonomous: boolean;
  /** Estimated prompt tokens (deterministic count, not a model guess). */
  readonly estInputTokens: number;
  /** Worst-case output tokens (the per-call output cap). */
  readonly maxOutputTokens: number;
}

export type BudgetRefusalReason =
  | "daily_usd"
  | "monthly_usd"
  | "daily_tokens"
  | "monthly_tokens"
  | "unpriced_model"
  | "paused";

export type AdmitResult =
  | { readonly ok: true; readonly hold: BudgetHold }
  | {
      readonly ok: false;
      readonly code: "BUDGET_EXCEEDED";
      readonly reason: BudgetRefusalReason;
      readonly message: string;
    };

/**
 * A reserved worst-case debit, reconciled after the call returns.
 *
 * `holdId` is the durable reservation id required by the frozen Wave-B
 * contract (`BudgetReservation.reservationId`, run-contracts.ts): it is the
 * idempotency key for reconciliation. Non-zero holds are persisted in the
 * ledger file atomically with their debit, so a crash between reserve and
 * reconcile leaves a visible open hold (held_unknown semantics: the full
 * reservation stays consumed), never a silently stranded or refunded debit.
 */
export interface BudgetHold {
  readonly holdId: string;
  readonly agentId: string;
  readonly model: string;
  readonly estimatedUsd: number;
  readonly estimatedTokens: number;
  readonly dayKey: string;
  readonly monthKey: string;
}

/** A hold as persisted in the ledger file while it remains open. */
export interface PersistedBudgetHold {
  readonly holdId: string;
  readonly agentId: string;
  readonly model: string;
  readonly estimatedUsd: number;
  readonly estimatedTokens: number;
  readonly dayKey: string;
  readonly monthKey: string;
  readonly reservedAt: string;
}

/**
 * Outcome of a reconcile attempt. Exactly one call per hold `applied`s the
 * (actual − estimated) delta; every later call is a mechanical no-op.
 */
export interface ReconcileResult {
  readonly applied: boolean;
  readonly reason:
    /** Delta applied; the hold is now resolved (contract: "reconciled"). */
    | "reconciled"
    /** The hold was already resolved — duplicate call, ledger untouched. */
    | "duplicate"
    /**
     * The hold's day window rolled before reconciliation. Its debit was
     * zeroed by the roll, so no refund is applied (unknown usage is never
     * refunded as if the call were free); the stale hold is discarded.
     */
    | "window_rolled"
    /** Zero hold (enforcement off / out of scope): nothing was ever held. */
    | "zero_hold";
}

/** Emitted when a budget event happens; wired to the notification surface. */
export interface BudgetNotification {
  readonly agentId: string;
  readonly kind: "soft_warning" | "paused";
  readonly window: "day" | "month";
  readonly spentUsd: number;
  readonly capUsd: number;
  readonly message: string;
}

export type BudgetNotifier = (event: BudgetNotification) => void;

/** Price per 1M tokens for a model, used to convert tokens → dollars. */
export interface ModelPrice {
  readonly inputPerMTokens: number;
  readonly outputPerMTokens: number;
}

/** Resolves a model id → its price. Injected so the ledger stays pure. */
export type ModelPriceResolver = (model: string) => ModelPrice | null;
