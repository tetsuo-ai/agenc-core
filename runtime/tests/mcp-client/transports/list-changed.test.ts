import { afterEach, describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({
  clientOptions: undefined as unknown,
}));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    constructor(_info: unknown, options: unknown) {
      captured.clientOptions = options;
    }
    close() {
      return Promise.resolve();
    }
  },
}));
vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: class {},
}));
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class {},
}));
vi.mock("./connect-with-cleanup.js", () => ({
  connectMCPClientWithCleanup: async () => {},
}));
vi.mock("../../elicitation/mcp.js", () => ({
  configureMcpElicitationClient: async () => {},
}));
vi.mock("../../services/mcp/hostCapabilities.js", () => ({
  buildMcpHostClientCapabilities: () => ({ roots: {} }),
  configureMcpHostRequestHandlers: () => {},
}));
vi.mock("../../utils/proxy.js", () => ({
  getProxyFetchOptions: () => ({}),
}));

import { createStdioMCPConnection } from "./stdio.js";
import { createSseMCPConnection } from "./sse.js";
import { createHttpMCPConnection } from "./http.js";
import { createWebSocketMCPConnection } from "./websocket.js";
import { createMCPConnection } from "../connection.js";

const handlers = {
  onToolsListChanged: vi.fn(),
  onPromptsListChanged: vi.fn(),
  onResourcesListChanged: vi.fn(),
};

function expectListChangedClientOptions(): void {
  const options = captured.clientOptions as {
    readonly listChanged?: {
      readonly tools?: { readonly onChanged?: (error?: unknown) => void };
      readonly prompts?: { readonly onChanged?: (error?: unknown) => void };
      readonly resources?: { readonly onChanged?: (error?: unknown) => void };
    };
  };
  expect(options.listChanged?.tools?.onChanged).toEqual(expect.any(Function));
  expect(options.listChanged?.prompts?.onChanged).toEqual(expect.any(Function));
  expect(options.listChanged?.resources?.onChanged).toEqual(
    expect.any(Function),
  );
  options.listChanged?.tools?.onChanged?.();
  options.listChanged?.prompts?.onChanged?.();
  options.listChanged?.resources?.onChanged?.();
  expect(handlers.onToolsListChanged).toHaveBeenCalledOnce();
  expect(handlers.onPromptsListChanged).toHaveBeenCalledOnce();
  expect(handlers.onResourcesListChanged).toHaveBeenCalledOnce();
}

afterEach(() => {
  captured.clientOptions = undefined;
  vi.clearAllMocks();
});

describe("MCP transport listChanged client options", () => {
  it.each([
    [
      "stdio",
      async () =>
        createStdioMCPConnection(
          { name: "stdio-srv", command: "true" },
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          handlers,
        ),
    ],
    [
      "sse",
      async () =>
        createSseMCPConnection(
          { name: "sse-srv", endpoint: "http://127.0.0.1:9/sse" },
          undefined,
          undefined,
          undefined,
          undefined,
          handlers,
        ),
    ],
    [
      "http",
      async () =>
        createHttpMCPConnection(
          { name: "http-srv", endpoint: "http://127.0.0.1:9/mcp" },
          undefined,
          undefined,
          undefined,
          undefined,
          handlers,
        ),
    ],
    [
      "websocket",
      async () =>
        createWebSocketMCPConnection(
          { name: "ws-srv", endpoint: "ws://127.0.0.1:9/mcp" },
          undefined,
          undefined,
          undefined,
          undefined,
          handlers,
        ),
    ],
  ] as const)("constructs the %s Client with listChanged handlers", async (
    _transport,
    connect,
  ) => {
    await connect();
    expectListChangedClientOptions();
  });
});

describe("createMCPConnection forwards listChanged handlers", () => {
  it("passes handlers through to the stdio factory Client constructor", async () => {
    await createMCPConnection(
      { name: "stdio-srv", command: "true" },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      handlers,
    );
    expectListChangedClientOptions();
  });
});
