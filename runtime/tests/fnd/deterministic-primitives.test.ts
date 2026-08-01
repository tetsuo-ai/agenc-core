import { describe, expect, test } from "bun:test";

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

  test("rejects thenable controlled values without consuming the gate", () => {
    const controlled = createControlledPromise<unknown>("thenable gate");
    expectErrorCode(
      () => controlled.resolve(Promise.resolve("value")),
      ControlledAsyncError,
      "thenable_value",
    );
    controlled.assertPending();
    controlled.resolve("safe value");
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
