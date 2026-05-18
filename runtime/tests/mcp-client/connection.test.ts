import { describe, it, expect, vi, beforeEach } from "vitest";
import type { MCPElicitationHandlers, MCPServerConfig } from "./types.js";

// Mock the transport modules so we can assert dispatch
// without touching the real SDK.
vi.mock("./transports/stdio.js", () => ({
  createStdioMCPConnection: vi.fn(),
}));
vi.mock("./transports/sse.js", () => ({
  createSseMCPConnection: vi.fn(),
}));
vi.mock("./transports/http.js", () => ({
  createHttpMCPConnection: vi.fn(),
}));
vi.mock("./transports/websocket.js", () => ({
  createWebSocketMCPConnection: vi.fn(),
}));

import { createMCPConnection } from "./connection.js";
import { createStdioMCPConnection } from "./transports/stdio.js";
import { createSseMCPConnection } from "./transports/sse.js";
import { createHttpMCPConnection } from "./transports/http.js";
import { createWebSocketMCPConnection } from "./transports/websocket.js";

const mockCreateStdio = vi.mocked(createStdioMCPConnection);
const mockCreateSse = vi.mocked(createSseMCPConnection);
const mockCreateHttp = vi.mocked(createHttpMCPConnection);
const mockCreateWebSocket = vi.mocked(createWebSocketMCPConnection);

function baseStdioConfig(
  overrides: Partial<MCPServerConfig> = {},
): MCPServerConfig {
  return {
    name: "stdio-srv",
    command: "npx",
    args: ["-y", "@test/srv"],
    ...overrides,
  };
}

describe("createMCPConnection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ------------------------------------------------------------------
  // stdio (default / legacy)
  // ------------------------------------------------------------------

  it("defaults to stdio when no transport is specified", async () => {
    mockCreateStdio.mockResolvedValueOnce("stdio-client");

    const client = await createMCPConnection(baseStdioConfig());

    expect(mockCreateStdio).toHaveBeenCalledOnce();
    const [stdioConfig] = mockCreateStdio.mock.calls[0]!;
    expect(stdioConfig).toEqual({
      name: "stdio-srv",
      command: "npx",
      args: ["-y", "@test/srv"],
    });
    expect(mockCreateSse).not.toHaveBeenCalled();
    expect(mockCreateHttp).not.toHaveBeenCalled();
    expect(mockCreateWebSocket).not.toHaveBeenCalled();
    expect(client).toBe("stdio-client");
  });

  it("uses stdio explicitly when transport='stdio'", async () => {
    mockCreateStdio.mockResolvedValueOnce("stdio-client");

    await createMCPConnection(baseStdioConfig({ transport: "stdio" }));
    expect(mockCreateStdio).toHaveBeenCalledOnce();
    expect(mockCreateSse).not.toHaveBeenCalled();
    expect(mockCreateHttp).not.toHaveBeenCalled();
    expect(mockCreateWebSocket).not.toHaveBeenCalled();
  });

  it("passes MCP elicitation handlers to stdio transport factory", async () => {
    mockCreateStdio.mockResolvedValueOnce("stdio-client");
    const handlers: MCPElicitationHandlers = {
      handleRequest: vi.fn(),
    };

    await createMCPConnection(
      baseStdioConfig({ transport: "stdio" }),
      undefined,
      handlers,
    );

    expect(mockCreateStdio.mock.calls[0]?.[2]).toBe(handlers);
  });

  it("throws when stdio transport is missing a command", async () => {
    await expect(
      createMCPConnection({
        name: "bad",
        transport: "stdio",
      } as MCPServerConfig),
    ).rejects.toThrow(/transport="stdio" but no "command"/);
    expect(mockCreateStdio).not.toHaveBeenCalled();
  });

  // ------------------------------------------------------------------
  // sse
  // ------------------------------------------------------------------

  it("routes transport='sse' to createSseMCPConnection with endpoint/headers", async () => {
    mockCreateSse.mockResolvedValueOnce("sse-client");

    const result = await createMCPConnection({
      name: "remote",
      transport: "sse",
      endpoint: "http://127.0.0.1:4100/sse",
      headers: { Authorization: "Bearer abc" },
      timeout: 12_345,
    });

    expect(mockCreateSse).toHaveBeenCalledOnce();
    const [sseConfig] = mockCreateSse.mock.calls[0]!;
    expect(sseConfig).toEqual({
      name: "remote",
      endpoint: "http://127.0.0.1:4100/sse",
      headers: { Authorization: "Bearer abc" },
      timeout: 12_345,
    });
    expect(mockCreateHttp).not.toHaveBeenCalled();
    expect(mockCreateStdio).not.toHaveBeenCalled();
    expect(mockCreateWebSocket).not.toHaveBeenCalled();
    expect(result).toBe("sse-client");
  });

  it("omits optional fields when the caller did not provide them (sse)", async () => {
    mockCreateSse.mockResolvedValueOnce("sse-client");

    await createMCPConnection({
      name: "remote",
      transport: "sse",
      endpoint: "http://127.0.0.1:4100/sse",
    });

    const [sseConfig] = mockCreateSse.mock.calls[0]!;
    expect(sseConfig).toEqual({
      name: "remote",
      endpoint: "http://127.0.0.1:4100/sse",
    });
    expect((sseConfig as Record<string, unknown>).headers).toBeUndefined();
    expect((sseConfig as Record<string, unknown>).timeout).toBeUndefined();
  });

  it("throws when sse transport is missing an endpoint", async () => {
    await expect(
      createMCPConnection({
        name: "remote",
        transport: "sse",
      }),
    ).rejects.toThrow(/transport="sse" but no "endpoint"/);
    expect(mockCreateSse).not.toHaveBeenCalled();
  });

  // ------------------------------------------------------------------
  // http (Streamable HTTP)
  // ------------------------------------------------------------------

  it("routes transport='http' to createHttpMCPConnection with endpoint/headers", async () => {
    mockCreateHttp.mockResolvedValueOnce("http-client");

    const result = await createMCPConnection({
      name: "stream",
      transport: "http",
      endpoint: "http://127.0.0.1:4101/mcp",
      headers: { "X-Api-Key": "secret" },
      timeout: 5_000,
    });

    expect(mockCreateHttp).toHaveBeenCalledOnce();
    const [httpConfig] = mockCreateHttp.mock.calls[0]!;
    expect(httpConfig).toEqual({
      name: "stream",
      endpoint: "http://127.0.0.1:4101/mcp",
      headers: { "X-Api-Key": "secret" },
      timeout: 5_000,
    });
    expect(mockCreateSse).not.toHaveBeenCalled();
    expect(mockCreateStdio).not.toHaveBeenCalled();
    expect(mockCreateWebSocket).not.toHaveBeenCalled();
    expect(result).toBe("http-client");
  });

  it("throws when http transport is missing an endpoint", async () => {
    await expect(
      createMCPConnection({
        name: "stream",
        transport: "http",
      }),
    ).rejects.toThrow(/transport="http" but no "endpoint"/);
    expect(mockCreateHttp).not.toHaveBeenCalled();
  });

  // ------------------------------------------------------------------
  // websocket
  // ------------------------------------------------------------------

  it("routes transport='websocket' to createWebSocketMCPConnection", async () => {
    mockCreateWebSocket.mockResolvedValueOnce("ws-client");

    const result = await createMCPConnection({
      name: "socket",
      transport: "websocket",
      endpoint: "ws://127.0.0.1:4102/mcp",
      headers: { Authorization: "Bearer ws" },
      timeout: 7_000,
    });

    expect(mockCreateWebSocket).toHaveBeenCalledOnce();
    const [wsConfig] = mockCreateWebSocket.mock.calls[0]!;
    expect(wsConfig).toEqual({
      name: "socket",
      endpoint: "ws://127.0.0.1:4102/mcp",
      headers: { Authorization: "Bearer ws" },
      timeout: 7_000,
    });
    expect(mockCreateStdio).not.toHaveBeenCalled();
    expect(mockCreateSse).not.toHaveBeenCalled();
    expect(mockCreateHttp).not.toHaveBeenCalled();
    expect(result).toBe("ws-client");
  });

  it("routes transport='ws' to createWebSocketMCPConnection", async () => {
    mockCreateWebSocket.mockResolvedValueOnce("ws-client");

    await createMCPConnection({
      name: "socket",
      transport: "ws",
      endpoint: "ws://127.0.0.1:4103/mcp",
    });

    expect(mockCreateWebSocket).toHaveBeenCalledOnce();
  });

  it("throws when websocket transport is missing an endpoint", async () => {
    await expect(
      createMCPConnection({
        name: "socket",
        transport: "websocket",
      }),
    ).rejects.toThrow(/transport="websocket" but no "endpoint"/);
    expect(mockCreateWebSocket).not.toHaveBeenCalled();
  });
});
