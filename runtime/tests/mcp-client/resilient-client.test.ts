import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ResilientMCPBridge,
  toToolCatalogPolicyConfig,
} from "./resilient-client.js";
import type { MCPToolBridgePermissionOptions } from "./tools.js";
import type { MCPServerConfig, MCPToolBridge } from "./types.js";
import { EMPTY_MCP_REQUEST_ENVIRONMENT } from "./environment.js";

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

  it.each(["default", "managed", "user"] as const)(
    "propagates virtual non-filesystem write tools from %s authority",
    (scope) => {
      expect(toToolCatalogPolicyConfig({
        name: "desktop",
        command: "node",
        origin: { scope },
        virtual_no_fs_write_tools: ["browser_navigate"],
      })).toMatchObject({
        virtualNoFsWriteTools: ["browser_navigate"],
      });
    },
  );

  it.each([
    "project",
    "local",
    "flag",
    "profile",
    "environment",
    "cli",
    "plugin",
    "session",
  ] as const)(
    "does not propagate virtual non-filesystem write tools from %s authority",
    (scope) => {
      expect(toToolCatalogPolicyConfig({
        name: "desktop",
        command: "node",
        origin: { scope },
        virtual_no_fs_write_tools: ["browser_navigate"],
      })).toBeUndefined();
    },
  );

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
      EMPTY_MCP_REQUEST_ENVIRONMENT,
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
      EMPTY_MCP_REQUEST_ENVIRONMENT,
    );

    await bridge.dispose();
  });

  it("keeps A/B session transport authority on automatic reconnect", async () => {
    vi.useFakeTimers();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const mutableEnvironmentA: Record<string, string | undefined> = {
      HTTPS_PROXY: "http://session-a.proxy.test:8080",
      NO_PROXY: "localhost",
    };
    const initialA = makeBridge(
      "session-a",
      vi.fn().mockResolvedValue({
        content: "transport closed",
        isError: true,
      }),
    );
    const initialB = makeBridge(
      "session-b",
      vi.fn().mockResolvedValue({
        content: "transport closed",
        isError: true,
      }),
    );
    mockCreateMCPConnection
      .mockResolvedValueOnce("client-a")
      .mockResolvedValueOnce("client-b");
    mockCreateToolBridge
      .mockResolvedValueOnce(makeBridge("session-a"))
      .mockResolvedValueOnce(makeBridge("session-b"));

    const bridgeA = new ResilientMCPBridge(
      { name: "session-a", command: "node" },
      initialA,
      logger,
      { environment: mutableEnvironmentA },
    );
    const bridgeB = new ResilientMCPBridge(
      { name: "session-b", command: "node" },
      initialB,
      logger,
      { environment: Object.freeze({}) },
    );

    delete mutableEnvironmentA.HTTPS_PROXY;
    mutableEnvironmentA.NO_PROXY = "*";
    await Promise.all([
      bridgeA.tools[0]!.execute({}),
      bridgeB.tools[0]!.execute({}),
    ]);
    await vi.advanceTimersByTimeAsync(1_000);

    const callA = mockCreateMCPConnection.mock.calls.find(
      ([config]) => config.name === "session-a",
    );
    const callB = mockCreateMCPConnection.mock.calls.find(
      ([config]) => config.name === "session-b",
    );
    expect(callA?.[5]).toEqual({
      HTTPS_PROXY: "http://session-a.proxy.test:8080",
      NO_PROXY: "localhost",
    });
    expect(Object.isFrozen(callA?.[5])).toBe(true);
    expect(callB?.[5]).toEqual({});
    expect(Object.isFrozen(callB?.[5])).toBe(true);
    expect(callA?.[5]).not.toBe(callB?.[5]);
    const bridgeCallA = mockCreateToolBridge.mock.calls.find(
      ([, serverName]) => serverName === "session-a",
    );
    const bridgeCallB = mockCreateToolBridge.mock.calls.find(
      ([, serverName]) => serverName === "session-b",
    );
    expect(bridgeCallA?.[3]?.environment).toEqual({
      HTTPS_PROXY: "http://session-a.proxy.test:8080",
      NO_PROXY: "localhost",
    });
    expect(Object.isFrozen(bridgeCallA?.[3]?.environment)).toBe(true);
    expect(bridgeCallB?.[3]?.environment).toEqual({});
    expect(Object.isFrozen(bridgeCallB?.[3]?.environment)).toBe(true);

    await Promise.all([bridgeA.dispose(), bridgeB.dispose()]);
  });

  it("re-applies the catalog policy (pin + allow/deny + approval mode) on reconnect (#6)", async () => {
    vi.useFakeTimers();
    const config: MCPServerConfig = {
      name: "srv1",
      command: "npx",
      args: ["-y", "@test/srv1"],
      timeout: 123,
      enabled_tools: ["safe_tool"],
      disabled_tools: ["dangerous_tool"],
      default_tools_approval_mode: "never",
      virtual_no_fs_write_tools: ["browser_navigate"],
      origin: { scope: "user" },
      pinnedCatalogSha256: "a".repeat(64),
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
      virtualNoFsWriteTools: ["browser_navigate"],
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
