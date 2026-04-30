import { describe, it, expect } from "vitest";

import {
  type McpManagerLike,
  projectMcpManagerToConnections,
} from "../agenc/adapters/upstream-mcp-clients.js";

function fakeManager(
  servers: ReadonlyArray<{ name: string; connected: boolean }>,
): McpManagerLike {
  return {
    getConfiguredServers() {
      return servers.map((s) => ({ name: s.name }));
    },
    isConnected(name: string) {
      return servers.find((s) => s.name === name)?.connected ?? false;
    },
  };
}

describe("projectMcpManagerToConnections (TUI MCP picker wiring)", () => {
  it("returns empty for a manager with no configured servers", () => {
    const got = projectMcpManagerToConnections(fakeManager([]));
    expect(got).toEqual([]);
  });

  it("emits every configured server with type='pending' regardless of connection state", () => {
    const got = projectMcpManagerToConnections(
      fakeManager([
        { name: "files", connected: true },
        { name: "octosearch", connected: false },
      ]),
    );
    expect(got.length).toBe(2);
    for (const entry of got) {
      expect(entry.type).toBe("pending");
    }
    expect(got.map((c) => c.name)).toEqual(["files", "octosearch"]);
  });

  it("does not emit type='connected' even when the manager reports a server connected — the upstream Client SDK is not wired", () => {
    const got = projectMcpManagerToConnections(
      fakeManager([
        { name: "ide", connected: true },
        { name: "slack", connected: true },
      ]),
    );
    for (const entry of got) {
      expect(entry.type).not.toBe("connected");
    }
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

  it("never produces an entry whose `client` field is set (would crash useIdeAtMentioned / slackChannelSuggestions)", () => {
    const got = projectMcpManagerToConnections(
      fakeManager([{ name: "ide", connected: true }]),
    );
    for (const entry of got) {
      expect((entry as { client?: unknown }).client).toBeUndefined();
    }
  });
});
