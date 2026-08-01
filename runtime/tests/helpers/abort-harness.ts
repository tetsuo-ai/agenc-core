export const MAX_ABORT_HARNESS_CHECKPOINTS = 10_000;
export const MAX_ABORT_HARNESS_TRACKED_LISTENERS = 10_000;
export const MAX_ABORT_HARNESS_LABEL_UTF8_BYTES = 1_024;

const ABORT_EVENT_TYPE = "abort";
const FIRST_CHECKPOINT_SEQUENCE = 1;
const OPTION_SEMANTICS_PROBE_EVENT_TYPE =
  "agenc-abort-harness-option-semantics-probe";
const NativeAbortController = AbortController;
const NativeEventTarget = EventTarget;
const NativeMap = Map;
const NativeProxy = Proxy;
const NativeTextEncoder = TextEncoder;
const NativeWeakMap = WeakMap;
const nativeAbortControllerAbort = NativeAbortController.prototype.abort;
const nativeEventTargetAdd = EventTarget.prototype.addEventListener;
const nativeEventTargetRemove = EventTarget.prototype.removeEventListener;
const nativeJsonStringify = JSON.stringify;
const nativeMapDelete = NativeMap.prototype.delete;
const nativeMapForEach = NativeMap.prototype.forEach;
const nativeMapGet = NativeMap.prototype.get;
const nativeMapSet = NativeMap.prototype.set;
const nativeNumberIsSafeInteger = Number.isSafeInteger;
const nativeObject = Object;
const nativeObjectDefineProperty = Object.defineProperty;
const nativeObjectFreeze = Object.freeze;
const nativeObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const nativeObjectGetPrototypeOf = Object.getPrototypeOf;
const nativeObjectIs = Object.is;
const nativeReflectApply = Reflect.apply;
const nativeReflectDeleteProperty = Reflect.deleteProperty;
const nativeReflectGet = Reflect.get;
const nativeString = String;
const nativeSymbolToPrimitive = Symbol.toPrimitive;
const nativeTextEncoderEncode = NativeTextEncoder.prototype.encode;
const nativeWeakMapDelete = NativeWeakMap.prototype.delete;
const nativeWeakMapGet = NativeWeakMap.prototype.get;
const nativeWeakMapHas = NativeWeakMap.prototype.has;
const nativeWeakMapSet = NativeWeakMap.prototype.set;
const opaqueAbortListenerDepthBySignal = new NativeWeakMap<
  AbortSignal,
  number
>();

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
  passive(): boolean;
  externalSignal(): AbortSignal | undefined;
  releaseOpaqueTracking(): void;
}

interface NativeEventTypeObservation {
  readonly nativeType: unknown;
  normalizedType(): string | undefined;
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

function appendArrayValue<T>(target: T[], value: T): void {
  nativeObjectDefineProperty(target, nativeString(target.length), {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

function copyArray<T>(target: readonly T[]): T[] {
  const copy: T[] = [];
  for (let index = 0; index < target.length; index += 1) {
    appendArrayValue(copy, target[index]!);
  }
  return copy;
}

function drainArray<T>(target: T[]): T[] {
  const drained = copyArray(target);
  target.length = 0;
  return drained;
}

function deleteMapValue<K, V>(target: Map<K, V>, key: K): boolean {
  return nativeReflectApply(nativeMapDelete, target, [key]) as boolean;
}

function forEachMapValue<K, V>(
  target: Map<K, V>,
  callback: (value: V) => void,
): void {
  nativeReflectApply(nativeMapForEach, target, [callback]);
}

function getMapValue<K, V>(target: Map<K, V>, key: K): V | undefined {
  return nativeReflectApply(nativeMapGet, target, [key]) as V | undefined;
}

function setMapValue<K, V>(target: Map<K, V>, key: K, value: V): void {
  nativeReflectApply(nativeMapSet, target, [key, value]);
}

function deleteWeakMapValue<K extends object, V>(
  target: WeakMap<K, V>,
  key: K,
): boolean {
  return nativeReflectApply(nativeWeakMapDelete, target, [key]) as boolean;
}

function getWeakMapValue<K extends object, V>(
  target: WeakMap<K, V>,
  key: K,
): V | undefined {
  return nativeReflectApply(nativeWeakMapGet, target, [key]) as V | undefined;
}

function hasWeakMapValue<K extends object, V>(
  target: WeakMap<K, V>,
  key: K,
): boolean {
  return nativeReflectApply(nativeWeakMapHas, target, [key]) as boolean;
}

function setWeakMapValue<K extends object, V>(
  target: WeakMap<K, V>,
  key: K,
  value: V,
): void {
  nativeReflectApply(nativeWeakMapSet, target, [key, value]);
}

const abortSignalAbortedGetter = (() => {
  const getter = nativeObjectGetOwnPropertyDescriptor(
    AbortSignal.prototype,
    "aborted",
  )?.get;
  if (getter === undefined) {
    throw new Error("AbortSignal.aborted intrinsic is unavailable");
  }
  return getter as (this: AbortSignal) => boolean;
})();

const abortSignalReasonGetter = (() => {
  const getter = nativeObjectGetOwnPropertyDescriptor(
    AbortSignal.prototype,
    "reason",
  )?.get;
  if (getter === undefined) {
    throw new Error("AbortSignal.reason intrinsic is unavailable");
  }
  return getter as (this: AbortSignal) => unknown;
})();

function probeCaptureRemoval(
  addOptions: unknown,
  removeOptions: unknown,
): boolean {
  const target = new NativeEventTarget();
  let invoked = false;
  const listener = (): void => {
    invoked = true;
  };
  nativeReflectApply(nativeEventTargetAdd, target, [
    OPTION_SEMANTICS_PROBE_EVENT_TYPE,
    listener,
    addOptions,
  ]);
  nativeReflectApply(nativeEventTargetRemove, target, [
    OPTION_SEMANTICS_PROBE_EVENT_TYPE,
    listener,
    removeOptions,
  ]);
  target.dispatchEvent(new Event(OPTION_SEMANTICS_PROBE_EVENT_TYPE));
  nativeReflectApply(nativeEventTargetRemove, target, [
    OPTION_SEMANTICS_PROBE_EVENT_TYPE,
    listener,
    { capture: true },
  ]);
  nativeReflectApply(nativeEventTargetRemove, target, [
    OPTION_SEMANTICS_PROBE_EVENT_TYPE,
    listener,
    { capture: false },
  ]);
  return !invoked;
}

function probeAddedCapture(addOptions: unknown): boolean {
  const target = new NativeEventTarget();
  let invoked = false;
  const listener = (): void => {
    invoked = true;
  };
  try {
    nativeReflectApply(nativeEventTargetAdd, target, [
      OPTION_SEMANTICS_PROBE_EVENT_TYPE,
      listener,
      addOptions,
    ]);
  } catch {
    return false;
  }
  nativeReflectApply(nativeEventTargetRemove, target, [
    OPTION_SEMANTICS_PROBE_EVENT_TYPE,
    listener,
    { capture: true },
  ]);
  target.dispatchEvent(new Event(OPTION_SEMANTICS_PROBE_EVENT_TYPE));
  nativeReflectApply(nativeEventTargetRemove, target, [
    OPTION_SEMANTICS_PROBE_EVENT_TYPE,
    listener,
    { capture: false },
  ]);
  return !invoked;
}

function probePrimitiveRemovalCapture(
  value: unknown,
): PrimitiveRemovalCaptureObservation {
  const prototype = nativeObjectGetPrototypeOf(nativeObject(value)) as object;
  const originalDescriptor = nativeObjectGetOwnPropertyDescriptor(
    prototype,
    "capture",
  );
  let captureReads = 0;
  let usesOriginalReceiver = true;
  nativeObjectDefineProperty(prototype, "capture", {
    configurable: true,
    get(this: unknown): boolean {
      captureReads += 1;
      usesOriginalReceiver &&= nativeObjectIs(this, value);
      return true;
    },
  });
  try {
    probeCaptureRemoval({ capture: true }, value);
  } finally {
    if (originalDescriptor === undefined) {
      nativeReflectDeleteProperty(prototype, "capture");
    } else {
      nativeObjectDefineProperty(prototype, "capture", originalDescriptor);
    }
  }
  return nativeObjectFreeze({
    readsCapture: captureReads > 0,
    usesOriginalReceiver: captureReads > 0 && usesOriginalReceiver,
  });
}

function detectNativeListenerOptionSemantics(): NativeListenerOptionSemantics {
  const truthyCapture = { capture: 1 as unknown as boolean };
  const primitiveRemovalCapture = nativeObjectFreeze({
    bigint: probePrimitiveRemovalCapture(1n),
    boolean: probePrimitiveRemovalCapture(true),
    number: probePrimitiveRemovalCapture(1),
    string: probePrimitiveRemovalCapture("capture"),
    symbol: probePrimitiveRemovalCapture(Symbol("capture")),
  });

  // Node 26.5 and Bun 1.3 differ in removeEventListener's dictionary and
  // primitive capture conversion. Detect each primitive category instead of
  // assuming that either engine follows the other engine's interpretation.
  return nativeObjectFreeze({
    addTruthyPrimitiveMeansCapture: nativeObjectFreeze({
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
    removePrimitiveReadsCapture: nativeObjectFreeze({
      bigint: primitiveRemovalCapture.bigint.readsCapture,
      boolean: primitiveRemovalCapture.boolean.readsCapture,
      number: primitiveRemovalCapture.number.readsCapture,
      string: primitiveRemovalCapture.string.readsCapture,
      symbol: primitiveRemovalCapture.symbol.readsCapture,
    }),
    removePrimitiveUsesOriginalReceiver: nativeObjectFreeze({
      bigint: primitiveRemovalCapture.bigint.usesOriginalReceiver,
      boolean: primitiveRemovalCapture.boolean.usesOriginalReceiver,
      number: primitiveRemovalCapture.number.usesOriginalReceiver,
      string: primitiveRemovalCapture.string.usesOriginalReceiver,
      symbol: primitiveRemovalCapture.symbol.usesOriginalReceiver,
    }),
    removeTruthyPrimitiveMeansCapture: nativeObjectFreeze({
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
  return coercesTruthy ? !!value : value === true;
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
    : !!value && semantics[valueType];
}

function normalizePrimitiveRemovalCapture(value: unknown): boolean {
  const valueType = primitiveListenerOptionType(value);
  if (valueType === undefined) return false;
  if (nativeListenerOptionSemantics.removePrimitiveReadsCapture[valueType]) {
    const boxedValue = nativeObject(value) as object;
    const receiver = nativeListenerOptionSemantics
      .removePrimitiveUsesOriginalReceiver[valueType]
      ? value
      : boxedValue;
    return normalizeOptionBoolean(
      nativeReflectGet(boxedValue, "capture", receiver),
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

function observeNativeEventType(type: unknown): NativeEventTypeObservation {
  if (typeof type === "string") {
    return {
      nativeType: type,
      normalizedType: () => type,
    };
  }

  let normalizedType: string | undefined;
  return {
    nativeType: {
      [nativeSymbolToPrimitive](): string {
        normalizedType = nativeString(type);
        return normalizedType;
      },
    },
    normalizedType: () => normalizedType,
  };
}

function normalizeNativeEventType(type: unknown): string {
  return nativeString(type);
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
  const bytes = nativeReflectApply(
    nativeTextEncoderEncode,
    new NativeTextEncoder(),
    [label],
  ).byteLength;
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
  nativeReflectApply(nativeEventTargetAdd, signal, [
    ABORT_EVENT_TYPE,
    listener,
  ]);
}

function removeNativeAbortListener(
  signal: AbortSignal,
  listener: EventListener,
): void {
  nativeReflectApply(nativeEventTargetRemove, signal, [
    ABORT_EVENT_TYPE,
    listener,
  ]);
}

function beginOpaqueAbortListenerTracking(signal: AbortSignal): void {
  const depth = getWeakMapValue(opaqueAbortListenerDepthBySignal, signal) ?? 0;
  setWeakMapValue(opaqueAbortListenerDepthBySignal, signal, depth + 1);
}

function endOpaqueAbortListenerTracking(signal: AbortSignal): void {
  const depth = getWeakMapValue(opaqueAbortListenerDepthBySignal, signal);
  if (depth === undefined || depth <= 1) {
    deleteWeakMapValue(opaqueAbortListenerDepthBySignal, signal);
  } else {
    setWeakMapValue(opaqueAbortListenerDepthBySignal, signal, depth - 1);
  }
}

function isNativeAbortSignal(value: unknown): value is AbortSignal {
  try {
    nativeReflectApply(abortSignalAbortedGetter, value, []);
    return true;
  } catch {
    return false;
  }
}

function isSignalAborted(signal: AbortSignal): boolean {
  return nativeReflectApply(abortSignalAbortedGetter, signal, []) as boolean;
}

function getSignalReason(signal: AbortSignal): unknown {
  return nativeReflectApply(abortSignalReasonGetter, signal, []);
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
      passive: () => false,
      externalSignal: () => undefined,
      releaseOpaqueTracking: () => {},
    };
  }

  let captureValue: unknown = false;
  let onceValue: unknown = false;
  let passiveValue: unknown = false;
  let signalValue: unknown;
  const opaqueSignals: AbortSignal[] = [];
  const nativeOptions = new NativeProxy(options, {
    get(target, property): unknown {
      const value = nativeReflectGet(target, property, target);
      if (property === "capture") captureValue = value;
      if (property === "once") onceValue = value;
      if (property === "passive") passiveValue = value;
      if (property === "signal") {
        signalValue = value;
        if (isNativeAbortSignal(value)) {
          beginOpaqueAbortListenerTracking(value);
          try {
            appendArrayValue(opaqueSignals, value);
          } catch (error) {
            endOpaqueAbortListenerTracking(value);
            throw error;
          }
          onExternalSignal?.(value);
        }
      }
      return value;
    },
  });
  let released = false;

  return {
    nativeOptions,
    capture: () => !!captureValue,
    once: () => !!onceValue,
    passive: () => !!passiveValue,
    externalSignal: () =>
      isNativeAbortSignal(signalValue) ? signalValue : undefined,
    releaseOpaqueTracking(): void {
      if (released) return;
      released = true;
      let cleanupError: unknown;
      for (let index = opaqueSignals.length - 1; index >= 0; index -= 1) {
        try {
          endOpaqueAbortListenerTracking(opaqueSignals[index]!);
        } catch (error) {
          if (cleanupError === undefined) cleanupError = error;
        }
      }
      if (cleanupError !== undefined) throw cleanupError;
    },
  };
}

function listenerKey(capture: boolean): "capture" | "bubble" {
  return capture ? "capture" : "bubble";
}

function validateLimit(value: number, maximum: number, label: string): number {
  if (!nativeNumberIsSafeInteger(value) || value < 1 || value > maximum) {
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
 * Only explicit registrations on this signal whose event type is `"abort"`
 * after host-native string conversion are counted. Native engine-internal
 * dependants, such as AbortSignal.any's hidden subscription, remain
 * intentionally opaque and must be asserted by their observable propagated
 * outcome.
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
  const controller = new NativeAbortController();
  const signal = controller.signal;
  const originalAbort = (reason?: unknown): void => {
    nativeReflectApply(nativeAbortControllerAbort, controller, [reason]);
  };
  const originalAdd = (
    type: string,
    listener: AbortEventListener | null,
    listenerOptions?: boolean | AddEventListenerOptions,
  ): void => {
    nativeReflectApply(nativeEventTargetAdd, signal, [
      type,
      listener,
      listenerOptions,
    ]);
  };
  const originalRemove = (
    type: string,
    listener: AbortEventListener | null,
    listenerOptions?: boolean | EventListenerOptions,
  ): void => {
    nativeReflectApply(nativeEventTargetRemove, signal, [
      type,
      listener,
      listenerOptions,
    ]);
  };
  const abortOwnDescriptor = nativeObjectGetOwnPropertyDescriptor(
    controller,
    "abort",
  );
  const addOwnDescriptor = nativeObjectGetOwnPropertyDescriptor(
    signal,
    "addEventListener",
  );
  const removeOwnDescriptor = nativeObjectGetOwnPropertyDescriptor(
    signal,
    "removeEventListener",
  );

  const listenerRecords = new NativeMap<
    AbortEventListener,
    Map<"capture" | "bubble", TrackedListener>
  >();
  const checkpointOccurrences = new NativeMap<string, number>();
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
  ): TrackedListener | undefined => {
    const byCapture = getMapValue(listenerRecords, listener);
    return byCapture === undefined
      ? undefined
      : getMapValue(byCapture, listenerKey(capture));
  };

  const deleteRecordMapping = (record: TrackedListener): void => {
    const byCapture = getMapValue(listenerRecords, record.listener);
    if (byCapture === undefined) return;
    deleteMapValue(byCapture, listenerKey(record.capture));
    if (
      getMapValue(byCapture, "capture") === undefined &&
      getMapValue(byCapture, "bubble") === undefined
    ) {
      deleteMapValue(listenerRecords, record.listener);
    }
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

  const replayObservedAdd = (
    type: string,
    listener: AbortEventListener,
    observation: NativeListenerOptionsObservation,
  ): void => {
    const externalSignal = observation.externalSignal();
    if (externalSignal !== undefined) {
      beginOpaqueAbortListenerTracking(externalSignal);
    }
    try {
      nativeReflectApply(originalAdd, undefined, [
        type,
        listener,
        {
          capture: observation.capture(),
          once: observation.once(),
          passive: observation.passive(),
          signal: externalSignal,
        },
      ]);
    } finally {
      if (externalSignal !== undefined) {
        endOpaqueAbortListenerTracking(externalSignal);
      }
    }
  };

  const trackedAdd = function trackedAdd(
    this: unknown,
    type: unknown,
    listener: unknown,
    options?: unknown,
  ): void {
    if (this !== signal) {
      nativeReflectApply(nativeEventTargetAdd, this, [type, listener, options]);
      return;
    }
    if (restored) {
      nativeReflectApply(nativeEventTargetAdd, signal, [
        type,
        listener,
        options,
      ]);
      return;
    }
    if (!isTrackableAbortListener(listener)) {
      nativeReflectApply(originalAdd, undefined, [type, listener, options]);
      return;
    }
    if (hasWeakMapValue(opaqueAbortListenerDepthBySignal, signal)) {
      nativeReflectApply(originalAdd, undefined, [type, listener, options]);
      return;
    }
    if (typeof type === "symbol") {
      nativeReflectApply(originalAdd, undefined, [type, listener, options]);
      return;
    }
    if (typeof type === "string" && type !== ABORT_EVENT_TYPE) {
      nativeReflectApply(originalAdd, undefined, [type, listener, options]);
      return;
    }

    const typeObservation = observeNativeEventType(type);

    let record: TrackedListener | undefined;
    const wrapped: EventListener = (event) => {
      const activeRecord = record;
      if (activeRecord === undefined) return;
      if (activeRecord.once) removeRecord(activeRecord);
      if (typeof activeRecord.listener === "function") {
        nativeReflectApply(activeRecord.listener, signal, [event]);
      } else {
        activeRecord.listener.handleEvent(event);
      }
    };
    const provisionalExternalObservers: ProvisionalExternalObserver[] = [];
    const removeProvisionalExternalObservers = (
      retained?: ProvisionalExternalObserver,
    ): void => {
      const observers = drainArray(provisionalExternalObservers);
      let cleanupError: unknown;
      for (let index = 0; index < observers.length; index += 1) {
        const observer = observers[index]!;
        if (observer === retained) {
          appendArrayValue(provisionalExternalObservers, observer);
        } else {
          try {
            removeNativeAbortListener(observer.signal, observer.handler);
          } catch (error) {
            appendArrayValue(provisionalExternalObservers, observer);
            if (cleanupError === undefined) cleanupError = error;
          }
        }
      }
      if (cleanupError !== undefined) throw cleanupError;
    };
    const observation = observeNativeListenerOptions(options, (ownerSignal) => {
      const externalAbortHandler: EventListener = () => {
        if (!isSignalAborted(ownerSignal)) return;
        if (record?.active === true) removeRecord(record);
      };
      addNativeAbortListener(ownerSignal, externalAbortHandler);
      try {
        appendArrayValue(provisionalExternalObservers, {
          signal: ownerSignal,
          handler: externalAbortHandler,
        });
      } catch (error) {
        removeNativeAbortListener(ownerSignal, externalAbortHandler);
        throw error;
      }
    });
    try {
      nativeReflectApply(originalAdd, undefined, [
        typeObservation.nativeType,
        wrapped,
        observation.nativeOptions,
      ]);
    } catch (error) {
      const normalizedType = typeObservation.normalizedType();
      if (normalizedType !== undefined) {
        try {
          originalRemove(normalizedType, wrapped, {
            capture: observation.capture(),
          });
        } catch {
          // Preserve the host-native registration error after best-effort rollback.
        }
      }
      try {
        removeProvisionalExternalObservers();
      } catch {
        // Preserve the host-native registration error after best-effort rollback.
      }
      throw error;
    } finally {
      observation.releaseOpaqueTracking();
    }

    let normalizedType: string | undefined;
    let capture = false;
    let provisionalListenerPresent = false;
    let finalizedRecord: TrackedListener | undefined;
    try {
      normalizedType = typeObservation.normalizedType();
      if (normalizedType === undefined) {
        const externalSignal = observation.externalSignal();
        removeProvisionalExternalObservers();
        if (
          restored ||
          (externalSignal !== undefined && isSignalAborted(externalSignal))
        ) {
          return;
        }
        throw new AbortHarnessError(
          "instrumentation_unsupported",
          `${label} could not observe native event-type conversion`,
        );
      }

      capture = observation.capture();
      provisionalListenerPresent = true;
      const provisionalListenerType = normalizedType;
      const removeProvisionalListener = (): void => {
        if (!provisionalListenerPresent) return;
        originalRemove(provisionalListenerType, wrapped, { capture });
        provisionalListenerPresent = false;
      };

      if (restored) {
        removeProvisionalListener();
        removeProvisionalExternalObservers();
        if (normalizedType !== ABORT_EVENT_TYPE) {
          replayObservedAdd(normalizedType, listener, observation);
        }
        return;
      }
      if (normalizedType !== ABORT_EVENT_TYPE) {
        removeProvisionalListener();
        removeProvisionalExternalObservers();
        replayObservedAdd(normalizedType, listener, observation);
        return;
      }

      const externalSignal = observation.externalSignal();
      let retainedExternalObserver: ProvisionalExternalObserver | undefined;
      for (
        let index = provisionalExternalObservers.length - 1;
        index >= 0;
        index -= 1
      ) {
        const observer = provisionalExternalObservers[index]!;
        if (observer.signal === externalSignal) {
          retainedExternalObserver = observer;
          break;
        }
      }
      removeProvisionalExternalObservers(retainedExternalObserver);
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

      finalizedRecord = {
        listener,
        wrapped,
        capture,
        once: observation.once(),
        externalSignal,
        externalAbortHandler: retainedExternalObserver?.handler,
        active: false,
      };
      record = finalizedRecord;

      let byCapture = getMapValue(listenerRecords, listener);
      if (byCapture === undefined) {
        byCapture = new NativeMap();
        setMapValue(listenerRecords, listener, byCapture);
      }
      setMapValue(byCapture, listenerKey(capture), finalizedRecord);
      finalizedRecord.active = true;
      activeListenerCount += 1;
      listenerAdds += 1;
      provisionalListenerPresent = false;
    } catch (error) {
      if (finalizedRecord?.active === true) {
        try {
          removeRecord(finalizedRecord);
        } catch {
          // Continue rolling back the remaining provisional resources.
        }
      } else if (finalizedRecord !== undefined) {
        try {
          deleteRecordMapping(finalizedRecord);
        } catch {
          // Continue rolling back the remaining provisional resources.
        }
      }
      if (provisionalListenerPresent && normalizedType !== undefined) {
        try {
          originalRemove(normalizedType, wrapped, { capture });
        } catch {
          // Continue rolling back the remaining provisional resources.
        }
      }
      try {
        removeProvisionalExternalObservers();
      } catch {
        // Preserve the original finalization error after best-effort rollback.
      }
      throw error;
    }
  };

  const trackedRemove = function trackedRemove(
    this: unknown,
    type: unknown,
    listener: unknown,
    options?: unknown,
  ): void {
    if (this !== signal) {
      nativeReflectApply(nativeEventTargetRemove, this, [
        type,
        listener,
        options,
      ]);
      return;
    }
    if (restored) {
      nativeReflectApply(nativeEventTargetRemove, signal, [
        type,
        listener,
        options,
      ]);
      return;
    }
    if (!isTrackableAbortListener(listener)) {
      nativeReflectApply(originalRemove, undefined, [type, listener, options]);
      return;
    }
    if (typeof type === "symbol") {
      nativeReflectApply(originalRemove, undefined, [type, listener, options]);
      return;
    }
    const normalizedType = normalizeNativeEventType(type);
    if (normalizedType !== ABORT_EVENT_TYPE) {
      nativeReflectApply(originalRemove, undefined, [
        normalizedType,
        listener,
        options,
      ]);
      return;
    }
    const capture = isListenerOptionsObject(options)
      ? normalizeOptionBoolean(
          nativeReflectGet(options, "capture"),
          nativeListenerOptionSemantics.removeCaptureCoercesTruthy,
        )
      : normalizePrimitiveRemovalCapture(options);
    const record = lookupRecord(listener, capture);
    if (record !== undefined) removeRecord(record);
  };

  try {
    nativeObjectDefineProperty(controller, "abort", {
      configurable: true,
      value(this: unknown, reason?: unknown): void {
        if (this !== controller) {
          nativeReflectApply(nativeAbortControllerAbort, this, [reason]);
          return;
        }
        if (restored) {
          nativeReflectApply(nativeAbortControllerAbort, controller, [reason]);
          return;
        }
        abortRequestCount += 1;
        originalAbort(reason);
      },
      writable: true,
    });
    nativeObjectDefineProperty(signal, "addEventListener", {
      configurable: true,
      value: trackedAdd,
      writable: true,
    });
    nativeObjectDefineProperty(signal, "removeEventListener", {
      configurable: true,
      value: trackedRemove,
      writable: true,
    });
  } catch (error) {
    originalRemove(ABORT_EVENT_TYPE, onNativeAbort);
    throw new AbortHarnessError(
      "instrumentation_unsupported",
      `${label} cannot instrument native AbortController methods: ${nativeString(error)}`,
    );
  }

  const snapshot = (): AbortHarnessSnapshot =>
    nativeObjectFreeze({
      label,
      aborted: isSignalAborted(signal),
      reason: getSignalReason(signal),
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
      nativeReflectDeleteProperty(target, property);
    } else {
      nativeObjectDefineProperty(target, property, descriptor);
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
      const occurrence = (getMapValue(checkpointOccurrences, name) ?? 0) + 1;
      setMapValue(checkpointOccurrences, name, occurrence);
      const entry = nativeObjectFreeze({
        ...snapshot(),
        name,
        sequence: FIRST_CHECKPOINT_SEQUENCE + checkpointLog.length,
        occurrence,
      });
      appendArrayValue(checkpointLog, entry);
      return entry;
    },
    snapshot,
    checkpoints: () => nativeObjectFreeze(copyArray(checkpointLog)),
    assertCheckpointSequence(names: readonly string[]): void {
      let matches = names.length === checkpointLog.length;
      for (let index = 0; matches && index < names.length; index += 1) {
        matches = names[index] === checkpointLog[index]!.name;
      }
      if (matches) {
        return;
      }
      const actualNames: string[] = [];
      for (let index = 0; index < checkpointLog.length; index += 1) {
        appendArrayValue(actualNames, checkpointLog[index]!.name);
      }
      throw new AbortHarnessError(
        "checkpoint_mismatch",
        `${label} checkpoints were ${nativeJsonStringify(actualNames)}, expected ${nativeJsonStringify(names)}`,
      );
    },
    assertAborted(expected: ExpectedAbortState): void {
      if (
        isSignalAborted(signal) &&
        nativeObjectIs(getSignalReason(signal), expected.reason) &&
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
      forEachMapValue(listenerRecords, (byCapture) => {
        forEachMapValue(byCapture, (record) => {
          removeRecord(record);
        });
      });
      originalRemove(ABORT_EVENT_TYPE, onNativeAbort);
      restoreDescriptor(controller, "abort", abortOwnDescriptor);
      restoreDescriptor(signal, "addEventListener", addOwnDescriptor);
      restoreDescriptor(signal, "removeEventListener", removeOwnDescriptor);
      restored = true;
    },
  };

  return nativeObjectFreeze(harness);
}
