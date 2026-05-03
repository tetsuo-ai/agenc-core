import { describe, it, expect, vi, beforeEach } from "vitest";
import type { MCPElicitationHandlers, MCPServerConfig } from "./types.js";

// Mock the SSE and HTTP transport modules so we can assert dispatch
// without touching the real SDK.
vi.mock("./transports/sse.js", () => ({
  createSseMCPConnection: vi.fn(),
}));
vi.mock("./transports/http.js", () => ({
  createHttpMCPConnection: vi.fn(),
}));

// Mock the upstream MCP SDK so the stdio path doesn't try to fork a child.
// vi.fn() can't be used with `new`, so we use real classes and expose
// call-tracking spies on instance methods / constructor args.
const mockStdioClientConnect = vi.fn().mockResolvedValue(undefined);
const mockStdioClientClose = vi.fn().mockResolvedValue(undefined);
const stdioTransportCalls: Array<Record<string, unknown>> = [];
const stdioClientCalls: Array<Record<string, unknown>> = [];

class MockClient {
  connect = mockStdioClientConnect;
  close = mockStdioClientClose;
  constructor(info: Record<string, unknown>, caps: Record<string, unknown>) {
    stdioClientCalls.push({ info, caps });
  }
}

class MockStdioTransport {
  constructor(args: Record<string, unknown>) {
    stdioTransportCalls.push(args);
  }
}

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: MockClient,
}));
vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: MockStdioTransport,
}));

import { createMCPConnection } from "./connection.js";
import { createSseMCPConnection } from "./transports/sse.js";
import { createHttpMCPConnection } from "./transports/http.js";

const mockCreateSse = vi.mocked(createSseMCPConnection);
const mockCreateHttp = vi.mocked(createHttpMCPConnection);

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
    stdioTransportCalls.length = 0;
    stdioClientCalls.length = 0;
    mockStdioClientConnect.mockResolvedValue(undefined);
  });

  // ------------------------------------------------------------------
  // stdio (default / legacy)
  // ------------------------------------------------------------------

  it("defaults to stdio when no transport is specified", async () => {
    const client = await createMCPConnection(baseStdioConfig());

    expect(stdioTransportCalls).toHaveLength(1);
    const transportArgs = stdioTransportCalls[0] as {
      command: string;
      args: string[];
    };
    expect(transportArgs.command).toBe("npx");
    expect(transportArgs.args).toEqual(["-y", "@test/srv"]);
    expect(mockStdioClientConnect).toHaveBeenCalledOnce();
    expect(mockCreateSse).not.toHaveBeenCalled();
    expect(mockCreateHttp).not.toHaveBeenCalled();
    expect(client).toBeDefined();
  });

  it("uses stdio explicitly when transport='stdio'", async () => {
    await createMCPConnection(baseStdioConfig({ transport: "stdio" }));
    expect(stdioTransportCalls).toHaveLength(1);
    expect(mockCreateSse).not.toHaveBeenCalled();
    expect(mockCreateHttp).not.toHaveBeenCalled();
  });

  it("advertises MCP elicitation without claiming form default application", async () => {
    const handlers: MCPElicitationHandlers = {
      handleRequest: vi.fn(),
    };

    await createMCPConnection(
      baseStdioConfig({ transport: "stdio" }),
      undefined,
      handlers,
    );

    expect(stdioClientCalls[0]?.caps).toEqual({
      capabilities: { elicitation: { form: {}, url: {} } },
    });
  });

  it("throws when stdio transport is missing a command", async () => {
    await expect(
      createMCPConnection({
        name: "bad",
        transport: "stdio",
      } as MCPServerConfig),
    ).rejects.toThrow(/transport="stdio" but no "command"/);
    expect(stdioTransportCalls).toHaveLength(0);
  });

  // ------------------------------------------------------------------
  // sse
  // ------------------------------------------------------------------

  it("routes transport='sse' to createSseMCPConnection with endpoint/headers", async () => {
    mockCreateSse.mockResolvedValueOnce("sse-client");

    const result = await createMCPConnection({
      name: "remote",
      transport: "sse",
      endpoint: "https://mcp.example/sse",
      headers: { Authorization: "Bearer abc" },
      timeout: 12_345,
    });

    expect(mockCreateSse).toHaveBeenCalledOnce();
    const [sseConfig] = mockCreateSse.mock.calls[0]!;
    expect(sseConfig).toEqual({
      name: "remote",
      endpoint: "https://mcp.example/sse",
      headers: { Authorization: "Bearer abc" },
      timeout: 12_345,
    });
    expect(mockCreateHttp).not.toHaveBeenCalled();
    expect(stdioTransportCalls).toHaveLength(0);
    expect(result).toBe("sse-client");
  });

  it("omits optional fields when the caller did not provide them (sse)", async () => {
    mockCreateSse.mockResolvedValueOnce("sse-client");

    await createMCPConnection({
      name: "remote",
      transport: "sse",
      endpoint: "https://mcp.example/sse",
    });

    const [sseConfig] = mockCreateSse.mock.calls[0]!;
    expect(sseConfig).toEqual({
      name: "remote",
      endpoint: "https://mcp.example/sse",
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
      endpoint: "https://mcp.example/stream",
      headers: { "X-Api-Key": "secret" },
      timeout: 5_000,
    });

    expect(mockCreateHttp).toHaveBeenCalledOnce();
    const [httpConfig] = mockCreateHttp.mock.calls[0]!;
    expect(httpConfig).toEqual({
      name: "stream",
      endpoint: "https://mcp.example/stream",
      headers: { "X-Api-Key": "secret" },
      timeout: 5_000,
    });
    expect(mockCreateSse).not.toHaveBeenCalled();
    expect(stdioTransportCalls).toHaveLength(0);
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
});
