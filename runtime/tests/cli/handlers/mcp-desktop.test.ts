import { Readable, Writable } from "node:stream";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test, vi } from "vitest";

vi.mock("bun:bundle", () => ({ feature: () => false }));

import {
  computeMcpDesktopRevision,
  loadInstalledPluginMcpConfigsOnly,
  MAX_MCP_DESKTOP_REQUEST_BYTES,
  McpDesktopCommandError,
  type McpDesktopDependencies,
  mcpDesktopListHandler,
  mcpDesktopSetEnabledHandler,
  mcpDesktopUpsertHandler,
  mergeMcpDesktopPatch,
  readMcpDesktopUpsertRequest,
} from "../../../src/cli/handlers/mcp-desktop.js";
import { installPluginOp } from "../../../src/plugins/cli/pluginOperations.js";
import type {
  McpServerConfig,
  ScopedMcpServerConfig,
} from "../../../src/services/mcp/types.js";

function captureIo(input = ""): {
  readonly io: {
    readonly stdin: Readable;
    readonly stdout: Writable;
    readonly stderr: Writable;
  };
  readonly output: () => { readonly stdout: string; readonly stderr: string };
} {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      stdin: Readable.from([input]),
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

function dependencies(
  configs: Readonly<Record<string, ScopedMcpServerConfig>>,
  overrides: Partial<McpDesktopDependencies> = {},
): McpDesktopDependencies {
  return {
    loadConfigs: vi.fn(async () => configs),
    persistUserConfig: vi.fn(async () => {}),
    setEnabled: vi.fn(),
    isDisabled: vi.fn(() => false),
    needsAuthentication: vi.fn(async () => false),
    authenticate: vi.fn(async () => {}),
    enterpriseConfigActive: vi.fn(() => false),
    policyAllows: vi.fn(() => true),
    ...overrides,
  };
}

function stdioConfig(
  overrides: Partial<ScopedMcpServerConfig> = {},
): ScopedMcpServerConfig {
  return {
    type: "stdio",
    command: "node",
    args: ["server.mjs"],
    scope: "user",
    ...overrides,
  } as ScopedMcpServerConfig;
}

function upsertJson(
  overrides: Readonly<Record<string, unknown>> = {},
): string {
  return JSON.stringify({
    name: "docs",
    transport: "stdio",
    command: "node",
    args: ["server.mjs"],
    env: [],
    envPassthrough: [],
    ...overrides,
  });
}

describe("Desktop MCP structured contract", () => {
  test("config-only list redacts env values and never starts authentication", async () => {
    const secret = "must-not-reach-renderer";
    const config = stdioConfig({
      args: ["server.mjs", "--token", "argument-secret", "--view=full"],
      env: { API_KEY: secret },
      env_vars: ["PATH"],
    });
    const deps = dependencies({ docs: config });
    const { io, output } = captureIo();

    await mcpDesktopListHandler(io, deps);

    const document = JSON.parse(output().stdout) as {
      schemaVersion: number;
      ok: boolean;
      result: { servers: Array<Record<string, unknown>> };
    };
    expect(document).toMatchObject({ schemaVersion: 1, ok: true });
    expect(document.result.servers).toEqual([
      expect.objectContaining({
        name: "docs",
        transport: "stdio",
        env: [{ name: "API_KEY", configured: true, sensitive: true }],
        envPassthrough: ["PATH"],
        editable: true,
      }),
    ]);
    expect(output().stdout).not.toContain(secret);
    expect(output().stdout).not.toContain("argument-secret");
    expect(deps.authenticate).not.toHaveBeenCalled();

    const redactedArgs = document.result.servers[0]!.args as string[];
    const patched = mergeMcpDesktopPatch(config, {
      name: "docs",
      transport: "stdio",
      command: "node",
      args: redactedArgs,
      env: [{ name: "API_KEY", configured: true, sensitive: true }],
      envPassthrough: ["PATH"],
    });
    expect((patched as { args: string[] }).args).toEqual([
      "server.mjs",
      "--token",
      "argument-secret",
      "--view=full",
    ]);
    const editedArgs = [...redactedArgs];
    editedArgs[0] = "updated.mjs";
    const patchedArgs = mergeMcpDesktopPatch(config, {
      name: "docs",
      transport: "stdio",
      command: "node",
      args: editedArgs,
      env: [{ name: "API_KEY", configured: true, sensitive: true }],
      envPassthrough: ["PATH"],
    });
    expect((patchedArgs as { args: string[] }).args).toEqual([
      "updated.mjs",
      "--token",
      "argument-secret",
      "--view=full",
    ]);
  });

  test("config-only list redacts URL credentials and preserves them on no-op edit", async () => {
    const rawUrl =
      "https://agent:password@example.test/mcp?access_token=opaque&view=full#private";
    const remote = {
      type: "http",
      url: rawUrl,
      scope: "user",
    } satisfies ScopedMcpServerConfig;
    const deps = dependencies({ remote });
    const { io, output } = captureIo();

    await mcpDesktopListHandler(io, deps);

    expect(output().stdout).not.toContain("password");
    expect(output().stdout).not.toContain("opaque");
    expect(output().stdout).not.toContain("private");
    const document = JSON.parse(output().stdout) as {
      result: { servers: Array<{ url: string }> };
    };
    const redactedUrl = document.result.servers[0]!.url;
    const patched = mergeMcpDesktopPatch(remote, {
      name: "remote",
      transport: "http",
      url: redactedUrl,
      args: [],
      env: [],
      envPassthrough: [],
    });
    expect((patched as { url: string }).url).toBe(rawUrl);

    const edited = new URL(redactedUrl);
    edited.searchParams.set("view", "compact");
    const editedPatch = mergeMcpDesktopPatch(remote, {
      name: "remote",
      transport: "http",
      url: edited.toString(),
      args: [],
      env: [],
      envPassthrough: [],
    }) as { url: string };
    const restored = new URL(editedPatch.url);
    expect(restored.username).toBe("agent");
    expect(restored.password).toBe("password");
    expect(restored.searchParams.get("access_token")).toBe("opaque");
    expect(restored.searchParams.get("view")).toBe("compact");
    expect(restored.hash).toBe("#private");
  });

  test("redacts structured npx and mcp-remote argv without losing opaque stored values", async () => {
    const rawArgs = [
      "-y",
      "mcp-remote",
      "https://example.test/private-path?token=query-secret",
      "--header",
      "Authorization: Bearer header-secret",
      "-H",
      "X-Api-Key: second-secret",
      "--env",
      "API_KEY=env-secret",
      "--env=COOKIE=session-secret",
      "sk-positional-secret-123456",
    ];
    const config = stdioConfig({ command: "npx", args: rawArgs });
    const { io, output } = captureIo();

    await mcpDesktopListHandler(io, dependencies({ remote: config }));

    for (const secret of [
      "private-path",
      "query-secret",
      "header-secret",
      "second-secret",
      "env-secret",
      "session-secret",
      "positional-secret",
    ]) {
      expect(output().stdout).not.toContain(secret);
    }
    const document = JSON.parse(output().stdout) as {
      result: { servers: Array<{ args: string[] }> };
    };
    const redacted = document.result.servers[0]!.args;
    expect(redacted).toEqual([
      "-y",
      "mcp-remote",
      "https://example.test/[REDACTED]",
      "--header",
      "Authorization: [REDACTED]",
      "-H",
      "X-Api-Key: [REDACTED]",
      "--env",
      "API_KEY=[REDACTED]",
      "--env=COOKIE=[REDACTED]",
      "[REDACTED]",
    ]);
    const restored = mergeMcpDesktopPatch(config, {
      name: "remote",
      transport: "stdio",
      command: "npx",
      args: redacted,
      env: [],
      envPassthrough: [],
    });
    expect((restored as { args: string[] }).args).toEqual(rawArgs);
  });

  test("config-only new-stack inventory includes a locally installed Ledger MCP", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenc-mcp-new-stack-"));
    const agencHome = join(root, "home");
    const workspaceRoot = join(root, "workspace");
    const repoRoot = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../../..",
    );
    await installPluginOp({
      source: join(repoRoot, "plugins", "ledger-wallet-cli"),
      agencHome,
      workspaceRoot,
      scope: "user",
    });

    const configs = await loadInstalledPluginMcpConfigsOnly({
      agencHome,
      workspaceRoot,
      env: {},
    });
    const { io, output } = captureIo();
    await mcpDesktopListHandler(io, dependencies(configs));

    const document = JSON.parse(output().stdout) as {
      result: { servers: Array<Record<string, unknown>> };
    };
    expect(document.result.servers).toEqual([
      expect.objectContaining({
        name: "plugin:ledger-wallet-cli:ledger-wallet-cli",
        pluginId: "ledger-wallet-cli",
        source: "plugin:ledger-wallet-cli",
        transport: "stdio",
        command: "node",
        args: ["./mcp/ledger-wallet-cli-server.mjs"],
        editable: false,
      }),
    ]);
  });

  test("secret-preserving PATCH keeps opaque env and remote auth fields", () => {
    const currentStdio: McpServerConfig = {
      type: "stdio",
      command: "old",
      args: [],
      env: { API_KEY: "opaque-secret", KEEP: "still-here" },
    };
    const patchedStdio = mergeMcpDesktopPatch(currentStdio, {
      name: "docs",
      transport: "stdio",
      command: "new",
      args: ["serve"],
      env: [
        { name: "API_KEY", configured: true, sensitive: true },
        { name: "DELETE_ME", configured: false },
      ],
      envPassthrough: ["PATH"],
    });
    expect(patchedStdio).toMatchObject({
      command: "new",
      args: ["serve"],
      env: { API_KEY: "opaque-secret", KEEP: "still-here" },
      env_vars: ["PATH"],
    });

    const currentRemote = {
      type: "http",
      url: "https://old.example/mcp",
      headers: { Authorization: "Bearer opaque" },
      oauth: { clientId: "desktop" },
      enabled_tools: ["search"],
    } satisfies McpServerConfig;
    const patchedRemote = mergeMcpDesktopPatch(currentRemote, {
      name: "remote",
      transport: "http",
      url: "https://new.example/mcp",
      args: [],
      env: [],
      envPassthrough: [],
    });
    expect(patchedRemote).toMatchObject({
      url: "https://new.example/mcp",
      headers: { Authorization: "Bearer opaque" },
      oauth: { clientId: "desktop" },
      enabled_tools: ["search"],
    });
  });

  test("upsert rejects stale revision before persistence", async () => {
    const existing = stdioConfig({ env: { API_KEY: "opaque-secret" } });
    const persist = vi.fn(async () => {});
    const deps = dependencies({ docs: existing }, { persistUserConfig: persist });
    const { io } = captureIo(
      upsertJson({
        originalName: "docs",
        revision: "0".repeat(64),
        env: [{ name: "API_KEY", configured: true, sensitive: true }],
      }),
    );

    await expect(mcpDesktopUpsertHandler(io, deps)).rejects.toMatchObject({
      code: "MCP_REVISION_CONFLICT",
    });
    expect(persist).not.toHaveBeenCalled();

    const actual = computeMcpDesktopRevision("docs", "user", existing);
    expect(actual).toMatch(/^[a-f0-9]{64}$/u);
  });

  test("enable and disable require an existing server", async () => {
    const setEnabled = vi.fn();
    const deps = dependencies(
      {
        docs: stdioConfig(),
        "plugin:ledger-wallet-cli:ledger-wallet-cli": stdioConfig({
          scope: "dynamic",
          pluginSource: "/Users/private/plugin-cache/ledger-wallet-cli",
          pluginServer: {
            pluginName: "ledger-wallet-cli",
            serverName: "ledger-wallet-cli",
          },
        }),
      },
      { setEnabled },
    );
    const enabledIo = captureIo();
    const disabledIo = captureIo();

    await mcpDesktopSetEnabledHandler("docs", true, enabledIo.io, deps);
    await mcpDesktopSetEnabledHandler("docs", false, disabledIo.io, deps);
    await mcpDesktopSetEnabledHandler(
      "plugin:ledger-wallet-cli:ledger-wallet-cli",
      false,
      captureIo().io,
      deps,
    );
    expect(setEnabled.mock.calls).toEqual([
      ["docs", true],
      ["docs", false],
      ["plugin:ledger-wallet-cli:ledger-wallet-cli", false],
    ]);

    const listed = captureIo();
    await mcpDesktopListHandler(listed.io, deps);
    expect(listed.output().stdout).not.toContain("/Users/private");
    expect(listed.output().stdout).toContain('"pluginId":"ledger-wallet-cli"');

    await expect(
      mcpDesktopSetEnabledHandler("missing", true, captureIo().io, deps),
    ).rejects.toMatchObject({ code: "MCP_NOT_FOUND" });
  });

  test("strict stdin rejects duplicate JSON keys, malformed JSON, and oversize", async () => {
    await expect(
      readMcpDesktopUpsertRequest(
        Readable.from([
          '{"name":"docs","name":"other","transport":"stdio","command":"node","args":[],"env":[],"envPassthrough":[]}',
        ]),
      ),
    ).rejects.toBeInstanceOf(McpDesktopCommandError);

    await expect(
      readMcpDesktopUpsertRequest(Readable.from(['{"name":'])),
    ).rejects.toMatchObject({ code: "MCP_INVALID_REQUEST" });

    await expect(
      readMcpDesktopUpsertRequest(
        Readable.from([upsertJson({
          env: [{ name: "API_KEY", configured: true, value: "line-one\nline-two" }],
        })]),
      ),
    ).rejects.toMatchObject({ code: "MCP_INVALID_REQUEST" });

    await expect(
      readMcpDesktopUpsertRequest(
        Readable.from([Buffer.alloc(MAX_MCP_DESKTOP_REQUEST_BYTES + 1, 0x78)]),
      ),
    ).rejects.toMatchObject({ code: "MCP_REQUEST_TOO_LARGE" });
  });
});
