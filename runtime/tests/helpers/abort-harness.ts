import { addAbortListener as addNodeAbortListener } from "node:events";

export const MAX_ABORT_HARNESS_CHECKPOINTS = 10_000;
export const MAX_ABORT_HARNESS_TRACKED_LISTENERS = 10_000;
export const MAX_ABORT_HARNESS_LABEL_UTF8_BYTES = 1_024;

const ABORT_EVENT_TYPE = "abort";
const FIRST_CHECKPOINT_SEQUENCE = 1;
const OPTION_SEMANTICS_PROBE_EVENT_TYPE =
  "agenc-abort-harness-option-semantics-probe";
const NativeAbortController = AbortController;
const NativeAbortSignal = AbortSignal;
const NativeEventTarget = EventTarget;
const NativeMap = Map;
const NativeProxy = Proxy;
const NativeTextEncoder = TextEncoder;
const NativeWeakMap = WeakMap;
const nativeAbortControllerAbort = NativeAbortController.prototype.abort;
const nativeAbortSignalAny = NativeAbortSignal.any;
const nativeAddAbortListener = addNodeAbortListener;
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
const nativeSymbolIterator = Symbol.iterator;
const nativeTextEncoderEncode = NativeTextEncoder.prototype.encode;
const nativeWeakMapDelete = NativeWeakMap.prototype.delete;
const nativeWeakMapGet = NativeWeakMap.prototype.get;
const nativeWeakMapHas = NativeWeakMap.prototype.has;
const nativeWeakMapSet = NativeWeakMap.prototype.set;
const opaqueAbortListenerDepthBySignal = new NativeWeakMap<
  AbortSignal,
  number
>();
interface TrustedInstrumentedAbortSignalSurface {
  readonly addEventListener: unknown;
  readonly removeEventListener: unknown;
}

const trustedInstrumentedAbortSignals = new NativeWeakMap<
  AbortSignal,
  TrustedInstrumentedAbortSignalSurface
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
  /** Assert that the instrumented add method retains no tracked listener. */
  assertNoActiveListeners(): void;
  /** Terminal cleanup; do not reuse previously tracked listener identities. */
  restore(): void;
}

export interface AbortHarnessOptions {
  readonly checkpointLimit?: number;
  /** Bounds active listener identities and retained owner-signal observers. */
  readonly trackedListenerLimit?: number;
}

interface TrackedListener {
  readonly listener: AbortEventListener;
  readonly wrapped: EventListener;
  readonly capture: boolean;
  readonly once: boolean;
  readonly externalObservers: ExternalAbortObserver[];
  active: boolean;
}

interface NativeListenerOptionsObservation {
  readonly nativeOptions: unknown;
  capture(): boolean;
  once(): boolean;
  passive(): boolean;
  signalValue(): unknown;
  externalSignal(): AbortSignal | undefined;
  suppressExternalSignal(): void;
  releaseOpaqueTracking(): void;
}

interface ExternalAbortObserver {
  readonly signal: AbortSignal;
  readonly handler: EventListener;
  readonly fallbackSignal?: AbortSignal;
  associationIndex: number | undefined;
  /** Failed registrations must re-convert their original event type on abort. */
  conditionalOnEventTypeConversion: boolean;
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
  readonly duplicateSignalCancelsExisting: Readonly<
    Record<"capture" | "bubble", boolean>
  >;
  readonly initialSignalCancellationPrecedesOwnerListeners: Readonly<
    Record<"capture" | "bubble", boolean>
  >;
  readonly explicitRemovalRetainsSignalAssociation: Readonly<
    Record<"capture" | "bubble", boolean>
  >;
  readonly failedTypeConversionRetainsSignalAssociation: Readonly<
    Record<"capture" | "bubble", boolean>
  >;
  readonly onceRemovalRetainsSignalAssociation: Readonly<
    Record<"capture" | "bubble", boolean>
  >;
  readonly ownerCancellationRetainsOtherSignalAssociations: Readonly<
    Record<"capture" | "bubble", boolean>
  >;
  readonly syntheticSignalEventCancelsAssociation: Readonly<
    Record<"capture" | "bubble", boolean>
  >;
  readonly removeCaptureCoercesTruthy: boolean;
  readonly removePrimitiveReadsCapture: PrimitiveCaptureSemantics;
  readonly removePrimitiveUsesOriginalReceiver: PrimitiveCaptureSemantics;
  readonly removeTruthyPrimitiveMeansCapture: PrimitiveCaptureSemantics;
}

interface NativeListenerConversionSemantics {
  readonly oncePrecedesCapture: boolean;
  readonly ownerAbortDuringTypeConversionRepeatsType: boolean;
  readonly ownerAbortDuringTypeConversionRetainsListener: boolean;
  readonly typePrecedesOptions: boolean;
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
  callback: (value: V, key: K) => void,
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

function probeDuplicateSignalCancellation(capture: boolean): boolean {
  const target = new NativeEventTarget();
  const owner = new NativeAbortController();
  let invoked = false;
  const listener = (): void => {
    invoked = true;
  };
  nativeReflectApply(nativeEventTargetAdd, target, [
    OPTION_SEMANTICS_PROBE_EVENT_TYPE,
    listener,
    { capture },
  ]);
  nativeReflectApply(nativeEventTargetAdd, target, [
    OPTION_SEMANTICS_PROBE_EVENT_TYPE,
    listener,
    { capture, signal: owner.signal },
  ]);
  nativeReflectApply(nativeAbortControllerAbort, owner, []);
  target.dispatchEvent(new Event(OPTION_SEMANTICS_PROBE_EVENT_TYPE));
  nativeReflectApply(nativeEventTargetRemove, target, [
    OPTION_SEMANTICS_PROBE_EVENT_TYPE,
    listener,
    { capture },
  ]);
  return !invoked;
}

function probeInitialSignalCancellationOrder(capture: boolean): boolean {
  const target = new NativeEventTarget();
  const owner = new NativeAbortController();
  let invoked = false;
  const listener = (): void => {
    invoked = true;
  };
  const dispatchTarget = (): void => {
    target.dispatchEvent(new Event(OPTION_SEMANTICS_PROBE_EVENT_TYPE));
  };
  nativeReflectApply(nativeEventTargetAdd, owner.signal, [
    ABORT_EVENT_TYPE,
    dispatchTarget,
  ]);
  nativeReflectApply(nativeEventTargetAdd, target, [
    OPTION_SEMANTICS_PROBE_EVENT_TYPE,
    listener,
    { capture, signal: owner.signal },
  ]);
  nativeReflectApply(nativeAbortControllerAbort, owner, []);
  nativeReflectApply(nativeEventTargetRemove, owner.signal, [
    ABORT_EVENT_TYPE,
    dispatchTarget,
  ]);
  nativeReflectApply(nativeEventTargetRemove, target, [
    OPTION_SEMANTICS_PROBE_EVENT_TYPE,
    listener,
    { capture },
  ]);
  return !invoked;
}

function probeExplicitRemovalSignalRetention(capture: boolean): boolean {
  const target = new NativeEventTarget();
  const owner = new NativeAbortController();
  let invoked = false;
  const listener = (): void => {
    invoked = true;
  };
  nativeReflectApply(nativeEventTargetAdd, target, [
    OPTION_SEMANTICS_PROBE_EVENT_TYPE,
    listener,
    { capture, signal: owner.signal },
  ]);
  nativeReflectApply(nativeEventTargetRemove, target, [
    OPTION_SEMANTICS_PROBE_EVENT_TYPE,
    listener,
    { capture },
  ]);
  nativeReflectApply(nativeEventTargetAdd, target, [
    OPTION_SEMANTICS_PROBE_EVENT_TYPE,
    listener,
    { capture },
  ]);
  nativeReflectApply(nativeAbortControllerAbort, owner, []);
  target.dispatchEvent(new Event(OPTION_SEMANTICS_PROBE_EVENT_TYPE));
  nativeReflectApply(nativeEventTargetRemove, target, [
    OPTION_SEMANTICS_PROBE_EVENT_TYPE,
    listener,
    { capture },
  ]);
  return !invoked;
}

function probeFailedTypeConversionSignalRetention(capture: boolean): boolean {
  const target = new NativeEventTarget();
  const owner = new NativeAbortController();
  let conversionFails = true;
  let invoked = false;
  const type = {
    toString(): string {
      if (conversionFails) throw new Error("expected type conversion failure");
      return OPTION_SEMANTICS_PROBE_EVENT_TYPE;
    },
  };
  const listener = (): void => {
    invoked = true;
  };
  try {
    nativeReflectApply(nativeEventTargetAdd, target, [
      type,
      listener,
      { capture, signal: owner.signal },
    ]);
  } catch {
    // The expected failure is part of the probe, not its cleanup mechanism.
  } finally {
    conversionFails = false;
  }
  nativeReflectApply(nativeEventTargetAdd, target, [
    OPTION_SEMANTICS_PROBE_EVENT_TYPE,
    listener,
    { capture },
  ]);
  nativeReflectApply(nativeAbortControllerAbort, owner, []);
  target.dispatchEvent(new Event(OPTION_SEMANTICS_PROBE_EVENT_TYPE));
  nativeReflectApply(nativeEventTargetRemove, target, [
    OPTION_SEMANTICS_PROBE_EVENT_TYPE,
    listener,
    { capture },
  ]);
  return !invoked;
}

function probeOnceRemovalSignalRetention(capture: boolean): boolean {
  const target = new NativeEventTarget();
  const owner = new NativeAbortController();
  let calls = 0;
  const listener = (): void => {
    calls += 1;
  };
  nativeReflectApply(nativeEventTargetAdd, target, [
    OPTION_SEMANTICS_PROBE_EVENT_TYPE,
    listener,
    { capture, once: true, signal: owner.signal },
  ]);
  target.dispatchEvent(new Event(OPTION_SEMANTICS_PROBE_EVENT_TYPE));
  nativeReflectApply(nativeEventTargetAdd, target, [
    OPTION_SEMANTICS_PROBE_EVENT_TYPE,
    listener,
    { capture },
  ]);
  nativeReflectApply(nativeAbortControllerAbort, owner, []);
  target.dispatchEvent(new Event(OPTION_SEMANTICS_PROBE_EVENT_TYPE));
  nativeReflectApply(nativeEventTargetRemove, target, [
    OPTION_SEMANTICS_PROBE_EVENT_TYPE,
    listener,
    { capture },
  ]);
  return calls === 1;
}

function probeOtherSignalRetentionAfterCancellation(
  capture: boolean,
): boolean {
  const target = new NativeEventTarget();
  const firstOwner = new NativeAbortController();
  const secondOwner = new NativeAbortController();
  let invoked = false;
  const listener = (): void => {
    invoked = true;
  };
  nativeReflectApply(nativeEventTargetAdd, target, [
    OPTION_SEMANTICS_PROBE_EVENT_TYPE,
    listener,
    { capture, signal: firstOwner.signal },
  ]);
  nativeReflectApply(nativeEventTargetAdd, target, [
    OPTION_SEMANTICS_PROBE_EVENT_TYPE,
    listener,
    { capture, signal: secondOwner.signal },
  ]);
  nativeReflectApply(nativeAbortControllerAbort, firstOwner, []);
  nativeReflectApply(nativeEventTargetAdd, target, [
    OPTION_SEMANTICS_PROBE_EVENT_TYPE,
    listener,
    { capture },
  ]);
  nativeReflectApply(nativeAbortControllerAbort, secondOwner, []);
  target.dispatchEvent(new Event(OPTION_SEMANTICS_PROBE_EVENT_TYPE));
  nativeReflectApply(nativeEventTargetRemove, target, [
    OPTION_SEMANTICS_PROBE_EVENT_TYPE,
    listener,
    { capture },
  ]);
  return !invoked;
}

function probeSyntheticSignalEventCancellation(capture: boolean): boolean {
  const target = new NativeEventTarget();
  const owner = new NativeAbortController();
  let invoked = false;
  const listener = (): void => {
    invoked = true;
  };
  nativeReflectApply(nativeEventTargetAdd, target, [
    OPTION_SEMANTICS_PROBE_EVENT_TYPE,
    listener,
    { capture, signal: owner.signal },
  ]);
  owner.signal.dispatchEvent(new Event(ABORT_EVENT_TYPE));
  target.dispatchEvent(new Event(OPTION_SEMANTICS_PROBE_EVENT_TYPE));
  nativeReflectApply(nativeEventTargetRemove, target, [
    OPTION_SEMANTICS_PROBE_EVENT_TYPE,
    listener,
    { capture },
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
    duplicateSignalCancelsExisting: nativeObjectFreeze({
      bubble: probeDuplicateSignalCancellation(false),
      capture: probeDuplicateSignalCancellation(true),
    }),
    initialSignalCancellationPrecedesOwnerListeners: nativeObjectFreeze({
      bubble: probeInitialSignalCancellationOrder(false),
      capture: probeInitialSignalCancellationOrder(true),
    }),
    explicitRemovalRetainsSignalAssociation: nativeObjectFreeze({
      bubble: probeExplicitRemovalSignalRetention(false),
      capture: probeExplicitRemovalSignalRetention(true),
    }),
    failedTypeConversionRetainsSignalAssociation: nativeObjectFreeze({
      bubble: probeFailedTypeConversionSignalRetention(false),
      capture: probeFailedTypeConversionSignalRetention(true),
    }),
    onceRemovalRetainsSignalAssociation: nativeObjectFreeze({
      bubble: probeOnceRemovalSignalRetention(false),
      capture: probeOnceRemovalSignalRetention(true),
    }),
    ownerCancellationRetainsOtherSignalAssociations: nativeObjectFreeze({
      bubble: probeOtherSignalRetentionAfterCancellation(false),
      capture: probeOtherSignalRetentionAfterCancellation(true),
    }),
    syntheticSignalEventCancelsAssociation: nativeObjectFreeze({
      bubble: probeSyntheticSignalEventCancellation(false),
      capture: probeSyntheticSignalEventCancellation(true),
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

function probeOwnerAbortDuringTypeConversion(): {
  readonly repeatsTypeConversion: boolean;
  readonly retainsListener: boolean;
} {
  const target = new NativeEventTarget();
  const owner = new NativeAbortController();
  let conversionCount = 0;
  let invoked = false;
  const type = {
    toString(): string {
      conversionCount += 1;
      if (conversionCount === 1) {
        nativeReflectApply(nativeAbortControllerAbort, owner, []);
      }
      return OPTION_SEMANTICS_PROBE_EVENT_TYPE;
    },
  };
  const listener = (): void => {
    invoked = true;
  };
  nativeReflectApply(nativeEventTargetAdd, target, [
    type,
    listener,
    { signal: owner.signal },
  ]);
  target.dispatchEvent(new Event(OPTION_SEMANTICS_PROBE_EVENT_TYPE));
  nativeReflectApply(nativeEventTargetRemove, target, [
    OPTION_SEMANTICS_PROBE_EVENT_TYPE,
    listener,
  ]);
  return nativeObjectFreeze({
    repeatsTypeConversion: conversionCount > 1,
    retainsListener: invoked,
  });
}

function detectNativeListenerConversionSemantics(): NativeListenerConversionSemantics {
  const target = new NativeEventTarget();
  let sequence = 0;
  let captureSequence = 0;
  let onceSequence = 0;
  let typeSequence = 0;
  const type = {
    toString(): string {
      typeSequence = ++sequence;
      return OPTION_SEMANTICS_PROBE_EVENT_TYPE;
    },
  };
  const options = {
    get capture(): boolean {
      captureSequence = ++sequence;
      return false;
    },
    get once(): boolean {
      onceSequence = ++sequence;
      return false;
    },
    get passive(): boolean {
      sequence += 1;
      return false;
    },
    get signal(): undefined {
      sequence += 1;
      return undefined;
    },
  };
  nativeReflectApply(nativeEventTargetAdd, target, [type, () => {}, options]);
  const ownerAbortDuringTypeConversion =
    probeOwnerAbortDuringTypeConversion();
  return nativeObjectFreeze({
    oncePrecedesCapture: onceSequence < captureSequence,
    ownerAbortDuringTypeConversionRepeatsType:
      ownerAbortDuringTypeConversion.repeatsTypeConversion,
    ownerAbortDuringTypeConversionRetainsListener:
      ownerAbortDuringTypeConversion.retainsListener,
    typePrecedesOptions: typeSequence < captureSequence,
  });
}

const nativeListenerConversionSemantics =
  detectNativeListenerConversionSemantics();

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

function singleSignalIterable(signal: AbortSignal): Iterable<AbortSignal> {
  const iterable = {} as Iterable<AbortSignal>;
  nativeObjectDefineProperty(iterable, nativeSymbolIterator, {
    configurable: true,
    value(): Iterator<AbortSignal> {
      let yielded = false;
      return {
        next(): IteratorResult<AbortSignal> {
          if (yielded) return { done: true, value: undefined };
          yielded = true;
          return { done: false, value: signal };
        },
      };
    },
  });
  return iterable;
}

function detectResistantAbortListenerOptions():
  | AddEventListenerOptions
  | undefined {
  const owner = new NativeAbortController();
  let observed = false;
  let capturedOptions: AddEventListenerOptions | undefined;
  const stopPropagation: EventListener = (event) => {
    event.stopImmediatePropagation();
  };
  const observer: EventListener = () => {
    observed = true;
  };
  addNativeAbortListener(owner.signal, stopPropagation);
  nativeObjectDefineProperty(owner.signal, "addEventListener", {
    configurable: true,
    value(
      type: unknown,
      listener: unknown,
      options?: unknown,
    ): void {
      if (
        type === ABORT_EVENT_TYPE &&
        isListenerOptionsObject(options)
      ) {
        capturedOptions = options as AddEventListenerOptions;
      }
      nativeReflectApply(nativeEventTargetAdd, owner.signal, [
        type,
        listener,
        options,
      ]);
    },
  });
  nativeReflectApply(nativeAddAbortListener, undefined, [
    owner.signal,
    observer,
  ]);
  nativeReflectApply(nativeAbortControllerAbort, owner, []);
  removeNativeAbortListener(owner.signal, stopPropagation);
  removeNativeAbortListener(owner.signal, observer);
  return observed ? capturedOptions : undefined;
}

const resistantAbortListenerOptions =
  detectResistantAbortListenerOptions();

function createExternalAbortObserver(
  signal: AbortSignal,
  handler: EventListener,
  conditionalOnEventTypeConversion: boolean,
): ExternalAbortObserver {
  if (resistantAbortListenerOptions !== undefined) {
    nativeReflectApply(nativeEventTargetAdd, signal, [
      ABORT_EVENT_TYPE,
      handler,
      resistantAbortListenerOptions,
    ]);
    return {
      signal,
      handler,
      associationIndex: undefined,
      conditionalOnEventTypeConversion,
    };
  }

  addNativeAbortListener(signal, handler);
  try {
    const fallbackSignal = nativeReflectApply(
      nativeAbortSignalAny,
      NativeAbortSignal,
      [singleSignalIterable(signal)],
    ) as AbortSignal;
    addNativeAbortListener(fallbackSignal, handler);
    return {
      signal,
      handler,
      fallbackSignal,
      associationIndex: undefined,
      conditionalOnEventTypeConversion,
    };
  } catch (error) {
    removeNativeAbortListener(signal, handler);
    throw error;
  }
}

function removeExternalAbortObserver(observer: ExternalAbortObserver): void {
  let cleanupError: unknown;
  try {
    removeNativeAbortListener(observer.signal, observer.handler);
  } catch (error) {
    cleanupError = error;
  }
  if (observer.fallbackSignal !== undefined) {
    try {
      removeNativeAbortListener(observer.fallbackSignal, observer.handler);
    } catch (error) {
      if (cleanupError === undefined) cleanupError = error;
    }
  }
  if (cleanupError !== undefined) throw cleanupError;
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

function resolvesToNativeDataMethod(
  target: object,
  property: string,
  expected: unknown,
): boolean {
  let owner: object | null = target;
  while (owner !== null) {
    const descriptor = nativeObjectGetOwnPropertyDescriptor(owner, property);
    if (descriptor !== undefined) {
      const valueDescriptor = nativeObjectGetOwnPropertyDescriptor(
        descriptor,
        "value",
      );
      return (
        valueDescriptor !== undefined && valueDescriptor.value === expected
      );
    }
    owner = nativeObjectGetPrototypeOf(owner);
  }
  return false;
}

function resolvesToNativeAbortedGetter(signal: AbortSignal): boolean {
  let owner: object | null = signal;
  while (owner !== null) {
    const descriptor = nativeObjectGetOwnPropertyDescriptor(owner, "aborted");
    if (descriptor !== undefined) {
      const getterDescriptor = nativeObjectGetOwnPropertyDescriptor(
        descriptor,
        "get",
      );
      return (
        getterDescriptor !== undefined &&
        getterDescriptor.value === abortSignalAbortedGetter
      );
    }
    owner = nativeObjectGetPrototypeOf(owner);
  }
  return false;
}

function hasSupportedOwnerSignalSurface(signal: AbortSignal): boolean {
  const trustedSurface = getWeakMapValue(
    trustedInstrumentedAbortSignals,
    signal,
  );
  const expectedAdd = trustedSurface?.addEventListener ?? nativeEventTargetAdd;
  const expectedRemove =
    trustedSurface?.removeEventListener ?? nativeEventTargetRemove;
  return (
    resolvesToNativeDataMethod(signal, "addEventListener", expectedAdd) &&
    resolvesToNativeDataMethod(
      signal,
      "removeEventListener",
      expectedRemove,
    ) &&
    resolvesToNativeAbortedGetter(signal)
  );
}

function observeNativeListenerOptions(
  options?: unknown,
  onExternalSignal?: (signal: AbortSignal) => void,
  eager = false,
  oncePrecedesCapture = false,
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
      signalValue: () => undefined,
      externalSignal: () => undefined,
      suppressExternalSignal: () => {},
      releaseOpaqueTracking: () => {},
    };
  }

  let captureValue: unknown = false;
  let onceValue: unknown = false;
  let passiveValue: unknown = false;
  let signalValue: unknown;
  const opaqueSignals: AbortSignal[] = [];
  let externalSignalSuppressed = false;
  const retainOpaqueSignal = (value: unknown): void => {
    signalValue = value;
    if (!isNativeAbortSignal(value)) return;
    beginOpaqueAbortListenerTracking(value);
    try {
      appendArrayValue(opaqueSignals, value);
      onExternalSignal?.(value);
    } catch (error) {
      endOpaqueAbortListenerTracking(value);
      throw error;
    }
  };
  if (eager) {
    if (oncePrecedesCapture) {
      onceValue = nativeReflectGet(options, "once", options);
      captureValue = nativeReflectGet(options, "capture", options);
    } else {
      captureValue = nativeReflectGet(options, "capture", options);
      onceValue = nativeReflectGet(options, "once", options);
    }
    passiveValue = nativeReflectGet(options, "passive", options);
    retainOpaqueSignal(nativeReflectGet(options, "signal", options));
  }
  const nativeOptions = new NativeProxy(options, {
    get(target, property): unknown {
      if (eager) {
        if (property === "capture") return captureValue;
        if (property === "once") return onceValue;
        if (property === "passive") return passiveValue;
        if (property === "signal") {
          return externalSignalSuppressed ? undefined : signalValue;
        }
      }
      const value = nativeReflectGet(target, property, target);
      if (property === "capture") captureValue = value;
      if (property === "once") onceValue = value;
      if (property === "passive") passiveValue = value;
      if (property === "signal") {
        retainOpaqueSignal(value);
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
    signalValue: () => signalValue,
    externalSignal: () =>
      isNativeAbortSignal(signalValue) ? signalValue : undefined,
    suppressExternalSignal(): void {
      externalSignalSuppressed = true;
    },
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
 * Only registrations made through this signal's instrumented
 * `addEventListener` property whose event type is `"abort"` after host-native
 * string conversion are counted. Registrations that bypass the own property,
 * plus native engine-internal dependants such as AbortSignal.any's hidden
 * subscription, remain intentionally opaque and must be asserted by their
 * observable outcome. Native targets expose no listener introspection, so a
 * prototype-direct and an instrumented registration must not be mixed for the
 * same listener/capture identity before removal. A same-listener registration
 * reentered while native removal arguments are being converted may also be
 * delegated opaquely when no exact tracked capture exists, preserving native
 * deduplication with a prototype-direct registration.
 * Owner signals supplied through listener options must retain their native
 * `aborted`, `addEventListener`, and `removeEventListener` surface, or belong
 * to another active abort harness. Arbitrary surface overrides make exact
 * cancellation accounting unobservable and are rejected fail-closed.
 * Likewise, `abortRequestCount` counts calls through the controller's
 * instrumented `abort` property; prototype-direct abort calls are reflected by
 * native signal state and event count but remain opaque to the request counter.
 * `restore()` is terminal for listener identities previously registered with
 * owner signals: some hosts retain opaque owner associations to the harness's
 * stable wrapper, and those cannot be retargeted to post-restore native calls.
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
  const externalObserverStates = new NativeMap<
    AbortEventListener,
    Map<"capture" | "bubble", ExternalAbortObserver[]>
  >();
  const stableListenerWrappers = new NativeWeakMap<
    AbortEventListener,
    Map<"capture" | "bubble", EventListener>
  >();
  const removalConversionDepths = new NativeMap<AbortEventListener, number>();
  const checkpointOccurrences = new NativeMap<string, number>();
  const checkpointLog: AbortCheckpoint[] = [];
  let abortRequestCount = 0;
  let abortEventCount = 0;
  let listenerAdds = 0;
  let listenerRemovals = 0;
  let activeListenerCount = 0;
  let activeExternalObserverCount = 0;
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

  const getExternalObservers = (
    listener: AbortEventListener,
    capture: boolean,
  ): ExternalAbortObserver[] | undefined => {
    const byCapture = getMapValue(externalObserverStates, listener);
    return byCapture === undefined
      ? undefined
      : getMapValue(byCapture, listenerKey(capture));
  };

  const ensureExternalObservers = (
    listener: AbortEventListener,
    capture: boolean,
    preferred?: ExternalAbortObserver[],
  ): ExternalAbortObserver[] => {
    const existing = getExternalObservers(listener, capture);
    if (existing !== undefined) return existing;
    let byCapture = getMapValue(externalObserverStates, listener);
    if (byCapture === undefined) {
      byCapture = new NativeMap();
      setMapValue(externalObserverStates, listener, byCapture);
    }
    const observers = preferred ?? [];
    setMapValue(byCapture, listenerKey(capture), observers);
    return observers;
  };

  const deleteEmptyExternalObserverState = (
    listener: AbortEventListener,
    capture: boolean,
  ): void => {
    const byCapture = getMapValue(externalObserverStates, listener);
    if (byCapture === undefined) return;
    const observers = getMapValue(byCapture, listenerKey(capture));
    if (observers !== undefined && observers.length > 0) return;
    deleteMapValue(byCapture, listenerKey(capture));
    if (
      getMapValue(byCapture, "capture") === undefined &&
      getMapValue(byCapture, "bubble") === undefined
    ) {
      deleteMapValue(externalObserverStates, listener);
    }
  };

  const addExternalObserverAssociation = (
    listener: AbortEventListener,
    capture: boolean,
    observer: ExternalAbortObserver,
    preferred?: ExternalAbortObserver[],
  ): void => {
    const observers = ensureExternalObservers(listener, capture, preferred);
    const associationIndex = observers.length;
    appendArrayValue(observers, observer);
    observer.associationIndex = associationIndex;
    activeExternalObserverCount += 1;
  };

  const detachExternalObserverAssociation = (
    listener: AbortEventListener,
    capture: boolean,
    observer: ExternalAbortObserver,
  ): boolean => {
    const observers = getExternalObservers(listener, capture);
    const associationIndex = observer.associationIndex;
    if (
      observers === undefined ||
      associationIndex === undefined ||
      observers[associationIndex] !== observer
    ) {
      return false;
    }
    const lastIndex = observers.length - 1;
    if (associationIndex !== lastIndex) {
      const replacement = observers[lastIndex]!;
      nativeObjectDefineProperty(observers, nativeString(associationIndex), {
        configurable: true,
        enumerable: true,
        value: replacement,
        writable: true,
      });
      replacement.associationIndex = associationIndex;
    }
    observers.length = lastIndex;
    observer.associationIndex = undefined;
    activeExternalObserverCount -= 1;
    deleteEmptyExternalObserverState(listener, capture);
    removeExternalAbortObserver(observer);
    return true;
  };

  const releaseExternalObserverAssociations = (
    listener: AbortEventListener,
    capture: boolean,
  ): void => {
    const observers = getExternalObservers(listener, capture);
    if (observers === undefined) return;
    const retained = drainArray(observers);
    activeExternalObserverCount -= retained.length;
    deleteEmptyExternalObserverState(listener, capture);
    let cleanupError: unknown;
    for (let index = 0; index < retained.length; index += 1) {
      retained[index]!.associationIndex = undefined;
      try {
        removeExternalAbortObserver(retained[index]!);
      } catch (error) {
        if (cleanupError === undefined) cleanupError = error;
      }
    }
    if (cleanupError !== undefined) throw cleanupError;
  };

  const releaseAllExternalObserverAssociations = (): void => {
    const states: Array<{
      readonly capture: boolean;
      readonly listener: AbortEventListener;
    }> = [];
    forEachMapValue(externalObserverStates, (byCapture, listener) => {
      if (getMapValue(byCapture, "bubble") !== undefined) {
        appendArrayValue(states, { capture: false, listener });
      }
      if (getMapValue(byCapture, "capture") !== undefined) {
        appendArrayValue(states, { capture: true, listener });
      }
    });
    let cleanupError: unknown;
    for (let index = 0; index < states.length; index += 1) {
      const state = states[index]!;
      try {
        releaseExternalObserverAssociations(state.listener, state.capture);
      } catch (error) {
        if (cleanupError === undefined) cleanupError = error;
      }
    }
    if (cleanupError !== undefined) throw cleanupError;
  };

  const removeRecord = (record: TrackedListener): boolean => {
    if (!record.active) return false;
    record.active = false;
    deleteRecordMapping(record);
    originalRemove(ABORT_EVENT_TYPE, record.wrapped, {
      capture: record.capture,
    });
    activeListenerCount -= 1;
    listenerRemovals += 1;
    return true;
  };

  const reconcileRecordOwnerCancellation = (record: TrackedListener): void => {
    if (
      !record.active ||
      !nativeListenerOptionSemantics
        .initialSignalCancellationPrecedesOwnerListeners[
          listenerKey(record.capture)
        ]
    ) {
      return;
    }
    let cleanupError: unknown;
    let index = 0;
    while (record.active && index < record.externalObservers.length) {
      const observer = record.externalObservers[index]!;
      if (!isSignalAborted(observer.signal)) {
        index += 1;
        continue;
      }
      try {
        nativeReflectApply(observer.handler, observer.signal, []);
      } catch (error) {
        if (cleanupError === undefined) cleanupError = error;
      }
      if (record.externalObservers[index] === observer) index += 1;
    }
    if (cleanupError !== undefined) throw cleanupError;
  };

  const reconcileAllOwnerCancellations = (): void => {
    if (activeExternalObserverCount === 0) return;
    forEachMapValue(listenerRecords, (byCapture) => {
      forEachMapValue(byCapture, (record) => {
        reconcileRecordOwnerCancellation(record);
      });
    });
  };

  const invokeUserListener = (record: TrackedListener, event: Event): void => {
    if (typeof record.listener === "function") {
      nativeReflectApply(record.listener, signal, [event]);
    } else {
      record.listener.handleEvent(event);
    }
  };

  const invokeRecord = (record: TrackedListener, event: Event): void => {
    if (!record.once) {
      invokeUserListener(record, event);
      return;
    }
    removeRecord(record);
    if (
      !nativeListenerOptionSemantics.onceRemovalRetainsSignalAssociation[
        listenerKey(record.capture)
      ]
    ) {
      releaseExternalObserverAssociations(record.listener, record.capture);
    }
    invokeUserListener(record, event);
  };

  const rememberStableWrapper = (
    listener: AbortEventListener,
    capture: boolean,
    wrapped: EventListener,
  ): EventListener => {
    let byCapture = getWeakMapValue(stableListenerWrappers, listener);
    if (byCapture === undefined) {
      byCapture = new NativeMap();
      setWeakMapValue(stableListenerWrappers, listener, byCapture);
    }
    const key = listenerKey(capture);
    const existing = getMapValue(byCapture, key);
    if (existing !== undefined) return existing;
    setMapValue(byCapture, key, wrapped);
    return wrapped;
  };

  const getStableWrapper = (
    listener: AbortEventListener,
    capture: boolean,
  ): EventListener => {
    const existing = getWeakMapValue(stableListenerWrappers, listener);
    const key = listenerKey(capture);
    const wrapped =
      existing === undefined ? undefined : getMapValue(existing, key);
    if (wrapped !== undefined) return wrapped;
    const created: EventListener = (event) => {
      const activeRecord = lookupRecord(listener, capture);
      if (activeRecord !== undefined) invokeRecord(activeRecord, event);
    };
    return rememberStableWrapper(listener, capture, created);
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
    let observedExternalSignal: AbortSignal | undefined;
    let observedExternalSignalWasAborted = false;
    const observeOptions = (): NativeListenerOptionsObservation =>
      observeNativeListenerOptions(
        options,
        (ownerSignal) => {
          if (!hasSupportedOwnerSignalSurface(ownerSignal)) {
            throw new AbortHarnessError(
              "instrumentation_unsupported",
              `${label} requires native owner-signal listener and aborted properties`,
            );
          }
          observedExternalSignal = ownerSignal;
          observedExternalSignalWasAborted = isSignalAborted(ownerSignal);
        },
        true,
        nativeListenerConversionSemantics.oncePrecedesCapture,
      );
    let normalizedType: string;
    let observation: NativeListenerOptionsObservation;
    let eventTypeConversionInProgress = false;
    let eventTypeConversionFailed = false;
    let ownerCancelledDuringEventTypeConversion = false;
    let pendingExternalObserver: ExternalAbortObserver | undefined;

    const attachExternalObserver = (
      ownerSignal: AbortSignal,
      observedListener: AbortEventListener,
      observedCapture: boolean,
      observesEventTypeConversion = false,
    ): ExternalAbortObserver => {
      let externalObserver: ExternalAbortObserver | undefined;
      const externalAbortHandler: EventListener = () => {
        const cancellationApplies =
          isSignalAborted(ownerSignal) ||
          nativeListenerOptionSemantics
            .syntheticSignalEventCancelsAssociation[
              listenerKey(observedCapture)
            ];
        if (!cancellationApplies) return;
        let cleanupError: unknown;
        if (externalObserver !== undefined) {
          try {
            detachExternalObserverAssociation(
              observedListener,
              observedCapture,
              externalObserver,
            );
          } catch (error) {
            cleanupError = error;
          }
        }
        let cancellationRemovesTarget = true;
        if (
          externalObserver?.conditionalOnEventTypeConversion === true &&
          (eventTypeConversionInProgress || eventTypeConversionFailed)
        ) {
          ownerCancelledDuringEventTypeConversion ||=
            eventTypeConversionInProgress;
          if (
            nativeListenerConversionSemantics
              .ownerAbortDuringTypeConversionRepeatsType
          ) {
            const cancellationType = normalizeNativeEventType(type);
            cancellationRemovesTarget =
              cancellationType === ABORT_EVENT_TYPE;
          }
        }
        if (
          !nativeListenerOptionSemantics
            .ownerCancellationRetainsOtherSignalAssociations[
              listenerKey(observedCapture)
            ]
        ) {
          try {
            releaseExternalObserverAssociations(
              observedListener,
              observedCapture,
            );
          } catch (error) {
            if (cleanupError === undefined) cleanupError = error;
          }
        }
        if (cancellationRemovesTarget) {
          const observedRecord = lookupRecord(
            observedListener,
            observedCapture,
          );
          if (observedRecord !== undefined) removeRecord(observedRecord);
        }
        if (cleanupError !== undefined) throw cleanupError;
      };
      externalObserver = createExternalAbortObserver(
        ownerSignal,
        externalAbortHandler,
        observesEventTypeConversion,
      );
      return externalObserver;
    };

    const discardPendingExternalObserver = (): void => {
      if (pendingExternalObserver === undefined) return;
      const observer = pendingExternalObserver;
      pendingExternalObserver = undefined;
      removeExternalAbortObserver(observer);
    };

    if (nativeListenerConversionSemantics.typePrecedesOptions) {
      normalizedType = normalizeNativeEventType(type);
      observation = observeOptions();
    } else {
      observation = observeOptions();
      const rawSignal = observation.signalValue();
      if (
        rawSignal !== undefined &&
        rawSignal !== null &&
        !isNativeAbortSignal(rawSignal)
      ) {
        const validationTarget = new NativeEventTarget();
        const validationListener = (): void => {};
        try {
          nativeReflectApply(nativeEventTargetAdd, validationTarget, [
            OPTION_SEMANTICS_PROBE_EVENT_TYPE,
            validationListener,
            observation.nativeOptions,
          ]);
        } finally {
          observation.releaseOpaqueTracking();
        }
        nativeReflectApply(nativeEventTargetRemove, validationTarget, [
          OPTION_SEMANTICS_PROBE_EVENT_TYPE,
          validationListener,
        ]);
      }
      if (
        observation.externalSignal() !== undefined &&
        observedExternalSignalWasAborted
      ) {
        observation.releaseOpaqueTracking();
        return;
      }
      const conversionExternalSignal = observation.externalSignal();
      const conversionCapture = observation.capture();
      if (conversionExternalSignal !== undefined) {
        try {
          pendingExternalObserver = attachExternalObserver(
            conversionExternalSignal,
            listener,
            conversionCapture,
            true,
          );
        } catch (error) {
          observation.releaseOpaqueTracking();
          throw error;
        }
      }
      try {
        eventTypeConversionInProgress = true;
        normalizedType = normalizeNativeEventType(type);
      } catch (error) {
        eventTypeConversionFailed = true;
        let retentionLimitExceeded = false;
        try {
          if (
            pendingExternalObserver !== undefined &&
            !restored &&
            !ownerCancelledDuringEventTypeConversion &&
            nativeListenerOptionSemantics
              .failedTypeConversionRetainsSignalAssociation[
                listenerKey(conversionCapture)
              ]
          ) {
            if (activeExternalObserverCount < trackedListenerLimit) {
              const retainedObserver = pendingExternalObserver;
              addExternalObserverAssociation(
                listener,
                conversionCapture,
                retainedObserver,
              );
              pendingExternalObserver = undefined;
            } else {
              // This host retained an association that cannot be represented
              // without violating the configured hard observer bound.
              retentionLimitExceeded = true;
              discardPendingExternalObserver();
            }
          } else {
            discardPendingExternalObserver();
          }
        } finally {
          observation.releaseOpaqueTracking();
        }
        if (retentionLimitExceeded) {
          throw new AbortHarnessError(
            "listener_limit",
            `${label} cannot retain a failed-conversion owner association within ${trackedListenerLimit} observers`,
          );
        }
        throw error;
      } finally {
        eventTypeConversionInProgress = false;
      }
    }
    const tracksAbortType = normalizedType === ABORT_EVENT_TYPE;
    const enteredDuringOwnRemovalConversion =
      (getMapValue(removalConversionDepths, listener) ?? 0) > 0;
    let observationReleased = false;
    const releaseObservation = (): void => {
      if (observationReleased) return;
      observationReleased = true;
      observation.releaseOpaqueTracking();
    };
    const discardPendingObserverAndRelease = (): void => {
      try {
        discardPendingExternalObserver();
      } finally {
        releaseObservation();
      }
    };
    if (
      nativeListenerConversionSemantics.typePrecedesOptions &&
      observation.externalSignal() !== undefined &&
      observedExternalSignalWasAborted
    ) {
      releaseObservation();
      return;
    }
    if (ownerCancelledDuringEventTypeConversion) {
      if (
        !nativeListenerConversionSemantics
          .ownerAbortDuringTypeConversionRetainsListener
      ) {
        discardPendingObserverAndRelease();
        return;
      }
      observation.suppressExternalSignal();
    }
    const applyObservedAdd = (
      observedListener: AbortEventListener,
    ): void => {
      try {
        nativeReflectApply(originalAdd, undefined, [
          normalizedType,
          observedListener,
          observation.nativeOptions,
        ]);
      } finally {
        releaseObservation();
      }
    };

    if (restored) {
      discardPendingObserverAndRelease();
      return;
    }
    if (!tracksAbortType) {
      discardPendingExternalObserver();
      applyObservedAdd(listener);
      return;
    }

    const capture = observation.capture();
    let existingRecord = lookupRecord(listener, capture);
    if (existingRecord !== undefined) {
      reconcileRecordOwnerCancellation(existingRecord);
      existingRecord = lookupRecord(listener, capture);
    }
    if (enteredDuringOwnRemovalConversion && existingRecord === undefined) {
      discardPendingExternalObserver();
      applyObservedAdd(listener);
      return;
    }

    const externalSignal = observation.externalSignal();
    const externalSignalWasLive =
      externalSignal !== undefined &&
      observedExternalSignal === externalSignal &&
      !observedExternalSignalWasAborted;
    const hasExternalSignalObserver = (): boolean => {
      const observers = getExternalObservers(listener, capture);
      if (observers === undefined) return false;
      for (
        let index = 0;
        index < observers.length;
        index += 1
      ) {
        const observer = observers[index]!;
        if (
          observer.signal === externalSignal &&
          !observer.conditionalOnEventTypeConversion
        ) {
          return true;
        }
      }
      return false;
    };
    const requiresExternalObserver = (): boolean =>
      externalSignalWasLive &&
      !ownerCancelledDuringEventTypeConversion &&
      !hasExternalSignalObserver() &&
      (existingRecord === undefined ||
        nativeListenerOptionSemantics.duplicateSignalCancelsExisting[
          listenerKey(capture)
        ]);
    let needsExternalObserver = requiresExternalObserver();
    if (
      (existingRecord === undefined &&
        activeListenerCount >= trackedListenerLimit) ||
      (needsExternalObserver &&
        activeExternalObserverCount >= trackedListenerLimit)
    ) {
      reconcileAllOwnerCancellations();
      existingRecord = lookupRecord(listener, capture);
      needsExternalObserver = requiresExternalObserver();
    }
    if (
      existingRecord === undefined &&
      activeListenerCount >= trackedListenerLimit
    ) {
      discardPendingObserverAndRelease();
      throw new AbortHarnessError(
        "listener_limit",
        `${label} exceeds ${trackedListenerLimit} active abort listeners`,
      );
    }
    if (
      needsExternalObserver &&
      activeExternalObserverCount >= trackedListenerLimit
    ) {
      discardPendingObserverAndRelease();
      throw new AbortHarnessError(
        "listener_limit",
        `${label} exceeds ${trackedListenerLimit} owner signal observers`,
      );
    }

    let wrapped: EventListener;
    try {
      wrapped = getStableWrapper(listener, capture);
    } catch (error) {
      discardPendingObserverAndRelease();
      throw error;
    }
    try {
      applyObservedAdd(wrapped);
    } catch (error) {
      discardPendingExternalObserver();
      throw error;
    }

    const externalSignalIsCurrentlyLive =
      externalSignalWasLive && !isSignalAborted(externalSignal!);
    if (existingRecord !== undefined) {
      if (needsExternalObserver && externalSignalIsCurrentlyLive) {
        const externalObserver =
          pendingExternalObserver ??
          attachExternalObserver(externalSignal!, listener, capture);
        pendingExternalObserver = undefined;
        externalObserver.conditionalOnEventTypeConversion = false;
        try {
          addExternalObserverAssociation(
            listener,
            capture,
            externalObserver,
            existingRecord.externalObservers,
          );
        } catch (error) {
          removeExternalAbortObserver(externalObserver);
          throw error;
        }
      }
      discardPendingExternalObserver();
      return;
    }
    if (externalSignal !== undefined && !externalSignalWasLive) {
      discardPendingExternalObserver();
      return;
    }

    const finalizedRecord: TrackedListener = {
      listener,
      wrapped,
      capture,
      once: observation.once(),
      externalObservers: getExternalObservers(listener, capture) ?? [],
      active: false,
    };
    let byCapture = getMapValue(listenerRecords, listener);
    if (byCapture === undefined) {
      byCapture = new NativeMap();
      setMapValue(listenerRecords, listener, byCapture);
    }
    setMapValue(byCapture, listenerKey(capture), finalizedRecord);
    finalizedRecord.active = true;
    activeListenerCount += 1;
    listenerAdds += 1;
    if (needsExternalObserver && externalSignalIsCurrentlyLive) {
      const externalObserver =
        pendingExternalObserver ??
        attachExternalObserver(externalSignal!, listener, capture);
      pendingExternalObserver = undefined;
      externalObserver.conditionalOnEventTypeConversion = false;
      try {
        addExternalObserverAssociation(
          listener,
          capture,
          externalObserver,
          finalizedRecord.externalObservers,
        );
      } catch (error) {
        removeExternalAbortObserver(externalObserver);
        removeRecord(finalizedRecord);
        throw error;
      }
    }
    discardPendingExternalObserver();
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
    let normalizedType: string;
    let capture: boolean;
    const removalDepth = getMapValue(removalConversionDepths, listener) ?? 0;
    setMapValue(removalConversionDepths, listener, removalDepth + 1);
    try {
      normalizedType = normalizeNativeEventType(type);
      if (normalizedType !== ABORT_EVENT_TYPE) {
        nativeReflectApply(originalRemove, undefined, [
          normalizedType,
          listener,
          options,
        ]);
        return;
      }
      capture = isListenerOptionsObject(options)
        ? normalizeOptionBoolean(
            nativeReflectGet(options, "capture"),
            nativeListenerOptionSemantics.removeCaptureCoercesTruthy,
          )
        : normalizePrimitiveRemovalCapture(options);
    } finally {
      if (removalDepth === 0) {
        deleteMapValue(removalConversionDepths, listener);
      } else {
        setMapValue(removalConversionDepths, listener, removalDepth);
      }
    }
    let record = lookupRecord(listener, capture);
    if (record !== undefined) {
      reconcileRecordOwnerCancellation(record);
      record = lookupRecord(listener, capture);
      if (record !== undefined) removeRecord(record);
    }
    nativeReflectApply(originalRemove, undefined, [
      normalizedType,
      listener,
      { capture },
    ]);
    if (
      !nativeListenerOptionSemantics
        .explicitRemovalRetainsSignalAssociation[listenerKey(capture)]
    ) {
      releaseExternalObserverAssociations(listener, capture);
    }
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
    setWeakMapValue(
      trustedInstrumentedAbortSignals,
      signal,
      nativeObjectFreeze({
        addEventListener: trackedAdd,
        removeEventListener: trackedRemove,
      }),
    );
  } catch (error) {
    originalRemove(ABORT_EVENT_TYPE, onNativeAbort);
    throw new AbortHarnessError(
      "instrumentation_unsupported",
      `${label} cannot instrument native AbortController methods: ${nativeString(error)}`,
    );
  }

  const snapshot = (): AbortHarnessSnapshot => {
    reconcileAllOwnerCancellations();
    return nativeObjectFreeze({
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
  };

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
      reconcileAllOwnerCancellations();
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
      releaseAllExternalObserverAssociations();
      originalRemove(ABORT_EVENT_TYPE, onNativeAbort);
      restoreDescriptor(controller, "abort", abortOwnDescriptor);
      restoreDescriptor(signal, "addEventListener", addOwnDescriptor);
      restoreDescriptor(signal, "removeEventListener", removeOwnDescriptor);
      deleteWeakMapValue(trustedInstrumentedAbortSignals, signal);
      restored = true;
    },
  };

  return nativeObjectFreeze(harness);
}
