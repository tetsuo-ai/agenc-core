/**
 * Tool payload conversion for provider wire requests.
 *
 * Ports the TypeScript reference runtime's provider-tool shaping onto AgenC's
 * `LLMTool` catalog. The source runtime builds provider payloads from
 * prompt-derived tool descriptions; AgenC receives those descriptions on
 * `LLMTool.function.description` and preserves them across every wire format.
 *
 * Shape differences from the reference runtime:
 *   - AgenC's registry already exposes provider-ready JSON schemas, so this
 *     layer only normalizes provider envelopes and does not rebuild schemas.
 */

import type { LLMTool } from "../types.js";
import { encodeMcpToolNameForWire } from "./mcp-tool-naming.js";
import { normalizeToolParamSchema } from "../../utils/toolParamSchema.js";

type FunctionTool = {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
  };
};

type FlatFunctionTool = {
  readonly type: "function";
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
};

type AnthropicTool = {
  readonly name: string;
  readonly description: string;
  readonly input_schema: Record<string, unknown>;
};

/**
 * Wire-safe tool name. The internal registry namespaces MCP tools as
 * `mcp.<server>.<tool>` (dots) but every major provider's strict
 * regex (`^[a-zA-Z0-9_-]{1,64}$`) rejects dots in the function name.
 * Encode at the wire boundary; the response parser decodes back.
 */
function toolName(tool: LLMTool): string {
  return encodeMcpToolNameForWire(tool.function.name);
}

function toolDescription(tool: LLMTool): string {
  return tool.function.description ?? "";
}

function toolParameters(tool: LLMTool): Record<string, unknown> {
  // Guarantee an object root. Strict OpenAI-compatible providers (x.ai grok,
  // deepseek) reject a root-level anyOf/oneOf union with "tool parameter root
  // must be an object type". This only reshapes the schema sent on the wire;
  // tool execution keeps the original conditional input schema.
  const raw = tool.function.parameters ?? { type: "object", properties: {} };
  return normalizeToolParamSchema(raw).schema;
}

/**
 * JSON-schema keywords llama.cpp's json-schema-to-grammar reliably
 * compiles. Grammar-constrained servers (LM Studio, llama.cpp server)
 * build a GBNF grammar from tool schemas at request time and 400 the
 * whole request ("failed to parse grammar") when any tool uses a
 * keyword outside this subset. Dropping the rest only loosens
 * validation on the wire — tool execution still checks the original
 * schema.
 */
const GRAMMAR_SAFE_SCHEMA_KEYS = new Set([
  "type",
  "description",
  "properties",
  "required",
  "items",
  "enum",
  "const",
  "additionalProperties",
  "anyOf",
  "oneOf",
]);

export function sanitizeToolSchemaForGrammar(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeToolSchemaForGrammar);
  if (typeof value !== "object" || value === null) return value;
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  let typeUnion: readonly unknown[] | undefined;
  for (const [key, entry] of Object.entries(source)) {
    if (!GRAMMAR_SAFE_SCHEMA_KEYS.has(key)) continue;
    if (key === "type" && Array.isArray(entry)) {
      typeUnion = entry;
      continue;
    }
    if (key === "properties" && typeof entry === "object" && entry !== null) {
      const props: Record<string, unknown> = {};
      for (const [name, sub] of Object.entries(
        entry as Record<string, unknown>,
      )) {
        props[name] = sanitizeToolSchemaForGrammar(sub);
      }
      out[key] = props;
      continue;
    }
    if (key === "items" || key === "additionalProperties") {
      out[key] =
        typeof entry === "object" && entry !== null
          ? sanitizeToolSchemaForGrammar(entry)
          : entry;
      continue;
    }
    if (key === "anyOf" || key === "oneOf") {
      if (Array.isArray(entry)) {
        out[key] = entry.map(sanitizeToolSchemaForGrammar);
      }
      continue;
    }
    out[key] = entry;
  }

  if (typeUnion !== undefined) {
    const types = Array.from(
      new Set(
        typeUnion.filter((item): item is string => typeof item === "string"),
      ),
    );
    const concreteTypes = types.filter((type) => type !== "null");

    if (concreteTypes.length === 1) {
      // llama.cpp's converter does not reliably compile nullable `type`
      // arrays. A single concrete type plus null can safely use the concrete
      // grammar because execution still validates the original schema.
      out.type = concreteTypes[0];
    } else if (
      concreteTypes.length > 1 &&
      out.anyOf === undefined &&
      out.oneOf === undefined
    ) {
      // Never collapse a real union to its first member. Express each
      // concrete alternative with grammar-safe keywords; retain null as a
      // const branch when the source allowed it.
      out.anyOf = types.map((type) =>
        type === "null" ? { const: null } : { type },
      );
    } else if (concreteTypes.length === 0 && types.includes("null")) {
      out.const = null;
    }
  }
  return out;
}

export function toChatCompletionsTools(
  tools: readonly LLMTool[],
  opts?: { readonly grammarSafe?: boolean },
): FunctionTool[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: toolName(tool),
      description: toolDescription(tool),
      parameters:
        opts?.grammarSafe === true
          ? (sanitizeToolSchemaForGrammar(
              toolParameters(tool),
            ) as Record<string, unknown>)
          : toolParameters(tool),
    },
  }));
}

export function toOpenAIResponsesTools(
  tools: readonly LLMTool[],
): FlatFunctionTool[] {
  return tools.map((tool) => ({
    type: "function",
    name: toolName(tool),
    description: toolDescription(tool),
    parameters: toolParameters(tool),
  }));
}

export function toXaiResponsesTools(
  tools: readonly LLMTool[],
): FlatFunctionTool[] {
  return toOpenAIResponsesTools(tools);
}

export function toAnthropicTools(
  tools: readonly LLMTool[],
): AnthropicTool[] {
  return tools.map((tool) => ({
    name: toolName(tool),
    description: toolDescription(tool),
    input_schema: toolParameters(tool),
  }));
}
