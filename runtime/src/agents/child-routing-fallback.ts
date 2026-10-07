import type { ChildTerminalOutcome } from "./child-terminal.js";
import type { RankedChildCandidate } from "./provider-selector-types.js";

export interface ChildRoutingAttemptResult<T> {
  readonly value: T;
  readonly terminal: ChildTerminalOutcome;
  /** All wire sampling attempts, including provider retries and final summaries. */
  readonly modelCalls: number;
  /** Count every dispatched child tool, including read-only tools. */
  readonly toolCalls: number;
  /** Reconciled spend for this attempt, never cumulative worker spend. */
  readonly costUsd?: number;
  /** Unreconciled reservations retained by canonical admission. */
  readonly heldUnknownCostUsd?: number;
}

/** An independent check's answer. "unavailable" includes a check that threw. */
export type ChildRoutingVerdict = "pass" | "fail" | "unavailable";

export interface ChildRoutingAttempt<T> extends ChildRoutingAttemptResult<T> {
  readonly candidate: RankedChildCandidate;
  readonly attempt: number;
  /** Present only when an independent check ran for this attempt. */
  readonly verdict?: ChildRoutingVerdict;
}

export interface ChildRoutingAttemptContext<T> {
  readonly candidate: RankedChildCandidate;
  readonly attempt: number;
  readonly remainingModelCalls: number;
  readonly remainingCostUsd?: number;
  readonly previousAttempts: readonly ChildRoutingAttempt<T>[];
  /**
   * Candidates a later attempt could still use if this one fails before any
   * tool call, judged before this attempt's own spend. Empty on the last
   * permitted attempt.
   */
  readonly fallbackCandidates: readonly RankedChildCandidate[];
}

export type ChildRoutingStopReason = "completed" | "terminal_outcome" | "tools_already_run"
  | "cancelled" | "attempt_limit" | "no_candidate" | "model_call_budget_exhausted"
  | "cost_budget_exhausted" | "usage_unknown" | "invalid_usage" | "verification_unavailable"
  /** A check failed and the plan allows no further attempt for a failed check. */
  | "verification_failed"
  /** The attempt finished within the cap, but the check's own charge would not fit, so no check ran. */
  | "verification_over_budget";

/** Terminals whose answer an independent check can examine. */
export const CHECKABLE_CHILD_TERMINALS: ReadonlySet<ChildTerminalOutcome["reason"]> = new Set(["completed", "step_limit", "no_progress"]);

export interface ChildRoutingFallbackResult<T> {
  readonly value?: T;
  readonly attempts: readonly ChildRoutingAttempt<T>[];
  readonly stopReason: ChildRoutingStopReason;
  readonly modelCalls: number;
  /** Known spend plus held-unknown reservations. Omitted for unknown accounting. */
  readonly accountedCostUsd?: number;
}

function nonNegative(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value >= 0;
}

/** A provider failure that another provider can retry. Tasks, limits and stalls are not. */
export function childFailureAllowsFallback(failure: Pick<ChildTerminalOutcome, "reason" | "retryable">): boolean {
  return failure.reason === "insufficient_funds" ||
    (failure.retryable && (failure.reason === "rate_limited" ||
      failure.reason === "provider_unavailable" || failure.reason === "timeout"));
}

/**
 * Bound a sequence of freshly authorized child runs. The caller owns selection,
 * fresh consent, unique run identities and canonical admission. Never switch a
 * live ChildSession's destination or replay tools. In particular, a 402 does
 * not bypass the existing funds-stop consent check on the next spawn.
 *
 * Callback exceptions propagate: their effects and usage have not been
 * attested, so treating a thrown error as a safe retry would be incorrect.
 */
export async function runChildRoutingFallback<T>(options: {
  readonly candidates: readonly RankedChildCandidate[];
  readonly maxModelCalls: number;
  readonly maxCostUsd?: number;
  readonly maxAttempts?: number;
  readonly signal?: AbortSignal;
  /**
   * The caller already started the first candidate. Its attempt is observed
   * to the end whatever its estimate; budgets only admit later attempts.
   */
  readonly firstAttemptStarted?: boolean;
  readonly verification?: {
    readonly retrySafe: boolean;
    readonly costUsd: number;
    /** A failed check may start the next candidate. Only a planned cascade sets this. */
    readonly escalate: boolean;
    readonly check: (result: ChildRoutingAttempt<T>) => Promise<ChildRoutingVerdict>;
  };
  readonly runAttempt: (context: ChildRoutingAttemptContext<T>) => Promise<ChildRoutingAttemptResult<T>>;
}): Promise<ChildRoutingFallbackResult<T>> {
  const maxAttempts = options.maxAttempts ?? 3;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3 ||
      !Number.isSafeInteger(options.maxModelCalls) || options.maxModelCalls < 0 ||
      (options.maxCostUsd !== undefined && !nonNegative(options.maxCostUsd)) ||
      (options.verification !== undefined && !nonNegative(options.verification.costUsd))) {
    throw new RangeError("Child fallback requires at most 3 attempts and finite non-negative budgets.");
  }
  const attempts: ChildRoutingAttempt<T>[] = [];
  const attemptedProviders = new Set<string>();
  const attemptedPairs = new Set<string>();
  let modelCalls = 0;
  let accountedCostUsd: number | undefined = 0;
  const finish = (stopReason: ChildRoutingStopReason): ChildRoutingFallbackResult<T> => ({
    ...(attempts.length > 0 ? { value: attempts.at(-1)!.value } : {}),
    attempts: [...attempts], stopReason, modelCalls,
    ...(accountedCostUsd !== undefined ? { accountedCostUsd } : {}),
  });
  while (true) {
    if (options.signal?.aborted) return finish("cancelled");
    if (attempts.length >= maxAttempts) return finish("attempt_limit");
    if (modelCalls >= options.maxModelCalls) return finish("model_call_budget_exhausted");
    const remainingCostUsd = options.maxCostUsd === undefined ? undefined
      : Math.max(0, options.maxCostUsd - accountedCostUsd!);
    const eligible = options.candidates.filter((candidate) => !attemptedProviders.has(candidate.provider) &&
      !attemptedPairs.has(`${candidate.provider}/${candidate.model}`));
    // A new attempt must leave room for its own check.
    const admits = (item: RankedChildCandidate): boolean => remainingCostUsd === undefined ||
      (nonNegative(item.estimatedCostUsd) && item.estimatedCostUsd + (options.verification?.costUsd ?? 0) <= remainingCostUsd);
    const started = attempts.length === 0 && options.firstAttemptStarted === true;
    const candidate = started ? options.candidates[0] : eligible.find(admits);
    if (candidate === undefined) {
      return finish(eligible.length === 0 ? "no_candidate" : "cost_budget_exhausted");
    }
    const fallbackCandidates = attempts.length + 1 >= maxAttempts ? [] : eligible.filter((item) =>
      item.provider !== candidate.provider && admits(item));
    const outcome = await options.runAttempt({ candidate, attempt: attempts.length + 1,
      remainingModelCalls: options.maxModelCalls - modelCalls,
      ...(remainingCostUsd !== undefined ? { remainingCostUsd } : {}),
      previousAttempts: [...attempts], fallbackCandidates });
    attempts.push({ ...outcome, candidate, attempt: attempts.length + 1 });
    attemptedPairs.add(`${candidate.provider}/${candidate.model}`);
    if (!Number.isSafeInteger(outcome.modelCalls) || outcome.modelCalls < 0 ||
        !Number.isSafeInteger(outcome.toolCalls) || outcome.toolCalls < 0 ||
        (outcome.terminal.dispatch !== "not_sent" && outcome.modelCalls === 0) ||
        outcome.terminal.provider !== candidate.provider || outcome.terminal.model !== candidate.model) {
      accountedCostUsd = undefined;
      return finish("invalid_usage");
    }
    modelCalls += outcome.modelCalls;
    const costUsd = outcome.costUsd ?? outcome.terminal.costUsd;
    const held = outcome.heldUnknownCostUsd;
    if ((costUsd !== undefined && !nonNegative(costUsd)) || (held !== undefined && !nonNegative(held))) {
      accountedCostUsd = undefined;
      return finish("invalid_usage");
    }
    const usageKnown = costUsd !== undefined || held !== undefined || outcome.terminal.dispatch === "not_sent";
    accountedCostUsd = usageKnown ? accountedCostUsd! + (costUsd ?? 0) + (held ?? 0) : undefined;
    if (!Number.isSafeInteger(modelCalls) ||
        (accountedCostUsd !== undefined && !nonNegative(accountedCostUsd))) {
      accountedCostUsd = undefined;
      return finish("invalid_usage");
    }
    // A provider's completion label cannot authorize usage beyond the task
    // bounds. Exact exhaustion may complete; overspend must remain visible.
    if (modelCalls > options.maxModelCalls) return finish("model_call_budget_exhausted");
    if (options.maxCostUsd !== undefined) {
      if (!usageKnown) return finish("usage_unknown");
      if (accountedCostUsd! > options.maxCostUsd) return finish("cost_budget_exhausted");
    }
    if (options.signal?.aborted) return finish("cancelled");
    if (options.verification !== undefined && CHECKABLE_CHILD_TERMINALS.has(outcome.terminal.reason)) {
      // Unknown or held usage matters only to a cap that must admit the
      // check's charge; under a cap the reconciled spend is known here.
      if (options.maxCostUsd !== undefined && accountedCostUsd! + options.verification.costUsd > options.maxCostUsd) {
        return finish("verification_over_budget");
      }
      // Retain the declared verifier charge even if its result becomes unavailable.
      if (accountedCostUsd !== undefined) accountedCostUsd += options.verification.costUsd;
      let verdict: ChildRoutingVerdict;
      try { verdict = await options.verification.check(attempts.at(-1)!); }
      catch { verdict = "unavailable"; }
      if (verdict !== "pass" && verdict !== "fail") verdict = "unavailable";
      attempts[attempts.length - 1] = { ...attempts.at(-1)!, verdict };
      if (options.signal?.aborted) return finish("cancelled");
      if (verdict === "pass") return finish("completed");
      if (verdict === "unavailable") return finish("verification_unavailable");
      if (!options.verification.escalate) return finish("verification_failed");
      if (outcome.toolCalls > 0 && !options.verification.retrySafe) return finish("tools_already_run");
      if (!usageKnown) return finish("usage_unknown");
      continue;
    }
    if (outcome.terminal.reason === "completed") return finish("completed");
    attemptedProviders.add(candidate.provider);
    if (!childFailureAllowsFallback(outcome.terminal)) return finish("terminal_outcome");
    if (outcome.toolCalls > 0) return finish("tools_already_run");
    if (!usageKnown) return finish("usage_unknown");
  }
}
