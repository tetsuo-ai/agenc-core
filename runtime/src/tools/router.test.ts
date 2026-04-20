import { describe, expect, test } from "vitest";
import { ToolRouter, toolCallFromLLMToolCall } from "./router.js";
import type { Tool } from "./types.js";

const readTool: Tool = {
  name: "system.readFile",
  description: "",
  inputSchema: {},
  execute: async () => ({ content: "ok" }),
};

const writeTool: Tool = {
  name: "system.writeFile",
  description: "",
  inputSchema: {},
  execute: async () => ({ content: "ok" }),
};

describe("ToolRouter", () => {
  test("findSpec matches by full name", () => {
    const router = new ToolRouter([
      { tool: readTool, supportsParallelToolCalls: true },
      { tool: writeTool, supportsParallelToolCalls: false },
    ]);
    expect(router.findSpec("system.readFile")?.tool).toBe(readTool);
    expect(router.findSpec("unknown")).toBeUndefined();
  });

  test("toolSupportsParallel true for parallel-safe function tool", () => {
    const router = new ToolRouter([
      { tool: readTool, supportsParallelToolCalls: true },
    ]);
    expect(
      router.toolSupportsParallel({
        toolName: { name: "system.readFile" },
        callId: "c1",
        payload: { kind: "function", arguments: "" },
      }),
    ).toBe(true);
  });

  test("toolSupportsParallel false for non-parallel function tool", () => {
    const router = new ToolRouter([
      { tool: writeTool, supportsParallelToolCalls: false },
    ]);
    expect(
      router.toolSupportsParallel({
        toolName: { name: "system.writeFile" },
        callId: "c2",
        payload: { kind: "function", arguments: "" },
      }),
    ).toBe(false);
  });

  test("MCP tools use parallelMcpServerNames allowlist", () => {
    const router = new ToolRouter(
      [{ tool: readTool, supportsParallelToolCalls: true }],
      { parallelMcpServerNames: new Set(["dbA"]) },
    );
    expect(
      router.toolSupportsParallel({
        toolName: { name: "query" },
        callId: "c3",
        payload: { kind: "mcp", server: "dbA", tool: "query", rawArguments: "" },
      }),
    ).toBe(true);
    expect(
      router.toolSupportsParallel({
        toolName: { name: "query" },
        callId: "c4",
        payload: { kind: "mcp", server: "dbZ", tool: "query", rawArguments: "" },
      }),
    ).toBe(false);
  });

  test("toolCallFromLLMToolCall routes mcp tools by namespace", () => {
    const call = toolCallFromLLMToolCall({
      id: "c1",
      name: "mcp.github.listIssues",
      arguments: "{}",
    });
    expect(call.payload.kind).toBe("mcp");
  });
});
