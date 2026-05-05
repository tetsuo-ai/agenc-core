import { afterEach, describe, expect, it, vi } from "vitest";
import { ResilientMCPBridge } from "./resilient-bridge.js";
import type { MCPToolBridgePermissionOptions } from "./tool-bridge.js";
import type { MCPServerConfig, MCPToolBridge } from "./types.js";

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
    expect(mockCreateMCPConnection).toHaveBeenCalledWith(config, logger);
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
});
