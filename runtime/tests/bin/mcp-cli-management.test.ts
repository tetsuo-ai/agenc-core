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
  mcpApproveProjectHandler: vi.fn(),
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

const xaaState = vi.hoisted(() => ({
  settings: undefined as
    | { issuer: string; clientId: string; callbackPort?: number }
    | undefined,
  cachedIdToken: undefined as string | undefined,
  clientSecret: undefined as string | undefined,
  saveSecretResult: { success: true } as { success: boolean; warning?: string },
  clearedIdTokens: [] as string[],
  clearedClientSecrets: [] as string[],
  acquireIdpIdToken: vi.fn(async (options: {
    onAuthorizationUrl?: (url: string) => void;
  }) => {
    options.onAuthorizationUrl?.("https://idp.test/login");
  }),
  savedJwt: undefined as string | undefined,
  updateError: undefined as Error | undefined,
}));

const settingsMocks = vi.hoisted(() => ({
  updateSettingsForSource: vi.fn((_source: string, update: {
    xaaIdp?: { issuer: string; clientId: string; callbackPort?: number };
  }) => {
    if (xaaState.updateError) return { error: xaaState.updateError };
    xaaState.settings = update.xaaIdp;
    return {};
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
  acquireIdpIdToken: xaaState.acquireIdpIdToken,
  clearIdpClientSecret: vi.fn((issuer: string) => {
    xaaState.clearedClientSecrets.push(issuer);
    xaaState.clientSecret = undefined;
  }),
  clearIdpIdToken: vi.fn((issuer: string) => {
    xaaState.clearedIdTokens.push(issuer);
    xaaState.cachedIdToken = undefined;
  }),
  getCachedIdpIdToken: vi.fn(() => xaaState.cachedIdToken),
  getIdpClientSecret: vi.fn(() => xaaState.clientSecret),
  getXaaIdpSettings: vi.fn(() => xaaState.settings),
  issuerKey: vi.fn((issuer: string) => issuer.replace(/\/+$/, "").toLowerCase()),
  saveIdpClientSecret: vi.fn((_issuer: string, secret: string) => {
    xaaState.clientSecret = secret;
    return xaaState.saveSecretResult;
  }),
  saveIdpIdTokenFromJwt: vi.fn((_issuer: string, token: string) => {
    xaaState.savedJwt = token;
    xaaState.cachedIdToken = token;
    return Date.UTC(2030, 0, 1);
  }),
  isXaaEnabled: vi.fn(() => process.env.AGENC_ENABLE_XAA === "1"),
}));
vi.mock("../utils/settings/settings.js", () => settingsMocks);

const originalEnv = {
  AGENC_ENABLE_XAA: process.env.AGENC_ENABLE_XAA,
  AGENC_HOME: process.env.AGENC_HOME,
  HOME: process.env.HOME,
  MCP_XAA_IDP_CLIENT_SECRET: process.env.MCP_XAA_IDP_CLIENT_SECRET,
};

let agencHome: string;

beforeEach(async () => {
  agencHome = await mkdtemp(join(tmpdir(), "agenc-mcp-cli-"));
  process.env.AGENC_HOME = agencHome;
  process.env.HOME = agencHome;
  delete process.env.AGENC_ENABLE_XAA;
  delete process.env.MCP_XAA_IDP_CLIENT_SECRET;
  xaaState.settings = undefined;
  xaaState.cachedIdToken = undefined;
  xaaState.clientSecret = undefined;
  xaaState.saveSecretResult = { success: true };
  xaaState.clearedIdTokens = [];
  xaaState.clearedClientSecrets = [];
  xaaState.savedJwt = undefined;
  xaaState.updateError = undefined;
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
      "approve-project",
      "reset-project-choices",
      "doctor",
      "xaa",
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
    expect(help).toContain("approve-project");
    expect(help).toContain("reset-project-choices");
    expect(help).toContain("doctor");
    expect(help).toContain("xaa");
    expect(help).toContain("--transport <stdio|sse|http>");
    expect(help).toContain("default: user for add/add-json");
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
        argv: ["approve-project", "github"],
      }),
    ).resolves.toBe(0);
    expect(handlerMocks.mcpApproveProjectHandler).toHaveBeenCalledWith(
      "github",
    );

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

  test("mcp add rejects malformed callback ports before writing config", async () => {
    for (const [index, badPort] of ["123abc", "0", "-1", "65536"].entries()) {
      const { io, output } = captureIo();

      await expect(
        runAgenCMcpCli(
          {
            kind: "management",
            argv: [
              "add",
              "--transport",
              "http",
              "--callback-port",
              badPort,
              `docs${index}`,
              "https://agenc.tech/mcp",
            ],
          },
          { io },
        ),
      ).resolves.toBe(1);

      expect(output().stderr).toContain(
        "Error: --callback-port must be a valid TCP port",
      );
    }

    await expect(readFile(join(agencHome, "config.toml"), "utf8")).rejects
      .toThrow();
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

  test("mcp add rejects value-form boolean flags instead of silently enabling them", async () => {
    for (const flagArg of ["--client-secret=false", "--xaa=false", "--client-secret=0"]) {
      const { io, output } = captureIo();

      await expect(
        runAgenCMcpCli(
          {
            kind: "management",
            argv: ["add", flagArg, "github", "gh-mcp"],
          },
          { io },
        ),
      ).resolves.toBe(1);

      const flagName = flagArg.slice(2, flagArg.indexOf("="));
      expect(output().stderr).toContain(
        `Option --${flagName} does not take a value`,
      );
      // No config should be written when parsing rejects the argument.
      await expect(readFile(join(agencHome, "config.toml"), "utf8")).rejects
        .toThrow();
    }
  });

  test("mcp add still enables bare boolean flags", async () => {
    const { io } = captureIo();

    await expect(
      runAgenCMcpCli(
        {
          kind: "management",
          argv: ["add", "--client-secret", "github", "gh-mcp"],
        },
        { io },
      ),
    ).resolves.toBe(0);

    const loaded = await loadConfig({ home: agencHome });
    expect(loaded.config.mcp_servers?.github).toMatchObject({
      transport: "stdio",
      command: "gh-mcp",
    });
  });

  test("mcp xaa setup validates issuer and secret env before writing settings", async () => {
    const { io, output } = captureIo();

    await expect(
      runAgenCMcpCli(
        {
          kind: "management",
          argv: [
            "xaa",
            "setup",
            "--issuer",
            "http://idp.test",
            "--client-id",
            "agenc",
          ],
        },
        { io },
      ),
    ).resolves.toBe(1);
    expect(output().stderr).toContain("--issuer must use https://");
    expect(settingsMocks.updateSettingsForSource).not.toHaveBeenCalled();

    const second = captureIo();
    await expect(
      runAgenCMcpCli(
        {
          kind: "management",
          argv: [
            "xaa",
            "setup",
            "--issuer",
            "https://idp.test",
            "--client-id",
            "agenc",
            "--client-secret",
          ],
        },
        { io: second.io },
      ),
    ).resolves.toBe(1);
    expect(second.output().stderr).toContain(
      "MCP_XAA_IDP_CLIENT_SECRET env var",
    );
  });

  test("mcp xaa setup writes settings through injected IO and clears stale issuer secrets", async () => {
    xaaState.settings = {
      issuer: "https://old-idp.test",
      clientId: "old-client",
    };
    process.env.MCP_XAA_IDP_CLIENT_SECRET = "super-secret";
    const { io, output } = captureIo();

    await expect(
      runAgenCMcpCli(
        {
          kind: "management",
          argv: [
            "xaa",
            "setup",
            "--issuer",
            "https://idp.test",
            "--client-id",
            "agenc",
            "--client-secret",
            "--callback-port",
            "3456",
          ],
        },
        { io },
      ),
    ).resolves.toBe(0);

    expect(output().stdout).toContain(
      "XAA IdP connection configured for https://idp.test",
    );
    expect(output().stderr).toBe("");
    expect(xaaState.settings).toEqual({
      issuer: "https://idp.test",
      clientId: "agenc",
      callbackPort: 3456,
    });
    expect(xaaState.clientSecret).toBe("super-secret");
    expect(xaaState.clearedIdTokens).toEqual(["https://old-idp.test"]);
    expect(xaaState.clearedClientSecrets).toEqual(["https://old-idp.test"]);
  });

  test("mcp xaa login supports cached, forced, and id-token paths", async () => {
    xaaState.settings = {
      issuer: "https://idp.test",
      clientId: "agenc",
    };
    xaaState.cachedIdToken = "cached.jwt";
    const cached = captureIo();
    await expect(
      runAgenCMcpCli(
        { kind: "management", argv: ["xaa", "login"] },
        { io: cached.io },
      ),
    ).resolves.toBe(0);
    expect(cached.output().stdout).toContain("Already logged in");

    const forced = captureIo();
    await expect(
      runAgenCMcpCli(
        { kind: "management", argv: ["xaa", "login", "--force"] },
        { io: forced.io },
      ),
    ).resolves.toBe(0);
    expect(xaaState.acquireIdpIdToken).toHaveBeenCalled();
    expect(forced.output().stdout).toContain("If the browser did not open");

    const injected = captureIo();
    await expect(
      runAgenCMcpCli(
        {
          kind: "management",
          argv: ["xaa", "login", "--id-token", "manual.jwt"],
        },
        { io: injected.io },
      ),
    ).resolves.toBe(0);
    expect(xaaState.savedJwt).toBe("manual.jwt");
    expect(injected.output().stdout).toContain("id_token cached");
  });

  test("mcp xaa show and clear do not leak secrets or cached tokens", async () => {
    xaaState.settings = {
      issuer: "https://idp.test",
      clientId: "agenc-client",
      callbackPort: 3456,
    };
    xaaState.clientSecret = "super-secret";
    xaaState.cachedIdToken = "cached.jwt";
    const show = captureIo();

    await expect(
      runAgenCMcpCli(
        { kind: "management", argv: ["xaa", "show"] },
        { io: show.io },
      ),
    ).resolves.toBe(0);

    expect(show.output().stdout).toContain("Issuer:        https://idp.test");
    expect(show.output().stdout).toContain("Client ID:     agenc-client");
    expect(show.output().stdout).toContain("Client secret: (stored in keychain)");
    expect(show.output().stdout).toContain("Logged in:     yes");
    expect(show.output().stdout).not.toContain("super-secret");
    expect(show.output().stdout).not.toContain("cached.jwt");

    const clear = captureIo();
    await expect(
      runAgenCMcpCli(
        { kind: "management", argv: ["xaa", "clear"] },
        { io: clear.io },
      ),
    ).resolves.toBe(0);
    expect(clear.output().stdout).toContain("XAA IdP connection cleared");
    expect(xaaState.settings).toBeUndefined();
    expect(xaaState.clientSecret).toBeUndefined();
    expect(xaaState.cachedIdToken).toBeUndefined();
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
