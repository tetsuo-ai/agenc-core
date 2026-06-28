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

export function toChatCompletionsTools(
  tools: readonly LLMTool[],
): FunctionTool[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: toolName(tool),
      description: toolDescription(tool),
      parameters: toolParameters(tool),
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
