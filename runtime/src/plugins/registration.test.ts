import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, test, vi } from "vitest";

import { findCommand } from "../commands.js";
import { loadPlugins } from "./loader.js";
import { loadPluginAgents } from "./registration/load-plugin-agents.js";
import { loadPluginCommands, loadPluginSkills } from "./registration/load-plugin-commands.js";
import { loadPluginHooks } from "./registration/load-plugin-hooks.js";
import { loadPluginLspServers } from "./registration/lsp-plugin-integration.js";
import { getUnconfiguredChannels, loadPluginMcpServers } from "./registration/mcp-plugin-integration.js";
import { refreshActivePlugins, refreshPluginRegistrations } from "./registration/manager.js";
import { loadPluginOutputStyles } from "./registration/load-plugin-output-styles.js";
import type { SlashCommandContext } from "../commands/types.js";
import {
  clearAgentDefinitionsCache,
  getAgentDefinitionsWithOverrides,
} from "../tools/AgentTool/loadAgentsDir.js";
import { FILE_EDIT_TOOL_NAME } from "../tools/system/file-edit.js";
import { FILE_READ_TOOL_NAME } from "../tools/system/file-read.js";
import { FILE_WRITE_TOOL_NAME } from "../tools/system/file-write.js";

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
          AGENC_PLUGIN_NAME: "sample",
          TOKEN: "stored-token",
          TAGS: "alpha,beta",
          SCOPES: "read,write",
        }),
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

  test("active refresh registers hooks, preserves AppState shapes, and publishes active discovery snapshots", async () => {
    await withTempPlugin(async ({ root, pluginRoot, options }) => {
      const hooksRuntime = { load: vi.fn() };
      const configStore = {
        current: () => ({
          plugins: { dirs: [pluginRoot] },
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
      let appState: Record<string, unknown> = {
        plugins: {
          enabled: [],
          disabled: [],
          commands: [],
          errors: [existingPluginError],
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

      clearAgentDefinitionsCache();
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

  test("explicit plugin discovery bypasses active snapshots for commands, skills, and agents", async () => {
    await withTempPlugin(async ({ root, pluginRoot, options }) => {
      const configStore = {
        current: () => ({ plugins: { dirs: [pluginRoot] } }),
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
