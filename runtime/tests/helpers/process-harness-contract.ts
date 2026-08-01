import { types as utilityTypes } from "node:util";

import {
  PROCESS_EVIDENCE_NONCE_ENV,
  PROCESS_EVIDENCE_NONCE_JSON_KEY,
} from "./process-evidence-contract.mjs";

export {
  PROCESS_EVIDENCE_NONCE_ENV,
  PROCESS_EVIDENCE_NONCE_HEX_LENGTH,
  PROCESS_EVIDENCE_NONCE_JSON_KEY,
} from "./process-evidence-contract.mjs";

const MAX_ARGUMENT_COUNT = 4_096;
const MAX_ENVIRONMENT_ENTRIES = 4_096;
const MAX_ARGUMENT_AND_ENVIRONMENT_BYTES = 1_048_576;
const MAX_STDIN_BYTES = 1_048_576;
const MAX_OUTPUT_BYTES = 4 * 1_048_576;
const MAX_TIMEOUT_MS = 60_000;
const MAX_TERMINATE_GRACE_MS = 5_000;
const DEFAULT_TERMINATE_GRACE_MS = 250;
const MAX_MARKER_BYTES = 65_536;
const MAX_EXPECTED_JSON_DEPTH = 32;
const MAX_EXPECTED_JSON_NODES = 4_096;
const MAX_DURABLE_MARKER_COUNT = 32;
const ENCODED_SEPARATOR_BYTES = 1;
const CONTROL_CHARACTER_PATTERN = /\u0000/u;
const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(
  Uint8Array.prototype,
) as object;
const TYPED_ARRAY_BUFFER_GETTER = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  "buffer",
)?.get;
const TYPED_ARRAY_BYTE_LENGTH_GETTER = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  "byteLength",
)?.get;
const UINT8_ARRAY_SET = Uint8Array.prototype.set;
const ABORT_SIGNAL_ABORTED_GETTER = Object.getOwnPropertyDescriptor(
  AbortSignal.prototype,
  "aborted",
)?.get;

const INVOCATION_KEYS = new Set([
  "program",
  "args",
  "cwd",
  "env",
  "stdin",
  "timeoutMs",
  "maxOutputBytes",
  "terminateGraceMs",
  "signal",
  "heartbeat",
  "durableMarkers",
]);
const HEARTBEAT_KEYS = new Set([
  "path",
  "startupTimeoutMs",
  "intervalTimeoutMs",
  "maxBytes",
]);
const MARKER_KEYS = new Set(["path", "timeoutMs", "maxBytes", "expectedJson"]);

export interface ChildHeartbeatExpectation {
  readonly path: string;
  readonly startupTimeoutMs: number;
  readonly intervalTimeoutMs: number;
  readonly maxBytes: number;
}

export interface ChildInvocation {
  readonly program: string;
  readonly args?: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly stdin?: Uint8Array;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly terminateGraceMs?: number;
  readonly signal?: AbortSignal;
  readonly heartbeat?: ChildHeartbeatExpectation;
  readonly durableMarkers?: readonly string[];
}

export interface DurableMarkerExpectation {
  readonly path: string;
  readonly timeoutMs: number;
  readonly maxBytes: number;
  readonly expectedJson?: Readonly<Record<string, unknown>>;
}

export interface SnapshottedChildInvocation {
  readonly program: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly stdin?: Uint8Array;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly terminateGraceMs: number;
  readonly signal?: AbortSignal;
  readonly heartbeat?: ChildHeartbeatExpectation;
  readonly durableMarkers: readonly string[];
  readonly deadline: number;
}

export interface SnapshottedMarkerExpectation {
  readonly path: string;
  readonly timeoutMs: number;
  readonly maxBytes: number;
  readonly expectedJson?: Readonly<Record<string, unknown>>;
}

type DataProperties = Readonly<Record<PropertyKey, unknown>>;

export function snapshotChildInvocation(
  invocation: ChildInvocation,
): SnapshottedChildInvocation {
  const started = performance.now();
  const properties = dataProperties(
    invocation,
    INVOCATION_KEYS,
    "child invocation",
  );
  const program = safeString(properties.program, "child program");
  const cwd = safeString(properties.cwd, "child working directory");
  const args = snapshotStringArray(properties.args, "child arguments");
  const durableMarkers = snapshotStringArray(
    properties.durableMarkers,
    "child durable markers",
  );
  if (durableMarkers.length > MAX_DURABLE_MARKER_COUNT) {
    throw new Error("child durable marker count exceeds its limit");
  }
  if (new Set(durableMarkers).size !== durableMarkers.length) {
    throw new Error("child durable marker paths must be unique");
  }
  const env = snapshotEnvironment(properties.env);
  const timeoutMs = boundedInteger(
    properties.timeoutMs,
    1,
    MAX_TIMEOUT_MS,
    "child timeoutMs",
  );
  const maxOutputBytes = boundedInteger(
    properties.maxOutputBytes,
    1,
    MAX_OUTPUT_BYTES,
    "child maxOutputBytes",
  );
  const terminateGraceMs =
    properties.terminateGraceMs === undefined
      ? DEFAULT_TERMINATE_GRACE_MS
      : boundedInteger(
          properties.terminateGraceMs,
          1,
          MAX_TERMINATE_GRACE_MS,
          "child terminateGraceMs",
        );
  const stdin = snapshotStdin(properties.stdin);
  const signal = snapshotAbortSignal(properties.signal);
  const heartbeat = snapshotHeartbeat(properties.heartbeat);

  let encodedBytes =
    Buffer.byteLength(program, "utf8") +
    ENCODED_SEPARATOR_BYTES +
    Buffer.byteLength(cwd, "utf8") +
    ENCODED_SEPARATOR_BYTES;
  for (const argument of args) {
    encodedBytes +=
      Buffer.byteLength(argument, "utf8") + ENCODED_SEPARATOR_BYTES;
  }
  for (const marker of durableMarkers) {
    encodedBytes += Buffer.byteLength(marker, "utf8") + ENCODED_SEPARATOR_BYTES;
  }
  for (const [name, value] of Object.entries(env)) {
    encodedBytes +=
      Buffer.byteLength(name, "utf8") +
      ENCODED_SEPARATOR_BYTES +
      Buffer.byteLength(value, "utf8") +
      ENCODED_SEPARATOR_BYTES;
  }
  if (encodedBytes > MAX_ARGUMENT_AND_ENVIRONMENT_BYTES) {
    throw new Error("child arguments and environment exceed their byte limit");
  }

  return Object.freeze({
    program,
    args,
    cwd,
    env,
    ...(stdin === undefined ? {} : { stdin }),
    timeoutMs,
    maxOutputBytes,
    terminateGraceMs,
    ...(signal === undefined ? {} : { signal }),
    ...(heartbeat === undefined ? {} : { heartbeat }),
    durableMarkers,
    deadline: started + timeoutMs,
  });
}

export function snapshotMarkerExpectation(
  expectation: DurableMarkerExpectation,
): SnapshottedMarkerExpectation {
  const properties = dataProperties(
    expectation,
    MARKER_KEYS,
    "durable marker expectation",
  );
  const path = safeString(properties.path, "child marker path");
  const timeoutMs = boundedInteger(
    properties.timeoutMs,
    1,
    MAX_TIMEOUT_MS,
    "marker timeoutMs",
  );
  const maxBytes = boundedInteger(
    properties.maxBytes,
    1,
    MAX_MARKER_BYTES,
    "marker maxBytes",
  );
  const expectedJson =
    properties.expectedJson === undefined
      ? undefined
      : snapshotBoundedJsonObject(properties.expectedJson, maxBytes);
  if (
    expectedJson !== undefined &&
    Object.hasOwn(expectedJson, PROCESS_EVIDENCE_NONCE_JSON_KEY)
  ) {
    throw new Error("marker expectedJson must not declare the run nonce");
  }
  return Object.freeze({
    path,
    timeoutMs,
    maxBytes,
    ...(expectedJson === undefined ? {} : { expectedJson }),
  });
}

export function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

export function snapshotBoundedJsonObject(
  value: unknown,
  maximumBytes: number,
): Readonly<Record<string, unknown>> {
  const state = {
    nodes: 0,
    ancestors: new Set<object>(),
  };
  const snapshot = cloneJson(value, 0, state);
  if (!isPlainRecord(snapshot)) {
    throw new Error("bounded JSON must be an ordinary object");
  }
  const encoded = JSON.stringify(snapshot);
  if (Buffer.byteLength(encoded, "utf8") > maximumBytes) {
    throw new Error("bounded JSON exceeds its byte limit");
  }
  return snapshot;
}

function snapshotStringArray(value: unknown, label: string): readonly string[] {
  if (value === undefined) return Object.freeze([]);
  if (
    !Array.isArray(value) ||
    utilityTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Array.prototype
  ) {
    throw new Error(`${label} must be an ordinary dense array`);
  }
  if (value.length > MAX_ARGUMENT_COUNT) {
    throw new Error("child argument count exceeds its limit");
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || !keys.includes("length")) {
    throw new Error(`${label} must not contain sparse or custom properties`);
  }
  const snapshot: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new Error(`${label} must contain only data properties`);
    }
    snapshot.push(safeString(descriptor.value, `child argument ${index}`));
  }
  return Object.freeze(snapshot);
}

function snapshotEnvironment(value: unknown): Readonly<Record<string, string>> {
  if (!isPlainRecord(value)) {
    throw new Error("child environment must be an ordinary record");
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key === "symbol")) {
    throw new Error("child environment must not contain symbol properties");
  }
  if (keys.length > MAX_ENVIRONMENT_ENTRIES) {
    throw new Error("child environment entry count exceeds its limit");
  }
  const snapshot = Object.create(null) as Record<string, string>;
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new Error("child environment must contain only data properties");
    }
    if (key.length === 0 || key.includes("=")) {
      throw new Error("child environment contains an invalid name");
    }
    const name = safeString(key, "child environment name");
    if (name === PROCESS_EVIDENCE_NONCE_ENV) {
      throw new Error("child environment contains a reserved harness name");
    }
    snapshot[name] = safeString(
      descriptor.value,
      `child environment value ${name}`,
    );
  }
  return Object.freeze(snapshot);
}

function snapshotStdin(value: unknown): Uint8Array | undefined {
  if (value === undefined) return undefined;
  if (
    utilityTypes.isProxy(value) ||
    !utilityTypes.isUint8Array(value) ||
    TYPED_ARRAY_BUFFER_GETTER === undefined ||
    TYPED_ARRAY_BYTE_LENGTH_GETTER === undefined
  ) {
    throw new Error("child stdin must be an exclusive Uint8Array");
  }
  const backingBuffer = TYPED_ARRAY_BUFFER_GETTER.call(
    value,
  ) as ArrayBufferLike;
  if (utilityTypes.isSharedArrayBuffer(backingBuffer)) {
    throw new Error("child stdin must be an exclusive Uint8Array");
  }
  let byteLength: unknown;
  try {
    byteLength = TYPED_ARRAY_BYTE_LENGTH_GETTER.call(value);
  } catch (error) {
    throw new Error("child stdin must not be detached", { cause: error });
  }
  if (
    !Number.isSafeInteger(byteLength) ||
    (byteLength as number) < 0 ||
    (byteLength as number) > MAX_STDIN_BYTES
  ) {
    throw new Error("child stdin exceeds its supported byte limit");
  }
  let snapshot: Uint8Array;
  try {
    snapshot = new Uint8Array(byteLength as number);
    Reflect.apply(UINT8_ARRAY_SET, snapshot, [value]);
  } catch (error) {
    throw new Error("child stdin must not be detached", { cause: error });
  }
  return snapshot;
}

function snapshotAbortSignal(value: unknown): AbortSignal | undefined {
  if (value === undefined) return undefined;
  if (
    utilityTypes.isProxy(value) ||
    !(value instanceof AbortSignal) ||
    Object.getPrototypeOf(value) !== AbortSignal.prototype ||
    Reflect.ownKeys(value).some((key) => typeof key === "string") ||
    ABORT_SIGNAL_ABORTED_GETTER === undefined
  ) {
    throw new Error("child signal must be an AbortSignal");
  }
  try {
    ABORT_SIGNAL_ABORTED_GETTER.call(value);
  } catch (error) {
    throw new Error("child signal must be a branded AbortSignal", {
      cause: error,
    });
  }
  return value;
}

function snapshotHeartbeat(
  value: unknown,
): ChildHeartbeatExpectation | undefined {
  if (value === undefined) return undefined;
  const properties = dataProperties(
    value,
    HEARTBEAT_KEYS,
    "child heartbeat expectation",
  );
  return Object.freeze({
    path: safeString(properties.path, "child heartbeat path"),
    startupTimeoutMs: boundedInteger(
      properties.startupTimeoutMs,
      1,
      MAX_TIMEOUT_MS,
      "heartbeat startupTimeoutMs",
    ),
    intervalTimeoutMs: boundedInteger(
      properties.intervalTimeoutMs,
      1,
      MAX_TIMEOUT_MS,
      "heartbeat intervalTimeoutMs",
    ),
    maxBytes: boundedInteger(
      properties.maxBytes,
      1,
      MAX_MARKER_BYTES,
      "heartbeat maxBytes",
    ),
  });
}

function cloneJson(
  value: unknown,
  depth: number,
  state: { nodes: number; readonly ancestors: Set<object> },
): unknown {
  state.nodes += 1;
  if (state.nodes > MAX_EXPECTED_JSON_NODES) {
    throw new Error("marker expectedJson exceeds its node limit");
  }
  if (depth > MAX_EXPECTED_JSON_DEPTH) {
    throw new Error("marker expectedJson exceeds its depth limit");
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return safeString(value, "marker JSON string");
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object" || utilityTypes.isProxy(value)) {
    throw new Error("marker expectedJson contains a non-JSON value");
  }
  if (state.ancestors.has(value)) {
    throw new Error("marker expectedJson must not contain cycles");
  }
  state.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        throw new Error("marker expectedJson arrays must be ordinary arrays");
      }
      const keys = Reflect.ownKeys(value);
      if (keys.length !== value.length + 1 || !keys.includes("length")) {
        throw new Error("marker expectedJson arrays must be dense");
      }
      const result: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(
          value,
          String(index),
        );
        if (descriptor === undefined || !("value" in descriptor)) {
          throw new Error(
            "marker expectedJson must contain only data properties",
          );
        }
        result.push(cloneJson(descriptor.value, depth + 1, state));
      }
      return Object.freeze(result);
    }
    if (!isPlainRecord(value)) {
      throw new Error("marker expectedJson objects must be ordinary records");
    }
    const result: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") {
        throw new Error(
          "marker expectedJson must not contain symbol properties",
        );
      }
      safeString(key, "marker JSON property name");
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor)) {
        throw new Error(
          "marker expectedJson must contain only data properties",
        );
      }
      Object.defineProperty(result, key, {
        configurable: false,
        enumerable: true,
        writable: false,
        value: cloneJson(descriptor.value, depth + 1, state),
      });
    }
    return Object.freeze(result);
  } finally {
    state.ancestors.delete(value);
  }
}

function dataProperties(
  value: unknown,
  allowedKeys: ReadonlySet<string>,
  label: string,
): DataProperties {
  if (!isPlainRecord(value)) {
    throw new Error(`${label} must be an ordinary record`);
  }
  const properties = Object.create(null) as Record<PropertyKey, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowedKeys.has(key)) {
      throw new Error(`${label} contains an unknown property`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new Error(`${label} must contain only data properties`);
    }
    properties[key] = descriptor.value;
  }
  return properties;
}

function isPlainRecord(value: unknown): value is Record<PropertyKey, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    utilityTypes.isProxy(value)
  ) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function safeString(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    CONTROL_CHARACTER_PATTERN.test(value) ||
    !isWellFormedUnicode(value)
  ) {
    throw new Error(`${label} contains an unsafe character`);
  }
  return value;
}

function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  ) {
    throw new Error(`${label} is outside its supported range`);
  }
  return value as number;
}
