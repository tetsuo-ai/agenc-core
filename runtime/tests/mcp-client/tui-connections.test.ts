import { describe, it, expect, vi } from "vitest";

import {
  type McpConnectionProjection,
  type McpManagerLike,
  projectMcpManagerToConnections,
} from "./tui-connections.js";
import type { MCPServerConnection } from "../services/mcp/types.js";

function fakeManager(
  servers: ReadonlyArray<{ name: string; connected: boolean }>,
  states: Readonly<Record<string, McpConnectionProjection>> = {},
  connectedConnections: Readonly<Record<string, MCPServerConnection>> = {},
): McpManagerLike {
  return {
    getConfiguredServers() {
      return servers.map((s) => ({ name: s.name }));
    },
    isConnected(name: string) {
      return servers.find((s) => s.name === name)?.connected ?? false;
    },
    getConnectionState(name: string) {
      return states[name];
    },
    getConnectedConnection(name: string) {
      return connectedConnections[name];
    },
  };
}

function connectedMcpServer(name: string): MCPServerConnection {
  return {
    type: "connected",
    name,
    config: { type: "sse-ide" },
    capabilities: { tools: {} },
    client: { setNotificationHandler: vi.fn() },
    cleanup: vi.fn(),
  } as MCPServerConnection;
}

describe("projectMcpManagerToConnections (TUI MCP picker wiring)", () => {
  it("returns empty for a manager with no configured servers", () => {
    const got = projectMcpManagerToConnections(fakeManager([]));
    expect(got).toEqual([]);
  });

  it("projects real connected connections and pending server states", () => {
    const connected = connectedMcpServer("files");
    const got = projectMcpManagerToConnections(
      fakeManager(
        [
          { name: "files", connected: true },
          { name: "octosearch", connected: false },
        ],
        {},
        {
          files: connected,
        },
      ),
    );

    expect(got).toEqual([
      connected,
      expect.objectContaining({
        name: "octosearch",
        type: "pending",
      }),
    ]);
  });

  it("preserves order from getConfiguredServers", () => {
    const got = projectMcpManagerToConnections(
      fakeManager([
        { name: "alpha", connected: true },
        { name: "beta", connected: false },
        { name: "gamma", connected: true },
      ]),
    );
    expect(got.map((c) => c.name)).toEqual(["alpha", "beta", "gamma"]);
  });

  it("uses the manager-provided connected connection when available", () => {
    const connected = connectedMcpServer("ide");
    const got = projectMcpManagerToConnections(
      fakeManager(
        [{ name: "ide", connected: true }],
        {},
        {
          ide: connected,
        },
      ),
    );

    expect(got[0]).toBe(connected);
  });

  it("keeps connected-looking servers pending when no real client is exposed", () => {
    const got = projectMcpManagerToConnections(
      fakeManager([{ name: "files", connected: true }], {
        files: { type: "connected" },
      }),
    );

    expect(got[0]).toEqual(
      expect.objectContaining({
        name: "files",
        type: "pending",
      }),
    );
  });

  it("projects failed and disabled server states for App notifications", () => {
    const got = projectMcpManagerToConnections(
      fakeManager(
        [
          { name: "files", connected: false },
          { name: "disabled", connected: false },
        ],
        {
          files: { type: "failed", error: "spawn ENOENT" },
          disabled: { type: "disabled" },
        },
      ),
    );

    expect(got).toEqual([
      expect.objectContaining({
        name: "files",
        type: "failed",
        error: "spawn ENOENT",
      }),
      expect.objectContaining({
        name: "disabled",
        type: "disabled",
      }),
    ]);
  });
});
