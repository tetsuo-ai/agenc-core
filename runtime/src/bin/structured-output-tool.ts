/**
 * `StructuredOutput` model-facing tool.
 *
 * Port of agenc `src/tools/SyntheticOutputTool/SyntheticOutputTool.ts`,
 * translated to AgenC's flat `Tool` adapter (no `buildTool`,
 * `lazySchema`, or `isOpenWorld`).
 *
 * `createStructuredOutputTool` provides the model with a default
 * passthrough structured-output tool when the harness has not bound a
 * specific schema.
 *
 * @module
 */

import type { Tool, ToolResult } from "../tools/types.js";
import { safeStringify } from "../tools/types.js";
import { Ajv, type ValidateFunction } from "ajv";

export const STRUCTURED_OUTPUT_TOOL_NAME = "StructuredOutput";

const STRUCTURED_OUTPUT_DESCRIPTION =
  "Return your final response in the requested structured format. Call this tool exactly once at the end of your response to provide the structured output. The runtime validates the payload against the configured JSON schema (when one is bound) and surfaces any schema-mismatch errors back to you so you can correct the shape and retry.";

function toolMetadata(opts?: { readonly visible?: boolean }): Tool["metadata"] {
  return {
    family: "structured",
    source: "builtin",
    hiddenByDefault: false,
    mutating: false,
    deferred: opts?.visible !== true,
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

type StructuredOutputToolBuildResult =
  | { readonly tool: Tool }
  | { readonly error: string };

const schemaToolCache = new WeakMap<object, StructuredOutputToolBuildResult>();
const ajv = new Ajv({ allErrors: true, strict: false });

function formatSchemaErrors(validate: ValidateFunction): string {
  return ajv.errorsText(validate.errors, { separator: "\n" });
}

/**
 * Base passthrough tool. Accepts any object input, echoes it back as
 * `structured_output`. Registered into the catalog so the model has a
 * default name to call when the harness has not bound a specific
 * schema.
 *
 * Deferred by default (discoverable via tool search). Pass
 * `visible: true` when the session is configured with an output schema so
 * the tool is advertised immediately — programmatic/SDK callers that start
 * a session WITH a schema must not need a discovery round-trip.
 */
export function createStructuredOutputTool(opts?: {
  readonly visible?: boolean;
}): Tool {
  return {
    name: STRUCTURED_OUTPUT_TOOL_NAME,
    description: STRUCTURED_OUTPUT_DESCRIPTION,
    metadata: toolMetadata(opts),
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

export function createStructuredOutputToolForSchema(
  schema: Record<string, unknown>,
): StructuredOutputToolBuildResult {
  const cached = schemaToolCache.get(schema);
  if (cached !== undefined) return cached;

  let validate: ValidateFunction;
  try {
    validate = ajv.compile(schema);
  } catch (error) {
    const result = {
      error: error instanceof Error ? error.message : String(error),
    };
    schemaToolCache.set(schema, result);
    return result;
  }

  // A bound schema means the session explicitly asked for structured
  // output, so the schema-bound tool is always advertised (non-deferred).
  const tool: Tool = {
    ...createStructuredOutputTool({ visible: true }),
    inputSchema: schema,
    execute: async (args) => {
      if (!validate(args)) {
        return jsonResult(
          {
            error: "Output does not match required schema",
            detail: formatSchemaErrors(validate),
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
  const result = { tool };
  schemaToolCache.set(schema, result);
  return result;
}
