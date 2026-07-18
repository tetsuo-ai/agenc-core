/**
 * Ports donor `mcp-server/src/message_processor.rs` tools/list and
 * tools/call behavior onto AgenC's existing tool registry surface.
 *
 * Inbound MCP does not yet carry a daemon session-owned admission identity.
 * The AgenC registry adapter therefore exposes no executable tools and rejects
 * direct calls, including calls to nominally read-only tools. Calling a
 * captured `tool.execute` closure here would bypass the common budget,
 * concurrency, cancellation, sandbox, and journal boundary.
 */

import type { ToolRegistry } from "../tool-registry.js";
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

export function mcpDefinitionFromAgenCTool(tool: Tool): McpToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  };
}

export class McpToolRegistry implements McpToolProvider {
  private readonly tools = new Map<string, McpRegisteredTool>();
  private readonly blockedToolNames = new Set<string>();

  registerTool(tool: McpRegisteredTool): void {
    if (
      this.tools.has(tool.definition.name) ||
      this.blockedToolNames.has(tool.definition.name)
    ) {
      throw new Error(`MCP tool already registered: ${tool.definition.name}`);
    }
    this.tools.set(tool.definition.name, tool);
  }

  blockTool(name: string): void {
    if (this.tools.has(name) || this.blockedToolNames.has(name)) {
      throw new Error(`MCP tool already registered: ${name}`);
    }
    this.blockedToolNames.add(name);
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
      if (this.blockedToolNames.has(params.name)) {
        return {
          content: [
            {
              type: "text",
              text:
                `MCP tool '${params.name}' is unavailable: inbound MCP tool ` +
                "execution requires a daemon session-bound admission identity. " +
                "Direct execution is fail-closed even for read-only tools because " +
                "it bypasses cancellation, concurrency, and audit. Environment " +
                "overrides are not authorization.",
            },
          ],
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: `Unknown tool '${params.name}'` }],
        isError: true,
      };
    }
    return tool.call(params, context);
  }
}

export function mcpToolRegistryFromAgenCTools(
  registry: Pick<ToolRegistry, "tools">,
): McpToolRegistry {
  const mcpRegistry = new McpToolRegistry();
  for (const tool of registry.tools) {
    // Preserve a stable machine-visible refusal for callers that issue a
    // tools/call despite the empty advertised catalog. Do not capture execute.
    mcpRegistry.blockTool(tool.name);
  }
  return mcpRegistry;
}
