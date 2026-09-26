import { describe, it, expect, vi, beforeEach } from "vitest";
import { MCPManager } from "./manager.js";
import type { MCPServerConfig } from "./types.js";
import {
  installEmptyCompanionBridgeDefaults,
  makeConfig,
  makeMockBridge,
  makeMockPromptBridge,
  makeMockResourceBridge,
} from "./manager-test-fixtures.js";

interface MCPListChangedHandlers {
  readonly onToolsListChanged: () => void;
  readonly onPromptsListChanged: () => void;
  readonly onResourcesListChanged: () => void;
}

vi.mock("./connection.js", () => ({ createMCPConnection: vi.fn() }));
vi.mock("./tools.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./tools.js")>()),
  createToolBridge: vi.fn(),
}));
vi.mock("./resources.js", () => ({ createResourceBridge: vi.fn() }));
vi.mock("./prompts.js", () => ({ createPromptBridge: vi.fn() }));

import { createMCPConnection } from "./connection.js";
import { createToolBridge } from "./tools.js";
import { createResourceBridge } from "./resources.js";
import { createPromptBridge } from "./prompts.js";

const mockCreateMCPConnection = vi.mocked(createMCPConnection);
const mockCreateToolBridge = vi.mocked(createToolBridge);
const mockCreateResourceBridge = vi.mocked(createResourceBridge);
const mockCreatePromptBridge = vi.mocked(createPromptBridge);

function listChangedHandlersFromConnect(index = -1): MCPListChangedHandlers {
  const call = mockCreateMCPConnection.mock.calls.at(index);
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

async function startManager(
  configs: MCPServerConfig[],
  logger?: ReturnType<typeof testLogger>,
): Promise<MCPManager> {
  const manager =
    logger === undefined ? new MCPManager(configs) : new MCPManager(configs, logger);
  await manager.start();
  return manager;
}

function holdNextToolBridge(): (bridge: ReturnType<typeof makeMockBridge>) => void {
  const held = holdNextToolBridgeResult();
  return (bridge) => held.resolve(bridge);
}

function holdNextToolBridgeResult(): {
  readonly resolve: (bridge: ReturnType<typeof makeMockBridge>) => void;
  readonly reject: (error: unknown) => void;
} {
  let resolvePromise: ((bridge: ReturnType<typeof makeMockBridge>) => void) | undefined;
  let rejectPromise: ((error: unknown) => void) | undefined;
  mockCreateToolBridge.mockImplementationOnce(
    () =>
      new Promise((resolve, reject) => {
        resolvePromise = resolve;
        rejectPromise = reject;
      }),
  );
  return {
    resolve: (bridge) => resolvePromise?.(bridge),
    reject: (error) => rejectPromise?.(error),
  };
}

describe("MCPManager list_changed catalog refresh", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    installEmptyCompanionBridgeDefaults(
      mockCreateResourceBridge,
      mockCreatePromptBridge,
    );
  });

  it("registers listChanged handlers on the connection used at start", async () => {
    mockCreateMCPConnection.mockResolvedValueOnce({ close: vi.fn() });
    mockCreateToolBridge.mockResolvedValueOnce(makeMockBridge("srv1", ["toolA"]));
    const manager = await startManager([makeConfig("srv1")]);
    const handlers = listChangedHandlersFromConnect();
    expect(typeof handlers.onToolsListChanged).toBe("function");
    expect(typeof handlers.onPromptsListChanged).toBe("function");
    expect(typeof handlers.onResourcesListChanged).toBe("function");
    await manager.stop();
  });

  it("finishes an in-flight tools refresh when a prompts notification arrives", async () => {
    const initial = makeMockBridge("srv1", ["toolA"]);
    const refreshed = makeMockBridge("srv1", ["toolB"]);
    const prompts = makeMockPromptBridge("srv1", [{ name: "promptA" }]);
    mockCreateMCPConnection.mockResolvedValue({ close: vi.fn() });
    mockCreateToolBridge.mockResolvedValueOnce(initial);
    const releaseRefresh = holdNextToolBridge();
    mockCreatePromptBridge.mockResolvedValue(prompts);

    const manager = await startManager([makeConfig("srv1")]);
    try {
      const handlers = listChangedHandlersFromConnect();
      handlers.onToolsListChanged();
      await vi.waitFor(() => {
        expect(mockCreateToolBridge).toHaveBeenCalledTimes(2);
      });
      handlers.onPromptsListChanged();
      releaseRefresh(refreshed);
      await waitForTools(manager, ["mcp.srv1.toolB"]);
      await vi.waitFor(() => {
        expect(prompts.refreshPrompts).toHaveBeenCalled();
      });
      expect(mockCreateMCPConnection).toHaveBeenCalledOnce();
    } finally {
      await manager.stop();
    }
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

      listChangedHandlersFromConnect().onToolsListChanged();
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
    const resources = makeMockResourceBridge("srv1", [{ uri: "file:///a" }]);
    const prompts = makeMockPromptBridge("srv1", [{ name: "promptA" }]);
    mockCreateMCPConnection.mockResolvedValue({ close: vi.fn() });
    mockCreateToolBridge.mockResolvedValue(makeMockBridge("srv1", ["toolA"]));
    mockCreateResourceBridge.mockResolvedValue(resources);
    mockCreatePromptBridge.mockResolvedValue(prompts);

    const manager = await startManager([makeConfig("srv1")]);
    try {
      expect((await manager.getResources()).map((item) => item.uri)).toEqual([
        "file:///a",
      ]);
      expect((await manager.listPrompts()).map((item) => item.name)).toEqual([
        "promptA",
      ]);

      resources.setResources([{ uri: "file:///b" }]);
      prompts.setPrompts([{ name: "promptB" }]);
      const handlers = listChangedHandlersFromConnect();
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
      listChangedHandlersFromConnect().onToolsListChanged();
      await vi.waitFor(() => {
        expect(logger.warn).toHaveBeenCalledWith(
          expect.stringContaining("catalog refresh failed"),
          expect.any(Error),
        );
      });
      expect(manager.getTools().map((tool) => tool.name)).toEqual([
        "mcp.srv1.toolA",
      ]);
      expect(observations).toHaveLength(before);
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

    const manager = await startManager(
      [makeConfig("srv1"), makeConfig("srv2")],
      logger,
    );
    try {
      listChangedHandlersFromConnect(1).onToolsListChanged();
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
    mockCreateToolBridge.mockResolvedValue(makeMockBridge("srv1", ["toolA"]));
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
      const handlers = listChangedHandlersFromConnect();
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
      expect(observations).toHaveLength(before);
    } finally {
      unsubscribe();
      await manager.stop();
    }
  });

  it("coalesces notification bursts into one extra refresh after the in-flight run", async () => {
    const initial = makeMockBridge("srv1", ["toolA"]);
    const firstRefresh = makeMockBridge("srv1", ["toolB"]);
    const secondRefresh = makeMockBridge("srv1", ["toolC"]);
    mockCreateMCPConnection.mockResolvedValue({ close: vi.fn() });
    mockCreateToolBridge.mockResolvedValueOnce(initial);
    const releaseFirst = holdNextToolBridge();
    mockCreateToolBridge.mockResolvedValueOnce(secondRefresh);

    const manager = await startManager([makeConfig("srv1")]);
    try {
      const handlers = listChangedHandlersFromConnect();
      handlers.onToolsListChanged();
      await vi.waitFor(() => {
        expect(mockCreateToolBridge).toHaveBeenCalledTimes(2);
      });
      handlers.onToolsListChanged();
      handlers.onToolsListChanged();
      releaseFirst(firstRefresh);
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
    mockCreateMCPConnection.mockResolvedValue({ close: vi.fn() });
    mockCreateToolBridge.mockResolvedValueOnce(initial);
    const releaseRefresh = holdNextToolBridge();

    const manager = await startManager([makeConfig("srv1")]);
    listChangedHandlersFromConnect().onToolsListChanged();
    await vi.waitFor(() => {
      expect(mockCreateToolBridge).toHaveBeenCalledTimes(2);
    });
    await manager.stop();
    releaseRefresh(stale);
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
    mockCreateMCPConnection.mockResolvedValue({ close: vi.fn() });
    mockCreateToolBridge.mockResolvedValueOnce(initial);
    const releaseRefresh = holdNextToolBridge();
    mockCreateToolBridge.mockResolvedValueOnce(reconnected);

    const manager = await startManager([makeConfig("srv1")]);
    try {
      listChangedHandlersFromConnect().onToolsListChanged();
      await vi.waitFor(() => {
        expect(mockCreateToolBridge).toHaveBeenCalledTimes(2);
      });
      await manager.getTools()[0]!.execute({});
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(() => {
        expect(mockCreateToolBridge).toHaveBeenCalledTimes(3);
      });
      releaseRefresh(stale);
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

  it("still refreshes a kind queued after a stale refresh throws", async () => {
    vi.useFakeTimers();
    const initial = makeMockBridge("srv1", ["toolA"]);
    initial.tools[0]!.execute = vi.fn().mockResolvedValue({
      content: "transport closed",
      isError: true,
    });
    const reconnected = makeMockBridge("srv1", ["toolA"]);
    const refreshed = makeMockBridge("srv1", ["toolB"]);
    mockCreateMCPConnection.mockResolvedValue({ close: vi.fn() });
    mockCreateToolBridge.mockResolvedValueOnce(initial);
    const held = holdNextToolBridgeResult();
    mockCreateToolBridge.mockResolvedValueOnce(reconnected);
    mockCreateToolBridge.mockResolvedValueOnce(refreshed);

    const manager = await startManager([makeConfig("srv1")]);
    try {
      const handlers = listChangedHandlersFromConnect();
      handlers.onToolsListChanged();
      await vi.waitFor(() => {
        expect(mockCreateToolBridge).toHaveBeenCalledTimes(2);
      });
      await manager.getTools()[0]!.execute({});
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(() => {
        expect(mockCreateToolBridge).toHaveBeenCalledTimes(3);
      });
      handlers.onToolsListChanged();
      held.reject(new Error("stale catalog refresh"));
      await waitForTools(manager, ["mcp.srv1.toolB"]);
    } finally {
      await manager.stop();
      vi.useRealTimers();
    }
  });

  it.each([
    {
      label: "session header",
      config: makeConfig("srv1", {
        origin: { scope: "session" },
        headers: { Authorization: "super-secret-token" },
      }),
    },
    {
      label: "plugin secret",
      config: makeConfig("srv1", {
        origin: { scope: "plugin" },
        pluginSecretValues: ["super-secret-token"],
      }),
    },
  ])("redacts a $label from a failed tools refresh log", async ({ config }) => {
    const logger = testLogger();
    mockCreateMCPConnection.mockResolvedValue({ close: vi.fn() });
    mockCreateToolBridge
      .mockResolvedValueOnce(makeMockBridge(config.name, ["toolA"]))
      .mockRejectedValueOnce(new Error("list failed super-secret-token"));
    const manager = await startManager([config], logger);
    try {
      listChangedHandlersFromConnect().onToolsListChanged();
      await vi.waitFor(() => {
        expect(logger.warn).toHaveBeenCalled();
      });
      const logged = JSON.stringify(logger.warn.mock.calls);
      expect(logged).toContain("catalog refresh failed");
      expect(logged).not.toContain("super-secret-token");
    } finally {
      await manager.stop();
    }
  });
});
