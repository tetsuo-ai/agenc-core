import { readFileSync } from "node:fs";
import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import { sourceUrl } from "../helpers/source-path.ts";
import { JSON_RPC_VERSION, type SessionMcpStatusResult } from "./protocol/index.js";

describe("session MCP status schema", () => {
  it("publishes the opt-in stopped state for on-demand MCP servers", () => {
    const schema = JSON.parse(readFileSync(sourceUrl("app-server/protocol/schema.json"), "utf8")) as {
      definitions: Record<string, unknown>;
    };
    const compile = (definition: string) => new Ajv({ strict: false }).compile({
      $schema: "http://json-schema.org/draft-07/schema#",
      definitions: schema.definitions,
      $ref: `#/definitions/${definition}`,
    });
    const validateRequest = compile("AgenCDaemonRequest");
    const request = (params: Record<string, unknown>) => ({
      jsonrpc: JSON_RPC_VERSION, id: "mcp-status", method: "session.mcp.status", params,
    });
    expect(validateRequest(request({ sessionId: "session_1" })), JSON.stringify(validateRequest.errors)).toBe(true);
    expect(
      validateRequest(request({ sessionId: "session_1", includeStoppedState: true })),
      JSON.stringify(validateRequest.errors),
    ).toBe(true);
    expect(validateRequest(request({ sessionId: "session_1", includeStoppedState: "true" }))).toBe(false);
    const validateStatus = compile("SessionMcpStatusResult");
    const status = {
      sessionId: "session_1",
      revision: 3,
      servers: [{
        name: "plugin:demo:edgar",
        transport: "stdio",
        enabled: true,
        required: false,
        state: "stopped",
        toolCount: 1,
      }],
      tools: [{ serverName: "plugin:demo:edgar", name: "mcp.plugin:demo:edgar.lookup" }],
    } satisfies SessionMcpStatusResult;
    expect(validateStatus(status), JSON.stringify(validateStatus.errors)).toBe(true);
  });
});
