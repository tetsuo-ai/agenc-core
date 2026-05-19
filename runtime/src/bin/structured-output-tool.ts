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

const STRUCTURED_OUTPUT_TOOL_NAME = "StructuredOutput";

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
