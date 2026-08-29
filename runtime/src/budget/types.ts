/** Shared types for user-facing budget-policy resolution. */

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
