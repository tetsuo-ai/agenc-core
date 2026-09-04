/**
 * Structured-output + capability helpers shared by provider adapters and
 * planner / verifier flows.
 *
 * xAI MCP source of truth:
 * - Structured outputs are supported by all language models.
 * - Structured outputs with tools are only supported by the Grok 4 family.
 * - `reasoning_effort` is supported by Grok 4.3, Grok 4.5, and Grok 4.6,
 *   where it controls reasoning depth, and by `grok-4.20-multi-agent`, where
 *   it controls agent count. Other Grok families remain fail-closed.
 *
 * @module
 */

import { Ajv, type ValidateFunction } from "ajv";
import type {
  LLMStructuredOutputRequest,
  LLMStructuredOutputResult,
  LLMStructuredOutputSchema,
} from "./types.js";
import { isRecord } from "../utils/record.js";
import { normalizeProviderIdentity } from "../provider-identity.js";
import { resolveModelCapabilityHints } from "./registry/model-catalog.js";

export const ANTHROPIC_STRUCTURED_OUTPUT_TOOL_NAME = "agenc_structured_output";

interface CompiledStructuredOutputValidator {
  readonly ajv: Ajv;
  readonly validator: ValidateFunction;
}

const structuredOutputValidatorCache = new WeakMap<
  object,
  CompiledStructuredOutputValidator
>();

function validateStructuredValueWithAjv(
  value: unknown,
  schema: Record<string, unknown> | undefined,
): string | undefined {
  if (!schema) return undefined;
  let compiled = structuredOutputValidatorCache.get(schema);
  try {
    if (compiled === undefined) {
      // Each caller-owned schema gets an isolated AJV registry. This preserves
      // absolute recursive self-refs through `$id` while allowing unrelated
      // sessions to reuse that same `$id` without global registry collisions.
      const ajv = new Ajv({
        allErrors: true,
        strict: false,
        validateFormats: false,
        logger: false,
      });
      compiled = { ajv, validator: ajv.compile(schema) };
      structuredOutputValidatorCache.set(schema, compiled);
    }
  } catch (error) {
    return `schema is invalid: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (compiled.validator(value)) return undefined;
  return compiled.ajv.errorsText(compiled.validator.errors, {
    dataVar: "$",
    separator: "; ",
  });
}

export type ProviderStructuredOutputMode =
  | "native_text_format"
  | "chat_response_format"
  | "chat_json_object"
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

function supportsMetaStructuredOutputs(model: string | undefined): boolean {
  if (typeof model !== "string") return false;
  const normalized = model.trim();
  return (
    /(?:^|[/:])muse-spark-(?:1\.3(?:-contributor)?|1\.2(?:-contributor)?|1\.1)$/i
      .test(normalized)
  );
}

export function resolveProviderStructuredOutputMode(input: {
  readonly provider: string | undefined;
  readonly model: string | undefined;
  readonly api?: "responses" | "chat_completions" | "messages";
}): ProviderStructuredOutputMode {
  const provider = normalizeProviderIdentity(
    input.provider,
    "structured-output capability",
  );
  if (provider === "grok") {
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
  if (provider === "meta") {
    if (
      input.api !== "chat_completions" ||
      !supportsMetaStructuredOutputs(input.model)
    ) {
      return "unsupported";
    }
    return "chat_response_format";
  }
  if (provider === "cerebras") {
    if (
      input.api !== "chat_completions" ||
      resolveModelCapabilityHints({
        provider,
        model: input.model,
      })?.supportsStructuredOutput !== true
    ) {
      return "unsupported";
    }
    return "chat_response_format";
  }
  if (provider === "zai" || provider === "zai-coding-plan") {
    if (
      input.api !== "chat_completions" ||
      resolveModelCapabilityHints({
        provider,
        model: input.model,
      })?.supportsStructuredOutput !== true
    ) {
      return "unsupported";
    }
    return "chat_json_object";
  }
  if (provider === "kimi") {
    if (
      input.api !== "chat_completions" ||
      resolveModelCapabilityHints({
        provider,
        model: input.model,
      })?.supportsStructuredOutput !== true
    ) {
      return "unsupported";
    }
    return "chat_response_format";
  }
  if (provider === "anthropic") {
    return supportsAnthropicStructuredOutputToolUse(input.model)
      ? "anthropic_tool_use"
      : "unsupported";
  }
  return "unsupported";
}

/**
 * Returns true when the xAI model accepts the `reasoning_effort` request
 * parameter. Grok 4.3, Grok 4.5, and Grok 4.6 use it for reasoning depth;
 * `grok-4.20-multi-agent*` uses it for agent count.
 *
 * Keep this model allowlist fail-closed. xAI's OpenAI-compatible surfaces
 * reject unsupported request fields, so unknown Grok variants must not
 * inherit the parameter merely because their name starts with `grok-4`.
 */
export function supportsXaiReasoningEffortParam(
  model: string | undefined,
): boolean {
  if (typeof model !== "string") return false;
  const normalized = model.trim().toLowerCase();
  if (normalized.length === 0) return false;
  const unqualified = normalized.slice(
    Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf(":")) + 1,
  );
  return (
    /^grok-4\.(?:3|5|6)(?:$|[-_.])/.test(unqualified) ||
    /^grok-4[.-]20-multi-agent(?:$|[-_.])/.test(unqualified) ||
    unqualified === "grok-build-latest"
  );
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
  const comprehensiveValidationError = validateStructuredValueWithAjv(
    value,
    schema,
  );
  if (comprehensiveValidationError) {
    throw new Error(
      `${schemaName ?? "structured_output"} violated its JSON schema: ${comprehensiveValidationError}`,
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
