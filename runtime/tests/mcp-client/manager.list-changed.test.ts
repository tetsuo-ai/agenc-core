import { describe, it, expect, vi, beforeEach } from "vitest";
import { MCPManager } from "./manager.js";
import type { MCPServerConfig } from "./types.js";

interface MCPListChangedHandlers {
  readonly onToolsListChanged: () => void;
  readonly onPromptsListChanged: () => void;
  readonly onResourcesListChanged: () => void;
}

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

function makeMockResourceBridge(
  serverName: string,
  resources: Array<{ uri: string; name?: string }> = [],
) {
  let current = resources;
  return {
    serverName,
    listResources: vi.fn().mockImplementation(async () =>
      current.map((r) => ({
        serverName,
        uri: r.uri,
        namespacedName: `mcp.${serverName}.${r.uri}`,
        ...(r.name !== undefined ? { name: r.name } : {}),
      })),
    ),
    refreshResources: vi.fn().mockImplementation(async () =>
      current.map((r) => ({
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
    setResources(next: Array<{ uri: string; name?: string }>) {
      current = next;
    },
  };
}

function makeMockPromptBridge(
  serverName: string,
  prompts: Array<{ name: string }> = [],
) {
  let current = prompts;
  return {
    serverName,
    listPrompts: vi.fn().mockImplementation(async () =>
      current.map((p) => ({
        serverName,
        name: p.name,
        namespacedName: `mcp.${serverName}.${p.name}`,
      })),
    ),
    refreshPrompts: vi.fn().mockImplementation(async () =>
      current.map((p) => ({
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
    setPrompts(next: Array<{ name: string }>) {
      current = next;
    },
  };
}

function listChangedHandlersFromLastConnect(): MCPListChangedHandlers {
  const call = mockCreateMCPConnection.mock.calls.at(-1);
  const handlers = call?.[6] as MCPListChangedHandlers | undefined;
  if (handlers === undefined) {
    throw new Error("createMCPConnection was not given listChanged handlers");
  }
  return handlers;
}

function testLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

async function waitForTools(manager: MCPManager, names: readonly string[]) {
  await vi.waitFor(() => {
    expect(manager.getTools().map((tool) => tool.name)).toEqual([...names]);
  });
}

describe("MCPManager list_changed catalog refresh", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockCreateResourceBridge.mockImplementation((_client, serverName) =>
      Promise.resolve(makeMockResourceBridge(serverName)),
    );
    mockCreatePromptBridge.mockImplementation((_client, serverName) =>
      Promise.resolve(makeMockPromptBridge(serverName)),
    );
  });

  it("registers listChanged handlers on the connection used at start", async () => {
    mockCreateMCPConnection.mockResolvedValueOnce({ close: vi.fn() });
    mockCreateToolBridge.mockResolvedValueOnce(makeMockBridge("srv1", ["toolA"]));
    const manager = new MCPManager([makeConfig("srv1")]);
    await manager.start();
    const handlers = listChangedHandlersFromLastConnect();
    expect(typeof handlers.onToolsListChanged).toBe("function");
    expect(typeof handlers.onPromptsListChanged).toBe("function");
    expect(typeof handlers.onResourcesListChanged).toBe("function");
    await manager.stop();
  });

  it("replaces the published tool surface without reconnecting", async () => {
    const initial = makeMockBridge("srv1", ["toolA"]);
    const refreshed = makeMockBridge("srv1", ["toolB"]);
    mockCreateMCPConnection.mockResolvedValue({ close: vi.fn() });
    mockCreateToolBridge
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(refreshed);

    const manager = new MCPManager([makeConfig("srv1")]);
    const observations: string[][] = [];
    const unsubscribe = manager.subscribeSurfaceChanges(() => {
      observations.push(manager.getTools().map((tool) => tool.name));
    });
    try {
      await manager.start();
      expect(manager.getTools().map((tool) => tool.name)).toEqual([
        "mcp.srv1.toolA",
      ]);

      listChangedHandlersFromLastConnect().onToolsListChanged();
      await waitForTools(manager, ["mcp.srv1.toolB"]);
      expect(mockCreateMCPConnection).toHaveBeenCalledOnce();
      expect(mockCreateToolBridge).toHaveBeenCalledTimes(2);
      expect(mockCreateToolBridge.mock.calls[1]?.[3]).toMatchObject({
        ownClient: false,
      });
      expect(observations.at(-1)).toEqual(["mcp.srv1.toolB"]);
      await expect(
        manager.callTool("srv1", "toolB", {}),
      ).resolves.toEqual({ content: "ok" });
      await expect(manager.callTool("srv1", "toolA", {})).resolves.toEqual({
        content: expect.stringContaining("not available"),
        isError: true,
      });
    } finally {
      unsubscribe();
      await manager.stop();
    }
  });

  it("refreshes public prompt and resource lists after their notifications", async () => {
    const tools = makeMockBridge("srv1", ["toolA"]);
    const resources = makeMockResourceBridge("srv1", [{ uri: "file:///a" }]);
    const prompts = makeMockPromptBridge("srv1", [{ name: "promptA" }]);
    mockCreateMCPConnection.mockResolvedValue({ close: vi.fn() });
    mockCreateToolBridge.mockResolvedValue(tools);
    mockCreateResourceBridge.mockResolvedValue(resources);
    mockCreatePromptBridge.mockResolvedValue(prompts);

    const manager = new MCPManager([makeConfig("srv1")]);
    try {
      await manager.start();
      expect((await manager.getResources()).map((item) => item.uri)).toEqual([
        "file:///a",
      ]);
      expect((await manager.listPrompts()).map((item) => item.name)).toEqual([
        "promptA",
      ]);

      resources.setResources([{ uri: "file:///b" }]);
      prompts.setPrompts([{ name: "promptB" }]);
      const handlers = listChangedHandlersFromLastConnect();
      handlers.onResourcesListChanged();
      handlers.onPromptsListChanged();

      await vi.waitFor(async () => {
        expect(resources.refreshResources).toHaveBeenCalled();
        expect(prompts.refreshPrompts).toHaveBeenCalled();
      });
      expect((await manager.getResources()).map((item) => item.uri)).toEqual([
        "file:///b",
      ]);
      expect((await manager.listPrompts()).map((item) => item.name)).toEqual([
        "promptB",
      ]);
    } finally {
      await manager.stop();
    }
  });

  it("keeps the prior tool surface when a refresh fails policy checks", async () => {
    const logger = testLogger();
    const initial = makeMockBridge("srv1", ["toolA"]);
    mockCreateMCPConnection.mockResolvedValue({ close: vi.fn() });
    mockCreateToolBridge
      .mockResolvedValueOnce(initial)
      .mockRejectedValueOnce(new Error("catalog digest mismatch"));

    const manager = new MCPManager([makeConfig("srv1")], logger);
    const observations: string[][] = [];
    const unsubscribe = manager.subscribeSurfaceChanges(() => {
      observations.push(manager.getTools().map((tool) => tool.name));
    });
    try {
      await manager.start();
      const before = observations.length;
      listChangedHandlersFromLastConnect().onToolsListChanged();
      await vi.waitFor(() => {
        expect(logger.warn).toHaveBeenCalledWith(
          expect.stringContaining("catalog refresh failed"),
          expect.any(Error),
        );
      });
      expect(manager.getTools().map((tool) => tool.name)).toEqual([
        "mcp.srv1.toolA",
      ]);
      expect(observations.length).toBe(before);
    } finally {
      unsubscribe();
      await manager.stop();
    }
  });

  it("does not publish added tools that fail name-collision checks", async () => {
    const logger = testLogger();
    const srv1 = makeMockBridge("srv1", ["shared"]);
    const srv2Initial = makeMockBridge("srv2", ["unique"]);
    const srv2Collision = {
      serverName: "srv2",
      tools: [{ ...srv1.tools[0]! }],
      dispose: vi.fn().mockResolvedValue(undefined),
    };
    mockCreateMCPConnection.mockResolvedValue({ close: vi.fn() });
    mockCreateToolBridge
      .mockResolvedValueOnce(srv1)
      .mockResolvedValueOnce(srv2Initial)
      .mockResolvedValueOnce(srv2Collision);

    const manager = new MCPManager(
      [makeConfig("srv1"), makeConfig("srv2")],
      logger,
    );
    try {
      await manager.start();
      const srv2Handlers = mockCreateMCPConnection.mock.calls[1]?.[6] as
        | MCPListChangedHandlers
        | undefined;
      expect(srv2Handlers).toBeDefined();
      srv2Handlers!.onToolsListChanged();
      await vi.waitFor(() => {
        expect(logger.warn).toHaveBeenCalledWith(
          expect.stringContaining("catalog refresh failed"),
          expect.any(Error),
        );
      });
      expect(manager.getTools().map((tool) => tool.name).sort()).toEqual([
        "mcp.srv1.shared",
        "mcp.srv2.unique",
      ]);
    } finally {
      await manager.stop();
    }
  });

  it("keeps prior prompt and resource lists when a strict refresh fails", async () => {
    const logger = testLogger();
    const tools = makeMockBridge("srv1", ["toolA"]);
    const resources = makeMockResourceBridge("srv1", [{ uri: "file:///a" }]);
    const prompts = makeMockPromptBridge("srv1", [{ name: "promptA" }]);
    resources.refreshResources.mockImplementation(() =>
      Promise.reject(
        new Error('MCP server "srv1" repeated a resources/list cursor'),
      ),
    );
    prompts.refreshPrompts.mockImplementation(() =>
      Promise.reject(new Error("prompts/list failed")),
    );
    mockCreateMCPConnection.mockResolvedValue({ close: vi.fn() });
    mockCreateToolBridge.mockResolvedValue(tools);
    mockCreateResourceBridge.mockResolvedValue(resources);
    mockCreatePromptBridge.mockResolvedValue(prompts);

    const manager = new MCPManager([makeConfig("srv1")], logger);
    const observations: number[] = [];
    const unsubscribe = manager.subscribeSurfaceChanges(() => {
      observations.push(Date.now());
    });
    try {
      await manager.start();
      const before = observations.length;
      const handlers = listChangedHandlersFromLastConnect();
      handlers.onResourcesListChanged();
      handlers.onPromptsListChanged();
      await vi.waitFor(() => {
        expect(logger.warn).toHaveBeenCalled();
      });
      expect((await manager.getResources()).map((item) => item.uri)).toEqual([
        "file:///a",
      ]);
      expect((await manager.listPrompts()).map((item) => item.name)).toEqual([
        "promptA",
      ]);
      expect(observations.length).toBe(before);
    } finally {
      unsubscribe();
      await manager.stop();
    }
  });

  it("coalesces notification bursts into one extra refresh after the in-flight run", async () => {
    const initial = makeMockBridge("srv1", ["toolA"]);
    const firstRefresh = makeMockBridge("srv1", ["toolB"]);
    const secondRefresh = makeMockBridge("srv1", ["toolC"]);
    let releaseFirst: ((bridge: ReturnType<typeof makeMockBridge>) => void)
      | undefined;
    mockCreateMCPConnection.mockResolvedValue({ close: vi.fn() });
    mockCreateToolBridge
      .mockResolvedValueOnce(initial)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseFirst = resolve;
          }),
      )
      .mockResolvedValueOnce(secondRefresh);

    const manager = new MCPManager([makeConfig("srv1")]);
    try {
      await manager.start();
      const handlers = listChangedHandlersFromLastConnect();
      handlers.onToolsListChanged();
      await vi.waitFor(() => {
        expect(mockCreateToolBridge).toHaveBeenCalledTimes(2);
      });
      handlers.onToolsListChanged();
      handlers.onToolsListChanged();
      releaseFirst?.(firstRefresh);
      await waitForTools(manager, ["mcp.srv1.toolC"]);
      expect(mockCreateToolBridge).toHaveBeenCalledTimes(3);
      expect(mockCreateMCPConnection).toHaveBeenCalledOnce();
    } finally {
      await manager.stop();
    }
  });

  it("does not publish a stale refresh after stop", async () => {
    const initial = makeMockBridge("srv1", ["toolA"]);
    const stale = makeMockBridge("srv1", ["toolZ"]);
    let releaseRefresh: ((bridge: ReturnType<typeof makeMockBridge>) => void)
      | undefined;
    mockCreateMCPConnection.mockResolvedValue({ close: vi.fn() });
    mockCreateToolBridge
      .mockResolvedValueOnce(initial)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseRefresh = resolve;
          }),
      );

    const manager = new MCPManager([makeConfig("srv1")]);
    await manager.start();
    listChangedHandlersFromLastConnect().onToolsListChanged();
    await vi.waitFor(() => {
      expect(mockCreateToolBridge).toHaveBeenCalledTimes(2);
    });
    await manager.stop();
    releaseRefresh?.(stale);
    await Promise.resolve();
    await Promise.resolve();
    expect(manager.getTools()).toEqual([]);
  });

  it("does not publish a stale refresh after automatic reconnect", async () => {
    vi.useFakeTimers();
    const initial = makeMockBridge("srv1", ["toolA"]);
    initial.tools[0]!.execute = vi.fn().mockResolvedValue({
      content: "transport closed",
      isError: true,
    });
    const stale = makeMockBridge("srv1", ["toolZ"]);
    const reconnected = makeMockBridge("srv1", ["toolA"]);
    let releaseRefresh: ((bridge: ReturnType<typeof makeMockBridge>) => void)
      | undefined;
    mockCreateMCPConnection.mockResolvedValue({ close: vi.fn() });
    mockCreateToolBridge
      .mockResolvedValueOnce(initial)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseRefresh = resolve;
          }),
      )
      .mockResolvedValueOnce(reconnected);

    const manager = new MCPManager([makeConfig("srv1")]);
    try {
      await manager.start();
      listChangedHandlersFromLastConnect().onToolsListChanged();
      await vi.waitFor(() => {
        expect(mockCreateToolBridge).toHaveBeenCalledTimes(2);
      });
      await manager.getTools()[0]!.execute({});
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(() => {
        expect(mockCreateToolBridge).toHaveBeenCalledTimes(3);
      });
      releaseRefresh?.(stale);
      await Promise.resolve();
      await Promise.resolve();
      expect(manager.getTools().map((tool) => tool.name)).toEqual([
        "mcp.srv1.toolA",
      ]);
      expect(
        manager.getTools().some((tool) => tool.name === "mcp.srv1.toolZ"),
      ).toBe(false);
    } finally {
      await manager.stop();
      vi.useRealTimers();
    }
  });
});
