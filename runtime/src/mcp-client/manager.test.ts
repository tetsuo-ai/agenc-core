import { describe, it, expect, vi, beforeEach } from "vitest";
import { MCPManager } from "./manager.js";
import type { MCPServerConfig } from "./types.js";

// Mock the connection and tool-bridge modules
vi.mock("./connection.js", () => ({
  createMCPConnection: vi.fn(),
}));
vi.mock("./tool-bridge.js", () => ({
  createToolBridge: vi.fn(),
}));

import { createMCPConnection } from "./connection.js";
import { createToolBridge } from "./tool-bridge.js";

const mockCreateMCPConnection = vi.mocked(createMCPConnection);
const mockCreateToolBridge = vi.mocked(createToolBridge);

function makeConfig(name: string, overrides?: Partial<MCPServerConfig>): MCPServerConfig {
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
    vi.clearAllMocks();
  });

  // --------------------------------------------------------------------------
  // start()
  // --------------------------------------------------------------------------

  it("connects to all enabled servers", async () => {
    const bridge1 = makeMockBridge("srv1", ["toolA"]);
    const bridge2 = makeMockBridge("srv2", ["toolB", "toolC"]);

    mockCreateMCPConnection.mockResolvedValueOnce("client1").mockResolvedValueOnce("client2");
    mockCreateToolBridge.mockResolvedValueOnce(bridge1).mockResolvedValueOnce(bridge2);

    const manager = new MCPManager([makeConfig("srv1"), makeConfig("srv2")]);
    await manager.start();

    expect(mockCreateMCPConnection).toHaveBeenCalledTimes(2);
    expect(mockCreateToolBridge).toHaveBeenCalledTimes(2);
    expect(manager.getTools()).toHaveLength(3);
    expect(manager.getConnectedServers()).toEqual(["srv1", "srv2"]);
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
  });

  it("does nothing with empty config", async () => {
    const manager = new MCPManager([]);
    await manager.start();

    expect(mockCreateMCPConnection).not.toHaveBeenCalled();
    expect(manager.getTools()).toHaveLength(0);
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

  // --------------------------------------------------------------------------
  // stop()
  // --------------------------------------------------------------------------

  it("disposes all bridges then clears", async () => {
    const bridge1 = makeMockBridge("srv1", ["a"]);
    const bridge2 = makeMockBridge("srv2", ["b"]);

    mockCreateMCPConnection.mockResolvedValueOnce("c1").mockResolvedValueOnce("c2");
    mockCreateToolBridge.mockResolvedValueOnce(bridge1).mockResolvedValueOnce(bridge2);

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

  // --------------------------------------------------------------------------
  // getTools / getToolsByServer / getConnectedServers
  // --------------------------------------------------------------------------

  it("getTools returns flattened tools from all bridges", async () => {
    const bridge1 = makeMockBridge("srv1", ["a", "b"]);
    const bridge2 = makeMockBridge("srv2", ["c"]);

    mockCreateMCPConnection.mockResolvedValueOnce("c1").mockResolvedValueOnce("c2");
    mockCreateToolBridge.mockResolvedValueOnce(bridge1).mockResolvedValueOnce(bridge2);

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

    mockCreateMCPConnection.mockResolvedValueOnce("c1").mockResolvedValueOnce("c2");
    mockCreateToolBridge.mockResolvedValueOnce(bridge1).mockResolvedValueOnce(bridge2);

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

  it("rejects reconnect for unknown or disabled servers", async () => {
    const manager = new MCPManager([
      makeConfig("srv1", { enabled: false }),
    ]);

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
    await expect(manager.start({ requireOneReady: true })).resolves.toBeUndefined();
  });

  it("I-20: requiredServers hard-fails when a named server is missing", async () => {
    const bridge = makeMockBridge("a", []);
    mockCreateMCPConnection
      .mockResolvedValueOnce("ca")
      .mockRejectedValueOnce(new Error("missing b"));
    mockCreateToolBridge.mockResolvedValueOnce(bridge);
    const manager = new MCPManager([makeConfig("a"), makeConfig("b")]);
    await expect(
      manager.start({ requiredServers: ["b"] }),
    ).rejects.toThrow(/required server\(s\) not ready/);
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
        () => new Promise(() => { /* never resolves */ }),
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
});
