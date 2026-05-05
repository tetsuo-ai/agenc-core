import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, test } from "vitest";

import { loadPlugins } from "./loader.js";
import { loadPluginAgents } from "./registration/load-plugin-agents.js";
import { loadPluginCommands, loadPluginSkills } from "./registration/load-plugin-commands.js";
import { loadPluginHooks } from "./registration/load-plugin-hooks.js";
import { loadPluginLspServers } from "./registration/lsp-plugin-integration.js";
import { loadPluginMcpServers } from "./registration/mcp-plugin-integration.js";
import { refreshPluginRegistrations } from "./registration/manager.js";
import { loadPluginOutputStyles } from "./registration/load-plugin-output-styles.js";

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
            `${process.env.AGENC_PLUGIN_CACHE_DIR}/data/${pluginRoot.replace(/[^a-zA-Z0-9\-_]/g, "-")}`,
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
        tools: ["Read", "Edit"],
      });
      expect(agents[0]?.getSystemPrompt()).toContain(`Use ${pluginRoot}/rules.md`);
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
          TOKEN: "[configured:token]",
        }),
      });

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
  const pluginRoot = join(root, "sample-plugin");
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
      },
    });
    await writeFileAt(
      join(pluginRoot, "commands", "deploy.md"),
      [
        "---",
        "description: Deploy command frontmatter",
        "arguments: env target",
        "---",
        "Deploy $ARGUMENTS from ${AGENC_PLUGIN_ROOT} into ${env} with ${AGENC_PLUGIN_DATA}",
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
        "Use ${AGENC_PLUGIN_ROOT}/rules.md",
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
