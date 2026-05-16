import { describe, expect, it, vi } from "vitest";

import mcpCommand, {
  collectMcpToolStatusByServer,
  collectMcpToolStatus,
  collectMcpServerStatus,
  formatMcpServerStatus,
  formatMcpToolStatus,
  parseMcpArgs,
} from "./mcp.js";
import type { Session } from "../session/session.js";

function stubSession(
  servers: Map<
    string,
    { enabled: boolean; required: boolean; url?: string; command?: string }
  >,
  mcpManagerOverrides: Record<string, unknown> = {},
): Session {
  return {
    config: { model: "test" },
    services: {
      authManager: { mode: "bearer_key" },
      mcpManager: {
        effectiveServers: async () => servers,
        ...mcpManagerOverrides,
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
    expect(formatMcpServerStatus([])).toContain("MCP servers: none configured.");
    expect(formatMcpServerStatus([])).toContain("/mcp add");
  });

  it("parses management subcommands and quoted add args", () => {
    expect(parseMcpArgs("tools github")).toEqual({
      kind: "tools",
      serverName: "github",
    });
    expect(parseMcpArgs("reconnect github")).toEqual({
      kind: "reconnect",
      serverName: "github",
    });
    expect(parseMcpArgs("add local node \"server path.js\" --stdio")).toEqual({
      kind: "add",
      serverName: "local",
      command: "node",
      args: ["server path.js", "--stdio"],
    });
    expect(parseMcpArgs("add broken \"unterminated")).toMatchObject({
      kind: "error",
    });
  });

  it("executes /mcp status", async () => {
    const result = await mcpCommand.execute({
      session: stubSession(
        new Map([["local", { enabled: true, required: false, command: "node" }]]),
        {
          getToolsByServer: (name: string) =>
            name === "local"
              ? [
                  { name: "mcp.local.game_tip", description: "Game tip" },
                  { name: "mcp.local.score_hint", description: "Score hint" },
                ]
              : [],
        },
      ),
      argsRaw: "status",
      cwd: "/tmp/ws",
      home: "/home/test",
    });

    expect(result.kind).toBe("text");
    if (result.kind === "text") {
      expect(result.text).toContain("local: connected");
      expect(result.text).toContain("(node, 2 tools)");
      expect(result.text).toContain("mcp.local.game_tip");
      expect(result.text).toContain("mcp.local.score_hint");
      expect(result.text).toContain("/mcp tools [server]");
    }
  });

  it("lists all MCP tools or tools for one server", async () => {
    const session = stubSession(new Map(), {
      getTools: () => [
        { name: "mcp.git.status", description: "Git status" },
        { name: "mcp.docs.search" },
      ],
      getToolsByServer: (name: string) =>
        name === "git"
          ? [{ name: "mcp.git.status", description: "Git status" }]
          : [],
    });

    expect(collectMcpToolStatus(session).map((tool) => tool.name)).toEqual([
      "mcp.docs.search",
      "mcp.git.status",
    ]);
    expect(formatMcpToolStatus(collectMcpToolStatus(session, "git"), "git"))
      .toContain("mcp.git.status - Git status");
    expect(
      collectMcpToolStatusByServer(session, [
        {
          name: "git",
          enabled: true,
          required: false,
        },
      ]).get("git")?.map((tool) => tool.name),
    ).toEqual(["mcp.git.status"]);

    const result = await mcpCommand.execute({
      session,
      argsRaw: "tools git",
      cwd: "/tmp/ws",
      home: "/home/test",
    });
    expect(result.kind).toBe("text");
    if (result.kind === "text") {
      expect(result.text).toContain("MCP tools for git:");
      expect(result.text).toContain("mcp.git.status - Git status");
    }
  });

  it("sanitizes MCP tool output to one line per tool", () => {
    const text = formatMcpToolStatus([
      {
        name: "mcp.git.\nstatus",
        description: "Runs \\u0394 checks\nwith\u0007bell",
      },
    ]);

    expect(text).toContain("mcp.git. status - Runs \\u0394 checks with?bell");
    expect(text.split("\n")).toHaveLength(2);
  });

  it("reports reconnect, enable, and disable results", async () => {
    const reconnectServer = vi.fn(async (serverName: string) => ({
      serverName,
      success: true,
      toolCount: 2,
    }));
    const enableServer = vi.fn(async (serverName: string) => ({
      serverName,
      success: true,
      toolCount: 1,
    }));
    const disableServer = vi.fn(async (serverName: string) => ({
      serverName,
      success: true,
      toolCount: 0,
    }));
    const session = stubSession(new Map(), {
      reconnectServer,
      enableServer,
      disableServer,
    });

    await expect(
      mcpCommand.execute({
        session,
        argsRaw: "reconnect github",
        cwd: "/tmp/ws",
        home: "/home/test",
      }),
    ).resolves.toMatchObject({
      kind: "text",
      text: expect.stringContaining('MCP server "github" reconnected (2 tools).'),
    });
    await mcpCommand.execute({
      session,
      argsRaw: "enable github",
      cwd: "/tmp/ws",
      home: "/home/test",
    });
    await mcpCommand.execute({
      session,
      argsRaw: "disable github",
      cwd: "/tmp/ws",
      home: "/home/test",
    });

    expect(reconnectServer).toHaveBeenCalledWith("github");
    expect(enableServer).toHaveBeenCalledWith("github");
    expect(disableServer).toHaveBeenCalledWith("github");
  });

  it("surfaces failed mutations as command errors", async () => {
    const session = stubSession(new Map(), {
      reconnectServer: async (serverName: string) => ({
        serverName,
        success: false,
        toolCount: 0,
        error: "refused",
      }),
    });

    const result = await mcpCommand.execute({
      session,
      argsRaw: "reconnect github",
      cwd: "/tmp/ws",
      home: "/home/test",
    });
    expect(result).toEqual({ kind: "error", message: "refused" });
  });

  it("surfaces add failures as command errors", async () => {
    const addServer = vi.fn(async (config) => ({
      serverName: config.name,
      success: false,
      toolCount: 0,
      error: "no such command",
    }));
    const session = stubSession(new Map(), { addServer });

    const result = await mcpCommand.execute({
      session,
      argsRaw: "add local missing",
      cwd: "/tmp/ws",
      home: "/home/test",
    });

    expect(result).toEqual({ kind: "error", message: "no such command" });
    expect(addServer).toHaveBeenCalledWith({
      name: "local",
      transport: "stdio",
      command: "missing",
      args: [],
      enabled: true,
    });
  });

  it("adds a stdio MCP server for the current session only", async () => {
    const addServer = vi.fn(async (config) => ({
      serverName: config.name,
      success: true,
      toolCount: 1,
    }));
    const session = stubSession(new Map(), { addServer });

    const result = await mcpCommand.execute({
      session,
      argsRaw: 'add local node "server path.js" --stdio',
      cwd: "/tmp/ws",
      home: "/home/test",
    });

    expect(addServer).toHaveBeenCalledWith({
      name: "local",
      transport: "stdio",
      command: "node",
      args: ["server path.js", "--stdio"],
      enabled: true,
    });
    expect(result.kind).toBe("text");
    if (result.kind === "text") {
      expect(result.text).toContain('MCP server "local" added for this session');
      expect(result.text).toContain("does not edit config.toml");
    }
  });

  it("reports unsupported live manager surfaces clearly", async () => {
    const result = await mcpCommand.execute({
      session: stubSession(new Map()),
      argsRaw: "tools",
      cwd: "/tmp/ws",
      home: "/home/test",
    });
    expect(result).toEqual({
      kind: "error",
      message: "MCP tool listing is not available for this session.",
    });
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
