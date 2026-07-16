/**
 * Regression tests for the two reconnect defects in ResilientMCPBridge:
 *
 *  (a) Reconnect rebuilt only the tool bridge, leaving the manager's
 *      resource/prompt bridges pointing at the OLD (closed) client. The
 *      bridge now invokes an `onReconnect(client)` hook (the manager wires
 *      this to rebuild the resource + prompt bridges against the new client).
 *
 *  (b) Reconnect only checked `disposed` before its awaits, so a
 *      dispose()-during-reconnect orphaned a freshly-spawned detached stdio
 *      child (process leak). The bridge now re-checks `disposed` after each
 *      await and closes the new client / tears down the new bridge.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ResilientMCPBridge } from "./resilient-client.js";
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

const config: MCPServerConfig = {
  name: "srv1",
  command: "npx",
  args: ["-y", "@test/srv1"],
  timeout: 123,
};

function failingInitialBridge(): MCPToolBridge {
  return makeBridge(
    "srv1",
    vi.fn().mockResolvedValue({ content: "transport closed", isError: true }),
  );
}

describe("ResilientMCPBridge reconnect bridge/leak handling", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("(a) invokes onReconnect with the new client so the manager can rebuild resource/prompt bridges", async () => {
    vi.useFakeTimers();
    const reconnectedBridge = makeBridge("srv1");
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const onReconnect = vi.fn().mockResolvedValue(undefined);

    mockCreateMCPConnection.mockResolvedValueOnce("client2");
    mockCreateToolBridge.mockResolvedValueOnce(reconnectedBridge);

    const bridge = new ResilientMCPBridge(
      config,
      failingInitialBridge(),
      logger,
      { onReconnect },
    );

    await bridge.tools[0]!.execute({});
    await vi.advanceTimersByTimeAsync(1_000);

    // The hook must receive the freshly-spawned client, not the old one.
    expect(onReconnect).toHaveBeenCalledOnce();
    expect(onReconnect).toHaveBeenCalledWith("client2");

    await bridge.dispose();
  });

  it("(a) a failing onReconnect does not undo an otherwise-successful tool reconnect", async () => {
    vi.useFakeTimers();
    const reconnectedBridge = makeBridge("srv1");
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const onReconnect = vi.fn().mockRejectedValue(new Error("resources down"));

    mockCreateMCPConnection.mockResolvedValueOnce("client2");
    mockCreateToolBridge.mockResolvedValueOnce(reconnectedBridge);

    const bridge = new ResilientMCPBridge(
      config,
      failingInitialBridge(),
      logger,
      { onReconnect },
    );

    await bridge.tools[0]!.execute({});
    await vi.advanceTimersByTimeAsync(1_000);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("resource/prompt refresh failed"),
    );
    // Tool surface still healthy: the new inner bridge is in use.
    const newClient = makeBridge("srv1").tools[0]!;
    void newClient;
    const result = await bridge.tools[0]!.execute({});
    expect(result).toEqual({ content: "ok" });

    await bridge.dispose();
  });

  it("(b) dispose() while createMCPConnection is in flight closes the new client (no orphaned child)", async () => {
    vi.useFakeTimers();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const close = vi.fn().mockResolvedValue(undefined);
    const newClient = { close };

    // Gate: createMCPConnection stays pending until we resolve it, giving us
    // a window to call dispose() mid-reconnect.
    let resolveConn!: (c: unknown) => void;
    mockCreateMCPConnection.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveConn = resolve;
      }) as Promise<never>,
    );
    const onReconnect = vi.fn().mockResolvedValue(undefined);

    const bridge = new ResilientMCPBridge(
      config,
      failingInitialBridge(),
      logger,
      { onReconnect },
    );

    await bridge.tools[0]!.execute({});
    // Fire the reconnect timer; reconnect() now awaits createMCPConnection.
    await vi.advanceTimersByTimeAsync(1_000);

    // Dispose lands while the new client is still being spawned and must not
    // report completion until that owned reconnect is closed.
    let disposed = false;
    const disposal = bridge.dispose().then(() => {
      disposed = true;
    });
    await Promise.resolve();
    expect(disposed).toBe(false);

    // Now the connection resolves — the spawned client must be closed, the
    // tool bridge must NOT be built, and the resource/prompt hook must NOT
    // run (nothing to refresh on a disposed bridge).
    resolveConn(newClient);
    await disposal;

    expect(close).toHaveBeenCalledOnce();
    expect(mockCreateToolBridge).not.toHaveBeenCalled();
    expect(onReconnect).not.toHaveBeenCalled();
  });

  it("(b) dispose() while createToolBridge is in flight tears down the new bridge", async () => {
    vi.useFakeTimers();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const newBridge = makeBridge("srv1");

    mockCreateMCPConnection.mockResolvedValueOnce("client2");
    let resolveBridge!: (b: MCPToolBridge) => void;
    mockCreateToolBridge.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveBridge = resolve;
      }),
    );
    const onReconnect = vi.fn().mockResolvedValue(undefined);

    const bridge = new ResilientMCPBridge(
      config,
      failingInitialBridge(),
      logger,
      { onReconnect },
    );

    await bridge.tools[0]!.execute({});
    await vi.advanceTimersByTimeAsync(1_000);

    // Dispose lands while the new tool bridge is still being built and waits
    // until that bridge has been torn down.
    let disposed = false;
    const disposal = bridge.dispose().then(() => {
      disposed = true;
    });
    await Promise.resolve();
    expect(disposed).toBe(false);

    resolveBridge(newBridge);
    await disposal;

    // The freshly-built bridge owns the client; disposing it closes the
    // client + kills the child. The reconnect hook must not run.
    expect(newBridge.dispose).toHaveBeenCalled();
    expect(onReconnect).not.toHaveBeenCalled();
  });
});
