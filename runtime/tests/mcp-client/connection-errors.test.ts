import { describe, expect, it } from "vitest";
import {
  isMcpConnectionError,
  markMcpConnectionFailure,
  mcpConnectionFailure,
} from "../../src/mcp-client/connection-errors.js";
import type { ToolResult } from "../../src/mcp-client/_deps/tools-types.js";

describe("isMcpConnectionError", () => {
  it.each([
    "MCP server is not connected",
    "Disconnected from transport",
    "write EPIPE",
    "channel closed",
    "process exited with code 1",
    "Connection refused",
    "broken pipe",
    "transport closed by peer",
    "client closed",
    "read ECONNRESET",
    "connect ECONNREFUSED",
  ])("classifies %s as a connection failure", (message) => {
    expect(isMcpConnectionError(message)).toBe(true);
  });

  it.each([
    "",
    "invalid arguments",
    "permission denied",
    "tool timed out",
    "unknown method",
  ])("does not treat %s as a dropped transport", (message) => {
    expect(isMcpConnectionError(message)).toBe(false);
  });
});

describe("mcp connection failure mark", () => {
  it("records a per-result mark that does not leak to another result", () => {
    const failed: ToolResult = { content: "not connected" };
    const ok: ToolResult = { content: "ok" };
    expect(mcpConnectionFailure(failed)).toBeUndefined();
    markMcpConnectionFailure(failed, true);
    markMcpConnectionFailure(ok, false);
    expect(mcpConnectionFailure(failed)).toBe(true);
    expect(mcpConnectionFailure(ok)).toBe(false);
  });
});
