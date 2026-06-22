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
  LLMStructuredOutputRequest,
  LLMStructuredOutputResult,
  LLMStructuredOutputSchema,
} from "./types.js";
import { isRecord } from "../utils/record.js";

export const ANTHROPIC_STRUCTURED_OUTPUT_TOOL_NAME = "agenc_structured_output";

export type ProviderStructuredOutputMode =
  | "native_text_format"
  | "chat_response_format"
  | "anthropic_tool_use"
  | "unsupported";

export function isStructuredOutputRequested(
  request: LLMStructuredOutputRequest | undefined,
): boolean {
  return request?.enabled !== false && request?.schema !== undefined;
}

export function supportsXaiStructuredOutputs(
  model: string | undefined,
): boolean {
  if (typeof model !== "string") return false;
  const normalized = model.trim().toLowerCase();
  if (normalized.length === 0) return false;
  return !normalized.startsWith("grok-imagine");
}

export function supportsXaiStructuredOutputsWithTools(
  model: string | undefined,
): boolean {
  if (typeof model !== "string") return false;
  return /^grok-4(?:[.-]|$)/i.test(model.trim());
}

export function supportsOpenAIStructuredOutputs(
  model: string | undefined,
): boolean {
  if (typeof model !== "string") return false;
  const normalized = model.trim().toLowerCase();
  if (normalized.length === 0) return false;
  return ![
    /(?:^|[/:])gpt-3\.5(?:$|[-_.:])/,
    /(?:^|[/:])gpt-4-turbo(?:$|[-_.:])/,
    /(?:^|[/:])gpt-4-(?:0613|0314|1106|0125)(?:$|[-_.:])/,
    /(?:^|[/:])text-(?:davinci|curie|babbage|ada)(?:$|[-_.:])/,
    /(?:^|[/:])(?:davinci|curie|babbage|ada)(?:$|[-_.:])/,
  ].some((pattern) => pattern.test(normalized));
}

export function supportsAnthropicStructuredOutputToolUse(
  model: string | undefined,
): boolean {
  return typeof model === "string" && model.trim().length > 0;
}

export function resolveProviderStructuredOutputMode(input: {
  readonly provider: string | undefined;
  readonly model: string | undefined;
  readonly api?: "responses" | "chat_completions" | "messages";
}): ProviderStructuredOutputMode {
  const provider = input.provider?.trim().toLowerCase();
  if (provider === "grok" || provider === "xai") {
    return supportsXaiStructuredOutputs(input.model)
      ? "native_text_format"
      : "unsupported";
  }
  if (provider === "openai") {
    if (!supportsOpenAIStructuredOutputs(input.model)) return "unsupported";
    return input.api === "chat_completions"
      ? "chat_response_format"
      : "native_text_format";
  }
  if (provider === "anthropic") {
    return supportsAnthropicStructuredOutputToolUse(input.model)
      ? "anthropic_tool_use"
      : "unsupported";
  }
  return "unsupported";
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
  // gaphunt3 #8: validate union combinators; without this a schema node lacking a
  // `type` keyword (anyOf/oneOf/allOf) was treated as unconstrained and silently passed.
  const branchSchemas = (key: string): Array<Record<string, unknown>> =>
    Array.isArray(schema[key])
      ? (schema[key] as unknown[]).filter((entry): entry is Record<string, unknown> =>
          isRecord(entry),
        )
      : [];
  const anyOf = branchSchemas("anyOf");
  if (anyOf.length > 0) {
    const matched = anyOf.some(
      (branch) => validateStructuredValue(value, branch, path) === undefined,
    );
    if (!matched) {
      return `${path} must match at least one schema in anyOf`;
    }
  }
  const oneOf = branchSchemas("oneOf");
  if (oneOf.length > 0) {
    const matchCount = oneOf.filter(
      (branch) => validateStructuredValue(value, branch, path) === undefined,
    ).length;
    if (matchCount !== 1) {
      return `${path} must match exactly one schema in oneOf`;
    }
  }
  const allOf = branchSchemas("allOf");
  for (const branch of allOf) {
    const error = validateStructuredValue(value, branch, path);
    if (error) {
      return error;
    }
  }
  if (!schemaType) {
    return undefined;
  }
  switch (schemaType) {
    case "object": {
      if (!isRecord(value)) {
        return `${path} must be an object`;
      }
      const properties = isRecord(schema.properties)
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
      const itemSchema = isRecord(schema.items)
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

function cloneJsonSchemaValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => cloneJsonSchemaValue(entry));
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      cloneJsonSchemaValue(entry),
    ]),
  );
}

// gaphunt3 #11: express an originally-optional field as nullable so OpenAI strict
// mode (every key required) does not force the model to fabricate a value.
function widenSchemaWithNull(
  propertySchema: Record<string, unknown>,
): Record<string, unknown> {
  const widened: Record<string, unknown> = { ...propertySchema };
  if (typeof widened.type === "string") {
    widened.type = widened.type === "null" ? widened.type : [widened.type, "null"];
    return widened;
  }
  if (Array.isArray(widened.type)) {
    widened.type = widened.type.includes("null")
      ? widened.type
      : [...widened.type, "null"];
    return widened;
  }
  for (const unionKey of ["anyOf", "oneOf"] as const) {
    if (Array.isArray(widened[unionKey])) {
      const branches = widened[unionKey] as unknown[];
      const hasNull = branches.some(
        (branch) => isRecord(branch) && branch.type === "null",
      );
      widened[unionKey] = hasNull ? branches : [...branches, { type: "null" }];
      return widened;
    }
  }
  return widened;
}

function enforceStrictSchemaValue(value: unknown): unknown {
  const cloned = cloneJsonSchemaValue(value);
  if (!isRecord(cloned)) {
    return cloned;
  }
  const record: Record<string, unknown> = { ...cloned };
  if (record.format === "uri") {
    delete record.format;
  }

  if (isRecord(record.properties)) {
    const properties: Record<string, unknown> = {};
    for (const [key, propertySchema] of Object.entries(record.properties)) {
      properties[key] = enforceStrictSchemaValue(propertySchema);
    }
    record.properties = properties;
  }

  if (isRecord(record.items) || Array.isArray(record.items)) {
    record.items = enforceStrictSchemaValue(record.items);
  }

  for (const unionKey of ["anyOf", "oneOf", "allOf"] as const) {
    if (Array.isArray(record[unionKey])) {
      record[unionKey] = (record[unionKey] as readonly unknown[]).map(
        (entry) => enforceStrictSchemaValue(entry),
      );
    }
  }

  if (record.type === "object" || isRecord(record.properties)) {
    // gaphunt3 #11: OpenAI strict mode requires every property in `required`, but
    // originally-optional fields must be expressed as nullable. Widen the type of
    // each property NOT in the author's `required` array to include "null" before
    // forcing all keys required, preserving the schema's optionality contract.
    const originalRequired = new Set(
      Array.isArray(record.required)
        ? record.required.filter((entry): entry is string => typeof entry === "string")
        : [],
    );
    if (isRecord(record.properties)) {
      for (const [key, propertySchema] of Object.entries(record.properties)) {
        if (!originalRequired.has(key) && isRecord(propertySchema)) {
          record.properties[key] = widenSchemaWithNull(propertySchema);
        }
      }
    }
    record.additionalProperties = false;
    record.required = isRecord(record.properties)
      ? Object.keys(record.properties)
      : [];
  }

  return record;
}

export function enforceStrictStructuredOutputSchema(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const enforced = enforceStrictSchemaValue(schema);
  return isRecord(enforced) ? enforced : {};
}

export function buildStructuredOutputTextFormat(
  request: LLMStructuredOutputRequest | undefined,
  defaultStrict = true,
): Record<string, unknown> | undefined {
  const schema = request?.schema;
  if (request?.enabled === false || !schema) {
    return undefined;
  }
  const strict = schema.strict ?? defaultStrict;
  return {
    type: schema.type,
    name: schema.name,
    schema: strict
      ? enforceStrictStructuredOutputSchema(schema.schema)
      : cloneJsonSchemaValue(schema.schema),
    strict,
  };
}

export function parseStructuredOutputValue(
  value: unknown,
  schemaName?: string,
  schema?: LLMStructuredOutputSchema["schema"],
): LLMStructuredOutputResult {
  if (!isRecord(value)) {
    throw new Error(
      `${schemaName ?? "structured_output"} must return a top-level JSON object`,
    );
  }
  const validationError = validateStructuredValue(value, schema, "$");
  if (validationError) {
    throw new Error(
      `${schemaName ?? "structured_output"} violated its JSON schema: ${validationError}`,
    );
  }
  return {
    type: "json_schema",
    ...(schemaName ? { name: schemaName } : {}),
    rawText: JSON.stringify(value),
    parsed: value,
  };
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
  if (!isRecord(parsed)) {
    throw new Error(
      `${schemaName ?? "structured_output"} must return a top-level JSON object`,
    );
  }
  const result = parseStructuredOutputValue(parsed, schemaName, schema);
  return {
    ...result,
    rawText,
  };
}
