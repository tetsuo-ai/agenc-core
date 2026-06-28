/**
 * Tool parameter-schema normalization for the OpenAI function-calling wire.
 *
 * The OpenAI function-calling spec requires each tool's `parameters` JSON
 * schema to have an OBJECT root (`type: "object"`). Lenient providers
 * (OpenAI/Codex) tolerate a root-level `anyOf`/`oneOf` union, but strict
 * OpenAI-compatible providers (x.ai grok, deepseek) reject it with:
 *
 *   400 "exec_command: tool parameter root must be an object type
 *        (root schema is an anyOf/oneOf union with a non-object branch)"
 *
 * This helper guarantees an object root for the schema PRESENTED to the
 * provider. It does NOT touch tool execution or the tools' real input
 * schemas — execution-side validation (src/tools/execution.ts) still handles
 * the original `anyOf`/`oneOf` conditional shape.
 */

import { isRecord } from "./record.js";

export interface NormalizedToolParamSchema {
  /** Object-rooted JSON schema safe to send to strict providers. */
  schema: Record<string, unknown>;
  /**
   * `true` when the root was already a plain object and may be sent with
   * strict mode; `false` when the root was a union/non-object and was
   * rewritten into a permissive object (fields are conditional, so the
   * provider must NOT be told they are all required).
   */
  strictEligible: boolean;
}

const UNION_KEYS = ["anyOf", "oneOf"] as const;

function hasRootUnion(record: Record<string, unknown>): boolean {
  return UNION_KEYS.some((key) => Array.isArray(record[key]));
}

/**
 * Collect `properties` records from every object-typed branch of a union, in
 * order, so later branches win on key collisions (matching how the original
 * schemas list a canonical branch first but accept alias fields too).
 */
function mergeBranchProperties(
  branches: unknown[],
  into: Record<string, unknown>,
): void {
  for (const branch of branches) {
    if (!isRecord(branch)) continue;
    if (branch.type !== undefined && branch.type !== "object") continue;
    const props = branch.properties;
    if (isRecord(props)) {
      for (const [key, value] of Object.entries(props)) {
        into[key] = value;
      }
    }
  }
}

/**
 * Guarantee an object-rooted parameter schema for the OpenAI function-calling
 * wire.
 *
 * - Already an object root (`type: "object"`, or has `properties` and no
 *   root-level `anyOf`/`oneOf`): returned unchanged, `strictEligible: true`.
 * - Root has `anyOf`/`oneOf`: merge `properties` from all object-typed
 *   branches (plus any properties carried on the root itself) into a single
 *   `{ type: "object", properties, additionalProperties: true }`. The merged
 *   props are NOT marked required and `strictEligible` is `false`.
 * - Any other non-object root: `{ type: "object", properties: {},
 *   additionalProperties: true }`, `strictEligible: false`.
 */
export function normalizeToolParamSchema(
  schema: unknown,
): NormalizedToolParamSchema {
  if (!isRecord(schema)) {
    return {
      schema: { type: "object", properties: {}, additionalProperties: true },
      strictEligible: false,
    };
  }

  const isObjectRoot = schema.type === "object";
  const hasUnion = hasRootUnion(schema);

  // Already a clean object root (no root-level union): pass through unchanged.
  if (isObjectRoot && !hasUnion) {
    return { schema, strictEligible: true };
  }
  if (!isObjectRoot && isRecord(schema.properties) && !hasUnion) {
    return { schema, strictEligible: true };
  }

  // Root-level union (possibly alongside its own object body, as exec_command
  // has): merge object-branch properties into a permissive object root.
  if (hasUnion) {
    const merged: Record<string, unknown> = {};
    // Carry the root's own properties first.
    if (isRecord(schema.properties)) {
      for (const [key, value] of Object.entries(schema.properties)) {
        merged[key] = value;
      }
    }
    for (const key of UNION_KEYS) {
      const branches = schema[key];
      if (Array.isArray(branches)) {
        mergeBranchProperties(branches, merged);
      }
    }

    const normalized: Record<string, unknown> = {
      type: "object",
      properties: merged,
      additionalProperties: true,
    };
    if (typeof schema.description === "string") {
      normalized.description = schema.description;
    }
    return { schema: normalized, strictEligible: false };
  }

  // Any other non-object root: permissive empty object.
  const normalized: Record<string, unknown> = {
    type: "object",
    properties: {},
    additionalProperties: true,
  };
  if (typeof schema.description === "string") {
    normalized.description = schema.description;
  }
  return { schema: normalized, strictEligible: false };
}
