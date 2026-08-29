import { sanitizeSystemReminderContent } from "../prompts/attachments/system-reminder-sanitizer.js";
import { recursivelySanitizeUnicode } from "../utils/sanitization.js";

const CONTROL_CHARACTER_PATTERN =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu;
export const MAX_MCP_SANITIZATION_NODES = 100_000;
export const MAX_MCP_SANITIZATION_BYTES = 5 * 1024 * 1024;
const SANITIZATION_BUDGET_EXCEEDED = Symbol("sanitization-budget-exceeded");
const SANITIZATION_KEY_COLLISION = Symbol("sanitization-key-collision");

export interface McpSanitizationBudget {
  remainingNodes: number;
  remainingBytes: number;
}

export function createMcpSanitizationBudget(
  maxBytes = MAX_MCP_SANITIZATION_BYTES,
  maxNodes = MAX_MCP_SANITIZATION_NODES,
): McpSanitizationBudget {
  return {
    remainingNodes: Math.max(0, Math.floor(maxNodes)),
    remainingBytes: Math.max(0, Math.floor(maxBytes)),
  };
}

export function consumeMcpSanitizationBudget(
  budget: McpSanitizationBudget,
  byteCount: number,
  nodeCount = 1,
): boolean {
  const bytes = Math.max(0, Math.floor(byteCount));
  const nodes = Math.max(0, Math.floor(nodeCount));
  if (bytes > budget.remainingBytes || nodes > budget.remainingNodes) {
    return false;
  }
  budget.remainingBytes -= bytes;
  budget.remainingNodes -= nodes;
  return true;
}

/**
 * Repair malformed UTF-16 before normalization. `Buffer.from()` silently
 * replaces lone surrogates too, but doing it here keeps every rendered and
 * structured representation deterministic.
 */
export function repairMcpUnpairedSurrogates(value: string): string {
  let parts: string[] | undefined;
  let segmentStart = 0;

  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1;
        continue;
      }
    } else if (codeUnit < 0xdc00 || codeUnit > 0xdfff) {
      continue;
    }

    parts ??= [];
    parts.push(value.slice(segmentStart, index), "\ufffd");
    segmentStart = index + 1;
  }

  if (parts === undefined) return value;
  parts.push(value.slice(segmentStart));
  return parts.join("");
}

/** Sanitize untrusted MCP text while preserving ordinary whitespace. */
export function sanitizeMcpOutputText(value: string): string {
  const repaired = repairMcpUnpairedSurrogates(value);
  const unicodeSafe = recursivelySanitizeUnicode(repaired);
  return sanitizeSystemReminderContent(unicodeSafe).replace(
    CONTROL_CHARACTER_PATTERN,
    " ",
  );
}

/**
 * Recursively sanitize JSON-compatible data supplied by an MCP server.
 * Cycles and exotic object prototypes are rejected rather than traversed.
 */
export function sanitizeMcpJsonValue(
  value: unknown,
  maxDepth = 64,
  budget: McpSanitizationBudget = createMcpSanitizationBudget(),
): unknown {
  const ancestors = new Set<object>();

  const charge = (valueBytes: number): void => {
    if (!consumeMcpSanitizationBudget(budget, valueBytes, 0)) {
      throw SANITIZATION_BUDGET_EXCEEDED;
    }
  };

  const visit = (candidate: unknown, depth: number): unknown => {
    if (!consumeMcpSanitizationBudget(budget, 0)) {
      throw SANITIZATION_BUDGET_EXCEEDED;
    }
    if (typeof candidate === "string") {
      if (candidate.length > budget.remainingBytes) {
        throw SANITIZATION_BUDGET_EXCEEDED;
      }
      const rawBytes = Buffer.byteLength(candidate, "utf8");
      if (rawBytes > budget.remainingBytes) {
        throw SANITIZATION_BUDGET_EXCEEDED;
      }
      const sanitized = sanitizeMcpOutputText(candidate);
      charge(Buffer.byteLength(JSON.stringify(sanitized), "utf8"));
      return sanitized;
    }
    if (
      candidate === null ||
      typeof candidate === "boolean" ||
      typeof candidate === "number"
    ) {
      const primitive = typeof candidate === "number" && !Number.isFinite(candidate)
        ? null
        : candidate;
      charge(Buffer.byteLength(JSON.stringify(primitive), "utf8"));
      return primitive;
    }
    if (depth > maxDepth || typeof candidate !== "object") return undefined;
    if (ancestors.has(candidate)) return undefined;

    ancestors.add(candidate);
    try {
      if (Array.isArray(candidate)) {
        if (candidate.length > budget.remainingNodes) {
          throw SANITIZATION_BUDGET_EXCEEDED;
        }
        charge(2 + Math.max(0, candidate.length - 1));
        const output: unknown[] = [];
        for (const item of candidate) {
          output.push(visit(item, depth + 1) ?? null);
        }
        return output;
      }

      const prototype = Object.getPrototypeOf(candidate);
      if (prototype !== Object.prototype && prototype !== null) return undefined;
      const output: Record<string, unknown> = {};
      charge(2);
      let retainedFieldCount = 0;
      for (const rawKey in candidate) {
        if (!Object.prototype.hasOwnProperty.call(candidate, rawKey)) continue;
        const descriptor = Object.getOwnPropertyDescriptor(candidate, rawKey);
        if (descriptor === undefined || !("value" in descriptor)) {
          return undefined;
        }
        if (rawKey.length > budget.remainingBytes) {
          throw SANITIZATION_BUDGET_EXCEEDED;
        }
        const key = sanitizeMcpOutputText(rawKey);
        const sanitized = visit(descriptor.value, depth + 1);
        if (key.length === 0 || sanitized === undefined) continue;
        // Distinct untrusted keys can normalize to the same model-visible key.
        // Reject the whole object instead of silently selecting one value.
        if (Object.prototype.hasOwnProperty.call(output, key)) {
          throw SANITIZATION_KEY_COLLISION;
        }
        charge(
          Buffer.byteLength(JSON.stringify(key), "utf8") +
            1 +
            (retainedFieldCount > 0 ? 1 : 0),
        );
        Object.defineProperty(output, key, {
          configurable: true,
          enumerable: true,
          writable: true,
          value: sanitized,
        });
        retainedFieldCount += 1;
      }
      return output;
    } finally {
      ancestors.delete(candidate);
    }
  };

  try {
    return visit(value, 0);
  } catch (error) {
    if (error === SANITIZATION_BUDGET_EXCEEDED) return undefined;
    return undefined;
  }
}

/** Return a UTF-8-safe prefix whose encoded size does not exceed maxBytes. */
export function truncateMcpUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (
    value.length <= maxBytes &&
    Buffer.byteLength(value, "utf8") <= maxBytes
  ) {
    return value;
  }

  let bytes = 0;
  let endIndex = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maxBytes) break;
    bytes += characterBytes;
    endIndex += character.length;
  }
  return value.slice(0, endIndex);
}
