import { describe, expect, test } from "vitest";

import { MCP_ERROR_INVALID_REQUEST, MCP_ERROR_INVALID_PARAMS, MCP_ERROR_METHOD_NOT_FOUND, MCP_ERROR_NOT_INITIALIZED, MCP_ERROR_PARSE } from "./types.js";
import { McpServerFramework, ensureMcpOutgoingSerializable } from "./framework.js";

function request(id: number, method: string, params?: unknown) {
  return {
    jsonrpc: "2.0",
    id,
    method,
    ...(params !== undefined ? { params } : {}),
  } as const;
}

describe("McpServerFramework", () => {
  test("responds to initialize with AgenC server metadata and capabilities", () => {
    const server = new McpServerFramework({
      serverInfo: { version: "1.2.3" },
    });

    const [out] = server.handleMessage(
      request(1, "initialize", {
        protocolVersion: "2025-06-18",
        clientInfo: { name: "client", version: "9.9.9" },
      }),
    );

    expect(out).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: { listChanged: true } },
        serverInfo: {
          name: "agenc-mcp-server",
          title: "AgenC",
          version: "1.2.3",
        },
        instructions: null,
      },
    });
    expect(server.snapshot()).toMatchObject({
      initialized: true,
      protocolVersion: "2025-06-18",
      clientInfo: { name: "client", version: "9.9.9" },
    });
  });

  test("rejects repeated initialize requests", () => {
    const server = new McpServerFramework();
    server.handleMessage(request(1, "initialize"));

    expect(server.handleMessage(request(2, "initialize"))).toEqual([
      {
        jsonrpc: "2.0",
        id: 2,
        error: {
          code: MCP_ERROR_INVALID_REQUEST,
          message: "initialize called more than once",
        },
      },
    ]);
  });

  test("requires initialize before ordinary requests", () => {
    const server = new McpServerFramework();

    expect(server.handleMessage(request(3, "tools/list"))).toEqual([
      {
        jsonrpc: "2.0",
        id: 3,
        error: {
          code: MCP_ERROR_NOT_INITIALIZED,
          message: "initialize must be called before other MCP requests",
          data: { method: "tools/list" },
        },
      },
    ]);
    expect(server.handleMessage(request(4, "ping"))).toEqual([
      {
        jsonrpc: "2.0",
        id: 4,
        error: {
          code: MCP_ERROR_NOT_INITIALIZED,
          message: "initialize must be called before other MCP requests",
          data: { method: "ping" },
        },
      },
    ]);
  });

  test("rejects invalid JSON-RPC request ids", () => {
    const server = new McpServerFramework();
    const invalidIds = [true, { nested: 1 }, ["array"], 1.5];

    for (const id of invalidIds) {
      expect(
        server.handleMessage({
          jsonrpc: "2.0",
          id,
          method: "initialize",
        }),
      ).toEqual([
        {
          jsonrpc: "2.0",
          id: null,
          error: {
            code: MCP_ERROR_INVALID_REQUEST,
            message: "invalid JSON-RPC id",
          },
        },
      ]);
    }
  });

  test("rejects malformed initialize params", () => {
    const server = new McpServerFramework();

    expect(
      server.handleMessage(request(5, "initialize", { protocolVersion: 1 })),
    ).toEqual([
      {
        jsonrpc: "2.0",
        id: 5,
        error: {
          code: MCP_ERROR_INVALID_PARAMS,
          message: "initialize protocolVersion must be a string",
        },
      },
    ]);
    expect(
      server.handleMessage(
        request(6, "initialize", { clientInfo: { name: "ok", version: 9 } }),
      ),
    ).toEqual([
      {
        jsonrpc: "2.0",
        id: 6,
        error: {
          code: MCP_ERROR_INVALID_PARAMS,
          message: "initialize clientInfo.version must be a string",
        },
      },
    ]);
  });

  test("responds to ping and empty tools/list after initialization", () => {
    const server = new McpServerFramework();
    server.handleMessage(request(1, "initialize"));

    expect(server.handleMessage(request(2, "ping"))).toEqual([
      { jsonrpc: "2.0", id: 2, result: {} },
    ]);
    expect(server.handleMessage(request(3, "tools/list"))).toEqual([
      {
        jsonrpc: "2.0",
        id: 3,
        result: { tools: [], nextCursor: null },
      },
    ]);
  });

  test("sync tools/call path asks callers to use the async dispatcher", () => {
    const server = new McpServerFramework();
    server.handleMessage(request(1, "initialize"));

    expect(
      server.handleMessage(
        request(2, "tools/call", { name: "sample.echo", arguments: {} }),
      ),
    ).toEqual([
      {
        jsonrpc: "2.0",
        id: 2,
        error: {
          code: MCP_ERROR_INVALID_REQUEST,
          message: "tools/call requires the async MCP dispatcher",
        },
      },
    ]);
  });

  test("returns method-not-found for unsupported requests", () => {
    const server = new McpServerFramework();
    server.handleMessage(request(1, "initialize"));

    expect(server.handleMessage(request(4, "prompts/list"))).toEqual([
      {
        jsonrpc: "2.0",
        id: 4,
        error: {
          code: MCP_ERROR_METHOD_NOT_FOUND,
          message: "method not found: prompts/list",
          data: { method: "prompts/list" },
        },
      },
    ]);
  });

  test("records initialized notification without emitting a response", () => {
    const server = new McpServerFramework();

    expect(
      server.handleMessage({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }),
    ).toEqual([]);
    expect(server.snapshot().initializedNotificationReceived).toBe(true);
  });

  test("creates server-originated requests and resolves response callbacks", () => {
    const server = new McpServerFramework();
    const responses: unknown[] = [];

    const outgoing = server.createServerRequest(
      "agent/event",
      { event: "ready" },
      (message) => responses.push(message),
    );

    expect(outgoing).toEqual({
      jsonrpc: "2.0",
      id: 0,
      method: "agent/event",
      params: { event: "ready" },
    });
    expect(server.snapshot().pendingServerRequests).toBe(1);
    expect(
      server.handleMessage({ jsonrpc: "2.0", id: 0, result: { ok: true } }),
    ).toEqual([]);
    expect(responses).toEqual([
      { jsonrpc: "2.0", id: 0, result: { ok: true } },
    ]);
    expect(server.snapshot().pendingServerRequests).toBe(0);
  });

  test("creates server notifications and routes client error responses", () => {
    const server = new McpServerFramework();
    const responses: unknown[] = [];
    const outgoing = server.createServerRequest("agent/needs-input", undefined, (
      message,
    ) => responses.push(message));

    expect(server.createServerNotification("notifications/tools/list_changed")).toEqual({
      jsonrpc: "2.0",
      method: "notifications/tools/list_changed",
    });
    expect(
      server.handleMessage({
        jsonrpc: "2.0",
        id: outgoing.id,
        error: { code: -32000, message: "client rejected" },
      }),
    ).toEqual([]);
    expect(responses).toEqual([
      {
        jsonrpc: "2.0",
        id: outgoing.id,
        error: { code: -32000, message: "client rejected" },
      },
    ]);
  });

  test("parses raw JSON-RPC lines and reports parse errors", () => {
    const server = new McpServerFramework();

    expect(server.handleRawMessage("{not json")).toEqual([
      {
        jsonrpc: "2.0",
        id: null,
        error: {
          code: MCP_ERROR_PARSE,
          message: "invalid JSON-RPC message",
        },
      },
    ]);
    expect(
      server.handleRawMessage(
        JSON.stringify(request(5, "initialize", { protocolVersion: "x" })),
      ),
    ).toEqual([
      expect.objectContaining({
        jsonrpc: "2.0",
        id: 5,
      }),
    ]);
  });

  test("serializes outgoing messages for transports", () => {
    const server = new McpServerFramework();
    const [out] = server.handleMessage(request(1, "initialize"));

    expect(JSON.parse(ensureMcpOutgoingSerializable(out!))).toEqual(out);
  });
});
