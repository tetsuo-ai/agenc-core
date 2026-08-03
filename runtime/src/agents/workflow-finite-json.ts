/** Strict, duplicate-aware, resource-bounded JSON for workflow contracts. */

import { TextDecoder } from "node:util";
import { types as utilTypes } from "node:util";

// Use the ESM entry explicitly: the package's CommonJS UMD entry performs
// relative runtime requires that cannot survive the runtime's single-file
// esbuild chunks.
import { printParseErrorCode, visit } from "jsonc-parser/lib/esm/main.js";

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

export type FiniteJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly FiniteJsonValue[]
  | { readonly [key: string]: FiniteJsonValue };

export interface FiniteJsonLimits {
  readonly maximumBytes: number;
  readonly maximumDepth: number;
  readonly maximumNodes: number;
  readonly maximumKeyUtf8Bytes: number;
  readonly maximumStringUtf8Bytes: number;
  readonly maximumTotalStringUtf8Bytes: number;
}

export class FiniteJsonValidationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "FiniteJsonValidationError";
    this.code = code;
  }
}

interface ObjectFrame {
  readonly kind: "object";
  readonly value: Record<string, FiniteJsonValue>;
  readonly keys: Set<string>;
  pendingKey: string | undefined;
}

interface ArrayFrame {
  readonly kind: "array";
  readonly value: FiniteJsonValue[];
}

type ParseFrame = ObjectFrame | ArrayFrame;

export function parseFiniteJsonBytes(
  bytes: Uint8Array,
  label: string,
  limits: FiniteJsonLimits,
): FiniteJsonValue {
  validateLimits(limits);
  if (bytes.byteLength > limits.maximumBytes) {
    throw validationError(
      "JSON_BYTES",
      label,
      `exceeds ${limits.maximumBytes} bytes`,
    );
  }
  const source = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    source.byteLength >= UTF8_BOM.byteLength &&
    source.subarray(0, UTF8_BOM.byteLength).equals(UTF8_BOM)
  ) {
    throw validationError("JSON_BOM", label, "must not start with a UTF-8 BOM");
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(source);
  } catch (error) {
    throw validationError(
      "JSON_UTF8",
      label,
      `is not valid UTF-8: ${errorMessage(error)}`,
    );
  }

  const frames: ParseFrame[] = [];
  let root: FiniteJsonValue | undefined;
  let hasRoot = false;
  let nodeCount = 0;
  let totalStringUtf8Bytes = 0;

  const countNode = (): void => {
    nodeCount += 1;
    if (nodeCount > limits.maximumNodes) {
      throw validationError(
        "JSON_NODES",
        label,
        `exceeds ${limits.maximumNodes} JSON nodes`,
      );
    }
  };

  const countString = (value: string, maximumBytes: number, kind: string): void => {
    assertWellFormedUnicode(value, label, kind);
    const byteLength = Buffer.byteLength(value, "utf8");
    if (byteLength > maximumBytes) {
      throw validationError(
        kind === "object key" ? "JSON_KEY_BYTES" : "JSON_STRING_BYTES",
        label,
        `${kind} exceeds ${maximumBytes} UTF-8 bytes`,
      );
    }
    totalStringUtf8Bytes += byteLength;
    if (totalStringUtf8Bytes > limits.maximumTotalStringUtf8Bytes) {
      throw validationError(
        "JSON_TOTAL_STRING_BYTES",
        label,
        `exceeds ${limits.maximumTotalStringUtf8Bytes} aggregate string UTF-8 bytes`,
      );
    }
  };

  const attach = (value: FiniteJsonValue): void => {
    const parent = frames.at(-1);
    if (parent === undefined) {
      if (hasRoot) {
        throw validationError("JSON_TRAILING", label, "contains trailing JSON data");
      }
      root = value;
      hasRoot = true;
      return;
    }
    if (parent.kind === "array") {
      parent.value.push(value);
      return;
    }
    const key = parent.pendingKey;
    if (key === undefined) {
      throw validationError("JSON_STRUCTURE", label, "contains an object value without a key");
    }
    Object.defineProperty(parent.value, key, {
      configurable: false,
      enumerable: true,
      value,
      writable: false,
    });
    parent.pendingKey = undefined;
  };

  const beginContainer = (kind: ParseFrame["kind"]): void => {
    const depth = frames.length + 1;
    if (depth > limits.maximumDepth) {
      throw validationError(
        "JSON_DEPTH",
        label,
        `exceeds JSON depth ${limits.maximumDepth}`,
      );
    }
    countNode();
    if (kind === "object") {
      const value = Object.create(null) as Record<string, FiniteJsonValue>;
      attach(value);
      frames.push({ kind, value, keys: new Set(), pendingKey: undefined });
    } else {
      const value: FiniteJsonValue[] = [];
      attach(value);
      frames.push({ kind, value });
    }
  };

  try {
    visit(
      text,
      {
        onObjectBegin() {
          beginContainer("object");
        },
        onObjectProperty(property) {
          const frame = frames.at(-1);
          if (frame?.kind !== "object" || frame.pendingKey !== undefined) {
            throw validationError("JSON_STRUCTURE", label, "contains an invalid object member");
          }
          countString(property, limits.maximumKeyUtf8Bytes, "object key");
          if (frame.keys.has(property)) {
            throw validationError(
              "JSON_DUPLICATE_KEY",
              label,
              `contains duplicate object key ${JSON.stringify(property)}`,
            );
          }
          frame.keys.add(property);
          frame.pendingKey = property;
        },
        onObjectEnd() {
          const frame = frames.pop();
          if (frame?.kind !== "object" || frame.pendingKey !== undefined) {
            throw validationError("JSON_STRUCTURE", label, "contains an incomplete object");
          }
          Object.freeze(frame.value);
        },
        onArrayBegin() {
          beginContainer("array");
        },
        onArrayEnd() {
          const frame = frames.pop();
          if (frame?.kind !== "array") {
            throw validationError("JSON_STRUCTURE", label, "contains an incomplete array");
          }
          Object.freeze(frame.value);
        },
        onLiteralValue(value: unknown) {
          countNode();
          if (typeof value === "string") {
            countString(value, limits.maximumStringUtf8Bytes, "string value");
          } else if (typeof value === "number") {
            assertFiniteJsonNumber(value, label);
          } else if (
            value !== null &&
            typeof value !== "boolean"
          ) {
            throw validationError("JSON_LITERAL", label, "contains an invalid JSON literal");
          }
          attach(value as FiniteJsonValue);
        },
        onError(error, offset) {
          throw validationError(
            "JSON_SYNTAX",
            label,
            `contains ${printParseErrorCode(error)} at UTF-16 offset ${offset}`,
          );
        },
      },
      { disallowComments: true, allowTrailingComma: false, allowEmptyContent: false },
    );
  } catch (error) {
    if (error instanceof FiniteJsonValidationError) throw error;
    throw validationError("JSON_SYNTAX", label, errorMessage(error));
  }

  if (!hasRoot || root === undefined || frames.length !== 0) {
    throw validationError("JSON_EMPTY", label, "does not contain one complete JSON value");
  }
  return root;
}

interface CloneTaskValue {
  readonly kind: "value";
  readonly source: unknown;
  readonly depth: number;
  readonly target?: FiniteJsonValue[] | Record<string, FiniteJsonValue>;
  readonly key?: number | string;
}

interface CloneTaskFreeze {
  readonly kind: "freeze";
  readonly target: FiniteJsonValue[] | Record<string, FiniteJsonValue>;
}

type CloneTask = CloneTaskValue | CloneTaskFreeze;

/**
 * Validate a programmatic JSON value without invoking accessors or Proxy traps,
 * and copy it into the same inert representation produced by the text parser.
 */
export function cloneFiniteJsonValue(
  input: unknown,
  label: string,
  limits: Omit<FiniteJsonLimits, "maximumBytes">,
): FiniteJsonValue {
  validateLimits({ ...limits, maximumBytes: 1 });
  const seen = new WeakSet<object>();
  const tasks: CloneTask[] = [{ kind: "value", source: input, depth: 1 }];
  let root: FiniteJsonValue | undefined;
  let hasRoot = false;
  let nodeCount = 0;
  let totalStringUtf8Bytes = 0;

  const countString = (value: string, maximumBytes: number, kind: string): void => {
    assertWellFormedUnicode(value, label, kind);
    const byteLength = Buffer.byteLength(value, "utf8");
    if (byteLength > maximumBytes) {
      throw validationError(
        kind === "object key" ? "JSON_KEY_BYTES" : "JSON_STRING_BYTES",
        label,
        `${kind} exceeds ${maximumBytes} UTF-8 bytes`,
      );
    }
    totalStringUtf8Bytes += byteLength;
    if (totalStringUtf8Bytes > limits.maximumTotalStringUtf8Bytes) {
      throw validationError(
        "JSON_TOTAL_STRING_BYTES",
        label,
        `exceeds ${limits.maximumTotalStringUtf8Bytes} aggregate string UTF-8 bytes`,
      );
    }
  };

  const assign = (
    task: CloneTaskValue,
    value: FiniteJsonValue,
  ): void => {
    if (task.target === undefined) {
      if (hasRoot) {
        throw validationError("JSON_STRUCTURE", label, "contains more than one root value");
      }
      root = value;
      hasRoot = true;
      return;
    }
    if (Array.isArray(task.target)) {
      task.target[task.key as number] = value;
      return;
    }
    Object.defineProperty(task.target, task.key as string, {
      configurable: false,
      enumerable: true,
      value,
      writable: false,
    });
  };

  while (tasks.length > 0) {
    const task = tasks.pop()!;
    if (task.kind === "freeze") {
      Object.freeze(task.target);
      continue;
    }
    nodeCount += 1;
    if (nodeCount > limits.maximumNodes) {
      throw validationError(
        "JSON_NODES",
        label,
        `exceeds ${limits.maximumNodes} JSON nodes`,
      );
    }
    const source = task.source;
    if (source === null || typeof source === "boolean") {
      assign(task, source);
      continue;
    }
    if (typeof source === "number") {
      assertFiniteJsonNumber(source, label);
      assign(task, source);
      continue;
    }
    if (typeof source === "string") {
      countString(source, limits.maximumStringUtf8Bytes, "string value");
      assign(task, source);
      continue;
    }
    if (typeof source !== "object") {
      throw validationError("JSON_TYPE", label, "contains a non-JSON value");
    }
    if (task.depth > limits.maximumDepth) {
      throw validationError(
        "JSON_DEPTH",
        label,
        `exceeds JSON depth ${limits.maximumDepth}`,
      );
    }
    if (utilTypes.isProxy(source)) {
      throw validationError("JSON_PROXY", label, "must not contain a Proxy");
    }
    if (seen.has(source)) {
      throw validationError("JSON_ALIAS", label, "must be a tree without cycles or aliases");
    }
    seen.add(source);

    if (Array.isArray(source)) {
      if (Object.getPrototypeOf(source) !== Array.prototype) {
        throw validationError("JSON_EXOTIC", label, "contains an exotic array");
      }
      const ownKeys = Reflect.ownKeys(source);
      if (source.length > limits.maximumNodes - nodeCount) {
        throw validationError(
          "JSON_NODES",
          label,
          `exceeds ${limits.maximumNodes} JSON nodes`,
        );
      }
      for (let index = 0; index < source.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(source, String(index));
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
          throw validationError("JSON_SPARSE_ARRAY", label, "contains a sparse or accessor array");
        }
      }
      if (
        ownKeys.some(
          (key) =>
            typeof key === "symbol" ||
            (key !== "length" && !/^(?:0|[1-9][0-9]*)$/u.test(key)),
        )
      ) {
        throw validationError("JSON_ARRAY_PROPERTY", label, "contains a non-JSON array property");
      }
      const target: FiniteJsonValue[] = new Array(source.length);
      assign(task, target);
      tasks.push({ kind: "freeze", target });
      for (let index = source.length - 1; index >= 0; index -= 1) {
        const descriptor = Object.getOwnPropertyDescriptor(source, String(index))!;
        tasks.push({
          kind: "value",
          source: (descriptor as PropertyDescriptor & { value: unknown }).value,
          depth: task.depth + 1,
          target,
          key: index,
        });
      }
      continue;
    }

    const prototype = Object.getPrototypeOf(source);
    if (prototype !== Object.prototype && prototype !== null) {
      throw validationError("JSON_EXOTIC", label, "contains an exotic object");
    }
    const ownKeys = Reflect.ownKeys(source);
    if (ownKeys.length > limits.maximumNodes - nodeCount) {
      throw validationError(
        "JSON_NODES",
        label,
        `exceeds ${limits.maximumNodes} JSON nodes`,
      );
    }
    const entries: Array<readonly [string, unknown]> = [];
    for (const key of ownKeys) {
      if (typeof key === "symbol") {
        throw validationError("JSON_SYMBOL", label, "contains a symbol property");
      }
      countString(key, limits.maximumKeyUtf8Bytes, "object key");
      const descriptor = Object.getOwnPropertyDescriptor(source, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        throw validationError("JSON_ACCESSOR", label, "contains an accessor or hidden property");
      }
      entries.push([key, descriptor.value]);
    }
    const target = Object.create(null) as Record<string, FiniteJsonValue>;
    assign(task, target);
    tasks.push({ kind: "freeze", target });
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const [key, value] = entries[index]!;
      tasks.push({
        kind: "value",
        source: value,
        depth: task.depth + 1,
        target,
        key,
      });
    }
  }

  if (!hasRoot || root === undefined) {
    throw validationError("JSON_EMPTY", label, "does not contain a JSON value");
  }
  return root;
}

function assertFiniteJsonNumber(value: number, label: string): void {
  if (!Number.isFinite(value)) {
    throw validationError("JSON_NUMBER", label, "contains a non-finite number");
  }
  if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
    throw validationError("JSON_NUMBER", label, "contains an unsafe integer");
  }
  if (Object.is(value, -0)) {
    throw validationError("JSON_NUMBER", label, "contains ambiguous negative zero");
  }
}

function assertWellFormedUnicode(value: string, label: string, kind: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) {
        throw validationError("JSON_UNICODE", label, `${kind} contains a lone high surrogate`);
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw validationError("JSON_UNICODE", label, `${kind} contains a lone low surrogate`);
    }
  }
}

function validateLimits(limits: FiniteJsonLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`${name} must be a positive safe integer`);
    }
  }
}

function validationError(
  code: string,
  label: string,
  detail: string,
): FiniteJsonValidationError {
  return new FiniteJsonValidationError(code, `${label} ${detail}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
