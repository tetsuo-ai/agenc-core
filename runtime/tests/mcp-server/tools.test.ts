import { describe, expect, test } from "vitest";

import type { LLMToolCall } from "../llm/types.js";
import type { ToolDispatchResult, ToolRegistry } from "../tool-registry.js";
import type { Tool } from "../tools/types.js";
import { MCP_ERROR_INVALID_PARAMS } from "./types.js";
import { McpServerFramework } from "./framework.js";
import { McpToolRegistry, mcpDefinitionFromAgenCTool, mcpToolRegistryFromAgenCTools } from "./tools.js";

const SAMPLE_TOOL: Tool = {
  name: "sample.echo",
  description: "Echo text back to the caller.",
  isReadOnly: true,
  inputSchema: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
  },
  async execute(args) {
    return { content: String(args.text ?? "") };
  },
};

function request(id: number, method: string, params?: unknown) {
  return {
    jsonrpc: "2.0",
    id,
    method,
    ...(params !== undefined ? { params } : {}),
  } as const;
}

describe("MCP server tool registration", () => {
  test("maps AgenC tools into MCP tool definitions", () => {
    expect(mcpDefinitionFromAgenCTool(SAMPLE_TOOL)).toEqual({
      name: "sample.echo",
      description: "Echo text back to the caller.",
      inputSchema: SAMPLE_TOOL.inputSchema,
    });
  });

  test("registerTool lists definitions and rejects duplicate names", () => {
    const registry = new McpToolRegistry();
    registry.registerTool({
      definition: mcpDefinitionFromAgenCTool(SAMPLE_TOOL),
      async call() {
        return { content: [{ type: "text", text: "ok" }] };
      },
    });

    expect(registry.listTools()).toEqual([mcpDefinitionFromAgenCTool(SAMPLE_TOOL)]);
    expect(() =>
      registry.registerTool({
        definition: mcpDefinitionFromAgenCTool(SAMPLE_TOOL),
        async call() {
          return { content: [{ type: "text", text: "duplicate" }] };
        },
      }),
    ).toThrow("MCP tool already registered: sample.echo");
  });

  test("framework tools/list exposes registered AgenC tools", () => {
    const mcpRegistry = new McpToolRegistry();
    mcpRegistry.registerTool({
      definition: mcpDefinitionFromAgenCTool(SAMPLE_TOOL),
      async call() {
        return { content: [{ type: "text", text: "ok" }] };
      },
    });
    const server = new McpServerFramework({ toolProvider: mcpRegistry });
    server.handleMessage(request(1, "initialize"));

    expect(server.handleMessage(request(2, "tools/list"))).toEqual([
      {
        jsonrpc: "2.0",
        id: 2,
        result: {
          tools: [mcpDefinitionFromAgenCTool(SAMPLE_TOOL)],
          nextCursor: null,
        },
      },
    ]);
  });

  test("framework tools/call dispatches through the AgenC tool registry", async () => {
    const calls: LLMToolCall[] = [];
    const registry: Pick<ToolRegistry, "tools" | "dispatch"> = {
      tools: [SAMPLE_TOOL],
      async dispatch(toolCall): Promise<ToolDispatchResult> {
        calls.push(toolCall);
        return {
          content: `echo:${JSON.parse(toolCall.arguments).text}`,
          codeModeResult: { echoed: true },
        };
      },
    };
    const server = new McpServerFramework({
      toolProvider: mcpToolRegistryFromAgenCTools(registry),
    });
    server.handleMessage(request(1, "initialize"));

    await expect(
      server.handleMessageAsync(
        request(2, "tools/call", {
          name: "sample.echo",
          arguments: { text: "hello" },
        }),
      ),
    ).resolves.toEqual([
      {
        jsonrpc: "2.0",
        id: 2,
        result: {
          content: [{ type: "text", text: "echo:hello" }],
          structuredContent: { echoed: true },
        },
      },
    ]);
    expect(calls).toEqual([
      {
        id: "2",
        name: "sample.echo",
        arguments: JSON.stringify({ text: "hello" }),
      },
    ]);
  });

  test("tools/call validates params and returns unknown-tool results", async () => {
    const server = new McpServerFramework({ toolProvider: new McpToolRegistry() });
    server.handleMessage(request(1, "initialize"));

    await expect(
      server.handleMessageAsync(request(2, "tools/call", { name: 123 })),
    ).resolves.toEqual([
      {
        jsonrpc: "2.0",
        id: 2,
        error: {
          code: MCP_ERROR_INVALID_PARAMS,
          message: "tools/call name must be a string",
        },
      },
    ]);
    await expect(
      server.handleMessageAsync(
        request(3, "tools/call", { name: "missing.tool", arguments: {} }),
      ),
    ).resolves.toEqual([
      {
        jsonrpc: "2.0",
        id: 3,
        result: {
          content: [{ type: "text", text: "Unknown tool 'missing.tool'" }],
          isError: true,
        },
      },
    ]);
  });
});
