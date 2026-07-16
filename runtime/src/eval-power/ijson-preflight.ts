import { Buffer } from "node:buffer";

const MAXIMUM_DEPTH = 64;
const MAXIMUM_ARRAY_LENGTH = 100_000;
const MAXIMUM_PROPERTIES_PER_OBJECT = 256;
const MAXIMUM_TOTAL_NODES = 1_200_000;
const MAXIMUM_TOTAL_PROPERTIES = 1_200_000;
const MAXIMUM_SINGLE_STRING_BYTES = 1_000_000;
const MAXIMUM_TOTAL_STRING_BYTES = 200_000_000;
const MAXIMUM_DIAGNOSTIC_PATH_LENGTH = 512;

interface VisitFrame {
  readonly kind: "visit";
  readonly value: unknown;
  readonly depth: number;
  readonly path: string;
}

interface LeaveFrame {
  readonly kind: "leave";
  readonly value: object;
}

type Frame = VisitFrame | LeaveFrame;

export class BoundedIJsonPreflightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BoundedIJsonPreflightError";
  }
}

function fail(message: string): never {
  throw new BoundedIJsonPreflightError(message);
}

function addStringBytes(value: string, path: string, current: number): number {
  const byteLength = Buffer.byteLength(value, "utf8");
  if (byteLength > MAXIMUM_SINGLE_STRING_BYTES) {
    fail(`${path} exceeds the single-string budget`);
  }
  const next = current + byteLength;
  if (next > MAXIMUM_TOTAL_STRING_BYTES) {
    fail(`I-JSON graph exceeds the ${MAXIMUM_TOTAL_STRING_BYTES}-byte string budget`);
  }
  return next;
}

function appendPath(path: string, suffix: string): string {
  if (path.length + suffix.length <= MAXIMUM_DIAGNOSTIC_PATH_LENGTH) return `${path}${suffix}`;
  return `${path.slice(0, MAXIMUM_DIAGNOSTIC_PATH_LENGTH - 1)}…`;
}

/**
 * Descriptor-only, iterative resource preflight for data that will later be
 * canonicalized. It mirrors the canonical I-JSON data-property constraints
 * without invoking accessors or recursively walking an attacker-sized graph.
 */
export function assertBoundedIJsonGraph(value: unknown, rootLabel: string): void {
  const ancestors = new Set<object>();
  const stack: Frame[] = [{ kind: "visit", value, depth: 0, path: rootLabel }];
  let totalNodes = 0;
  let totalProperties = 0;
  let totalStringBytes = 0;

  while (stack.length > 0) {
    const frame = stack.pop() as Frame;
    if (frame.kind === "leave") {
      ancestors.delete(frame.value);
      continue;
    }

    totalNodes += 1;
    if (totalNodes > MAXIMUM_TOTAL_NODES) {
      fail(`I-JSON graph exceeds the ${MAXIMUM_TOTAL_NODES}-node budget`);
    }
    if (frame.depth > MAXIMUM_DEPTH) {
      fail(`${frame.path} exceeds the maximum I-JSON depth ${MAXIMUM_DEPTH}`);
    }

    const candidate = frame.value;
    if (candidate === null || typeof candidate === "boolean") continue;
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)
        || (Number.isInteger(candidate) && !Number.isSafeInteger(candidate))
        || Object.is(candidate, -0)) {
        fail(`${frame.path} is not a finite, unambiguous I-JSON number`);
      }
      continue;
    }
    if (typeof candidate === "string") {
      totalStringBytes = addStringBytes(candidate, frame.path, totalStringBytes);
      continue;
    }
    if (typeof candidate !== "object") {
      fail(`${frame.path} is not an I-JSON value`);
    }
    if (ancestors.has(candidate)) fail(`${frame.path} contains a cycle`);

    const prototype = Object.getPrototypeOf(candidate);
    if (Array.isArray(candidate)) {
      if (candidate.length > MAXIMUM_ARRAY_LENGTH) {
        fail(`${frame.path} exceeds the maximum array length ${MAXIMUM_ARRAY_LENGTH}`);
      }
      const ownKeys = Reflect.ownKeys(candidate);
      const ownPropertyCount = ownKeys.length - 1; // Array length is not serialized.
      if (ownPropertyCount > MAXIMUM_ARRAY_LENGTH
        || totalProperties + ownPropertyCount > MAXIMUM_TOTAL_PROPERTIES) {
        fail(`I-JSON graph exceeds the ${MAXIMUM_TOTAL_PROPERTIES}-property budget`);
      }
      for (const key of ownKeys) {
        if (typeof key === "symbol") fail(`${frame.path} contains a symbol property`);
        if (key !== "length" && !/^(?:0|[1-9][0-9]*)$/u.test(key)) {
          fail(`${frame.path} contains a non-JSON array property`);
        }
      }
      totalProperties += ownPropertyCount;
      ancestors.add(candidate);
      stack.push({ kind: "leave", value: candidate });
      for (let index = candidate.length - 1; index >= 0; index -= 1) {
        const descriptor = Object.getOwnPropertyDescriptor(candidate, String(index));
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
          fail(`${frame.path}[${index}] must be an own enumerable data property`);
        }
        stack.push({
          kind: "visit",
          value: descriptor.value,
          depth: frame.depth + 1,
          path: appendPath(frame.path, `[${index}]`),
        });
      }
      continue;
    }

    if (prototype !== Object.prototype && prototype !== null) {
      fail(`${frame.path} must be a plain JSON object`);
    }
    const ownKeys = Reflect.ownKeys(candidate);
    if (ownKeys.length > MAXIMUM_PROPERTIES_PER_OBJECT) {
      fail(`${frame.path} exceeds the per-object property budget`);
    }
    if (totalProperties + ownKeys.length > MAXIMUM_TOTAL_PROPERTIES) {
      fail(`I-JSON graph exceeds the ${MAXIMUM_TOTAL_PROPERTIES}-property budget`);
    }
    totalProperties += ownKeys.length;
    ancestors.add(candidate);
    stack.push({ kind: "leave", value: candidate });
    for (let index = ownKeys.length - 1; index >= 0; index -= 1) {
      const key = ownKeys[index];
      if (typeof key === "symbol") fail(`${frame.path} contains a symbol property`);
      totalStringBytes = addStringBytes(key, `${frame.path} property name`, totalStringBytes);
      const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        fail(`${frame.path}.${key} must be an own enumerable data property`);
      }
      stack.push({
        kind: "visit",
        value: descriptor.value,
        depth: frame.depth + 1,
        path: appendPath(frame.path, `.${key}`),
      });
    }
  }
}
