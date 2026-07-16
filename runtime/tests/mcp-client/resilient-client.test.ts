import { afterEach, describe, expect, it, vi } from "vitest";
import { ResilientMCPBridge } from "./resilient-client.js";
import type { MCPToolBridgePermissionOptions } from "./tools.js";
import type { MCPServerConfig, MCPToolBridge } from "./types.js";

vi.mock("./connection.js", () => ({
  createMCPConnection: vi.fn(),
}));

vi.mock("./tools.js", () => ({
  createToolBridge: vi.fn(),
}));

import { createMCPConnection } from "./connection.js";
import { createToolBridge } from "./tools.js";

const mockCreateMCPConnection = vi.mocked(createMCPConnection);
const mockCreateToolBridge = vi.mocked(createToolBridge);

function makeBridge(
  serverName: string,
  execute = vi.fn().mockResolvedValue({ content: "ok" }),
): MCPToolBridge {
  return {
    serverName,
    tools: [
      {
        name: `mcp.${serverName}.tool`,
        description: "Tool",
        inputSchema: { type: "object", properties: {} },
        execute,
      },
    ],
    dispose: vi.fn().mockResolvedValue(undefined),
  };
}

describe("ResilientMCPBridge", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("retries a rejected inner disposal and caches the successful retry", async () => {
    const cleanupError = new Error("owned client still alive");
    const initialBridge = makeBridge("srv1");
    vi.mocked(initialBridge.dispose)
      .mockRejectedValueOnce(cleanupError)
      .mockResolvedValue(undefined);
    const bridge = new ResilientMCPBridge(
      { name: "srv1", command: "node" },
      initialBridge,
    );

    const firstDisposal = bridge.dispose();
    expect(bridge.dispose()).toBe(firstDisposal);
    await expect(firstDisposal).rejects.toEqual(
      expect.objectContaining({ errors: [cleanupError] }),
    );

    await expect(bridge.dispose()).resolves.toBeUndefined();
    await expect(bridge.dispose()).resolves.toBeUndefined();
    expect(initialBridge.dispose).toHaveBeenCalledTimes(2);
  });

  it("remains disposed while persistent cleanup failures stay retryable", async () => {
    const cleanupError = new Error("owned client remains alive");
    const initialBridge = makeBridge("srv1");
    vi.mocked(initialBridge.dispose).mockRejectedValue(cleanupError);
    const bridge = new ResilientMCPBridge(
      { name: "srv1", command: "node" },
      initialBridge,
    );

    await expect(bridge.dispose()).rejects.toBeInstanceOf(AggregateError);
    await expect(bridge.dispose()).rejects.toBeInstanceOf(AggregateError);
    expect(initialBridge.dispose).toHaveBeenCalledTimes(2);
    await expect(bridge.tools[0]!.execute({})).resolves.toMatchObject({
      isError: true,
      content: expect.stringContaining("disposed"),
    });
  });

  it("passes permission options to automatically reconnected tool bridges", async () => {
    vi.useFakeTimers();
    const config: MCPServerConfig = {
      name: "srv1",
      command: "npx",
      args: ["-y", "@test/srv1"],
      timeout: 123,
    };
    const permissionOptions: MCPToolBridgePermissionOptions = {
      getActiveTurnId: () => "turn-1",
    };
    const initialBridge = makeBridge(
      "srv1",
      vi.fn().mockResolvedValue({
        content: "transport closed",
        isError: true,
      }),
    );
    const reconnectedBridge = makeBridge("srv1");
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    mockCreateMCPConnection.mockResolvedValueOnce("client2");
    mockCreateToolBridge.mockResolvedValueOnce(reconnectedBridge);

    const bridge = new ResilientMCPBridge(
      config,
      initialBridge,
      logger,
      { permissions: permissionOptions },
    );

    const result = await bridge.tools[0]!.execute({});
    expect(result).toEqual({
      content: 'MCP server "srv1" lost connection — reconnecting...',
      isError: true,
    });

    await vi.advanceTimersByTimeAsync(1_000);

    expect(initialBridge.dispose).toHaveBeenCalledOnce();
    expect(mockCreateMCPConnection).toHaveBeenCalledWith(
      config,
      logger,
      undefined,
      undefined,
      undefined,
    );
    expect(mockCreateToolBridge).toHaveBeenCalledWith(
      "client2",
      "srv1",
      logger,
      expect.objectContaining({
        callToolTimeoutMs: 123,
        listToolsTimeoutMs: 123,
        permissions: permissionOptions,
      }),
    );

    await bridge.dispose();
  });

  it("passes sampling handlers to automatically reconnected clients", async () => {
    vi.useFakeTimers();
    const config: MCPServerConfig = {
      name: "srv1",
      command: "npx",
      timeout: 123,
    };
    const initialBridge = makeBridge(
      "srv1",
      vi.fn().mockResolvedValue({
        content: "transport closed",
        isError: true,
      }),
    );
    const reconnectedBridge = makeBridge("srv1");
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const samplingHandlers = {
      createMessage: vi.fn(),
    };

    mockCreateMCPConnection.mockResolvedValueOnce("client2");
    mockCreateToolBridge.mockResolvedValueOnce(reconnectedBridge);

    const bridge = new ResilientMCPBridge(config, initialBridge, logger, {
      samplingHandlers,
    });

    await bridge.tools[0]!.execute({});
    await vi.advanceTimersByTimeAsync(1_000);

    expect(mockCreateMCPConnection).toHaveBeenCalledWith(
      config,
      logger,
      undefined,
      samplingHandlers,
      undefined,
    );

    await bridge.dispose();
  });

  it("re-applies the catalog policy (pin + allow/deny + approval mode) on reconnect (#6)", async () => {
    vi.useFakeTimers();
    // Catalog-policy fields live alongside MCPServerConfig but are not part of
    // its public surface, mirroring how manager.ts forwards them.
    const config = {
      name: "srv1",
      command: "npx",
      args: ["-y", "@test/srv1"],
      timeout: 123,
      enabled_tools: ["safe_tool"],
      disabled_tools: ["dangerous_tool"],
      default_tools_approval_mode: "never",
      pinnedCatalogSha256: "a".repeat(64),
    } as unknown as MCPServerConfig;

    const initialBridge = makeBridge(
      "srv1",
      vi.fn().mockResolvedValue({
        content: "transport closed",
        isError: true,
      }),
    );
    const reconnectedBridge = makeBridge("srv1");
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    mockCreateMCPConnection.mockResolvedValueOnce("client2");
    mockCreateToolBridge.mockResolvedValueOnce(reconnectedBridge);

    const bridge = new ResilientMCPBridge(config, initialBridge, logger);

    // Force a connection error -> schedule reconnect.
    await bridge.tools[0]!.execute({});
    await vi.advanceTimersByTimeAsync(1_000);

    expect(mockCreateToolBridge).toHaveBeenCalledTimes(1);
    const options = mockCreateToolBridge.mock.calls[0]![3]!;
    // The rebuilt bridge MUST receive the catalog policy so the I-74 pin and
    // the allow/deny filter run on every reconnection.
    expect(options.serverConfig).toBeDefined();
    expect(options.serverConfig).toMatchObject({
      pinnedCatalogSha256: "a".repeat(64),
      allowedTools: ["safe_tool"],
      deniedTools: ["dangerous_tool"],
      defaultToolsApprovalMode: "never",
    });

    await bridge.dispose();
  });

  it("omits serverConfig on reconnect when the config carries no catalog policy", async () => {
    vi.useFakeTimers();
    const config: MCPServerConfig = {
      name: "srv1",
      command: "npx",
      args: ["-y", "@test/srv1"],
      timeout: 123,
    };

    const initialBridge = makeBridge(
      "srv1",
      vi.fn().mockResolvedValue({
        content: "transport closed",
        isError: true,
      }),
    );
    const reconnectedBridge = makeBridge("srv1");
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    mockCreateMCPConnection.mockResolvedValueOnce("client2");
    mockCreateToolBridge.mockResolvedValueOnce(reconnectedBridge);

    const bridge = new ResilientMCPBridge(config, initialBridge, logger);

    await bridge.tools[0]!.execute({});
    await vi.advanceTimersByTimeAsync(1_000);

    const options = mockCreateToolBridge.mock.calls[0]![3]!;
    expect(options.serverConfig).toBeUndefined();

    await bridge.dispose();
  });

  it("awaits and closes an in-flight automatic reconnect during disposal", async () => {
    vi.useFakeTimers();
    let resolveClient:
      | ((client: { close: ReturnType<typeof vi.fn> }) => void)
      | undefined;
    const freshClient = { close: vi.fn().mockResolvedValue(undefined) };
    const initialBridge = makeBridge(
      "srv1",
      vi.fn().mockResolvedValue({
        content: "transport closed",
        isError: true,
      }),
    );
    mockCreateMCPConnection.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveClient = resolve;
        }),
    );
    const bridge = new ResilientMCPBridge(
      { name: "srv1", command: "node" },
      initialBridge,
    );

    await bridge.tools[0]!.execute({});
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mockCreateMCPConnection).toHaveBeenCalledOnce();

    let disposed = false;
    const disposal = bridge.dispose().then(() => {
      disposed = true;
    });
    await Promise.resolve();
    expect(disposed).toBe(false);

    resolveClient?.(freshClient);
    await disposal;

    expect(freshClient.close).toHaveBeenCalledOnce();
    expect(initialBridge.dispose).toHaveBeenCalledOnce();
  });
});
