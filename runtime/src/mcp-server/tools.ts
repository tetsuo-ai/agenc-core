/**
 * Ports donor `mcp-server/src/message_processor.rs` tools/list and
 * tools/call behavior onto AgenC's existing tool registry surface.
 *
 * MS-02 owns registration only. Transports and permission decisions stay
 * in later MS-* items. This adapter binds each admitted call to the exact
 * audited tool instance; name-based registry dispatch can rebuild or alias
 * to a different implementation and is therefore unsafe at this boundary.
 */

import type { ToolRegistry } from "../tool-registry.js";
import { safeStringify, type Tool, type ToolResult } from "../tools/types.js";
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

function isProvablyReadOnlyForInboundMcp(tool: Tool): boolean {
  // Inbound MCP does not traverse runToolUse's native permission/sandbox path.
  // Require the independent internal signals and no permission/UI hooks. Fail
  // closed when a tool omits or contradicts any of them; metadata alone is
  // never authorization.
  return (
    tool.isReadOnly === true &&
    tool.metadata?.mutating === false &&
    tool.recoveryCategory === "idempotent" &&
    tool.requiresApproval === false &&
    tool.defaultPermissionMode === undefined &&
    tool.requiresUserInteraction === undefined &&
    tool.checkPermissions === undefined
  );
}

export function mcpDefinitionFromAgenCTool(tool: Tool): McpToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  };
}

function mcpResultFromToolExecution(result: ToolResult): McpCallToolResult {
  return {
    content: [{ type: "text", text: result.content }],
    ...(result.codeModeResult !== undefined
      ? { structuredContent: result.codeModeResult }
      : {}),
    ...(result.isError === true ? { isError: true } : {}),
  };
}

function registeredToolFromAgenCTool(tool: Tool): McpRegisteredTool {
  const execute = tool.execute.bind(tool);
  return {
    definition: mcpDefinitionFromAgenCTool(tool),
    async call(params, context) {
      const args = { ...(params.arguments ?? {}) };
      Object.defineProperty(args, "__callId", {
        value: String(context.requestId ?? `${tool.name}-mcp-call`),
        enumerable: false,
        configurable: true,
      });
      try {
        return mcpResultFromToolExecution(await execute(args));
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: safeStringify({
                error: error instanceof Error ? error.message : String(error),
              }),
            },
          ],
          isError: true,
        };
      }
    },
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
                `MCP tool '${params.name}' is unavailable: inbound MCP serves ` +
                "only explicitly read-only, non-mutating, idempotent tools. " +
                "Environment overrides are not authorization; use a daemon-native " +
                "admitted session when mutation support is available.",
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
    if (!isProvablyReadOnlyForInboundMcp(tool)) {
      mcpRegistry.blockTool(tool.name);
      continue;
    }
    mcpRegistry.registerTool(registeredToolFromAgenCTool(tool));
  }
  return mcpRegistry;
}
