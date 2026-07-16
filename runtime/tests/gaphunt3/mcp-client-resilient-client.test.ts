import { afterEach, describe, expect, it, vi } from "vitest";

import { ResilientMCPBridge } from "src/mcp-client/resilient-client";
import type {
  MCPElicitationHandlers,
  MCPServerConfig,
  MCPToolBridge,
} from "src/mcp-client/types";

// gaphunt3 #14: the reconnect path must re-supply the session's elicitation
// handlers to the freshly-spawned client; otherwise server-initiated
// elicitation silently breaks after any reconnect.
// gaphunt3 #38: the proxy must resolve the live inner tool by EXACT namespaced
// name, not by a dotted-suffix `endsWith` fallback that can misroute to the
// wrong tool when one tool name is a `.`-suffixed substring of another.

// reconnect() does `await import("./connection.js")` / `"./tools.js"` from the
// source file; both resolve to the same source modules the test aliases here.
vi.mock("src/mcp-client/connection", () => ({
  createMCPConnection: vi.fn(),
}));
vi.mock("src/mcp-client/tools", () => ({
  createToolBridge: vi.fn(),
}));

import { createMCPConnection } from "src/mcp-client/connection";
import { createToolBridge } from "src/mcp-client/tools";

const mockCreateMCPConnection = vi.mocked(createMCPConnection);
const mockCreateToolBridge = vi.mocked(createToolBridge);

const config: MCPServerConfig = {
  name: "srv1",
  command: "npx",
  args: ["-y", "@test/srv1"],
  timeout: 123,
};

function makeBridge(
  serverName: string,
  tools: MCPToolBridge["tools"],
): MCPToolBridge {
  return {
    serverName,
    tools,
    dispose: vi.fn().mockResolvedValue(undefined),
  };
}

function tool(
  name: string,
  execute = vi.fn().mockResolvedValue({ content: "ok" }),
): MCPToolBridge["tools"][number] {
  return {
    name,
    description: name,
    inputSchema: { type: "object", properties: {} },
    execute,
  };
}

/** An initial inner bridge whose single tool fails with a connection error,
 *  so the first `execute()` schedules a reconnect. */
function failingInitialBridge(toolName: string): MCPToolBridge {
  return makeBridge("srv1", [
    tool(
      toolName,
      vi.fn().mockResolvedValue({ content: "transport closed", isError: true }),
    ),
  ]);
}

describe("ResilientMCPBridge gaphunt3 fixes", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  // --------------------------------------------------------------------------
  // #14 — elicitation handlers survive reconnect
  // --------------------------------------------------------------------------
  it("#14: re-supplies the session elicitation handlers to the rebuilt client on reconnect", async () => {
    vi.useFakeTimers();

    const handleRequest = vi.fn().mockResolvedValue({ action: "accept" });
    const elicitationHandlers: MCPElicitationHandlers = { handleRequest };

    // Emulate the connection layer: a real `createMCPConnection` forwards its
    // handlers into `configureMcpElicitationClient`, which registers the
    // ElicitRequest handler ONLY when handlers !== undefined. Here the fake
    // client "registers" whatever handlers it was given so we can later
    // simulate a server-initiated elicitation request on the new client.
    let registered: MCPElicitationHandlers | undefined;
    mockCreateMCPConnection.mockImplementation(
      async (_config, _logger, handlers) => {
        registered = handlers;
        return { close: vi.fn().mockResolvedValue(undefined) };
      },
    );
    mockCreateToolBridge.mockResolvedValueOnce(
      makeBridge("srv1", [tool("mcp.srv1.tool")]),
    );

    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const bridge = new ResilientMCPBridge(config, failingInitialBridge("mcp.srv1.tool"), logger, {
      elicitationHandlers,
    });

    // Trigger a reconnect.
    await bridge.tools[0]!.execute({});
    await vi.advanceTimersByTimeAsync(1_000);

    // The reconnect must have spawned the client WITH the handlers.
    expect(mockCreateMCPConnection).toHaveBeenCalledWith(
      config,
      logger,
      elicitationHandlers,
      undefined,
      undefined,
    );
    expect(registered).toBe(elicitationHandlers);

    // A server-initiated elicitation on the reconnected client now routes to
    // the session handler. Before the fix the client was built without
    // handlers, so nothing would be registered and the spy stays uncalled.
    expect(registered).toBeDefined();
    await registered!.handleRequest({
      serverName: "srv1",
      requestId: 1,
      request: { message: "name?" },
    });
    expect(handleRequest).toHaveBeenCalledOnce();

    await bridge.dispose();
  });

  it("#14: without supplied handlers reconnect passes undefined (no accidental registration)", async () => {
    vi.useFakeTimers();

    mockCreateMCPConnection.mockResolvedValue({
      close: vi.fn().mockResolvedValue(undefined),
    });
    mockCreateToolBridge.mockResolvedValueOnce(
      makeBridge("srv1", [tool("mcp.srv1.tool")]),
    );

    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const bridge = new ResilientMCPBridge(
      config,
      failingInitialBridge("mcp.srv1.tool"),
      logger,
    );

    await bridge.tools[0]!.execute({});
    await vi.advanceTimersByTimeAsync(1_000);

    expect(mockCreateMCPConnection).toHaveBeenCalledWith(
      config,
      logger,
      undefined,
      undefined,
      undefined,
    );

    await bridge.dispose();
  });

  // --------------------------------------------------------------------------
  // #38 — exact-name inner tool resolution (no dotted-suffix misroute)
  // --------------------------------------------------------------------------
  it("#38: dispatches the exact tool, not a dotted-suffix overlap that precedes it", async () => {
    // Inner bridge exposes a longer-named tool BEFORE the exact one, so the
    // old `endsWith('.add')` fallback (short-circuiting on the first match)
    // would route `mcp.srv1.add` to `mcp.srv1.do.add`.
    const doAddExecute = vi.fn().mockResolvedValue({ content: "do.add" });
    const addExecute = vi.fn().mockResolvedValue({ content: "add" });

    const inner = makeBridge("srv1", [
      tool("mcp.srv1.do.add", doAddExecute),
      tool("mcp.srv1.add", addExecute),
    ]);

    const bridge = new ResilientMCPBridge(config, inner, {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    });

    // Find the proxy for the shorter tool and call it.
    const proxy = bridge.tools.find((t) => t.name === "mcp.srv1.add");
    expect(proxy).toBeDefined();
    const result = await proxy!.execute({});

    // Must hit the exact tool's execute, never the dotted-suffix overlap.
    expect(addExecute).toHaveBeenCalledOnce();
    expect(doAddExecute).not.toHaveBeenCalled();
    expect(result).toEqual({ content: "add" });

    await bridge.dispose();
  });

  it("#38: still resolves a normally-namespaced tool by exact name", async () => {
    const exec = vi.fn().mockResolvedValue({ content: "plain" });
    const inner = makeBridge("srv1", [tool("mcp.srv1.plain", exec)]);

    const bridge = new ResilientMCPBridge(config, inner, {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    });

    const proxy = bridge.tools.find((t) => t.name === "mcp.srv1.plain");
    const result = await proxy!.execute({});

    expect(exec).toHaveBeenCalledOnce();
    expect(result).toEqual({ content: "plain" });

    await bridge.dispose();
  });
});
