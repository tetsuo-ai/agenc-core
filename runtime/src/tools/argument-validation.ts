import { isRecord } from "../utils/record.js";
import type { Tool } from "./types.js";

export interface SchemaValidationError {
  readonly path: string;
  readonly message: string;
  /**
   * Category driving the AgenC-style prose: missing required,
   * unexpected key, type mismatch, or `other` for everything else.
   */
  readonly category: "missing" | "unexpected_key" | "type" | "other";
  readonly expected?: string;
  readonly received?: string;
}

export interface SchemaValidationResult {
  readonly valid: boolean;
  readonly errors: ReadonlyArray<SchemaValidationError>;
  /** Execution-only copy; the caller must preserve the model input for replay. */
  readonly args?: Record<string, unknown>;
  readonly coercedPaths?: readonly string[];
  /** Set when `args` is the tool's `reshapeModelArgs` fold of the input. */
  readonly reshaped?: true;
}

function schemaTypeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  switch (typeof value) {
    case "string":
      return "string";
    case "boolean":
      return "boolean";
    case "number":
      return Number.isInteger(value) ? "integer" : "number";
    case "bigint":
      return "integer";
    case "object":
      return "object";
    default:
      return typeof value;
  }
}

function typeMatches(expected: string, actualType: string): boolean {
  if (expected === actualType) return true;
  if (expected === "number" && actualType === "integer") return true;
  return false;
}

type SchemaObj = Record<string, unknown>;

function resolveRef(schema: SchemaObj, rootSchema: SchemaObj): SchemaObj {
  const ref = schema["$ref"];
  if (typeof ref !== "string" || !ref.startsWith("#/")) return schema;
  const segments = ref.slice(2).split("/");
  let node: unknown = rootSchema;
  for (const seg of segments) {
    if (!isRecord(node)) return schema;
    node = node[seg];
  }
  return isRecord(node) ? node : schema;
}

function joinPath(prefix: string, key: string | number): string {
  if (prefix === "") return String(key);
  return `${prefix}.${key}`;
}

/**
 * Richer JSON Schema validator that covers the keywords AgenC's
 * Zod schemas emit: `type`, `required`, `properties`,
 * `additionalProperties`, `items`, `enum`, `const`, `anyOf`, `oneOf`,
 * `allOf`, `$ref`, `format`, plus coarse string length / number
 * range bounds. Unknown keywords are ignored (consistent with the
 * "catch glaring contract violations" intent).
 */
export function validateToolArgs(
  schema: Record<string, unknown> | undefined,
  args: Record<string, unknown>,
): SchemaValidationResult {
  const errors: SchemaValidationError[] = [];
  if (!schema || typeof schema !== "object") {
    return { valid: true, errors: [] };
  }
  validateNode(schema, args, "", errors, schema);
  if (errors.length === 0) return { valid: true, errors, args };
  return { valid: false, errors };
}

/**
 * Only for original model input, before execution gates or scheduling predicates.
 * `reshape` is the tool's own `reshapeModelArgs`; it runs only when strict
 * validation and the JSON container repair both fail, gets the untouched
 * input, and its result must pass the same strict validation.
 */
export function normalizeModelToolArgs(
  schema: Record<string, unknown> | undefined,
  args: Record<string, unknown>,
  reshape?: Tool["reshapeModelArgs"],
): SchemaValidationResult {
  const strict = validateToolArgs(schema, args);
  if (strict.valid || !schema) return strict;
  const errors = strict.errors;
  const coercedPaths: string[] = [];
  const candidate = normalizeContainerArgs(schema, args, "", schema, coercedPaths);
  if (coercedPaths.length > 0 && isRecord(candidate)) {
    const retryErrors: SchemaValidationError[] = [];
    validateNode(schema, candidate, "", retryErrors, schema);
    if (retryErrors.length === 0) {
      return { valid: true, errors: [], args: candidate, coercedPaths };
    }
  }
  const reshaped = reshapeOrDecline(reshape, args);
  if (reshaped !== undefined && validateToolArgs(schema, reshaped).valid) {
    return { valid: true, errors: [], args: reshaped, reshaped: true };
  }
  // Failed repair must retain the original diagnostics, including their paths.
  return { valid: false, errors };
}

/** A throwing, identity or non-object reshape declines. */
function reshapeOrDecline(
  reshape: Tool["reshapeModelArgs"],
  args: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (reshape === undefined) return undefined;
  try {
    const reshaped = reshape(args);
    return isRecord(reshaped) && reshaped !== args ? reshaped : undefined;
  } catch {
    return undefined;
  }
}

/** Types admitted by the keywords our validator walks. Unknown means unrestricted. */
function admittedTypes(schema: SchemaObj, root: SchemaObj): Set<string> | undefined {
  const resolved = resolveRef(schema, root);
  const type = resolved["type"];
  let types = typeof type === "string" ? new Set([type])
    : Array.isArray(type) ? new Set(type.filter((t): t is string => typeof t === "string"))
    : undefined;
  const intersect = (other: Set<string> | undefined) => {
    if (other !== undefined) {
      types = types === undefined ? other : new Set([...types].filter((t) => other.has(t)));
    }
  };
  for (const key of ["anyOf", "oneOf"] as const) {
    const branches = resolved[key];
    if (!Array.isArray(branches) || branches.length === 0) continue;
    const alternatives = branches.filter(isRecord).map((sub) => admittedTypes(sub, root));
    if (alternatives.every((set) => set !== undefined)) {
      intersect(new Set(alternatives.flatMap((set) => [...set!])));
    }
  }
  const allOf = resolved["allOf"];
  if (Array.isArray(allOf)) {
    for (const sub of allOf) if (isRecord(sub)) intersect(admittedTypes(sub, root));
  }
  return types;
}

/** Copy on write, traversing only schema locations already handled by validateNode. */
function normalizeContainerArgs(
  schema: SchemaObj,
  value: unknown,
  path: string,
  root: SchemaObj,
  paths: string[],
): unknown {
  const originalErrors: SchemaValidationError[] = [];
  validateNode(schema, value, path, originalErrors, root);
  if (originalErrors.length === 0) return value;
  const resolved = resolveRef(schema, root);
  if (typeof value === "string") {
    const types = admittedTypes(schema, root);
    if (!types || types.has("string")) return value;
    try {
      const parsed: unknown = JSON.parse(value);
      const type = schemaTypeOf(parsed);
      if ((type !== "array" && type !== "object") || !types.has(type)) return value;
      value = parsed;
      paths.push(path);
    } catch {
      return value;
    }
  }
  // Parent compositions can admit strings through sibling property schemas,
  // including references and unconstrained alternatives. Until we can prove
  // admission at each child path, decline nested repair across this boundary.
  if (["anyOf", "oneOf", "allOf"].some((key) => Array.isArray(resolved[key]))) {
    return value;
  }
  if (Array.isArray(value) && isRecord(resolved["items"])) {
    const items = resolved["items"];
    const original = value;
    const next = original.map((item, i) =>
      normalizeContainerArgs(items, item, joinPath(path, i), root, paths),
    );
    return next.some((item, i) => item !== original[i]) ? next : original;
  }
  if (isRecord(value)) {
    if (typeof resolved["type"] === "string" && resolved["type"] !== "object") return value;
    const properties = isRecord(resolved["properties"]) ? resolved["properties"] : {};
    let result = value;
    for (const key of Object.keys(value)) {
      const sub = Object.hasOwn(properties, key) ? properties[key] : resolved["additionalProperties"];
      if (!isRecord(sub)) continue;
      const next = normalizeContainerArgs(sub, value[key], joinPath(path, key), root, paths);
      if (next !== value[key]) {
        if (result === value) result = { ...value };
        Object.defineProperty(result, key, {
          value: next, enumerable: true, writable: true, configurable: true,
        });
      }
    }
    return result;
  }
  return value;
}

function validateNode(
  schema: SchemaObj,
  value: unknown,
  path: string,
  errors: SchemaValidationError[],
  rootSchema: SchemaObj,
): void {
  const resolved = resolveRef(schema, rootSchema);

  const anyOf = resolved["anyOf"];
  if (Array.isArray(anyOf) && anyOf.length > 0) {
    let anyValid = false;
    for (const sub of anyOf) {
      if (!isRecord(sub)) continue;
      const subErrors: SchemaValidationError[] = [];
      validateNode(sub, value, path, subErrors, rootSchema);
      if (subErrors.length === 0) {
        anyValid = true;
        break;
      }
    }
    if (!anyValid) {
      errors.push({
        path: path || "(root)",
        message: "value does not match any of the expected schemas",
        category: "other",
      });
      return;
    }
  }

  const oneOf = resolved["oneOf"];
  if (Array.isArray(oneOf) && oneOf.length > 0) {
    let matched = 0;
    for (const sub of oneOf) {
      if (!isRecord(sub)) continue;
      const subErrors: SchemaValidationError[] = [];
      validateNode(sub, value, path, subErrors, rootSchema);
      if (subErrors.length === 0) matched += 1;
    }
    if (matched !== 1) {
      errors.push({
        path: path || "(root)",
        message:
          matched === 0
            ? "value does not match any oneOf branch"
            : "value matches more than one oneOf branch",
        category: "other",
      });
      return;
    }
  }

  const allOf = resolved["allOf"];
  if (Array.isArray(allOf) && allOf.length > 0) {
    for (const sub of allOf) {
      if (!isRecord(sub)) continue;
      validateNode(sub, value, path, errors, rootSchema);
    }
  }

  if ("const" in resolved) {
    const constVal = resolved["const"];
    if (!deepEq(value, constVal)) {
      errors.push({
        path: path || "(root)",
        message: `value must equal ${JSON.stringify(constVal)}`,
        category: "other",
      });
      return;
    }
  }

  const declaredType = resolved["type"];
  if (declaredType !== undefined) {
    const actual = schemaTypeOf(value);
    if (typeof declaredType === "string") {
      if (!typeMatches(declaredType, actual)) {
        errors.push({
          path: path || "(root)",
          message: `expected ${declaredType}, got ${actual}`,
          category: "type",
          expected: declaredType,
          received: actual,
        });
        return;
      }
    } else if (Array.isArray(declaredType)) {
      if (
        !declaredType.some(
          (t) => typeof t === "string" && typeMatches(t, actual),
        )
      ) {
        const expected = declaredType
          .filter((t) => typeof t === "string")
          .join(" | ");
        errors.push({
          path: path || "(root)",
          message: `expected one of ${expected}, got ${actual}`,
          category: "type",
          expected,
          received: actual,
        });
        return;
      }
    }
  }

  const enumVals = resolved["enum"];
  if (Array.isArray(enumVals) && enumVals.length > 0) {
    if (!enumVals.some((v) => deepEq(v, value))) {
      errors.push({
        path: path || "(root)",
        message: "value not in enum",
        category: "other",
      });
      return;
    }
  }

  const format = resolved["format"];
  if (typeof format === "string") {
    if (typeof value !== "string") {
      errors.push({
        path: path || "(root)",
        message: `expected ${format}-formatted string, got ${schemaTypeOf(value)}`,
        category: "type",
        expected: "string",
        received: schemaTypeOf(value),
      });
      return;
    }
  }

  if (Array.isArray(value)) {
    validateArray(resolved, value, path, errors, rootSchema);
    return;
  }
  if (isRecord(value)) {
    validateObject(resolved, value, path, errors, rootSchema);
    return;
  }
  if (typeof value === "string") {
    const minLen = resolved["minLength"];
    const maxLen = resolved["maxLength"];
    if (typeof minLen === "number" && value.length < minLen) {
      errors.push({
        path: path || "(root)",
        message: `string too short (min ${minLen})`,
        category: "other",
      });
    }
    if (typeof maxLen === "number" && value.length > maxLen) {
      errors.push({
        path: path || "(root)",
        message: `string too long (max ${maxLen})`,
        category: "other",
      });
    }
    return;
  }
  if (typeof value === "number" || typeof value === "bigint") {
    const min = resolved["minimum"];
    const max = resolved["maximum"];
    const num = typeof value === "bigint" ? Number(value) : value;
    if (typeof min === "number" && num < min) {
      errors.push({
        path: path || "(root)",
        message: `value below minimum (${min})`,
        category: "other",
      });
    }
    if (typeof max === "number" && num > max) {
      errors.push({
        path: path || "(root)",
        message: `value above maximum (${max})`,
        category: "other",
      });
    }
  }
}

function validateArray(
  schema: SchemaObj,
  value: ReadonlyArray<unknown>,
  path: string,
  errors: SchemaValidationError[],
  rootSchema: SchemaObj,
): void {
  const items = schema["items"];
  if (isRecord(items)) {
    for (let i = 0; i < value.length; i += 1) {
      validateNode(items, value[i], joinPath(path, i), errors, rootSchema);
    }
  }
  const minItems = schema["minItems"];
  if (typeof minItems === "number" && value.length < minItems) {
    errors.push({
      path: path || "(root)",
      message: `array has fewer than ${minItems} items`,
      category: "other",
    });
  }
  const maxItems = schema["maxItems"];
  if (typeof maxItems === "number" && value.length > maxItems) {
    errors.push({
      path: path || "(root)",
      message: `array has more than ${maxItems} items`,
      category: "other",
    });
  }
}

function validateObject(
  schema: SchemaObj,
  obj: SchemaObj,
  path: string,
  errors: SchemaValidationError[],
  rootSchema: SchemaObj,
): void {
  const declaredType = schema["type"];
  if (typeof declaredType === "string" && declaredType !== "object") return;

  // Presence means an own key. `key in obj` also finds inherited ones, so a
  // plain object would satisfy a required `constructor` or `__proto__` and
  // have an absent optional one validated against Object.prototype's value.
  const required = schema["required"];
  if (Array.isArray(required)) {
    for (const key of required) {
      if (typeof key !== "string") continue;
      if (!Object.hasOwn(obj, key)) {
        errors.push({
          path: joinPath(path, key),
          message: "missing required field",
          category: "missing",
        });
      }
    }
  }
  const properties = schema["properties"];
  const declaredProps = new Set<string>();
  if (properties && typeof properties === "object") {
    const propMap = properties as Record<string, unknown>;
    for (const [key, sub] of Object.entries(propMap)) {
      declaredProps.add(key);
      if (!Object.hasOwn(obj, key)) continue;
      if (!isRecord(sub)) continue;
      validateNode(sub, obj[key], joinPath(path, key), errors, rootSchema);
    }
  }
  const additional = schema["additionalProperties"];
  if (additional === false) {
    for (const key of Object.keys(obj)) {
      if (!declaredProps.has(key)) {
        errors.push({
          path: joinPath(path, key),
          message: "unexpected field",
          category: "unexpected_key",
        });
      }
    }
  } else if (isRecord(additional)) {
    for (const [key, val] of Object.entries(obj)) {
      if (declaredProps.has(key)) continue;
      validateNode(additional, val, joinPath(path, key), errors, rootSchema);
    }
  }
}

function deepEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) if (!deepEq(a[i], b[i])) return false;
    return true;
  }
  if (isRecord(a) && isRecord(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (const k of ka) if (!deepEq(a[k], b[k])) return false;
    return true;
  }
  return false;
}

const AGENC_INTERNAL_ARG_PREFIX = "__agenc";

/**
 * The copy is built from own data properties. Assigning keys onto `{}` would
 * turn a model's JSON `__proto__` key into the copy's prototype, hiding it
 * from `additionalProperties: false` and every other shape check.
 */
export function stripAgenCInternalArgsForValidation(
  input: Record<string, unknown>,
): Record<string, unknown> {
  let needed = false;
  for (const key of Object.keys(input)) {
    if (key.startsWith(AGENC_INTERNAL_ARG_PREFIX)) {
      needed = true;
      break;
    }
  }
  if (!needed) return input;
  return Object.fromEntries(
    Object.entries(input).filter(
      ([key]) => !key.startsWith(AGENC_INTERNAL_ARG_PREFIX),
    ),
  );
}
