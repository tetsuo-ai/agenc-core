/**
 * BudgetStateService (Cut 7.3).
 *
 * Owns all sliding-window budget state for the policy / approvals
 * stack. Pure state mutation; no decision logic — that lives in
 * `tool-permission-evaluator.ts`.
 *
 * Replaces the rate-limiting + spend-counting + circuit-breaker fields
 * scattered across `policy/engine.ts`, `gateway/tool-policy.ts`, and
 * `gateway/approvals.ts` with one place to read and update them.
 *
 * @module
 */

interface SlidingWindowSample {
  readonly timestamp: number;
  readonly amount: number;
}

interface SlidingWindowState {
  readonly samples: readonly SlidingWindowSample[];
  readonly windowMs: number;
}

function createSlidingWindow(windowMs: number): SlidingWindowState {
  return { samples: [], windowMs };
}

export function recordSample(
  state: SlidingWindowState,
  amount: number,
  nowMs: number,
): SlidingWindowState {
  const cutoff = nowMs - state.windowMs;
  const trimmed = state.samples.filter((s) => s.timestamp >= cutoff);
  return {
    ...state,
    samples: [...trimmed, { timestamp: nowMs, amount }],
  };
}

function windowTotal(state: SlidingWindowState, nowMs: number): number {
  const cutoff = nowMs - state.windowMs;
  let total = 0;
  for (const sample of state.samples) {
    if (sample.timestamp >= cutoff) total += sample.amount;
  }
  return total;
}

interface BudgetLedger {
  readonly toolCallRate: SlidingWindowState;
  readonly tokenSpend: SlidingWindowState;
  readonly lamportSpend: SlidingWindowState;
  readonly runtimeMs: SlidingWindowState;
}

function createBudgetLedger(config: {
  rateWindowMs?: number;
  tokenWindowMs?: number;
  lamportWindowMs?: number;
  runtimeWindowMs?: number;
} = {}): BudgetLedger {
  return {
    toolCallRate: createSlidingWindow(config.rateWindowMs ?? 60_000),
    tokenSpend: createSlidingWindow(config.tokenWindowMs ?? 60 * 60 * 1000),
    lamportSpend: createSlidingWindow(config.lamportWindowMs ?? 60 * 60 * 1000),
    runtimeMs: createSlidingWindow(config.runtimeWindowMs ?? 60 * 60 * 1000),
  };
}

/**
 * Aggregate ledger state for a single session. Tools are scoped by
 * sessionId so a misbehaving session cannot starve a polite one.
 */
export class BudgetStateService {
  private readonly bySession = new Map<string, BudgetLedger>();

  recordToolCall(sessionId: string, nowMs: number): void {
    const ledger = this.ensure(sessionId);
    ledger.toolCallRate as unknown as SlidingWindowState;
    this.bySession.set(sessionId, {
      ...ledger,
      toolCallRate: recordSample(ledger.toolCallRate, 1, nowMs),
    });
  }

  recordTokens(sessionId: string, tokens: number, nowMs: number): void {
    const ledger = this.ensure(sessionId);
    this.bySession.set(sessionId, {
      ...ledger,
      tokenSpend: recordSample(ledger.tokenSpend, tokens, nowMs),
    });
  }

  recordLamports(sessionId: string, lamports: number, nowMs: number): void {
    const ledger = this.ensure(sessionId);
    this.bySession.set(sessionId, {
      ...ledger,
      lamportSpend: recordSample(ledger.lamportSpend, lamports, nowMs),
    });
  }

  recordRuntimeMs(sessionId: string, ms: number, nowMs: number): void {
    const ledger = this.ensure(sessionId);
    this.bySession.set(sessionId, {
      ...ledger,
      runtimeMs: recordSample(ledger.runtimeMs, ms, nowMs),
    });
  }

  toolCallRate(sessionId: string, nowMs: number): number {
    const ledger = this.bySession.get(sessionId);
    if (!ledger) return 0;
    return windowTotal(ledger.toolCallRate, nowMs);
  }

  tokenSpend(sessionId: string, nowMs: number): number {
    const ledger = this.bySession.get(sessionId);
    if (!ledger) return 0;
    return windowTotal(ledger.tokenSpend, nowMs);
  }

  lamportSpend(sessionId: string, nowMs: number): number {
    const ledger = this.bySession.get(sessionId);
    if (!ledger) return 0;
    return windowTotal(ledger.lamportSpend, nowMs);
  }

  runtimeMs(sessionId: string, nowMs: number): number {
    const ledger = this.bySession.get(sessionId);
    if (!ledger) return 0;
    return windowTotal(ledger.runtimeMs, nowMs);
  }

  reset(sessionId: string): void {
    this.bySession.delete(sessionId);
  }

  resetAll(): void {
    this.bySession.clear();
  }

  private ensure(sessionId: string): BudgetLedger {
    let ledger = this.bySession.get(sessionId);
    if (!ledger) {
      ledger = createBudgetLedger();
      this.bySession.set(sessionId, ledger);
    }
    return ledger;
  }
}
