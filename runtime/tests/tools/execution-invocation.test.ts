import { describe, expect, it } from "vitest";

import type { ToolInvocation, ToolPayload } from "../../src/tools/context.js";
import {
  buildPayloadForArgs,
  invocationForArgs,
  stringifyToolArgsWithBigInt,
} from "../../src/tools/execution-invocation.js";

function invocation(payload: ToolPayload): ToolInvocation {
  return {
    session: {} as never,
    turn: {} as never,
    tracker: { appendFileDiff() {}, snapshot() { return []; }, clear() {} },
    callId: "c1",
    toolName: { name: "Probe" },
    payload,
    source: "direct",
  };
}

describe("execution invocation payload rebuild", () => {
  it("rebuilds function arguments from the current args without mutating history", () => {
    const original = invocation({ kind: "function", arguments: "{\"todos\":\"[]\"}" });
    const next = invocationForArgs(original, { todos: [{ content: "done" }] });
    expect(next).not.toBe(original);
    expect(next.payload).toEqual({
      kind: "function",
      arguments: JSON.stringify({ todos: [{ content: "done" }] }),
    });
    expect(original.payload).toEqual({ kind: "function", arguments: "{\"todos\":\"[]\"}" });
  });

  it("rebuilds MCP rawArguments and keeps the server and tool identity", () => {
    const payload: ToolPayload = {
      kind: "mcp",
      server: "desktop",
      tool: "open",
      rawArguments: "{}",
    };
    expect(buildPayloadForArgs(payload, { url: "https://example.test" })).toEqual({
      kind: "mcp",
      server: "desktop",
      tool: "open",
      rawArguments: JSON.stringify({ url: "https://example.test" }),
    });
  });

  it.each([
    { kind: "custom" as const, input: "keep" },
    { kind: "tool_search" as const, arguments: { query: "keep" } },
    { kind: "local_shell" as const, params: { command: ["echo"] } },
  ])("leaves $kind payloads unchanged", (payload) => {
    expect(buildPayloadForArgs(payload, { rewritten: true })).toBe(payload);
  });

  it("serializes bigint arguments as JSON numbers", () => {
    expect(stringifyToolArgsWithBigInt({ n: 10n })).toBe("{\"n\":10}");
  });
});
