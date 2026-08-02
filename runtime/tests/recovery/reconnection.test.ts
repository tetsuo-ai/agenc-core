import { describe, expect, test, vi } from "vitest";

import { LLMRateLimitError } from "../../src/llm/errors.js";
import {
  RECONNECT_INITIAL_MS,
  RECONNECT_MAX_MS,
  RECONNECT_RETRY_AFTER_CEILING_MS,
  reconnectWithBackoff,
  serverDirectedRetryAfter,
  type ReconnectOpts,
  type ReconnectSleeper,
} from "../../src/recovery/reconnection.js";
import { EventLog } from "../../src/session/event-log.js";
import type { Session } from "../../src/session/session.js";

function sessionWithLog(log = new EventLog()): Session {
  let subId = 0;
  return {
    eventLog: log,
    nextInternalSubId: () => `reconnect-${++subId}`,
  } as unknown as Session;
}

class ManualClocks {
  monotonicMs = 0;
  wallMs = 1_000_000;

  readonly monotonicNow = (): number => this.monotonicMs;
  readonly wallNow = (): number => this.wallMs;

  advanceBoth(milliseconds: number): void {
    this.monotonicMs += milliseconds;
    this.wallMs += milliseconds;
  }
}

function reconnectOptions<T>(
  overrides: Partial<ReconnectOpts<T>> & Pick<ReconnectOpts<T>, "attempt">,
): ReconnectOpts<T> {
  return {
    session: sessionWithLog(),
    maxAttempts: 3,
    isTransient: () => true,
    rng: () => 0,
    sleeper: async () => {},
    ...overrides,
  };
}

describe("serverDirectedRetryAfter", () => {
  test("preserves typed valid, invalid, over-policy, wrapped, and absent directives", () => {
    expect(serverDirectedRetryAfter(new LLMRateLimitError("grok", 5_000))).toEqual({
      classification: "valid",
      floorMs: 5_000,
    });
    expect(
      serverDirectedRetryAfter({ retryAfterMs: Number.POSITIVE_INFINITY }),
    ).toEqual({ classification: "invalid", invalidReason: "non_finite" });
    expect(
      serverDirectedRetryAfter({
        retryAfterMs: RECONNECT_RETRY_AFTER_CEILING_MS + 1,
      }),
    ).toEqual({
      classification: "over_policy",
      floorMs: RECONNECT_RETRY_AFTER_CEILING_MS + 1,
    });
    expect(
      serverDirectedRetryAfter({
        cause: {
          retryAfterDirective: {
            classification: "invalid",
            invalidReason: "overflow",
          },
        },
      }),
    ).toEqual({ classification: "invalid", invalidReason: "overflow" });
    expect(serverDirectedRetryAfter(new Error("ECONNRESET"))).toEqual({
      classification: "absent",
    });
    expect(Object.isFrozen(serverDirectedRetryAfter(new Error("ECONNRESET")))).toBe(
      true,
    );
  });
});

describe("reconnectWithBackoff policy validation", () => {
  test("requires at least one explicit finite ladder cap", async () => {
    await expect(
      reconnectWithBackoff({
        session: sessionWithLog(),
        attempt: async () => "unused",
        isTransient: () => true,
      }),
    ).rejects.toThrowError(/maxAttempts.*giveUpMs/u);
  });

  test.each([0, -1, 1.5, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid maxAttempts %s",
    async (maxAttempts) => {
      await expect(
        reconnectWithBackoff({
          session: sessionWithLog(),
          maxAttempts,
          attempt: async () => "unused",
          isTransient: () => true,
        }),
      ).rejects.toThrowError(/maxAttempts.*positive integer/u);
    },
  );

  test.each([0, -1, 1.5, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid giveUpMs %s",
    async (giveUpMs) => {
      await expect(
        reconnectWithBackoff({
          session: sessionWithLog(),
          giveUpMs,
          attempt: async () => "unused",
          isTransient: () => true,
        }),
      ).rejects.toThrowError(/giveUpMs.*positive integer/u);
    },
  );

  test("keeps the named compatibility defaults", () => {
    expect(RECONNECT_INITIAL_MS).toBe(1_000);
    expect(RECONNECT_MAX_MS).toBe(30_000);
    expect(RECONNECT_RETRY_AFTER_CEILING_MS).toBe(300_000);
  });
});

describe("reconnectWithBackoff orchestration", () => {
  test("returns first-attempt success without drawing or sleeping", async () => {
    const rng = vi.fn(() => 0);
    const sleeper = vi.fn<ReconnectSleeper>(async () => {});
    const outcome = await reconnectWithBackoff(
      reconnectOptions({
        maxAttempts: 1,
        attempt: async () => "ok",
        rng,
        sleeper,
      }),
    );
    expect(outcome).toEqual({ kind: "ok", value: "ok", attempts: 1 });
    expect(rng).not.toHaveBeenCalled();
    expect(sleeper).not.toHaveBeenCalled();
  });

  test("retries transient failures and preserves total-attempt numbering", async () => {
    let calls = 0;
    const callback = vi.fn(async () => true);
    const outcome = await reconnectWithBackoff(
      reconnectOptions({
        maxAttempts: 3,
        attempt: async (attempt) => {
          calls += 1;
          if (calls < 3) throw new Error("temporary");
          return attempt;
        },
        onTransientRetry: callback,
      }),
    );
    expect(outcome).toEqual({ kind: "ok", value: 2, attempts: 3 });
    expect(callback.mock.calls.map(([attempt]) => attempt)).toEqual([1, 2]);
  });

  test("runs the final safety callback before typed attempt exhaustion", async () => {
    const callback = vi.fn(async () => true);
    const sleeper = vi.fn<ReconnectSleeper>(async () => {});
    const outcome = await reconnectWithBackoff(
      reconnectOptions({
        maxAttempts: 2,
        attempt: async () => {
          throw new Error("temporary");
        },
        onTransientRetry: callback,
        sleeper,
      }),
    );
    expect(outcome).toMatchObject({
      kind: "exhausted",
      attempts: 2,
      reason: "attempts_exhausted",
      telemetry: {
        attempt: 2,
        chosenDelayMs: null,
        exhaustionReason: "attempts_exhausted",
      },
    });
    expect(callback).toHaveBeenCalledTimes(2);
    expect(sleeper).toHaveBeenCalledTimes(1);
  });

  test("keeps retry eligibility separate and bubbles non-transient failures", async () => {
    const callback = vi.fn(async () => true);
    await expect(
      reconnectWithBackoff(
        reconnectOptions({
          attempt: async () => {
            throw new Error("permanent authorization failure");
          },
          isTransient: () => false,
          onTransientRetry: callback,
        }),
      ),
    ).rejects.toThrow("permanent authorization failure");
    expect(callback).not.toHaveBeenCalled();
  });

  test("treats callback refusal as a typed non-retryable exhaustion", async () => {
    const sleeper = vi.fn<ReconnectSleeper>(async () => {});
    const outcome = await reconnectWithBackoff(
      reconnectOptions({
        attempt: async () => {
          throw new Error("unknown physical effect");
        },
        onTransientRetry: async () => false,
        sleeper,
      }),
    );
    expect(outcome).toMatchObject({
      kind: "exhausted",
      attempts: 1,
      reason: "retry_callback_rejected",
      telemetry: { exhaustionReason: "retry_callback_rejected" },
    });
    expect(sleeper).not.toHaveBeenCalled();
  });

  test("keeps A1 unknown-effect refusal authoritative over Retry-After policy", async () => {
    const sleeper = vi.fn<ReconnectSleeper>(async () => {});
    const outcome = await reconnectWithBackoff(
      reconnectOptions({
        attempt: async () => {
          throw {
            retryAfterMs: RECONNECT_RETRY_AFTER_CEILING_MS + 1,
          };
        },
        // Production run-turn performs its A1 physical-effect check here.
        onTransientRetry: async () => false,
        sleeper,
      }),
    );
    expect(outcome).toMatchObject({
      kind: "exhausted",
      attempts: 1,
      reason: "retry_callback_rejected",
    });
    expect(sleeper).not.toHaveBeenCalled();
  });

  test("exhausts over-policy and over-budget valid floors without retrying early", async () => {
    for (const scenario of [
      {
        error: { retryAfterMs: RECONNECT_RETRY_AFTER_CEILING_MS + 1 },
        giveUpMs: undefined,
        reason: "retry_after_exceeds_policy",
      },
      {
        error: { retryAfterMs: 5_000 },
        giveUpMs: 4_000,
        reason: "retry_after_exceeds_budget",
      },
    ] as const) {
      const sleeper = vi.fn<ReconnectSleeper>(async () => {});
      const callback = vi.fn(async () => true);
      let calls = 0;
      const outcome = await reconnectWithBackoff(
        reconnectOptions({
          ...(scenario.giveUpMs === undefined
            ? { maxAttempts: 3 }
            : { maxAttempts: undefined, giveUpMs: scenario.giveUpMs }),
          attempt: async () => {
            calls += 1;
            throw scenario.error;
          },
          onTransientRetry: callback,
          sleeper,
        }),
      );
      expect(outcome).toMatchObject({
        kind: "exhausted",
        attempts: 1,
        reason: scenario.reason,
      });
      expect(calls).toBe(1);
      expect(callback).toHaveBeenCalledTimes(1);
      expect(sleeper).not.toHaveBeenCalled();
    }
  });

  test("invalid directives diagnose and fall back to ordinary jitter", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const outcome = await reconnectWithBackoff(
      reconnectOptions({
        attempt: async () => {
          calls += 1;
          if (calls === 1) {
            throw { retryAfterMs: Number.POSITIVE_INFINITY };
          }
          return "recovered";
        },
        rng: () => 0.5,
        sleeper: async (delayMs) => {
          sleeps.push(delayMs);
        },
      }),
    );
    expect(outcome).toMatchObject({ kind: "ok", value: "recovered" });
    expect(sleeps).toEqual([500]);
  });

  test("callback execution consumes the immutable elapsed budget", async () => {
    const clocks = new ManualClocks();
    const sleeper = vi.fn<ReconnectSleeper>(async () => {});
    let calls = 0;
    const outcome = await reconnectWithBackoff(
      reconnectOptions({
        maxAttempts: undefined,
        giveUpMs: 1_000,
        monotonicNow: clocks.monotonicNow,
        wallNow: clocks.wallNow,
        attempt: async () => {
          calls += 1;
          throw new Error("temporary");
        },
        onTransientRetry: async () => {
          clocks.advanceBoth(1_000);
          return true;
        },
        sleeper,
      }),
    );
    expect(outcome).toMatchObject({
      kind: "exhausted",
      reason: "elapsed_budget_exhausted",
      attempts: 1,
      telemetry: { remainingBudgetMs: 0 },
    });
    expect(calls).toBe(1);
    expect(sleeper).not.toHaveBeenCalled();
  });

  test("checks elapsed budget before the first provider attempt", async () => {
    let monotonicReads = 0;
    const attempt = vi.fn(async () => "unused");
    const outcome = await reconnectWithBackoff(
      reconnectOptions({
        maxAttempts: undefined,
        giveUpMs: 1_000,
        monotonicNow: () => (monotonicReads++ === 0 ? 0 : 1_000),
        wallNow: () => 0,
        attempt,
      }),
    );
    expect(outcome).toMatchObject({
      kind: "exhausted",
      attempts: 0,
      reason: "elapsed_budget_exhausted",
    });
    expect(attempt).not.toHaveBeenCalled();
  });

  test("provider attempt time consumes budget after the safety callback", async () => {
    const clocks = new ManualClocks();
    const callback = vi.fn(async () => true);
    const outcome = await reconnectWithBackoff(
      reconnectOptions({
        maxAttempts: undefined,
        giveUpMs: 1_000,
        monotonicNow: clocks.monotonicNow,
        wallNow: clocks.wallNow,
        attempt: async () => {
          clocks.advanceBoth(1_000);
          throw new Error("temporary");
        },
        onTransientRetry: callback,
      }),
    );
    expect(outcome).toMatchObject({
      kind: "exhausted",
      attempts: 1,
      reason: "elapsed_budget_exhausted",
    });
    expect(callback).toHaveBeenCalledTimes(1);
  });

  test("timer oversleep consumes budget before another provider call", async () => {
    const clocks = new ManualClocks();
    let calls = 0;
    const outcome = await reconnectWithBackoff(
      reconnectOptions({
        maxAttempts: undefined,
        giveUpMs: 1_000,
        monotonicNow: clocks.monotonicNow,
        wallNow: clocks.wallNow,
        attempt: async () => {
          calls += 1;
          throw new Error("temporary");
        },
        rng: () => 0.5,
        sleeper: async () => {
          clocks.advanceBoth(1_100);
        },
      }),
    );
    expect(outcome).toMatchObject({
      kind: "exhausted",
      reason: "elapsed_budget_exhausted",
      attempts: 1,
    });
    expect(calls).toBe(1);
  });

  test("a wall-clock suspend gap exhausts even when monotonic time pauses", async () => {
    const clocks = new ManualClocks();
    let calls = 0;
    const outcome = await reconnectWithBackoff(
      reconnectOptions({
        maxAttempts: undefined,
        giveUpMs: 1_000,
        monotonicNow: clocks.monotonicNow,
        wallNow: clocks.wallNow,
        attempt: async () => {
          calls += 1;
          throw new Error("temporary");
        },
        rng: () => 0.5,
        sleeper: async () => {
          clocks.wallMs += 120_000;
        },
      }),
    );
    expect(outcome).toMatchObject({
      kind: "exhausted",
      reason: "elapsed_budget_exhausted",
      attempts: 1,
    });
    expect(calls).toBe(1);
  });

  test("wall rollback never erases monotonic elapsed time", async () => {
    const clocks = new ManualClocks();
    let calls = 0;
    const outcome = await reconnectWithBackoff(
      reconnectOptions({
        maxAttempts: undefined,
        giveUpMs: 1_000,
        monotonicNow: clocks.monotonicNow,
        wallNow: clocks.wallNow,
        attempt: async () => {
          calls += 1;
          if (calls === 2) clocks.advanceBoth(500);
          throw new Error("temporary");
        },
        rng: () => 0.5,
        sleeper: async () => {
          clocks.monotonicMs += 500;
          clocks.wallMs -= 10_000;
        },
      }),
    );
    expect(outcome).toMatchObject({
      kind: "exhausted",
      reason: "elapsed_budget_exhausted",
      attempts: 2,
    });
    expect(calls).toBe(2);
  });

  test("wall rollback cannot restore a previously observed wall-clock gap", async () => {
    const clocks = new ManualClocks();
    let calls = 0;
    let sleeps = 0;
    const outcome = await reconnectWithBackoff(
      reconnectOptions({
        maxAttempts: 3,
        giveUpMs: 1_000,
        monotonicNow: clocks.monotonicNow,
        wallNow: clocks.wallNow,
        attempt: async () => {
          calls += 1;
          if (calls === 2) {
            clocks.wallMs -= 500;
            throw { retryAfterMs: 500 };
          }
          if (calls === 3) return "rollback incorrectly restored budget";
          throw new Error("temporary");
        },
        sleeper: async () => {
          sleeps += 1;
          clocks.wallMs += 600;
        },
      }),
    );
    expect(outcome).toMatchObject({
      kind: "exhausted",
      attempts: 2,
      reason: "retry_after_exceeds_budget",
      telemetry: { remainingBudgetMs: 400 },
    });
    expect(calls).toBe(2);
    expect(sleeps).toBe(1);
  });

  test("safe warning telemetry omits raw provider error text", async () => {
    const log = new EventLog();
    const events: unknown[] = [];
    log.subscribe((event) => events.push(event));
    let calls = 0;
    await reconnectWithBackoff(
      reconnectOptions({
        session: sessionWithLog(log),
        attempt: async () => {
          calls += 1;
          if (calls === 1) throw new Error("secret-provider-payload");
          return "ok";
        },
      }),
    );
    const serialized = JSON.stringify(events);
    expect(serialized).toContain("reconnecting");
    expect(serialized).toContain("delayMs");
    expect(serialized).not.toContain("secret-provider-payload");
  });
});

describe("reconnectWithBackoff abort checkpoints", () => {
  test("aborts before the first attempt", async () => {
    const controller = new AbortController();
    controller.abort(new Error("private abort reason"));
    const attempt = vi.fn(async () => "unused");
    const outcome = await reconnectWithBackoff(
      reconnectOptions({ signal: controller.signal, attempt }),
    );
    expect(outcome).toEqual({ kind: "aborted", reason: "aborted", attempts: 0 });
    expect(attempt).not.toHaveBeenCalled();
  });

  test("aborts immediately after the retry callback", async () => {
    const controller = new AbortController();
    const sleeper = vi.fn<ReconnectSleeper>(async () => {});
    const outcome = await reconnectWithBackoff(
      reconnectOptions({
        signal: controller.signal,
        attempt: async () => {
          throw new Error("temporary");
        },
        onTransientRetry: async () => {
          controller.abort("callback abort");
          return true;
        },
        sleeper,
      }),
    );
    expect(outcome).toEqual({ kind: "aborted", reason: "aborted", attempts: 1 });
    expect(sleeper).not.toHaveBeenCalled();
  });

  test("aborts during sleep and checks again immediately after wake", async () => {
    const controller = new AbortController();
    let calls = 0;
    const outcome = await reconnectWithBackoff(
      reconnectOptions({
        signal: controller.signal,
        attempt: async () => {
          calls += 1;
          throw new Error("temporary");
        },
        sleeper: async () => {
          controller.abort("sleep abort");
        },
      }),
    );
    expect(outcome).toEqual({ kind: "aborted", reason: "aborted", attempts: 1 });
    expect(calls).toBe(1);
  });
});
