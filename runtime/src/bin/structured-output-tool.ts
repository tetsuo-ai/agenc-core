/**
 * `StructuredOutput` model-facing tool.
 *
 * Port of agenc `src/tools/SyntheticOutputTool/SyntheticOutputTool.ts`,
 * translated to AgenC's flat `Tool` adapter (no `buildTool`,
 * `lazySchema`, or `isOpenWorld`).
 *
 * Two surfaces:
 *
 *   - {@link createStructuredOutputTool} — base tool with an
 *     unconstrained `passthrough` input. Useful when the caller wants
 *     the model to emit structured JSON but does not have a schema.
 *   - {@link createStructuredOutputToolForSchema} — dynamic factory
 *     that, given a JSON schema, returns a tool whose `inputSchema` is
 *     that JSON schema and whose `execute` validates against an
 *     AJV-compiled validator. Cached by schema-object identity via
 *     `WeakMap` so workflow scripts that pass the same schema object
 *     dozens of times don't pay JIT recompile cost on every call
 *     (mirrors agenc's identity cache).
 *
 * @module
 */

import { Ajv, type ErrorObject } from "ajv";
import type { Tool, ToolResult } from "../tools/types.js";
import { safeStringify } from "../tools/types.js";

export const STRUCTURED_OUTPUT_TOOL_NAME = "StructuredOutput";

const STRUCTURED_OUTPUT_DESCRIPTION =
  "Return your final response in the requested structured format. Call this tool exactly once at the end of your response to provide the structured output. The runtime validates the payload against the configured JSON schema (when one is bound) and surfaces any schema-mismatch errors back to you so you can correct the shape and retry.";

function toolMetadata(): Tool["metadata"] {
  return {
    family: "structured",
    source: "builtin",
    hiddenByDefault: false,
    mutating: false,
    deferred: true,
    keywords: ["structured", "output", "schema", "json"],
    preferredProfiles: ["coding", "operator", "general"],
  };
}

function jsonResult(content: unknown, isError?: boolean): ToolResult {
  return {
    content: safeStringify(content),
    ...(isError ? { isError: true } : {}),
  };
}

/**
 * Base passthrough tool. Accepts any object input, echoes it back as
 * `structured_output`. Registered into the catalog so the model has a
 * default name to call when the harness has not bound a specific
 * schema.
 */
export function createStructuredOutputTool(): Tool {
  return {
    name: STRUCTURED_OUTPUT_TOOL_NAME,
    description: STRUCTURED_OUTPUT_DESCRIPTION,
    metadata: toolMetadata(),
    isReadOnly: true,
    recoveryCategory: "idempotent",
    inputSchema: {
      type: "object",
      additionalProperties: true,
    },
    execute: async (args) => {
      return jsonResult({
        message: "Structured output provided successfully",
        structured_output: args,
      });
    },
  };
}

export interface StructuredOutputToolBuildSuccess {
  readonly tool: Tool;
}

export interface StructuredOutputToolBuildError {
  readonly error: string;
}

export type StructuredOutputToolBuildResult =
  | StructuredOutputToolBuildSuccess
  | StructuredOutputToolBuildError;

// AJV runtime validator factory; lazy-initialized so the dep cost is
// only paid by callers that actually compile a schema. Mirrors
// agenc's per-call construction but cached at module scope.
let cachedAjv: Ajv | undefined;
function getAjv(): Ajv {
  if (cachedAjv) return cachedAjv;
  cachedAjv = new Ajv({ allErrors: true, strict: false });
  return cachedAjv;
}

// WeakMap keyed on the caller's schema object reference. Workflow
// callers that pass the same `BUGS_SCHEMA` literal dozens of times
// reuse the compiled validator and the built tool entry. Mirrors
// agenc `toolCache` in `SyntheticOutputTool.ts:109`.
const toolCache = new WeakMap<object, StructuredOutputToolBuildResult>();

/**
 * Build a `StructuredOutput` tool whose `inputSchema` is the provided
 * JSON schema. The compiled AJV validator runs on every call; on
 * mismatch the tool returns an error result describing the violations
 * (path + message) so the model can correct and retry.
 */
export function createStructuredOutputToolForSchema(
  jsonSchema: Record<string, unknown>,
): StructuredOutputToolBuildResult {
  const cached = toolCache.get(jsonSchema);
  if (cached) return cached;

  const built = buildStructuredOutputToolForSchema(jsonSchema);
  toolCache.set(jsonSchema, built);
  return built;
}

function buildStructuredOutputToolForSchema(
  jsonSchema: Record<string, unknown>,
): StructuredOutputToolBuildResult {
  try {
    const ajv = getAjv();
    if (!ajv.validateSchema(jsonSchema)) {
      return { error: ajv.errorsText(ajv.errors) };
    }
    const validate = ajv.compile(jsonSchema);
    const tool: Tool = {
      name: STRUCTURED_OUTPUT_TOOL_NAME,
      description: STRUCTURED_OUTPUT_DESCRIPTION,
      metadata: toolMetadata(),
      isReadOnly: true,
      recoveryCategory: "idempotent",
      inputSchema: jsonSchema,
      execute: async (args) => {
        if (!validate(args)) {
          const detail = (validate.errors ?? [])
            .map(
              (e: ErrorObject) =>
                `${e.instancePath || "/"}: ${e.message ?? "invalid"}`,
            )
            .join("; ");
          return jsonResult(
            {
              error: "Output does not match required schema",
              detail,
            },
            true,
          );
        }
        return jsonResult({
          message: "Structured output provided successfully",
          structured_output: args,
        });
      },
    };
    return { tool };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
