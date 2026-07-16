import { describe, expect, test, vi } from "vitest";

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
  metadata: { mutating: false },
  requiresApproval: false,
  recoveryCategory: "idempotent",
  inputSchema: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
  },
  async execute(args) {
    return { content: String(args.text ?? "") };
  },
};

const MUTATING_TOOL: Tool = {
  ...SAMPLE_TOOL,
  name: "sample.write",
  description: "Mutates state.",
  isReadOnly: false,
  metadata: { mutating: true },
  recoveryCategory: "side-effecting",
};

const CONTRADICTORY_TOOL: Tool = {
  ...SAMPLE_TOOL,
  name: "sample.contradictory",
  description: "Claims read-only while declaring a mutation.",
  metadata: { mutating: true },
};

const NON_IDEMPOTENT_READ_TOOL: Tool = {
  ...SAMPLE_TOOL,
  name: "sample.non-idempotent-read",
  description: "Claims read-only without replay-safe semantics.",
  recoveryCategory: "side-effecting",
};

const UNCLASSIFIED_TOOL: Tool = {
  ...SAMPLE_TOOL,
  name: "sample.unclassified",
  description: "Omits explicit mutation metadata.",
  metadata: undefined,
};

const APPROVAL_GATED_TOOL: Tool = {
  ...SAMPLE_TOOL,
  name: "sample.approval-gated",
  description: "Requires approval despite otherwise read-only metadata.",
  requiresApproval: true,
};

const INTERACTION_HOOK_TOOL: Tool = {
  ...SAMPLE_TOOL,
  name: "sample.interaction-hook",
  description: "Defines an interaction policy hook.",
  requiresUserInteraction: () => false,
};

const PERMISSION_HOOK_TOOL: Tool = {
  ...SAMPLE_TOOL,
  name: "sample.permission-hook",
  description: "Defines a permission policy hook.",
  checkPermissions(input) {
    return { behavior: "allow", updatedInput: input };
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

  test("framework tools/call executes the audited tool instance", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const safeTool: Tool = {
      ...SAMPLE_TOOL,
      async execute(args) {
        calls.push(args);
        return {
          content: `echo:${String(args.text ?? "")}`,
          codeModeResult: { echoed: true },
        };
      },
    };
    const registry: Pick<ToolRegistry, "tools" | "dispatch"> = {
      tools: [safeTool],
      async dispatch(toolCall): Promise<ToolDispatchResult> {
        return { content: `wrong:${toolCall.name}`, isError: true };
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
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ text: "hello" });
    expect(Object.getOwnPropertyDescriptor(calls[0], "__callId")).toMatchObject({
      value: "2",
      enumerable: false,
    });
  });

  test.each(["1", "true"])(
    "never treats AGENC_MCP_ALLOW_MUTATIONS=%s as inbound authorization",
    async (legacyOverride) => {
      const originalOverride = process.env.AGENC_MCP_ALLOW_MUTATIONS;
      process.env.AGENC_MCP_ALLOW_MUTATIONS = legacyOverride;
      const calls: LLMToolCall[] = [];
      try {
        const registry: Pick<ToolRegistry, "tools" | "dispatch"> = {
          tools: [
            SAMPLE_TOOL,
            MUTATING_TOOL,
            CONTRADICTORY_TOOL,
            NON_IDEMPOTENT_READ_TOOL,
            UNCLASSIFIED_TOOL,
            APPROVAL_GATED_TOOL,
            INTERACTION_HOOK_TOOL,
            PERMISSION_HOOK_TOOL,
          ],
          async dispatch(toolCall): Promise<ToolDispatchResult> {
            calls.push(toolCall);
            return { content: "unexpected dispatch" };
          },
        };
        const server = new McpServerFramework({
          toolProvider: mcpToolRegistryFromAgenCTools(registry),
        });
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

        for (const [index, tool] of [
          MUTATING_TOOL,
          CONTRADICTORY_TOOL,
          NON_IDEMPOTENT_READ_TOOL,
          UNCLASSIFIED_TOOL,
          APPROVAL_GATED_TOOL,
          INTERACTION_HOOK_TOOL,
          PERMISSION_HOOK_TOOL,
        ].entries()) {
          await expect(
            server.handleMessageAsync(
              request(10 + index, "tools/call", {
                name: tool.name,
                arguments: {},
              }),
            ),
          ).resolves.toEqual([
            {
              jsonrpc: "2.0",
              id: 10 + index,
              result: {
                content: [
                  {
                    type: "text",
                    text: expect.stringContaining(
                      "Environment overrides are not authorization",
                    ),
                  },
                ],
                isError: true,
              },
            },
          ]);
        }
        expect(calls).toEqual([]);
      } finally {
        if (originalOverride === undefined) {
          delete process.env.AGENC_MCP_ALLOW_MUTATIONS;
        } else {
          process.env.AGENC_MCP_ALLOW_MUTATIONS = originalOverride;
        }
      }
    },
  );

  test("binds calls to the audited tool instance instead of a registry alias or rebound name", async () => {
    const auditedCalls: Array<Record<string, unknown>> = [];
    const registryDispatch = vi.fn(async (): Promise<ToolDispatchResult> => ({
      content: "mutating alias target executed",
    }));
    const auditedTool: Tool = {
      ...SAMPLE_TOOL,
      name: "FileWrite",
      async execute(args) {
        auditedCalls.push(args);
        return { content: "audited instance executed" };
      },
    };
    let currentTools: readonly Tool[] = [auditedTool];
    const registry: Pick<ToolRegistry, "tools" | "dispatch"> = {
      get tools() {
        return currentTools;
      },
      dispatch: registryDispatch,
    };
    const provider = mcpToolRegistryFromAgenCTools(registry);
    currentTools = [MUTATING_TOOL];

    await expect(
      provider.callTool(
        { name: "FileWrite", arguments: { path: "sentinel" } },
        { requestId: "bound-call" },
      ),
    ).resolves.toEqual({
      content: [{ type: "text", text: "audited instance executed" }],
    });
    expect(auditedCalls).toHaveLength(1);
    expect(registryDispatch).not.toHaveBeenCalled();
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
