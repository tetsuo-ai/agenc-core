/**
 * T6 gap #119 — MCP tool-bridge `mcp_tool_call_begin` / `_end` smoke.
 *
 * Verifies that the bridge factory threads an `MCPCallObserver` into
 * each per-tool `execute()` wrapper so the session layer can emit
 * the canonical EventMsg variants without the bridge itself needing
 * a Session reference.
 */

import { describe, expect, test } from "vitest";
import { createToolBridge, type MCPCallObserver } from "./tool-bridge.js";

describe("createToolBridge — T6 gap #119 observer wiring", () => {
  test("observer.onBegin + onEnd fire around a successful call", async () => {
    const begins: Array<{ server: string; toolName: string; args: string }> = [];
    const ends: Array<{ server: string; toolName: string; isError: boolean }> = [];
    const observer: MCPCallObserver = {
      onBegin: (b) => {
        begins.push({ server: b.server, toolName: b.toolName, args: b.args });
      },
      onEnd: (e) => {
        ends.push({ server: e.server, toolName: e.toolName, isError: e.isError });
      },
    };

    const fakeClient = {
      listTools: async () => ({
        tools: [
          {
            name: "echo",
            description: "echoes input",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      }),
      callTool: async () => ({
        content: [{ type: "text", text: "hello" }],
        isError: false,
      }),
      close: async () => {},
    };

    const bridge = await createToolBridge(fakeClient, "srv", undefined, {
      callObserver: observer,
    });
    const tool = bridge.tools[0]!;
    const result = await tool.execute({ msg: "hi" });

    expect(result.isError).toBeFalsy();
    expect(begins).toHaveLength(1);
    expect(begins[0]!.server).toBe("srv");
    expect(begins[0]!.toolName).toBe("echo");
    expect(JSON.parse(begins[0]!.args)).toEqual({ msg: "hi" });

    expect(ends).toHaveLength(1);
    expect(ends[0]!.server).toBe("srv");
    expect(ends[0]!.toolName).toBe("echo");
    expect(ends[0]!.isError).toBe(false);
  });

  test("observer.onEnd still fires with isError when client throws", async () => {
    const ends: Array<{ isError: boolean }> = [];
    const observer: MCPCallObserver = {
      onEnd: (e) => {
        ends.push({ isError: e.isError });
      },
    };

    const fakeClient = {
      listTools: async () => ({
        tools: [
          {
            name: "boom",
            description: "throws",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      }),
      callTool: async () => {
        throw new Error("server exploded");
      },
      close: async () => {},
    };

    const bridge = await createToolBridge(fakeClient, "srv", undefined, {
      callObserver: observer,
    });
    const result = await bridge.tools[0]!.execute({});
    expect(result.isError).toBe(true);
    expect(ends).toHaveLength(1);
    expect(ends[0]!.isError).toBe(true);
  });
});
