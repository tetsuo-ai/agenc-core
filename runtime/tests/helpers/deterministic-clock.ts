export const MAX_DETERMINISTIC_CLOCK_PENDING_TIMERS = 10_000;
export const MAX_DETERMINISTIC_CLOCK_CALLBACKS_PER_ADVANCE = 100_000;

const DEFAULT_WALL_TIME_MS = 0;
const DEFAULT_MONOTONIC_TIME_MS = 0;
const FIRST_TIMER_ID = 1;

export type DeterministicClockErrorCode =
  | "async_callback"
  | "callback_limit"
  | "invalid_callback"
  | "invalid_limit"
  | "invalid_time"
  | "pending_timer_limit"
  | "reentrant_advance"
  | "time_overflow"
  | "timers_pending";

export class DeterministicClockError extends Error {
  readonly code: DeterministicClockErrorCode;

  constructor(code: DeterministicClockErrorCode, message: string) {
    super(message);
    this.name = "DeterministicClockError";
    this.code = code;
  }
}

export interface DeterministicClockOptions {
  readonly wallTimeMs?: number;
  readonly monotonicTimeMs?: number;
  readonly pendingTimerLimit?: number;
  readonly callbackLimitPerAdvance?: number;
}

export interface DeterministicTimerHandle {
  readonly id: number;
  readonly dueMonotonicMs: number;
  readonly cancelled: boolean;
  cancel(): boolean;
}

export interface ClockAdvanceReport {
  readonly wallTimeMs: number;
  readonly monotonicTimeMs: number;
  readonly callbacksRun: number;
  readonly pendingTimers: number;
}

export interface DeterministicClock {
  wallNowMs(): number;
  monotonicNowMs(): number;
  schedule(callback: () => void, delayMs: number): DeterministicTimerHandle;
  sleep(delayMs: number, signal?: AbortSignal): Promise<void>;
  runDue(): ClockAdvanceReport;
  elapse(milliseconds: number): ClockAdvanceReport;
  advanceMonotonicBy(milliseconds: number): ClockAdvanceReport;
  advanceWallBy(milliseconds: number): void;
  setWallTimeMs(value: number): void;
  pendingTimerCount(): number;
  assertIdle(): void;
}

interface TimerEntry {
  readonly id: number;
  readonly dueMonotonicMs: number;
  readonly callback: () => void;
  state: "pending" | "cancelled" | "fired";
}

function assertTime(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new DeterministicClockError(
      "invalid_time",
      `${label} must be a nonnegative safe integer`,
    );
  }
}

function assertLimit(value: number, maximum: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new DeterministicClockError(
      "invalid_limit",
      `${label} must be a safe integer in [1, ${maximum}]`,
    );
  }
}

function addTime(value: number, delta: number, label: string): number {
  const result = value + delta;
  if (!Number.isSafeInteger(result)) {
    throw new DeterministicClockError(
      "time_overflow",
      `${label} would exceed Number.MAX_SAFE_INTEGER`,
    );
  }
  return result;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" && value !== null) ||
    typeof value === "function"
  ) && typeof (value as { readonly then?: unknown }).then === "function";
}

/**
 * Construct a deterministic, instance-local test clock.
 *
 * Timers use monotonic time. Wall time can progress with monotonic time through
 * `elapse`, progress independently, or move backwards through `setWallTimeMs`.
 * The helper never patches host clocks or timer globals.
 */
export function createDeterministicClock(
  options: DeterministicClockOptions = {},
): DeterministicClock {
  let wallTimeMs = options.wallTimeMs ?? DEFAULT_WALL_TIME_MS;
  let monotonicTimeMs = options.monotonicTimeMs ?? DEFAULT_MONOTONIC_TIME_MS;
  const pendingTimerLimit =
    options.pendingTimerLimit ?? MAX_DETERMINISTIC_CLOCK_PENDING_TIMERS;
  const callbackLimit =
    options.callbackLimitPerAdvance ??
    MAX_DETERMINISTIC_CLOCK_CALLBACKS_PER_ADVANCE;

  assertTime(wallTimeMs, "wallTimeMs");
  assertTime(monotonicTimeMs, "monotonicTimeMs");
  assertLimit(
    pendingTimerLimit,
    MAX_DETERMINISTIC_CLOCK_PENDING_TIMERS,
    "pendingTimerLimit",
  );
  assertLimit(
    callbackLimit,
    MAX_DETERMINISTIC_CLOCK_CALLBACKS_PER_ADVANCE,
    "callbackLimitPerAdvance",
  );

  const heap: TimerEntry[] = [];
  const heapIndexById = new Map<number, number>();
  let nextTimerId = FIRST_TIMER_ID;
  let advancing = false;

  const compareTimers = (left: TimerEntry, right: TimerEntry): number =>
    left.dueMonotonicMs - right.dueMonotonicMs || left.id - right.id;

  const swap = (leftIndex: number, rightIndex: number): void => {
    const left = heap[leftIndex]!;
    const right = heap[rightIndex]!;
    heap[leftIndex] = right;
    heap[rightIndex] = left;
    heapIndexById.set(left.id, rightIndex);
    heapIndexById.set(right.id, leftIndex);
  };

  const bubbleUp = (startIndex: number): void => {
    let index = startIndex;
    while (index > 0) {
      const parentIndex = Math.floor((index - 1) / 2);
      if (compareTimers(heap[parentIndex]!, heap[index]!) <= 0) return;
      swap(parentIndex, index);
      index = parentIndex;
    }
  };

  const bubbleDown = (startIndex: number): void => {
    let index = startIndex;
    for (;;) {
      const leftIndex = index * 2 + 1;
      const rightIndex = leftIndex + 1;
      let smallestIndex = index;
      if (
        leftIndex < heap.length &&
        compareTimers(heap[leftIndex]!, heap[smallestIndex]!) < 0
      ) {
        smallestIndex = leftIndex;
      }
      if (
        rightIndex < heap.length &&
        compareTimers(heap[rightIndex]!, heap[smallestIndex]!) < 0
      ) {
        smallestIndex = rightIndex;
      }
      if (smallestIndex === index) return;
      swap(index, smallestIndex);
      index = smallestIndex;
    }
  };

  const removeAt = (index: number): TimerEntry => {
    const removed = heap[index]!;
    const last = heap.pop()!;
    heapIndexById.delete(removed.id);
    if (index < heap.length) {
      heap[index] = last;
      heapIndexById.set(last.id, index);
      const parentIndex = Math.floor((index - 1) / 2);
      if (
        index > 0 &&
        compareTimers(heap[index]!, heap[parentIndex]!) < 0
      ) {
        bubbleUp(index);
      } else {
        bubbleDown(index);
      }
    }
    return removed;
  };

  const cancelTimer = (id: number): boolean => {
    const index = heapIndexById.get(id);
    if (index === undefined) return false;
    removeAt(index).state = "cancelled";
    return true;
  };

  const schedule = (
    callback: () => void,
    delayMs: number,
  ): DeterministicTimerHandle => {
    if (typeof callback !== "function") {
      throw new DeterministicClockError(
        "invalid_callback",
        "timer callback must be a function",
      );
    }
    assertTime(delayMs, "delayMs");
    if (heap.length >= pendingTimerLimit) {
      throw new DeterministicClockError(
        "pending_timer_limit",
        `pending timer limit ${pendingTimerLimit} exceeded`,
      );
    }
    if (!Number.isSafeInteger(nextTimerId)) {
      throw new DeterministicClockError(
        "time_overflow",
        "deterministic timer identifier space exhausted",
      );
    }

    const id = nextTimerId;
    nextTimerId += 1;
    const dueMonotonicMs = addTime(
      monotonicTimeMs,
      delayMs,
      "timer deadline",
    );
    const entry: TimerEntry = {
      id,
      dueMonotonicMs,
      callback,
      state: "pending",
    };
    heapIndexById.set(id, heap.length);
    heap.push(entry);
    bubbleUp(heap.length - 1);

    return Object.freeze({
      id,
      dueMonotonicMs,
      get cancelled(): boolean {
        return entry.state === "cancelled";
      },
      cancel(): boolean {
        return cancelTimer(id);
      },
    });
  };

  const advanceTo = (
    targetMonotonicTimeMs: number,
    targetWallTimeMs: number,
    moveWallWithMonotonic: boolean,
  ): ClockAdvanceReport => {
    if (advancing) {
      throw new DeterministicClockError(
        "reentrant_advance",
        "deterministic clock advancement is not reentrant",
      );
    }
    advancing = true;
    let callbacksRun = 0;
    try {
      for (;;) {
        const next = heap[0];
        if (
          next === undefined ||
          next.dueMonotonicMs > targetMonotonicTimeMs
        ) {
          break;
        }
        if (callbacksRun >= callbackLimit) {
          throw new DeterministicClockError(
            "callback_limit",
            `callback limit ${callbackLimit} exceeded during one advance`,
          );
        }

        const elapsed = next.dueMonotonicMs - monotonicTimeMs;
        monotonicTimeMs = next.dueMonotonicMs;
        if (moveWallWithMonotonic) {
          wallTimeMs = addTime(wallTimeMs, elapsed, "wall time");
        }
        const fired = removeAt(0);
        fired.state = "fired";
        const callback = fired.callback as () => unknown;
        callbacksRun += 1;
        const result = callback();
        if (isThenable(result)) {
          void Promise.resolve(result).catch(() => {});
          throw new DeterministicClockError(
            "async_callback",
            "deterministic timer callbacks must be synchronous",
          );
        }
      }

      monotonicTimeMs = targetMonotonicTimeMs;
      wallTimeMs = targetWallTimeMs;
      return Object.freeze({
        wallTimeMs,
        monotonicTimeMs,
        callbacksRun,
        pendingTimers: heap.length,
      });
    } finally {
      advancing = false;
    }
  };

  const assertNotAdvancing = (): void => {
    if (advancing) {
      throw new DeterministicClockError(
        "reentrant_advance",
        "clock time cannot be changed from a timer callback",
      );
    }
  };

  const clock: DeterministicClock = {
    wallNowMs: () => wallTimeMs,
    monotonicNowMs: () => monotonicTimeMs,
    schedule,
    sleep(delayMs: number, signal?: AbortSignal): Promise<void> {
      if (signal?.aborted === true) return Promise.reject(signal.reason);
      return new Promise<void>((resolve, reject) => {
        let settled = false;
        let handle: DeterministicTimerHandle | undefined;
        const cleanup = (): void => {
          signal?.removeEventListener("abort", onAbort);
        };
        const onAbort = (): void => {
          if (settled) return;
          settled = true;
          handle?.cancel();
          cleanup();
          reject(signal?.reason);
        };
        try {
          handle = schedule(() => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve();
          }, delayMs);
          signal?.addEventListener("abort", onAbort, { once: true });
          if (signal?.aborted === true) onAbort();
        } catch (error) {
          settled = true;
          handle?.cancel();
          cleanup();
          reject(error);
        }
      });
    },
    runDue(): ClockAdvanceReport {
      return advanceTo(monotonicTimeMs, wallTimeMs, false);
    },
    elapse(milliseconds: number): ClockAdvanceReport {
      assertNotAdvancing();
      assertTime(milliseconds, "milliseconds");
      return advanceTo(
        addTime(monotonicTimeMs, milliseconds, "monotonic time"),
        addTime(wallTimeMs, milliseconds, "wall time"),
        true,
      );
    },
    advanceMonotonicBy(milliseconds: number): ClockAdvanceReport {
      assertNotAdvancing();
      assertTime(milliseconds, "milliseconds");
      return advanceTo(
        addTime(monotonicTimeMs, milliseconds, "monotonic time"),
        wallTimeMs,
        false,
      );
    },
    advanceWallBy(milliseconds: number): void {
      assertNotAdvancing();
      assertTime(milliseconds, "milliseconds");
      wallTimeMs = addTime(wallTimeMs, milliseconds, "wall time");
    },
    setWallTimeMs(value: number): void {
      assertNotAdvancing();
      assertTime(value, "wallTimeMs");
      wallTimeMs = value;
    },
    pendingTimerCount: () => heap.length,
    assertIdle(): void {
      if (heap.length === 0) return;
      throw new DeterministicClockError(
        "timers_pending",
        `${heap.length} deterministic timer(s) remain pending`,
      );
    },
  };

  return Object.freeze(clock);
}
