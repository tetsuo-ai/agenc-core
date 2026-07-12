/**
 * Ports donor `mcp-server/src/message_processor.rs` tools/list and
 * tools/call behavior onto AgenC's existing tool registry surface.
 *
 * MS-02 owns registration only. Transports and permission decisions stay
 * in later MS-* items; this adapter delegates execution to the already
 * configured AgenC `ToolRegistry`.
 */

import type { LLMToolCall } from "../llm/types.js";
import type { ToolRegistry, ToolDispatchResult } from "../tool-registry.js";
import type { Tool } from "../tools/types.js";
import {
  type McpCallToolResult,
  type McpToolCallContext,
  type McpToolCallParams,
  type McpToolDefinition,
  type McpToolProvider,
} from "./types.js";

export interface McpRegisteredTool {
  readonly definition: McpToolDefinition;
  call(
    params: McpToolCallParams,
    context: McpToolCallContext,
  ): Promise<McpCallToolResult>;
}

function stringifyArguments(args: Readonly<Record<string, unknown>> | undefined): string {
  if (args === undefined) return "{}";
  try {
    return JSON.stringify(args);
  } catch {
    return "{}";
  }
}

export function mcpDefinitionFromAgenCTool(tool: Tool): McpToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  };
}

function mcpResultFromToolDispatch(
  result: ToolDispatchResult,
): McpCallToolResult {
  return {
    content: [{ type: "text", text: result.content }],
    ...(result.codeModeResult !== undefined
      ? { structuredContent: result.codeModeResult }
      : {}),
    ...(result.isError === true ? { isError: true } : {}),
  };
}

function registeredToolFromAgenCTool(
  tool: Tool,
  dispatch: ToolRegistry["dispatch"],
): McpRegisteredTool {
  return {
    definition: mcpDefinitionFromAgenCTool(tool),
    async call(params, context) {
      // Fail closed for mutating tools unless operator opts in (todo-118).
      // Full session permission/sandbox pipeline remains a follow-up; this
      // removes the previous always-execute path for write/shell tools.
      const readOnly = tool.isReadOnly === true;
      const allowMutations =
        process.env.AGENC_MCP_ALLOW_MUTATIONS === "1" ||
        process.env.AGENC_MCP_ALLOW_MUTATIONS === "true";
      if (!readOnly && !allowMutations) {
        return {
          content: [
            {
              type: "text",
              text: `MCP tool '${tool.name}' is not read-only; set AGENC_MCP_ALLOW_MUTATIONS=1 to permit mutating tools over MCP serve (todo-118).`,
            },
          ],
          isError: true,
        };
      }
      const toolCall: LLMToolCall = {
        id: String(context.requestId ?? `${tool.name}-mcp-call`),
        name: params.name,
        arguments: stringifyArguments(params.arguments),
      };
      return mcpResultFromToolDispatch(await dispatch(toolCall));
    },
  };
}

export class McpToolRegistry implements McpToolProvider {
  private readonly tools = new Map<string, McpRegisteredTool>();

  registerTool(tool: McpRegisteredTool): void {
    if (this.tools.has(tool.definition.name)) {
      throw new Error(`MCP tool already registered: ${tool.definition.name}`);
    }
    this.tools.set(tool.definition.name, tool);
  }

  listTools(): readonly McpToolDefinition[] {
    return [...this.tools.values()].map((tool) => tool.definition);
  }

  async callTool(
    params: McpToolCallParams,
    context: McpToolCallContext,
  ): Promise<McpCallToolResult> {
    const tool = this.tools.get(params.name);
    if (tool === undefined) {
      return {
        content: [{ type: "text", text: `Unknown tool '${params.name}'` }],
        isError: true,
      };
    }
    return tool.call(params, context);
  }
}

export function mcpToolRegistryFromAgenCTools(
  registry: Pick<ToolRegistry, "tools" | "dispatch">,
): McpToolRegistry {
  const mcpRegistry = new McpToolRegistry();
  for (const tool of registry.tools) {
    mcpRegistry.registerTool(
      registeredToolFromAgenCTool(tool, registry.dispatch.bind(registry)),
    );
  }
  return mcpRegistry;
}
