import { describe, expect, test } from "bun:test";
import { getEventListeners } from "node:events";

import {
  AbortHarnessError,
  createAbortHarness,
  MAX_ABORT_HARNESS_LABEL_UTF8_BYTES,
} from "../helpers/abort-harness.js";
import {
  ControlledAsyncError,
  createControlledPromise,
  drainMicrotasks,
  MAX_CONTROLLED_ASYNC_LABEL_UTF8_BYTES,
  settleWithinMicrotasks,
  waitForMicrotaskCondition,
} from "../helpers/controlled-async.js";
import {
  createDeterministicClock,
  DeterministicClockError,
} from "../helpers/deterministic-clock.js";
import {
  createFailurePlan,
  FailurePlanError,
  MAX_FAILURE_PLAN_CHECKPOINT_UTF8_BYTES,
} from "../helpers/failure-plan.js";
import {
  createSeededRng,
  createSequenceRng,
  MAX_SEEDED_RNG_DOMAIN_UTF8_BYTES,
  MAX_SEEDED_RNG_SEED_BYTES,
  MAX_SEQUENCE_RNG_LABEL_UTF8_BYTES,
  MAX_SEQUENCE_RNG_VALUES,
  SeededRngError,
} from "../helpers/seeded-rng.js";

const MICROTASK_TAIL_PROBE_TURNS = 64;
const REPEATED_SETTLEMENT_PROBES = 32;
const NEXT_TASK_DELAY_MS = 0;
const INVALID_EVENT_LISTENER = 42;

type InstrumentedPromiseThen = (
  this: Promise<unknown>,
  onFulfilled?: ((value: unknown) => unknown) | null,
  onRejected?: ((reason: unknown) => unknown) | null,
) => Promise<unknown>;

function expectErrorCode(
  action: () => unknown,
  errorType:
    | typeof AbortHarnessError
    | typeof ControlledAsyncError
    | typeof DeterministicClockError
    | typeof FailurePlanError
    | typeof SeededRngError,
  code: string,
): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(errorType);
    expect(error).toMatchObject({ code });
    return;
  }
  throw new Error(`expected ${errorType.name} with code ${code}`);
}

async function expectAsyncErrorCode(
  action: () => Promise<unknown>,
  errorType:
    | typeof AbortHarnessError
    | typeof ControlledAsyncError
    | typeof DeterministicClockError
    | typeof FailurePlanError
    | typeof SeededRngError,
  code: string,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    expect(error).toBeInstanceOf(errorType);
    expect(error).toMatchObject({ code });
    return;
  }
  throw new Error(`expected ${errorType.name} with code ${code}`);
}

describe("deterministic clock", () => {
  test("orders timers by monotonic deadline and insertion while advancing both clocks", () => {
    const clock = createDeterministicClock({
      wallTimeMs: 1_000,
      monotonicTimeMs: 50,
    });
    const trace: Array<readonly [string, number, number]> = [];

    clock.schedule(() => {
      trace.push(["first-five", clock.wallNowMs(), clock.monotonicNowMs()]);
    }, 5);
    clock.schedule(() => {
      trace.push(["second-five", clock.wallNowMs(), clock.monotonicNowMs()]);
    }, 5);
    clock.schedule(() => {
      trace.push(["ten", clock.wallNowMs(), clock.monotonicNowMs()]);
    }, 10);

    expect(clock.elapse(10)).toEqual({
      wallTimeMs: 1_010,
      monotonicTimeMs: 60,
      callbacksRun: 3,
      pendingTimers: 0,
    });
    expect(trace).toEqual([
      ["first-five", 1_005, 55],
      ["second-five", 1_005, 55],
      ["ten", 1_010, 60],
    ]);
    clock.assertIdle();
  });

  test("models independent monotonic progress, wall progress, and wall rollback", () => {
    const clock = createDeterministicClock({
      wallTimeMs: 5_000,
      monotonicTimeMs: 100,
    });
    let fired = false;
    clock.schedule(() => {
      fired = true;
    }, 10);

    clock.advanceWallBy(600);
    expect([clock.wallNowMs(), clock.monotonicNowMs(), fired]).toEqual([
      5_600,
      100,
      false,
    ]);
    clock.setWallTimeMs(4_900);
    expect(clock.advanceMonotonicBy(10)).toMatchObject({
      wallTimeMs: 4_900,
      monotonicTimeMs: 110,
      callbacksRun: 1,
    });
    expect(fired).toBe(true);
  });

  test("cancels eagerly and runs recursively scheduled zero-delay work", () => {
    const clock = createDeterministicClock();
    const cancelled = clock.schedule(() => {
      throw new Error("cancelled timer ran");
    }, 1);
    expect(cancelled.cancel()).toBe(true);
    expect(cancelled.cancel()).toBe(false);
    expect(cancelled.cancelled).toBe(true);

    const trace: string[] = [];
    const first = clock.schedule(() => {
      trace.push("first");
      clock.schedule(() => trace.push("second"), 0);
    }, 0);
    expect(clock.runDue().callbacksRun).toBe(2);
    expect(first.cancelled).toBe(false);
    expect(trace).toEqual(["first", "second"]);
    clock.assertIdle();
  });

  test("fails at configured pending-timer and callback ceilings", () => {
    const pendingClock = createDeterministicClock({ pendingTimerLimit: 2 });
    const first = pendingClock.schedule(() => {}, 1);
    const second = pendingClock.schedule(() => {}, 2);
    expectErrorCode(
      () => pendingClock.schedule(() => {}, 3),
      DeterministicClockError,
      "pending_timer_limit",
    );
    first.cancel();
    second.cancel();
    pendingClock.assertIdle();

    const callbackClock = createDeterministicClock({
      callbackLimitPerAdvance: 2,
    });
    callbackClock.schedule(() => {
      callbackClock.schedule(() => {}, 0);
      callbackClock.schedule(() => {}, 0);
    }, 0);
    expectErrorCode(
      () => callbackClock.runDue(),
      DeterministicClockError,
      "callback_limit",
    );
    expect(callbackClock.pendingTimerCount()).toBe(1);
  });

  test("stops at a throwing callback without claiming the target time", () => {
    const clock = createDeterministicClock({
      wallTimeMs: 100,
      monotonicTimeMs: 0,
    });
    const injected = new Error("injected timer failure");
    let laterRan = false;
    clock.schedule(() => {
      throw injected;
    }, 5);
    clock.schedule(() => {
      laterRan = true;
    }, 8);

    expect(() => clock.elapse(10)).toThrow(injected);
    expect([clock.wallNowMs(), clock.monotonicNowMs()]).toEqual([105, 5]);
    expect(laterRan).toBe(false);
    expect(clock.advanceMonotonicBy(3).callbacksRun).toBe(1);
    expect(laterRan).toBe(true);
  });

  test("rejects asynchronous callbacks, invalid time, and overflow", () => {
    const asyncClock = createDeterministicClock();
    asyncClock.schedule((async () => {}) as () => void, 0);
    expectErrorCode(
      () => asyncClock.runDue(),
      DeterministicClockError,
      "async_callback",
    );

    expectErrorCode(
      () => createDeterministicClock({ wallTimeMs: -1 }),
      DeterministicClockError,
      "invalid_time",
    );
    const overflowClock = createDeterministicClock({
      monotonicTimeMs: Number.MAX_SAFE_INTEGER,
    });
    expectErrorCode(
      () => overflowClock.schedule(() => {}, 1),
      DeterministicClockError,
      "time_overflow",
    );
  });

  test("settles sleeps and removes abort listeners on resolve and abort", async () => {
    const clock = createDeterministicClock();
    const resolvedAbort = createAbortHarness("resolved sleep");
    try {
      const sleep = clock.sleep(5, resolvedAbort.signal);
      expect(resolvedAbort.snapshot().activeListenerCount).toBe(1);
      clock.elapse(5);
      await expect(sleep).resolves.toBeUndefined();
      resolvedAbort.assertNoActiveListeners();
    } finally {
      resolvedAbort.restore();
    }

    const rejectedAbort = createAbortHarness("aborted sleep");
    const reason = Object.freeze({ kind: "test_abort" });
    try {
      const sleep = clock.sleep(10, rejectedAbort.signal);
      const observed = settleWithinMicrotasks(sleep, {
        label: "aborted clock sleep",
        maxTurns: 5,
      });
      rejectedAbort.controller.abort(reason);
      await expect(observed).resolves.toMatchObject({
        status: "rejected",
        reason,
      });
      rejectedAbort.assertAborted({
        reason,
        requestCount: 1,
        eventCount: 1,
      });
      rejectedAbort.assertNoActiveListeners();
      expect(clock.pendingTimerCount()).toBe(0);
    } finally {
      rejectedAbort.restore();
    }
  });

  test("cancels a sleep timer when abort-listener registration fails", async () => {
    const clock = createDeterministicClock();
    const abort = createAbortHarness("sleep setup failure", {
      trackedListenerLimit: 1,
    });
    const retainedListener = (): void => {};
    abort.signal.addEventListener("abort", retainedListener);

    try {
      const settlement = await settleWithinMicrotasks(
        clock.sleep(10, abort.signal),
        { label: "failed sleep setup", maxTurns: 2 },
      );
      expect(settlement).toMatchObject({
        status: "rejected",
        reason: { code: "listener_limit" },
      });
      expect(clock.pendingTimerCount()).toBe(0);
      clock.assertIdle();
      expect(abort.snapshot().activeListenerCount).toBe(1);
    } finally {
      abort.signal.removeEventListener("abort", retainedListener);
      abort.restore();
    }
  });
});

describe("seeded RNG", () => {
  test("freezes the SHA-256/xorshift32 golden stream", () => {
    const rng = createSeededRng({ domain: "foundation", seed: "seed" });
    expect(rng.algorithm).toBe("sha256-domain-xorshift32-rejection-v1");
    expect([
      rng.nextUint32(),
      rng.nextUint32(),
      rng.nextUint32(),
      rng.nextUint32(),
    ]).toEqual([2_417_274_626, 3_144_241_912, 3_086_308_867, 3_146_918_841]);
  });

  test("separates domains and reproduces identical streams", () => {
    const first = createSeededRng({ domain: "alpha", seed: "shared" });
    const second = createSeededRng({ domain: "alpha", seed: "shared" });
    const other = createSeededRng({ domain: "beta", seed: "shared" });
    const firstWords = Array.from({ length: 16 }, () => first.nextUint32());
    expect(Array.from({ length: 16 }, () => second.nextUint32())).toEqual(
      firstWords,
    );
    expect(other.nextUint32()).not.toBe(firstWords[0]);
  });

  test("uses bounded unbiased rejection sampling", () => {
    const rejecting = createSeededRng({ domain: "foundation", seed: "seed" });
    expect(rejecting.nextInt(2_147_483_649)).toBe(575_401_387);
    expect(rejecting.nextInt(2_147_483_649)).toBe(1_530_060_748);

    const fullRange = createSeededRng({ domain: "foundation", seed: "seed" });
    expect(fullRange.nextInt(0x1_0000_0000)).toBe(2_417_274_626);
    expectErrorCode(
      () => fullRange.nextInt(0),
      SeededRngError,
      "invalid_integer_bound",
    );
  });

  test("keeps generated floating values in the RNG contract", () => {
    const rng = createSeededRng({ domain: "float-bounds", seed: "sample" });
    for (let index = 0; index < 10_000; index += 1) {
      const value = rng.nextFloat();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  test("rejects malformed strings and byte limits before stream creation", () => {
    const unpairedHighSurrogate = String.fromCharCode(0xd800);
    expectErrorCode(
      () => createSeededRng({ domain: unpairedHighSurrogate, seed: "seed" }),
      SeededRngError,
      "malformed_unicode",
    );
    expectErrorCode(
      () =>
        createSeededRng({
          domain: "x".repeat(MAX_SEEDED_RNG_DOMAIN_UTF8_BYTES + 1),
          seed: "seed",
        }),
      SeededRngError,
      "domain_limit",
    );
    expectErrorCode(
      () =>
        createSeededRng({
          domain: "seed-limit",
          seed: new Uint8Array(MAX_SEEDED_RNG_SEED_BYTES + 1),
        }),
      SeededRngError,
      "seed_limit",
    );
  });

  test("rejects oversized seeds before consulting copy behavior", () => {
    const oversizedSeed = new Uint8Array(MAX_SEEDED_RNG_SEED_BYTES + 1);
    let copyAttempted = false;
    Object.defineProperty(oversizedSeed, Symbol.iterator, {
      configurable: true,
      get(): never {
        copyAttempted = true;
        throw new Error("oversized seed copy was attempted");
      },
    });

    expectErrorCode(
      () => createSeededRng({ domain: "copy-boundary", seed: oversizedSeed }),
      SeededRngError,
      "seed_limit",
    );
    expect(copyAttempted).toBe(false);
  });

  test("copies in-bound byte seeds without consulting overridable iteration", () => {
    const seed = new Uint8Array([7, 11, 13]);
    const plainSeed = new Uint8Array(seed);
    let iteratorConsulted = false;
    Object.defineProperty(seed, Symbol.iterator, {
      configurable: true,
      get(): never {
        iteratorConsulted = true;
        throw new Error("in-bound seed iterator was consulted");
      },
    });

    const actual = createSeededRng({ domain: "indexed-seed-copy", seed });
    const expected = createSeededRng({
      domain: "indexed-seed-copy",
      seed: plainSeed,
    });
    expect(iteratorConsulted).toBe(false);
    expect(
      Array.from({ length: 8 }, () => actual.nextUint32()),
    ).toEqual(Array.from({ length: 8 }, () => expected.nextUint32()));
  });

  test("keeps exact UTF-8 boundaries and rejects oversized text first", () => {
    const exactAsciiDomain = "a".repeat(MAX_SEEDED_RNG_DOMAIN_UTF8_BYTES);
    const exactTwoByteDomain = "é".repeat(
      MAX_SEEDED_RNG_DOMAIN_UTF8_BYTES / 2,
    );
    const exactFourByteDomain = "😀".repeat(
      MAX_SEEDED_RNG_DOMAIN_UTF8_BYTES / 4,
    );
    expect(
      createSeededRng({ domain: exactAsciiDomain, seed: "boundary" })
        .nextUint32(),
    ).toBeTypeOf("number");
    expect(
      createSeededRng({ domain: exactTwoByteDomain, seed: "boundary" })
        .nextUint32(),
    ).toBeTypeOf("number");
    expect(
      createSeededRng({ domain: exactFourByteDomain, seed: "boundary" })
        .nextUint32(),
    ).toBeTypeOf("number");

    expectErrorCode(
      () =>
        createSeededRng({
          domain: `${exactTwoByteDomain}é`,
          seed: "boundary",
        }),
      SeededRngError,
      "domain_limit",
    );
    expectErrorCode(
      () =>
        createSeededRng({
          domain: "seed-boundary",
          seed: "s".repeat(MAX_SEEDED_RNG_SEED_BYTES + 1),
        }),
      SeededRngError,
      "seed_limit",
    );
    expectErrorCode(
      () =>
        createSeededRng({
          domain: `${"x".repeat(
            MAX_SEEDED_RNG_DOMAIN_UTF8_BYTES + 1,
          )}${String.fromCharCode(0xd800)}`,
          seed: "boundary",
        }),
      SeededRngError,
      "domain_limit",
    );
  });

  test("provides finite exact sequences and detects leftovers or exhaustion", () => {
    const sequence = createSequenceRng(
      [0, 0.5, 1 - Number.EPSILON],
      "boundary sequence",
    );
    expectErrorCode(
      () => sequence.assertConsumed(),
      SeededRngError,
      "sequence_remaining",
    );
    expect([sequence.nextFloat(), sequence.nextFloat(), sequence.nextFloat()]).toEqual([
      0,
      0.5,
      1 - Number.EPSILON,
    ]);
    sequence.assertConsumed();
    expectErrorCode(
      () => sequence.nextFloat(),
      SeededRngError,
      "sequence_exhausted",
    );
    expectErrorCode(
      () => createSequenceRng([1]),
      SeededRngError,
      "invalid_sequence_value",
    );
  });

  test("copies exact sequence indices without consulting iteration", () => {
    const values = [0, 0.25, 0.75];
    let iteratorConsulted = false;
    Object.defineProperty(values, Symbol.iterator, {
      configurable: true,
      get(): never {
        iteratorConsulted = true;
        throw new Error("sequence iterator was consulted");
      },
    });

    const sequence = createSequenceRng(values, "indexed sequence copy");
    expect(iteratorConsulted).toBe(false);
    expect(sequence.remaining()).toBe(3);
    expect([sequence.nextFloat(), sequence.nextFloat(), sequence.nextFloat()]).toEqual([
      0,
      0.25,
      0.75,
    ]);
  });

  test("rejects sparse, oversized, and length-mutating sequences", () => {
    const sparse = new Array<number>(1);
    expectErrorCode(
      () => createSequenceRng(sparse),
      SeededRngError,
      "sequence_sparse",
    );

    const oversized = Array.from(
      { length: MAX_SEQUENCE_RNG_VALUES + 1 },
      () => 0.5,
    );
    expectErrorCode(
      () => createSequenceRng(oversized),
      SeededRngError,
      "sequence_limit",
    );

    const mutating = [0.25, 0.75];
    Object.defineProperty(mutating, 0, {
      configurable: true,
      get(): number {
        mutating.length = 1;
        return 0.25;
      },
    });
    expectErrorCode(
      () => createSequenceRng(mutating),
      SeededRngError,
      "sequence_mutated",
    );
  });
});

describe("bounded primitive text", () => {
  test("rejects oversized strings before Unicode scanning or UTF-8 encoding", () => {
    const failurePlan = createFailurePlan([{ checkpoint: "bounded" }]);
    const oversizedDomain = "x".repeat(
      MAX_SEEDED_RNG_DOMAIN_UTF8_BYTES + 1,
    );
    const oversizedSeed = "x".repeat(MAX_SEEDED_RNG_SEED_BYTES + 1);
    const oversizedSequenceLabel = "x".repeat(
      MAX_SEQUENCE_RNG_LABEL_UTF8_BYTES + 1,
    );
    const oversizedControlledLabel = "x".repeat(
      MAX_CONTROLLED_ASYNC_LABEL_UTF8_BYTES + 1,
    );
    const oversizedAbortLabel = "x".repeat(
      MAX_ABORT_HARNESS_LABEL_UTF8_BYTES + 1,
    );
    const oversizedFailureName = "x".repeat(
      MAX_FAILURE_PLAN_CHECKPOINT_UTF8_BYTES + 1,
    );
    const originalCharCodeAt = String.prototype.charCodeAt;
    const OriginalTextEncoder = globalThis.TextEncoder;
    const codes: unknown[] = [];
    let scannedCodeUnits = 0;
    let encodedStrings = 0;

    String.prototype.charCodeAt = function trackedCharCodeAt(
      this: string,
      index: number,
    ): number {
      scannedCodeUnits += 1;
      return originalCharCodeAt.call(this, index);
    };
    globalThis.TextEncoder = class TrackedTextEncoder extends OriginalTextEncoder {
      override encode(input?: string) {
        encodedStrings += 1;
        return super.encode(input);
      }
    };

    const collectCode = (action: () => unknown): void => {
      try {
        action();
        codes.push("no_error");
      } catch (error) {
        codes.push((error as { readonly code?: unknown }).code);
      }
    };

    try {
      collectCode(() =>
        createSeededRng({
          domain: oversizedDomain,
          seed: "seed",
        }),
      );
      collectCode(() =>
        createSeededRng({
          domain: "seed-bound",
          get seed(): string {
            scannedCodeUnits = 0;
            encodedStrings = 0;
            return oversizedSeed;
          },
        }),
      );
      collectCode(() =>
        createSequenceRng([0.5], oversizedSequenceLabel),
      );
      collectCode(() =>
        createControlledPromise(oversizedControlledLabel),
      );
      collectCode(() =>
        createAbortHarness(oversizedAbortLabel),
      );
      collectCode(() =>
        createFailurePlan([{ checkpoint: "bounded" }], {
          label: oversizedFailureName,
        }),
      );
      collectCode(() => failurePlan.hit(oversizedFailureName));
    } finally {
      String.prototype.charCodeAt = originalCharCodeAt;
      globalThis.TextEncoder = OriginalTextEncoder;
    }

    expect(codes).toEqual([
      "domain_limit",
      "seed_limit",
      "sequence_label_limit",
      "invalid_label",
      "invalid_label",
      "checkpoint_invalid",
      "checkpoint_invalid",
    ]);
    expect(scannedCodeUnits).toBe(0);
    expect(encodedStrings).toBe(0);
  });
});

describe("controlled asynchronous work", () => {
  test("records fulfillment and rejects duplicate settlement", async () => {
    const controlled = createControlledPromise<number>("fulfillment gate");
    controlled.assertPending();
    const observed = settleWithinMicrotasks(controlled.promise, {
      maxTurns: 2,
    });
    controlled.resolve(42);
    controlled.assertSettled();
    expect(controlled.state()).toEqual({ status: "fulfilled", value: 42 });
    await expect(observed).resolves.toEqual({
      status: "fulfilled",
      value: 42,
      turns: 1,
    });
    expectErrorCode(
      () => controlled.reject(new Error("late")),
      ControlledAsyncError,
      "already_settled",
    );
  });

  test("records rejection without converting its reason", async () => {
    const controlled = createControlledPromise<void>("rejection gate");
    const reason = Object.freeze({ code: "injected" });
    const observed = settleWithinMicrotasks(controlled.promise, { maxTurns: 2 });
    controlled.reject(reason);
    await expect(observed).resolves.toEqual({
      status: "rejected",
      reason,
      turns: 1,
    });
    expect(controlled.state()).toEqual({ status: "rejected", reason });
  });

  test("counts nested microtask turns and fails when the bound is too small", async () => {
    let ready = false;
    void Promise.resolve().then(() => {
      void Promise.resolve().then(() => {
        ready = true;
      });
    });
    await expect(
      waitForMicrotaskCondition(() => ready, {
        label: "nested readiness",
        maxTurns: 3,
      }),
    ).resolves.toBe(2);

    await expectAsyncErrorCode(
      () =>
        waitForMicrotaskCondition(() => false, {
          label: "omitted completion",
          maxTurns: 1,
        }),
      ControlledAsyncError,
      "microtask_limit",
    );
  });

  test("drains exact bounded turns and rejects asynchronous predicates", async () => {
    await drainMicrotasks(0);
    await drainMicrotasks(2);
    await expectAsyncErrorCode(
      () => drainMicrotasks(10_001),
      ControlledAsyncError,
      "invalid_turn_count",
    );
    await expectAsyncErrorCode(
      () =>
        waitForMicrotaskCondition(
          (async () => true) as unknown as () => boolean,
          { maxTurns: 1 },
        ),
      ControlledAsyncError,
      "predicate_async",
    );
  });

  test("rejects promise reference values without consuming the gate", () => {
    const controlled = createControlledPromise<string>("promise reference gate");
    const resolveUnchecked = controlled.resolve as (value: unknown) => void;
    expectErrorCode(
      () => resolveUnchecked(Promise.resolve("value")),
      ControlledAsyncError,
      "reference_value",
    );
    controlled.assertPending();
    controlled.resolve("safe value");
  });

  test("rejects plain reference values without consuming the gate", async () => {
    const controlled = createControlledPromise<string>("reference gate");
    const observed = settleWithinMicrotasks(controlled.promise, { maxTurns: 2 });
    const resolveUnchecked = controlled.resolve as (value: unknown) => void;

    expectErrorCode(
      () => resolveUnchecked(Object.freeze({ value: "not thenable" })),
      ControlledAsyncError,
      "reference_value",
    );
    controlled.assertPending();

    controlled.resolve("safe primitive");
    expect(controlled.state()).toEqual({
      status: "fulfilled",
      value: "safe primitive",
    });
    await expect(observed).resolves.toEqual({
      status: "fulfilled",
      value: "safe primitive",
      turns: 1,
    });
  });

  test("never reads a reentrant then getter before rejecting the value", async () => {
    const controlled = createControlledPromise<string>("reentrant then gate");
    const observed = settleWithinMicrotasks(controlled.promise, { maxTurns: 2 });
    const resolveUnchecked = controlled.resolve as (value: unknown) => void;
    const reentrantReason = Object.freeze({ code: "reentrant rejection" });
    let thenAccesses = 0;
    const referenceValue = {
      get then(): undefined {
        thenAccesses += 1;
        controlled.reject(reentrantReason);
        return undefined;
      },
    };

    expectErrorCode(
      () => resolveUnchecked(referenceValue),
      ControlledAsyncError,
      "reference_value",
    );
    expect(thenAccesses).toBe(0);
    controlled.assertPending();

    controlled.resolve("safe after reentrant value");
    expect(controlled.state()).toEqual({
      status: "fulfilled",
      value: "safe after reentrant value",
    });
    await expect(observed).resolves.toEqual({
      status: "fulfilled",
      value: "safe after reentrant value",
      turns: 1,
    });
  });

  test("never reads a time-varying then getter before rejecting the value", async () => {
    const controlled = createControlledPromise<string>("changing then gate");
    const observed = settleWithinMicrotasks(controlled.promise, { maxTurns: 2 });
    const resolveUnchecked = controlled.resolve as (value: unknown) => void;
    let thenAccesses = 0;
    const referenceValue = {
      get then(): undefined | ((resolve: (value: string) => void) => void) {
        thenAccesses += 1;
        return thenAccesses === 1
          ? undefined
          : (resolve): void => resolve("assimilated value");
      },
    };

    expectErrorCode(
      () => resolveUnchecked(referenceValue),
      ControlledAsyncError,
      "reference_value",
    );
    expect(thenAccesses).toBe(0);
    controlled.assertPending();

    controlled.resolve("safe after changing value");
    expect(controlled.state()).toEqual({
      status: "fulfilled",
      value: "safe after changing value",
    });
    await expect(observed).resolves.toEqual({
      status: "fulfilled",
      value: "safe after changing value",
      turns: 1,
    });
  });

  test("does not leave timeout-chain jobs after early settlement", async () => {
    const promisePrototype = Promise.prototype as unknown as {
      then: InstrumentedPromiseThen;
    };
    const originalThen = promisePrototype.then;
    let registrationWindowOpen = true;
    let helperReturned = false;
    let callbacksAfterReturn = 0;
    let settlement: Awaited<
      ReturnType<typeof settleWithinMicrotasks<string>>
    > | undefined;

    promisePrototype.then = function instrumentedThen(
      this: Promise<unknown>,
      onFulfilled?: ((value: unknown) => unknown) | null,
      onRejected?: ((reason: unknown) => unknown) | null,
    ): Promise<unknown> {
      const trackedRegistration = registrationWindowOpen;
      const wrap = (
        callback: ((value: unknown) => unknown) | null | undefined,
      ): ((value: unknown) => unknown) | null | undefined =>
        callback == null
          ? callback
          : (value: unknown): unknown => {
              if (trackedRegistration && helperReturned) {
                callbacksAfterReturn += 1;
              }
              return callback(value);
            };
      return originalThen.call(
        this,
        wrap(onFulfilled),
        wrap(onRejected),
      );
    };

    try {
      const observation = settleWithinMicrotasks(Promise.resolve("settled"), {
        label: "early settlement tail audit",
        maxTurns: MICROTASK_TAIL_PROBE_TURNS,
      });
      registrationWindowOpen = false;
      settlement = await observation;
      helperReturned = true;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, NEXT_TASK_DELAY_MS);
      });
    } finally {
      registrationWindowOpen = false;
      promisePrototype.then = originalThen;
    }

    expect(settlement).toEqual({
      status: "fulfilled",
      value: "settled",
      turns: 0,
    });
    expect(callbacksAfterReturn).toBe(0);
  });

  test("shares one settlement observer across repeated bounded timeouts", async () => {
    let resolvePending!: (value: string) => void;
    const pending = new Promise<string>((resolve) => {
      resolvePending = resolve;
    });
    const originalThen = pending.then;
    let observerRegistrations = 0;
    let observerCallbacks = 0;

    Object.defineProperty(pending, "then", {
      configurable: true,
      value(
        onFulfilled?: ((value: string) => unknown) | null,
        onRejected?: ((reason: unknown) => unknown) | null,
      ): Promise<unknown> {
        observerRegistrations += 1;
        const wrap = <T>(
          callback: ((value: T) => unknown) | null | undefined,
        ): ((value: T) => unknown) | null | undefined =>
          callback == null
            ? callback
            : (value: T): unknown => {
                observerCallbacks += 1;
                return callback(value);
              };
        return originalThen.call(
          pending,
          wrap(onFulfilled),
          wrap(onRejected),
        );
      },
    });

    for (let probe = 0; probe < REPEATED_SETTLEMENT_PROBES; probe += 1) {
      await expectAsyncErrorCode(
        () => settleWithinMicrotasks(pending, { maxTurns: 0 }),
        ControlledAsyncError,
        "microtask_limit",
      );
    }
    expect(observerRegistrations).toBe(1);
    expect(observerCallbacks).toBe(0);

    resolvePending("settled once");
    await drainMicrotasks(1);
    expect(observerCallbacks).toBe(1);
    await expect(
      settleWithinMicrotasks(pending, { maxTurns: 0 }),
    ).resolves.toEqual({
      status: "fulfilled",
      value: "settled once",
      turns: 0,
    });
    expect(observerRegistrations).toBe(1);
    expect(observerCallbacks).toBe(1);
  });
});

describe("abort harness", () => {
  test("records exact checkpoint order, occurrences, reason, requests, and events", () => {
    const harness = createAbortHarness("checkpoint audit");
    const reason = Object.freeze({ kind: "operator_abort" });
    try {
      expect(harness.checkpoint("before")).toMatchObject({
        sequence: 1,
        occurrence: 1,
        aborted: false,
      });
      harness.controller.abort(reason);
      harness.controller.abort("ignored second reason");
      expect(harness.checkpoint("after")).toMatchObject({
        sequence: 2,
        occurrence: 1,
        aborted: true,
        reason,
      });
      expect(harness.checkpoint("after").occurrence).toBe(2);
      harness.assertCheckpointSequence(["before", "after", "after"]);
      harness.assertAborted({ reason, requestCount: 2, eventCount: 1 });
    } finally {
      harness.restore();
    }
  });

  test("tracks duplicate, removed, once, object, and externally removed listeners", () => {
    const harness = createAbortHarness("listener audit");
    const external = new AbortController();
    let calls = 0;
    const persistent = (): void => {
      calls += 100;
    };
    const once = (): void => {
      calls += 1;
    };
    const objectListener = {
      handleEvent(): void {
        calls += 10;
      },
    };
    try {
      harness.signal.addEventListener("abort", persistent);
      harness.signal.addEventListener("abort", persistent);
      harness.signal.addEventListener("abort", once, { once: true });
      harness.signal.addEventListener("abort", objectListener, {
        signal: external.signal,
      });
      expect(harness.snapshot()).toMatchObject({
        activeListenerCount: 3,
        listenerAdds: 3,
      });

      external.abort("remove object listener");
      harness.signal.removeEventListener("abort", persistent);
      expect(harness.snapshot().activeListenerCount).toBe(1);
      harness.controller.abort("finish");
      expect(calls).toBe(1);
      harness.assertNoActiveListeners();
      expect(harness.snapshot()).toMatchObject({
        listenerAdds: 3,
        listenerRemovals: 3,
      });
    } finally {
      harness.restore();
    }
  });

  test("delegates removal for listeners registered through the native prototype", () => {
    const nativeAdd = EventTarget.prototype.addEventListener;
    const nativeRemove = EventTarget.prototype.removeEventListener;
    const captureValues = [false, true] as const;

    for (const capture of captureValues) {
      const harness = createAbortHarness(
        `prototype-direct listener capture=${String(capture)}`,
      );
      let calls = 0;
      let captureReads = 0;
      const listener = (): void => {
        calls += 1;
      };
      const removalOptions = {
        get capture(): boolean {
          captureReads += 1;
          return capture;
        },
      };
      try {
        Reflect.apply(nativeAdd, harness.signal, [
          "abort",
          listener,
          { capture },
        ]);
        harness.signal.removeEventListener(
          "abort",
          listener,
          removalOptions,
        );
        harness.signal.dispatchEvent(new Event("abort"));

        expect(calls).toBe(0);
        expect(captureReads).toBe(1);
        expect(harness.snapshot()).toMatchObject({
          activeListenerCount: 0,
          listenerAdds: 0,
          listenerRemovals: 0,
        });
        harness.assertNoActiveListeners();
      } finally {
        Reflect.apply(nativeRemove, harness.signal, [
          "abort",
          listener,
          { capture },
        ]);
        harness.restore();
      }
    }
  });

  test("preserves removal parity across opaque duplicates and reentrant conversion", () => {
    const nativeAdd = EventTarget.prototype.addEventListener;
    const nativeRemove = EventTarget.prototype.removeEventListener;
    const captureValues = [false, true] as const;
    const conversionKinds = ["capture", "type"] as const;

    for (const capture of captureValues) {
      const duplicateHarness = createAbortHarness(
        `opaque duplicate capture=${String(capture)}`,
      );
      let duplicateCalls = 0;
      const duplicateListener = (): void => {
        duplicateCalls += 1;
      };
      try {
        Reflect.apply(nativeAdd, duplicateHarness.signal, [
          "abort",
          duplicateListener,
          { capture },
        ]);
        duplicateHarness.signal.addEventListener(
          "abort",
          duplicateListener,
          { capture },
        );
        duplicateHarness.signal.removeEventListener(
          "abort",
          duplicateListener,
          { capture },
        );
        duplicateHarness.signal.dispatchEvent(new Event("abort"));

        expect(duplicateCalls).toBe(0);
        expect(duplicateHarness.snapshot()).toMatchObject({
          activeListenerCount: 0,
          listenerAdds: 1,
          listenerRemovals: 1,
        });
      } finally {
        Reflect.apply(nativeRemove, duplicateHarness.signal, [
          "abort",
          duplicateListener,
          { capture },
        ]);
        duplicateHarness.restore();
      }

      for (const conversionKind of conversionKinds) {
        const harness = createAbortHarness(
          `reentrant ${conversionKind} removal capture=${String(capture)}`,
        );
        const conversionError = new Error(
          `${conversionKind} conversion failed intentionally`,
        );
        let calls = 0;
        let conversions = 0;
        const listener = (): void => {
          calls += 1;
        };
        const addDuplicate = (): void => {
          harness.signal.addEventListener("abort", listener, { capture });
        };
        const eventType =
          conversionKind === "type"
            ? ({
                [Symbol.toPrimitive](): never {
                  conversions += 1;
                  addDuplicate();
                  throw conversionError;
                },
              } as unknown as string)
            : "abort";
        const removalOptions =
          conversionKind === "capture"
            ? {
                get capture(): never {
                  conversions += 1;
                  addDuplicate();
                  throw conversionError;
                },
              }
            : { capture };
        try {
          Reflect.apply(nativeAdd, harness.signal, [
            "abort",
            listener,
            { capture },
          ]);
          expect(() =>
            harness.signal.removeEventListener(
              eventType,
              listener,
              removalOptions,
            ),
          ).toThrow(conversionError);
          harness.signal.dispatchEvent(new Event("abort"));

          expect(conversions).toBe(1);
          expect(calls).toBe(1);
          expect(harness.snapshot()).toMatchObject({
            activeListenerCount: 0,
            listenerAdds: 0,
            listenerRemovals: 0,
          });
        } finally {
          Reflect.apply(nativeRemove, harness.signal, [
            "abort",
            listener,
            { capture },
          ]);
          harness.restore();
        }
      }
    }
  });

  test("scopes opaque removal reentrancy to the exact listener identity", () => {
    const nativeAdd = EventTarget.prototype.addEventListener;
    const nativeRemove = EventTarget.prototype.removeEventListener;
    const captureValues = [false, true] as const;

    for (const capture of captureValues) {
      const oppositeHarness = createAbortHarness(
        `opposite capture removal=${String(capture)}`,
      );
      const conversionError = new Error("capture conversion failed");
      let oppositeCalls = 0;
      const oppositeListener = (): void => {
        oppositeCalls += 1;
      };
      try {
        Reflect.apply(nativeAdd, oppositeHarness.signal, [
          "abort",
          oppositeListener,
          { capture },
        ]);
        oppositeHarness.signal.addEventListener("abort", oppositeListener, {
          capture: !capture,
        });
        expect(() =>
          oppositeHarness.signal.removeEventListener(
            "abort",
            oppositeListener,
            {
              get capture(): never {
                oppositeHarness.signal.addEventListener(
                  "abort",
                  oppositeListener,
                  { capture },
                );
                throw conversionError;
              },
            },
          ),
        ).toThrow(conversionError);
        oppositeHarness.signal.dispatchEvent(new Event("abort"));

        expect(oppositeCalls).toBe(2);
        expect(oppositeHarness.snapshot()).toMatchObject({
          activeListenerCount: 1,
          listenerAdds: 1,
          listenerRemovals: 0,
        });
      } finally {
        Reflect.apply(nativeRemove, oppositeHarness.signal, [
          "abort",
          oppositeListener,
          { capture },
        ]);
        oppositeHarness.signal.removeEventListener(
          "abort",
          oppositeListener,
          { capture: !capture },
        );
        oppositeHarness.restore();
      }

      const unrelatedHarness = createAbortHarness(
        `unrelated removal reentrancy capture=${String(capture)}`,
      );
      const unrelatedError = new Error("unrelated conversion failed");
      let outerCalls = 0;
      let unrelatedCalls = 0;
      const outerListener = (): void => {
        outerCalls += 1;
      };
      const unrelatedListener = (): void => {
        unrelatedCalls += 1;
      };
      try {
        unrelatedHarness.signal.addEventListener("abort", outerListener, {
          capture,
        });
        expect(() =>
          unrelatedHarness.signal.removeEventListener(
            "abort",
            outerListener,
            {
              get capture(): never {
                unrelatedHarness.signal.addEventListener(
                  "abort",
                  unrelatedListener,
                );
                throw unrelatedError;
              },
            },
          ),
        ).toThrow(unrelatedError);
        unrelatedHarness.signal.dispatchEvent(new Event("abort"));

        expect(outerCalls).toBe(1);
        expect(unrelatedCalls).toBe(1);
        expect(unrelatedHarness.snapshot()).toMatchObject({
          activeListenerCount: 2,
          listenerAdds: 2,
          listenerRemovals: 0,
        });
      } finally {
        unrelatedHarness.signal.removeEventListener(
          "abort",
          outerListener,
          { capture },
        );
        unrelatedHarness.signal.removeEventListener(
          "abort",
          unrelatedListener,
        );
        unrelatedHarness.restore();
      }
    }
  });

  test("matches native duplicate owner-signal cancellation on each runtime", () => {
    const captureValues = [false, true] as const;
    const exercise = (
      signal: AbortSignal,
      capture: boolean,
    ): {
      readonly calls: () => number;
      readonly listener: EventListener;
      readonly owners: readonly [AbortController, AbortController];
    } => {
      const owners = [new AbortController(), new AbortController()] as const;
      let calls = 0;
      const listener = (): void => {
        calls += 1;
      };
      signal.addEventListener("abort", listener, { capture });
      signal.addEventListener("abort", listener, {
        capture,
        signal: owners[0].signal,
      });
      signal.addEventListener("abort", listener, {
        capture,
        signal: owners[1].signal,
      });
      owners[1].abort("cancel duplicate registration");
      signal.dispatchEvent(new Event("abort"));
      signal.dispatchEvent(new Event("abort"));
      return { calls: () => calls, listener, owners };
    };

    for (const capture of captureValues) {
      const nativeController = new AbortController();
      const native = exercise(nativeController.signal, capture);
      const harness = createAbortHarness(
        `duplicate owner signals capture=${String(capture)}`,
      );
      const actual = exercise(harness.signal, capture);
      try {
        expect(actual.calls()).toBe(native.calls());
        native.owners[0].abort("prove native retained owner behavior");
        actual.owners[0].abort("prove harness retained owner behavior");
        nativeController.signal.dispatchEvent(new Event("abort"));
        harness.signal.dispatchEvent(new Event("abort"));
        expect(actual.calls()).toBe(native.calls());
        expect(harness.snapshot()).toMatchObject({
          activeListenerCount: native.calls() === 0 ? 0 : 1,
          listenerAdds: 1,
          listenerRemovals: native.calls() === 0 ? 1 : 0,
        });
      } finally {
        nativeController.signal.removeEventListener(
          "abort",
          native.listener,
          { capture },
        );
        harness.signal.removeEventListener("abort", actual.listener, {
          capture,
        });
        harness.restore();
      }
    }
  });

  test("matches native synthetic owner-signal cancellation semantics", () => {
    const captureValues = [false, true] as const;
    const exercise = (
      signal: AbortSignal,
      capture: boolean,
    ): { readonly calls: number; readonly listener: EventListener } => {
      const owner = new AbortController();
      let calls = 0;
      const listener = (): void => {
        calls += 1;
      };
      signal.addEventListener("abort", listener, {
        capture,
        once: true,
        signal: owner.signal,
      });
      owner.signal.dispatchEvent(new Event("abort"));
      signal.addEventListener("abort", listener, { capture });
      signal.dispatchEvent(new Event("abort"));
      signal.dispatchEvent(new Event("abort"));
      return { calls, listener };
    };

    for (const capture of captureValues) {
      const nativeTarget = new AbortController();
      const native = exercise(nativeTarget.signal, capture);
      const harness = createAbortHarness(
        `synthetic owner cancellation capture=${String(capture)}`,
      );
      const actual = exercise(harness.signal, capture);
      try {
        expect(actual.calls).toBe(native.calls);
        expect(harness.snapshot()).toMatchObject({
          activeListenerCount: native.calls === 2 ? 1 : 0,
          listenerAdds: native.calls === 2 ? 2 : 1,
          listenerRemovals: 1,
        });
      } finally {
        nativeTarget.signal.removeEventListener("abort", native.listener, {
          capture,
        });
        harness.signal.removeEventListener("abort", actual.listener, {
          capture,
        });
        harness.restore();
      }
    }
  });

  test("matches native owner cancellation despite stopped event propagation", () => {
    const captureValues = [false, true] as const;
    const registrationModes = ["initial", "duplicate"] as const;
    const exercise = (
      signal: AbortSignal,
      capture: boolean,
      registrationMode: (typeof registrationModes)[number],
    ): {
      readonly calls: () => number;
      readonly listener: EventListener;
      readonly owner: AbortController;
    } => {
      const owner = new AbortController();
      owner.signal.addEventListener("abort", (event) => {
        event.stopImmediatePropagation();
      });
      let calls = 0;
      const listener = (): void => {
        calls += 1;
      };
      if (registrationMode === "duplicate") {
        signal.addEventListener("abort", listener, { capture });
      }
      signal.addEventListener("abort", listener, {
        capture,
        signal: owner.signal,
      });
      owner.abort("cancel behind stopImmediatePropagation");
      signal.dispatchEvent(new Event("abort"));
      return { calls: () => calls, listener, owner };
    };

    for (const capture of captureValues) {
      for (const registrationMode of registrationModes) {
        const nativeController = new AbortController();
        const native = exercise(
          nativeController.signal,
          capture,
          registrationMode,
        );
        const harness = createAbortHarness(
          `stopped owner propagation ${registrationMode} capture=${String(capture)}`,
        );
        const actual = exercise(harness.signal, capture, registrationMode);
        try {
          expect(actual.calls()).toBe(native.calls());
          expect(harness.snapshot()).toMatchObject({
            activeListenerCount: native.calls() === 0 ? 0 : 1,
            listenerAdds: 1,
            listenerRemovals: native.calls() === 0 ? 1 : 0,
          });
        } finally {
          nativeController.signal.removeEventListener(
            "abort",
            native.listener,
            { capture },
          );
          harness.signal.removeEventListener("abort", actual.listener, {
            capture,
          });
          harness.restore();
        }
      }
    }
  });

  test("matches native owner cancellation at its registration-order slot", () => {
    const captureValues = [false, true] as const;
    const registrationModes = ["initial", "duplicate"] as const;
    const ownerListenerPositions = ["before", "after"] as const;
    const propagationModes = ["continue", "stop"] as const;
    type RegistrationMode = (typeof registrationModes)[number];
    type OwnerListenerPosition = (typeof ownerListenerPositions)[number];
    type PropagationMode = (typeof propagationModes)[number];
    interface ExerciseResult {
      readonly calls: number;
      readonly callsDuringOwnerListener: number;
      readonly listener: EventListener;
      readonly owner: AbortController;
    }
    const exercise = (
      signal: AbortSignal,
      capture: boolean,
      registrationMode: RegistrationMode,
      ownerListenerPosition: OwnerListenerPosition,
      propagationMode: PropagationMode,
      inspect: () => void,
    ): ExerciseResult => {
      const owner = new AbortController();
      let calls = 0;
      let callsDuringOwnerListener = 0;
      const listener = (): void => {
        calls += 1;
      };
      const ownerListener = (event: Event): void => {
        if (propagationMode === "stop") {
          event.stopImmediatePropagation();
        }
        inspect();
        signal.dispatchEvent(new Event("abort"));
        callsDuringOwnerListener = calls;
      };
      if (ownerListenerPosition === "before") {
        owner.signal.addEventListener("abort", ownerListener);
      }
      if (registrationMode === "duplicate") {
        signal.addEventListener("abort", listener, { capture });
      }
      signal.addEventListener("abort", listener, {
        capture,
        signal: owner.signal,
      });
      if (ownerListenerPosition === "after") {
        owner.signal.addEventListener("abort", ownerListener);
      }
      owner.abort("exercise owner cancellation ordering");
      signal.dispatchEvent(new Event("abort"));
      return { calls, callsDuringOwnerListener, listener, owner };
    };

    for (const capture of captureValues) {
      for (const registrationMode of registrationModes) {
        for (const ownerListenerPosition of ownerListenerPositions) {
          for (const propagationMode of propagationModes) {
            const nativeTarget = new AbortController();
            const native = exercise(
              nativeTarget.signal,
              capture,
              registrationMode,
              ownerListenerPosition,
              propagationMode,
              () => {},
            );
            const harness = createAbortHarness(
              `owner order ${registrationMode} ${ownerListenerPosition} ${propagationMode} capture=${String(capture)}`,
            );
            let activeDuringOwnerListener = -1;
            const actual = exercise(
              harness.signal,
              capture,
              registrationMode,
              ownerListenerPosition,
              propagationMode,
              () => {
                activeDuringOwnerListener =
                  harness.snapshot().activeListenerCount;
              },
            );
            try {
              expect(actual.calls).toBe(native.calls);
              const expectedActiveAfterAbort =
                native.calls > native.callsDuringOwnerListener ? 1 : 0;
              expect(activeDuringOwnerListener).toBe(
                native.callsDuringOwnerListener > 0 ? 1 : 0,
              );
              expect(harness.snapshot()).toMatchObject({
                activeListenerCount: expectedActiveAfterAbort,
                listenerAdds: 1,
                listenerRemovals: expectedActiveAfterAbort === 0 ? 1 : 0,
              });
            } finally {
              nativeTarget.signal.removeEventListener(
                "abort",
                native.listener,
                { capture },
              );
              harness.signal.removeEventListener("abort", actual.listener, {
                capture,
              });
              harness.restore();
            }
          }
        }
      }
    }
  });

  test("matches native reentrant registration during owner cancellation", () => {
    const captureValues = [false, true] as const;
    const registrationModes = ["initial", "duplicate"] as const;
    const ownerListenerPositions = ["before", "after"] as const;
    const propagationModes = ["continue", "stop"] as const;
    type RegistrationMode = (typeof registrationModes)[number];
    type OwnerListenerPosition = (typeof ownerListenerPositions)[number];
    type PropagationMode = (typeof propagationModes)[number];
    interface ExerciseResult {
      readonly calls: number;
      readonly callsDuringOwnerListener: number;
      readonly listener: EventListener;
    }
    const exercise = (
      signal: AbortSignal,
      capture: boolean,
      registrationMode: RegistrationMode,
      ownerListenerPosition: OwnerListenerPosition,
      propagationMode: PropagationMode,
    ): ExerciseResult => {
      const owner = new AbortController();
      let calls = 0;
      let callsDuringOwnerListener = 0;
      const listener = (): void => {
        calls += 1;
      };
      const ownerListener = (event: Event): void => {
        if (propagationMode === "stop") {
          event.stopImmediatePropagation();
        }
        signal.addEventListener("abort", listener, { capture });
        signal.dispatchEvent(new Event("abort"));
        callsDuringOwnerListener = calls;
      };
      if (ownerListenerPosition === "before") {
        owner.signal.addEventListener("abort", ownerListener);
      }
      if (registrationMode === "duplicate") {
        signal.addEventListener("abort", listener, { capture });
      }
      signal.addEventListener("abort", listener, {
        capture,
        signal: owner.signal,
      });
      if (ownerListenerPosition === "after") {
        owner.signal.addEventListener("abort", ownerListener);
      }
      owner.abort("exercise reentrant registration ordering");
      signal.dispatchEvent(new Event("abort"));
      return { calls, callsDuringOwnerListener, listener };
    };

    for (const capture of captureValues) {
      for (const registrationMode of registrationModes) {
        for (const ownerListenerPosition of ownerListenerPositions) {
          for (const propagationMode of propagationModes) {
            const nativeTarget = new AbortController();
            const native = exercise(
              nativeTarget.signal,
              capture,
              registrationMode,
              ownerListenerPosition,
              propagationMode,
            );
            const harness = createAbortHarness(
              `reentrant owner add ${registrationMode} ${ownerListenerPosition} ${propagationMode} capture=${String(capture)}`,
            );
            const actual = exercise(
              harness.signal,
              capture,
              registrationMode,
              ownerListenerPosition,
              propagationMode,
            );
            try {
              expect(actual.callsDuringOwnerListener).toBe(
                native.callsDuringOwnerListener,
              );
              expect(actual.calls).toBe(native.calls);
              const snapshot = harness.snapshot();
              expect(snapshot.activeListenerCount).toBe(
                native.calls > native.callsDuringOwnerListener ? 1 : 0,
              );
              expect(snapshot.listenerAdds - snapshot.listenerRemovals).toBe(
                snapshot.activeListenerCount,
              );
            } finally {
              nativeTarget.signal.removeEventListener(
                "abort",
                native.listener,
                { capture },
              );
              harness.signal.removeEventListener("abort", actual.listener, {
                capture,
              });
              harness.restore();
            }
          }
        }
      }
    }
  });

  test("matches native owner carry across synchronous once re-registration", () => {
    const captureValues = [false, true] as const;
    const readdModes = ["none", "different", "same", "pre-aborted"] as const;
    type ReaddMode = (typeof readdModes)[number];
    interface ExerciseResult {
      readonly calls: number;
      readonly listener: EventListener;
    }
    const exercise = (
      signal: AbortSignal,
      capture: boolean,
      readdMode: ReaddMode,
    ): ExerciseResult => {
      const originalOwner = new AbortController();
      const alternateOwner = new AbortController();
      if (readdMode === "pre-aborted") {
        alternateOwner.abort("pre-abort alternate owner");
      }
      let calls = 0;
      const listener = (): void => {
        calls += 1;
        if (calls !== 1) return;
        if (readdMode === "none") {
          signal.addEventListener("abort", listener, { capture });
          return;
        }
        signal.addEventListener("abort", listener, {
          capture,
          signal:
            readdMode === "same"
              ? originalOwner.signal
              : alternateOwner.signal,
        });
      };
      signal.addEventListener("abort", listener, {
        capture,
        once: true,
        signal: originalOwner.signal,
      });
      signal.dispatchEvent(new Event("abort"));
      originalOwner.abort("cancel original owner association");
      signal.dispatchEvent(new Event("abort"));
      return { calls, listener };
    };

    for (const capture of captureValues) {
      for (const readdMode of readdModes) {
        const nativeTarget = new AbortController();
        const native = exercise(nativeTarget.signal, capture, readdMode);
        const harness = createAbortHarness(
          `once owner carry ${readdMode} capture=${String(capture)}`,
        );
        const actual = exercise(harness.signal, capture, readdMode);
        try {
          expect(actual.calls).toBe(native.calls);
          const snapshot = harness.snapshot();
          expect(snapshot.listenerAdds - snapshot.listenerRemovals).toBe(
            snapshot.activeListenerCount,
          );
          expect(snapshot.activeListenerCount).toBe(
            native.calls === 2 ? 1 : 0,
          );
        } finally {
          nativeTarget.signal.removeEventListener("abort", native.listener, {
            capture,
          });
          harness.signal.removeEventListener("abort", actual.listener, {
            capture,
          });
          harness.restore();
        }
      }
    }
  });

  test("matches dormant owner associations across listener retirement", () => {
    const captureValues = [false, true] as const;
    const retirementModes = ["explicit", "once", "other-owner"] as const;
    type RetirementMode = (typeof retirementModes)[number];
    const exercise = (
      signal: AbortSignal,
      capture: boolean,
      retirementMode: RetirementMode,
    ): { readonly calls: number; readonly listener: EventListener } => {
      const firstOwner = new AbortController();
      const secondOwner = new AbortController();
      let calls = 0;
      const listener = (): void => {
        calls += 1;
      };

      if (retirementMode === "explicit") {
        signal.addEventListener("abort", listener, {
          capture,
          signal: firstOwner.signal,
        });
        signal.removeEventListener("abort", listener, { capture });
      } else if (retirementMode === "once") {
        signal.addEventListener("abort", listener, {
          capture,
          once: true,
          signal: firstOwner.signal,
        });
        signal.dispatchEvent(new Event("abort"));
      } else {
        signal.addEventListener("abort", listener, {
          capture,
          signal: firstOwner.signal,
        });
        signal.addEventListener("abort", listener, {
          capture,
          signal: secondOwner.signal,
        });
        firstOwner.abort("consume the first owner association");
      }

      signal.addEventListener("abort", listener, { capture, once: true });
      const cancellingOwner =
        retirementMode === "other-owner" ? secondOwner : firstOwner;
      cancellingOwner.abort("exercise a dormant owner association");
      signal.addEventListener("abort", listener, { capture });
      signal.dispatchEvent(new Event("abort"));
      signal.dispatchEvent(new Event("abort"));
      return { calls, listener };
    };

    for (const capture of captureValues) {
      for (const retirementMode of retirementModes) {
        const nativeTarget = new AbortController();
        const native = exercise(
          nativeTarget.signal,
          capture,
          retirementMode,
        );
        const harness = createAbortHarness(
          `dormant owner ${retirementMode} capture=${String(capture)}`,
        );
        const actual = exercise(harness.signal, capture, retirementMode);
        try {
          expect(actual.calls).toBe(native.calls);
          const retainedCallCount = retirementMode === "once" ? 3 : 2;
          const expectedActive = Number(
            native.calls === retainedCallCount,
          );
          expect(harness.snapshot()).toMatchObject({
            activeListenerCount: expectedActive,
            listenerAdds: expectedActive === 1 ? 3 : 2,
            listenerRemovals: 2,
          });
        } finally {
          nativeTarget.signal.removeEventListener("abort", native.listener, {
            capture,
          });
          harness.signal.removeEventListener("abort", actual.listener, {
            capture,
          });
          harness.restore();
        }
      }
    }
  });

  test("reuses a carried owner association at its configured bound", () => {
    const captureValues = [false, true] as const;
    const exercise = (
      signal: AbortSignal,
      owner: AbortController,
      capture: boolean,
    ): { readonly calls: number; readonly listener: EventListener } => {
      let calls = 0;
      const listener = (): void => {
        calls += 1;
        signal.addEventListener("abort", listener, {
          capture,
          signal: owner.signal,
        });
      };
      signal.addEventListener("abort", listener, {
        capture,
        once: true,
        signal: owner.signal,
      });
      signal.dispatchEvent(new Event("abort"));
      owner.abort("cancel the synchronous re-registration");
      signal.dispatchEvent(new Event("abort"));
      return { calls, listener };
    };

    for (const capture of captureValues) {
      const nativeTarget = new AbortController();
      const native = exercise(
        nativeTarget.signal,
        new AbortController(),
        capture,
      );
      const harness = createAbortHarness(
        `bounded carried owner capture=${String(capture)}`,
        { trackedListenerLimit: 1 },
      );
      const actual = exercise(
        harness.signal,
        new AbortController(),
        capture,
      );
      try {
        expect(actual.calls).toBe(native.calls);
        expect(harness.snapshot()).toMatchObject({
          activeListenerCount: 0,
          listenerAdds: 2,
          listenerRemovals: 2,
        });
      } finally {
        nativeTarget.signal.removeEventListener("abort", native.listener, {
          capture,
        });
        harness.signal.removeEventListener("abort", actual.listener, {
          capture,
        });
        harness.restore();
      }
    }
  });

  test("matches owner retention after failed event-type conversion", () => {
    const captureValues = [false, true] as const;
    const exercise = (
      signal: AbortSignal,
      capture: boolean,
    ): {
      readonly calls: number;
      readonly conversions: number;
      readonly listener: EventListener;
    } => {
      const owner = new AbortController();
      let calls = 0;
      let conversions = 0;
      let conversionFails = true;
      const type = {
        toString(): string {
          conversions += 1;
          if (conversionFails) {
            throw new Error("intentional first event-type failure");
          }
          return "abort";
        },
      };
      const listener = (): void => {
        calls += 1;
      };
      try {
        Reflect.apply(signal.addEventListener, signal, [
          type,
          listener,
          { capture, signal: owner.signal },
        ]);
      } catch {
        conversionFails = false;
      }
      signal.addEventListener("abort", listener, { capture, once: true });
      owner.abort("consume failed registration association");
      signal.addEventListener("abort", listener, { capture });
      signal.dispatchEvent(new Event("abort"));
      signal.dispatchEvent(new Event("abort"));
      return { calls, conversions, listener };
    };

    for (const capture of captureValues) {
      const nativeTarget = new AbortController();
      const native = exercise(nativeTarget.signal, capture);
      const harness = createAbortHarness(
        `failed type owner retention capture=${String(capture)}`,
      );
      const actual = exercise(harness.signal, capture);
      try {
        expect(actual.calls).toBe(native.calls);
        expect(actual.conversions).toBe(native.conversions);
        const expectedActive = native.calls === 2 ? 1 : 0;
        expect(harness.snapshot()).toMatchObject({
          activeListenerCount: expectedActive,
          listenerAdds: expectedActive === 1 ? 2 : 1,
          listenerRemovals: 1,
        });
      } finally {
        nativeTarget.signal.removeEventListener("abort", native.listener, {
          capture,
        });
        harness.signal.removeEventListener("abort", actual.listener, {
          capture,
        });
        harness.restore();
      }
    }
  });

  test("tracks a successful owner after a conditional failed association", () => {
    const captureValues = [false, true] as const;
    const exercise = (
      signal: AbortSignal,
      capture: boolean,
    ): {
      readonly calls: number;
      readonly conversions: number;
      readonly listener: EventListener;
    } => {
      const owner = new AbortController();
      let calls = 0;
      let conversions = 0;
      let conversionFails = true;
      const type = {
        toString(): string {
          conversions += 1;
          if (conversionFails) {
            throw new Error("intentional conditional association failure");
          }
          return "not-abort";
        },
      };
      const listener = (): void => {
        calls += 1;
      };
      try {
        Reflect.apply(signal.addEventListener, signal, [
          type,
          listener,
          { capture, signal: owner.signal },
        ]);
      } catch {
        conversionFails = false;
      }
      signal.addEventListener("abort", listener, {
        capture,
        signal: owner.signal,
      });
      owner.abort("consume conditional and unconditional associations");
      signal.dispatchEvent(new Event("abort"));
      return { calls, conversions, listener };
    };

    for (const capture of captureValues) {
      const nativeTarget = new AbortController();
      const native = exercise(nativeTarget.signal, capture);
      const harness = createAbortHarness(
        `conditional then successful owner capture=${String(capture)}`,
      );
      const actual = exercise(harness.signal, capture);
      try {
        expect(actual.calls).toBe(native.calls);
        expect(actual.conversions).toBe(native.conversions);
        expect(harness.snapshot()).toMatchObject({
          activeListenerCount: 0,
          listenerAdds: 1,
          listenerRemovals: 1,
        });
      } finally {
        nativeTarget.signal.removeEventListener("abort", native.listener, {
          capture,
        });
        harness.signal.removeEventListener("abort", actual.listener, {
          capture,
        });
        harness.restore();
      }
    }
  });

  test("rejects overridden owner-signal surfaces fail-closed", () => {
    const captureValues = [false, true] as const;
    const registrationModes = ["initial", "duplicate"] as const;
    const ownerStates = ["live", "pre-aborted"] as const;
    type RegistrationMode = (typeof registrationModes)[number];
    type OwnerState = (typeof ownerStates)[number];
    interface ExerciseResult {
      readonly calls: number;
      readonly error: unknown;
      readonly listener: EventListener;
      readonly ownerSurfaceReads: number;
    }
    const exercise = (
      signal: AbortSignal,
      capture: boolean,
      registrationMode: RegistrationMode,
      ownerState: OwnerState,
    ): ExerciseResult => {
      const owner = new AbortController();
      if (ownerState === "pre-aborted") {
        owner.abort("pre-abort hostile owner");
      }
      let ownerSurfaceReads = 0;
      const failOwnerSurface = (): never => {
        ownerSurfaceReads += 1;
        throw new Error("hostile owner surface was consulted");
      };
      Object.defineProperty(owner.signal, "aborted", {
        configurable: true,
        get: failOwnerSurface,
      });
      Object.defineProperty(owner.signal, "addEventListener", {
        configurable: true,
        value: failOwnerSurface,
      });
      Object.defineProperty(owner.signal, "removeEventListener", {
        configurable: true,
        value: failOwnerSurface,
      });
      let calls = 0;
      const listener = (): void => {
        calls += 1;
      };
      let error: unknown;
      try {
        if (registrationMode === "duplicate") {
          signal.addEventListener("abort", listener, { capture });
        }
        signal.addEventListener("abort", listener, {
          capture,
          signal: owner.signal,
        });
        if (ownerState === "live") {
          owner.abort("abort hostile owner");
        }
        signal.dispatchEvent(new Event("abort"));
      } catch (caught) {
        error = caught;
      }
      return {
        calls,
        error,
        listener,
        ownerSurfaceReads,
      };
    };

    for (const capture of captureValues) {
      for (const registrationMode of registrationModes) {
        for (const ownerState of ownerStates) {
          const harness = createAbortHarness(
            `hostile owner ${registrationMode} ${ownerState} capture=${String(capture)}`,
          );
          const actual = exercise(
            harness.signal,
            capture,
            registrationMode,
            ownerState,
          );
          try {
            expect(actual.error).toBeInstanceOf(AbortHarnessError);
            expect(actual.error).toMatchObject({
              code: "instrumentation_unsupported",
            });
            expect(actual.calls).toBe(0);
            expect(actual.ownerSurfaceReads).toBe(0);
            const expectedActive =
              registrationMode === "duplicate" ? 1 : 0;
            expect(harness.snapshot()).toMatchObject({
              activeListenerCount: expectedActive,
              listenerAdds: expectedActive,
              listenerRemovals: 0,
            });
          } finally {
            harness.signal.removeEventListener("abort", actual.listener, {
              capture,
            });
            harness.restore();
          }
        }
      }
    }
  });

  test("rejects mutated active-harness owner surfaces fail-closed", () => {
    const surfaces = [
      "aborted",
      "addEventListener",
      "removeEventListener",
    ] as const;

    for (const surface of surfaces) {
      const owner = createAbortHarness(`mutated owner ${surface}`);
      const target = createAbortHarness(`mutated owner target ${surface}`);
      const listener = (): void => {};
      let hostileSurfaceCalls = 0;
      const hostileSurface = (): never => {
        hostileSurfaceCalls += 1;
        throw new Error(`mutated owner ${surface} was invoked`);
      };
      try {
        Object.defineProperty(
          owner.signal,
          surface,
          surface === "aborted"
            ? { configurable: true, get: hostileSurface }
            : {
                configurable: true,
                value: hostileSurface,
                writable: true,
              },
        );
        expectErrorCode(
          () =>
            target.signal.addEventListener("abort", listener, {
              signal: owner.signal,
            }),
          AbortHarnessError,
          "instrumentation_unsupported",
        );
        expect(hostileSurfaceCalls).toBe(0);
        expect(target.snapshot()).toMatchObject({
          activeListenerCount: 0,
          listenerAdds: 0,
          listenerRemovals: 0,
        });
      } finally {
        target.restore();
        owner.restore();
      }
    }
  });

  test("invokes callable listeners without consulting their call property", () => {
    const listenerKinds = ["shadowed", "proxy"] as const;
    type ListenerKind = (typeof listenerKinds)[number];
    interface InvocationSnapshot {
      readonly bodyCalls: number;
      readonly callPropertyReads: number;
      readonly divertedCalls: number;
      readonly proxyApplyCalls: number;
      readonly replacementApplyCalls: number;
      readonly receiverMatched: boolean;
      readonly eventMatched: boolean;
    }
    const invoke = (
      signal: AbortSignal,
      listenerKind: ListenerKind,
    ): InvocationSnapshot => {
      const event = new Event("abort");
      let bodyCalls = 0;
      let callPropertyReads = 0;
      let divertedCalls = 0;
      let proxyApplyCalls = 0;
      let replacementApplyCalls = 0;
      let receiverMatched = false;
      let eventMatched = false;
      const originalReflectApply = Reflect.apply;
      const target = function listenerBody(
        this: unknown,
        receivedEvent: Event,
      ): void {
        bodyCalls += 1;
        receiverMatched = this === signal;
        eventMatched = receivedEvent === event;
      };
      let listener: EventListener;
      if (listenerKind === "shadowed") {
        Object.defineProperty(target, "call", {
          get(): () => void {
            callPropertyReads += 1;
            return () => {
              divertedCalls += 1;
            };
          },
        });
        listener = target;
      } else {
        listener = new Proxy(target, {
          get(proxyTarget, property, receiver): unknown {
            if (property === "call") {
              callPropertyReads += 1;
              return () => {
                divertedCalls += 1;
              };
            }
            return Reflect.get(proxyTarget, property, receiver);
          },
          apply(proxyTarget, thisArgument, argumentsList): unknown {
            proxyApplyCalls += 1;
            return originalReflectApply(
              proxyTarget,
              thisArgument,
              argumentsList,
            );
          },
        });
      }

      signal.addEventListener("abort", listener);
      const reflectApplyDescriptor = Object.getOwnPropertyDescriptor(
        Reflect,
        "apply",
      );
      Object.defineProperty(Reflect, "apply", {
        configurable: true,
        value(): never {
          replacementApplyCalls += 1;
          throw new Error("replacement Reflect.apply must not run");
        },
        writable: true,
      });
      try {
        signal.dispatchEvent(event);
      } finally {
        if (reflectApplyDescriptor === undefined) {
          Reflect.deleteProperty(Reflect, "apply");
        } else {
          Object.defineProperty(Reflect, "apply", reflectApplyDescriptor);
        }
      }

      return {
        bodyCalls,
        callPropertyReads,
        divertedCalls,
        proxyApplyCalls,
        replacementApplyCalls,
        receiverMatched,
        eventMatched,
      };
    };

    for (const listenerKind of listenerKinds) {
      const native = invoke(new AbortController().signal, listenerKind);
      const harness = createAbortHarness(`callable ${listenerKind} listener`);
      try {
        const actual = invoke(harness.signal, listenerKind);
        expect(actual).toEqual(native);
        expect(actual).toMatchObject({
          bodyCalls: 1,
          callPropertyReads: 0,
          divertedCalls: 0,
          proxyApplyCalls: listenerKind === "proxy" ? 1 : 0,
          replacementApplyCalls: 0,
          receiverMatched: true,
          eventMatched: true,
        });
      } finally {
        harness.restore();
      }
    }
  });

  test("uses intrinsic boolean conversion after hostile option getters", () => {
    const replacementModes = ["false", "throw"] as const;
    type ReplacementMode = (typeof replacementModes)[number];
    const exercise = (
      signal: AbortSignal,
      replacementMode: ReplacementMode,
    ): {
      readonly trace: readonly string[];
      readonly error:
        | { readonly name: string; readonly message: string }
        | undefined;
      readonly listenerCalls: number;
      readonly replacementCalls: number;
    } => {
      const trace: string[] = [];
      let listenerCalls = 0;
      let replacementCalls = 0;
      const booleanDescriptor = Object.getOwnPropertyDescriptor(
        globalThis,
        "Boolean",
      );
      const options = {} as AddEventListenerOptions;
      Object.defineProperty(options, "capture", {
        get(): boolean {
          trace.push("options.capture");
          Object.defineProperty(globalThis, "Boolean", {
            configurable: true,
            value(): boolean {
              replacementCalls += 1;
              if (replacementMode === "throw") {
                throw new Error("replacement Boolean must not run");
              }
              return false;
            },
            writable: true,
          });
          return false;
        },
      });
      for (const property of ["once", "passive"] as const) {
        Object.defineProperty(options, property, {
          get(): boolean {
            trace.push(`options.${property}`);
            return property === "once";
          },
        });
      }
      Object.defineProperty(options, "signal", {
        get(): undefined {
          trace.push("options.signal");
          return undefined;
        },
      });

      let error: unknown;
      try {
        signal.addEventListener(
          "abort",
          () => {
            listenerCalls += 1;
          },
          options,
        );
      } catch (caught) {
        error = caught;
      } finally {
        if (booleanDescriptor === undefined) {
          Reflect.deleteProperty(globalThis, "Boolean");
        } else {
          Object.defineProperty(globalThis, "Boolean", booleanDescriptor);
        }
      }
      signal.dispatchEvent(new Event("abort"));
      signal.dispatchEvent(new Event("abort"));
      return {
        trace,
        error:
          error instanceof Error
            ? { name: error.name, message: error.message }
            : undefined,
        listenerCalls,
        replacementCalls,
      };
    };

    for (const replacementMode of replacementModes) {
      const native = exercise(
        new AbortController().signal,
        replacementMode,
      );
      const harness = createAbortHarness(
        `Boolean replacement ${replacementMode}`,
      );
      try {
        const actual = exercise(harness.signal, replacementMode);
        expect(actual).toEqual(native);
        expect(actual).toMatchObject({
          error: undefined,
          listenerCalls: 1,
          replacementCalls: 0,
        });
        expect(harness.snapshot()).toMatchObject({
          activeListenerCount: 0,
          listenerAdds: 1,
          listenerRemovals: 1,
        });
      } finally {
        harness.restore();
      }
    }
  });

  test("survives mutable-intrinsic poisoning across listener finalization", () => {
    const intrinsicApply = Reflect.apply;
    const intrinsicDefineProperty = Object.defineProperty;
    const intrinsicDeleteProperty = Reflect.deleteProperty;
    const intrinsicGetOwnPropertyDescriptor =
      Object.getOwnPropertyDescriptor;
    const intrinsicGetPrototypeOf = Object.getPrototypeOf;
    const intrinsicString = String;
    const intrinsicArray = Array;
    const intrinsicArrayPrototype = Array.prototype;
    const eventTargetRemove = EventTarget.prototype.removeEventListener;
    const mapIteratorPrototype = intrinsicGetPrototypeOf(
      new Map().values(),
    );
    const arrayIteratorKey = Symbol.iterator;
    const speciesKey = Symbol.species;

    const exercise = (
      signal: AbortSignal,
      finalize: (listener: EventListener) => void,
    ): {
      readonly error:
        | { readonly name: string; readonly message: string }
        | undefined;
      readonly listenerCalls: number;
      readonly poisonCalls: number;
    } => {
      const owner = new AbortController();
      const restorations: Array<() => void> = [];
      let listenerCalls = 0;
      let poisonCalls = 0;
      const poison = (): never => {
        poisonCalls += 1;
        throw new Error("poisoned mutable intrinsic was consulted");
      };
      const appendRestoration = (restoration: () => void): void => {
        intrinsicDefineProperty(
          restorations,
          intrinsicString(restorations.length),
          {
            configurable: true,
            enumerable: true,
            value: restoration,
            writable: true,
          },
        );
      };
      const install = (
        target: object,
        property: PropertyKey,
        descriptor: PropertyDescriptor,
      ): void => {
        const original = intrinsicGetOwnPropertyDescriptor(target, property);
        appendRestoration(() => {
          if (original === undefined) {
            intrinsicDeleteProperty(target, property);
          } else {
            intrinsicDefineProperty(target, property, original);
          }
        });
        intrinsicDefineProperty(target, property, descriptor);
      };
      const poisonMethod = (target: object, property: PropertyKey): void => {
        install(target, property, {
          configurable: true,
          value: poison,
          writable: true,
        });
      };
      const poisonIntrinsics = (): void => {
        for (const property of ["apply", "get", "deleteProperty"] as const) {
          poisonMethod(Reflect, property);
        }
        for (const property of [
          "defineProperty",
          "freeze",
          "getOwnPropertyDescriptor",
          "getPrototypeOf",
          "is",
        ] as const) {
          poisonMethod(Object, property);
        }
        poisonMethod(JSON, "stringify");
        for (const property of ["get", "set", "delete", "forEach"] as const) {
          poisonMethod(Map.prototype, property);
        }
        for (const property of ["get", "set", "delete", "has"] as const) {
          poisonMethod(WeakMap.prototype, property);
        }
        for (const property of [
          "push",
          "slice",
          "splice",
          "reverse",
          "find",
        ] as const) {
          poisonMethod(intrinsicArrayPrototype, property);
        }
        poisonMethod(mapIteratorPrototype, "next");
        poisonMethod(mapIteratorPrototype, arrayIteratorKey);
        install(intrinsicArray, speciesKey, {
          configurable: true,
          get: poison,
        });
        for (const property of [
          "AbortController",
          "Array",
          "Map",
          "Proxy",
          "TextEncoder",
          "WeakMap",
        ] as const) {
          poisonMethod(globalThis, property);
        }
        poisonMethod(Number, "isSafeInteger");
        poisonMethod(intrinsicArrayPrototype, arrayIteratorKey);
        install(intrinsicArrayPrototype, "0", {
          configurable: true,
          set: poison,
        });
      };
      const restoreIntrinsics = (): void => {
        for (let index = restorations.length - 1; index >= 0; index -= 1) {
          restorations[index]!();
        }
      };

      const options = {} as AddEventListenerOptions;
      intrinsicDefineProperty(options, "capture", {
        get(): boolean {
          poisonIntrinsics();
          return false;
        },
      });
      intrinsicDefineProperty(options, "once", {
        get(): boolean {
          return false;
        },
      });
      intrinsicDefineProperty(options, "passive", {
        get(): boolean {
          return false;
        },
      });
      intrinsicDefineProperty(options, "signal", {
        get(): AbortSignal {
          return owner.signal;
        },
      });
      const type = {
        toString(): string {
          return "abort";
        },
      };
      const listener = (): void => {
        listenerCalls += 1;
      };
      let error: unknown;
      try {
        intrinsicApply(signal.addEventListener, signal, [
          type,
          listener,
          options,
        ]);
        signal.dispatchEvent(new Event("abort"));
        finalize(listener);
      } catch (caught) {
        error = caught;
      } finally {
        restoreIntrinsics();
      }

      return {
        error:
          error instanceof Error
            ? { name: error.name, message: error.message }
            : undefined,
        listenerCalls,
        poisonCalls,
      };
    };

    const nativeSignal = new AbortController().signal;
    const native = exercise(nativeSignal, (listener) => {
      intrinsicApply(eventTargetRemove, nativeSignal, ["abort", listener]);
    });
    const harness = createAbortHarness("mutable intrinsic poisoning");
    const actual = exercise(harness.signal, () => harness.restore());
    expect(actual).toEqual(native);
    expect(actual).toEqual({
      error: undefined,
      listenerCalls: 1,
      poisonCalls: 0,
    });
    expect(harness.snapshot()).toMatchObject({
      activeListenerCount: 0,
      listenerAdds: 1,
      listenerRemovals: 1,
      restored: true,
    });
  });

  test("tracks abort listeners registered through native event-type coercion", () => {
    interface EventTypeCase {
      readonly label: string;
      make(trace: string[]): unknown;
    }
    const eventTypeCases: readonly EventTypeCase[] = [
      {
        label: "boxed string",
        make: () => new String("abort"),
      },
      {
        label: "toString",
        make: (trace) => ({
          toString(): string {
            trace.push("type.toString");
            return "abort";
          },
        }),
      },
      {
        label: "toString then valueOf",
        make: (trace) => ({
          toString(): object {
            trace.push("type.toString");
            return {};
          },
          valueOf(): string {
            trace.push("type.valueOf");
            return "abort";
          },
        }),
      },
    ];
    const makeOptions = (trace: string[]): AddEventListenerOptions => {
      const options = {} as AddEventListenerOptions;
      for (const property of ["capture", "once", "passive"] as const) {
        Object.defineProperty(options, property, {
          get(): boolean {
            trace.push(`options.${property}`);
            return false;
          },
        });
      }
      Object.defineProperty(options, "signal", {
        get(): undefined {
          trace.push("options.signal");
          return undefined;
        },
      });
      return options;
    };
    const invokeAdd = (
      signal: AbortSignal,
      type: unknown,
      listener: EventListener,
      options: AddEventListenerOptions,
    ): void => {
      Reflect.apply(signal.addEventListener, signal, [
        type,
        listener,
        options,
      ]);
    };

    for (const eventTypeCase of eventTypeCases) {
      const native = new AbortController();
      const nativeTrace: string[] = [];
      let nativeCalls = 0;
      invokeAdd(
        native.signal,
        eventTypeCase.make(nativeTrace),
        () => {
          nativeCalls += 1;
        },
        makeOptions(nativeTrace),
      );
      native.signal.dispatchEvent(new Event("abort"));

      const harness = createAbortHarness(`coerced add ${eventTypeCase.label}`);
      const harnessTrace: string[] = [];
      let harnessCalls = 0;
      invokeAdd(
        harness.signal,
        eventTypeCase.make(harnessTrace),
        () => {
          harnessCalls += 1;
        },
        makeOptions(harnessTrace),
      );
      expect(harnessTrace).toEqual(nativeTrace);
      expect(nativeCalls).toBe(1);
      expect(harness.snapshot()).toMatchObject({
        activeListenerCount: 1,
        listenerAdds: 1,
        listenerRemovals: 0,
      });

      harness.signal.dispatchEvent(new Event("abort"));
      expect(harnessCalls).toBe(nativeCalls);
      expect(harnessCalls).toBe(1);
      harness.restore();
      harness.signal.dispatchEvent(new Event("abort"));
      expect(harnessCalls).toBe(1);
      expect(harness.snapshot()).toMatchObject({
        activeListenerCount: 0,
        listenerAdds: 1,
        listenerRemovals: 1,
        restored: true,
      });
    }
  });

  test("matches native owner abort reentrancy during event-type conversion", () => {
    interface ExerciseResult {
      readonly calls: number;
      readonly listener: EventListener;
      readonly trace: readonly string[];
    }
    const exercise = (signal: AbortSignal): ExerciseResult => {
      const owner = new AbortController();
      const trace: string[] = [];
      let conversions = 0;
      let calls = 0;
      const type = {
        toString(): string {
          conversions += 1;
          const conversion = conversions;
          trace.push(`type.${conversion}.enter`);
          if (conversion === 1) {
            owner.abort("abort during outer event-type conversion");
          }
          trace.push(`type.${conversion}.return`);
          return conversion === 1 ? "abort" : "cleanup-only";
        },
      };
      const options = {} as AddEventListenerOptions;
      for (const property of ["capture", "once", "passive"] as const) {
        Object.defineProperty(options, property, {
          get(): boolean {
            trace.push(`options.${property}`);
            return false;
          },
        });
      }
      Object.defineProperty(options, "signal", {
        get(): AbortSignal {
          trace.push("options.signal");
          return owner.signal;
        },
      });
      const listener = (): void => {
        calls += 1;
      };

      Reflect.apply(signal.addEventListener, signal, [type, listener, options]);
      signal.dispatchEvent(new Event("abort"));
      signal.dispatchEvent(new Event("cleanup-only"));
      return { calls, listener, trace };
    };

    const nativeTarget = new AbortController();
    const native = exercise(nativeTarget.signal);
    const harness = createAbortHarness("owner abort during event type");
    const actual = exercise(harness.signal);
    try {
      expect(actual.trace).toEqual(native.trace);
      expect(actual.calls).toBe(native.calls);
      expect(harness.snapshot()).toMatchObject({
        activeListenerCount: native.calls === 0 ? 0 : 1,
        listenerAdds: native.calls === 0 ? 0 : 1,
        listenerRemovals: 0,
      });
    } finally {
      nativeTarget.signal.removeEventListener("abort", native.listener);
      harness.signal.removeEventListener("abort", actual.listener);
      harness.restore();
    }
  });

  test("matches native event-type conversion during removal and failure", () => {
    const invoke = (
      method: "addEventListener" | "removeEventListener",
      signal: AbortSignal,
      type: unknown,
      listener: EventListener,
      options: unknown,
    ): unknown => {
      try {
        Reflect.apply(signal[method], signal, [type, listener, options]);
        return undefined;
      } catch (error) {
        return error;
      }
    };
    const errorShape = (
      error: unknown,
    ): { readonly name: string; readonly message: string } | undefined =>
      error instanceof Error
        ? { name: error.name, message: error.message }
        : undefined;
    const makeRemovalType = (trace: string[]): unknown => ({
      toString(): string {
        trace.push("type.toString");
        return "abort";
      },
    });
    const makeRemovalOptions = (trace: string[]): EventListenerOptions => {
      const options = {} as EventListenerOptions;
      Object.defineProperty(options, "capture", {
        get(): boolean {
          trace.push("options.capture");
          return false;
        },
      });
      return options;
    };

    const native = new AbortController();
    const nativeTrace: string[] = [];
    let nativeCalls = 0;
    const nativeListener = (): void => {
      nativeCalls += 1;
    };
    native.signal.addEventListener("abort", nativeListener);
    invoke(
      "removeEventListener",
      native.signal,
      makeRemovalType(nativeTrace),
      nativeListener,
      makeRemovalOptions(nativeTrace),
    );
    native.signal.dispatchEvent(new Event("abort"));

    const harness = createAbortHarness("coerced removal");
    const harnessTrace: string[] = [];
    let harnessCalls = 0;
    const harnessListener = (): void => {
      harnessCalls += 1;
    };
    try {
      harness.signal.addEventListener("abort", harnessListener);
      invoke(
        "removeEventListener",
        harness.signal,
        makeRemovalType(harnessTrace),
        harnessListener,
        makeRemovalOptions(harnessTrace),
      );
      harness.signal.dispatchEvent(new Event("abort"));
      expect(harnessTrace).toEqual(nativeTrace);
      expect(harnessCalls).toBe(nativeCalls);
      expect(harness.snapshot()).toMatchObject({
        activeListenerCount: 0,
        listenerAdds: 1,
        listenerRemovals: 1,
      });
    } finally {
      harness.restore();
    }

    const injected = new Error("event type conversion failed");
    const makeThrowingType = (trace: string[]): unknown => ({
      toString(): never {
        trace.push("type.toString");
        throw injected;
      },
    });
    const makeAddOptions = (trace: string[]): AddEventListenerOptions => {
      const options = {} as AddEventListenerOptions;
      for (const property of ["capture", "once", "passive"] as const) {
        Object.defineProperty(options, property, {
          get(): boolean {
            trace.push(`options.${property}`);
            return false;
          },
        });
      }
      Object.defineProperty(options, "signal", {
        get(): undefined {
          trace.push("options.signal");
          return undefined;
        },
      });
      return options;
    };
    const nativeFailureTrace: string[] = [];
    const nativeFailure = new AbortController();
    const nativeError = invoke(
      "addEventListener",
      nativeFailure.signal,
      makeThrowingType(nativeFailureTrace),
      () => {},
      makeAddOptions(nativeFailureTrace),
    );
    const failureHarness = createAbortHarness("throwing event type");
    const harnessFailureTrace: string[] = [];
    try {
      const harnessError = invoke(
        "addEventListener",
        failureHarness.signal,
        makeThrowingType(harnessFailureTrace),
        () => {},
        makeAddOptions(harnessFailureTrace),
      );
      expect(harnessFailureTrace).toEqual(nativeFailureTrace);
      expect(errorShape(harnessError)).toEqual(errorShape(nativeError));
      expect(harnessError).toBe(injected);
      expect(failureHarness.snapshot()).toMatchObject({
        activeListenerCount: 0,
        listenerAdds: 0,
        listenerRemovals: 0,
      });
    } finally {
      failureHarness.restore();
    }
    failureHarness.signal.dispatchEvent(new Event("abort"));
  });

  test("matches native no-op when an option signal aborts before registration", () => {
    const abortPoints = [
      "pre-aborted",
      "capture",
      "once",
      "passive",
      "signal",
    ] as const;
    type AbortPoint = (typeof abortPoints)[number];
    const conversionModes = ["return", "throw"] as const;
    type ConversionMode = (typeof conversionModes)[number];
    interface ExerciseResult {
      readonly trace: readonly string[];
      readonly error:
        | { readonly name: string; readonly message: string }
        | undefined;
      calls(): number;
    }
    const exercise = (
      signal: AbortSignal,
      abortPoint: AbortPoint,
      conversionMode: ConversionMode,
    ): ExerciseResult => {
      const owner = new AbortController();
      if (abortPoint === "pre-aborted") {
        owner.abort("pre-aborted option signal");
      }
      const trace: string[] = [];
      let listenerCalls = 0;
      const type = {
        toString(): string {
          trace.push("type.toString");
          if (conversionMode === "throw") {
            throw new Error(`type conversion failed at ${abortPoint}`);
          }
          return "abort";
        },
      };
      const options = {} as AddEventListenerOptions;
      for (const property of ["capture", "once", "passive"] as const) {
        Object.defineProperty(options, property, {
          get(): boolean {
            trace.push(`options.${property}`);
            if (abortPoint === property) {
              owner.abort(`aborted during ${property}`);
            }
            return false;
          },
        });
      }
      Object.defineProperty(options, "signal", {
        get(): AbortSignal {
          trace.push("options.signal");
          if (abortPoint === "signal") {
            owner.abort("aborted during signal");
          }
          return owner.signal;
        },
      });

      let error: unknown;
      try {
        Reflect.apply(signal.addEventListener, signal, [
          type,
          () => {
            listenerCalls += 1;
          },
          options,
        ]);
      } catch (caught) {
        error = caught;
      }
      signal.dispatchEvent(new Event("abort"));
      return {
        trace,
        error:
          error instanceof Error
            ? { name: error.name, message: error.message }
            : undefined,
        calls: () => listenerCalls,
      };
    };

    for (const abortPoint of abortPoints) {
      for (const conversionMode of conversionModes) {
        const native = exercise(
          new AbortController().signal,
          abortPoint,
          conversionMode,
        );
        const harness = createAbortHarness(
          `option signal ${abortPoint} ${conversionMode}`,
        );
        const actual = exercise(
          harness.signal,
          abortPoint,
          conversionMode,
        );
        try {
          expect(actual.trace).toEqual(native.trace);
          expect(actual.error).toEqual(native.error);
          if (
            conversionMode === "return" ||
            !native.trace.includes("type.toString")
          ) {
            expect(actual.error).toBeUndefined();
          } else {
            expect(actual.error).toEqual({
              name: "Error",
              message: `type conversion failed at ${abortPoint}`,
            });
          }
          expect(actual.calls()).toBe(native.calls());
          expect(actual.calls()).toBe(0);
          expect(harness.snapshot()).toMatchObject({
            activeListenerCount: 0,
            listenerAdds: 0,
            listenerRemovals: 0,
          });
        } finally {
          harness.restore();
        }
        harness.signal.dispatchEvent(new Event("abort"));
        expect(actual.calls()).toBe(0);
      }
    }
  });

  test("does not finalize a coerced listener after reentrant restoration", () => {
    const restorationPoints = ["type", "options"] as const;
    type RestorationPoint = (typeof restorationPoints)[number];
    const makeType = (
      trace: string[],
      restorationPoint: RestorationPoint,
      restore: () => void,
    ): unknown => ({
      toString(): string {
        trace.push("type.toString");
        if (restorationPoint === "type") {
          trace.push("restore");
          restore();
        }
        return "abort";
      },
    });
    const makeOptions = (
      trace: string[],
      restorationPoint: RestorationPoint,
      restore: () => void,
    ): AddEventListenerOptions => {
      const options = {} as AddEventListenerOptions;
      for (const property of ["capture", "once", "passive"] as const) {
        Object.defineProperty(options, property, {
          get(): boolean {
            trace.push(`options.${property}`);
            if (
              property === "capture" &&
              restorationPoint === "options"
            ) {
              trace.push("restore");
              restore();
            }
            return false;
          },
        });
      }
      Object.defineProperty(options, "signal", {
        get(): undefined {
          trace.push("options.signal");
          return undefined;
        },
      });
      return options;
    };
    const invokeAdd = (
      signal: AbortSignal,
      type: unknown,
      listener: EventListener,
      options: AddEventListenerOptions,
    ): void => {
      Reflect.apply(signal.addEventListener, signal, [
        type,
        listener,
        options,
      ]);
    };

    for (const restorationPoint of restorationPoints) {
      const native = new AbortController();
      const nativeTrace: string[] = [];
      const nativeListener = (): void => {};
      invokeAdd(
        native.signal,
        makeType(nativeTrace, restorationPoint, () => {}),
        nativeListener,
        makeOptions(nativeTrace, restorationPoint, () => {}),
      );
      native.signal.removeEventListener("abort", nativeListener);

      const harness = createAbortHarness(
        `reentrant ${restorationPoint} restoration`,
      );
      const harnessTrace: string[] = [];
      let harnessCalls = 0;
      invokeAdd(
        harness.signal,
        makeType(harnessTrace, restorationPoint, () => harness.restore()),
        () => {
          harnessCalls += 1;
        },
        makeOptions(harnessTrace, restorationPoint, () => harness.restore()),
      );

      expect(harnessTrace).toEqual(nativeTrace);
      expect(harness.snapshot()).toMatchObject({
        activeListenerCount: 0,
        listenerAdds: 0,
        listenerRemovals: 0,
        restored: true,
      });
      harness.signal.dispatchEvent(new Event("abort"));
      expect(harnessCalls).toBe(0);
    }
  });

  test("preserves borrowed receivers and cached post-restore methods", () => {
    const captureError = (action: () => void): unknown => {
      try {
        action();
        return undefined;
      } catch (error) {
        return error;
      }
    };
    const errorShape = (
      error: unknown,
    ): { readonly name: string; readonly message: string } | undefined =>
      error instanceof Error
        ? { name: error.name, message: error.message }
        : undefined;
    const harness = createAbortHarness("borrowed receiver");
    const cachedAdd = harness.signal.addEventListener;
    const cachedRemove = harness.signal.removeEventListener;
    const cachedAbort = harness.controller.abort;
    const alternate = new AbortController();
    let alternateCalls = 0;
    const alternateListener = (): void => {
      alternateCalls += 1;
    };
    try {
      Reflect.apply(cachedAdd, alternate.signal, [
        "abort",
        alternateListener,
      ]);
      alternate.signal.dispatchEvent(new Event("abort"));
      expect(alternateCalls).toBe(1);
      Reflect.apply(cachedRemove, alternate.signal, [
        "abort",
        alternateListener,
      ]);
      alternate.signal.dispatchEvent(new Event("abort"));
      expect(alternateCalls).toBe(1);

      const alternateReason = Object.freeze({ kind: "borrowed abort" });
      Reflect.apply(cachedAbort, alternate, [alternateReason]);
      expect(alternate.signal.aborted).toBe(true);
      expect(alternate.signal.reason).toBe(alternateReason);
      expect(harness.snapshot()).toMatchObject({
        abortRequestCount: 0,
        activeListenerCount: 0,
        listenerAdds: 0,
        listenerRemovals: 0,
      });

      const nativeSignal = new AbortController().signal;
      const nativeController = new AbortController();
      const invalidReceiver = {};
      const listener = (): void => {};
      const nativeAddError = captureError(() => {
        Reflect.apply(nativeSignal.addEventListener, invalidReceiver, [
          "abort",
          listener,
        ]);
      });
      const harnessAddError = captureError(() => {
        Reflect.apply(cachedAdd, invalidReceiver, ["abort", listener]);
      });
      expect(errorShape(harnessAddError)).toEqual(errorShape(nativeAddError));

      const nativeRemoveError = captureError(() => {
        Reflect.apply(nativeSignal.removeEventListener, invalidReceiver, [
          "abort",
          listener,
        ]);
      });
      const harnessRemoveError = captureError(() => {
        Reflect.apply(cachedRemove, invalidReceiver, ["abort", listener]);
      });
      expect(errorShape(harnessRemoveError)).toEqual(
        errorShape(nativeRemoveError),
      );

      const nativeAbortError = captureError(() => {
        Reflect.apply(nativeController.abort, invalidReceiver, []);
      });
      const harnessAbortError = captureError(() => {
        Reflect.apply(cachedAbort, invalidReceiver, []);
      });
      expect(errorShape(harnessAbortError)).toEqual(
        errorShape(nativeAbortError),
      );
    } finally {
      harness.restore();
    }

    let restoredCalls = 0;
    const restoredListener = (): void => {
      restoredCalls += 1;
    };
    Reflect.apply(cachedAdd, harness.signal, ["abort", restoredListener]);
    harness.signal.dispatchEvent(new Event("abort"));
    expect(restoredCalls).toBe(1);
    Reflect.apply(cachedRemove, harness.signal, ["abort", restoredListener]);
    harness.signal.dispatchEvent(new Event("abort"));
    expect(restoredCalls).toBe(1);
    const restoredReason = Object.freeze({ kind: "cached abort" });
    Reflect.apply(cachedAbort, harness.controller, [restoredReason]);
    expect(harness.snapshot()).toMatchObject({
      aborted: true,
      reason: restoredReason,
      abortRequestCount: 0,
      abortEventCount: 0,
      activeListenerCount: 0,
      restored: true,
    });
  });

  test("preserves native same-signal cancellation without counting hidden listeners", () => {
    const nativeController = new AbortController();
    let nativeCalls = 0;
    nativeController.signal.addEventListener(
      "abort",
      () => {
        nativeCalls += 1;
      },
      { signal: nativeController.signal },
    );
    nativeController.abort("native same-signal abort");

    const harness = createAbortHarness("same-signal cancellation");
    let harnessCalls = 0;
    try {
      harness.signal.addEventListener(
        "abort",
        () => {
          harnessCalls += 1;
        },
        { signal: harness.signal },
      );
      expect(harness.snapshot()).toMatchObject({
        activeListenerCount: 1,
        listenerAdds: 1,
      });

      harness.controller.abort("harness same-signal abort");
      expect(harnessCalls).toBe(nativeCalls);
      expect(harnessCalls).toBe(0);
      harness.assertNoActiveListeners();
      expect(harness.snapshot().listenerRemovals).toBe(1);
    } finally {
      harness.restore();
    }
  });

  test("matches native cross-signal abort ordering on each runtime", () => {
    const nativeTarget = new AbortController();
    const nativeOwner = new AbortController();
    const nativeTrace: string[] = [];
    nativeOwner.signal.addEventListener("abort", () => {
      nativeTrace.push("owner");
      nativeTarget.abort("native target abort");
    });
    nativeTarget.signal.addEventListener(
      "abort",
      () => nativeTrace.push("target"),
      { signal: nativeOwner.signal },
    );
    nativeOwner.abort("native owner abort");

    const target = createAbortHarness("cross-signal target");
    const owner = createAbortHarness("cross-signal owner");
    const harnessTrace: string[] = [];
    try {
      owner.signal.addEventListener("abort", () => {
        harnessTrace.push("owner");
        target.controller.abort("harness target abort");
      });
      target.signal.addEventListener(
        "abort",
        () => harnessTrace.push("target"),
        { signal: owner.signal },
      );
      expect(owner.snapshot().activeListenerCount).toBe(1);
      expect(target.snapshot().activeListenerCount).toBe(1);

      owner.controller.abort("harness owner abort");
      expect(harnessTrace).toEqual(nativeTrace);
      target.assertNoActiveListeners();
      expect(owner.snapshot()).toMatchObject({
        activeListenerCount: 1,
        listenerAdds: 1,
      });
      expect(target.snapshot()).toMatchObject({
        activeListenerCount: 0,
        listenerAdds: 1,
        listenerRemovals: 1,
      });
    } finally {
      target.restore();
      owner.restore();
    }
  });

  test("matches native option getter order, receiver, and duplicate conversion", () => {
    const makeOptions = (
      trace: string[],
      ownerSignal: AbortSignal,
      receiverChecks: boolean[],
    ): AddEventListenerOptions => {
      const options = {} as AddEventListenerOptions;
      const addGetter = (
        property: "capture" | "once" | "passive" | "signal",
        value: unknown,
      ): void => {
        Object.defineProperty(options, property, {
          configurable: true,
          get(this: AddEventListenerOptions): unknown {
            trace.push(property);
            receiverChecks.push(this === options);
            return value;
          },
        });
      };
      addGetter("capture", false);
      addGetter("once", false);
      addGetter("passive", false);
      addGetter("signal", ownerSignal);
      return options;
    };

    const nativeTarget = new AbortController();
    const nativeOwner = new AbortController();
    const nativeTrace: string[] = [];
    const nativeReceivers: boolean[] = [];
    const nativeListener = (): void => {};
    const nativeOptions = makeOptions(
      nativeTrace,
      nativeOwner.signal,
      nativeReceivers,
    );
    nativeTarget.signal.addEventListener("abort", nativeListener, nativeOptions);
    nativeTarget.signal.addEventListener("abort", nativeListener, nativeOptions);

    const target = createAbortHarness("getter-order target");
    const owner = createAbortHarness("getter-order owner");
    const harnessTrace: string[] = [];
    const harnessReceivers: boolean[] = [];
    const harnessListener = (): void => {};
    try {
      const harnessOptions = makeOptions(
        harnessTrace,
        owner.signal,
        harnessReceivers,
      );
      target.signal.addEventListener("abort", harnessListener, harnessOptions);
      target.signal.addEventListener("abort", harnessListener, harnessOptions);

      expect(harnessTrace).toEqual(nativeTrace);
      expect(harnessReceivers).toEqual(nativeReceivers);
      expect(harnessReceivers.every(Boolean)).toBe(true);
      for (const property of ["capture", "once", "passive", "signal"]) {
        expect(harnessTrace.filter((entry) => entry === property)).toHaveLength(2);
      }
      expect(target.snapshot()).toMatchObject({
        activeListenerCount: 1,
        listenerAdds: 1,
        listenerRemovals: 0,
      });
      expect(owner.snapshot().activeListenerCount).toBe(0);

      owner.controller.abort("remove converted listener");
      target.assertNoActiveListeners();
      expect(target.snapshot()).toMatchObject({
        listenerAdds: 1,
        listenerRemovals: 1,
      });
    } finally {
      target.restore();
      owner.restore();
    }
  });

  test("matches native truthy capture duplicate identity", () => {
    const truthyCapture = { capture: 1 as unknown as boolean, once: true };
    const native = new AbortController();
    let nativeCalls = 0;
    const nativeListener = (): void => {
      nativeCalls += 1;
    };
    native.signal.addEventListener("abort", nativeListener, truthyCapture);
    native.signal.addEventListener("abort", nativeListener, {
      capture: true,
      once: false,
    });
    native.signal.addEventListener("abort", nativeListener, {
      capture: false,
      once: false,
    });
    native.signal.dispatchEvent(new Event("abort"));
    native.signal.dispatchEvent(new Event("abort"));
    native.signal.removeEventListener("abort", nativeListener, {
      capture: false,
    });
    native.signal.dispatchEvent(new Event("abort"));

    const harness = createAbortHarness("truthy capture duplicates");
    let harnessCalls = 0;
    const harnessListener = (): void => {
      harnessCalls += 1;
    };
    try {
      harness.signal.addEventListener("abort", harnessListener, truthyCapture);
      harness.signal.addEventListener("abort", harnessListener, {
        capture: true,
        once: false,
      });
      harness.signal.addEventListener("abort", harnessListener, {
        capture: false,
        once: false,
      });
      harness.signal.dispatchEvent(new Event("abort"));
      harness.signal.dispatchEvent(new Event("abort"));
      harness.signal.removeEventListener("abort", harnessListener, {
        capture: false,
      });
      harness.signal.dispatchEvent(new Event("abort"));

      expect(harnessCalls).toBe(nativeCalls);
      expect(harnessCalls).toBe(3);
      expect(harness.snapshot()).toMatchObject({
        activeListenerCount: 0,
        listenerAdds: 2,
        listenerRemovals: 2,
      });
    } finally {
      harness.restore();
    }
  });

  test("matches native once coercion for boolean-like getter values", () => {
    const values: readonly unknown[] = [true, 1, "yes", {}, false, 0];
    for (const value of values) {
      const makeOptions = (
        trace: string[],
        receivers: boolean[],
      ): AddEventListenerOptions => {
        const options = {} as AddEventListenerOptions;
        Object.defineProperty(options, "once", {
          get(this: AddEventListenerOptions): unknown {
            trace.push("once");
            receivers.push(this === options);
            return value;
          },
        });
        return options;
      };

      const native = new AbortController();
      const nativeTrace: string[] = [];
      const nativeReceivers: boolean[] = [];
      let nativeCalls = 0;
      native.signal.addEventListener(
        "abort",
        () => {
          nativeCalls += 1;
        },
        makeOptions(nativeTrace, nativeReceivers),
      );
      native.signal.dispatchEvent(new Event("abort"));
      native.signal.dispatchEvent(new Event("abort"));

      const harness = createAbortHarness("once conversion");
      const harnessTrace: string[] = [];
      const harnessReceivers: boolean[] = [];
      let harnessCalls = 0;
      try {
        harness.signal.addEventListener(
          "abort",
          () => {
            harnessCalls += 1;
          },
          makeOptions(harnessTrace, harnessReceivers),
        );
        harness.signal.dispatchEvent(new Event("abort"));
        harness.signal.dispatchEvent(new Event("abort"));

        expect(harnessTrace).toEqual(nativeTrace);
        expect(harnessReceivers).toEqual(nativeReceivers);
        expect(harnessReceivers.every(Boolean)).toBe(true);
        expect(harnessCalls).toBe(nativeCalls);
        expect(harnessCalls).toBe(Boolean(value) ? 1 : 2);
      } finally {
        harness.restore();
      }
    }
  });

  test("matches host-native removal capture conversion values", () => {
    const values: readonly unknown[] = [true, 1, "yes", {}, false];
    for (const value of values) {
      const makeOptions = (
        trace: string[],
        receivers: boolean[],
      ): EventListenerOptions => {
        const options = {} as EventListenerOptions;
        Object.defineProperty(options, "capture", {
          get(this: EventListenerOptions): unknown {
            trace.push("capture");
            receivers.push(this === options);
            return value;
          },
        });
        return options;
      };

      const native = new AbortController();
      const nativeTrace: string[] = [];
      const nativeReceivers: boolean[] = [];
      let nativeCalls = 0;
      const nativeListener = (): void => {
        nativeCalls += 1;
      };
      native.signal.addEventListener("abort", nativeListener, {
        capture: true,
      });
      native.signal.removeEventListener(
        "abort",
        nativeListener,
        makeOptions(nativeTrace, nativeReceivers),
      );
      native.signal.dispatchEvent(new Event("abort"));

      const harness = createAbortHarness("removal capture conversion");
      const harnessTrace: string[] = [];
      const harnessReceivers: boolean[] = [];
      let harnessCalls = 0;
      const harnessListener = (): void => {
        harnessCalls += 1;
      };
      try {
        harness.signal.addEventListener("abort", harnessListener, {
          capture: true,
        });
        harness.signal.removeEventListener(
          "abort",
          harnessListener,
          makeOptions(harnessTrace, harnessReceivers),
        );
        harness.signal.dispatchEvent(new Event("abort"));

        expect(harnessTrace).toEqual(nativeTrace);
        expect(harnessReceivers).toEqual(nativeReceivers);
        expect(harnessReceivers.every(Boolean)).toBe(true);
        expect(harnessCalls).toBe(nativeCalls);
        expect(harness.snapshot().activeListenerCount).toBe(nativeCalls);
      } finally {
        harness.restore();
      }
    }

    const native = new AbortController();
    let nativeCalls = 0;
    const nativeListener = (): void => {
      nativeCalls += 1;
    };
    native.signal.addEventListener("abort", nativeListener, { capture: true });
    native.signal.removeEventListener("abort", nativeListener, true);
    native.signal.dispatchEvent(new Event("abort"));

    const harness = createAbortHarness("boolean removal capture conversion");
    let harnessCalls = 0;
    const harnessListener = (): void => {
      harnessCalls += 1;
    };
    try {
      harness.signal.addEventListener("abort", harnessListener, {
        capture: true,
      });
      harness.signal.removeEventListener("abort", harnessListener, true);
      harness.signal.dispatchEvent(new Event("abort"));
      expect(harnessCalls).toBe(nativeCalls);
      expect(harness.snapshot().activeListenerCount).toBe(nativeCalls);
    } finally {
      harness.restore();
    }
  });

  test("matches native throwing option getters without provisional state", () => {
    const injected = new Error("throw from passive getter");
    const makeOptions = (trace: string[]): AddEventListenerOptions => {
      const options = {} as AddEventListenerOptions;
      for (const property of ["capture", "once"] as const) {
        Object.defineProperty(options, property, {
          get(): boolean {
            trace.push(property);
            return false;
          },
        });
      }
      Object.defineProperty(options, "passive", {
        get(): never {
          trace.push("passive");
          throw injected;
        },
      });
      Object.defineProperty(options, "signal", {
        get(): AbortSignal {
          trace.push("signal");
          return new AbortController().signal;
        },
      });
      return options;
    };

    const native = new AbortController();
    const nativeTrace: string[] = [];
    let nativeError: unknown;
    try {
      native.signal.addEventListener("abort", () => {}, makeOptions(nativeTrace));
    } catch (error) {
      nativeError = error;
    }

    const harness = createAbortHarness("throwing getter");
    const harnessTrace: string[] = [];
    let harnessError: unknown;
    try {
      try {
        harness.signal.addEventListener(
          "abort",
          () => {},
          makeOptions(harnessTrace),
        );
      } catch (error) {
        harnessError = error;
      }
      expect(harnessTrace).toEqual(nativeTrace);
      expect(harnessError).toBe(nativeError);
      expect(harness.snapshot()).toMatchObject({
        activeListenerCount: 0,
        listenerAdds: 0,
        listenerRemovals: 0,
      });
    } finally {
      harness.restore();
    }
  });

  test("delegates invalid listeners with exact host-native option semantics", () => {
    const listenerValues: readonly unknown[] = [
      null,
      undefined,
      INVALID_EVENT_LISTENER,
    ];
    const makeAddOptions = (trace: string[]): AddEventListenerOptions => {
      const owner = new AbortController();
      const options = {} as AddEventListenerOptions;
      const values = {
        capture: false,
        once: false,
        passive: false,
        signal: owner.signal,
      };
      for (const property of [
        "capture",
        "once",
        "passive",
        "signal",
      ] as const) {
        Object.defineProperty(options, property, {
          get(): unknown {
            trace.push(property);
            return values[property];
          },
        });
      }
      return options;
    };
    const makeRemoveOptions = (trace: string[]): EventListenerOptions => {
      const options = {} as EventListenerOptions;
      Object.defineProperty(options, "capture", {
        get(): boolean {
          trace.push("capture");
          return false;
        },
      });
      return options;
    };
    const invoke = (
      method: (...args: unknown[]) => unknown,
      listener: unknown,
      options: AddEventListenerOptions | EventListenerOptions,
    ): unknown => {
      try {
        Reflect.apply(method, undefined, [
          "abort",
          listener,
          options,
        ]);
        return undefined;
      } catch (error) {
        return error;
      }
    };
    const errorShape = (
      error: unknown,
    ): { readonly name: string; readonly message: string } | undefined =>
      error instanceof Error
        ? { name: error.name, message: error.message }
        : undefined;

    const originalEmitWarning = process.emitWarning;
    process.emitWarning = (() => {}) as typeof process.emitWarning;
    try {
      for (const listener of listenerValues) {
        const native = new AbortController();
        const harness = createAbortHarness("invalid listener delegation");
        try {
          const nativeAddTrace: string[] = [];
          const harnessAddTrace: string[] = [];
          const nativeAddError = invoke(
            native.signal.addEventListener.bind(native.signal) as (
              ...args: unknown[]
            ) => unknown,
            listener,
            makeAddOptions(nativeAddTrace),
          );
          const harnessAddError = invoke(
            harness.signal.addEventListener.bind(harness.signal) as (
              ...args: unknown[]
            ) => unknown,
            listener,
            makeAddOptions(harnessAddTrace),
          );
          expect(harnessAddTrace).toEqual(nativeAddTrace);
          expect(errorShape(harnessAddError)).toEqual(
            errorShape(nativeAddError),
          );
          if (listener === INVALID_EVENT_LISTENER) {
            expect(nativeAddError).toBeInstanceOf(TypeError);
          } else {
            expect(nativeAddError).toBeUndefined();
          }

          const nativeRemoveTrace: string[] = [];
          const harnessRemoveTrace: string[] = [];
          const nativeRemoveError = invoke(
            native.signal.removeEventListener.bind(native.signal) as (
              ...args: unknown[]
            ) => unknown,
            listener,
            makeRemoveOptions(nativeRemoveTrace),
          );
          const harnessRemoveError = invoke(
            harness.signal.removeEventListener.bind(harness.signal) as (
              ...args: unknown[]
            ) => unknown,
            listener,
            makeRemoveOptions(harnessRemoveTrace),
          );
          expect(harnessRemoveTrace).toEqual(nativeRemoveTrace);
          expect(errorShape(harnessRemoveError)).toEqual(
            errorShape(nativeRemoveError),
          );
          if (listener === INVALID_EVENT_LISTENER) {
            expect(nativeRemoveError).toBeInstanceOf(TypeError);
          } else {
            expect(nativeRemoveError).toBeUndefined();
          }
          expect(harness.snapshot()).toMatchObject({
            activeListenerCount: 0,
            listenerAdds: 0,
            listenerRemovals: 0,
          });
        } finally {
          harness.restore();
        }
      }
    } finally {
      process.emitWarning = originalEmitWarning;
    }
  });

  test("matches native primitive add and remove option conversion", () => {
    const primitiveOptions: ReadonlyArray<{
      readonly label: string;
      readonly value: unknown;
    }> = [
      { label: "number zero", value: 0 },
      { label: "number one", value: 1 },
      { label: "empty string", value: "" },
      { label: "non-empty string", value: "capture" },
      { label: "symbol", value: Symbol("capture") },
      { label: "bigint zero", value: 0n },
      { label: "bigint one", value: 1n },
      { label: "null", value: null },
      { label: "undefined", value: undefined },
      { label: "boolean false", value: false },
      { label: "boolean true", value: true },
    ];
    const optionProperties = [
      "capture",
      "once",
      "passive",
      "signal",
    ] as const;
    type OptionProperty = (typeof optionProperties)[number];
    interface OptionGetterTrace {
      readonly property: OptionProperty;
      readonly receiver: unknown;
      readonly receiverIsOriginalValue: boolean;
      readonly receiverType: string;
    }
    const captureCandidates = [false, true] as const;
    const prototypeGetterModes = [
      "none",
      "truthy",
      "receiver",
      "throw",
    ] as const;
    type PrototypeGetterMode = (typeof prototypeGetterModes)[number];
    const injectedCaptureGetterError = new Error(
      "injected primitive capture getter",
    );
    const errorShape = (
      error: unknown,
    ):
      | { readonly name: string; readonly message: string }
      | { readonly thrown: string }
      | undefined => {
      if (error === undefined) return undefined;
      if (error instanceof Error) {
        return { name: error.name, message: error.message };
      }
      return { thrown: String(error) };
    };
    const captureError = (action: () => void): unknown => {
      try {
        action();
        return undefined;
      } catch (error) {
        return error;
      }
    };
    const withPrimitivePrototypeGetters = <T>(
      value: unknown,
      trace: OptionGetterTrace[],
      ownerSignal: AbortSignal,
      getterMode: PrototypeGetterMode,
      action: () => T,
    ): T => {
      if (getterMode === "none" || value == null) return action();
      const prototype = Object.getPrototypeOf(Object(value)) as object;
      const originalDescriptors = new Map<
        OptionProperty,
        PropertyDescriptor | undefined
      >();
      const getterValues: Record<OptionProperty, unknown> = {
        capture: 1,
        once: true,
        passive: true,
        signal: ownerSignal,
      };
      for (const property of optionProperties) {
        originalDescriptors.set(
          property,
          Object.getOwnPropertyDescriptor(prototype, property),
        );
        Object.defineProperty(prototype, property, {
          configurable: true,
          get(this: unknown): unknown {
            const receiverIsOriginalValue = Object.is(this, value);
            trace.push({
              property,
              receiver: this,
              receiverIsOriginalValue,
              receiverType: typeof this,
            });
            if (getterMode === "throw" && property === "capture") {
              throw injectedCaptureGetterError;
            }
            if (getterMode === "receiver" && property === "capture") {
              return receiverIsOriginalValue;
            }
            return getterValues[property];
          },
        });
      }
      try {
        return action();
      } finally {
        for (let index = optionProperties.length - 1; index >= 0; index -= 1) {
          const property = optionProperties[index]!;
          const descriptor = originalDescriptors.get(property);
          if (descriptor === undefined) {
            Reflect.deleteProperty(prototype, property);
          } else {
            Object.defineProperty(prototype, property, descriptor);
          }
        }
      }
    };
    const invokeAdd = (
      signal: AbortSignal,
      listener: EventListener,
      options: unknown,
    ): void => {
      Reflect.apply(signal.addEventListener, signal, [
        "abort",
        listener,
        options,
      ]);
    };
    const invokeRemove = (
      signal: AbortSignal,
      listener: EventListener,
      options: unknown,
    ): void => {
      Reflect.apply(signal.removeEventListener, signal, [
        "abort",
        listener,
        options,
      ]);
    };

    for (const optionCase of primitiveOptions) {
      for (const removalCapture of captureCandidates) {
        const native = new AbortController();
        const nativeOwner = new AbortController();
        const nativeTrace: OptionGetterTrace[] = [];
        let nativeCalls = 0;
        const nativeListener = (): void => {
          nativeCalls += 1;
        };
        const nativeError = withPrimitivePrototypeGetters(
          optionCase.value,
          nativeTrace,
          nativeOwner.signal,
          "truthy",
          () =>
            captureError(() => {
              invokeAdd(native.signal, nativeListener, optionCase.value);
            }),
        );
        if (nativeError === undefined) {
          native.signal.removeEventListener("abort", nativeListener, {
            capture: removalCapture,
          });
        }
        native.signal.dispatchEvent(new Event("abort"));

        const harness = createAbortHarness(
          `primitive add ${optionCase.label} ${String(removalCapture)}`,
        );
        const harnessOwner = new AbortController();
        const harnessTrace: OptionGetterTrace[] = [];
        let harnessCalls = 0;
        const harnessListener = (): void => {
          harnessCalls += 1;
        };
        try {
          const harnessError = withPrimitivePrototypeGetters(
            optionCase.value,
            harnessTrace,
            harnessOwner.signal,
            "truthy",
            () =>
              captureError(() => {
                invokeAdd(harness.signal, harnessListener, optionCase.value);
              }),
          );
          if (harnessError === undefined) {
            harness.signal.removeEventListener("abort", harnessListener, {
              capture: removalCapture,
            });
          }
          harness.signal.dispatchEvent(new Event("abort"));

          expect(nativeTrace).toEqual([]);
          expect(harnessTrace).toEqual(nativeTrace);
          expect(errorShape(harnessError)).toEqual(errorShape(nativeError));
          expect(harnessCalls).toBe(nativeCalls);
          const listenerAdded = nativeError === undefined;
          const listenerRemoved = listenerAdded && nativeCalls === 0;
          expect(harness.snapshot()).toMatchObject({
            activeListenerCount: listenerAdded && !listenerRemoved ? 1 : 0,
            listenerAdds: listenerAdded ? 1 : 0,
            listenerRemovals: listenerRemoved ? 1 : 0,
          });
        } finally {
          harness.restore();
        }
      }

      const getterModes =
        optionCase.value == null
          ? (["none"] as const)
          : prototypeGetterModes;
      for (const getterMode of getterModes) {
        for (const registeredCapture of captureCandidates) {
          const native = new AbortController();
          const nativeOwner = new AbortController();
          const nativeTrace: OptionGetterTrace[] = [];
          let nativeCalls = 0;
          const nativeListener = (): void => {
            nativeCalls += 1;
          };
          native.signal.addEventListener("abort", nativeListener, {
            capture: registeredCapture,
          });
          const nativeError = withPrimitivePrototypeGetters(
            optionCase.value,
            nativeTrace,
            nativeOwner.signal,
            getterMode,
            () =>
              captureError(() => {
                invokeRemove(
                  native.signal,
                  nativeListener,
                  optionCase.value,
                );
              }),
          );
          native.signal.dispatchEvent(new Event("abort"));

          const harness = createAbortHarness(
            `primitive remove ${optionCase.label} ${String(
              registeredCapture,
            )} getters=${getterMode}`,
          );
          const harnessOwner = new AbortController();
          const harnessTrace: OptionGetterTrace[] = [];
          let harnessCalls = 0;
          const harnessListener = (): void => {
            harnessCalls += 1;
          };
          try {
            harness.signal.addEventListener("abort", harnessListener, {
              capture: registeredCapture,
            });
            const harnessError = withPrimitivePrototypeGetters(
              optionCase.value,
              harnessTrace,
              harnessOwner.signal,
              getterMode,
              () =>
                captureError(() => {
                  invokeRemove(
                    harness.signal,
                    harnessListener,
                    optionCase.value,
                  );
                }),
            );
            harness.signal.dispatchEvent(new Event("abort"));

            for (const access of nativeTrace) {
              expect(access.receiverType).toBe(typeof optionCase.value);
              expect(access.receiverIsOriginalValue).toBe(true);
              expect(Object.is(access.receiver, optionCase.value)).toBe(true);
            }
            expect(harnessTrace).toEqual(nativeTrace);
            expect(errorShape(harnessError)).toEqual(errorShape(nativeError));
            expect(harnessCalls).toBe(nativeCalls);
            const listenerRemoved =
              nativeError === undefined && nativeCalls === 0;
            expect(harness.snapshot()).toMatchObject({
              activeListenerCount: listenerRemoved ? 0 : 1,
              listenerAdds: 1,
              listenerRemovals: listenerRemoved ? 1 : 0,
            });
          } finally {
            harness.restore();
          }
        }
      }
    }
  });

  test("matches native capture coercion and throwing removal getters", () => {
    const makeCaptureOptions = (
      trace: string[],
      value: unknown,
      receivers: boolean[],
    ): EventListenerOptions => {
      const options = {} as EventListenerOptions;
      Object.defineProperty(options, "capture", {
        configurable: true,
        get(this: EventListenerOptions): unknown {
          trace.push("capture");
          receivers.push(this === options);
          return value;
        },
      });
      return options;
    };
    const injected = new Error("throw from removal capture getter");

    const native = new AbortController();
    const nativeTrace: string[] = [];
    const nativeReceivers: boolean[] = [];
    let nativeCalls = 0;
    const nativeListener = (): void => {
      nativeCalls += 1;
    };
    native.signal.addEventListener("abort", nativeListener, { capture: true });
    native.signal.removeEventListener(
      "abort",
      nativeListener,
      makeCaptureOptions(nativeTrace, 1, nativeReceivers),
    );
    native.signal.dispatchEvent(new Event("abort"));
    native.signal.addEventListener("abort", nativeListener, { capture: true });
    const nativeThrowingOptions = makeCaptureOptions(
      nativeTrace,
      false,
      nativeReceivers,
    );
    Object.defineProperty(nativeThrowingOptions, "capture", {
      get(): never {
        nativeTrace.push("capture_throw");
        throw injected;
      },
    });
    let nativeError: unknown;
    try {
      native.signal.removeEventListener(
        "abort",
        nativeListener,
        nativeThrowingOptions,
      );
    } catch (error) {
      nativeError = error;
    }
    native.signal.dispatchEvent(new Event("abort"));

    const harness = createAbortHarness("removal conversion");
    const harnessTrace: string[] = [];
    const harnessReceivers: boolean[] = [];
    let harnessCalls = 0;
    const harnessListener = (): void => {
      harnessCalls += 1;
    };
    try {
      harness.signal.addEventListener("abort", harnessListener, {
        capture: true,
      });
      harness.signal.removeEventListener(
        "abort",
        harnessListener,
        makeCaptureOptions(harnessTrace, 1, harnessReceivers),
      );
      harness.signal.dispatchEvent(new Event("abort"));
      harness.signal.addEventListener("abort", harnessListener, {
        capture: true,
      });
      const harnessThrowingOptions = makeCaptureOptions(
        harnessTrace,
        false,
        harnessReceivers,
      );
      Object.defineProperty(harnessThrowingOptions, "capture", {
        get(): never {
          harnessTrace.push("capture_throw");
          throw injected;
        },
      });
      let harnessError: unknown;
      try {
        harness.signal.removeEventListener(
          "abort",
          harnessListener,
          harnessThrowingOptions,
        );
      } catch (error) {
        harnessError = error;
      }
      harness.signal.dispatchEvent(new Event("abort"));

      expect(harnessTrace).toEqual(nativeTrace);
      expect(harnessReceivers).toEqual(nativeReceivers);
      expect(harnessReceivers.every(Boolean)).toBe(true);
      expect(harnessError).toBe(nativeError);
      expect(harnessCalls).toBe(nativeCalls);
      const snapshot = harness.snapshot();
      expect(snapshot.activeListenerCount).toBe(1);
      expect(snapshot.listenerAdds - snapshot.listenerRemovals).toBe(1);
    } finally {
      harness.restore();
    }
  });

  test("matches native abort-during-getter behavior without phantom accounting", () => {
    const makeOptions = (
      trace: string[],
      owner: AbortController,
    ): AddEventListenerOptions => {
      const options = {} as AddEventListenerOptions;
      Object.defineProperty(options, "capture", {
        get(): boolean {
          trace.push("capture");
          return false;
        },
      });
      Object.defineProperty(options, "once", {
        get(): boolean {
          trace.push("once");
          owner.abort("aborted while converting options");
          return false;
        },
      });
      Object.defineProperty(options, "passive", {
        get(): boolean {
          trace.push("passive");
          return false;
        },
      });
      Object.defineProperty(options, "signal", {
        get(): AbortSignal {
          trace.push("signal");
          return owner.signal;
        },
      });
      return options;
    };

    const nativeTarget = new AbortController();
    const nativeOwner = new AbortController();
    const nativeTrace: string[] = [];
    let nativeCalls = 0;
    nativeTarget.signal.addEventListener(
      "abort",
      () => {
        nativeCalls += 1;
      },
      makeOptions(nativeTrace, nativeOwner),
    );
    nativeTarget.signal.dispatchEvent(new Event("abort"));

    const target = createAbortHarness("abort-during-getter target");
    const owner = createAbortHarness("abort-during-getter owner");
    const harnessTrace: string[] = [];
    let harnessCalls = 0;
    try {
      target.signal.addEventListener(
        "abort",
        () => {
          harnessCalls += 1;
        },
        makeOptions(harnessTrace, owner.controller),
      );
      target.signal.dispatchEvent(new Event("abort"));

      expect(harnessTrace).toEqual(nativeTrace);
      expect(harnessCalls).toBe(nativeCalls);
      expect(harnessCalls).toBe(0);
      expect(target.snapshot()).toMatchObject({
        activeListenerCount: 0,
        listenerAdds: 0,
        listenerRemovals: 0,
      });
      expect(owner.snapshot().activeListenerCount).toBe(0);
    } finally {
      target.restore();
      owner.restore();
    }
  });

  test("detects listener and checkpoint ceilings with small configured bounds", () => {
    const harness = createAbortHarness("bounded audit", {
      checkpointLimit: 2,
      trackedListenerLimit: 2,
    });
    const first = (): void => {};
    const second = (): void => {};
    const third = (): void => {};
    try {
      harness.checkpoint("one");
      harness.checkpoint("two");
      expectErrorCode(
        () => harness.checkpoint("three"),
        AbortHarnessError,
        "checkpoint_limit",
      );
      harness.signal.addEventListener("abort", first);
      harness.signal.addEventListener("abort", second);
      expectErrorCode(
        () => harness.signal.addEventListener("abort", third),
        AbortHarnessError,
        "listener_limit",
      );
      expectErrorCode(
        () => harness.assertNoActiveListeners(),
        AbortHarnessError,
        "listener_leak",
      );
    } finally {
      harness.restore();
      harness.restore();
    }
    expect(harness.snapshot()).toMatchObject({ restored: true });
  });

  test("treats pre-aborted owner registration as a no-op at capacity", () => {
    const makeOptions = (
      trace: string[],
      owner: AbortController,
    ): AddEventListenerOptions => {
      const options = {} as AddEventListenerOptions;
      for (const property of ["capture", "once", "passive"] as const) {
        Object.defineProperty(options, property, {
          get(): boolean {
            trace.push(property);
            return false;
          },
        });
      }
      Object.defineProperty(options, "signal", {
        get(): AbortSignal {
          trace.push("signal");
          return owner.signal;
        },
      });
      return options;
    };

    const nativeTarget = new AbortController();
    const nativeOwner = new AbortController();
    nativeOwner.abort("native pre-aborted owner");
    const nativeTrace: string[] = [];
    let nativeCalls = 0;
    nativeTarget.signal.addEventListener(
      "abort",
      () => {
        nativeCalls += 1;
      },
      makeOptions(nativeTrace, nativeOwner),
    );
    nativeTarget.signal.dispatchEvent(new Event("abort"));

    const harness = createAbortHarness("pre-aborted owner at capacity", {
      trackedListenerLimit: 1,
    });
    const retained = (): void => {};
    const owner = new AbortController();
    owner.abort("harness pre-aborted owner");
    const actualTrace: string[] = [];
    let actualCalls = 0;
    try {
      harness.signal.addEventListener("abort", retained);
      expect(() =>
        harness.signal.addEventListener(
          "abort",
          () => {
            actualCalls += 1;
          },
          makeOptions(actualTrace, owner),
        ),
      ).not.toThrow();
      harness.signal.dispatchEvent(new Event("abort"));
      expect(actualTrace).toEqual(nativeTrace);
      expect(actualCalls).toBe(nativeCalls);
      expect(harness.snapshot()).toMatchObject({
        activeListenerCount: 1,
        listenerAdds: 1,
        listenerRemovals: 0,
      });
    } finally {
      harness.signal.removeEventListener("abort", retained);
      harness.restore();
    }
  });

  test("reconciles owner cancellation before rejecting at capacity", () => {
    const nativeTarget = new AbortController();
    const nativeOwner = new AbortController();
    let nativeCallsDuringOwnerListener = 0;
    const nativeListener = (): void => {
      nativeCallsDuringOwnerListener += 1;
    };
    nativeOwner.signal.addEventListener("abort", () => {
      nativeTarget.signal.dispatchEvent(new Event("abort"));
    });
    nativeTarget.signal.addEventListener("abort", nativeListener, {
      signal: nativeOwner.signal,
    });
    nativeOwner.abort("probe cancellation order at capacity");
    nativeTarget.signal.removeEventListener("abort", nativeListener);

    if (nativeCallsDuringOwnerListener !== 0) return;

    const harness = createAbortHarness("owner cancellation at capacity", {
      trackedListenerLimit: 1,
    });
    const owner = new AbortController();
    const cancelled = (): void => {};
    let replacementCalls = 0;
    const replacement = (): void => {
      replacementCalls += 1;
    };
    let addError: unknown;
    owner.signal.addEventListener("abort", () => {
      try {
        harness.signal.addEventListener("abort", replacement);
      } catch (error) {
        addError = error;
      }
    });
    try {
      harness.signal.addEventListener("abort", cancelled, {
        signal: owner.signal,
      });
      owner.abort("free capacity before nested registration");
      harness.signal.dispatchEvent(new Event("abort"));
      expect(addError).toBeUndefined();
      expect(replacementCalls).toBe(1);
      expect(harness.snapshot()).toMatchObject({
        activeListenerCount: 1,
        listenerAdds: 2,
        listenerRemovals: 1,
      });
    } finally {
      harness.signal.removeEventListener("abort", cancelled);
      harness.signal.removeEventListener("abort", replacement);
      harness.restore();
    }
  });

  test("bounds retained owner-signal observers across listener records", () => {
    const probeTarget = new AbortController();
    const probeOwner = new AbortController();
    let probeCalls = 0;
    const probeListener = (): void => {
      probeCalls += 1;
    };
    probeTarget.signal.addEventListener("abort", probeListener);
    probeTarget.signal.addEventListener("abort", probeListener, {
      signal: probeOwner.signal,
    });
    probeOwner.abort("probe duplicate owner semantics");
    probeTarget.signal.dispatchEvent(new Event("abort"));
    const duplicateOwnerIsRetained = probeCalls === 0;
    probeTarget.signal.removeEventListener("abort", probeListener);

    const harness = createAbortHarness("bounded owner observers", {
      trackedListenerLimit: 2,
    });
    const owners = [
      new AbortController(),
      new AbortController(),
      new AbortController(),
    ] as const;
    const first = (): void => {};
    const second = (): void => {};
    try {
      harness.signal.addEventListener("abort", first, {
        signal: owners[0].signal,
      });
      harness.signal.addEventListener("abort", first, {
        signal: owners[1].signal,
      });
      if (duplicateOwnerIsRetained) {
        expectErrorCode(
          () =>
            harness.signal.addEventListener("abort", second, {
              signal: owners[2].signal,
            }),
          AbortHarnessError,
          "listener_limit",
        );
        expect(harness.snapshot().activeListenerCount).toBe(1);
      } else {
        harness.signal.addEventListener("abort", second, {
          signal: owners[2].signal,
        });
        expect(harness.snapshot().activeListenerCount).toBe(2);
      }
    } finally {
      harness.restore();
      for (const owner of owners) {
        owner.abort("owner observer cleanup");
      }
    }
  });

  test("fails closed when failed conversion retention exceeds the observer bound", () => {
    const injected = new Error("bounded type conversion failure");
    const probeTarget = new AbortController();
    const probeOwner = new AbortController();
    let probeConversionFails = true;
    let probeCalls = 0;
    const probeType = {
      toString(): string {
        if (probeConversionFails) throw injected;
        return "abort";
      },
    };
    const probeListener = (): void => {
      probeCalls += 1;
    };
    try {
      Reflect.apply(probeTarget.signal.addEventListener, probeTarget.signal, [
        probeType,
        probeListener,
        { signal: probeOwner.signal },
      ]);
    } catch {
      // The native failure establishes whether this runtime retains its owner.
    } finally {
      probeConversionFails = false;
    }
    probeTarget.signal.addEventListener("abort", probeListener);
    probeOwner.abort("probe failed-conversion retention");
    probeTarget.signal.dispatchEvent(new Event("abort"));
    const nativeRetainsFailedAssociation = probeCalls === 0;
    probeTarget.signal.removeEventListener("abort", probeListener);

    const harness = createAbortHarness("bounded failed conversion", {
      trackedListenerLimit: 1,
    });
    const retainedOwner = new AbortController();
    const rejectedOwner = new AbortController();
    let conversionFails = true;
    let calls = 0;
    const type = {
      toString(): string {
        if (conversionFails) throw injected;
        return "abort";
      },
    };
    const listener = (): void => {
      calls += 1;
    };
    let actualError: unknown;
    try {
      harness.signal.addEventListener("abort", listener, {
        signal: retainedOwner.signal,
      });
      try {
        Reflect.apply(harness.signal.addEventListener, harness.signal, [
          type,
          listener,
          { signal: rejectedOwner.signal },
        ]);
      } catch (error) {
        actualError = error;
      } finally {
        conversionFails = false;
      }

      if (nativeRetainsFailedAssociation) {
        expect(actualError).toBeInstanceOf(AbortHarnessError);
        expect(actualError).toMatchObject({ code: "listener_limit" });
      } else {
        expect(actualError).toBe(injected);
      }
      expect(getEventListeners(rejectedOwner.signal, "abort")).toHaveLength(0);
      rejectedOwner.abort("prove rejected association was discarded");
      harness.signal.dispatchEvent(new Event("abort"));
      expect(calls).toBe(1);
      expect(harness.snapshot()).toMatchObject({
        activeListenerCount: 1,
        listenerAdds: 1,
        listenerRemovals: 0,
      });
    } finally {
      harness.restore();
      retainedOwner.abort("release retained association");
      rejectedOwner.abort("release rejected association");
    }
  });

  test("does not multiply native owner associations or leak rejected ones", () => {
    const duplicateCount = 5;
    const nativeOwner = new AbortController();
    const nativeTarget = new AbortController();
    const nativeListener = (): void => {};
    nativeTarget.signal.addEventListener("abort", nativeListener);
    for (let index = 0; index < duplicateCount; index += 1) {
      nativeTarget.signal.addEventListener("abort", nativeListener, {
        signal: nativeOwner.signal,
      });
    }
    const nativeAssociationCount = getEventListeners(
      nativeOwner.signal,
      "abort",
    ).length;
    nativeTarget.signal.removeEventListener("abort", nativeListener);
    const nativeResidualCount = getEventListeners(
      nativeOwner.signal,
      "abort",
    ).length;

    const owner = new AbortController();
    const harness = createAbortHarness("owner association lifecycle", {
      trackedListenerLimit: 1,
    });
    const listener = (): void => {};
    harness.signal.addEventListener("abort", listener);
    for (let index = 0; index < duplicateCount; index += 1) {
      harness.signal.addEventListener("abort", listener, {
        signal: owner.signal,
      });
    }
    expect(getEventListeners(owner.signal, "abort").length).toBeLessThanOrEqual(
      nativeAssociationCount + 1,
    );
    harness.restore();
    expect(getEventListeners(owner.signal, "abort")).toHaveLength(
      nativeResidualCount,
    );

    const rejectedOwner = new AbortController();
    const bounded = createAbortHarness("rejected owner association", {
      trackedListenerLimit: 1,
    });
    try {
      bounded.signal.addEventListener("abort", () => {});
      expectErrorCode(
        () =>
          bounded.signal.addEventListener("abort", () => {}, {
            get signal(): AbortSignal {
              return rejectedOwner.signal;
            },
          }),
        AbortHarnessError,
        "listener_limit",
      );
      expect(getEventListeners(rejectedOwner.signal, "abort")).toHaveLength(0);
    } finally {
      bounded.restore();
      nativeOwner.abort("release native association probes");
      owner.abort("release harness association probes");
      rejectedOwner.abort("prove rejected owner retained nothing");
    }
  });

  test("remains a native signal and propagates through AbortSignal.any", () => {
    const harness = createAbortHarness("native propagation");
    const reason = Object.freeze({ kind: "combined" });
    try {
      expect(harness.signal).toBeInstanceOf(AbortSignal);
      const combined = AbortSignal.any([harness.signal]);
      harness.controller.abort(reason);
      expect(combined.aborted).toBe(true);
      expect(combined.reason).toBe(reason);
      harness.assertAborted({ reason, requestCount: 1, eventCount: 1 });
    } finally {
      harness.restore();
    }
  });
});

describe("failure plan", () => {
  test("requires exact ordered checkpoints while permitting repeated names", () => {
    const plan = createFailurePlan(
      [
        { checkpoint: "prepare" },
        { checkpoint: "write" },
        { checkpoint: "write" },
        { checkpoint: "commit" },
      ],
      { label: "durable sequence" },
    );
    plan.hit("prepare");
    plan.hit("write");
    plan.hit("write");
    plan.hit("commit");
    plan.assertComplete();
    expect(plan.snapshot()).toMatchObject({
      status: "complete",
      reached: ["prepare", "write", "write", "commit"],
      remaining: [],
    });
  });

  test("detects omitted, reordered, and post-completion checkpoints", () => {
    const omitted = createFailurePlan(
      [{ checkpoint: "one" }, { checkpoint: "two" }],
      { label: "omitted plan" },
    );
    omitted.hit("one");
    expectErrorCode(
      () => omitted.assertComplete(),
      FailurePlanError,
      "incomplete",
    );

    const reordered = createFailurePlan(
      [{ checkpoint: "one" }, { checkpoint: "two" }],
      { label: "reordered plan" },
    );
    expectErrorCode(
      () => reordered.hit("two"),
      FailurePlanError,
      "mismatch",
    );
    expectErrorCode(
      () => reordered.hit("one"),
      FailurePlanError,
      "plan_poisoned",
    );

    const complete = createFailurePlan([{ checkpoint: "only" }]);
    complete.hit("only");
    expectErrorCode(
      () => complete.hit("extra"),
      FailurePlanError,
      "unexpected_checkpoint",
    );
  });

  test("consumes a boundary before its intentional action throws", () => {
    const injected = new Error("injected boundary failure");
    const plan = createFailurePlan([
      {
        checkpoint: "after-durable-write",
        action: () => {
          throw injected;
        },
      },
    ]);
    expect(() => plan.hit("after-durable-write")).toThrow(injected);
    plan.assertComplete();
    expect(plan.snapshot().status).toBe("complete");
  });

  test("rejects reentrant or asynchronous actions and configured step overflow", () => {
    let reentrant!: ReturnType<typeof createFailurePlan>;
    reentrant = createFailurePlan([
      {
        checkpoint: "outer",
        action: () => reentrant.hit("outer"),
      },
    ]);
    expectErrorCode(
      () => reentrant.hit("outer"),
      FailurePlanError,
      "reentrant_hit",
    );
    expect(reentrant.snapshot().status).toBe("poisoned");

    const asynchronous = createFailurePlan([
      {
        checkpoint: "async",
        action: (async () => {}) as () => void,
      },
    ]);
    expectErrorCode(
      () => asynchronous.hit("async"),
      FailurePlanError,
      "action_async",
    );

    expectErrorCode(
      () =>
        createFailurePlan(
          [{ checkpoint: "one" }, { checkpoint: "two" }],
          { stepLimit: 1 },
        ),
      FailurePlanError,
      "step_limit",
    );
  });

  test("copies indexed steps once without consulting collection overrides", () => {
    let checkpointReads = 0;
    let actionReads = 0;
    const step = {} as {
      readonly checkpoint: string;
      readonly action?: () => void;
    };
    Object.defineProperty(step, "checkpoint", {
      get(): string {
        checkpointReads += 1;
        return "copied";
      },
    });
    Object.defineProperty(step, "action", {
      get(): undefined {
        actionReads += 1;
        return undefined;
      },
    });
    const steps = [step];
    Object.defineProperty(steps, Symbol.iterator, {
      get(): never {
        throw new Error("failure plan consulted iteration");
      },
    });
    Object.defineProperty(steps, "map", {
      get(): never {
        throw new Error("failure plan consulted map");
      },
    });

    const plan = createFailurePlan(steps);
    expect([checkpointReads, actionReads]).toEqual([1, 1]);
    plan.hit("copied");
    plan.assertComplete();
    expect([checkpointReads, actionReads]).toEqual([1, 1]);
  });

  test("rejects non-array, proxied, sparse, and length-mutating step collections", () => {
    expectErrorCode(
      () =>
        createFailurePlan([
          { checkpoint: 42 as unknown as string },
        ]),
      FailurePlanError,
      "checkpoint_invalid",
    );

    expectErrorCode(
      () =>
        createFailurePlan(
          { 0: { checkpoint: "forged" }, length: 1 } as unknown as readonly {
            checkpoint: string;
          }[],
        ),
      FailurePlanError,
      "steps_invalid",
    );

    const proxied = new Proxy([{ checkpoint: "proxied" }], {
      get(): never {
        throw new Error("failure plan entered collection proxy");
      },
    });
    expectErrorCode(
      () => createFailurePlan(proxied),
      FailurePlanError,
      "steps_invalid",
    );

    const sparse = new Array<{ readonly checkpoint: string }>(1);
    expectErrorCode(
      () => createFailurePlan(sparse),
      FailurePlanError,
      "steps_sparse",
    );

    const mutating = [{ checkpoint: "placeholder" }];
    Object.defineProperty(mutating, 0, {
      get(): { readonly checkpoint: string } {
        mutating.push({ checkpoint: "appended" });
        return { checkpoint: "first" };
      },
    });
    expectErrorCode(
      () => createFailurePlan(mutating),
      FailurePlanError,
      "steps_mutated",
    );
  });
});

describe("primitive interoperability", () => {
  test("detects delayed completion, ordered abort, listener cleanup, and timer cleanup", async () => {
    const clock = createDeterministicClock();
    const abort = createAbortHarness("integrated operation");
    const ready = createControlledPromise<string>("operation ready");
    const reason = Object.freeze({ kind: "planned_abort" });
    const plan = createFailurePlan(
      [
        { checkpoint: "started" },
        {
          checkpoint: "ready",
          action: () => abort.controller.abort(reason),
        },
        { checkpoint: "settled" },
      ],
      { label: "integrated failure sequence" },
    );

    try {
      const pendingSleep = clock.sleep(10, abort.signal);
      clock.schedule(() => ready.resolve("ready"), 5);

      plan.hit("started");
      expect(clock.elapse(5).callbacksRun).toBe(1);
      await expect(
        settleWithinMicrotasks(ready.promise, { maxTurns: 2 }),
      ).resolves.toMatchObject({ status: "fulfilled", value: "ready" });
      plan.hit("ready");
      await expect(
        settleWithinMicrotasks(pendingSleep, {
          label: "planned aborted sleep",
          maxTurns: 1,
        }),
      ).resolves.toMatchObject({ status: "rejected", reason, turns: 0 });
      plan.hit("settled");

      plan.assertComplete();
      clock.assertIdle();
      abort.assertNoActiveListeners();
      abort.assertAborted({ reason, requestCount: 1, eventCount: 1 });
    } finally {
      abort.restore();
    }
  });
});
