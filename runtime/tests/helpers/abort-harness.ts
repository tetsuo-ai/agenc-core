export const MAX_ABORT_HARNESS_CHECKPOINTS = 10_000;
export const MAX_ABORT_HARNESS_TRACKED_LISTENERS = 10_000;
export const MAX_ABORT_HARNESS_LABEL_UTF8_BYTES = 1_024;

const ABORT_EVENT_TYPE = "abort";
const FIRST_CHECKPOINT_SEQUENCE = 1;
const OPTION_SEMANTICS_PROBE_EVENT_TYPE =
  "agenc-abort-harness-option-semantics-probe";
const opaqueAbortListenerDepthBySignal = new WeakMap<AbortSignal, number>();

type AbortEventListener = EventListener | EventListenerObject;

export type AbortHarnessErrorCode =
  | "abort_mismatch"
  | "checkpoint_limit"
  | "checkpoint_mismatch"
  | "instrumentation_unsupported"
  | "invalid_label"
  | "invalid_limit"
  | "listener_leak"
  | "listener_limit";

export class AbortHarnessError extends Error {
  readonly code: AbortHarnessErrorCode;

  constructor(code: AbortHarnessErrorCode, message: string) {
    super(message);
    this.name = "AbortHarnessError";
    this.code = code;
  }
}

export interface AbortHarnessSnapshot {
  readonly label: string;
  readonly aborted: boolean;
  readonly reason: unknown;
  readonly abortRequestCount: number;
  readonly abortEventCount: number;
  readonly activeListenerCount: number;
  readonly listenerAdds: number;
  readonly listenerRemovals: number;
  readonly checkpointCount: number;
  readonly restored: boolean;
}

export interface AbortCheckpoint extends AbortHarnessSnapshot {
  readonly name: string;
  readonly sequence: number;
  readonly occurrence: number;
}

export interface ExpectedAbortState {
  readonly reason: unknown;
  readonly requestCount: number;
  readonly eventCount: number;
}

export interface AbortHarness {
  readonly controller: AbortController;
  readonly signal: AbortSignal;
  checkpoint(name: string): AbortCheckpoint;
  snapshot(): AbortHarnessSnapshot;
  checkpoints(): readonly AbortCheckpoint[];
  assertCheckpointSequence(names: readonly string[]): void;
  assertAborted(expected: ExpectedAbortState): void;
  assertNoActiveListeners(): void;
  restore(): void;
}

export interface AbortHarnessOptions {
  readonly checkpointLimit?: number;
  readonly trackedListenerLimit?: number;
}

interface TrackedListener {
  readonly listener: AbortEventListener;
  readonly wrapped: EventListener;
  readonly capture: boolean;
  readonly once: boolean;
  readonly externalSignal?: AbortSignal;
  externalAbortHandler?: EventListener;
  active: boolean;
}

interface NativeListenerOptionsObservation {
  readonly nativeOptions: unknown;
  capture(): boolean;
  once(): boolean;
  externalSignal(): AbortSignal | undefined;
  releaseOpaqueTracking(): void;
}

interface ProvisionalExternalObserver {
  readonly signal: AbortSignal;
  readonly handler: EventListener;
}

type PrimitiveListenerOptionType =
  | "bigint"
  | "boolean"
  | "number"
  | "string"
  | "symbol";

type PrimitiveCaptureSemantics = Readonly<
  Record<PrimitiveListenerOptionType, boolean>
>;

interface NativeListenerOptionSemantics {
  readonly addTruthyPrimitiveMeansCapture: PrimitiveCaptureSemantics;
  readonly removeCaptureCoercesTruthy: boolean;
  readonly removePrimitiveReadsCapture: PrimitiveCaptureSemantics;
  readonly removePrimitiveUsesOriginalReceiver: PrimitiveCaptureSemantics;
  readonly removeTruthyPrimitiveMeansCapture: PrimitiveCaptureSemantics;
}

interface PrimitiveRemovalCaptureObservation {
  readonly readsCapture: boolean;
  readonly usesOriginalReceiver: boolean;
}

const abortSignalAbortedGetter = (() => {
  const getter = Object.getOwnPropertyDescriptor(
    AbortSignal.prototype,
    "aborted",
  )?.get;
  if (getter === undefined) {
    throw new Error("AbortSignal.aborted intrinsic is unavailable");
  }
  return getter as (this: AbortSignal) => boolean;
})();

function probeCaptureRemoval(
  addOptions: unknown,
  removeOptions: unknown,
): boolean {
  const target = new EventTarget();
  let invoked = false;
  const listener = (): void => {
    invoked = true;
  };
  Reflect.apply(target.addEventListener, target, [
    OPTION_SEMANTICS_PROBE_EVENT_TYPE,
    listener,
    addOptions,
  ]);
  Reflect.apply(target.removeEventListener, target, [
    OPTION_SEMANTICS_PROBE_EVENT_TYPE,
    listener,
    removeOptions,
  ]);
  target.dispatchEvent(new Event(OPTION_SEMANTICS_PROBE_EVENT_TYPE));
  target.removeEventListener(OPTION_SEMANTICS_PROBE_EVENT_TYPE, listener, {
    capture: true,
  });
  target.removeEventListener(OPTION_SEMANTICS_PROBE_EVENT_TYPE, listener, {
    capture: false,
  });
  return !invoked;
}

function probeAddedCapture(addOptions: unknown): boolean {
  const target = new EventTarget();
  let invoked = false;
  const listener = (): void => {
    invoked = true;
  };
  try {
    Reflect.apply(target.addEventListener, target, [
      OPTION_SEMANTICS_PROBE_EVENT_TYPE,
      listener,
      addOptions,
    ]);
  } catch {
    return false;
  }
  target.removeEventListener(OPTION_SEMANTICS_PROBE_EVENT_TYPE, listener, {
    capture: true,
  });
  target.dispatchEvent(new Event(OPTION_SEMANTICS_PROBE_EVENT_TYPE));
  target.removeEventListener(OPTION_SEMANTICS_PROBE_EVENT_TYPE, listener, {
    capture: false,
  });
  return !invoked;
}

function probePrimitiveRemovalCapture(
  value: unknown,
): PrimitiveRemovalCaptureObservation {
  const prototype = Object.getPrototypeOf(Object(value)) as object;
  const originalDescriptor = Object.getOwnPropertyDescriptor(
    prototype,
    "capture",
  );
  let captureReads = 0;
  let usesOriginalReceiver = true;
  Object.defineProperty(prototype, "capture", {
    configurable: true,
    get(this: unknown): boolean {
      captureReads += 1;
      usesOriginalReceiver &&= Object.is(this, value);
      return true;
    },
  });
  try {
    probeCaptureRemoval({ capture: true }, value);
  } finally {
    if (originalDescriptor === undefined) {
      Reflect.deleteProperty(prototype, "capture");
    } else {
      Object.defineProperty(prototype, "capture", originalDescriptor);
    }
  }
  return Object.freeze({
    readsCapture: captureReads > 0,
    usesOriginalReceiver: captureReads > 0 && usesOriginalReceiver,
  });
}

function detectNativeListenerOptionSemantics(): NativeListenerOptionSemantics {
  const truthyCapture = { capture: 1 as unknown as boolean };
  const primitiveRemovalCapture = Object.freeze({
    bigint: probePrimitiveRemovalCapture(1n),
    boolean: probePrimitiveRemovalCapture(true),
    number: probePrimitiveRemovalCapture(1),
    string: probePrimitiveRemovalCapture("capture"),
    symbol: probePrimitiveRemovalCapture(Symbol("capture")),
  });

  // Node 26.5 and Bun 1.3 differ in removeEventListener's dictionary and
  // primitive capture conversion. Detect each primitive category instead of
  // assuming that either engine follows the other engine's interpretation.
  return Object.freeze({
    addTruthyPrimitiveMeansCapture: Object.freeze({
      bigint: probeAddedCapture(1n),
      boolean: probeAddedCapture(true),
      number: probeAddedCapture(1),
      string: probeAddedCapture("capture"),
      symbol: probeAddedCapture(Symbol("capture")),
    }),
    removeCaptureCoercesTruthy: probeCaptureRemoval(
      { capture: true },
      truthyCapture,
    ),
    removePrimitiveReadsCapture: Object.freeze({
      bigint: primitiveRemovalCapture.bigint.readsCapture,
      boolean: primitiveRemovalCapture.boolean.readsCapture,
      number: primitiveRemovalCapture.number.readsCapture,
      string: primitiveRemovalCapture.string.readsCapture,
      symbol: primitiveRemovalCapture.symbol.readsCapture,
    }),
    removePrimitiveUsesOriginalReceiver: Object.freeze({
      bigint: primitiveRemovalCapture.bigint.usesOriginalReceiver,
      boolean: primitiveRemovalCapture.boolean.usesOriginalReceiver,
      number: primitiveRemovalCapture.number.usesOriginalReceiver,
      string: primitiveRemovalCapture.string.usesOriginalReceiver,
      symbol: primitiveRemovalCapture.symbol.usesOriginalReceiver,
    }),
    removeTruthyPrimitiveMeansCapture: Object.freeze({
      bigint: probeCaptureRemoval({ capture: true }, 1n),
      boolean: probeCaptureRemoval({ capture: true }, true),
      number: probeCaptureRemoval({ capture: true }, 1),
      string: probeCaptureRemoval({ capture: true }, "capture"),
      symbol: probeCaptureRemoval(
        { capture: true },
        Symbol("capture"),
      ),
    }),
  });
}

const nativeListenerOptionSemantics = detectNativeListenerOptionSemantics();

function normalizeOptionBoolean(value: unknown, coercesTruthy: boolean): boolean {
  return coercesTruthy ? Boolean(value) : value === true;
}

function isListenerOptionsObject(value: unknown): value is object {
  return (
    (typeof value === "object" && value !== null) ||
    typeof value === "function"
  );
}

function primitiveListenerOptionType(
  value: unknown,
): PrimitiveListenerOptionType | undefined {
  const valueType = typeof value;
  switch (valueType) {
    case "bigint":
    case "boolean":
    case "number":
    case "string":
    case "symbol":
      return valueType;
    default:
      return undefined;
  }
}

function normalizePrimitiveCapture(
  value: unknown,
  semantics: PrimitiveCaptureSemantics,
): boolean {
  const valueType = primitiveListenerOptionType(value);
  return valueType === undefined
    ? false
    : Boolean(value) && semantics[valueType];
}

function normalizePrimitiveRemovalCapture(value: unknown): boolean {
  const valueType = primitiveListenerOptionType(value);
  if (valueType === undefined) return false;
  if (nativeListenerOptionSemantics.removePrimitiveReadsCapture[valueType]) {
    const boxedValue = Object(value) as object;
    const receiver = nativeListenerOptionSemantics
      .removePrimitiveUsesOriginalReceiver[valueType]
      ? value
      : boxedValue;
    return normalizeOptionBoolean(
      Reflect.get(boxedValue, "capture", receiver),
      nativeListenerOptionSemantics.removeCaptureCoercesTruthy,
    );
  }
  return normalizePrimitiveCapture(
    value,
    nativeListenerOptionSemantics.removeTruthyPrimitiveMeansCapture,
  );
}

function isTrackableAbortListener(value: unknown): value is AbortEventListener {
  return (
    typeof value === "function" ||
    (typeof value === "object" && value !== null)
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
        throw new AbortHarnessError(
          "invalid_label",
          `${label} contains an unpaired high surrogate at UTF-16 offset ${index}`,
        );
      }
      index += 1;
      continue;
    }
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new AbortHarnessError(
        "invalid_label",
        `${label} contains an unpaired low surrogate at UTF-16 offset ${index}`,
      );
    }
  }
}

function validateLabel(value: string | undefined, fallback: string): string {
  const label = value ?? fallback;
  if (label.length === 0 || label.length > MAX_ABORT_HARNESS_LABEL_UTF8_BYTES) {
    throw new AbortHarnessError(
      "invalid_label",
      `label must contain 1-${MAX_ABORT_HARNESS_LABEL_UTF8_BYTES} UTF-8 bytes`,
    );
  }
  assertWellFormedUnicode(label, "label");
  const bytes = new TextEncoder().encode(label).byteLength;
  if (bytes > MAX_ABORT_HARNESS_LABEL_UTF8_BYTES) {
    throw new AbortHarnessError(
      "invalid_label",
      `label must contain 1-${MAX_ABORT_HARNESS_LABEL_UTF8_BYTES} UTF-8 bytes`,
    );
  }
  return label;
}

function addNativeAbortListener(
  signal: AbortSignal,
  listener: EventListener,
): void {
  EventTarget.prototype.addEventListener.call(
    signal,
    ABORT_EVENT_TYPE,
    listener,
  );
}

function removeNativeAbortListener(
  signal: AbortSignal,
  listener: EventListener,
): void {
  EventTarget.prototype.removeEventListener.call(
    signal,
    ABORT_EVENT_TYPE,
    listener,
  );
}

function beginOpaqueAbortListenerTracking(signal: AbortSignal): void {
  const depth = opaqueAbortListenerDepthBySignal.get(signal) ?? 0;
  opaqueAbortListenerDepthBySignal.set(signal, depth + 1);
}

function endOpaqueAbortListenerTracking(signal: AbortSignal): void {
  const depth = opaqueAbortListenerDepthBySignal.get(signal);
  if (depth === undefined || depth <= 1) {
    opaqueAbortListenerDepthBySignal.delete(signal);
  } else {
    opaqueAbortListenerDepthBySignal.set(signal, depth - 1);
  }
}

function isNativeAbortSignal(value: unknown): value is AbortSignal {
  try {
    abortSignalAbortedGetter.call(value as AbortSignal);
    return true;
  } catch {
    return false;
  }
}

function isSignalAborted(signal: AbortSignal): boolean {
  return abortSignalAbortedGetter.call(signal) as boolean;
}

function observeNativeListenerOptions(
  options?: unknown,
  onExternalSignal?: (signal: AbortSignal) => void,
): NativeListenerOptionsObservation {
  if (!isListenerOptionsObject(options)) {
    const capture = normalizePrimitiveCapture(
      options,
      nativeListenerOptionSemantics.addTruthyPrimitiveMeansCapture,
    );
    return {
      nativeOptions: options,
      capture: () => capture,
      once: () => false,
      externalSignal: () => undefined,
      releaseOpaqueTracking: () => {},
    };
  }

  let captureValue: unknown = false;
  let onceValue: unknown = false;
  let signalValue: unknown;
  const opaqueSignals: AbortSignal[] = [];
  const nativeOptions = new Proxy(options, {
    get(target, property): unknown {
      const value = Reflect.get(target, property, target);
      if (property === "capture") captureValue = value;
      if (property === "once") onceValue = value;
      if (property === "signal") {
        signalValue = value;
        if (isNativeAbortSignal(value)) {
          beginOpaqueAbortListenerTracking(value);
          opaqueSignals.push(value);
          onExternalSignal?.(value);
        }
      }
      return value;
    },
  });
  let released = false;

  return {
    nativeOptions,
    capture: () => Boolean(captureValue),
    once: () => Boolean(onceValue),
    externalSignal: () =>
      isNativeAbortSignal(signalValue) ? signalValue : undefined,
    releaseOpaqueTracking(): void {
      if (released) return;
      released = true;
      for (let index = opaqueSignals.length - 1; index >= 0; index -= 1) {
        endOpaqueAbortListenerTracking(opaqueSignals[index]!);
      }
    },
  };
}

function listenerKey(capture: boolean): "capture" | "bubble" {
  return capture ? "capture" : "bubble";
}

function validateLimit(value: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new AbortHarnessError(
      "invalid_limit",
      `${label} must be a safe integer in [1, ${maximum}]`,
    );
  }
  return value;
}

/**
 * Instrument one native AbortController for deterministic test assertions.
 *
 * Only explicit `addEventListener("abort", ...)` registrations on this signal
 * are counted. Native engine-internal dependants, such as AbortSignal.any's
 * hidden subscription, remain intentionally opaque and must be asserted by
 * their observable propagated outcome.
 */
export function createAbortHarness(
  labelInput?: string,
  options: AbortHarnessOptions = {},
): AbortHarness {
  const label = validateLabel(labelInput, "abort harness");
  const checkpointLimit = validateLimit(
    options.checkpointLimit ?? MAX_ABORT_HARNESS_CHECKPOINTS,
    MAX_ABORT_HARNESS_CHECKPOINTS,
    "checkpointLimit",
  );
  const trackedListenerLimit = validateLimit(
    options.trackedListenerLimit ?? MAX_ABORT_HARNESS_TRACKED_LISTENERS,
    MAX_ABORT_HARNESS_TRACKED_LISTENERS,
    "trackedListenerLimit",
  );
  const controller = new AbortController();
  const signal = controller.signal;
  const originalAbort = controller.abort.bind(controller);
  const originalAdd = signal.addEventListener.bind(signal);
  const originalRemove = signal.removeEventListener.bind(signal);
  const abortOwnDescriptor = Object.getOwnPropertyDescriptor(controller, "abort");
  const addOwnDescriptor = Object.getOwnPropertyDescriptor(
    signal,
    "addEventListener",
  );
  const removeOwnDescriptor = Object.getOwnPropertyDescriptor(
    signal,
    "removeEventListener",
  );

  const listenerRecords = new Map<
    AbortEventListener,
    Map<"capture" | "bubble", TrackedListener>
  >();
  const checkpointOccurrences = new Map<string, number>();
  const checkpointLog: AbortCheckpoint[] = [];
  let abortRequestCount = 0;
  let abortEventCount = 0;
  let listenerAdds = 0;
  let listenerRemovals = 0;
  let activeListenerCount = 0;
  let restored = false;

  const onNativeAbort = (): void => {
    abortEventCount += 1;
  };
  originalAdd(ABORT_EVENT_TYPE, onNativeAbort, { once: true });

  const lookupRecord = (
    listener: AbortEventListener,
    capture: boolean,
  ): TrackedListener | undefined =>
    listenerRecords.get(listener)?.get(listenerKey(capture));

  const deleteRecordMapping = (record: TrackedListener): void => {
    const byCapture = listenerRecords.get(record.listener);
    if (byCapture === undefined) return;
    byCapture.delete(listenerKey(record.capture));
    if (byCapture.size === 0) listenerRecords.delete(record.listener);
  };

  const removeRecord = (record: TrackedListener): boolean => {
    if (!record.active) return false;
    record.active = false;
    deleteRecordMapping(record);
    originalRemove(ABORT_EVENT_TYPE, record.wrapped, {
      capture: record.capture,
    });
    if (
      record.externalSignal !== undefined &&
      record.externalAbortHandler !== undefined
    ) {
      removeNativeAbortListener(
        record.externalSignal,
        record.externalAbortHandler,
      );
    }
    activeListenerCount -= 1;
    listenerRemovals += 1;
    return true;
  };

  const trackedAdd = (
    type: string,
    listener: unknown,
    options?: unknown,
  ): void => {
    if (!isTrackableAbortListener(listener)) {
      Reflect.apply(originalAdd, undefined, [type, listener, options]);
      return;
    }
    if (opaqueAbortListenerDepthBySignal.has(signal)) {
      Reflect.apply(originalAdd, undefined, [type, listener, options]);
      return;
    }
    if (type !== ABORT_EVENT_TYPE) {
      Reflect.apply(originalAdd, undefined, [type, listener, options]);
      return;
    }

    let record: TrackedListener | undefined;
    const wrapped: EventListener = (event) => {
      const activeRecord = record;
      if (activeRecord === undefined) return;
      if (activeRecord.once) removeRecord(activeRecord);
      if (typeof activeRecord.listener === "function") {
        activeRecord.listener.call(signal, event);
      } else {
        activeRecord.listener.handleEvent(event);
      }
    };
    const provisionalExternalObservers: ProvisionalExternalObserver[] = [];
    const removeProvisionalExternalObservers = (
      retained?: ProvisionalExternalObserver,
    ): void => {
      for (const observer of provisionalExternalObservers.splice(0)) {
        if (observer === retained) {
          provisionalExternalObservers.push(observer);
        } else {
          removeNativeAbortListener(observer.signal, observer.handler);
        }
      }
    };
    const observation = observeNativeListenerOptions(options, (ownerSignal) => {
      const externalAbortHandler: EventListener = () => {
        if (!isSignalAborted(ownerSignal)) return;
        if (record?.active === true) removeRecord(record);
      };
      addNativeAbortListener(ownerSignal, externalAbortHandler);
      provisionalExternalObservers.push({
        signal: ownerSignal,
        handler: externalAbortHandler,
      });
    });
    try {
      Reflect.apply(originalAdd, undefined, [
        ABORT_EVENT_TYPE,
        wrapped,
        observation.nativeOptions,
      ]);
    } catch (error) {
      originalRemove(ABORT_EVENT_TYPE, wrapped, {
        capture: observation.capture(),
      });
      removeProvisionalExternalObservers();
      throw error;
    } finally {
      observation.releaseOpaqueTracking();
    }

    const capture = observation.capture();
    const externalSignal = observation.externalSignal();
    const retainedExternalObserver = [...provisionalExternalObservers]
      .reverse()
      .find((observer) => observer.signal === externalSignal);
    removeProvisionalExternalObservers(retainedExternalObserver);
    const removeProvisionalListener = (): void => {
      originalRemove(ABORT_EVENT_TYPE, wrapped, { capture });
    };
    if (
      lookupRecord(listener, capture) !== undefined ||
      (externalSignal !== undefined && isSignalAborted(externalSignal))
    ) {
      removeProvisionalListener();
      removeProvisionalExternalObservers();
      return;
    }
    if (activeListenerCount >= trackedListenerLimit) {
      removeProvisionalListener();
      removeProvisionalExternalObservers();
      throw new AbortHarnessError(
        "listener_limit",
        `${label} exceeds ${trackedListenerLimit} active abort listeners`,
      );
    }

    const finalizedRecord: TrackedListener = {
      listener,
      wrapped,
      capture,
      once: observation.once(),
      externalSignal,
      externalAbortHandler: retainedExternalObserver?.handler,
      active: false,
    };
    record = finalizedRecord;

    let byCapture = listenerRecords.get(listener);
    if (byCapture === undefined) {
      byCapture = new Map();
      listenerRecords.set(listener, byCapture);
    }
    byCapture.set(listenerKey(capture), finalizedRecord);
    finalizedRecord.active = true;
    activeListenerCount += 1;
    listenerAdds += 1;
  };

  const trackedRemove = (
    type: string,
    listener: unknown,
    options?: unknown,
  ): void => {
    if (!isTrackableAbortListener(listener)) {
      Reflect.apply(originalRemove, undefined, [type, listener, options]);
      return;
    }
    if (type !== ABORT_EVENT_TYPE) {
      Reflect.apply(originalRemove, undefined, [type, listener, options]);
      return;
    }
    const capture = isListenerOptionsObject(options)
      ? normalizeOptionBoolean(
          Reflect.get(options, "capture"),
          nativeListenerOptionSemantics.removeCaptureCoercesTruthy,
        )
      : normalizePrimitiveRemovalCapture(options);
    const record = lookupRecord(listener, capture);
    if (record !== undefined) removeRecord(record);
  };

  try {
    Object.defineProperty(controller, "abort", {
      configurable: true,
      value(reason?: unknown): void {
        abortRequestCount += 1;
        originalAbort(reason);
      },
      writable: true,
    });
    Object.defineProperty(signal, "addEventListener", {
      configurable: true,
      value: trackedAdd,
      writable: true,
    });
    Object.defineProperty(signal, "removeEventListener", {
      configurable: true,
      value: trackedRemove,
      writable: true,
    });
  } catch (error) {
    originalRemove(ABORT_EVENT_TYPE, onNativeAbort);
    throw new AbortHarnessError(
      "instrumentation_unsupported",
      `${label} cannot instrument native AbortController methods: ${String(error)}`,
    );
  }

  const snapshot = (): AbortHarnessSnapshot =>
    Object.freeze({
      label,
      aborted: signal.aborted,
      reason: signal.reason,
      abortRequestCount,
      abortEventCount,
      activeListenerCount,
      listenerAdds,
      listenerRemovals,
      checkpointCount: checkpointLog.length,
      restored,
    });

  const restoreDescriptor = (
    target: object,
    property: string,
    descriptor: PropertyDescriptor | undefined,
  ): void => {
    if (descriptor === undefined) {
      Reflect.deleteProperty(target, property);
    } else {
      Object.defineProperty(target, property, descriptor);
    }
  };

  const harness: AbortHarness = {
    controller,
    signal,
    checkpoint(nameInput: string): AbortCheckpoint {
      const name = validateLabel(nameInput, "checkpoint");
      if (checkpointLog.length >= checkpointLimit) {
        throw new AbortHarnessError(
          "checkpoint_limit",
          `${label} exceeds ${checkpointLimit} checkpoints`,
        );
      }
      const occurrence = (checkpointOccurrences.get(name) ?? 0) + 1;
      checkpointOccurrences.set(name, occurrence);
      const entry = Object.freeze({
        ...snapshot(),
        name,
        sequence: FIRST_CHECKPOINT_SEQUENCE + checkpointLog.length,
        occurrence,
      });
      checkpointLog.push(entry);
      return entry;
    },
    snapshot,
    checkpoints: () => Object.freeze([...checkpointLog]),
    assertCheckpointSequence(names: readonly string[]): void {
      if (
        names.length === checkpointLog.length &&
        names.every((name, index) => name === checkpointLog[index]!.name)
      ) {
        return;
      }
      throw new AbortHarnessError(
        "checkpoint_mismatch",
        `${label} checkpoints were ${JSON.stringify(
          checkpointLog.map((entry) => entry.name),
        )}, expected ${JSON.stringify(names)}`,
      );
    },
    assertAborted(expected: ExpectedAbortState): void {
      if (
        signal.aborted &&
        Object.is(signal.reason, expected.reason) &&
        abortRequestCount === expected.requestCount &&
        abortEventCount === expected.eventCount
      ) {
        return;
      }
      throw new AbortHarnessError(
        "abort_mismatch",
        `${label} abort state did not match requests=${expected.requestCount}, events=${expected.eventCount}`,
      );
    },
    assertNoActiveListeners(): void {
      if (activeListenerCount === 0) return;
      throw new AbortHarnessError(
        "listener_leak",
        `${label} retains ${activeListenerCount} active abort listener(s)`,
      );
    },
    restore(): void {
      if (restored) return;
      for (const byCapture of [...listenerRecords.values()]) {
        for (const record of [...byCapture.values()]) removeRecord(record);
      }
      originalRemove(ABORT_EVENT_TYPE, onNativeAbort);
      restoreDescriptor(controller, "abort", abortOwnDescriptor);
      restoreDescriptor(signal, "addEventListener", addOwnDescriptor);
      restoreDescriptor(signal, "removeEventListener", removeOwnDescriptor);
      restored = true;
    },
  };

  return Object.freeze(harness);
}
