import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("bun:bundle", () => ({ feature: () => false }));

import { loadConfig } from "../config/loader.js";
import type { AgenCMcpCliIo } from "./mcp-cli.js";
import {
  formatAgenCMcpCliHelpText,
  parseAgenCMcpCliArgs,
  runAgenCMcpCli,
} from "./mcp-cli.js";

const handlerMocks = vi.hoisted(() => ({
  mcpAddFromDesktopHandler: vi.fn(),
  mcpAddJsonHandler: vi.fn(),
  mcpDoctorHandler: vi.fn(),
  mcpGetHandler: vi.fn(),
  mcpListHandler: vi.fn(),
  mcpRemoveHandler: vi.fn(),
  mcpResetChoicesHandler: vi.fn(),
}));

const configMocks = vi.hoisted(() => ({
  addMcpConfig: vi.fn(async (name: string, config: unknown, scope: string) => {
    if (scope === "local") {
      throw new Error(
        "Cannot add MCP server to local config: local MCP config is not loaded by the runtime. Use user config instead.",
      );
    }
    if (scope !== "user") {
      throw new Error(`Unexpected test scope: ${scope}`);
    }
    const { addUserMcpServerToToml } = await import(
      "../services/mcp/user-config-toml.js"
    );
    await addUserMcpServerToToml(name, config as never);
  }),
}));

vi.mock("../cli/handlers/mcp.js", () => handlerMocks);
vi.mock("../services/mcp/config.js", () => configMocks);
vi.mock("../services/mcp/utils.js", () => ({
  describeMcpConfigFilePath: vi.fn(() => join(agencHome, "config.toml")),
  ensureConfigScope: vi.fn((scope?: string) => {
    const resolved = scope ?? "local";
    if (
      !["local", "user", "project", "dynamic", "enterprise", "agencai", "managed"]
        .includes(resolved)
    ) {
      throw new Error(
        "Invalid scope: " +
          resolved +
          ". Must be one of: local, user, project, dynamic, enterprise, agencai, managed",
      );
    }
    return resolved;
  }),
  ensureTransport: vi.fn((transport?: string) => {
    if (!transport) return "stdio";
    if (transport !== "stdio" && transport !== "sse" && transport !== "http") {
      throw new Error(
        `Invalid transport type: ${transport}. Must be one of: stdio, sse, http`,
      );
    }
    return transport;
  }),
  parseHeaders: vi.fn((headers: string[]) =>
    Object.fromEntries(headers.map((header) => header.split(/:\s*/, 2)))
  ),
}));
vi.mock("../services/mcp/auth.js", () => ({
  readClientSecret: vi.fn(async () => "secret"),
  saveMcpClientSecret: vi.fn(),
}));
vi.mock("../services/mcp/xaaIdpLogin.js", () => ({
  getXaaIdpSettings: vi.fn(() => undefined),
  isXaaEnabled: vi.fn(() => process.env.AGENC_ENABLE_XAA === "1"),
}));

const originalEnv = {
  AGENC_ENABLE_XAA: process.env.AGENC_ENABLE_XAA,
  AGENC_HOME: process.env.AGENC_HOME,
  HOME: process.env.HOME,
};

let agencHome: string;

beforeEach(async () => {
  agencHome = await mkdtemp(join(tmpdir(), "agenc-mcp-cli-"));
  process.env.AGENC_HOME = agencHome;
  process.env.HOME = agencHome;
  delete process.env.AGENC_ENABLE_XAA;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

function captureIo(): {
  readonly io: AgenCMcpCliIo;
  readonly output: () => { stdout: string; stderr: string };
} {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      stdin: process.stdin,
      stdout: new Writable({
        write(chunk, _encoding, callback) {
          stdout += String(chunk);
          callback();
        },
      }),
      stderr: new Writable({
        write(chunk, _encoding, callback) {
          stderr += String(chunk);
          callback();
        },
      }),
    },
    output: () => ({ stdout, stderr }),
  };
}

describe("AgenC MCP management CLI parsing", () => {
  test("recognizes non-serve management subcommands", () => {
    for (const command of [
      "add",
      "list",
      "get",
      "remove",
      "add-json",
      "add-from-agenc-desktop",
      "reset-project-choices",
      "doctor",
    ]) {
      expect(parseAgenCMcpCliArgs(["mcp", command, "server"])).toEqual({
        kind: "management",
        argv: [command, "server"],
      });
    }
  });

  test("keeps unknown mcp subcommands rejected", () => {
    expect(parseAgenCMcpCliArgs(["mcp", "run"])).toEqual({
      kind: "error",
      message: "unknown mcp command: run",
    });
  });

  test("help lists the wired management subcommands and add transports", () => {
    const help = formatAgenCMcpCliHelpText();
    expect(help).toContain("add-json");
    expect(help).toContain("add-from-agenc-desktop");
    expect(help).toContain("reset-project-choices");
    expect(help).toContain("doctor");
    expect(help).toContain("--transport <stdio|sse|http>");
  });

  test("management runner reports command usage errors", async () => {
    const { io, output } = captureIo();

    await expect(
      runAgenCMcpCli({ kind: "management", argv: ["add"] }, { io }),
    ).resolves.toBe(1);
    expect(output().stderr).toContain("Usage: agenc mcp add");
  });

  test("dispatches management handlers", async () => {
    await expect(
      runAgenCMcpCli({ kind: "management", argv: ["list"] }),
    ).resolves.toBe(0);
    expect(handlerMocks.mcpListHandler).toHaveBeenCalledTimes(1);

    await expect(
      runAgenCMcpCli({ kind: "management", argv: ["get", "github"] }),
    ).resolves.toBe(0);
    expect(handlerMocks.mcpGetHandler).toHaveBeenCalledWith("github");

    await expect(
      runAgenCMcpCli({
        kind: "management",
        argv: ["remove", "--scope", "user", "github"],
      }),
    ).resolves.toBe(0);
    expect(handlerMocks.mcpRemoveHandler).toHaveBeenCalledWith("github", {
      scope: "user",
    });

    await expect(
      runAgenCMcpCli({
        kind: "management",
        argv: ["reset-project-choices"],
      }),
    ).resolves.toBe(0);
    expect(handlerMocks.mcpResetChoicesHandler).toHaveBeenCalledTimes(1);

    await expect(
      runAgenCMcpCli({
        kind: "management",
        argv: ["doctor", "github", "--config-only", "--json"],
      }),
    ).resolves.toBe(0);
    expect(handlerMocks.mcpDoctorHandler).toHaveBeenCalledWith("github", {
      scope: undefined,
      configOnly: true,
      json: true,
    });
  });

  test("rejects extra fixed-arity command arguments", async () => {
    const { io, output } = captureIo();

    await expect(
      runAgenCMcpCli(
        { kind: "management", argv: ["get", "github", "extra"] },
        { io },
      ),
    ).resolves.toBe(1);
    expect(handlerMocks.mcpGetHandler).not.toHaveBeenCalled();
    expect(output().stderr).toContain("Usage: agenc mcp get <name>");
  });

  test("default mcp add writes to the live user config namespace", async () => {
    const { io, output } = captureIo();

    await expect(
      runAgenCMcpCli(
        { kind: "management", argv: ["add", "github", "gh-mcp"] },
        { io },
      ),
    ).resolves.toBe(0);

    const loaded = await loadConfig({ home: agencHome });
    expect(loaded.config.mcp_servers?.github).toMatchObject({
      transport: "stdio",
      command: "gh-mcp",
      args: [],
    });
    expect(await readFile(join(agencHome, "config.toml"), "utf8")).toContain(
      '["mcp_servers"."github"]',
    );
    expect(output().stdout).toContain("to user config");
    expect(output().stderr).toBe("");
  });

  test("mcp add supports http transport and headers", async () => {
    const { io, output } = captureIo();

    await expect(
      runAgenCMcpCli(
        {
          kind: "management",
          argv: [
            "add",
            "--transport",
            "http",
            "--header",
            "Authorization: Bearer token",
            "docs",
            "https://agenc.tech/mcp",
          ],
        },
        { io },
      ),
    ).resolves.toBe(0);

    const loaded = await loadConfig({ home: agencHome });
    expect(loaded.config.mcp_servers?.docs).toMatchObject({
      transport: "http",
      endpoint: "https://agenc.tech/mcp",
      headers: { Authorization: "Bearer token" },
    });
    expect(output().stdout).toContain("Authorization: <redacted>");
    expect(output().stdout).not.toContain("Bearer token");
  });

  test("mcp add validates xaa before writing config", async () => {
    const { io, output } = captureIo();

    await expect(
      runAgenCMcpCli(
        {
          kind: "management",
          argv: ["add", "--xaa", "github", "gh-mcp"],
        },
        { io },
      ),
    ).resolves.toBe(1);

    expect(output().stderr).toContain(
      "Error: --xaa requires AGENC_ENABLE_XAA=1",
    );
    await expect(readFile(join(agencHome, "config.toml"), "utf8")).rejects
      .toThrow();
  });

  test("preserves handler defaults for add-json and desktop import", async () => {
    await expect(
      runAgenCMcpCli({
        kind: "management",
        argv: ["add-json", "github", "{\"type\":\"stdio\"}"],
      }),
    ).resolves.toBe(0);
    expect(handlerMocks.mcpAddJsonHandler).toHaveBeenCalledWith(
      "github",
      "{\"type\":\"stdio\"}",
      { scope: undefined },
    );

    await expect(
      runAgenCMcpCli({
        kind: "management",
        argv: ["add-from-agenc-desktop"],
      }),
    ).resolves.toBe(0);
    expect(handlerMocks.mcpAddFromDesktopHandler).toHaveBeenCalledWith({
      scope: undefined,
    });
  });
});
