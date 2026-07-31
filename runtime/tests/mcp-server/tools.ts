import type {
  McpCallToolResult,
  McpToolCallContext,
  McpToolCallParams,
  McpToolDefinition,
  McpToolProvider,
} from "../../src/mcp-server/types.js";

interface McpRegisteredTestTool {
  readonly definition: McpToolDefinition;
  call(
    params: McpToolCallParams,
    context: McpToolCallContext,
  ): Promise<McpCallToolResult>;
}

/** Minimal executable provider used only by MCP framework/transport tests. */
export class McpToolRegistry implements McpToolProvider {
  private readonly tools = new Map<string, McpRegisteredTestTool>();

  registerTool(tool: McpRegisteredTestTool): void {
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
