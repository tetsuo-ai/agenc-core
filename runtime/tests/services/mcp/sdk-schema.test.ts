import { describe, expect, it } from "vitest";
import { CreateMessageRequestSchema, McpError, JSONRPCMessageSchema } from "@modelcontextprotocol/sdk/types.js";
import { loadMcpTypes, loadMcpStdio } from "../../../src/services/mcp/sdk-schema.js";

describe("synchronous MCP protocol loaders", () => {
  it("preserves SDK schema and error identities", () => {
    expect(loadMcpTypes().CreateMessageRequestSchema).toBe(CreateMessageRequestSchema);
    expect(loadMcpTypes().JSONRPCMessageSchema).toBe(JSONRPCMessageSchema);
    expect(loadMcpTypes().McpError).toBe(McpError);
  });
  it("keeps SDK framing and validation on the stdio path", () => {
    const codec = loadMcpStdio();
    const message = { jsonrpc: "2.0" as const, id: 1, method: "ping" };
    expect(codec.deserializeMessage(codec.serializeMessage(message))).toEqual(message);
    expect(() => codec.deserializeMessage('{"jsonrpc":"invalid"}')).toThrow();
  });
});
