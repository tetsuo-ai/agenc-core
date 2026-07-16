import { resolve } from "node:path";

import { describe, it, expect, vi, beforeEach } from "vitest";
import { MCPManager } from "./manager.js";
import type { MCPServerConfig } from "./types.js";
import type { MCPToolBridgePermissionOptions } from "./tools.js";
import { SandboxExecutionBroker } from "../sandbox/execution-broker.js";
import { transitionSandboxExecutionBroker } from "../sandbox/execution-lifecycle.js";
import { MCPTransportCleanupError } from "./transports/connect-with-cleanup.js";

// Mock the connection and tools modules
vi.mock("./connection.js", () => ({
  createMCPConnection: vi.fn(),
}));
vi.mock("./tools.js", () => ({
  createToolBridge: vi.fn(),
}));
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
    ).rejects.toThrow(/old authority restored/);

    expect(broker.cwd).toBe(oldCwd);
    expect(failingBridge.dispose).toHaveBeenCalledOnce();
    expect(manager.getConnectionState("srv1")).toEqual({
      type: "failed",
      error: expect.stringContaining("cleanup remains unproven"),
    });
    expect(manager.getConnectedServers()).toEqual([]);

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
    await Promise.resolve();
    expect(transitioned).toBe(false);
    expect(broker.cwd).toBe(oldCwd);

    resolveDynamic?.(dynamicClient);
    await expect(reconnecting).resolves.toMatchObject({ success: false });
    await transition;

    expect(dynamicClient.close).toHaveBeenCalledOnce();
    expect(broker.cwd).toBe(newCwd);
    expect(manager.getTools()[0]?.name).toBe("mcp.srv1.recovered");

    await manager.stop();
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
    await expect(transition).rejects.toThrow(/old authority restored/);

    expect(broker.cwd).toBe(oldCwd);
    expect(manager.getTools()).toEqual([]);
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
    ).rejects.toThrow(/quiesce failed; old authority restored/);
    expect(broker.cwd).toBe(oldCwd);

    await expect(manager.reconnectServer("srv1")).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining("connection cleanup failed"),
    });
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
    ).rejects.toThrow(/quiesce failed; old authority restored/);
    await expect(manager.reconnectServer("srv1")).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining("connection cleanup failed"),
    });
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

  it("enables a configured disabled server and connects it", async () => {
    const bridge = makeMockBridge("srv1", ["toolA"]);
    mockCreateMCPConnection.mockResolvedValueOnce("client1");
    mockCreateToolBridge.mockResolvedValueOnce(bridge);

    const manager = new MCPManager([makeConfig("srv1", { enabled: false })]);
    const result = await manager.enableServer("srv1");

    expect(result).toEqual({
      serverName: "srv1",
      success: true,
      toolCount: 1,
    });
    expect(manager.getConnectedServers()).toEqual(["srv1"]);
    expect(manager.getServerConfig("srv1")?.enabled).toBe(true);
  });

  it("disables a configured server and disposes all live bridges", async () => {
    const bridge = makeMockBridge("srv1", ["toolA"]);
    const resourceBridge = makeMockResourceBridge("srv1", [
      { uri: "file://a" },
    ]);
    const promptBridge = makeMockPromptBridge("srv1", [{ name: "prompt" }]);
    mockCreateMCPConnection.mockResolvedValueOnce("client1");
    mockCreateToolBridge.mockResolvedValueOnce(bridge);
    mockCreateResourceBridge.mockResolvedValueOnce(resourceBridge);
    mockCreatePromptBridge.mockResolvedValueOnce(promptBridge);

    const manager = new MCPManager([makeConfig("srv1")]);
    await manager.start();
    const result = await manager.disableServer("srv1");

    expect(result).toEqual({
      serverName: "srv1",
      success: true,
      toolCount: 0,
    });
    expect(bridge.dispose).toHaveBeenCalledOnce();
    expect(resourceBridge.dispose).toHaveBeenCalledOnce();
    expect(promptBridge.dispose).toHaveBeenCalledOnce();
    expect(manager.getConnectedServers()).toEqual([]);
    expect(manager.getToolsByServer("srv1")).toEqual([]);
    expect(manager.getServerConfig("srv1")?.enabled).toBe(false);
  });

  it("adds a session server and rejects duplicate or invalid names", async () => {
    const bridge = makeMockBridge("added", ["toolA"]);
    mockCreateMCPConnection.mockResolvedValueOnce("client1");
    mockCreateToolBridge.mockResolvedValueOnce(bridge);

    const manager = new MCPManager([]);
    await expect(
      manager.addServer({ name: "bad name", command: "node", args: [] }),
    ).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining("Invalid MCP server name"),
    });

    await expect(
      manager.addServer({
        name: "added",
        command: "node",
        args: ["server.js"],
      }),
    ).resolves.toEqual({
      serverName: "added",
      success: true,
      toolCount: 1,
    });
    expect(manager.getServerConfig("added")).toMatchObject({
      name: "added",
      command: "node",
      args: ["server.js"],
    });
    await expect(
      manager.addServer({ name: "added", command: "node", args: [] }),
    ).resolves.toMatchObject({
      success: false,
      error: 'MCP server "added" is already configured.',
    });
  });

  it("rolls back a failed session add so the server name can be retried", async () => {
    const bridge = makeMockBridge("added", ["toolA"]);
    mockCreateMCPConnection
      .mockRejectedValueOnce(new Error("no such command"))
      .mockResolvedValueOnce("client1");
    mockCreateToolBridge.mockResolvedValueOnce(bridge);

    const manager = new MCPManager([]);
    await expect(
      manager.addServer({ name: "added", command: "missing", args: [] }),
    ).resolves.toEqual({
      serverName: "added",
      success: false,
      toolCount: 0,
      error: "no such command",
    });
    expect(manager.getServerConfig("added")).toBeUndefined();

    await expect(
      manager.addServer({
        name: "added",
        command: "node",
        args: ["server.js"],
      }),
    ).resolves.toEqual({
      serverName: "added",
      success: true,
      toolCount: 1,
    });
    expect(manager.getServerConfig("added")).toMatchObject({
      name: "added",
      command: "node",
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
      ).rejects.toThrow(/quiesce failed; old authority restored/);
      expect(broker.cwd).toBe(oldCwd);
      expect(freshClient.close).toHaveBeenCalledTimes(2);

      await expect(manager.reconnectServer("srv1")).resolves.toMatchObject({
        success: false,
        error: expect.stringContaining("connection cleanup failed"),
      });
      expect(mockCreateMCPConnection).toHaveBeenCalledTimes(2);
      expect(freshClient.close).toHaveBeenCalledTimes(3);
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
    try {
      await manager.start();
      const staleTool = manager.getTools()[0]!;
      await staleTool.execute({});
      await vi.advanceTimersByTimeAsync(1_000);

      expect(manager.getTools()).toEqual([]);
      expect(manager.getConnectionState("srv1")).toEqual({
        type: "failed",
        error: expect.stringContaining("cleanup remains unproven"),
      });
      await expect(staleTool.execute({})).resolves.toEqual({
        content: 'MCP server "srv1" cleanup remains unproven',
        isError: true,
      });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(mockCreateMCPConnection).toHaveBeenCalledTimes(2);
    } finally {
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
