import { describe, expect, it } from "vitest";

import mcpCommand, {
  collectMcpServerStatus,
  formatMcpServerStatus,
} from "./mcp.js";
import type { Session } from "../session/session.js";

function stubSession(
  servers: Map<
    string,
    { enabled: boolean; required: boolean; url?: string; command?: string }
  >,
): Session {
  return {
    config: { model: "test" },
    services: {
      authManager: { mode: "bearer_key" },
      mcpManager: {
        effectiveServers: async () => servers,
      },
    },
  } as unknown as Session;
}

describe("mcpCommand", () => {
  it("collects sorted MCP server status from the session service", async () => {
    const snapshot = await collectMcpServerStatus(
      stubSession(
        new Map([
          ["zeta", { enabled: false, required: false, command: "z" }],
          ["alpha", { enabled: true, required: true, url: "http://a" }],
        ]),
      ),
    );

    expect(snapshot.map((server) => server.name)).toEqual(["alpha", "zeta"]);
    expect(snapshot[0]).toMatchObject({
      name: "alpha",
      enabled: true,
      required: true,
      url: "http://a",
    });
  });

  it("formats no configured servers explicitly", () => {
    expect(formatMcpServerStatus([])).toBe("MCP servers: none configured.");
  });

  it("executes /mcp status", async () => {
    const result = await mcpCommand.execute({
      session: stubSession(
        new Map([["local", { enabled: true, required: false, command: "node" }]]),
      ),
      argsRaw: "status",
      cwd: "/tmp/ws",
      home: "/home/test",
    });

    expect(result.kind).toBe("text");
    if (result.kind === "text") {
      expect(result.text).toContain("local: connected");
      expect(result.text).toContain("(node)");
    }
  });

  it("rejects unsupported subcommands", async () => {
    const result = await mcpCommand.execute({
      session: stubSession(new Map()),
      argsRaw: "restart",
      cwd: "/tmp/ws",
      home: "/home/test",
    });
    expect(result.kind).toBe("error");
  });
});
