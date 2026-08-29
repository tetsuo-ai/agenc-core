import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, test, vi } from "vitest";
import type { SecureStorageData } from "../utils/secureStorage/index.js";

const secureStorageRecords = vi.hoisted(
  () => new Map<string, SecureStorageData>(),
);

vi.mock("../utils/secureStorage/native.js", async importOriginal => {
  const actual =
    await importOriginal<typeof import("../utils/secureStorage/native.js")>();
  return {
    ...actual,
    readNativeSecureStorage: (home: { path: string }) =>
      structuredClone(secureStorageRecords.get(home.path) ?? {}),
    readNativeSecureStorageAsync: async (home: { path: string }) =>
      structuredClone(secureStorageRecords.get(home.path) ?? {}),
    updateNativeSecureStorage: (
      home: { path: string },
      updater: (current: SecureStorageData) => SecureStorageData,
    ) => {
      const previous = structuredClone(secureStorageRecords.get(home.path) ?? {});
      const written = structuredClone(updater(previous));
      if (JSON.stringify(previous) === JSON.stringify(written)) return null;
      secureStorageRecords.set(home.path, written);
      return { previous, written };
    },
    rollbackNativeSecureStorage: (
      home: { path: string },
      transaction: { previous: SecureStorageData; written: SecureStorageData } | null,
      updater: (
        current: SecureStorageData,
        transaction: { previous: SecureStorageData; written: SecureStorageData },
      ) => SecureStorageData,
    ) => {
      if (transaction === null) return;
      const current = structuredClone(secureStorageRecords.get(home.path) ?? {});
      secureStorageRecords.set(
        home.path,
        structuredClone(updater(current, transaction)),
      );
    },
  };
});

import { sourcePath } from "../helpers/source-path.ts";
import { findCommand, type Command } from "../commands.js";
import { MCPManager } from "../mcp-client/manager.js";
import { mcpServerNameValidationIssue } from "../mcp-client/server-name.js";
import {
  createPluginStorageAuthority,
  pluginDataDirPath,
} from "./directories.js";
import { loadPlugins, type PluginLoadIssue } from "./loader.js";
import { canonicalPluginRuntimeNamespace } from "./identifier-normalization.js";
import { substitutePluginTemplate } from "./registration/common.js";
import {
  loadPluginAgents,
  setActivePluginAgentSnapshot,
} from "./registration/load-plugin-agents.js";
import {
  loadPluginCommands,
  loadPluginSkills,
  setActivePluginCommandSnapshot,
  setActivePluginSkillSnapshot,
} from "./registration/load-plugin-commands.js";
import { loadPluginHooks } from "./registration/load-plugin-hooks.js";
import { loadPluginLspServers } from "./registration/lsp-plugin-integration.js";
import { getUnconfiguredChannels, loadPluginMcpServers } from "./registration/mcp-plugin-integration.js";
import {
  clearPluginRegistrationCaches,
  refreshActivePlugins,
  refreshPluginRegistrations,
} from "./registration/manager.js";
import { loadPluginOutputStyles } from "./registration/load-plugin-output-styles.js";
import type { SlashCommandContext } from "../commands/types.js";
import {
  clearAgentDefinitionsCache,
  getAgentDefinitionsWithOverrides,
  type PluginAgentDefinition,
} from "../tools/AgentTool/loadAgentsDir.js";
import { FILE_EDIT_TOOL_NAME } from "../tools/system/file-edit.js";
import { FILE_READ_TOOL_NAME } from "../tools/system/file-read.js";
import { FILE_WRITE_TOOL_NAME } from "../tools/system/file-write.js";
import { createAgentRoleWorkspace } from "../agents/role.js";
import { explicitDangerBroker } from "../helpers/explicit-danger-boundary.js";
import {
  resolveAgentRuntimeOptions,
  runWithAgentRuntimeOptions,
} from "../session/runtime-options.js";
import { ConfigStore } from "../config/store.js";
import { PlaintextPluginSecretError } from "../utils/plugins/pluginConfigAuthority.js";
import { runWithCanonicalSettingsAuthority } from "../utils/settings/canonicalAuthority.js";

const PLUGIN_MCP_ENV_SERVER_FIXTURE = sourcePath(
  "plugins/test-fixtures/plugin-mcp-env-server.cjs",
);

describe("plugin registration", () => {
  test("registers commands, agents, hooks, servers, and output styles from enabled plugins", async () => {
    await withTempPlugin(async ({ root, pluginRoot, options }) => {
      const result = await loadPlugins(options);
      const plugins = result.enabled;
      expect(plugins).toHaveLength(1);

      const commands = await loadPluginCommands({
        cwd: root,
        pluginStorageRoot: options.pluginStorageRoot,
        plugins,
        sessionId: "session-1",
      });
      const deploy = commands.find((command) => command.name === "sample:deploy");
      expect(deploy).toBeDefined();
      expect(deploy?.description).toBe("Deploy the project");
      expect(deploy?.allowedTools).toEqual([
        `Bash(${pluginRoot}/bin/deploy)`,
      ]);
      const sampleDataDir = pluginDataDirPath(
        "sample",
        createPluginStorageAuthority(options.pluginStorageRoot),
      );
      const prompt = await deploy?.getPromptForCommand?.("prod api", {});
      expect(prompt).toEqual([
        {
          type: "text",
          text:
            `Deploy prod api from ${pluginRoot} into prod with ` +
            `${sampleDataDir} ` +
            "using [configured:token] tags alpha,beta scopes read,write",
        },
      ]);

      const skills = await loadPluginSkills({
        cwd: root,
        pluginStorageRoot: options.pluginStorageRoot,
        plugins,
      });
      expect(skills.map((skill) => skill.name)).toEqual(["sample:inspector"]);
      await expect(skills[0]?.getPromptForCommand?.("", {}))
        .resolves.toEqual([
          expect.objectContaining({
            text: expect.stringContaining("Base directory for this skill:"),
          }),
        ]);

      const agents = await loadPluginAgents({
        cwd: root,
        pluginStorageRoot: options.pluginStorageRoot,
        plugins,
      });
      expect(agents).toHaveLength(1);
      expect(agents[0]).toMatchObject({
        agentType: "sample:review",
        source: "plugin",
        plugin: "sample",
        tools: ["Read", "Edit"],
      });
      expect(agents[0]?.getSystemPrompt())
        .toContain(`Use ${pluginRoot}/rules.md with [configured:token]`);
      expect("permissionMode" in (agents[0] ?? {})).toBe(false);
      expect("hooks" in (agents[0] ?? {})).toBe(false);
      expect("mcpServers" in (agents[0] ?? {})).toBe(false);

      const hooks = await loadPluginHooks({
        cwd: root,
        pluginStorageRoot: options.pluginStorageRoot,
        plugins,
        sessionId: "session-1",
      });
      expect(hooks?.PreToolUse?.[0]?.hooks[0]).toMatchObject({
        type: "command",
        command: `${pluginRoot}/hooks/pre.sh session-1`,
        statusMessage: `Checking ${pluginRoot} for session-1`,
      });

      const mcpServers = await loadPluginMcpServers({
        cwd: root,
        pluginStorageRoot: options.pluginStorageRoot,
        plugins,
      });
      expect(mcpServers["plugin:sample:local"]).toMatchObject({
        command: "node",
        args: [`${pluginRoot}/server.js`],
        cwd: pluginRoot,
        env: expect.objectContaining({
          AGENC_PLUGIN_ROOT: pluginRoot,
          AGENC_PLUGIN_DATA: pluginDataDirPath(
            "sample",
            createPluginStorageAuthority(options.pluginStorageRoot),
          ),
          AGENC_PLUGIN_NAME: "sample",
          AGENC_PLUGIN_MCP_SERVER: "local",
          AGENC_PLUGIN_SANDBOX: "stdio-child-process",
          TOKEN: "stored-token",
          TAGS: "alpha,beta",
          SCOPES: "read,write",
        }),
        pluginSandbox: {
          mode: "stdio-child-process",
          pluginName: "sample",
          pluginRoot,
          pluginDataDir: pluginDataDirPath(
            "sample",
            createPluginStorageAuthority(options.pluginStorageRoot),
          ),
          serverName: "local",
          scopedServerName: "plugin:sample:local",
        },
      });
      expect(getUnconfiguredChannels(plugins[0]!)).toEqual([]);

      const lspServers = await loadPluginLspServers({
        cwd: root,
        pluginStorageRoot: options.pluginStorageRoot,
        plugins,
      });
      expect(lspServers["plugin:sample:typescript"]).toMatchObject({
        command: "node",
        args: [`${pluginRoot}/lsp.js`],
        workspaceFolder: pluginRoot,
        extensionToLanguage: { ".ts": "typescript" },
      });

      const outputStyles = await loadPluginOutputStyles({
        cwd: root,
        pluginStorageRoot: options.pluginStorageRoot,
        plugins,
      });
      expect(outputStyles).toEqual([
        expect.objectContaining({
          name: "sample:terse",
          plugin: "sample",
          prompt: "Use short responses.",
          forceForPlugin: true,
        }),
      ]);

      const snapshot = await refreshPluginRegistrations({
        cwd: root,
        pluginStorageRoot: options.pluginStorageRoot,
        extraPluginDirs: [pluginRoot],
      });
      expect(snapshot).toMatchObject({
        enabled_count: 1,
        disabled_count: 0,
        command_count: 2,
        agent_count: 1,
        hook_count: 1,
        mcp_count: 1,
        lsp_count: 1,
        output_style_count: 1,
        error_count: 0,
      });
    });
  });

  test("keeps every executable namespace injective across plugin aliases", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenc-plugin-alias-runtime-"));
    const workspaceRoot = join(root, "workspace");
    const pluginStorageRoot = join(root, "home", "plugins");
    try {
      for (const [directory, pluginId] of [
        ["qualified", "foo@bar"],
        ["dotted", "foo.bar"],
      ] as const) {
        const pluginRoot = join(pluginStorageRoot, directory);
        await writeJson(join(pluginRoot, ".agenc-plugin", "plugin.json"), {
          name: "shared-package",
          mcpServers: { local: { command: "node", args: ["server.mjs"] } },
          lspServers: {
            typescript: {
              command: "node",
              args: ["lsp.mjs"],
              extensionToLanguage: { ".ts": "typescript" },
            },
          },
        });
        await writeJson(
          join(pluginRoot, ".agenc-plugin", "agenc-install.json"),
          { dependencyIdentity: pluginId },
        );
        await writeFileAt(
          join(pluginRoot, "commands", "run.md"),
          "---\naliases:\n  - quick\n  - shared-package:safe\n---\nRun.\n",
        );
        await writeFileAt(
          join(pluginRoot, "agents", "review.md"),
          "---\ndescription: Review.\n---\nReview.\n",
        );
        await writeFileAt(
          join(pluginRoot, "output-styles", "plain.md"),
          "---\ndescription: Plain.\n---\nPlain.\n",
        );
      }

      const plugins = (await loadPlugins({
        pluginStorageRoot,
        workspaceRoot,
        config: { plugins: { enabled: true } },
      })).enabled;
      expect(plugins.map((plugin) => plugin.id).sort()).toEqual([
        "foo.bar",
        "foo@bar",
      ]);
      expect(new Set(plugins.map((plugin) => plugin.name))).toEqual(
        new Set(["shared-package"]),
      );

      const [commands, agents, styles, mcpServers, lspServers] =
        await Promise.all([
          loadPluginCommands({ pluginStorageRoot, plugins }),
          loadPluginAgents({ pluginStorageRoot, plugins }),
          loadPluginOutputStyles({ pluginStorageRoot, plugins }),
          loadPluginMcpServers({ pluginStorageRoot, plugins }),
          loadPluginLspServers({ pluginStorageRoot, plugins }),
        ]);
      const namespaces = ["foo@bar", "foo.bar"].map(
        canonicalPluginRuntimeNamespace,
      );
      expect(new Set(namespaces).size).toBe(2);
      expect(commands.map((command) => command.name).sort()).toEqual(
        namespaces.map((namespace) => `${namespace}:run`).sort(),
      );
      for (const namespace of namespaces) {
        const command = commands.find((entry) =>
          entry.name === `${namespace}:run`
        );
        expect(command?.aliases).toEqual([
          `${namespace}:quick`,
          `${namespace}:safe`,
        ]);
      }
      expect(agents.map((agent) => [agent.agentType, agent.plugin]).sort())
        .toEqual(namespaces.map((namespace, index) => [
          `${namespace}:review`,
          ["foo@bar", "foo.bar"][index],
        ]).sort());
      expect(styles.map((style) => [style.name, style.plugin]).sort())
        .toEqual(namespaces.map((namespace, index) => [
          `${namespace}:plain`,
          ["foo@bar", "foo.bar"][index],
        ]).sort());
      for (const [pluginId, namespace] of ["foo@bar", "foo.bar"].map(
        (pluginId) => [pluginId, canonicalPluginRuntimeNamespace(pluginId)] as const,
      )) {
        expect(mcpServers[`plugin:${namespace}:local`]).toMatchObject({
          env: expect.objectContaining({ AGENC_PLUGIN_NAME: pluginId }),
          pluginSandbox: expect.objectContaining({ pluginName: pluginId }),
        });
        expect(lspServers[`plugin:${namespace}:typescript`]).toMatchObject({
          env: expect.objectContaining({ AGENC_PLUGIN_NAME: pluginId }),
        });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("never exposes a manifest-sensitive value from bundled plugin settings", async () => {
    await withTempPlugin(async ({ pluginRoot, options, configStore }) => {
      const manifestPath = join(pluginRoot, ".agenc-plugin", "plugin.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
        mcpServers: { local: { env: Record<string, string> } };
        channels: Array<{
          server: string;
          userConfig: Record<string, Record<string, unknown>>;
        }>;
        settings?: {
          options: Record<string, unknown>;
        };
      };
      manifest.mcpServers.local.env.CHANNEL_SECRET =
        "${user_config.channel_secret}";
      manifest.channels[0]!.userConfig.channel_secret = {
        type: "string",
        title: "Channel secret",
        description: "Channel-only secret",
        sensitive: true,
      };
      manifest.settings = {
        options: {
          token: "plaintext-bundled-token",
          channel_secret: "plaintext-channel-token",
          tags: ["alpha", "beta"],
        },
      };
      await writeJson(manifestPath, manifest);
      const existing = secureStorageRecords.get(configStore.homeContext.path) ?? {};
      secureStorageRecords.set(configStore.homeContext.path, {
        ...existing,
        pluginSecrets: {
          ...existing.pluginSecrets,
          "sample/local": {
            channel_secret: "channel-stored-token",
          },
        },
      });

      const result = await loadPlugins(options);
      const plugin = result.enabled[0]!;
      expect(JSON.stringify(plugin)).not.toContain("plaintext-bundled-token");
      expect(JSON.stringify(plugin)).not.toContain("plaintext-channel-token");
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          type: "settings",
          message: expect.stringContaining(
            "Sensitive plugin option(s) channel_secret, token were ignored",
          ),
        }),
      );

      const servers = await loadPluginMcpServers({
        pluginStorageRoot: options.pluginStorageRoot,
        plugins: [plugin],
      });
      expect(servers["plugin:sample:local"]?.env?.TOKEN).toBe("stored-token");
      expect(servers["plugin:sample:local"]?.env?.CHANNEL_SECRET).toBe(
        "channel-stored-token",
      );
      expect(JSON.stringify(servers)).not.toContain("plaintext-bundled-token");
      expect(JSON.stringify(servers)).not.toContain("plaintext-channel-token");
    });
  });

  test("rejects plaintext plugin secrets even when native secure storage is configured", async () => {
    await withTempPlugin(async ({ pluginRoot, options, configStore }) => {
      await writeFileAt(
        join(options.agencHome, "config.toml"),
        [
          "config_version = 2",
          `[pluginConfigs.${JSON.stringify("sample")}.options]`,
          'token = "plaintext-config-token"',
          "",
        ].join("\n"),
      );
      await configStore.reload();
      const plugin = (await loadPlugins(options)).enabled[0]!;

      await expect(
        loadPluginMcpServers({
          pluginStorageRoot: options.pluginStorageRoot,
          plugins: [plugin],
        }),
      ).rejects.toThrowError(PlaintextPluginSecretError);
    });
  });

  test("template substitution treats replacement-token paths literally and creates data dirs lazily", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenc-plugin-$&-"));
    const previousCacheDir = process.env.AGENC_PLUGIN_CACHE_DIR;
    const pluginRoot = join(root, ".agents", "plugins", "dollar-plugin");
    const agencHome = join(root, "home");
    const pluginStorageRoot = join(agencHome, "plugins");
    const cacheRoot = join(root, "cache-$$");
    try {
      process.env.AGENC_PLUGIN_CACHE_DIR = cacheRoot;
      await writeJson(join(pluginRoot, ".agenc-plugin", "plugin.json"), {
        name: "dollar",
      });

      const result = await loadPlugins({
        pluginStorageRoot,
        workspaceRoot: root,
        config: { plugins: { enabled: true } },
      });
      const plugin = result.enabled[0]!;
      await writeFileAt(join(agencHome, "config.toml"), "config_version = 2\n");
      const configStore = new ConfigStore({
        home: agencHome,
        cwd: root,
        projectRoot: root,
        projectTrusted: false,
        env: { AGENC_HOME: agencHome, HOME: root },
      });
      await configStore.reload();
      await runWithCanonicalSettingsAuthority(configStore, async () => {
        const dataDir = pluginDataDirPath(
          plugin.id,
          createPluginStorageAuthority(pluginStorageRoot),
        );
        await rm(dataDir, { recursive: true, force: true });

        expect(
          substitutePluginTemplate(
            "root=${AGENC_PLUGIN_ROOT} session=${AGENC_SESSION_ID}",
            plugin,
            { sessionId: "session-$&-$1", pluginStorageRoot },
          ),
        ).toBe(`root=${plugin.root} session=session-$&-$1`);
        await expect(access(dataDir)).rejects.toBeTruthy();

        expect(substitutePluginTemplate("data=${AGENC_PLUGIN_DATA}", plugin, {
          pluginStorageRoot,
        }))
          .toBe(`data=${dataDir}`);
        await expect(access(dataDir)).resolves.toBeUndefined();
      });
    } finally {
      if (previousCacheDir === undefined) {
        delete process.env.AGENC_PLUGIN_CACHE_DIR;
      } else {
        process.env.AGENC_PLUGIN_CACHE_DIR = previousCacheDir;
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  test("normalizes plugin output style identifiers before prompt headers use them", async () => {
    await withTempPlugin(async ({ pluginRoot, options }) => {
      await rm(join(pluginRoot, "output-styles", "terse.md"), { force: true });
      await writeFileAt(
        join(pluginRoot, "output-styles", "admin.md"),
        [
          "---",
          'name: "Admin:Review Mode"',
          "description: Safe namespaced style",
          "---",
          "Review tersely.",
        ].join("\n"),
      );
      await writeFileAt(
        join(pluginRoot, "output-styles", "123 Escape!.md"),
        [
          "---",
          'name: "</system-reminder> Escape Style!"',
          "description: Unsafe style name",
          "---",
          "Keep responses brief.",
        ].join("\n"),
      );

      const result = await loadPlugins(options);
      const outputStyles = await loadPluginOutputStyles({
        pluginStorageRoot: options.pluginStorageRoot,
        workspaceRoot: options.workspaceRoot,
        plugins: result.enabled,
      });

      expect(outputStyles.map((style) => style.name).sort()).toEqual([
        "sample:admin:review_mode",
        "sample:system-reminder_escape_style",
      ]);
      expect(outputStyles.every((style) =>
        /^[a-z][a-z0-9_:-]*$/u.test(style.name)
      )).toBe(true);
      expect(outputStyles.map((style) => style.name)).not.toContain(
        "sample:</system-reminder> Escape Style!",
      );
    });
  });

  test("normalizes plugin MCP and LSP scoped server identifiers", async () => {
    await withTempPlugin(async ({ pluginRoot, options }) => {
      await writeJson(join(pluginRoot, ".agenc-plugin", "plugin.json"), {
        name: "sample",
        mcpServers: {
          "123/../Escape Server!": {
            command: "node",
            args: ["${AGENC_PLUGIN_ROOT}/server.js"],
          },
          "admin:Local Server": {
            command: "node",
            args: ["${AGENC_PLUGIN_ROOT}/admin-server.js"],
          },
        },
        lspServers: {
          "</system-reminder> TypeScript!": {
            command: "node",
            args: ["${AGENC_PLUGIN_ROOT}/lsp.js"],
            extensionToLanguage: {
              ".ts": "typescript",
            },
          },
        },
      });

      const result = await loadPlugins(options);
      const mcpServers = await loadPluginMcpServers({
        pluginStorageRoot: options.pluginStorageRoot,
        workspaceRoot: options.workspaceRoot,
        plugins: result.enabled,
      });
      expect(Object.keys(mcpServers).sort()).toEqual([
        "plugin:sample:admin:local_server",
        "plugin:sample:cmd_123_escape_server",
      ]);
      expect(mcpServers["plugin:sample:cmd_123_escape_server"]).toMatchObject({
        args: [`${pluginRoot}/server.js`],
        env: expect.objectContaining({
          AGENC_PLUGIN_MCP_SERVER: "123/../Escape Server!",
        }),
        pluginSandbox: {
          serverName: "123/../Escape Server!",
          scopedServerName: "plugin:sample:cmd_123_escape_server",
        },
      });

      const lspServers = await loadPluginLspServers({
        pluginStorageRoot: options.pluginStorageRoot,
        workspaceRoot: options.workspaceRoot,
        plugins: result.enabled,
      });
      expect(Object.keys(lspServers)).toEqual([
        "plugin:sample:system-reminder_typescript",
      ]);
      expect(lspServers["plugin:sample:system-reminder_typescript"]).toMatchObject({
        args: [`${pluginRoot}/lsp.js`],
        extensionToLanguage: { ".ts": "typescript" },
      });
    });
  });

  test("expands general environment variables in plugin MCP and LSP server configs", async () => {
    await withTempPlugin(async ({ pluginRoot, options }) => {
      const environment = {
        AGENC_PLUGIN_TEST_COMMAND: "node",
        AGENC_PLUGIN_TEST_ARG: "expanded-arg",
        AGENC_PLUGIN_TEST_CWD: "workspace",
      };
      await writeJson(join(pluginRoot, ".agenc-plugin", "plugin.json"), {
        name: "sample",
        mcpServers: {
          local: {
            command: "${AGENC_PLUGIN_TEST_COMMAND}",
            args: [
              "--flag=${AGENC_PLUGIN_TEST_ARG}",
              "${AGENC_PLUGIN_TEST_DEFAULT:-fallback}",
            ],
            env: {
              EXPANDED: "${AGENC_PLUGIN_TEST_ARG}",
            },
            headers: {
              Authorization: "Bearer ${AGENC_PLUGIN_TEST_ARG}",
            },
            cwd: "cwd-${AGENC_PLUGIN_TEST_CWD}",
          },
        },
        lspServers: {
          typescript: {
            command: "${AGENC_PLUGIN_TEST_COMMAND}",
            args: ["--stdio=${AGENC_PLUGIN_TEST_ARG}"],
            env: {
              EXPANDED: "${AGENC_PLUGIN_TEST_ARG}",
            },
            workspaceFolder: "workspace-${AGENC_PLUGIN_TEST_CWD}",
            extensionToLanguage: {
              ".ts": "typescript",
            },
          },
        },
      });

      const result = await loadPlugins(options);
      const errors: PluginLoadIssue[] = [];
      const mcpServers = await loadPluginMcpServers({
        pluginStorageRoot: options.pluginStorageRoot,
        plugins: result.enabled,
        errors,
        env: environment,
      });
      const lspServers = await loadPluginLspServers({
        pluginStorageRoot: options.pluginStorageRoot,
        plugins: result.enabled,
        errors,
        env: environment,
      });

      expect(errors).toEqual([]);
      expect(mcpServers["plugin:sample:local"]).toMatchObject({
        command: "node",
        args: ["--flag=expanded-arg", "fallback"],
        env: expect.objectContaining({ EXPANDED: "expanded-arg" }),
        headers: { Authorization: "Bearer expanded-arg" },
        cwd: join(pluginRoot, "cwd-workspace"),
      });
      expect(lspServers["plugin:sample:typescript"]).toMatchObject({
        command: "node",
        args: ["--stdio=expanded-arg"],
        env: expect.objectContaining({ EXPANDED: "expanded-arg" }),
        workspaceFolder: join(pluginRoot, "workspace-workspace"),
      });
    });
  });

  test("plugin MCP sandbox env overrides manifest attempts to redefine reserved keys", async () => {
    await withTempPlugin(async ({ pluginRoot, options }) => {
      await writeJson(join(pluginRoot, ".agenc-plugin", "plugin.json"), {
        name: "sample",
        mcpServers: {
          local: {
            command: "node",
            env: {
              AGENC_PLUGIN_ROOT: "bad-root",
              AGENC_PLUGIN_DATA: "bad-data",
              AGENC_PLUGIN_NAME: "bad-name",
              AGENC_PLUGIN_MCP_SERVER: "bad-server",
              AGENC_PLUGIN_SANDBOX: "none",
            },
          },
        },
      });

      const result = await loadPlugins(options);
      const mcpServers = await loadPluginMcpServers({
        pluginStorageRoot: options.pluginStorageRoot,
        plugins: result.enabled,
      });
      const server = mcpServers["plugin:sample:local"];

      expect(server?.env).toMatchObject({
        AGENC_PLUGIN_ROOT: pluginRoot,
        AGENC_PLUGIN_DATA: pluginDataDirPath(
          "sample",
          createPluginStorageAuthority(options.pluginStorageRoot),
        ),
        AGENC_PLUGIN_NAME: "sample",
        AGENC_PLUGIN_MCP_SERVER: "local",
        AGENC_PLUGIN_SANDBOX: "stdio-child-process",
      });
    });
  });

  test("bounds long plugin-scoped MCP identities before manager construction", async () => {
    await withTempPlugin(async ({ pluginRoot, options }) => {
      const pluginName = `plugin-${"p".repeat(245)}`;
      const serverName = `server-${"s".repeat(245)}`;
      await writeJson(join(pluginRoot, ".agenc-plugin", "plugin.json"), {
        name: pluginName,
        mcpServers: {
          [serverName]: { command: "node" },
        },
      });

      const result = await loadPlugins(options);
      const first = await loadPluginMcpServers({
        pluginStorageRoot: options.pluginStorageRoot,
        plugins: result.enabled,
      });
      const second = await loadPluginMcpServers({
        pluginStorageRoot: options.pluginStorageRoot,
        plugins: result.enabled,
      });
      const names = Object.keys(first);

      expect(names).toHaveLength(1);
      expect(names[0]).toHaveLength(256);
      expect(names[0]).toMatch(/:[a-f0-9]{64}$/u);
      expect(mcpServerNameValidationIssue(names[0])).toBeUndefined();
      expect(Object.keys(second)).toEqual(names);
      expect(() =>
        new MCPManager(
          Object.entries(first).map(([name, config]) => ({
            name,
            ...config,
          })),
        ),
      ).not.toThrow();
    });
  });

  test("starts plugin MCP stdio servers as isolated child processes with reserved env and cwd", async () => {
    await withTempPlugin(async ({ root, pluginRoot, options }) => {
      const serverCwd = join(pluginRoot, "server-cwd");
      const infoFile = join(root, "mcp-info.json");
      await mkdir(serverCwd, { recursive: true });
      await writeJson(join(pluginRoot, ".agenc-plugin", "plugin.json"), {
        name: "sample",
        mcpServers: {
          local: {
            command: process.execPath,
            args: [PLUGIN_MCP_ENV_SERVER_FIXTURE, infoFile],
            cwd: "./server-cwd",
            timeout: 10_000,
          },
        },
      });

      const result = await loadPlugins(options);
      const mcpServers = await loadPluginMcpServers({
        pluginStorageRoot: options.pluginStorageRoot,
        plugins: result.enabled,
      });
      const manager = new MCPManager(
        Object.entries(mcpServers).map(([name, config]) => ({
          name,
          ...config,
        })),
      );
      manager.setSandboxExecutionBroker(explicitDangerBroker);

      try {
        await manager.start({ requireOneReady: true, timeoutMs: 10_000 });
        const info = JSON.parse(await readFile(infoFile, "utf8")) as {
          readonly cwd: string;
          readonly env: Readonly<Record<string, string>>;
        };

        expect(manager.getConnectedServers()).toEqual(["plugin:sample:local"]);
        expect(manager.getTools().map((tool) => tool.name)).toContain(
          "mcp.plugin:sample:local.ping",
        );
        expect(info.cwd).toBe(serverCwd);
        expect(info.env).toMatchObject({
          AGENC_PLUGIN_ROOT: pluginRoot,
          AGENC_PLUGIN_DATA: pluginDataDirPath(
            "sample",
            createPluginStorageAuthority(options.pluginStorageRoot),
          ),
          AGENC_PLUGIN_NAME: "sample",
          AGENC_PLUGIN_MCP_SERVER: "local",
          AGENC_PLUGIN_SANDBOX: "stdio-child-process",
        });
      } finally {
        await manager.stop();
      }
    });
  });

  test("omits plugin MCP servers whose template-resolved cwd escapes the plugin root", async () => {
    await withTempPlugin(async ({ pluginRoot, options }) => {
      await writeJson(join(pluginRoot, ".agenc-plugin", "plugin.json"), {
        name: "sample",
        mcpServers: {
          local: {
            command: "node",
            cwd: "${AGENC_PLUGIN_TEST_CWD_ESCAPE}",
          },
        },
      });

      const result = await loadPlugins(options);
      const errors: PluginLoadIssue[] = [];
      const mcpServers = await loadPluginMcpServers({
        pluginStorageRoot: options.pluginStorageRoot,
        plugins: result.enabled,
        errors,
        env: { AGENC_PLUGIN_TEST_CWD_ESCAPE: "../outside" },
      });

      expect(mcpServers["plugin:sample:local"]).toBeUndefined();
      expect(errors).toEqual([
        expect.objectContaining({
          type: "mcp",
          path: "local",
          message: expect.stringContaining("escapes plugin root"),
        }),
      ]);
    });
  });

  test("omits plugin MCP and LSP servers with unresolved config placeholders", async () => {
    await withTempPlugin(async ({ root, pluginRoot, options, configStore }) => {
      const previousMissing = process.env.AGENC_PLUGIN_TEST_MISSING;
      try {
        delete process.env.AGENC_PLUGIN_TEST_MISSING;
        secureStorageRecords.set(configStore.homeContext.path, {});
        await writeJson(join(pluginRoot, ".agenc-plugin", "plugin.json"), {
          name: "sample",
          userConfig: {
            token: {
              type: "string",
              title: "Token",
              description: "Access token",
              required: true,
              sensitive: true,
            },
          },
          mcpServers: {
            local: {
              command: "node",
              args: ["${user_config.token}"],
              env: {
                MISSING: "${AGENC_PLUGIN_TEST_MISSING}",
              },
            },
          },
          lspServers: {
            typescript: {
              command: "node",
              args: ["${user_config.token}"],
              env: {
                MISSING: "${AGENC_PLUGIN_TEST_MISSING}",
              },
              extensionToLanguage: {
                ".ts": "typescript",
              },
            },
          },
        });

        const snapshot = await refreshPluginRegistrations({
          cwd: root,
          pluginStorageRoot: options.pluginStorageRoot,
          extraPluginDirs: [pluginRoot],
        });

        expect(snapshot.mcp_servers["plugin:sample:local"]).toBeUndefined();
        expect(snapshot.lsp_servers["plugin:sample:typescript"]).toBeUndefined();
        expect(snapshot.loadResult.errors).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: "mcp",
              path: "local",
              message: "Missing user configuration values: token",
            }),
            expect.objectContaining({
              type: "mcp",
              path: "local",
              message: "Missing environment variables: AGENC_PLUGIN_TEST_MISSING",
            }),
            expect.objectContaining({
              type: "lsp",
              path: "typescript",
              message: "Missing user configuration values: token",
            }),
            expect.objectContaining({
              type: "lsp",
              path: "typescript",
              message: "Missing environment variables: AGENC_PLUGIN_TEST_MISSING",
            }),
          ]),
        );
        expect(snapshot.error_count).toBeGreaterThanOrEqual(4);
      } finally {
        if (previousMissing === undefined) {
          delete process.env.AGENC_PLUGIN_TEST_MISSING;
        } else {
          process.env.AGENC_PLUGIN_TEST_MISSING = previousMissing;
        }
      }
    });
  });

  test("active refresh registers hooks, preserves AppState shapes, and publishes active discovery snapshots", async () => {
    await withTempPlugin(async ({ root, pluginRoot, options }) => {
      const roleWorkspace = createAgentRoleWorkspace(root);
      const hooksRuntime = { setPluginHooks: vi.fn() };
      const enabledConfig = {
        configVersion: 2 as const,
        plugins: {
          enabled: true,
          plugins: {
            sample: { path: pluginRoot },
          },
        },
        hooks: {
          Stop: [
            {
              matcher: "*",
              hooks: [{ type: "command" as const, command: "echo base" }],
            },
          ],
        },
      };
      const refreshConfigStore = {
        current: () => enabledConfig,
      };
      const builtInAgent = {
        agentType: "built-in",
        source: "built-in",
        whenToUse: "baseline",
      };
      const existingPluginError = {
        type: "lsp-manager",
        server: "ts",
        reason: "still active",
      };
      const staleLoaderError = {
        type: "manifest-validation-error",
        source: pluginRoot,
        plugin: "sample",
        manifestPath: join(pluginRoot, ".agenc-plugin", "plugin.json"),
        validationErrors: ["old error"],
      };
      let appState: Record<string, unknown> = {
        plugins: {
          enabled: [],
          disabled: [],
          commands: [],
          errors: [existingPluginError, staleLoaderError],
          needsRefresh: true,
        },
        agentDefinitions: {
          agentRoleWorkspaceId: roleWorkspace.id,
          allAgents: [builtInAgent],
          activeAgents: [builtInAgent],
        },
        mcp: { pluginReconnectKey: 7 },
      };
      const ctx = {
        cwd: root,
        home: root,
        pluginStorageRoot: options.pluginStorageRoot,
        argsRaw: "",
        configStore: refreshConfigStore,
        appState: {
          getAppState: () => appState,
          setAppState: (updater: (prev: unknown) => unknown) => {
            appState = updater(appState) as Record<string, unknown>;
          },
        },
        session: {
          roleWorkspace,
          services: {
            configStore: refreshConfigStore,
            hooksRuntime,
            runtimeOptions: { pluginStorageRoot: options.pluginStorageRoot },
          },
        },
      } as unknown as SlashCommandContext;

      const snapshot = await refreshActivePlugins(ctx);

      expect(snapshot.enabled_count).toBe(1);
      expect(hooksRuntime.setPluginHooks).toHaveBeenCalledWith(
        expect.objectContaining({
          PreToolUse: expect.any(Array),
        }),
      );
      expect(hooksRuntime.setPluginHooks.mock.calls[0]?.[0]).not.toHaveProperty(
        "Stop",
      );
      expect(appState.plugins).toMatchObject({
        needsRefresh: false,
      });
      const enabledPlugin = (appState.plugins as { enabled: Array<Record<string, unknown>> }).enabled[0]!;
      expect(enabledPlugin).toMatchObject({ name: "sample" });
      expect(enabledPlugin).not.toHaveProperty("settings");
      expect(enabledPlugin.manifest as Record<string, unknown>).not.toHaveProperty("settings");
      expect(JSON.stringify(enabledPlugin)).not.toContain("stored-token");
      expect((appState.plugins as { commands: Array<{ name: string }> }).commands.map((command) => command.name))
        .toEqual(["sample:deploy", "sample:inspector"]);
      expect((appState.plugins as { errors: unknown[] }).errors)
        .toContainEqual(existingPluginError);
      expect((appState.plugins as { errors: unknown[] }).errors)
        .not.toContainEqual(staleLoaderError);
      expect(appState.mcp).toMatchObject({ pluginReconnectKey: 8 });
      expect((appState.agentDefinitions as { activeAgents: Array<{ agentType: string }> }).activeAgents)
        .toEqual([
          builtInAgent,
          expect.objectContaining({ agentType: "sample:review" }),
        ]);

      await expect(loadPluginCommands({
        cwd: root,
        pluginStorageRoot: options.pluginStorageRoot,
      }))
        .resolves.toEqual([expect.objectContaining({ name: "sample:deploy" })]);
      await expect(loadPluginAgents({
        cwd: root,
        pluginStorageRoot: options.pluginStorageRoot,
      }))
        .resolves.toEqual([expect.objectContaining({ agentType: "sample:review" })]);

      const catalogConfigStore = new ConfigStore({
        home: options.agencHome,
        cwd: root,
        projectRoot: root,
        projectTrusted: false,
        env: {},
        loader: async () => enabledConfig,
      });
      await catalogConfigStore.reload();
      try {
        await runWithCanonicalSettingsAuthority(
          catalogConfigStore,
          () => runWithAgentRuntimeOptions(
            resolveAgentRuntimeOptions({}, {
              pluginStorageRoot: options.pluginStorageRoot,
            }),
            () => expect(getAgentDefinitionsWithOverrides(
              root,
              options.pluginStorageRoot,
            ))
              .resolves.toEqual(
                expect.objectContaining({
                  activeAgents: expect.arrayContaining([
                    expect.objectContaining({ agentType: "sample:review" }),
                  ]),
                }),
              ),
          ),
        );
      } finally {
        clearAgentDefinitionsCache();
      }
    });
  });

  test("active refresh treats array-shaped AppState containers as malformed", async () => {
    await withTempPlugin(async ({ root, pluginRoot, options }) => {
      const roleWorkspace = createAgentRoleWorkspace(root);
      const configStore = {
        current: vi.fn(() => ({
          plugins: {
            enabled: true,
            plugins: {
              sample: { path: pluginRoot },
            },
          },
        })),
      };
      const hooksRuntime = { setPluginHooks: vi.fn() };
      const staleError = {
        type: "lsp-manager",
        server: "stale",
        reason: "array-shaped plugin state",
      };
      const arrayPlugins = Object.assign(["stale-plugin-entry"], {
        errors: [staleError],
        needsRefresh: true,
      });
      const arrayAgentDefinitions = Object.assign(["stale-agent-entry"], {
        agentRoleWorkspaceId: roleWorkspace.id,
        allAgents: [{ agentType: "built-in", source: "built-in" }],
        activeAgents: [{ agentType: "built-in", source: "built-in" }],
      });
      const arrayMcp = Object.assign(["stale-mcp-entry"], {
        pluginReconnectKey: 41,
      });
      let appState: Record<string, unknown> = {
        plugins: arrayPlugins,
        agentDefinitions: arrayAgentDefinitions,
        mcp: arrayMcp,
      };
      const initialAppState = appState;
      const setAppState = vi.fn((updater: (prev: unknown) => unknown) => {
        appState = updater(appState) as Record<string, unknown>;
      });
      const ctx = {
        cwd: root,
        home: root,
        pluginStorageRoot: options.pluginStorageRoot,
        argsRaw: "",
        configStore,
        appState: {
          getAppState: () => appState,
          setAppState,
        },
        session: {
          roleWorkspace,
          services: {
            configStore,
            hooksRuntime,
            runtimeOptions: { pluginStorageRoot: options.pluginStorageRoot },
          },
        },
      } as unknown as SlashCommandContext;

      await expect(refreshActivePlugins(ctx)).rejects.toThrow(
        "live agent catalog provenance is unavailable",
      );
      expect(configStore.current).not.toHaveBeenCalled();
      expect(hooksRuntime.setPluginHooks).not.toHaveBeenCalled();
      expect(setAppState).not.toHaveBeenCalled();
      expect(appState).toBe(initialAppState);
    });
  });

  test("active refresh refuses a write-only AppState bridge before loading plugins", async () => {
    await withTempPlugin(async ({ root, pluginRoot, options }) => {
      const roleWorkspace = createAgentRoleWorkspace(root);
      const configStore = {
        current: vi.fn(() => ({
          plugins: { plugins: { sample: { path: pluginRoot } } },
        })),
      };
      const hooksRuntime = { setPluginHooks: vi.fn() };
      const setAppState = vi.fn();
      const ctx = {
        cwd: root,
        home: root,
        pluginStorageRoot: options.pluginStorageRoot,
        argsRaw: "",
        configStore,
        appState: { setAppState },
        session: {
          roleWorkspace,
          services: {
            configStore,
            hooksRuntime,
            runtimeOptions: { pluginStorageRoot: options.pluginStorageRoot },
          },
        },
      } as unknown as SlashCommandContext;

      await expect(refreshActivePlugins(ctx)).rejects.toThrow(
        "live agent catalog provenance is unavailable",
      );
      expect(configStore.current).not.toHaveBeenCalled();
      expect(hooksRuntime.setPluginHooks).not.toHaveBeenCalled();
      expect(setAppState).not.toHaveBeenCalled();
    });
  });

  test("binds plugin refresh to the immutable role workspace instead of execution cwd", async () => {
    await withTempPlugin(async ({ root, pluginRoot, options }) => {
      const executionCwd = join(root, "worktree");
      await mkdir(executionCwd, { recursive: true });
      const roleWorkspace = createAgentRoleWorkspace(root);
      const configStore = {
        current: () => ({
          plugins: {
            enabled: true,
            plugins: { sample: { path: pluginRoot } },
          },
        }),
      };
      let appState: Record<string, unknown> = {
        agentDefinitions: {
          agentRoleWorkspaceId: roleWorkspace.id,
          allAgents: [],
          activeAgents: [],
        },
        plugins: {},
        mcp: {},
      };
      const ctx = {
        cwd: executionCwd,
        home: root,
        pluginStorageRoot: options.pluginStorageRoot,
        argsRaw: "",
        configStore,
        appState: {
          getAppState: () => appState,
          setAppState: (updater: (prev: unknown) => unknown) => {
            appState = updater(appState) as Record<string, unknown>;
          },
        },
        session: {
          roleWorkspace,
          services: {
            configStore,
            runtimeOptions: { pluginStorageRoot: options.pluginStorageRoot },
          },
        },
      } as unknown as SlashCommandContext;

      await refreshActivePlugins(ctx);

      expect(appState.agentDefinitions).toMatchObject({
        agentRoleWorkspaceId: roleWorkspace.id,
        activeAgents: [expect.objectContaining({ agentType: "sample:review" })],
      });
      await expect(
        loadPluginAgents({ cwd: roleWorkspace.cwd, pluginStorageRoot: options.pluginStorageRoot }),
      ).resolves.toEqual([
        expect.objectContaining({ agentType: "sample:review" }),
      ]);
      await expect(
        loadPluginAgents({ cwd: executionCwd, pluginStorageRoot: options.pluginStorageRoot }),
      ).resolves.toEqual([]);
    });
  });

  test("clearing registration caches drops active discovery snapshots", async () => {
    await withTempPlugin(async ({ root, pluginRoot, options }) => {
      const cwd = join(root, "workspace-without-default-plugin");
      await mkdir(cwd, { recursive: true });
      const roleWorkspace = createAgentRoleWorkspace(cwd);
      const configStore = {
        current: () => ({
          plugins: {
            enabled: true,
            plugins: {
              sample: { path: pluginRoot },
            },
          },
        }),
      };
      const ctx = {
        cwd,
        home: root,
        pluginStorageRoot: options.pluginStorageRoot,
        argsRaw: "",
        configStore,
        session: {
          roleWorkspace,
          services: {
            configStore,
            runtimeOptions: { pluginStorageRoot: options.pluginStorageRoot },
          },
        },
      } as unknown as SlashCommandContext;

      await refreshActivePlugins(ctx);

      await expect(loadPluginCommands({ cwd, pluginStorageRoot: options.pluginStorageRoot }))
        .resolves.toEqual([expect.objectContaining({ name: "sample:deploy" })]);
      await expect(loadPluginSkills({ cwd, pluginStorageRoot: options.pluginStorageRoot }))
        .resolves.toEqual([expect.objectContaining({ name: "sample:inspector" })]);
      await expect(loadPluginAgents({ cwd, pluginStorageRoot: options.pluginStorageRoot }))
        .resolves.toEqual([expect.objectContaining({ agentType: "sample:review" })]);

      clearPluginRegistrationCaches();

      await expect(loadPluginCommands({ cwd, pluginStorageRoot: options.pluginStorageRoot }))
        .resolves.toEqual([]);
      await expect(loadPluginSkills({ cwd, pluginStorageRoot: options.pluginStorageRoot }))
        .resolves.toEqual([]);
      await expect(loadPluginAgents({ cwd, pluginStorageRoot: options.pluginStorageRoot }))
        .resolves.toEqual([]);
    });
  });

  test("keeps same-workspace command and agent snapshots isolated by plugin storage root", async () => {
    await withTempPlugin(async ({ root, options }) => {
      const result = await loadPlugins(options);
      const commandsA = await loadPluginCommands({
        cwd: root,
        pluginStorageRoot: options.pluginStorageRoot,
        plugins: result.enabled,
      });
      const agentsA = await loadPluginAgents({
        cwd: root,
        pluginStorageRoot: options.pluginStorageRoot,
        plugins: result.enabled,
      });
      const pluginStorageRootB = join(root, "plugin-storage-b");
      const commandsB = commandsA.map(command => ({
        ...command,
        name: `storage-b:${command.name}`,
      }));
      const agentsB = agentsA.map(agent => ({
        ...agent,
        agentType: `storage-b:${agent.agentType}`,
      }));

      setActivePluginCommandSnapshot(
        { cwd: root, pluginStorageRoot: options.pluginStorageRoot },
        commandsA,
      );
      setActivePluginCommandSnapshot(
        { cwd: root, pluginStorageRoot: pluginStorageRootB },
        commandsB,
      );
      setActivePluginAgentSnapshot(
        { cwd: root, pluginStorageRoot: options.pluginStorageRoot },
        agentsA,
      );
      setActivePluginAgentSnapshot(
        { cwd: root, pluginStorageRoot: pluginStorageRootB },
        agentsB,
      );

      const [resolvedCommandsA, resolvedCommandsB, resolvedAgentsA, resolvedAgentsB] =
        await Promise.all([
          loadPluginCommands({ cwd: root, pluginStorageRoot: options.pluginStorageRoot }),
          loadPluginCommands({ cwd: root, pluginStorageRoot: pluginStorageRootB }),
          loadPluginAgents({ cwd: root, pluginStorageRoot: options.pluginStorageRoot }),
          loadPluginAgents({ cwd: root, pluginStorageRoot: pluginStorageRootB }),
        ]);

      expect(resolvedCommandsA.map(command => command.name)).toEqual([
        "sample:deploy",
      ]);
      expect(resolvedCommandsB.map(command => command.name)).toEqual([
        "storage-b:sample:deploy",
      ]);
      expect(resolvedAgentsA.map(agent => agent.agentType)).toEqual([
        "sample:review",
      ]);
      expect(resolvedAgentsB.map(agent => agent.agentType)).toEqual([
        "storage-b:sample:review",
      ]);
      clearPluginRegistrationCaches();
    });
  });

  test("keeps same-root plugin snapshots isolated by ConfigStore identity", async () => {
    await withTempPlugin(async ({ root, options }) => {
      const sharedHome = options.agencHome;
      const storeA = new ConfigStore({
        home: sharedHome,
        cwd: root,
        projectRoot: root,
        projectTrusted: false,
        base: { plugins: { enabled: true } },
        env: { AGENC_HOME: sharedHome, HOME: root },
      });
      const storeB = new ConfigStore({
        home: sharedHome,
        cwd: root,
        projectRoot: root,
        projectTrusted: false,
        base: { plugins: { enabled: false } },
        env: { AGENC_HOME: sharedHome, HOME: root },
      });
      expect(storeA.homeContext.path).toBe(storeB.homeContext.path);
      expect(storeA.current().plugins?.enabled).toBe(true);
      expect(storeB.current().plugins?.enabled).toBe(false);

      const identity = {
        cwd: root,
        pluginStorageRoot: options.pluginStorageRoot,
      };
      const commandA = { name: "home-a:command" } as Command;
      const commandB = { name: "home-b:command" } as Command;
      const skillA = { name: "home-a:skill" } as Command;
      const skillB = { name: "home-b:skill" } as Command;
      const agentA = { agentType: "home-a:agent" } as PluginAgentDefinition;
      const agentB = { agentType: "home-b:agent" } as PluginAgentDefinition;

      runWithCanonicalSettingsAuthority(storeA, () => {
        setActivePluginCommandSnapshot(identity, [commandA]);
        setActivePluginSkillSnapshot(identity, [skillA]);
        setActivePluginAgentSnapshot(identity, [agentA]);
      });
      runWithCanonicalSettingsAuthority(storeB, () => {
        setActivePluginCommandSnapshot(identity, [commandB]);
        setActivePluginSkillSnapshot(identity, [skillB]);
        setActivePluginAgentSnapshot(identity, [agentB]);
      });

      const [commandsA, skillsA, agentsA] = await runWithCanonicalSettingsAuthority(
        storeA,
        () => Promise.all([
          loadPluginCommands(identity),
          loadPluginSkills(identity),
          loadPluginAgents(identity),
        ]),
      );
      const [commandsB, skillsB, agentsB] = await runWithCanonicalSettingsAuthority(
        storeB,
        () => Promise.all([
          loadPluginCommands(identity),
          loadPluginSkills(identity),
          loadPluginAgents(identity),
        ]),
      );

      expect(commandsA.map(command => command.name)).toEqual(["home-a:command"]);
      expect(skillsA.map(command => command.name)).toEqual(["home-a:skill"]);
      expect(agentsA.map(agent => agent.agentType)).toEqual(["home-a:agent"]);
      expect(commandsB.map(command => command.name)).toEqual(["home-b:command"]);
      expect(skillsB.map(command => command.name)).toEqual(["home-b:skill"]);
      expect(agentsB.map(agent => agent.agentType)).toEqual(["home-b:agent"]);

      runWithCanonicalSettingsAuthority(storeA, () => {
        clearPluginRegistrationCaches();
      });
      const [commandsBAfterClear, skillsBAfterClear, agentsBAfterClear] =
        await runWithCanonicalSettingsAuthority(
          storeB,
          () => Promise.all([
            loadPluginCommands(identity),
            loadPluginSkills(identity),
            loadPluginAgents(identity),
          ]),
        );
      expect(commandsBAfterClear.map(command => command.name)).toEqual([
        "home-b:command",
      ]);
      expect(skillsBAfterClear.map(command => command.name)).toEqual([
        "home-b:skill",
      ]);
      expect(agentsBAfterClear.map(agent => agent.agentType)).toEqual([
        "home-b:agent",
      ]);
      runWithCanonicalSettingsAuthority(storeB, () => {
        clearPluginRegistrationCaches();
      });
    });
  });

  test("explicit plugin discovery bypasses active snapshots for commands, skills, and agents", async () => {
    await withTempPlugin(async ({ root, pluginRoot, options }) => {
      const configStore = {
        current: () => ({
          plugins: {
            plugins: {
              sample: { path: pluginRoot },
            },
          },
        }),
      };
      await refreshActivePlugins({
        cwd: root,
        home: root,
        pluginStorageRoot: options.pluginStorageRoot,
        argsRaw: "",
        configStore,
        session: {
          roleWorkspace: createAgentRoleWorkspace(root),
          services: {
            configStore,
            runtimeOptions: { pluginStorageRoot: options.pluginStorageRoot },
          },
        },
      } as unknown as SlashCommandContext);

      const explicitRoot = join(root, "explicit-plugin");
      await writeJson(join(explicitRoot, ".agenc-plugin", "plugin.json"), {
        name: "explicit",
      });
      await writeFileAt(join(explicitRoot, "commands", "alt.md"), "Explicit command.");
      await writeFileAt(join(explicitRoot, "skills", "audit", "SKILL.md"), "Explicit skill.");
      await writeFileAt(
        join(explicitRoot, "agents", "audit.md"),
        [
          "---",
          "name: audit",
          "description: Audit explicit plugin",
          "---",
          "Audit the workspace.",
        ].join("\n"),
      );

      await expect(loadPluginCommands({
        cwd: root,
        pluginStorageRoot: options.pluginStorageRoot,
        extraPluginDirs: [explicitRoot],
      })).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "explicit:alt" }),
        ]),
      );
      await expect(loadPluginSkills({
        cwd: root,
        pluginStorageRoot: options.pluginStorageRoot,
        extraPluginDirs: [explicitRoot],
      })).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "explicit:audit" }),
        ]),
      );
      await expect(loadPluginAgents({
        cwd: root,
        pluginStorageRoot: options.pluginStorageRoot,
        extraPluginDirs: [explicitRoot],
      })).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ agentType: "explicit:audit" }),
        ]),
      );
    });
  });

  test("manifest object-map command names win over nested source paths", async () => {
    await withTempPlugin(async ({ pluginRoot, options }) => {
      await writeJson(join(pluginRoot, ".agenc-plugin", "plugin.json"), {
        name: "sample",
        commands: {
          deploy: {
            source: "./commands/admin/deploy.md",
          },
        },
      });
      await writeFileAt(join(pluginRoot, "commands", "admin", "deploy.md"), "Deploy nested.");

      const result = await loadPlugins(options);
      const commands = await loadPluginCommands({ plugins: result.enabled });

      expect(commands.map((command) => command.name)).toContain("sample:deploy");
      expect(commands.map((command) => command.name)).not.toContain("sample:admin:deploy");
    });
  });

  test("normalizes manifest command keys and aliases into dispatchable identifiers", async () => {
    await withTempPlugin(async ({ pluginRoot, options }) => {
      await writeJson(join(pluginRoot, ".agenc-plugin", "plugin.json"), {
        name: "sample",
        commands: {
          "Deploy Now!": {
            source: "./commands/Admin Tools/Review Now.md",
          },
          "123 Inline!": {
            content: [
              "---",
              "aliases: Safe+Alias!, sample:Already+Safe!, other:unsafe",
              "---",
              "Inline command.",
            ].join("\n"),
          },
        },
      });
      await writeFileAt(
        join(pluginRoot, "commands", "Admin Tools", "Review Now.md"),
        "Review now.",
      );

      const result = await loadPlugins(options);
      const commands = await loadPluginCommands({ plugins: result.enabled });
      const inline = commands.find((command) =>
        command.name === "sample:cmd_123_inline"
      );

      expect(commands.map((command) => command.name).sort()).toEqual([
        "sample:cmd_123_inline",
        "sample:deploy_now",
      ]);
      expect(commands.every((command) =>
        /^[a-z][a-z0-9_:-]*$/u.test(command.name)
      )).toBe(true);
      expect(inline?.aliases).toEqual([
        "sample:safe_alias",
        "sample:already_safe",
      ]);
      expect(findCommand("sample:safe_alias", commands)).toBe(inline);
      expect(findCommand("other:unsafe", commands)).toBeUndefined();
    });
  });

  test("normalizes discovered command paths and skill directories into dispatchable identifiers", async () => {
    await withTempPlugin(async ({ pluginRoot, options }) => {
      await writeJson(join(pluginRoot, ".agenc-plugin", "plugin.json"), {
        name: "sample",
      });
      await rm(join(pluginRoot, "commands", "deploy.md"), { force: true });
      await rm(join(pluginRoot, "skills", "inspector"), {
        recursive: true,
        force: true,
      });
      await writeFileAt(
        join(pluginRoot, "commands", "Admin Tools", "Review Now!.md"),
        [
          "---",
          "name: sample:Pretty Name!",
          "aliases: Run+Review!, sample:Review+Alias!, foreign:Review+Alias!",
          "---",
          "Review now.",
        ].join("\n"),
      );
      await writeFileAt(
        join(pluginRoot, "skills", "Ops Tools", "TriAge Now!", "SKILL.md"),
        "Triage skill.",
      );

      const result = await loadPlugins(options);
      const commands = await loadPluginCommands({ plugins: result.enabled });
      const skills = await loadPluginSkills({ plugins: result.enabled });
      const review = commands.find((command) =>
        command.name === "sample:admin_tools:review_now"
      );

      expect(commands.map((command) => command.name)).toEqual([
        "sample:admin_tools:review_now",
      ]);
      expect(review?.userFacingName?.()).toBe("sample:pretty_name");
      expect(review?.aliases).toEqual([
        "sample:run_review",
        "sample:review_alias",
      ]);
      expect(skills.map((skill) => skill.name)).toEqual([
        "sample:ops_tools:triage_now",
      ]);
      expect([...commands, ...skills].every((command) =>
        /^[a-z][a-z0-9_:-]*$/u.test(command.name)
      )).toBe(true);
    });
  });

  test("plugin frontmatter names and aliases cannot create unscoped command identifiers", async () => {
    await withTempPlugin(async ({ pluginRoot, options }) => {
      await writeJson(join(pluginRoot, ".agenc-plugin", "plugin.json"), {
        name: "sample",
      });
      await writeFileAt(
        join(pluginRoot, "commands", "shadow.md"),
        [
          "---",
          "name: help",
          "aliases: reload-plugins, sample:safe, other:unsafe",
          "---",
          "Shadow command.",
        ].join("\n"),
      );
      await writeFileAt(
        join(pluginRoot, "commands", "foreign.md"),
        [
          "---",
          "name: other:unsafe",
          "---",
          "Foreign namespace command.",
        ].join("\n"),
      );

      const result = await loadPlugins(options);
      const commands = await loadPluginCommands({ plugins: result.enabled });
      const shadow = commands.find((command) => command.name === "sample:shadow");
      const foreign = commands.find((command) => command.name === "sample:foreign");

      expect(shadow?.userFacingName?.()).toBe("sample:shadow");
      expect(shadow?.aliases).toEqual(["sample:reload-plugins", "sample:safe"]);
      expect(foreign?.userFacingName?.()).toBe("sample:foreign");
      expect(findCommand("help", commands)).toBeUndefined();
      expect(findCommand("reload-plugins", commands)).toBeUndefined();
      expect(findCommand("other:unsafe", commands)).toBeUndefined();
      expect(findCommand("sample:reload-plugins", commands)).toBe(shadow);
    });
  });

  test("plugin command and skill arguments use shell-aware placeholder substitution", async () => {
    await withTempPlugin(async ({ pluginRoot, options }) => {
      await writeJson(join(pluginRoot, ".agenc-plugin", "plugin.json"), {
        name: "sample",
      });
      await writeFileAt(
        join(pluginRoot, "commands", "args.md"),
        [
          "---",
          "arguments: env target",
          "---",
          "full=$ARGUMENTS first=$ARGUMENTS[0] zero=$0 second=$1 named=$target brace=${env}",
        ].join("\n"),
      );
      await writeFileAt(
        join(pluginRoot, "commands", "no-placeholder.md"),
        "No placeholders.",
      );
      await writeFileAt(
        join(pluginRoot, "commands", "fallback.md"),
        "bad=$0 next=$ARGUMENTS[1]",
      );

      const result = await loadPlugins(options);
      const commands = await loadPluginCommands({ plugins: result.enabled });
      const args = commands.find((command) => command.name === "sample:args");
      await expect(args?.getPromptForCommand?.('"prod api" web', {}))
        .resolves.toEqual([
          {
            type: "text",
            text:
              'full="prod api" web first=prod api zero=prod api ' +
              "second=web named=web brace=prod api",
          },
        ]);

      const noPlaceholder = commands.find((command) => command.name === "sample:no-placeholder");
      await expect(noPlaceholder?.getPromptForCommand?.("alpha beta", {}))
        .resolves.toEqual([
          {
            type: "text",
            text: "No placeholders.\n\nARGUMENTS: alpha beta",
          },
        ]);

      const fallback = commands.find((command) => command.name === "sample:fallback");
      await expect(fallback?.getPromptForCommand?.("a ${", {}))
        .resolves.toEqual([
          {
            type: "text",
            text: "bad=a next=${",
          },
        ]);

      const skills = await loadPluginSkills({ plugins: result.enabled });
      await expect(skills[0]?.getPromptForCommand?.("alpha beta", {}))
        .resolves.toEqual([
          expect.objectContaining({
            text: expect.stringContaining("\n\nARGUMENTS: alpha beta"),
          }),
        ]);
    });
  });

  test("command registration does not expose nested Markdown below skill directories", async () => {
    await withTempPlugin(async ({ pluginRoot, options }) => {
      await writeJson(join(pluginRoot, ".agenc-plugin", "plugin.json"), {
        name: "sample",
      });
      await rm(join(pluginRoot, "commands", "deploy.md"), { force: true });
      await writeFileAt(join(pluginRoot, "commands", "regular.md"), "Regular command.");
      await writeFileAt(join(pluginRoot, "commands", "tool", "skill.md"), "Skill command.");
      await writeFileAt(join(pluginRoot, "commands", "tool", "README.md"), "Nested docs.");

      const result = await loadPlugins(options);
      const commands = await loadPluginCommands({ plugins: result.enabled });

      expect(commands.map((command) => command.name).sort()).toEqual([
        "sample:regular",
        "sample:tool",
      ]);
    });
  });

  test("normalizes plugin agent identifiers before memory paths use them", async () => {
    await withTempPlugin(async ({ root, pluginRoot, options }) => {
      await writeJson(join(pluginRoot, ".agenc-plugin", "plugin.json"), {
        name: "sample",
      });
      await rm(join(pluginRoot, "agents", "review.md"), { force: true });
      await writeFileAt(
        join(pluginRoot, "agents", "Ops Tools", "123 Review!.md"),
        [
          "---",
          "name: 123/../Escape Agent!",
          "description: Review risky metadata",
          "memory: local",
          "---",
          "Use memory safely.",
        ].join("\n"),
      );
      await writeFileAt(
        join(pluginRoot, "agents", "safe.md"),
        [
          "---",
          "name: admin:review",
          "description: Namespaced reviewer",
          "---",
          "Review safely.",
        ].join("\n"),
      );

      const result = await loadPlugins(options);
      const agents = await loadPluginAgents({
        cwd: root,
        pluginStorageRoot: options.pluginStorageRoot,
        plugins: result.enabled,
      });
      const unsafe = agents.find((agent) =>
        agent.agentType === "sample:ops_tools:cmd_123_escape_agent"
      );

      expect(agents.map((agent) => agent.agentType).sort()).toEqual([
        "sample:admin:review",
        "sample:ops_tools:cmd_123_escape_agent",
      ]);
      expect(agents.every((agent) =>
        /^[a-z][a-z0-9_:-]*$/u.test(agent.agentType)
      )).toBe(true);
      expect(agents.map((agent) => agent.agentType)).not.toContain(
        "sample:ops tools:123/../Escape Agent!",
      );

      const memoryPrompt = unsafe?.getSystemPrompt();
      expect(memoryPrompt).toContain("Memory directory:");
      expect(memoryPrompt).toContain("sample-ops_tools-cmd_123_escape_agent");
      expect(memoryPrompt).not.toContain("123/../Escape Agent!");
    });
  });

  test("plugin agents with memory keep memory access tools when tools are restricted", async () => {
    await withTempPlugin(async ({ root, pluginRoot, options }) => {
      await writeFileAt(
        join(pluginRoot, "agents", "review.md"),
        [
          "---",
          "name: review",
          "description: Review changes",
          "tools: Read",
          "memory: user",
          "---",
          "Use ${AGENC_PLUGIN_ROOT}/rules.md",
        ].join("\n"),
      );

      const result = await loadPlugins(options);
      const agents = await loadPluginAgents({
        cwd: root,
        pluginStorageRoot: options.pluginStorageRoot,
        plugins: result.enabled,
      });

      expect(agents[0]?.tools).toEqual(
        expect.arrayContaining([
          "Read",
          FILE_WRITE_TOOL_NAME,
          FILE_EDIT_TOOL_NAME,
          FILE_READ_TOOL_NAME,
        ]),
      );
    });
  });

  test("implicit command loading is skipped in simple mode but explicit plugin dirs still load", async () => {
    await withTempPlugin(async ({ root, pluginRoot, options }) => {
      await runWithAgentRuntimeOptions(
        resolveAgentRuntimeOptions({}, { simpleMode: true }),
        async () => {
        await expect(loadPluginCommands({
          cwd: root,
          pluginStorageRoot: options.pluginStorageRoot,
        })).resolves.toEqual([]);
        await expect(loadPluginCommands({
          cwd: root,
          pluginStorageRoot: options.pluginStorageRoot,
          extraPluginDirs: [pluginRoot],
        })).resolves.toEqual([
          expect.objectContaining({ name: "sample:deploy" }),
        ]);
        },
      );
    });
  });

  test("runtime plugin loads share one root cache and isolate different roots", async () => {
    vi.resetModules();
    const loadPluginsMock = vi.fn(async () => ({
      enabled: [],
      disabled: [],
      errors: [],
    }));
    vi.doMock("./loader.js", async () => {
      const actual = await vi.importActual<typeof import("./loader.js")>("./loader.js");
      return {
        ...actual,
        loadPlugins: loadPluginsMock,
      };
    });
    try {
      const commandsModule = await import("./registration/load-plugin-commands.js");
      const commonModule = await import("./registration/common.js");
      const { ConfigStore: IsolatedConfigStore } = await import("../config/store.js");
      const { runWithCanonicalSettingsAuthority: withAuthority } = await import(
        "../utils/settings/canonicalAuthority.js"
      );
      commonModule.clearRuntimePluginLoadCache();
      const authority = new IsolatedConfigStore({
        home: "/tmp/agenc-plugin-shared-home",
        cwd: "/tmp/agenc-plugin-shared-load",
        projectRoot: "/tmp/agenc-plugin-shared-load",
        env: {
          AGENC_HOME: "/tmp/agenc-plugin-shared-home",
          HOME: "/tmp",
        },
      });

      const explicitEnabled = { plugins: { enabled: true } };
      const explicitDisabled = { plugins: { enabled: false } };
      await withAuthority(authority, async () => {
        await commonModule.loadRuntimePlugins({
          cwd: "/tmp/agenc-plugin-shared-load",
          pluginStorageRoot: "/tmp/agenc-plugin-shared-root",
          config: explicitEnabled,
        });
        await commonModule.loadRuntimePlugins({
          cwd: "/tmp/agenc-plugin-shared-load",
          pluginStorageRoot: "/tmp/agenc-plugin-shared-root",
          config: explicitDisabled,
        });
        await commonModule.loadRuntimePlugins({
          cwd: "/tmp/agenc-plugin-shared-load",
          pluginStorageRoot: "/tmp/agenc-plugin-shared-root",
          config: explicitEnabled,
        });
      });
      expect(loadPluginsMock.mock.calls.map(([options]) => options.config)).toEqual([
        explicitEnabled,
        explicitDisabled,
        explicitEnabled,
      ]);
      loadPluginsMock.mockClear();

      await withAuthority(authority, () => Promise.all([
          commandsModule.loadPluginCommands({
            cwd: "/tmp/agenc-plugin-shared-load",
            pluginStorageRoot: "/tmp/agenc-plugin-shared-root",
          }),
          commandsModule.loadPluginSkills({
            cwd: "/tmp/agenc-plugin-shared-load",
            pluginStorageRoot: "/tmp/agenc-plugin-shared-root",
          }),
        ]));

      expect(loadPluginsMock).toHaveBeenCalledTimes(1);
      await withAuthority(authority, () =>
        commandsModule.loadPluginCommands({
          cwd: "/tmp/agenc-plugin-shared-load",
          pluginStorageRoot: "/tmp/agenc-plugin-other-root",
        })
      );
      expect(loadPluginsMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.doUnmock("./loader.js");
      vi.resetModules();
    }
  });

  test("MCP discovery surfaces partial loader errors", async () => {
    vi.resetModules();
    const issue: PluginLoadIssue = {
      type: "manifest",
      plugin: "broken",
      source: "broken@registry",
      message: "manifest temporarily unreadable",
    };
    const loadPluginsMock = vi.fn(async () => ({
      enabled: [],
      disabled: [],
      errors: [issue],
    }));
    vi.doMock("./loader.js", async () => {
      const actual =
        await vi.importActual<typeof import("./loader.js")>("./loader.js");
      return { ...actual, loadPlugins: loadPluginsMock };
    });
    try {
      const commonModule = await import("./registration/common.js");
      const mcpModule =
        await import("./registration/mcp-plugin-integration.js");
      commonModule.clearRuntimePluginLoadCache();
      const errors: PluginLoadIssue[] = [];

      await expect(
        mcpModule.loadPluginMcpServers({
          cwd: "/tmp/agenc-plugin-error-load",
          pluginStorageRoot: "/tmp/agenc-plugin-error-root",
          errors,
        }),
      ).resolves.toEqual({});

      expect(loadPluginsMock).toHaveBeenCalledOnce();
      expect(errors).toEqual([issue]);
    } finally {
      vi.doUnmock("./loader.js");
      vi.resetModules();
    }
  });
});

async function withTempPlugin(
  fn: (ctx: {
    readonly root: string;
    readonly pluginRoot: string;
    readonly configStore: ConfigStore;
    readonly options: {
      readonly agencHome: string;
      readonly pluginStorageRoot: string;
      readonly workspaceRoot: string;
      readonly extraPluginDirs: readonly string[];
    };
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "agenc-plugin-registration-"));
  const previousCacheDir = process.env.AGENC_PLUGIN_CACHE_DIR;
  const agencHome = join(root, "home");
  const pluginStorageRoot = join(agencHome, "plugins");
  const pluginRoot = join(pluginStorageRoot, "sample-plugin");
  const workspaceRoot = join(root, "workspace");
  try {
    process.env.AGENC_PLUGIN_CACHE_DIR = join(root, "plugin-cache");
    await writeJson(join(pluginRoot, ".agenc-plugin", "plugin.json"), {
      name: "sample",
      commands: {
        deploy: {
          source: "./commands/deploy.md",
          description: "Deploy the project",
          argumentHint: "<env> <target>",
          allowedTools: ["Bash(${AGENC_PLUGIN_ROOT}/bin/deploy)"],
        },
      },
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [
              {
                type: "command",
                command: "${AGENC_PLUGIN_ROOT}/hooks/pre.sh ${AGENC_SESSION_ID}",
                statusMessage: "Checking ${AGENC_PLUGIN_ROOT} for ${AGENC_SESSION_ID}",
              },
            ],
          },
        ],
      },
      mcpServers: {
        local: {
          command: "node",
          args: ["${AGENC_PLUGIN_ROOT}/server.js"],
          env: {
            TOKEN: "${user_config.token}",
            TAGS: "${user_config.tags}",
            SCOPES: "${user_config.scopes}",
          },
        },
      },
      lspServers: {
        typescript: {
          command: "node",
          args: ["${AGENC_PLUGIN_ROOT}/lsp.js"],
          extensionToLanguage: {
            ".ts": "typescript",
          },
        },
      },
      settings: {
        options: {
          tags: ["alpha", "beta"],
        },
      },
      userConfig: {
        token: {
          type: "string",
          title: "Token",
          description: "Access token",
          sensitive: true,
        },
        tags: {
          type: "string",
          title: "Tags",
          description: "Tag list",
          multiple: true,
        },
        scopes: {
          type: "string",
          title: "Scopes",
          description: "Default scopes",
          multiple: true,
          default: ["read", "write"],
        },
      },
      channels: [
        {
          server: "local",
          userConfig: {
            token: {
              type: "string",
              title: "Token",
              description: "Access token",
              required: true,
              sensitive: true,
            },
            nickname: {
              type: "string",
              title: "Nickname",
              description: "Optional nickname",
            },
            tags: {
              type: "string",
              title: "Tags",
              description: "Tag list",
              required: true,
              multiple: true,
            },
          },
        },
      ],
    });
    await writeFileAt(
      join(pluginRoot, "commands", "deploy.md"),
      [
        "---",
        "description: Deploy command frontmatter",
        "arguments: env target",
        "---",
        "Deploy $ARGUMENTS from ${AGENC_PLUGIN_ROOT} into ${env} with ${AGENC_PLUGIN_DATA} using ${user_config.token} tags ${user_config.tags} scopes ${user_config.scopes}",
      ].join("\n"),
    );
    await writeFileAt(
      join(pluginRoot, "agents", "review.md"),
      [
        "---",
        "name: review",
        "description: Review changes",
        "tools: Read, Edit",
        "permissionMode: bypassPermissions",
        "hooks:",
        "  PreToolUse: []",
        "mcpServers:",
        "  - local",
        "---",
        "Use ${AGENC_PLUGIN_ROOT}/rules.md with ${user_config.token}",
      ].join("\n"),
    );
    await writeFileAt(
      join(pluginRoot, "skills", "inspector", "SKILL.md"),
      [
        "---",
        "description: Inspect plugin state",
        "---",
        "Inspect ${AGENC_SKILL_DIR}",
      ].join("\n"),
    );
    await writeFileAt(
      join(pluginRoot, "output-styles", "terse.md"),
      [
        "---",
        "name: terse",
        "description: Terse output",
        "force-for-plugin: true",
        "---",
        "Use short responses.",
      ].join("\n"),
    );
    await writeFileAt(join(agencHome, "config.toml"), "config_version = 2\n");
    await mkdir(workspaceRoot, { recursive: true });
    const configStore = new ConfigStore({
      home: agencHome,
      cwd: workspaceRoot,
      projectRoot: workspaceRoot,
      projectTrusted: false,
      env: { AGENC_HOME: agencHome, HOME: root },
      managedConfigPath: join(root, "missing-managed.toml"),
      managedDropInDir: join(root, "missing-managed.d"),
    });
    await configStore.reload();
    secureStorageRecords.set(configStore.homeContext.path, {
      pluginSecrets: {
        sample: { token: "stored-token" },
      },
    });
    await runWithCanonicalSettingsAuthority(configStore, () => fn({
        root,
        pluginRoot,
        configStore,
        options: {
          agencHome,
          pluginStorageRoot,
          workspaceRoot,
          extraPluginDirs: [pluginRoot],
        },
      }));
  } finally {
    if (previousCacheDir === undefined) {
      delete process.env.AGENC_PLUGIN_CACHE_DIR;
    } else {
      process.env.AGENC_PLUGIN_CACHE_DIR = previousCacheDir;
    }
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 10,
    });
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFileAt(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeFileAt(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}
