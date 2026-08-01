export const DEFAULT_CONTROLLED_ASYNC_MAX_MICROTASK_TURNS = 1_000;
export const MAX_CONTROLLED_ASYNC_MICROTASK_TURNS = 10_000;
export const MAX_CONTROLLED_ASYNC_LABEL_UTF8_BYTES = 1_024;

const PENDING_PROMISE_SETTLEMENT = Symbol("pending promise settlement");

export type ControlledAsyncErrorCode =
  | "already_settled"
  | "invalid_label"
  | "invalid_turn_count"
  | "microtask_limit"
  | "predicate_async"
  | "reference_value"
  | "unexpected_pending"
  | "unexpected_settled";

export class ControlledAsyncError extends Error {
  readonly code: ControlledAsyncErrorCode;

  constructor(code: ControlledAsyncErrorCode, message: string) {
    super(message);
    this.name = "ControlledAsyncError";
    this.code = code;
  }
}

/**
 * Primitive fulfillment types; `void` preserves idiomatic `Promise<void>`
 * gates. Runtime values are revalidated before settlement.
 */
export type ControlledPromiseValue =
  | null
  | undefined
  | void
  | boolean
  | number
  | bigint
  | string
  | symbol;

export type ControlledPromiseState<T extends ControlledPromiseValue> =
  | { readonly status: "pending" }
  | { readonly status: "fulfilled"; readonly value: T }
  | { readonly status: "rejected"; readonly reason: unknown };

export interface ControlledPromise<T extends ControlledPromiseValue> {
  readonly promise: Promise<T>;
  state(): ControlledPromiseState<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
  assertPending(): void;
  assertSettled(): void;
}

export type PromiseSettlement<T> =
  | {
      readonly status: "fulfilled";
      readonly value: T;
      readonly turns: number;
    }
  | {
      readonly status: "rejected";
      readonly reason: unknown;
      readonly turns: number;
    };

type SharedPromiseSettlement<T> =
  | {
      readonly status: "fulfilled";
      readonly value: T;
    }
  | {
      readonly status: "rejected";
      readonly reason: unknown;
    };

interface SharedPromiseObservation<T> {
  settlement: SharedPromiseSettlement<T> | typeof PENDING_PROMISE_SETTLEMENT;
}

const sharedPromiseObservations = new WeakMap<
  Promise<unknown>,
  SharedPromiseObservation<unknown>
>();

export interface MicrotaskWaitOptions {
  readonly label?: string;
  readonly maxTurns?: number;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" && value !== null) ||
    typeof value === "function"
  ) && typeof (value as { readonly then?: unknown }).then === "function";
}

function isReferenceValue(value: unknown): boolean {
  return (
    (typeof value === "object" && value !== null) ||
    typeof value === "function"
  );
}

function assertWellFormedUnicode(value: string, label: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (
        index + 1 >= value.length ||
        next < 0xdc00 ||
        next > 0xdfff
      ) {
        throw new ControlledAsyncError(
          "invalid_label",
          `${label} contains an unpaired high surrogate at UTF-16 offset ${index}`,
        );
      }
      index += 1;
      continue;
    }
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new ControlledAsyncError(
        "invalid_label",
        `${label} contains an unpaired low surrogate at UTF-16 offset ${index}`,
      );
    }
  }
}

function validateLabel(value: string | undefined, fallback: string): string {
  const label = value ?? fallback;
  if (
    label.length === 0 ||
    label.length > MAX_CONTROLLED_ASYNC_LABEL_UTF8_BYTES
  ) {
    throw new ControlledAsyncError(
      "invalid_label",
      `label must contain 1-${MAX_CONTROLLED_ASYNC_LABEL_UTF8_BYTES} UTF-8 bytes`,
    );
  }
  assertWellFormedUnicode(label, "label");
  const byteLength = new TextEncoder().encode(label).byteLength;
  if (byteLength > MAX_CONTROLLED_ASYNC_LABEL_UTF8_BYTES) {
    throw new ControlledAsyncError(
      "invalid_label",
      `label must contain 1-${MAX_CONTROLLED_ASYNC_LABEL_UTF8_BYTES} UTF-8 bytes`,
    );
  }
  return label;
}

function validateTurnCount(value: number, allowZero: boolean): number {
  const minimum = allowZero ? 0 : 1;
  if (
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > MAX_CONTROLLED_ASYNC_MICROTASK_TURNS
  ) {
    throw new ControlledAsyncError(
      "invalid_turn_count",
      `microtask turns must be a safe integer in [${minimum}, ${MAX_CONTROLLED_ASYNC_MICROTASK_TURNS}]`,
    );
  }
  return value;
}

function resolveWaitOptions(
  options: MicrotaskWaitOptions,
  fallbackLabel: string,
): { readonly label: string; readonly maxTurns: number } {
  return {
    label: validateLabel(options.label, fallbackLabel),
    maxTurns: validateTurnCount(
      options.maxTurns ?? DEFAULT_CONTROLLED_ASYNC_MAX_MICROTASK_TURNS,
      true,
    ),
  };
}

function getSharedPromiseObservation<T>(
  promise: Promise<T>,
): SharedPromiseObservation<T> {
  const existing = sharedPromiseObservations.get(promise);
  if (existing !== undefined) {
    return existing as SharedPromiseObservation<T>;
  }

  const observation: SharedPromiseObservation<T> = {
    settlement: PENDING_PROMISE_SETTLEMENT,
  };
  sharedPromiseObservations.set(
    promise as Promise<unknown>,
    observation as SharedPromiseObservation<unknown>,
  );
  const recordSettlement = (settlement: SharedPromiseSettlement<T>): void => {
    if (observation.settlement !== PENDING_PROMISE_SETTLEMENT) return;
    observation.settlement = Object.freeze(settlement);
  };
  try {
    void promise.then(
      (value) => {
        recordSettlement({ status: "fulfilled", value });
      },
      (reason: unknown) => {
        recordSettlement({ status: "rejected", reason });
      },
    );
  } catch (error) {
    sharedPromiseObservations.delete(promise as Promise<unknown>);
    throw error;
  }
  return observation;
}

/**
 * Create a manually settled promise that rejects duplicate terminal calls.
 *
 * Fulfillment is deliberately limited to ECMAScript primitives. Native promise
 * resolution must inspect and may assimilate the `then` property of every
 * reference value. Refusing those values keeps settlement synchronous and
 * prevents hostile accessors or proxies from making recorded state disagree
 * with the promise's actual outcome.
 */
export function createControlledPromise<
  T extends ControlledPromiseValue = ControlledPromiseValue,
>(
  labelInput?: string,
): ControlledPromise<T> {
  const label = validateLabel(labelInput, "controlled promise");
  let state: ControlledPromiseState<T> = Object.freeze({ status: "pending" });
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (reason: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  const assertPendingForSettlement = (): void => {
    if (state.status === "pending") return;
    throw new ControlledAsyncError(
      "already_settled",
      `${label} is already ${state.status}`,
    );
  };

  return Object.freeze({
    promise,
    state: () => state,
    resolve(value: T): void {
      assertPendingForSettlement();
      if (isReferenceValue(value)) {
        throw new ControlledAsyncError(
          "reference_value",
          `${label} accepts only primitive resolution values because native promises inspect and assimilate reference values`,
        );
      }
      state = Object.freeze({ status: "fulfilled", value });
      resolvePromise(value);
    },
    reject(reason: unknown): void {
      assertPendingForSettlement();
      state = Object.freeze({ status: "rejected", reason });
      rejectPromise(reason);
    },
    assertPending(): void {
      if (state.status === "pending") return;
      throw new ControlledAsyncError(
        "unexpected_settled",
        `${label} unexpectedly settled as ${state.status}`,
      );
    },
    assertSettled(): void {
      if (state.status !== "pending") return;
      throw new ControlledAsyncError(
        "unexpected_pending",
        `${label} is still pending`,
      );
    },
  });
}

/** Yield exactly the requested number of ECMAScript promise-job turns. */
export async function drainMicrotasks(turns: number): Promise<void> {
  validateTurnCount(turns, true);
  for (let turn = 0; turn < turns; turn += 1) {
    await Promise.resolve();
  }
}

/**
 * Wait for a synchronous predicate using promise-job turns only.
 *
 * This intentionally never sleeps or advances host timers. Code waiting on
 * filesystem/process work must use the owning bounded process harness instead.
 */
export async function waitForMicrotaskCondition(
  predicate: () => boolean,
  options: MicrotaskWaitOptions = {},
): Promise<number> {
  if (typeof predicate !== "function") {
    throw new ControlledAsyncError(
      "predicate_async",
      "microtask condition predicate must be a function",
    );
  }
  const { label, maxTurns } = resolveWaitOptions(
    options,
    "microtask condition",
  );
  for (let turn = 0; turn <= maxTurns; turn += 1) {
    const result = predicate() as unknown;
    if (isThenable(result)) {
      void Promise.resolve(result).catch(() => {});
      throw new ControlledAsyncError(
        "predicate_async",
        `${label} predicate must be synchronous`,
      );
    }
    if (result === true) return turn;
    if (turn < maxTurns) await Promise.resolve();
  }
  throw new ControlledAsyncError(
    "microtask_limit",
    `${label} did not become true within ${maxTurns} microtask turn(s)`,
  );
}

/** Observe one promise without permitting an unbounded test wait. */
export async function settleWithinMicrotasks<T>(
  promise: Promise<T>,
  options: MicrotaskWaitOptions = {},
): Promise<PromiseSettlement<T>> {
  const { label, maxTurns } = resolveWaitOptions(
    options,
    "controlled promise settlement",
  );
  let elapsedTurns = 0;
  const observation = getSharedPromiseObservation(promise);

  for (;;) {
    await Promise.resolve();
    const settlement = observation.settlement;
    if (settlement !== PENDING_PROMISE_SETTLEMENT) {
      return Object.freeze({ ...settlement, turns: elapsedTurns });
    }
    if (elapsedTurns >= maxTurns) break;
    elapsedTurns += 1;
  }

  throw new ControlledAsyncError(
    "microtask_limit",
    `${label} did not settle within ${maxTurns} microtask turn(s)`,
  );
}
