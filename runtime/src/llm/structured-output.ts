/**
 * Structured-output + capability helpers shared by provider adapters and
 * planner / verifier flows.
 *
 * xAI MCP source of truth:
 * - Structured outputs are supported by all language models.
 * - Structured outputs with tools are only supported by the Grok 4 family.
 * - `reasoning_effort` is not supported by `grok-4.20` or `grok-4-1-fast`.
 *   Per xAI docs (developers/model-capabilities/text/reasoning), the
 *   ONLY model that accepts a `reasoning` parameter is
 *   `grok-4.20-multi-agent` — and there it controls agent count, not
 *   thinking depth. Sending `reasoning_effort` on any other current
 *   Grok 4 model returns an API error.
 *
 * @module
 */

import type {
  LLMStructuredOutputResult,
  LLMStructuredOutputSchema,
} from "./types.js";

export function supportsXaiStructuredOutputsWithTools(
  model: string | undefined,
): boolean {
  if (typeof model !== "string") return false;
  return /^grok-4(?:[.-]|$)/i.test(model.trim());
}

/**
 * Returns true when the xAI model accepts the `reasoning_effort`
 * request parameter. Only `grok-4.20-multi-agent*` variants accept it.
 *
 * All other Grok 4 reasoning models reason automatically and reject
 * the parameter with an API error; non-reasoning Grok 4 models
 * (`*-non-reasoning`) naturally reject it too.
 */
export function supportsXaiReasoningEffortParam(
  model: string | undefined,
): boolean {
  if (typeof model !== "string") return false;
  return /^grok-4[.-]20-multi-agent/i.test(model.trim());
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateStructuredValue(
  value: unknown,
  schema: Record<string, unknown> | undefined,
  path = "$",
): string | undefined {
  if (!schema) {
    return undefined;
  }
  const schemaType = typeof schema.type === "string" ? schema.type : undefined;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    const matched = schema.enum.some((entry) => JSON.stringify(entry) === JSON.stringify(value));
    if (!matched) {
      return `${path} must match one of the schema enum values`;
    }
  }
  if (!schemaType) {
    return undefined;
  }
  switch (schemaType) {
    case "object": {
      if (!isPlainObject(value)) {
        return `${path} must be an object`;
      }
      const properties = isPlainObject(schema.properties)
        ? (schema.properties as Record<string, Record<string, unknown>>)
        : {};
      const required = Array.isArray(schema.required)
        ? schema.required.filter((entry): entry is string => typeof entry === "string")
        : [];
      for (const key of required) {
        if (!(key in value)) {
          return `${path}.${key} is required`;
        }
      }
      if (schema.additionalProperties === false) {
        for (const key of Object.keys(value)) {
          if (!(key in properties)) {
            return `${path}.${key} is not allowed by the schema`;
          }
        }
      }
      for (const [key, propertySchema] of Object.entries(properties)) {
        if (!(key in value)) {
          continue;
        }
        const error = validateStructuredValue(value[key], propertySchema, `${path}.${key}`);
        if (error) {
          return error;
        }
      }
      return undefined;
    }
    case "array": {
      if (!Array.isArray(value)) {
        return `${path} must be an array`;
      }
      const itemSchema = isPlainObject(schema.items)
        ? (schema.items as Record<string, unknown>)
        : undefined;
      if (!itemSchema) {
        return undefined;
      }
      for (let index = 0; index < value.length; index += 1) {
        const error = validateStructuredValue(value[index], itemSchema, `${path}[${index}]`);
        if (error) {
          return error;
        }
      }
      return undefined;
    }
    case "string":
      return typeof value === "string" ? undefined : `${path} must be a string`;
    case "number":
      return typeof value === "number" && Number.isFinite(value)
        ? undefined
        : `${path} must be a finite number`;
    case "integer":
      return typeof value === "number" && Number.isInteger(value)
        ? undefined
        : `${path} must be an integer`;
    case "boolean":
      return typeof value === "boolean" ? undefined : `${path} must be a boolean`;
    case "null":
      return value === null ? undefined : `${path} must be null`;
    default:
      return undefined;
  }
}

export function parseStructuredOutputText(
  rawText: string,
  schemaName?: string,
  schema?: LLMStructuredOutputSchema["schema"],
): LLMStructuredOutputResult {
  const trimmed = rawText.trim();
  if (trimmed.length === 0) {
    throw new Error(
      `${schemaName ?? "structured_output"} returned an empty structured payload`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    throw new Error(
      `${schemaName ?? "structured_output"} returned invalid JSON instead of a schema object`,
    );
  }
  if (!isPlainObject(parsed)) {
    throw new Error(
      `${schemaName ?? "structured_output"} must return a top-level JSON object`,
    );
  }
  const validationError = validateStructuredValue(parsed, schema, "$");
  if (validationError) {
    throw new Error(
      `${schemaName ?? "structured_output"} violated its JSON schema: ${validationError}`,
    );
  }
  return {
    type: "json_schema",
    ...(schemaName ? { name: schemaName } : {}),
    rawText,
    parsed,
  };
}

