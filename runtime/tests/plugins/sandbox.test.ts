import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import type { McpServerConfig } from "../config/schema.js";
import {
  pathInsideOrEqual,
  resolvePluginMcpSandboxedServer,
} from "./sandbox.js";

describe("plugin MCP sandboxing", () => {
  test("isolates stdio child processes with reserved env precedence and metadata", async () => {
    await withTempPluginRoot(async ({ pluginRoot, dataDir, plugin }) => {
      const nestedCwd = path.join(pluginRoot, "server");
      await mkdir(nestedCwd, { recursive: true });
      const previousSecret = process.env.AGENC_PLUGIN_SANDBOX_TEST_SECRET;
      try {
        process.env.AGENC_PLUGIN_SANDBOX_TEST_SECRET = "do-not-copy";
        const result = resolvePluginMcpSandboxedServer(
          plugin,
          "local",
          {
            command: "node",
            args: ["server.js"],
            cwd: `${nestedCwd}${path.sep}`,
            env: {
              CUSTOM: "kept",
              AGENC_PLUGIN_ROOT: "bad-root",
              AGENC_PLUGIN_DATA: "bad-data",
              AGENC_PLUGIN_NAME: "bad-name",
              AGENC_PLUGIN_MCP_SERVER: "bad-server",
              AGENC_PLUGIN_SANDBOX: "none",
            },
          },
          {
            scopedServerName: "plugin:sample:local",
            dataDir,
          },
        );
        const server = expectSandboxedServer(result);

        expect(server.cwd).toBe(nestedCwd);
        expect(server.env).toMatchObject({
          CUSTOM: "kept",
          AGENC_PLUGIN_ROOT: pluginRoot,
          AGENC_PLUGIN_DATA: dataDir,
          AGENC_PLUGIN_NAME: "sample",
          AGENC_PLUGIN_MCP_SERVER: "local",
          AGENC_PLUGIN_SANDBOX: "stdio-child-process",
        });
        expect(server.env).not.toHaveProperty("AGENC_PLUGIN_SANDBOX_TEST_SECRET");
        expect(server.pluginSandbox).toEqual({
          mode: "stdio-child-process",
          pluginName: "sample",
          pluginRoot,
          pluginDataDir: dataDir,
          serverName: "local",
          scopedServerName: "plugin:sample:local",
        });
      } finally {
        if (previousSecret === undefined) {
          delete process.env.AGENC_PLUGIN_SANDBOX_TEST_SECRET;
        } else {
          process.env.AGENC_PLUGIN_SANDBOX_TEST_SECRET = previousSecret;
        }
      }
    });
  });

  test("defaults stdio cwd to plugin root and allows missing in-root directories", async () => {
    await withTempPluginRoot(async ({ pluginRoot, dataDir, plugin }) => {
      const defaultResult = resolvePluginMcpSandboxedServer(
        plugin,
        "default-cwd",
        { command: "node" },
        { dataDir },
      );
      expect(expectSandboxedServer(defaultResult).cwd).toBe(pluginRoot);

      const missingCwd = path.join(pluginRoot, "created-at-startup", "nested");
      const missingResult = resolvePluginMcpSandboxedServer(
        plugin,
        "missing-cwd",
        { command: "node", cwd: missingCwd },
        { dataDir },
      );
      expect(expectSandboxedServer(missingResult).cwd).toBe(missingCwd);
    });
  });

  test("rejects cwd escapes after template resolution", async () => {
    await withTempPluginRoot(async ({ root, pluginRoot, dataDir, plugin }) => {
      const siblingPrefix = path.join(root, "sample-plugin-evil");
      await mkdir(siblingPrefix, { recursive: true });
      const parent = path.join(pluginRoot, "..");

      for (const cwd of [siblingPrefix, parent]) {
        const result = resolvePluginMcpSandboxedServer(
          plugin,
          "escape",
          { command: "node", cwd },
          { dataDir },
        );
        expect(result).toEqual({
          issue: expect.objectContaining({
            code: "cwd-outside-plugin-root",
          }),
        });
      }
    });
  });

  test("rejects symlinked cwd directories that realpath outside the plugin root", async () => {
    if (process.platform === "win32") return;
    await withTempPluginRoot(async ({ root, pluginRoot, dataDir, plugin }) => {
      const outside = path.join(root, "outside");
      const link = path.join(pluginRoot, "outside-link");
      await mkdir(outside, { recursive: true });
      await symlink(outside, link, "dir");

      const result = resolvePluginMcpSandboxedServer(
        plugin,
        "linked",
        { command: "node", cwd: link },
        { dataDir },
      );

      expect(result).toEqual({
        issue: expect.objectContaining({
          code: "cwd-outside-plugin-root",
        }),
      });
    });
  });

  test("rejects missing cwd leaves beneath symlinked ancestors that escape the plugin root", async () => {
    if (process.platform === "win32") return;
    await withTempPluginRoot(async ({ root, pluginRoot, dataDir, plugin }) => {
      const outside = path.join(root, "outside");
      const link = path.join(pluginRoot, "outside-link");
      await mkdir(outside, { recursive: true });
      await symlink(outside, link, "dir");

      const result = resolvePluginMcpSandboxedServer(
        plugin,
        "linked-missing",
        { command: "node", cwd: path.join(link, "created-at-startup") },
        { dataDir },
      );

      expect(result).toEqual({
        issue: expect.objectContaining({
          code: "cwd-outside-plugin-root",
        }),
      });
    });
  });

  test("rejects transport configs that do not match their process shape", async () => {
    await withTempPluginRoot(async ({ dataDir, plugin }) => {
      const stdioEndpointOnly = resolvePluginMcpSandboxedServer(
        plugin,
        "stdio-endpoint",
        {
          transport: "stdio",
          endpoint: "urn:agenc:plugin:stdio",
        },
        { dataDir },
      );
      expect(stdioEndpointOnly).toEqual({
        issue: expect.objectContaining({
          code: "invalid-transport-config",
          message: expect.stringContaining("requires a command"),
        }),
      });

      const remoteCommandOnly = resolvePluginMcpSandboxedServer(
        plugin,
        "http-command",
        {
          transport: "http",
          command: "node",
        },
        { dataDir },
      );
      expect(remoteCommandOnly).toEqual({
        issue: expect.objectContaining({
          code: "invalid-transport-config",
          message: expect.stringContaining("requires an endpoint"),
        }),
      });
    });
  });

  test("passes remote MCP servers through without child-process sandbox metadata", async () => {
    await withTempPluginRoot(async ({ dataDir, plugin }) => {
      for (const transport of ["http", "sse", "websocket", "ws"] as const) {
        const result = resolvePluginMcpSandboxedServer(
          plugin,
          transport,
          {
            transport,
            endpoint: `urn:agenc:plugin:${transport}`,
            headers: { Authorization: "Bearer token" },
          },
          { dataDir },
        );
        const server = expectSandboxedServer(result);

        expect(server.transport).toBe(transport);
        expect(server.headers).toEqual({ Authorization: "Bearer token" });
        expect(server.pluginSandbox).toBeUndefined();
        expect(server.env).toBeUndefined();
      }
    });
  });

  test("path containment does not accept sibling-prefix directories", () => {
    expect(pathInsideOrEqual("/tmp/plugin", "/tmp/plugin")).toBe(true);
    expect(pathInsideOrEqual("/tmp/plugin", "/tmp/plugin/server")).toBe(true);
    expect(pathInsideOrEqual("/tmp/plugin", "/tmp/plugin-evil")).toBe(false);
  });
});

function expectSandboxedServer(
  result: ReturnType<typeof resolvePluginMcpSandboxedServer>,
): McpServerConfig {
  expect("server" in result).toBe(true);
  if (!("server" in result)) {
    throw new Error(result.issue.message);
  }
  return result.server;
}

async function withTempPluginRoot(
  fn: (ctx: {
    readonly root: string;
    readonly pluginRoot: string;
    readonly dataDir: string;
    readonly plugin: {
      readonly name: string;
      readonly root: string;
      readonly source: string;
    };
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "agenc-plugin-sandbox-"));
  try {
    const pluginRoot = path.join(root, "sample-plugin");
    const dataDir = path.join(root, "data", "sample");
    await mkdir(pluginRoot, { recursive: true });
    await mkdir(dataDir, { recursive: true });
    await fn({
      root,
      pluginRoot,
      dataDir,
      plugin: {
        name: "sample",
        root: pluginRoot,
        source: "sample-source",
      },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
