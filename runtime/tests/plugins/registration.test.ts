import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, test, vi } from "vitest";

import { sourcePath } from "../helpers/source-path.ts";
import { findCommand } from "../commands.js";
import { MCPManager } from "../mcp-client/manager.js";
import { pluginDataDirPath } from "./directories.js";
import { loadPlugins, type PluginLoadIssue } from "./loader.js";
import { substitutePluginTemplate } from "./registration/common.js";
import { loadPluginAgents } from "./registration/load-plugin-agents.js";
import { loadPluginCommands, loadPluginSkills } from "./registration/load-plugin-commands.js";
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
} from "../tools/AgentTool/loadAgentsDir.js";
import { FILE_EDIT_TOOL_NAME } from "../tools/system/file-edit.js";
import { FILE_READ_TOOL_NAME } from "../tools/system/file-read.js";
import { FILE_WRITE_TOOL_NAME } from "../tools/system/file-write.js";

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
        agencHome: options.agencHome,
        plugins,
        sessionId: "session-1",
      });
      const deploy = commands.find((command) => command.name === "sample:deploy");
      expect(deploy).toBeDefined();
      expect(deploy?.description).toBe("Deploy the project");
      expect(deploy?.allowedTools).toEqual([
        `Bash(${pluginRoot}/bin/deploy)`,
      ]);
      const prompt = await deploy?.getPromptForCommand?.("prod api", {});
      expect(prompt).toEqual([
        {
          type: "text",
          text:
            `Deploy prod api from ${pluginRoot} into prod with ` +
            `${process.env.AGENC_PLUGIN_CACHE_DIR}/data/${pluginRoot.replace(/[^a-zA-Z0-9\-_]/g, "-")} ` +
            "using [configured:token] tags alpha,beta scopes read,write",
        },
      ]);

      const skills = await loadPluginSkills({
        cwd: root,
        agencHome: options.agencHome,
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
        agencHome: options.agencHome,
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
        agencHome: options.agencHome,
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
        agencHome: options.agencHome,
        plugins,
      });
      expect(mcpServers["plugin:sample:local"]).toMatchObject({
        command: "node",
        args: [`${pluginRoot}/server.js`],
        cwd: pluginRoot,
        env: expect.objectContaining({
          AGENC_PLUGIN_ROOT: pluginRoot,
          AGENC_PLUGIN_DATA: pluginDataDirPath(pluginRoot),
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
          pluginDataDir: pluginDataDirPath(pluginRoot),
          serverName: "local",
          scopedServerName: "plugin:sample:local",
        },
      });
      expect(getUnconfiguredChannels(plugins[0]!)).toEqual([]);

      const lspServers = await loadPluginLspServers({
        cwd: root,
        agencHome: options.agencHome,
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
        agencHome: options.agencHome,
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
        agencHome: options.agencHome,
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

  test("template substitution treats replacement-token paths literally and creates data dirs lazily", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenc-plugin-$&-"));
    const previousCacheDir = process.env.AGENC_PLUGIN_CACHE_DIR;
    const pluginRoot = join(root, ".agents", "plugins", "dollar-plugin");
    const agencHome = join(root, "home");
    const cacheRoot = join(root, "cache-$$");
    try {
      process.env.AGENC_PLUGIN_CACHE_DIR = cacheRoot;
      await writeJson(join(pluginRoot, ".agenc-plugin", "plugin.json"), {
        name: "dollar",
      });

      const result = await loadPlugins({
        agencHome,
        workspaceRoot: root,
        config: { plugins: { enabled: true } },
      });
      const plugin = result.enabled[0]!;
      const dataDir = pluginDataDirPath(plugin.source);
      await rm(dataDir, { recursive: true, force: true });

      expect(
        substitutePluginTemplate(
          "root=${AGENC_PLUGIN_ROOT} session=${AGENC_SESSION_ID}",
          plugin,
          { sessionId: "session-$&-$1" },
        ),
      ).toBe(`root=${plugin.root} session=session-$&-$1`);
      await expect(access(dataDir)).rejects.toBeTruthy();

      expect(substitutePluginTemplate("data=${AGENC_PLUGIN_DATA}", plugin))
        .toBe(`data=${dataDir}`);
      await expect(access(dataDir)).resolves.toBeUndefined();
    } finally {
      if (previousCacheDir === undefined) {
        delete process.env.AGENC_PLUGIN_CACHE_DIR;
      } else {
        process.env.AGENC_PLUGIN_CACHE_DIR = previousCacheDir;
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  test("expands general environment variables in plugin MCP and LSP server configs", async () => {
    await withTempPlugin(async ({ pluginRoot, options }) => {
      const previousCommand = process.env.AGENC_PLUGIN_TEST_COMMAND;
      const previousArg = process.env.AGENC_PLUGIN_TEST_ARG;
      const previousCwd = process.env.AGENC_PLUGIN_TEST_CWD;
      try {
        process.env.AGENC_PLUGIN_TEST_COMMAND = "node";
        process.env.AGENC_PLUGIN_TEST_ARG = "expanded-arg";
        process.env.AGENC_PLUGIN_TEST_CWD = "workspace";
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
          plugins: result.enabled,
          errors,
        });
        const lspServers = await loadPluginLspServers({
          plugins: result.enabled,
          errors,
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
      } finally {
        if (previousCommand === undefined) {
          delete process.env.AGENC_PLUGIN_TEST_COMMAND;
        } else {
          process.env.AGENC_PLUGIN_TEST_COMMAND = previousCommand;
        }
        if (previousArg === undefined) {
          delete process.env.AGENC_PLUGIN_TEST_ARG;
        } else {
          process.env.AGENC_PLUGIN_TEST_ARG = previousArg;
        }
        if (previousCwd === undefined) {
          delete process.env.AGENC_PLUGIN_TEST_CWD;
        } else {
          process.env.AGENC_PLUGIN_TEST_CWD = previousCwd;
        }
      }
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
        plugins: result.enabled,
      });
      const server = mcpServers["plugin:sample:local"];

      expect(server?.env).toMatchObject({
        AGENC_PLUGIN_ROOT: pluginRoot,
        AGENC_PLUGIN_DATA: pluginDataDirPath(pluginRoot),
        AGENC_PLUGIN_NAME: "sample",
        AGENC_PLUGIN_MCP_SERVER: "local",
        AGENC_PLUGIN_SANDBOX: "stdio-child-process",
      });
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
        plugins: result.enabled,
      });
      const manager = new MCPManager(
        Object.entries(mcpServers).map(([name, config]) => ({
          name,
          ...config,
        })),
      );

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
          AGENC_PLUGIN_DATA: pluginDataDirPath(pluginRoot),
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
      const previousCwd = process.env.AGENC_PLUGIN_TEST_CWD_ESCAPE;
      try {
        process.env.AGENC_PLUGIN_TEST_CWD_ESCAPE = "../outside";
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
          plugins: result.enabled,
          errors,
        });

        expect(mcpServers["plugin:sample:local"]).toBeUndefined();
        expect(errors).toEqual([
          expect.objectContaining({
            type: "mcp",
            path: "local",
            message: expect.stringContaining("escapes plugin root"),
          }),
        ]);
      } finally {
        if (previousCwd === undefined) {
          delete process.env.AGENC_PLUGIN_TEST_CWD_ESCAPE;
        } else {
          process.env.AGENC_PLUGIN_TEST_CWD_ESCAPE = previousCwd;
        }
      }
    });
  });

  test("omits plugin MCP and LSP servers with unresolved config placeholders", async () => {
    await withTempPlugin(async ({ root, pluginRoot, options }) => {
      const previousMissing = process.env.AGENC_PLUGIN_TEST_MISSING;
      try {
        delete process.env.AGENC_PLUGIN_TEST_MISSING;
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
        await writeJson(join(pluginRoot, "settings.json"), { options: {} });

        const snapshot = await refreshPluginRegistrations({
          cwd: root,
          agencHome: options.agencHome,
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
      const hooksRuntime = { load: vi.fn() };
      const configStore = {
        current: () => ({
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
                hooks: [{ type: "command", command: "echo base" }],
              },
            ],
          },
        }),
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
          allAgents: [builtInAgent],
          activeAgents: [builtInAgent],
        },
        mcp: { pluginReconnectKey: 7 },
      };
      const ctx = {
        cwd: root,
        home: root,
        agencHome: options.agencHome,
        argsRaw: "",
        configStore,
        appState: {
          setAppState: (updater: (prev: unknown) => unknown) => {
            appState = updater(appState) as Record<string, unknown>;
          },
        },
        session: {
          services: {
            configStore,
            hooksRuntime,
          },
        },
      } as unknown as SlashCommandContext;

      const snapshot = await refreshActivePlugins(ctx);

      expect(snapshot.enabled_count).toBe(1);
      expect(hooksRuntime.load).toHaveBeenCalledWith(
        expect.objectContaining({
          Stop: expect.any(Array),
          PreToolUse: expect.any(Array),
        }),
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

      await expect(loadPluginCommands({ cwd: root }))
        .resolves.toEqual([expect.objectContaining({ name: "sample:deploy" })]);
      await expect(loadPluginAgents({ cwd: root }))
        .resolves.toEqual([expect.objectContaining({ agentType: "sample:review" })]);

      try {
        await expect(getAgentDefinitionsWithOverrides(root))
          .resolves.toEqual(
            expect.objectContaining({
              activeAgents: expect.arrayContaining([
                expect.objectContaining({ agentType: "sample:review" }),
              ]),
            }),
          );
      } finally {
        clearAgentDefinitionsCache();
      }
    });
  });

  test("clearing registration caches drops active discovery snapshots", async () => {
    await withTempPlugin(async ({ root, pluginRoot, options }) => {
      const cwd = join(root, "workspace-without-default-plugin");
      await mkdir(cwd, { recursive: true });
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
        agencHome: options.agencHome,
        argsRaw: "",
        configStore,
        session: {
          services: {
            configStore,
          },
        },
      } as unknown as SlashCommandContext;

      await refreshActivePlugins(ctx);

      await expect(loadPluginCommands({ cwd, agencHome: options.agencHome }))
        .resolves.toEqual([expect.objectContaining({ name: "sample:deploy" })]);
      await expect(loadPluginSkills({ cwd, agencHome: options.agencHome }))
        .resolves.toEqual([expect.objectContaining({ name: "sample:inspector" })]);
      await expect(loadPluginAgents({ cwd, agencHome: options.agencHome }))
        .resolves.toEqual([expect.objectContaining({ agentType: "sample:review" })]);

      clearPluginRegistrationCaches();

      await expect(loadPluginCommands({ cwd, agencHome: options.agencHome }))
        .resolves.toEqual([]);
      await expect(loadPluginSkills({ cwd, agencHome: options.agencHome }))
        .resolves.toEqual([]);
      await expect(loadPluginAgents({ cwd, agencHome: options.agencHome }))
        .resolves.toEqual([]);
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
        agencHome: options.agencHome,
        argsRaw: "",
        configStore,
        session: {
          services: {
            configStore,
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
        agencHome: options.agencHome,
        extraPluginDirs: [explicitRoot],
      })).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "explicit:alt" }),
        ]),
      );
      await expect(loadPluginSkills({
        cwd: root,
        agencHome: options.agencHome,
        extraPluginDirs: [explicitRoot],
      })).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "explicit:audit" }),
        ]),
      );
      await expect(loadPluginAgents({
        cwd: root,
        agencHome: options.agencHome,
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
        agencHome: options.agencHome,
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
      const previousSimple = process.env.AGENC_SIMPLE;
      try {
        process.env.AGENC_SIMPLE = "1";
        await expect(loadPluginCommands({
          cwd: root,
          agencHome: options.agencHome,
        })).resolves.toEqual([]);
        await expect(loadPluginCommands({
          cwd: root,
          agencHome: options.agencHome,
          extraPluginDirs: [pluginRoot],
        })).resolves.toEqual([
          expect.objectContaining({ name: "sample:deploy" }),
        ]);
      } finally {
        if (previousSimple === undefined) {
          delete process.env.AGENC_SIMPLE;
        } else {
          process.env.AGENC_SIMPLE = previousSimple;
        }
      }
    });
  });

  test("implicit command and skill discovery share one runtime plugin load", async () => {
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
      commonModule.clearRuntimePluginLoadCache();

      await Promise.all([
        commandsModule.loadPluginCommands({
          cwd: "/tmp/agenc-plugin-shared-load",
          agencHome: "/tmp/agenc-plugin-shared-home",
        }),
        commandsModule.loadPluginSkills({
          cwd: "/tmp/agenc-plugin-shared-load",
          agencHome: "/tmp/agenc-plugin-shared-home",
        }),
      ]);

      expect(loadPluginsMock).toHaveBeenCalledTimes(1);
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
    readonly options: {
      readonly agencHome: string;
      readonly workspaceRoot: string;
      readonly extraPluginDirs: readonly string[];
    };
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "agenc-plugin-registration-"));
  const previousCacheDir = process.env.AGENC_PLUGIN_CACHE_DIR;
  const pluginRoot = join(root, ".agents", "plugins", "sample-plugin");
  const agencHome = join(root, "home");
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
    await writeJson(join(pluginRoot, "settings.json"), {
      options: {
        token: "stored-token",
        tags: ["alpha", "beta"],
      },
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
    await fn({
      root,
      pluginRoot,
      options: {
        agencHome,
        workspaceRoot: root,
        extraPluginDirs: [pluginRoot],
      },
    });
  } finally {
    if (previousCacheDir === undefined) {
      delete process.env.AGENC_PLUGIN_CACHE_DIR;
    } else {
      process.env.AGENC_PLUGIN_CACHE_DIR = previousCacheDir;
    }
    await rm(root, { recursive: true, force: true });
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFileAt(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeFileAt(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}
