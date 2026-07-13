/**
 * Budget enforcer (TODO task 15) — the daemon-side admission gate.
 *
 * Contract (see docs/design/budget-enforcement.md):
 *   admit()      pre-flight: debit worst-case (est input + max output) priced
 *                at the model rate; check BOTH daily and monthly caps; fail
 *                closed. Returns a hold or a typed BUDGET_EXCEEDED refusal.
 *   reconcile()  post-call: replace the held estimate with real usage, refund
 *                the delta, and fire soft-warning / paused notifications.
 *
 * Never silently downgrades the model. On a hard-cap breach it pauses the
 * agent's autonomy and notifies; the operator raises the cap or resets.
 */

import { BudgetLedger } from "./ledger.js";
import type {
  AdmitRequest,
  AdmitResult,
  BudgetHold,
  BudgetNotification,
  BudgetNotifier,
  BudgetPolicy,
  BudgetRefusalReason,
  BudgetUsage,
  ModelPrice,
  ModelPriceResolver,
} from "./types.js";

export interface BudgetEnforcerOptions {
  readonly policy: BudgetPolicy;
  readonly ledger: BudgetLedger;
  readonly priceOf: ModelPriceResolver;
  readonly notify?: BudgetNotifier;
}

function priceTokens(
  price: ModelPrice,
  inputTokens: number,
  outputTokens: number,
): number {
  return (
    (inputTokens / 1_000_000) * price.inputPerMTokens +
    (outputTokens / 1_000_000) * price.outputPerMTokens
  );
}

export class BudgetEnforcer {
  readonly #policy: BudgetPolicy;
  readonly #ledger: BudgetLedger;
  readonly #priceOf: ModelPriceResolver;
  readonly #notify: BudgetNotifier;

  constructor(options: BudgetEnforcerOptions) {
    this.#policy = options.policy;
    this.#ledger = options.ledger;
    this.#priceOf = options.priceOf;
    this.#notify = options.notify ?? (() => {});
  }

  get enabled(): boolean {
    return this.#policy.enabled;
  }

  /** Does this request fall under enforcement given its provenance? */
  #inScope(request: AdmitRequest): boolean {
    if (!this.#policy.enabled) return false;
    return request.autonomous || this.#policy.enforceInteractive;
  }

  /**
   * Pre-flight admission check. When enforcement is off or out of scope, admits
   * with a zero hold (callers can still reconcile a no-op). Fail-closed: if any
   * relevant cap would be exceeded by the worst-case debit, refuses.
   */
  admit(request: AdmitRequest): AdmitResult {
    const { dayKey, monthKey } = this.#ledger.currentKeys();
    if (!this.#inScope(request)) {
      return {
        ok: true,
        hold: {
          agentId: request.agentId,
          model: request.model,
          estimatedUsd: 0,
          estimatedTokens: 0,
          dayKey,
          monthKey,
        },
      };
    }

    const state = this.#ledger.snapshot(request.agentId);
    if (state.paused) {
      return this.#refuse("paused", request.agentId, 0, 0);
    }

    const price = this.#priceOf(request.model);
    const caps = this.#policy.caps;
    // Worst-case: full estimated input + the output cap. Unpriced models can
    // still hit token caps; when any USD cap is configured, fail closed so
    // autonomous surfaces cannot unbounded-spend via model: "unknown" (todo-104).
    const estTokens = request.estInputTokens + request.maxOutputTokens;
    if (
      price === null &&
      (caps.dailyUsd !== undefined || caps.monthlyUsd !== undefined)
    ) {
      return this.#refuse("unpriced_model", request.agentId, 0, estTokens);
    }
    const estUsd =
      price !== null
        ? priceTokens(price, request.estInputTokens, request.maxOutputTokens)
        : 0;

    // Dollar caps.
    if (caps.dailyUsd !== undefined && state.day.usd + estUsd > caps.dailyUsd) {
      return this.#refuse("daily_usd", request.agentId, estUsd, estTokens);
    }
    if (
      caps.monthlyUsd !== undefined &&
      state.month.usd + estUsd > caps.monthlyUsd
    ) {
      return this.#refuse("monthly_usd", request.agentId, estUsd, estTokens);
    }
    // Token caps.
    if (
      caps.dailyTokens !== undefined &&
      state.day.tokens + estTokens > caps.dailyTokens
    ) {
      return this.#refuse("daily_tokens", request.agentId, estUsd, estTokens);
    }
    if (
      caps.monthlyTokens !== undefined &&
      state.month.tokens + estTokens > caps.monthlyTokens
    ) {
      return this.#refuse("monthly_tokens", request.agentId, estUsd, estTokens);
    }

    // Admit: hold the worst-case debit so a concurrent turn can't double-spend.
    this.#ledger.addSpend(request.agentId, estUsd, estTokens);
    return {
      ok: true,
      hold: {
        agentId: request.agentId,
        model: request.model,
        estimatedUsd: estUsd,
        estimatedTokens: estTokens,
        dayKey,
        monthKey,
      },
    };
  }

  #refuse(
    reason: BudgetRefusalReason,
    agentId: string,
    estUsd: number,
    estTokens: number,
  ): AdmitResult {
    // A hard-cap refusal pauses autonomy (fail closed) and notifies once.
    // unpriced_model is a configuration/pricing gate — do not pause the agent
    // (operator can fix the model id without agenc budget reset).
    if (reason !== "paused" && reason !== "unpriced_model") {
      this.#pause(agentId, reason);
    }
    void estUsd;
    void estTokens;
    return {
      ok: false,
      code: "BUDGET_EXCEEDED",
      reason,
      message:
        reason === "paused"
          ? `agent ${agentId} autonomy is paused by a budget cap; raise the cap or run \`agenc budget reset ${agentId}\``
          : reason === "unpriced_model"
            ? `agent ${agentId} cannot admit under USD budget caps: model has no known price (pass a priced model id or use token caps)`
            : `agent ${agentId} would exceed its ${reason.replace("_", " ")} budget cap`,
    };
  }

  #pause(agentId: string, reason: BudgetRefusalReason): void {
    const already = this.#ledger.snapshot(agentId).paused;
    this.#ledger.setPaused(agentId, true);
    if (!already) {
      const window: "day" | "month" = reason.startsWith("daily")
        ? "day"
        : "month";
      const snap = this.#ledger.snapshot(agentId);
      const spent = window === "day" ? snap.day.usd : snap.month.usd;
      const cap =
        window === "day"
          ? (this.#policy.caps.dailyUsd ?? 0)
          : (this.#policy.caps.monthlyUsd ?? 0);
      this.#emit({
        agentId,
        kind: "paused",
        window,
        spentUsd: spent,
        capUsd: cap,
        message: `agent ${agentId} autonomy paused: ${reason.replace("_", " ")} cap reached`,
      });
    }
  }

  /**
   * Replace a hold's worst-case estimate with the real usage and refund the
   * delta (ledger applies `actual − estimated`), then fire a one-shot soft
   * warning if a window crossed the soft threshold.
   *
   * **Not idempotent:** each call applies another `(actual − estimated)`
   * delta. Call **exactly once** per successful admit (prefer exclusive
   * `try`/`finally`). Zero holds (budget disabled / out of scope) are a no-op.
   */
  reconcile(hold: BudgetHold, usage: BudgetUsage): void {
    if (hold.estimatedTokens === 0 && hold.estimatedUsd === 0) {
      // Out-of-scope / unpriced admit held nothing; account nothing.
      return;
    }
    const price = this.#priceOf(hold.model);
    const actualTokens = usage.inputTokens + usage.outputTokens;
    const actualUsd =
      price !== null
        ? priceTokens(price, usage.inputTokens, usage.outputTokens)
        : 0;
    // Refund the difference between the worst-case hold and the actual spend.
    this.#ledger.addSpend(
      hold.agentId,
      actualUsd - hold.estimatedUsd,
      actualTokens - hold.estimatedTokens,
    );
    this.#maybeSoftWarn(hold.agentId);
  }

  #maybeSoftWarn(agentId: string): void {
    const caps = this.#policy.caps;
    const snap = this.#ledger.snapshot(agentId);
    const frac = this.#policy.softThreshold;
    if (
      caps.dailyUsd !== undefined &&
      !snap.softWarned.day &&
      snap.day.usd >= caps.dailyUsd * frac
    ) {
      this.#ledger.markSoftWarned(agentId, "day");
      this.#emit({
        agentId,
        kind: "soft_warning",
        window: "day",
        spentUsd: snap.day.usd,
        capUsd: caps.dailyUsd,
        message: `agent ${agentId} has spent $${snap.day.usd.toFixed(4)} of its $${caps.dailyUsd} daily budget`,
      });
    }
    if (
      caps.monthlyUsd !== undefined &&
      !snap.softWarned.month &&
      snap.month.usd >= caps.monthlyUsd * frac
    ) {
      this.#ledger.markSoftWarned(agentId, "month");
      this.#emit({
        agentId,
        kind: "soft_warning",
        window: "month",
        spentUsd: snap.month.usd,
        capUsd: caps.monthlyUsd,
        message: `agent ${agentId} has spent $${snap.month.usd.toFixed(4)} of its $${caps.monthlyUsd} monthly budget`,
      });
    }
  }

  #emit(event: BudgetNotification): void {
    try {
      this.#notify(event);
    } catch {
      // A notifier failure must never break enforcement.
    }
  }
}
