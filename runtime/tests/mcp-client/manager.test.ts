import { resolve } from "node:path";

import { describe, it, expect, vi, beforeEach } from "vitest";
import { MCPManager } from "./manager.js";
import type { MCPServerConfig } from "./types.js";
import type { MCPToolBridgePermissionOptions } from "./tools.js";
import { SandboxExecutionBroker } from "../sandbox/execution-broker.js";
import {
  registerSandboxExecutionLifecycleParticipant,
  transitionSandboxExecutionBroker,
} from "../sandbox/execution-lifecycle.js";
import { MCPTransportCleanupError } from "./transports/connect-with-cleanup.js";

// Mock the connection and tools modules
vi.mock("./connection.js", () => ({
  createMCPConnection: vi.fn(),
}));
vi.mock("./tools.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tools.js")>();
  return {
    ...actual,
    createToolBridge: vi.fn(),
  };
});
vi.mock("./resources.js", () => ({
  createResourceBridge: vi.fn(),
}));
vi.mock("./prompts.js", () => ({
  createPromptBridge: vi.fn(),
}));

import { createMCPConnection } from "./connection.js";
import { createToolBridge } from "./tools.js";
import { createResourceBridge } from "./resources.js";
import { createPromptBridge } from "./prompts.js";

const mockCreateMCPConnection = vi.mocked(createMCPConnection);
const mockCreateToolBridge = vi.mocked(createToolBridge);
const mockCreateResourceBridge = vi.mocked(createResourceBridge);
const mockCreatePromptBridge = vi.mocked(createPromptBridge);

function makeMockResourceBridge(
  serverName: string,
  resources: Array<{ uri: string; name?: string }> = [],
) {
  return {
    serverName,
    listResources: vi.fn().mockResolvedValue(
      resources.map((r) => ({
        serverName,
        uri: r.uri,
        namespacedName: `mcp.${serverName}.${r.uri}`,
        ...(r.name !== undefined ? { name: r.name } : {}),
      })),
    ),
    readResource: vi.fn().mockResolvedValue({
      uri: "",
      truncated: false,
      bytesReturned: 0,
    }),
    dispose: vi.fn().mockResolvedValue(undefined),
  };
}

function makeMockPromptBridge(
  serverName: string,
  prompts: Array<{ name: string }> = [],
) {
  return {
    serverName,
    listPrompts: vi.fn().mockResolvedValue(
      prompts.map((p) => ({
        serverName,
        name: p.name,
        namespacedName: `mcp.${serverName}.${p.name}`,
      })),
    ),
    renderPrompt: vi.fn().mockResolvedValue({
      promptName: "",
      messages: [],
    }),
    dispose: vi.fn().mockResolvedValue(undefined),
  };
}

function makeConfig(
  name: string,
  overrides?: Partial<MCPServerConfig>,
): MCPServerConfig {
  return { name, command: "npx", args: ["-y", `@test/${name}`], ...overrides };
}

function makeMockBridge(serverName: string, toolNames: string[]) {
  return {
    serverName,
    tools: toolNames.map((n) => ({
      name: `mcp.${serverName}.${n}`,
      description: `Tool ${n}`,
      inputSchema: { type: "object" as const, properties: {} },
      execute: vi.fn().mockResolvedValue({ content: "ok" }),
    })),
    dispose: vi.fn().mockResolvedValue(undefined),
  };
}

function deferred<T = void>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
} {
  let resolvePromise: ((value: T) => void) | undefined;
  let rejectPromise: ((error: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: (value) => resolvePromise?.(value),
    reject: (error) => rejectPromise?.(error),
  };
}

async function expectMcpAuthorityPermanentlyClosed(
  manager: MCPManager,
  broker: SandboxExecutionBroker,
  serverName: string,
): Promise<void> {
  expect(broker.isClosedAfterLifecycleAuthorityFailure()).toBe(true);
  expect(manager.getConnectionState(serverName)).toEqual({
    type: "failed",
    error: expect.stringContaining("permanently closed"),
  });
  expect(manager.getTools()).toEqual([]);
  expect(manager.getToolsByServer(serverName)).toEqual([]);
  expect(manager.getConnectedServers()).toEqual([]);
  expect(manager.getConnectedConnection(serverName)).toBeUndefined();
  expect(manager.getServerInstructions(serverName)).toBeUndefined();
  expect(manager.isConnected(serverName)).toBe(false);
  expect(manager.resolveMcpToolInfo(`mcp.${serverName}.tool`)).toBeUndefined();
  await expect(manager.getResources()).resolves.toEqual([]);
  await expect(manager.listPrompts()).resolves.toEqual([]);
  await expect(manager.callTool(serverName, "tool", {})).resolves.toEqual({
    content: expect.stringContaining("permanently closed"),
    isError: true,
  });
  await expect(
    manager.refreshServers([makeConfig("replacement")]),
  ).rejects.toThrow(/permanently closed/u);
  await expect(manager.reconnectServer(serverName)).resolves.toMatchObject({
    success: false,
    error: expect.stringContaining("permanently closed"),
  });
}

describe("MCPManager", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // By default, resource + prompt bridges succeed with empty lists so
    // existing tool-focused tests don't need to know about them.
    mockCreateResourceBridge.mockImplementation((_client, serverName) =>
      Promise.resolve(makeMockResourceBridge(serverName)),
    );
    mockCreatePromptBridge.mockImplementation((_client, serverName) =>
      Promise.resolve(makeMockPromptBridge(serverName)),
    );
  });

  it.each(["", "bad name", "bad.name", "bad\nname", "a".repeat(257)])(
    "rejects invalid server identity %j before constructing runtime state",
    (name) => {
      expect(() => new MCPManager([{ name, command: "node" }])).toThrow(
        /Invalid MCP server name/u,
      );
    },
  );

  it("accepts plugin-scoped server identities", () => {
    expect(
      new MCPManager([
        { name: "plugin:sample:local", command: "node" },
      ]).getConfiguredServers(),
    ).toHaveLength(1);
  });

  // --------------------------------------------------------------------------
  // start()
  // --------------------------------------------------------------------------

  it("connects to all enabled servers", async () => {
    const bridge1 = makeMockBridge("srv1", ["toolA"]);
    const bridge2 = makeMockBridge("srv2", ["toolB", "toolC"]);

    mockCreateMCPConnection
      .mockResolvedValueOnce("client1")
      .mockResolvedValueOnce("client2");
    mockCreateToolBridge
      .mockResolvedValueOnce(bridge1)
      .mockResolvedValueOnce(bridge2);

    const manager = new MCPManager([makeConfig("srv1"), makeConfig("srv2")]);
    await manager.start();

    expect(mockCreateMCPConnection).toHaveBeenCalledTimes(2);
    expect(mockCreateToolBridge).toHaveBeenCalledTimes(2);
    expect(manager.getTools()).toHaveLength(3);
    expect(manager.getConnectedServers()).toEqual(["srv1", "srv2"]);
    expect(manager.getConnectionState("srv1")).toEqual({ type: "connected" });
    expect(manager.getConnectionState("srv2")).toEqual({ type: "connected" });
    expect(manager.getConnectedConnection("srv1")).toEqual(
      expect.objectContaining({
        type: "connected",
        name: "srv1",
        client: "client1",
      }),
    );
  });

  it("passes its immutable provider environment to the canonical tool bridge", async () => {
    const environment: Record<string, string | undefined> = {
      MAX_MCP_OUTPUT_TOKENS: "1234",
    };
    mockCreateMCPConnection.mockResolvedValueOnce("client1");
    mockCreateToolBridge.mockResolvedValueOnce(makeMockBridge("srv1", ["toolA"]));

    const manager = new MCPManager(
      [makeConfig("srv1")],
      undefined,
      environment,
    );
    environment.MAX_MCP_OUTPUT_TOKENS = "9999";
    await manager.start();

    const bridgeEnvironment = mockCreateToolBridge.mock.calls[0]?.[3]?.environment;
    expect(bridgeEnvironment).toEqual({ MAX_MCP_OUTPUT_TOKENS: "1234" });
    expect(Object.isFrozen(bridgeEnvironment)).toBe(true);
    expect(bridgeEnvironment).not.toBe(environment);
  });

  it("isolates surface subscribers and supports idempotent unsubscribe", async () => {
    const bridge = makeMockBridge("srv1", ["toolA"]);
    mockCreateMCPConnection.mockResolvedValueOnce("client1");
    mockCreateToolBridge.mockResolvedValueOnce(bridge);
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
    };
    const manager = new MCPManager([makeConfig("srv1")], logger);
    const healthyListener = vi.fn();
    const unsubscribeBroken = manager.subscribeSurfaceChanges(() => {
      throw new Error("projection failed");
    });
    const unsubscribeHealthy = manager.subscribeSurfaceChanges(healthyListener);

    await expect(manager.start()).resolves.toBeUndefined();

    expect(healthyListener).toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      "MCP surface change listener failed:",
      expect.objectContaining({ message: "projection failed" }),
    );
    const callsBeforeUnsubscribe = healthyListener.mock.calls.length;
    unsubscribeBroken();
    unsubscribeHealthy();
    unsubscribeHealthy();
    await manager.stop();
    expect(healthyListener).toHaveBeenCalledTimes(callsBeforeUnsubscribe);
  });

  it("skips disabled servers", async () => {
    const bridge = makeMockBridge("srv1", ["toolA"]);
    mockCreateMCPConnection.mockResolvedValueOnce("client1");
    mockCreateToolBridge.mockResolvedValueOnce(bridge);

    const manager = new MCPManager([
      makeConfig("srv1"),
      makeConfig("srv2", { enabled: false }),
    ]);
    await manager.start();

    expect(mockCreateMCPConnection).toHaveBeenCalledTimes(1);
    expect(manager.getConnectedServers()).toEqual(["srv1"]);
    expect(manager.getConnectionState("srv2")).toEqual({ type: "disabled" });
  });

  it("drops invalid server default approval modes before bridge creation", async () => {
    const bridge = makeMockBridge("srv1", ["toolA"]);
    mockCreateMCPConnection.mockResolvedValueOnce("client1");
    mockCreateToolBridge.mockResolvedValueOnce(bridge);

    const manager = new MCPManager([
      makeConfig("srv1", {
        default_tools_approval_mode: "invalid",
        enabled_tools: [],
      } as never),
    ]);
    await manager.start();

    expect(mockCreateToolBridge).toHaveBeenCalledWith(
      "client1",
      "srv1",
      expect.anything(),
      expect.objectContaining({
        serverConfig: {
          allowedTools: [],
        },
      }),
    );
  });

  it("does nothing with empty config", async () => {
    const manager = new MCPManager([]);
    await manager.start();

    expect(mockCreateMCPConnection).not.toHaveBeenCalled();
    expect(manager.getTools()).toHaveLength(0);
  });

  it("rejects a second start after startup completes", async () => {
    const bridge = makeMockBridge("srv1", ["toolA"]);
    mockCreateMCPConnection.mockResolvedValueOnce({
      close: vi.fn().mockResolvedValue(undefined),
    });
    mockCreateToolBridge.mockResolvedValueOnce(bridge);
    const manager = new MCPManager([makeConfig("srv1")]);

    await manager.start();
    await expect(manager.start()).rejects.toThrow(/lifecycle is active/);

    expect(mockCreateMCPConnection).toHaveBeenCalledOnce();
    expect(mockCreateToolBridge).toHaveBeenCalledOnce();
    expect(manager.getConnectedServers()).toEqual(["srv1"]);
    expect(manager.getTools()).toHaveLength(1);
    await manager.stop();
  });

  it("rejects a concurrent start without spawning a replacement connection", async () => {
    let resolveClient:
      | ((client: { close: ReturnType<typeof vi.fn> }) => void)
      | undefined;
    const client = { close: vi.fn().mockResolvedValue(undefined) };
    mockCreateMCPConnection.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveClient = resolve;
        }),
    );
    mockCreateToolBridge.mockResolvedValueOnce(
      makeMockBridge("srv1", ["toolA"]),
    );
    const manager = new MCPManager([makeConfig("srv1")]);

    const firstStart = manager.start();
    await vi.waitFor(() => {
      expect(mockCreateMCPConnection).toHaveBeenCalledOnce();
    });
    await expect(manager.start()).rejects.toThrow(/lifecycle is active/);
    expect(mockCreateMCPConnection).toHaveBeenCalledOnce();

    resolveClient?.(client);
    await firstStart;
    expect(manager.getConnectedServers()).toEqual(["srv1"]);
    expect(manager.getTools()).toHaveLength(1);
    await manager.stop();
  });

  it("restarts a running manager under the rebased sandbox authority", async () => {
    const oldCwd = resolve("old-workspace");
    const newCwd = resolve("new-workspace");
    const broker = new SandboxExecutionBroker({
      mode: "danger_full_access",
      cwd: oldCwd,
    });
    const observedCwds: string[] = [];
    mockCreateMCPConnection.mockImplementation(
      async (_config, _logger, _elicitation, _sampling, scopedBroker) => {
        observedCwds.push(scopedBroker?.cwd ?? "missing");
        return { close: vi.fn().mockResolvedValue(undefined) };
      },
    );
    mockCreateToolBridge.mockImplementation(async () =>
      makeMockBridge("srv1", ["toolA"]),
    );

    const controller = new AbortController();
    const manager = new MCPManager([makeConfig("srv1")]);
    manager.setSandboxExecutionBroker(broker);
    await manager.start({
      signal: controller.signal,
      timeoutMs: 1_234,
      requireOneReady: true,
      requiredServers: ["srv1"],
    });
    controller.abort("original startup is over");
    const restartSpy = vi.spyOn(manager, "start");

    await transitionSandboxExecutionBroker(broker, newCwd);

    expect(observedCwds).toEqual([oldCwd, newCwd]);
    expect(restartSpy).toHaveBeenCalledOnce();
    expect(restartSpy).toHaveBeenCalledWith({
      timeoutMs: 1_234,
      requireOneReady: true,
      requiredServers: ["srv1"],
    });
    expect(manager.getConnectionState("srv1")).toEqual({ type: "connected" });

    await manager.stop();
    manager.setSandboxExecutionBroker(undefined);
  });

  it("serializes a server refresh with sandbox quiesce and resumes only the current config", async () => {
    const oldCwd = resolve("refresh-transition-old");
    const newCwd = resolve("refresh-transition-new");
    const broker = new SandboxExecutionBroker({
      mode: "danger_full_access",
      cwd: oldCwd,
    });
    let resolveRacedClient:
      | ((client: { close: ReturnType<typeof vi.fn> }) => void)
      | undefined;
    const racedClient = { close: vi.fn().mockResolvedValue(undefined) };
    mockCreateMCPConnection
      .mockResolvedValueOnce({ close: vi.fn().mockResolvedValue(undefined) })
      .mockImplementationOnce(
        () =>
          new Promise((resolveClient) => {
            resolveRacedClient = resolveClient;
          }),
      )
      .mockResolvedValueOnce({ close: vi.fn().mockResolvedValue(undefined) });
    mockCreateToolBridge
      .mockResolvedValueOnce(makeMockBridge("old", ["before"]))
      .mockResolvedValueOnce(makeMockBridge("current", ["after"]));

    const manager = new MCPManager([makeConfig("old")]);
    manager.setSandboxExecutionBroker(broker);
    const quiesceObserved = deferred();
    const unregisterQuiesceObserver =
      registerSandboxExecutionLifecycleParticipant(broker, {
        name: "refresh-transition-observer",
        quiesce: async () => quiesceObserved.resolve(),
        resume: async () => {},
      });
    await manager.start();

    const refresh = manager.refreshServers([makeConfig("current")]);
    await vi.waitFor(() => {
      expect(mockCreateMCPConnection).toHaveBeenCalledTimes(2);
    });
    const transition = transitionSandboxExecutionBroker(broker, newCwd);
    await quiesceObserved.promise;

    let refreshSettled = false;
    void refresh.finally(() => {
      refreshSettled = true;
    });
    await Promise.resolve();
    expect(refreshSettled).toBe(false);
    expect(manager.getConnectedServers()).toEqual([]);
    expect(broker.cwd).toBe(oldCwd);

    resolveRacedClient?.(racedClient);
    await Promise.all([transition, refresh]);

    expect(racedClient.close).toHaveBeenCalledOnce();
    expect(mockCreateMCPConnection).toHaveBeenCalledTimes(3);
    expect(manager.getConfiguredServers().map(({ name }) => name)).toEqual([
      "current",
    ]);
    expect(manager.getConnectedServers()).toEqual(["current"]);
    expect(manager.getTools().map(({ name }) => name)).toEqual([
      "mcp.current.after",
    ]);

    await manager.stop();
    unregisterQuiesceObserver();
    manager.setSandboxExecutionBroker(undefined);
  });

  it("supersedes a deferred refresh before sandbox resume without starting stale config", async () => {
    const oldCwd = resolve("deferred-refresh-old");
    const newCwd = resolve("deferred-refresh-new");
    const broker = new SandboxExecutionBroker({
      mode: "danger_full_access",
      cwd: oldCwd,
    });
    const holdTransition = deferred();
    const unregisterBlocker = registerSandboxExecutionLifecycleParticipant(
      broker,
      {
        name: "test-transition-blocker",
        quiesce: () => holdTransition.promise,
        resume: async () => {},
      },
    );
    mockCreateMCPConnection
      .mockResolvedValueOnce({ close: vi.fn().mockResolvedValue(undefined) })
      .mockResolvedValueOnce({ close: vi.fn().mockResolvedValue(undefined) });
    mockCreateToolBridge
      .mockResolvedValueOnce(makeMockBridge("old", ["before"]))
      .mockResolvedValueOnce(makeMockBridge("current", ["after"]));

    const manager = new MCPManager([makeConfig("old")]);
    manager.setSandboxExecutionBroker(broker);
    await manager.start();
    const transition = transitionSandboxExecutionBroker(broker, newCwd);
    await vi.waitFor(() => {
      expect(manager.getConnectedServers()).toEqual([]);
    });

    const staleRefresh = manager.refreshServers([makeConfig("stale")]);
    await vi.waitFor(() => {
      expect(manager.getConfiguredServers().map(({ name }) => name)).toEqual([
        "stale",
      ]);
    });
    const currentRefresh = manager.refreshServers([makeConfig("current")]);
    await expect(staleRefresh).rejects.toThrow(/superseded/);
    await vi.waitFor(() => {
      expect(manager.getConfiguredServers().map(({ name }) => name)).toEqual([
        "current",
      ]);
    });
    expect(mockCreateMCPConnection).toHaveBeenCalledOnce();

    holdTransition.resolve();
    await Promise.all([transition, currentRefresh]);

    expect(mockCreateMCPConnection).toHaveBeenCalledTimes(2);
    expect(manager.getConnectedServers()).toEqual(["current"]);
    expect(manager.getTools().map(({ name }) => name)).toEqual([
      "mcp.current.after",
    ]);

    unregisterBlocker();
    await manager.stop();
    manager.setSandboxExecutionBroker(undefined);
  });

  it("signals refresh deferral only after the old MCP surface is revoked and the replacement is staged", async () => {
    const broker = new SandboxExecutionBroker({
      mode: "danger_full_access",
      cwd: resolve("refresh-handshake-old"),
    });
    const holdTransition = deferred();
    const unregisterBlocker = registerSandboxExecutionLifecycleParticipant(
      broker,
      {
        name: "test-refresh-handshake-blocker",
        quiesce: () => holdTransition.promise,
        resume: async () => {},
      },
    );
    const oldClient = { close: vi.fn().mockResolvedValue(undefined) };
    const oldBridge = makeMockBridge("old", ["before"]);
    mockCreateMCPConnection
      .mockResolvedValueOnce(oldClient)
      .mockResolvedValueOnce({ close: vi.fn().mockResolvedValue(undefined) });
    mockCreateToolBridge
      .mockResolvedValueOnce(oldBridge)
      .mockResolvedValueOnce(makeMockBridge("current", ["after"]));

    const manager = new MCPManager([makeConfig("old")]);
    manager.setSandboxExecutionBroker(broker);
    await manager.start();
    const restartSpy = vi.spyOn(manager, "start");
    const transition = transitionSandboxExecutionBroker(
      broker,
      resolve("refresh-handshake-new"),
    );
    await vi.waitFor(() => {
      expect(manager.getConnectedServers()).toEqual([]);
    });

    const refreshDeferred = deferred();
    const onSandboxRefreshDeferred = vi.fn(() => {
      refreshDeferred.resolve();
    });
    const refresh = manager.refreshServers([makeConfig("current")], {
      onSandboxRefreshDeferred,
    });
    await refreshDeferred.promise;

    expect(oldBridge.dispose).toHaveBeenCalledOnce();
    expect(manager.getConfiguredServers().map(({ name }) => name)).toEqual([
      "current",
    ]);
    expect(manager.getConnectedServers()).toEqual([]);
    expect(mockCreateMCPConnection).toHaveBeenCalledOnce();
    await expect(manager.callTool("old", "before", {})).resolves.toEqual({
      content: 'MCP server "old" is not connected',
      isError: true,
    });
    expect(oldBridge.tools[0]?.execute).not.toHaveBeenCalled();
    expect(onSandboxRefreshDeferred).toHaveBeenCalledOnce();

    holdTransition.resolve();
    await Promise.all([transition, refresh]);

    expect(mockCreateMCPConnection).toHaveBeenCalledTimes(2);
    expect(restartSpy).toHaveBeenCalledOnce();
    expect(restartSpy).toHaveBeenCalledWith({});
    expect(manager.getConnectedServers()).toEqual(["current"]);
    expect(manager.getTools().map(({ name }) => name)).toEqual([
      "mcp.current.after",
    ]);
    expect(onSandboxRefreshDeferred).toHaveBeenCalledOnce();

    unregisterBlocker();
    await manager.stop();
    manager.setSandboxExecutionBroker(undefined);
  });

  it("rejects direct start and reconnect while sandbox execution is quiesced", async () => {
    const broker = new SandboxExecutionBroker({
      mode: "danger_full_access",
      cwd: resolve("direct-lifecycle-old"),
    });
    const holdTransition = deferred();
    const unregisterBlocker = registerSandboxExecutionLifecycleParticipant(
      broker,
      {
        name: "test-direct-lifecycle-blocker",
        quiesce: () => holdTransition.promise,
        resume: async () => {},
      },
    );
    mockCreateMCPConnection
      .mockResolvedValueOnce({ close: vi.fn().mockResolvedValue(undefined) })
      .mockResolvedValueOnce({ close: vi.fn().mockResolvedValue(undefined) });
    mockCreateToolBridge
      .mockResolvedValueOnce(makeMockBridge("srv1", ["before"]))
      .mockResolvedValueOnce(makeMockBridge("srv1", ["after"]));

    const manager = new MCPManager([makeConfig("srv1")]);
    manager.setSandboxExecutionBroker(broker);
    await manager.start();
    const transition = transitionSandboxExecutionBroker(
      broker,
      resolve("direct-lifecycle-new"),
    );
    await vi.waitFor(() => {
      expect(manager.getConnectedServers()).toEqual([]);
    });

    await expect(manager.start()).rejects.toThrow(/sandbox execution is quiesced/);
    await expect(manager.reconnectServer("srv1")).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining("sandbox execution is quiesced"),
    });
    expect(mockCreateMCPConnection).toHaveBeenCalledOnce();

    holdTransition.resolve();
    await transition;
    expect(mockCreateMCPConnection).toHaveBeenCalledTimes(2);
    expect(manager.getConnectedServers()).toEqual(["srv1"]);

    unregisterBlocker();
    await manager.stop();
    manager.setSandboxExecutionBroker(undefined);
  });

  it("does not revive a server removed while sandbox authority is quiesced", async () => {
    const oldCwd = resolve("fail-close-transition-old");
    const newCwd = resolve("fail-close-transition-new");
    const broker = new SandboxExecutionBroker({
      mode: "danger_full_access",
      cwd: oldCwd,
    });
    let releaseDisposal: (() => void) | undefined;
    const oldBridge = makeMockBridge("old", ["before"]);
    oldBridge.dispose.mockImplementationOnce(
      () =>
        new Promise<void>((resolveDisposal) => {
          releaseDisposal = resolveDisposal;
        }),
    );
    mockCreateMCPConnection.mockResolvedValueOnce({
      close: vi.fn().mockResolvedValue(undefined),
    });
    mockCreateToolBridge.mockResolvedValueOnce(oldBridge);

    const manager = new MCPManager([makeConfig("old")]);
    manager.setSandboxExecutionBroker(broker);
    await manager.start();

    const transition = transitionSandboxExecutionBroker(broker, newCwd);
    await vi.waitFor(() => {
      expect(oldBridge.dispose).toHaveBeenCalledOnce();
    });
    const failCloseRefresh = manager.refreshServers([]);
    releaseDisposal?.();

    await Promise.all([transition, failCloseRefresh]);
    expect(broker.cwd).toBe(newCwd);
    expect(manager.getConfiguredServers()).toEqual([]);
    expect(manager.getConnectedServers()).toEqual([]);
    expect(mockCreateMCPConnection).toHaveBeenCalledOnce();

    await manager.stop();
    manager.setSandboxExecutionBroker(undefined);
  });

  it("fails a sandbox transition when strict MCP teardown cannot prove shutdown", async () => {
    const oldCwd = resolve("stable-workspace");
    const newCwd = resolve("next-workspace");
    const broker = new SandboxExecutionBroker({
      mode: "danger_full_access",
      cwd: oldCwd,
    });
    const failingBridge = makeMockBridge("srv1", ["toolA"]);
    failingBridge.dispose.mockRejectedValueOnce(
      new Error("process tree survived"),
    );

    mockCreateMCPConnection.mockResolvedValueOnce({
      close: vi.fn().mockResolvedValue(undefined),
    });
    mockCreateToolBridge.mockResolvedValueOnce(failingBridge);

    const manager = new MCPManager([makeConfig("srv1")]);
    manager.setSandboxExecutionBroker(broker);
    await manager.start({ requireOneReady: true });

    await expect(
      transitionSandboxExecutionBroker(broker, newCwd),
    ).rejects.toThrow(/recovery resume failed and broker was closed/u);

    expect(broker.cwd).toBe(oldCwd);
    expect(failingBridge.dispose).toHaveBeenCalledOnce();
    await expectMcpAuthorityPermanentlyClosed(manager, broker, "srv1");

    await manager.stop();
    manager.setSandboxExecutionBroker(undefined);
  });

  it("does not finish strict quiesce until an in-flight startup client is closed", async () => {
    const oldCwd = resolve("pending-start-workspace");
    const newCwd = resolve("pending-start-rebased");
    const broker = new SandboxExecutionBroker({
      mode: "danger_full_access",
      cwd: oldCwd,
    });
    let resolvePending:
      | ((client: { close: ReturnType<typeof vi.fn> }) => void)
      | undefined;
    const pendingClient = { close: vi.fn().mockResolvedValue(undefined) };
    const recoveredBridge = makeMockBridge("srv1", ["toolA"]);
    mockCreateMCPConnection
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolvePending = resolve;
          }),
      )
      .mockResolvedValueOnce({ close: vi.fn().mockResolvedValue(undefined) });
    mockCreateToolBridge.mockResolvedValueOnce(recoveredBridge);

    const manager = new MCPManager([makeConfig("srv1")]);
    manager.setSandboxExecutionBroker(broker);
    const starting = manager.start();
    await vi.waitFor(() => {
      expect(mockCreateMCPConnection).toHaveBeenCalledOnce();
    });

    let transitioned = false;
    const transition = transitionSandboxExecutionBroker(broker, newCwd).then(
      () => {
        transitioned = true;
      },
    );
    await expect(starting).resolves.toBeUndefined();
    await Promise.resolve();
    expect(transitioned).toBe(false);
    expect(broker.cwd).toBe(oldCwd);

    resolvePending?.(pendingClient);
    await transition;

    expect(pendingClient.close).toHaveBeenCalledOnce();
    expect(broker.cwd).toBe(newCwd);
    expect(manager.isConnected("srv1")).toBe(true);

    await manager.stop();
    manager.setSandboxExecutionBroker(undefined);
  });

  it("does not start a never-started manager during a sandbox transition", async () => {
    const oldCwd = resolve("old-workspace");
    const newCwd = resolve("new-workspace");
    const broker = new SandboxExecutionBroker({
      mode: "danger_full_access",
      cwd: oldCwd,
    });
    const manager = new MCPManager([makeConfig("srv1")]);
    manager.setSandboxExecutionBroker(broker);
    const startSpy = vi.spyOn(manager, "start");
    const stopSpy = vi.spyOn(manager, "stop");

    await transitionSandboxExecutionBroker(broker, newCwd);

    expect(broker.cwd).toBe(newCwd);
    expect(startSpy).not.toHaveBeenCalled();
    expect(stopSpy).not.toHaveBeenCalled();
    expect(mockCreateMCPConnection).not.toHaveBeenCalled();
    manager.setSandboxExecutionBroker(undefined);
  });

  it("logs and continues when one server fails to connect", async () => {
    const bridge = makeMockBridge("srv2", ["toolB"]);
    mockCreateMCPConnection
      .mockRejectedValueOnce(new Error("connection refused"))
      .mockResolvedValueOnce("client2");
    mockCreateToolBridge.mockResolvedValueOnce(bridge);

    const logger = { info: vi.fn(), error: vi.fn(), warn: vi.fn() };
    const manager = new MCPManager(
      [makeConfig("srv1"), makeConfig("srv2")],
      logger as any,
    );
    await manager.start();

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("srv1"),
      expect.any(Error),
    );
    expect(manager.getConnectedServers()).toEqual(["srv2"]);
    expect(manager.getTools()).toHaveLength(1);
    expect(manager.getConnectionState("srv1")).toEqual({
      type: "failed",
      error: "connection refused",
    });
    expect(manager.getConnectionState("srv2")).toEqual({ type: "connected" });
  });

  it("closes client when createToolBridge fails", async () => {
    const mockClient = { close: vi.fn().mockResolvedValue(undefined) };
    mockCreateMCPConnection.mockResolvedValueOnce(mockClient);
    mockCreateToolBridge.mockRejectedValueOnce(new Error("listTools failed"));

    const manager = new MCPManager([makeConfig("srv1")]);
    await manager.start();

    expect(mockClient.close).toHaveBeenCalledOnce();
    expect(manager.getConnectedServers()).toEqual([]);
  });

  it("captures InitializeResult.instructions from the SDK client and surfaces it via getServerInstructions", async () => {
    const bridge = makeMockBridge("srv1", ["toolA"]);
    const mockClient = {
      getInstructions: () => "Use this server to manage GitHub issues.",
    };
    mockCreateMCPConnection.mockResolvedValueOnce(mockClient);
    mockCreateToolBridge.mockResolvedValueOnce(bridge);

    const manager = new MCPManager([makeConfig("srv1")]);
    await manager.start();

    expect(manager.getServerInstructions("srv1")).toBe(
      "Use this server to manage GitHub issues.",
    );
    expect(manager.getServerInstructions("unknown")).toBeUndefined();
  });

  it("ignores empty / missing instructions blobs from getInstructions()", async () => {
    const bridge1 = makeMockBridge("srv1", ["a"]);
    const bridge2 = makeMockBridge("srv2", ["b"]);
    const clientWithEmpty = { getInstructions: () => "" };
    const clientWithUndefined = { getInstructions: () => undefined };
    mockCreateMCPConnection
      .mockResolvedValueOnce(clientWithEmpty)
      .mockResolvedValueOnce(clientWithUndefined);
    mockCreateToolBridge
      .mockResolvedValueOnce(bridge1)
      .mockResolvedValueOnce(bridge2);

    const manager = new MCPManager([makeConfig("srv1"), makeConfig("srv2")]);
    await manager.start();

    expect(manager.getServerInstructions("srv1")).toBeUndefined();
    expect(manager.getServerInstructions("srv2")).toBeUndefined();
  });

  it("clears the captured instructions map on stop()", async () => {
    const bridge = makeMockBridge("srv1", ["a"]);
    const client = { getInstructions: () => "ins" };
    mockCreateMCPConnection.mockResolvedValueOnce(client);
    mockCreateToolBridge.mockResolvedValueOnce(bridge);

    const manager = new MCPManager([makeConfig("srv1")]);
    await manager.start();
    expect(manager.getServerInstructions("srv1")).toBe("ins");
    expect(manager.getConnectedConnection("srv1")).toEqual(
      expect.objectContaining({
        instructions: "ins",
      }),
    );
    await manager.stop();
    expect(manager.getServerInstructions("srv1")).toBeUndefined();
    expect(manager.getConnectedConnection("srv1")).toBeUndefined();
  });

  // --------------------------------------------------------------------------
  // stop()
  // --------------------------------------------------------------------------

  it("disposes all bridges then clears", async () => {
    const bridge1 = makeMockBridge("srv1", ["a"]);
    const bridge2 = makeMockBridge("srv2", ["b"]);

    mockCreateMCPConnection
      .mockResolvedValueOnce("c1")
      .mockResolvedValueOnce("c2");
    mockCreateToolBridge
      .mockResolvedValueOnce(bridge1)
      .mockResolvedValueOnce(bridge2);

    const manager = new MCPManager([makeConfig("srv1"), makeConfig("srv2")]);
    await manager.start();
    await manager.stop();

    expect(bridge1.dispose).toHaveBeenCalledOnce();
    expect(bridge2.dispose).toHaveBeenCalledOnce();
    expect(manager.getTools()).toHaveLength(0);
    expect(manager.getConnectedServers()).toEqual([]);
  });

  it("stop is safe to call when no bridges exist", async () => {
    const manager = new MCPManager([]);
    await manager.stop(); // should not throw
  });

  it("stop swallows dispose errors", async () => {
    const bridge = makeMockBridge("srv1", ["a"]);
    bridge.dispose.mockRejectedValueOnce(new Error("close failed"));

    mockCreateMCPConnection.mockResolvedValueOnce("c1");
    mockCreateToolBridge.mockResolvedValueOnce(bridge);

    const manager = new MCPManager([makeConfig("srv1")]);
    await manager.start();
    await manager.stop(); // should not throw
  });

  it("stopStrict reports cleanup that cannot be proven", async () => {
    const bridge = makeMockBridge("srv1", ["a"]);
    bridge.dispose.mockRejectedValueOnce(new Error("close failed"));

    mockCreateMCPConnection.mockResolvedValueOnce("c1");
    mockCreateToolBridge.mockResolvedValueOnce(bridge);

    const manager = new MCPManager([makeConfig("srv1")]);
    await manager.start();
    await expect(manager.stopStrict()).rejects.toThrow(
      /strict shutdown failed/,
    );
    expect(manager.getConnectedServers()).toEqual([]);
  });

  it("clearServersStrict revokes connections and configs without restarting", async () => {
    mockCreateMCPConnection.mockResolvedValueOnce("c1");
    mockCreateToolBridge.mockResolvedValueOnce(makeMockBridge("srv1", ["a"]));

    const manager = new MCPManager([makeConfig("srv1")]);
    await manager.start();
    const start = vi.spyOn(manager, "start");

    await manager.clearServersStrict();

    expect(start).not.toHaveBeenCalled();
    expect(manager.getConfiguredServers()).toEqual([]);
    expect(manager.getConnectedServers()).toEqual([]);
    expect(manager.getTools()).toEqual([]);
  });

  it("clearServersStrict hides revoked authority while cleanup is retained for retry", async () => {
    const bridge = makeMockBridge("srv1", ["a"]);
    bridge.dispose
      .mockRejectedValueOnce(new Error("close failed"))
      .mockResolvedValueOnce(undefined);
    mockCreateMCPConnection.mockResolvedValueOnce("c1");
    mockCreateToolBridge.mockResolvedValueOnce(bridge);

    const manager = new MCPManager([makeConfig("srv1")]);
    await manager.start();

    await expect(manager.clearServersStrict()).rejects.toThrow(
      /strict shutdown failed/,
    );
    expect(manager.getConfiguredServers()).toEqual([]);
    expect(manager.getConnectedServers()).toEqual([]);
    expect(manager.getConnectionState("srv1")).toBeUndefined();
    expect(manager.getTools()).toEqual([]);

    await expect(manager.clearServersStrict()).resolves.toBeUndefined();
    expect(bridge.dispose).toHaveBeenCalledTimes(2);
    expect(manager.getConfiguredServers()).toEqual([]);
  });

  it("refreshServers replaces configs and restarts the same manager instance", async () => {
    const firstBridge = makeMockBridge("old", ["before"]);
    const nextBridge = makeMockBridge("new", ["after"]);
    mockCreateMCPConnection
      .mockResolvedValueOnce("old-client")
      .mockResolvedValueOnce("new-client");
    mockCreateToolBridge
      .mockResolvedValueOnce(firstBridge)
      .mockResolvedValueOnce(nextBridge);

    const manager = new MCPManager([makeConfig("old")]);
    await manager.start();
    await manager.refreshServers([makeConfig("new")]);

    expect(firstBridge.dispose).toHaveBeenCalledOnce();
    expect(manager.getConfiguredServers()).toEqual([
      expect.objectContaining({ name: "new" }),
    ]);
    expect(manager.getConnectedServers()).toEqual(["new"]);
    expect(manager.getTools().map((tool) => tool.name)).toEqual([
      "mcp.new.after",
    ]);
  });

  it("captures nested supply-chain policy immutably at construction and refresh", async () => {
    const firstSupplyChain = { catalogSha256: "a".repeat(64) };
    const manager = new MCPManager([
      makeConfig("old", { supplyChain: firstSupplyChain }),
    ]);
    firstSupplyChain.catalogSha256 = "b".repeat(64);

    const capturedFirst = manager.getServerConfig("old")?.supplyChain;
    expect(capturedFirst).toEqual({ catalogSha256: "a".repeat(64) });
    expect(Object.isFrozen(capturedFirst)).toBe(true);

    const secondSupplyChain = { catalogSha256: "c".repeat(64) };
    const refresh = manager.refreshServers([
      makeConfig("current", { supplyChain: secondSupplyChain }),
    ]);
    secondSupplyChain.catalogSha256 = "d".repeat(64);
    await refresh;

    const capturedSecond = manager.getServerConfig("current")?.supplyChain;
    expect(capturedSecond).toEqual({ catalogSha256: "c".repeat(64) });
    expect(Object.isFrozen(capturedSecond)).toBe(true);
  });

  // --------------------------------------------------------------------------
  // getTools / getToolsByServer / getConnectedServers
  // --------------------------------------------------------------------------

  it("getTools returns flattened tools from all bridges", async () => {
    const bridge1 = makeMockBridge("srv1", ["a", "b"]);
    const bridge2 = makeMockBridge("srv2", ["c"]);

    mockCreateMCPConnection
      .mockResolvedValueOnce("c1")
      .mockResolvedValueOnce("c2");
    mockCreateToolBridge
      .mockResolvedValueOnce(bridge1)
      .mockResolvedValueOnce(bridge2);

    const manager = new MCPManager([makeConfig("srv1"), makeConfig("srv2")]);
    await manager.start();

    const tools = manager.getTools();
    expect(tools).toHaveLength(3);
    expect(tools.map((t) => t.name)).toEqual([
      "mcp.srv1.a",
      "mcp.srv1.b",
      "mcp.srv2.c",
    ]);
  });

  it("getToolsByServer returns tools for a specific server", async () => {
    const bridge = makeMockBridge("srv1", ["toolA", "toolB"]);
    mockCreateMCPConnection.mockResolvedValueOnce("c1");
    mockCreateToolBridge.mockResolvedValueOnce(bridge);

    const manager = new MCPManager([makeConfig("srv1")]);
    await manager.start();

    expect(manager.getToolsByServer("srv1")).toHaveLength(2);
    expect(manager.getToolsByServer("unknown")).toEqual([]);
  });

  it("calls an exact raw tool through the canonical bridge without exposing its client", async () => {
    const bridge = makeMockBridge("srv1", [
      "toolA_extra",
      "x_toolA",
      "toolA",
    ]);
    const prefixExecute = vi.mocked(bridge.tools[0]!.execute);
    const suffixExecute = vi.mocked(bridge.tools[1]!.execute);
    const exactExecute = vi.mocked(bridge.tools[2]!.execute);
    const canonicalResult = {
      content: "ok",
      codeModeResult: { rows: [1, 2, 3] },
      metadata: { source: "canonical-normalizer" },
    };
    exactExecute.mockResolvedValue(canonicalResult);
    const controller = new AbortController();
    const onProgress = vi.fn();
    const callId = "manager-call-1";
    const spoofedSignal = new AbortController().signal;
    const spoofedProgress = vi.fn();
    const args = {
      value: 42,
      __abortSignal: spoofedSignal,
      __callId: "model-visible-spoof",
      __onProgress: spoofedProgress,
      __sandboxExecutionBroker: { execute: vi.fn() },
      __agencFutureSecret: "must-not-cross-manager-boundary",
    };
    mockCreateMCPConnection.mockResolvedValueOnce("client1");
    mockCreateToolBridge.mockResolvedValueOnce(bridge);

    const manager = new MCPManager([makeConfig("srv1")]);
    try {
      await manager.start();

      const result = await manager.callTool(
        "srv1",
        "toolA",
        args,
        { signal: controller.signal, callId, onProgress },
      );
      expect(result).toBe(canonicalResult);
      expect(exactExecute).toHaveBeenCalledOnce();
      expect(prefixExecute).not.toHaveBeenCalled();
      expect(suffixExecute).not.toHaveBeenCalled();
      const executionArgs = exactExecute.mock.calls[0]?.[0];
      expect(executionArgs).not.toBe(args);
      expect(executionArgs).toEqual({ value: 42 });
      expect(Object.keys(executionArgs ?? {})).toEqual(["value"]);
      expect(
        Object.hasOwn(executionArgs ?? {}, "__sandboxExecutionBroker"),
      ).toBe(false);
      expect(
        Object.hasOwn(executionArgs ?? {}, "__agencFutureSecret"),
      ).toBe(false);
      expect(
        Object.getOwnPropertyDescriptor(executionArgs, "__abortSignal"),
      ).toEqual(
        expect.objectContaining({
          value: controller.signal,
          enumerable: false,
          writable: false,
        }),
      );
      expect(
        Object.getOwnPropertyDescriptor(executionArgs, "__callId"),
      ).toEqual(
        expect.objectContaining({
          value: callId,
          enumerable: false,
          writable: false,
        }),
      );
      expect(
        Object.getOwnPropertyDescriptor(executionArgs, "__onProgress"),
      ).toEqual(
        expect.objectContaining({
          value: onProgress,
          enumerable: false,
          writable: false,
        }),
      );
      expect(args.__abortSignal).toBe(spoofedSignal);
      expect(args.__callId).toBe("model-visible-spoof");
      expect(args.__onProgress).toBe(spoofedProgress);
      expect(args.__agencFutureSecret).toBe(
        "must-not-cross-manager-boundary",
      );
    } finally {
      await manager.stop();
    }
  });

  it("keeps manager-owned tool calls on the replacement bridge after automatic reconnect", async () => {
    vi.useFakeTimers();
    const initialExecute = vi.fn().mockResolvedValue({
      content: "transport closed",
      isError: true,
    });
    const replacementExecute = vi
      .fn()
      .mockResolvedValue({ content: "from replacement" });
    const initialBridge = makeMockBridge("srv1", ["tool"]);
    initialBridge.tools[0]!.execute = initialExecute;
    const replacementBridge = makeMockBridge("srv1", ["tool"]);
    replacementBridge.tools[0]!.execute = replacementExecute;
    mockCreateMCPConnection
      .mockResolvedValueOnce({ close: vi.fn().mockResolvedValue(undefined) })
      .mockResolvedValueOnce({ close: vi.fn().mockResolvedValue(undefined) });
    mockCreateToolBridge
      .mockResolvedValueOnce(initialBridge)
      .mockResolvedValueOnce(replacementBridge);

    const manager = new MCPManager([makeConfig("srv1")]);
    try {
      await manager.start();

      await expect(manager.callTool("srv1", "tool", {})).resolves.toEqual({
        content: 'MCP server "srv1" lost connection — reconnecting...',
        isError: true,
      });
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(manager.callTool("srv1", "tool", {})).resolves.toEqual({
        content: "from replacement",
      });

      expect(initialExecute).toHaveBeenCalledOnce();
      expect(replacementExecute).toHaveBeenCalledOnce();
    } finally {
      await manager.stop();
      vi.useRealTimers();
    }
  });

  it("fails closed when a manager-owned MCP call has no exact live tool", async () => {
    const bridge = makeMockBridge("srv1", ["known"]);
    const execute = vi.mocked(bridge.tools[0]!.execute);
    mockCreateMCPConnection.mockResolvedValueOnce("client1");
    mockCreateToolBridge.mockResolvedValueOnce(bridge);

    const manager = new MCPManager([makeConfig("srv1")]);
    try {
      await manager.start();

      await expect(manager.callTool("srv1", "unknown", {})).resolves.toEqual({
        content: 'MCP tool "unknown" is not available on server "srv1"',
        isError: true,
      });
      await expect(manager.callTool("missing", "known", {})).resolves.toEqual({
        content: 'MCP server "missing" is not connected',
        isError: true,
      });
      const cancellation = new Error("cancelled before MCP dispatch");
      const controller = new AbortController();
      controller.abort(cancellation);
      await expect(
        manager.callTool("srv1", "known", {}, { signal: controller.signal }),
      ).rejects.toBe(cancellation);
      await expect(
        manager.callTool("missing", "known", {}, { signal: controller.signal }),
      ).rejects.toBe(cancellation);
      expect(execute).not.toHaveBeenCalled();
    } finally {
      await manager.stop();
    }
  });

  it("getConnectedServers returns server names", async () => {
    const bridge1 = makeMockBridge("alpha", []);
    const bridge2 = makeMockBridge("beta", []);

    mockCreateMCPConnection
      .mockResolvedValueOnce("c1")
      .mockResolvedValueOnce("c2");
    mockCreateToolBridge
      .mockResolvedValueOnce(bridge1)
      .mockResolvedValueOnce(bridge2);

    const manager = new MCPManager([makeConfig("alpha"), makeConfig("beta")]);
    await manager.start();

    expect(manager.getConnectedServers()).toEqual(["alpha", "beta"]);
  });

  it("reconnects a configured enabled server in place", async () => {
    const initialBridge = makeMockBridge("srv1", ["toolA"]);
    const nextBridge = makeMockBridge("srv1", ["toolB", "toolC"]);

    mockCreateMCPConnection
      .mockResolvedValueOnce("client1")
      .mockResolvedValueOnce("client2");
    mockCreateToolBridge
      .mockResolvedValueOnce(initialBridge)
      .mockResolvedValueOnce(nextBridge);

    const manager = new MCPManager([makeConfig("srv1")]);
    await manager.start();

    const result = await manager.reconnectServer("srv1");

    expect(result).toEqual({
      serverName: "srv1",
      success: true,
      toolCount: 2,
    });
    expect(initialBridge.dispose).toHaveBeenCalledOnce();
    expect(manager.getToolsByServer("srv1").map((tool) => tool.name)).toEqual([
      "mcp.srv1.toolB",
      "mcp.srv1.toolC",
    ]);
  });

  it("strict quiesce waits for an in-flight dynamic reconnect", async () => {
    const oldCwd = resolve("dynamic-reconnect-old");
    const newCwd = resolve("dynamic-reconnect-new");
    const broker = new SandboxExecutionBroker({
      mode: "danger_full_access",
      cwd: oldCwd,
    });
    let resolveDynamic:
      | ((client: { close: ReturnType<typeof vi.fn> }) => void)
      | undefined;
    const dynamicClient = { close: vi.fn().mockResolvedValue(undefined) };
    mockCreateMCPConnection
      .mockResolvedValueOnce({ close: vi.fn().mockResolvedValue(undefined) })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveDynamic = resolve;
          }),
      )
      .mockResolvedValueOnce({ close: vi.fn().mockResolvedValue(undefined) });
    mockCreateToolBridge
      .mockResolvedValueOnce(makeMockBridge("srv1", ["initial"]))
      .mockResolvedValueOnce(makeMockBridge("srv1", ["recovered"]));

    const manager = new MCPManager([makeConfig("srv1")]);
    manager.setSandboxExecutionBroker(broker);
    const quiesceObserved = deferred();
    const unregisterQuiesceObserver =
      registerSandboxExecutionLifecycleParticipant(broker, {
        name: "dynamic-reconnect-transition-observer",
        quiesce: async () => quiesceObserved.resolve(),
        resume: async () => {},
      });
    await manager.start();
    const reconnecting = manager.reconnectServer("srv1");
    await vi.waitFor(() => {
      expect(mockCreateMCPConnection).toHaveBeenCalledTimes(2);
    });

    let transitioned = false;
    const transition = transitionSandboxExecutionBroker(broker, newCwd).then(
      () => {
        transitioned = true;
      },
    );
    await quiesceObserved.promise;
    expect(transitioned).toBe(false);
    expect(broker.cwd).toBe(oldCwd);

    resolveDynamic?.(dynamicClient);
    await expect(reconnecting).resolves.toMatchObject({ success: false });
    await transition;

    expect(dynamicClient.close).toHaveBeenCalledOnce();
    expect(broker.cwd).toBe(newCwd);
    expect(manager.getTools()[0]?.name).toBe("mcp.srv1.recovered");

    await manager.stop();
    unregisterQuiesceObserver();
    manager.setSandboxExecutionBroker(undefined);
  });

  it("does not connect after stop wins a reconnect disconnect race", async () => {
    const oldCwd = resolve("reconnect-disconnect-old");
    const newCwd = resolve("reconnect-disconnect-new");
    const broker = new SandboxExecutionBroker({
      mode: "danger_full_access",
      cwd: oldCwd,
    });
    let releaseDisconnect: (() => void) | undefined;
    const initialBridge = makeMockBridge("srv1", ["initial"]);
    initialBridge.dispose.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseDisconnect = resolve;
        }),
    );
    mockCreateMCPConnection
      .mockResolvedValueOnce({ close: vi.fn().mockResolvedValue(undefined) })
      .mockResolvedValueOnce({ close: vi.fn().mockResolvedValue(undefined) });
    mockCreateToolBridge
      .mockResolvedValueOnce(initialBridge)
      .mockResolvedValueOnce(makeMockBridge("srv1", ["recovered"]));

    const manager = new MCPManager([makeConfig("srv1")]);
    manager.setSandboxExecutionBroker(broker);
    await manager.start();
    const reconnecting = manager.reconnectServer("srv1");
    await vi.waitFor(() => {
      expect(initialBridge.dispose).toHaveBeenCalledOnce();
    });

    let transitioned = false;
    const transition = transitionSandboxExecutionBroker(broker, newCwd).then(
      () => {
        transitioned = true;
      },
    );
    await Promise.resolve();
    expect(transitioned).toBe(false);
    expect(mockCreateMCPConnection).toHaveBeenCalledOnce();

    releaseDisconnect?.();
    await expect(reconnecting).resolves.toMatchObject({ success: false });
    await transition;

    expect(broker.cwd).toBe(newCwd);
    expect(mockCreateMCPConnection).toHaveBeenCalledTimes(2);
    expect(mockCreateToolBridge).toHaveBeenCalledTimes(2);
    expect(manager.getTools()[0]?.name).toBe("mcp.srv1.recovered");

    await manager.stop();
    manager.setSandboxExecutionBroker(undefined);
  });

  it("propagates reconnect disconnect cleanup failure into strict quiesce", async () => {
    const oldCwd = resolve("reconnect-cleanup-old");
    const broker = new SandboxExecutionBroker({
      mode: "danger_full_access",
      cwd: oldCwd,
    });
    let rejectDisconnect: ((error: Error) => void) | undefined;
    const initialBridge = makeMockBridge("srv1", ["initial"]);
    initialBridge.dispose.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectDisconnect = reject;
        }),
    );
    mockCreateMCPConnection.mockResolvedValueOnce({
      close: vi.fn().mockResolvedValue(undefined),
    });
    mockCreateToolBridge.mockResolvedValueOnce(initialBridge);

    const manager = new MCPManager([makeConfig("srv1")]);
    manager.setSandboxExecutionBroker(broker);
    await manager.start();
    const reconnecting = manager.reconnectServer("srv1");
    await vi.waitFor(() => {
      expect(initialBridge.dispose).toHaveBeenCalledOnce();
    });
    const transition = transitionSandboxExecutionBroker(
      broker,
      resolve("reconnect-cleanup-new"),
    );

    rejectDisconnect?.(new Error("old process tree survived"));
    await expect(reconnecting).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining("connection cleanup failed"),
    });
    await expect(transition).rejects.toThrow(
      /recovery resume failed and broker was closed/u,
    );

    expect(broker.cwd).toBe(oldCwd);
    await expectMcpAuthorityPermanentlyClosed(manager, broker, "srv1");
    expect(mockCreateMCPConnection).toHaveBeenCalledOnce();
    await manager.stop();
    manager.setSandboxExecutionBroker(undefined);
  });

  it("retains settled reconnect cleanup failure and blocks every replacement", async () => {
    const oldCwd = resolve("settled-reconnect-cleanup-old");
    const broker = new SandboxExecutionBroker({
      mode: "danger_full_access",
      cwd: oldCwd,
    });
    const initialBridge = makeMockBridge("srv1", ["initial"]);
    initialBridge.dispose.mockRejectedValue(
      new Error("old process tree still owns authority"),
    );
    mockCreateMCPConnection.mockResolvedValueOnce({
      close: vi.fn().mockResolvedValue(undefined),
    });
    mockCreateToolBridge.mockResolvedValueOnce(initialBridge);

    const manager = new MCPManager([makeConfig("srv1")]);
    manager.setSandboxExecutionBroker(broker);
    await manager.start();

    await expect(manager.reconnectServer("srv1")).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining("connection cleanup failed"),
    });
    expect(mockCreateMCPConnection).toHaveBeenCalledOnce();

    await expect(
      transitionSandboxExecutionBroker(
        broker,
        resolve("settled-reconnect-cleanup-new"),
      ),
    ).rejects.toThrow(/recovery resume failed and broker was closed/u);
    expect(broker.cwd).toBe(oldCwd);
    await expectMcpAuthorityPermanentlyClosed(manager, broker, "srv1");
    expect(mockCreateMCPConnection).toHaveBeenCalledOnce();

    await manager.stop();
    manager.setSandboxExecutionBroker(undefined);
  });

  it("poisons replacement after pre-client transport cleanup fails", async () => {
    const oldCwd = resolve("pre-client-cleanup-old");
    const broker = new SandboxExecutionBroker({
      mode: "danger_full_access",
      cwd: oldCwd,
    });
    const transportCleanupError = new MCPTransportCleanupError(
      new Error("initialize failed"),
      new Error("transport close failed"),
      'MCP stdio server "srv1"',
    );
    mockCreateMCPConnection.mockRejectedValueOnce(transportCleanupError);

    const manager = new MCPManager([makeConfig("srv1")]);
    manager.setSandboxExecutionBroker(broker);
    await manager.start();

    expect(manager.getConnectionState("srv1")).toEqual({
      type: "failed",
      error: expect.stringContaining("connection cleanup failed"),
    });
    await expect(
      transitionSandboxExecutionBroker(
        broker,
        resolve("pre-client-cleanup-new"),
      ),
    ).rejects.toThrow(/recovery resume failed and broker was closed/u);
    await expectMcpAuthorityPermanentlyClosed(manager, broker, "srv1");
    expect(mockCreateMCPConnection).toHaveBeenCalledOnce();
    expect(broker.cwd).toBe(oldCwd);

    await manager.stop();
    manager.setSandboxExecutionBroker(undefined);
  });

  it("clears retained cleanup only after a retry proves disposal", async () => {
    const oldCwd = resolve("retryable-reconnect-cleanup-old");
    const newCwd = resolve("retryable-reconnect-cleanup-new");
    const broker = new SandboxExecutionBroker({
      mode: "danger_full_access",
      cwd: oldCwd,
    });
    const initialBridge = makeMockBridge("srv1", ["initial"]);
    const retryableResourceBridge = makeMockResourceBridge("srv1");
    retryableResourceBridge.dispose
      .mockRejectedValueOnce(new Error("resource cleanup raced"))
      .mockResolvedValue(undefined);
    mockCreateMCPConnection
      .mockResolvedValueOnce({ close: vi.fn().mockResolvedValue(undefined) })
      .mockResolvedValueOnce({ close: vi.fn().mockResolvedValue(undefined) });
    mockCreateToolBridge
      .mockResolvedValueOnce(initialBridge)
      .mockResolvedValueOnce(makeMockBridge("srv1", ["recovered"]));
    mockCreateResourceBridge.mockResolvedValueOnce(retryableResourceBridge);

    const manager = new MCPManager([makeConfig("srv1")]);
    manager.setSandboxExecutionBroker(broker);
    await manager.start();

    await expect(manager.reconnectServer("srv1")).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining("connection cleanup failed"),
    });
    expect(retryableResourceBridge.dispose).toHaveBeenCalledOnce();
    expect(mockCreateMCPConnection).toHaveBeenCalledOnce();

    await expect(
      transitionSandboxExecutionBroker(broker, newCwd),
    ).resolves.toBeUndefined();

    expect(retryableResourceBridge.dispose).toHaveBeenCalledTimes(2);
    expect(mockCreateMCPConnection).toHaveBeenCalledTimes(2);
    expect(manager.getTools()[0]?.name).toBe("mcp.srv1.recovered");
    expect(broker.cwd).toBe(newCwd);

    await manager.stop();
    manager.setSandboxExecutionBroker(undefined);
  });

  it("passes permission options into initial and reconnected tool bridges", async () => {
    const initialBridge = makeMockBridge("srv1", ["toolA"]);
    const nextBridge = makeMockBridge("srv1", ["toolB"]);
    const permissionOptions: MCPToolBridgePermissionOptions = {
      getActiveTurnId: () => "turn-1",
    };

    mockCreateMCPConnection
      .mockResolvedValueOnce("client1")
      .mockResolvedValueOnce("client2");
    mockCreateToolBridge
      .mockResolvedValueOnce(initialBridge)
      .mockResolvedValueOnce(nextBridge);

    const manager = new MCPManager([makeConfig("srv1")]);
    manager.setPermissionOptions(permissionOptions);
    await manager.start();
    await manager.reconnectServer("srv1");

    expect(mockCreateToolBridge.mock.calls[0]?.[3]).toEqual(
      expect.objectContaining({ permissions: permissionOptions }),
    );
    expect(mockCreateToolBridge.mock.calls[1]?.[3]).toEqual(
      expect.objectContaining({ permissions: permissionOptions }),
    );
  });

  it("rejects reconnect for unknown or disabled servers", async () => {
    const manager = new MCPManager([makeConfig("srv1", { enabled: false })]);

    await expect(manager.reconnectServer("missing")).resolves.toEqual({
      serverName: "missing",
      success: false,
      toolCount: 0,
      error: 'MCP server "missing" is not configured.',
    });
    await expect(manager.reconnectServer("srv1")).resolves.toEqual({
      serverName: "srv1",
      success: false,
      toolCount: 0,
      error: 'MCP server "srv1" is disabled in config.',
    });
  });

  it("failed reconnect leaves the server disconnected", async () => {
    const initialBridge = makeMockBridge("srv1", ["toolA"]);
    mockCreateMCPConnection
      .mockResolvedValueOnce("client1")
      .mockRejectedValueOnce(new Error("refused"));
    mockCreateToolBridge.mockResolvedValueOnce(initialBridge);

    const manager = new MCPManager([makeConfig("srv1")]);
    await manager.start();
    const result = await manager.reconnectServer("srv1");

    expect(result).toEqual({
      serverName: "srv1",
      success: false,
      toolCount: 0,
      error: "refused",
    });
    expect(initialBridge.dispose).toHaveBeenCalledOnce();
    expect(manager.getConnectedServers()).toEqual([]);
    expect(manager.getToolsByServer("srv1")).toEqual([]);
    expect(manager.getConnectionState("srv1")).toEqual({
      type: "failed",
      error: "refused",
    });
  });

  // --------------------------------------------------------------------------
  // T9 D: I-20 (aggregate failure) + I-50 (cancellable) + I-73 (name shadowing)
  // --------------------------------------------------------------------------

  it("I-20: requireOneReady hard-fails when zero servers connect", async () => {
    mockCreateMCPConnection
      .mockRejectedValueOnce(new Error("refused"))
      .mockRejectedValueOnce(new Error("refused"));
    const manager = new MCPManager([makeConfig("a"), makeConfig("b")]);
    await expect(manager.start({ requireOneReady: true })).rejects.toThrow(
      /aggregate startup failure/,
    );
  });

  it("I-20: requireOneReady succeeds when at least one connects", async () => {
    const bridge = makeMockBridge("b", ["t"]);
    mockCreateMCPConnection
      .mockRejectedValueOnce(new Error("refused"))
      .mockResolvedValueOnce("client");
    mockCreateToolBridge.mockResolvedValueOnce(bridge);
    const manager = new MCPManager([makeConfig("a"), makeConfig("b")]);
    await expect(
      manager.start({ requireOneReady: true }),
    ).resolves.toBeUndefined();
  });

  it("I-20: requiredServers hard-fails when a named server is missing", async () => {
    const bridge = makeMockBridge("a", []);
    mockCreateMCPConnection
      .mockResolvedValueOnce("ca")
      .mockRejectedValueOnce(new Error("missing b"));
    mockCreateToolBridge.mockResolvedValueOnce(bridge);
    const manager = new MCPManager([makeConfig("a"), makeConfig("b")]);
    await expect(manager.start({ requiredServers: ["b"] })).rejects.toThrow(
      /required server\(s\) not ready/,
    );
  });

  it("I-50: aborted signal throws before first connect", async () => {
    const manager = new MCPManager([makeConfig("a")]);
    const controller = new AbortController();
    controller.abort("user_cancelled");
    await expect(manager.start({ signal: controller.signal })).rejects.toThrow(
      /cancelled before first connect/,
    );
  });

  it("I-50: abort mid-startup skips slow servers but keeps already-connected", async () => {
    const bridge = makeMockBridge("fast", ["t"]);
    const controller = new AbortController();
    mockCreateMCPConnection
      .mockResolvedValueOnce("fast")
      .mockImplementationOnce(
        () =>
          new Promise(() => {
            /* never resolves */
          }),
      );
    mockCreateToolBridge.mockResolvedValueOnce(bridge);
    const manager = new MCPManager([makeConfig("fast"), makeConfig("slow")]);
    const started = manager.start({ signal: controller.signal });
    // Let the fast server complete, then abort.
    await new Promise((r) => setTimeout(r, 20));
    controller.abort("user_cancelled");
    await started;
    expect(manager.getConnectedServers()).toContain("fast");
  });

  it("I-50: aborted slow connects do not register late after start() returns", async () => {
    let resolveSlowClient: ((value: unknown) => void) | undefined;
    const slowClient = {
      close: vi.fn().mockResolvedValue(undefined),
    };
    const controller = new AbortController();
    const fastBridge = makeMockBridge("fast", ["t"]);

    mockCreateMCPConnection
      .mockResolvedValueOnce("fast-client")
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSlowClient = resolve;
          }),
      );
    mockCreateToolBridge.mockResolvedValueOnce(fastBridge);

    const manager = new MCPManager([makeConfig("fast"), makeConfig("slow")]);
    const started = manager.start({ signal: controller.signal });
    await new Promise((r) => setTimeout(r, 20));
    controller.abort("user_cancelled");
    await started;

    expect(manager.getConnectedServers()).toEqual(["fast"]);
    expect(mockCreateToolBridge).toHaveBeenCalledTimes(1);

    resolveSlowClient?.(slowClient);
    for (let i = 0; i < 10 && slowClient.close.mock.calls.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(manager.getConnectedServers()).toEqual(["fast"]);
    expect(mockCreateToolBridge).toHaveBeenCalledTimes(1);
    expect(slowClient.close).toHaveBeenCalledTimes(1);
  });

  it("stop cancels an in-flight start and closes a client that arrives late", async () => {
    let resolveClient:
      ((value: { close: ReturnType<typeof vi.fn> }) => void) | undefined;
    const lateClient = { close: vi.fn().mockResolvedValue(undefined) };
    mockCreateMCPConnection.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveClient = resolve;
        }),
    );

    const manager = new MCPManager([makeConfig("late")]);
    const started = manager.start();
    await vi.waitFor(() => {
      expect(mockCreateMCPConnection).toHaveBeenCalledOnce();
    });

    let stopped = false;
    const stopping = manager.stop().then(() => {
      stopped = true;
    });
    await expect(started).resolves.toBeUndefined();
    await Promise.resolve();
    expect(stopped).toBe(false);

    resolveClient?.(lateClient);
    await stopping;
    await vi.waitFor(() => {
      expect(lateClient.close).toHaveBeenCalledOnce();
    });

    expect(mockCreateToolBridge).not.toHaveBeenCalled();
    expect(manager.getConnectedServers()).toEqual([]);
    expect(manager.getTools()).toEqual([]);
  });

  it("does not publish a tool bridge that finishes after stop", async () => {
    let resolveBridge:
      ((value: ReturnType<typeof makeMockBridge>) => void) | undefined;
    const client = { close: vi.fn().mockResolvedValue(undefined) };
    const lateBridge = makeMockBridge("late", ["tool"]);
    mockCreateMCPConnection.mockResolvedValueOnce(client);
    mockCreateToolBridge.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveBridge = resolve;
        }),
    );

    const manager = new MCPManager([makeConfig("late")]);
    const started = manager.start();
    await vi.waitFor(() => {
      expect(mockCreateToolBridge).toHaveBeenCalledOnce();
    });

    const stopping = manager.stop();
    await expect(started).resolves.toBeUndefined();
    resolveBridge?.(lateBridge);
    await stopping;

    await vi.waitFor(() => {
      expect(client.close).toHaveBeenCalledOnce();
    });
    expect(manager.getConnectedServers()).toEqual([]);
    expect(manager.getTools()).toEqual([]);
  });

  it("I-73: rejects a bridge with a tool name already registered", async () => {
    const b1 = makeMockBridge("srv1", ["duplicate"]);
    // Give srv2 a tool that produces the SAME namespaced name (unusual but
    // tests catch any future registration-collision path — here we stub it
    // by giving srv2 a tool whose namespaced name matches srv1's one).
    const b2 = {
      serverName: "srv2",
      tools: [{ ...b1.tools[0] }], // shares `mcp.srv1.duplicate`
      dispose: vi.fn().mockResolvedValue(undefined),
    };
    mockCreateMCPConnection
      .mockResolvedValueOnce("c1")
      .mockResolvedValueOnce("c2");
    mockCreateToolBridge.mockResolvedValueOnce(b1).mockResolvedValueOnce(b2);
    const manager = new MCPManager([makeConfig("srv1"), makeConfig("srv2")]);
    await manager.start();
    // srv1 should connect; srv2 should fail the name-shadow check.
    expect(manager.getConnectedServers()).toEqual(["srv1"]);
  });

  // --------------------------------------------------------------------------
  // T9-D: MCP resource + prompt bridges
  // --------------------------------------------------------------------------

  it("connect creates resource and prompt bridges alongside tool bridge", async () => {
    const bridge = makeMockBridge("srv1", ["tool"]);
    mockCreateMCPConnection.mockResolvedValueOnce("client1");
    mockCreateToolBridge.mockResolvedValueOnce(bridge);

    const manager = new MCPManager([makeConfig("srv1")]);
    await manager.start();

    expect(mockCreateResourceBridge).toHaveBeenCalledOnce();
    expect(mockCreateResourceBridge).toHaveBeenCalledWith(
      "client1",
      "srv1",
      expect.anything(),
      expect.any(Object),
    );
    expect(mockCreatePromptBridge).toHaveBeenCalledOnce();
    expect(mockCreatePromptBridge).toHaveBeenCalledWith(
      "client1",
      "srv1",
      expect.anything(),
      expect.any(Object),
    );
  });

  it("connect survives a resources construction failure", async () => {
    const bridge = makeMockBridge("srv1", ["tool"]);
    mockCreateMCPConnection.mockResolvedValueOnce("client1");
    mockCreateToolBridge.mockResolvedValueOnce(bridge);
    mockCreateResourceBridge.mockRejectedValueOnce(
      new Error("resource rpc gone"),
    );

    const logger = { info: vi.fn(), error: vi.fn(), warn: vi.fn() };
    const manager = new MCPManager([makeConfig("srv1")], logger as any);
    await manager.start();

    expect(manager.getConnectedServers()).toEqual(["srv1"]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("resource bridge unavailable"),
      expect.any(Error),
    );
    // prompt bridge should still be built
    expect(mockCreatePromptBridge).toHaveBeenCalledOnce();
  });

  it("removes closed-client companions when automatic reconnect replacement fails", async () => {
    vi.useFakeTimers();
    const initialBridge = makeMockBridge("srv1", ["tool"]);
    initialBridge.tools[0]!.execute = vi.fn().mockResolvedValue({
      content: "transport closed",
      isError: true,
    });
    const reconnectedBridge = makeMockBridge("srv1", ["tool"]);
    const oldResource = makeMockResourceBridge("srv1", [
      { uri: "file:///stale" },
    ]);
    const oldPrompt = makeMockPromptBridge("srv1", [{ name: "stale" }]);
    const newPrompt = makeMockPromptBridge("srv1", [{ name: "fresh" }]);
    mockCreateMCPConnection
      .mockResolvedValueOnce({ close: vi.fn().mockResolvedValue(undefined) })
      .mockResolvedValueOnce({ close: vi.fn().mockResolvedValue(undefined) });
    mockCreateToolBridge
      .mockResolvedValueOnce(initialBridge)
      .mockResolvedValueOnce(reconnectedBridge);
    mockCreateResourceBridge
      .mockResolvedValueOnce(oldResource)
      .mockRejectedValueOnce(new Error("resources unavailable after reconnect"));
    mockCreatePromptBridge
      .mockResolvedValueOnce(oldPrompt)
      .mockResolvedValueOnce(newPrompt);

    const manager = new MCPManager([makeConfig("srv1")]);
    try {
      await manager.start();
      await manager.getTools()[0]!.execute({});
      await vi.advanceTimersByTimeAsync(1_000);

      expect(mockCreateToolBridge).toHaveBeenCalledTimes(2);
      expect(await manager.getResources()).toEqual([]);
      expect((await manager.listPrompts()).map((prompt) => prompt.name)).toEqual([
        "fresh",
      ]);
      expect(oldResource.dispose).toHaveBeenCalledOnce();
      expect(oldPrompt.dispose).toHaveBeenCalledOnce();
    } finally {
      await manager.stop();
      vi.useRealTimers();
    }
  });

  it("notifies surface subscribers when automatic reconnect succeeds", async () => {
    vi.useFakeTimers();
    const initialBridge = makeMockBridge("srv1", ["tool"]);
    initialBridge.tools[0]!.execute = vi.fn().mockResolvedValue({
      content: "transport closed",
      isError: true,
    });
    const reconnectedBridge = makeMockBridge("srv1", ["tool"]);
    mockCreateMCPConnection
      .mockResolvedValueOnce({ close: vi.fn().mockResolvedValue(undefined) })
      .mockResolvedValueOnce({ close: vi.fn().mockResolvedValue(undefined) });
    mockCreateToolBridge
      .mockResolvedValueOnce(initialBridge)
      .mockResolvedValueOnce(reconnectedBridge);

    const manager = new MCPManager([makeConfig("srv1")]);
    let unsubscribe = (): void => {};
    try {
      await manager.start();
      const observations: Array<{
        readonly state: unknown;
        readonly tools: readonly string[];
      }> = [];
      unsubscribe = manager.subscribeSurfaceChanges(() => {
        observations.push({
          state: manager.getConnectionState("srv1"),
          tools: manager.getTools().map((tool) => tool.name),
        });
      });

      await manager.getTools()[0]!.execute({});
      expect(observations).toEqual([]);
      await vi.advanceTimersByTimeAsync(1_000);

      expect(mockCreateToolBridge).toHaveBeenCalledTimes(2);
      expect(observations).toEqual([
        {
          state: { type: "connected" },
          tools: ["mcp.srv1.tool"],
        },
      ]);
    } finally {
      unsubscribe();
      await manager.stop();
      vi.useRealTimers();
    }
  });

  it("retains failed automatic reconnect cleanup and blocks replacement", async () => {
    vi.useFakeTimers();
    const oldCwd = resolve("automatic-reconnect-cleanup-old");
    const broker = new SandboxExecutionBroker({
      mode: "danger_full_access",
      cwd: oldCwd,
    });
    const initialBridge = makeMockBridge("srv1", ["tool"]);
    const oldResource = makeMockResourceBridge("srv1", [
      { uri: "file:///stale" },
    ]);
    const oldPrompt = makeMockPromptBridge("srv1", [{ name: "stale" }]);
    initialBridge.tools[0]!.execute = vi.fn().mockResolvedValue({
      content: "transport closed",
      isError: true,
    });
    const cleanupError = new Error("fresh process tree survived close");
    const freshClient = {
      close: vi.fn().mockRejectedValue(cleanupError),
    };
    mockCreateMCPConnection
      .mockResolvedValueOnce({ close: vi.fn().mockResolvedValue(undefined) })
      .mockResolvedValueOnce(freshClient);
    mockCreateToolBridge
      .mockResolvedValueOnce(initialBridge)
      .mockRejectedValueOnce(new Error("fresh catalog rejected"));
    mockCreateResourceBridge.mockResolvedValueOnce(oldResource);
    mockCreatePromptBridge.mockResolvedValueOnce(oldPrompt);

    const manager = new MCPManager([makeConfig("srv1")]);
    manager.setSandboxExecutionBroker(broker);
    try {
      await manager.start();
      expect(await manager.getResources()).toHaveLength(1);
      expect(await manager.listPrompts()).toHaveLength(1);
      await manager.getTools()[0]!.execute({});
      await vi.advanceTimersByTimeAsync(1_000);

      expect(freshClient.close).toHaveBeenCalledOnce();
      expect(manager.getConnectionState("srv1")).toEqual({
        type: "failed",
        error: expect.stringContaining("cleanup remains unproven"),
      });
      expect(manager.getTools()).toEqual([]);
      expect(await manager.getResources()).toEqual([]);
      expect(await manager.listPrompts()).toEqual([]);
      expect(oldResource.dispose).toHaveBeenCalledOnce();
      expect(oldPrompt.dispose).toHaveBeenCalledOnce();

      await expect(
        transitionSandboxExecutionBroker(
          broker,
          resolve("automatic-reconnect-cleanup-new"),
        ),
      ).rejects.toThrow(/recovery resume failed and broker was closed/u);
      expect(broker.cwd).toBe(oldCwd);
      expect(freshClient.close).toHaveBeenCalledTimes(2);
      await expectMcpAuthorityPermanentlyClosed(manager, broker, "srv1");
      expect(mockCreateMCPConnection).toHaveBeenCalledTimes(2);
      expect(freshClient.close).toHaveBeenCalledTimes(2);
    } finally {
      await manager.stop();
      manager.setSandboxExecutionBroker(undefined);
      vi.useRealTimers();
    }
  });

  it("terminally poisons automatic reconnect after typed transport cleanup failure", async () => {
    vi.useFakeTimers();
    const initialBridge = makeMockBridge("srv1", ["tool"]);
    initialBridge.tools[0]!.execute = vi.fn().mockResolvedValue({
      content: "transport closed",
      isError: true,
    });
    const transportCleanupError = new MCPTransportCleanupError(
      new Error("initialize failed"),
      new Error("transport close failed"),
      'MCP stdio server "srv1"',
    );
    mockCreateMCPConnection
      .mockResolvedValueOnce({ close: vi.fn().mockResolvedValue(undefined) })
      .mockRejectedValueOnce(transportCleanupError);
    mockCreateToolBridge.mockResolvedValueOnce(initialBridge);

    const manager = new MCPManager([makeConfig("srv1")]);
    let unsubscribe = (): void => {};
    try {
      await manager.start();
      const observations: Array<{
        readonly state: unknown;
        readonly toolCount: number;
      }> = [];
      unsubscribe = manager.subscribeSurfaceChanges(() => {
        observations.push({
          state: manager.getConnectionState("srv1"),
          toolCount: manager.getTools().length,
        });
      });
      const staleTool = manager.getTools()[0]!;
      await staleTool.execute({});
      await vi.advanceTimersByTimeAsync(1_000);

      expect(manager.getTools()).toEqual([]);
      expect(manager.getConnectionState("srv1")).toEqual({
        type: "failed",
        error: expect.stringContaining("cleanup remains unproven"),
      });
      expect(observations).toEqual([
        {
          state: {
            type: "failed",
            error: expect.stringContaining("cleanup remains unproven"),
          },
          toolCount: 0,
        },
      ]);
      await expect(staleTool.execute({})).resolves.toEqual({
        content: 'MCP server "srv1" cleanup remains unproven',
        isError: true,
      });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(mockCreateMCPConnection).toHaveBeenCalledTimes(2);
    } finally {
      unsubscribe();
      await manager.stop();
      vi.useRealTimers();
    }
  });

  it("getResources flattens descriptors across all connected servers", async () => {
    const bridge1 = makeMockBridge("srv1", ["t1"]);
    const bridge2 = makeMockBridge("srv2", ["t2"]);
    const resourceBridge1 = makeMockResourceBridge("srv1", [
      { uri: "file:///a.txt" },
      { uri: "file:///b.txt" },
    ]);
    const resourceBridge2 = makeMockResourceBridge("srv2", [
      { uri: "file:///c.txt" },
    ]);

    mockCreateMCPConnection
      .mockResolvedValueOnce("c1")
      .mockResolvedValueOnce("c2");
    mockCreateToolBridge
      .mockResolvedValueOnce(bridge1)
      .mockResolvedValueOnce(bridge2);
    mockCreateResourceBridge
      .mockResolvedValueOnce(resourceBridge1)
      .mockResolvedValueOnce(resourceBridge2);

    const manager = new MCPManager([makeConfig("srv1"), makeConfig("srv2")]);
    await manager.start();

    const resources = await manager.getResources();
    expect(resources).toHaveLength(3);
    expect(resources.map((r) => r.namespacedName)).toEqual([
      "mcp.srv1.file:///a.txt",
      "mcp.srv1.file:///b.txt",
      "mcp.srv2.file:///c.txt",
    ]);
  });

  it("readResource routes by namespaced name and returns null for unknown servers", async () => {
    const bridge = makeMockBridge("srv1", ["t"]);
    const resourceBridge = makeMockResourceBridge("srv1");
    resourceBridge.readResource.mockResolvedValueOnce({
      uri: "file:///a.txt",
      text: "hello",
      truncated: false,
      bytesReturned: 5,
    });

    mockCreateMCPConnection.mockResolvedValueOnce("c1");
    mockCreateToolBridge.mockResolvedValueOnce(bridge);
    mockCreateResourceBridge.mockResolvedValueOnce(resourceBridge);

    const manager = new MCPManager([makeConfig("srv1")]);
    await manager.start();

    const content = await manager.readResource("mcp.srv1.file:///a.txt");
    expect(content).toEqual({
      uri: "file:///a.txt",
      text: "hello",
      truncated: false,
      bytesReturned: 5,
    });
    expect(resourceBridge.readResource).toHaveBeenCalledWith("file:///a.txt");

    // Unknown server → null, not an error
    expect(await manager.readResource("mcp.other.anything")).toBeNull();
    // Malformed namespace → null
    expect(await manager.readResource("not-prefixed")).toBeNull();
    expect(await manager.readResource("mcp.srv1.")).toBeNull();
  });

  it("renderPrompt routes by namespaced name and listPrompts fans out", async () => {
    const bridge = makeMockBridge("srv1", ["t"]);
    const promptBridge = makeMockPromptBridge("srv1", [{ name: "summarize" }]);
    promptBridge.renderPrompt.mockResolvedValueOnce({
      promptName: "summarize",
      messages: [{ role: "user", text: "hi" }],
    });

    mockCreateMCPConnection.mockResolvedValueOnce("c1");
    mockCreateToolBridge.mockResolvedValueOnce(bridge);
    mockCreatePromptBridge.mockResolvedValueOnce(promptBridge);

    const manager = new MCPManager([makeConfig("srv1")]);
    await manager.start();

    const prompts = await manager.listPrompts();
    expect(prompts).toHaveLength(1);
    expect(prompts[0].namespacedName).toBe("mcp.srv1.summarize");

    const rendered = await manager.renderPrompt("mcp.srv1.summarize", {
      topic: "x",
    });
    expect(rendered).toEqual({
      promptName: "summarize",
      messages: [{ role: "user", text: "hi" }],
    });
    expect(promptBridge.renderPrompt).toHaveBeenCalledWith("summarize", {
      topic: "x",
    });

    expect(await manager.renderPrompt("mcp.nope.x")).toBeNull();
  });

  it("stop disposes resource and prompt bridges alongside tool bridges", async () => {
    const bridge1 = makeMockBridge("srv1", ["t"]);
    const bridge2 = makeMockBridge("srv2", ["t"]);
    const resourceBridge1 = makeMockResourceBridge("srv1");
    const resourceBridge2 = makeMockResourceBridge("srv2");
    const promptBridge1 = makeMockPromptBridge("srv1");
    const promptBridge2 = makeMockPromptBridge("srv2");

    mockCreateMCPConnection
      .mockResolvedValueOnce("c1")
      .mockResolvedValueOnce("c2");
    mockCreateToolBridge
      .mockResolvedValueOnce(bridge1)
      .mockResolvedValueOnce(bridge2);
    mockCreateResourceBridge
      .mockResolvedValueOnce(resourceBridge1)
      .mockResolvedValueOnce(resourceBridge2);
    mockCreatePromptBridge
      .mockResolvedValueOnce(promptBridge1)
      .mockResolvedValueOnce(promptBridge2);

    const manager = new MCPManager([makeConfig("srv1"), makeConfig("srv2")]);
    await manager.start();
    await manager.stop();

    expect(resourceBridge1.dispose).toHaveBeenCalledOnce();
    expect(resourceBridge2.dispose).toHaveBeenCalledOnce();
    expect(promptBridge1.dispose).toHaveBeenCalledOnce();
    expect(promptBridge2.dispose).toHaveBeenCalledOnce();
    expect(await manager.getResources()).toHaveLength(0);
    expect(await manager.listPrompts()).toHaveLength(0);
  });

  // --------------------------------------------------------------------------
  // getServerForTool + resolveMcpToolInfo
  // --------------------------------------------------------------------------

  it("getServerForTool returns the owning server for a registered tool", async () => {
    const bridge = makeMockBridge("github", ["listIssues", "createPR"]);
    mockCreateMCPConnection.mockResolvedValueOnce("c");
    mockCreateToolBridge.mockResolvedValueOnce(bridge);

    const manager = new MCPManager([makeConfig("github")]);
    await manager.start();

    expect(manager.getServerForTool("mcp.github.listIssues")).toBe("github");
    expect(manager.getServerForTool("mcp.github.doesNotExist")).toBeUndefined();
  });

  it("resolveMcpToolInfo resolves namespaced MCP tool names", async () => {
    const bridge = makeMockBridge("github", ["listIssues"]);
    mockCreateMCPConnection.mockResolvedValueOnce("c");
    mockCreateToolBridge.mockResolvedValueOnce(bridge);

    const manager = new MCPManager([makeConfig("github")]);
    await manager.start();

    expect(manager.resolveMcpToolInfo("mcp.github.listIssues")).toEqual({
      serverName: "github",
      toolName: "listIssues",
    });
    expect(manager.resolveMcpToolInfo("FileRead")).toBeUndefined();
  });
});
