import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import {
  deletePluginDataDir,
  getPluginDataDir,
  getPluginDataDirSize,
  getPluginSeedDirs,
  getPluginsDirectory,
  sanitizePluginId,
} from "./directories.js";
import {
  createPluginFromPath,
  discoverPluginRoots,
  discoverPluginSkillRoots,
  loadPlugins,
} from "./loader.js";
import {
  loadPluginManifest,
  PLUGIN_MANIFEST_RELATIVE_PATH,
  resolveManifestRelativePath,
} from "./manifest.js";
import { validateManifest, validatePluginContents } from "./validation.js";

describe("plugin manifest", () => {
  test("prefers canonical manifests and normalizes interface prompts", async () => {
    await withTempDir(async (root) => {
      const pluginRoot = join(root, "plugins", "alpha");
      await writeJson(join(pluginRoot, "plugin.json"), {
        name: "root-name",
      });
      await writeJson(join(pluginRoot, PLUGIN_MANIFEST_RELATIVE_PATH), {
        name: "canonical-name",
        version: " 1.2.3 ",
        interface: {
          displayName: "Canonical",
          defaultPrompt: [
            "  first   prompt  ",
            "second prompt",
            "third prompt",
            "ignored prompt",
          ],
        },
      });

      const parsed = await loadPluginManifest(pluginRoot);

      expect(parsed?.manifest.name).toBe("canonical-name");
      expect(parsed?.manifest.version).toBe("1.2.3");
      expect(parsed?.manifest.interface?.defaultPrompt).toEqual([
        "first prompt",
        "second prompt",
        "third prompt",
      ]);
    });
  });

  test("rejects paths that are not normalized beneath the plugin root", async () => {
    await withTempDir(async (root) => {
      expect(() =>
        resolveManifestRelativePath(root, "commands", "../outside.md"),
      ).toThrow("must start with ./");
      expect(() =>
        resolveManifestRelativePath(root, "commands", "./nested/../outside.md"),
      ).toThrow("must be normalized");
      expect(() =>
        resolveManifestRelativePath(root, "commands", "./"),
      ).toThrow("must not be ./");
    });
  });

  test("validates root plugin manifests as local plugin roots", async () => {
    await withTempDir(async (root) => {
      const pluginRoot = join(root, "local-plugin");
      await writeJson(join(pluginRoot, "plugin.json"), {
        name: "local-plugin",
        commands: "./commands",
      });
      await mkdir(join(pluginRoot, "commands"), { recursive: true });

      const result = await validateManifest(pluginRoot);

      expect(result.success).toBe(true);
      expect(result.fileType).toBe("plugin");
    });
  });
});

describe("plugin loader", () => {
  test("loads default components and server declarations from local plugins", async () => {
    await withTempDir(async (root) => {
      const agencHome = join(root, "home");
      const workspaceRoot = join(root, "workspace");
      const pluginRoot = join(agencHome, "plugins", "toolbox");
      await writePluginManifest(pluginRoot, {
        name: "toolbox",
        version: "1.0.0",
        settings: { mode: "local" },
      });
      await writeFileAt(join(pluginRoot, "skills", "planner", "SKILL.md"), "---\nname: planner\n---\n");
      await writeFileAt(join(pluginRoot, "commands", "build.md"), "# build\n");
      await writeFileAt(join(pluginRoot, "agents", "review.md"), "# review\n");
      await writeFileAt(join(pluginRoot, "output-styles", "plain.md"), "# plain\n");
      await writeJson(join(pluginRoot, "hooks", "hooks.json"), {
        hooks: {
          Stop: [{ matcher: "done", hooks: [{ type: "command", command: "true" }] }],
        },
      });
      await writeJson(join(pluginRoot, ".mcp.json"), {
        mcpServers: {
          local: {
            command: "node",
            args: ["server.js"],
            cwd: "bin",
          },
        },
      });
      await writeJson(join(pluginRoot, ".lsp.json"), {
        lspServers: {
          ts: {
            command: "typescript-language-server",
            extensionToLanguage: { ".ts": "typescript" },
            workspaceFolder: "workspace",
          },
        },
      });
      await writeJson(join(pluginRoot, ".app.json"), {
        apps: {
          calendar: { id: "calendar" },
        },
      });

      const result = await loadPlugins({ agencHome, workspaceRoot });
      const plugin = result.enabled[0];

      expect(result.errors).toEqual([]);
      expect(plugin?.name).toBe("toolbox");
      expect(plugin?.commands.map((command) => command.name)).toEqual(["build"]);
      expect(plugin?.skillsPaths).toEqual([join(pluginRoot, "skills")]);
      expect(plugin?.agentsPaths).toEqual([join(pluginRoot, "agents")]);
      expect(plugin?.outputStylesPaths).toEqual([join(pluginRoot, "output-styles")]);
      expect(plugin?.hookSources).toHaveLength(1);
      expect(plugin?.mcpServers.local?.cwd).toBe(join(pluginRoot, "bin"));
      expect(plugin?.lspServers.ts?.workspaceFolder).toBe(join(pluginRoot, "workspace"));
      expect(plugin?.appConnectorIds).toEqual(["calendar"]);
      expect(plugin?.settings).toEqual({ mode: "local" });
    });
  });

  test("keeps invalid plugin paths non-fatal", async () => {
    await withTempDir(async (root) => {
      const pluginRoot = join(root, "plugins", "broken");
      await writePluginManifest(pluginRoot, {
        name: "broken",
        commands: "./missing.md",
        hooks: "./missing-hooks.json",
        mcpServers: "./missing-mcp.json",
      });

      const { plugin, errors } = await createPluginFromPath(pluginRoot, {
        source: "test",
        enabled: true,
        fallbackName: "broken",
      });

      expect(plugin.name).toBe("broken");
      expect(plugin.enabled).toBe(true);
      expect(errors.map((error) => error.type).sort()).toEqual([
        "hooks",
        "mcp",
        "path-not-found",
      ]);
    });
  });

  test("rejects unsafe server keys and working directories", async () => {
    await withTempDir(async (root) => {
      const agencHome = join(root, "home");
      const workspaceRoot = join(root, "workspace");
      const pluginRoot = join(agencHome, "plugins", "server-safety");
      await writePluginManifest(pluginRoot, { name: "server-safety" });
      await writeFileAt(
        join(pluginRoot, ".mcp.json"),
        `{
  "mcpServers": {
    "__proto__": { "command": "node" },
    "constructor": { "command": "node" },
    "valid": { "command": "node", "cwd": "bin" },
    "escape": { "command": "node", "cwd": "../outside" }
  }
}
`,
      );
      await writeJson(join(pluginRoot, ".lsp.json"), {
        lspServers: {
          prototype: {
            command: "server",
            extensionToLanguage: { ".ts": "typescript" },
          },
          ts: {
            command: "server",
            extensionToLanguage: { ".ts": "typescript" },
            workspaceFolder: "../outside",
          },
        },
      });

      const result = await loadPlugins({ agencHome, workspaceRoot });
      const plugin = result.enabled[0];

      expect(Object.getPrototypeOf(plugin?.mcpServers)).toBeNull();
      expect(plugin?.mcpServers.valid?.cwd).toBe(join(pluginRoot, "bin"));
      expect(Object.keys(plugin?.mcpServers ?? {})).toEqual(["valid"]);
      expect(Object.keys(plugin?.lspServers ?? {})).toEqual([]);
      expect(result.errors.map((error) => error.message)).toEqual(
        expect.arrayContaining([
          expect.stringContaining("Unsafe mcp server key"),
          expect.stringContaining("Unsafe lsp server key"),
          expect.stringContaining("path must be normalized"),
        ]),
      );
    });
  });

  test("bounds default command discovery", async () => {
    await withTempDir(async (root) => {
      const pluginRoot = join(root, "plugins", "many-commands");
      await writePluginManifest(pluginRoot, { name: "many-commands" });
      for (let index = 0; index < 520; index += 1) {
        await writeFileAt(join(pluginRoot, "commands", `cmd-${index}.md`), "# command\n");
      }
      await writeFileAt(
        join(pluginRoot, "commands", "d1", "d2", "d3", "d4", "d5", "d6", "d7", "d8", "d9", "deep.md"),
        "# deep\n",
      );

      const { plugin } = await createPluginFromPath(pluginRoot, {
        source: "test",
        enabled: true,
        fallbackName: "many-commands",
      });

      expect(plugin.commands).toHaveLength(512);
      expect(plugin.commands.map((command) => command.name)).not.toContain("deep");
    });
  });

  test("discovers user, workspace, and configured plugin roots", async () => {
    await withTempDir(async (root) => {
      const agencHome = join(root, "home");
      const workspaceRoot = join(root, "workspace");
      const userPlugin = join(agencHome, "plugins", "user");
      const workspacePlugin = join(workspaceRoot, ".agents", "plugins", "workspace");
      const configuredPlugin = join(workspaceRoot, "vendor", "configured");
      const disabledPlugin = join(workspaceRoot, "vendor", "disabled");
      for (const [name, pluginRoot] of [
        ["user", userPlugin],
        ["workspace", workspacePlugin],
        ["configured", configuredPlugin],
        ["disabled", disabledPlugin],
      ] as const) {
        await writePluginManifest(pluginRoot, { name });
        await writeFileAt(join(pluginRoot, "skills", name, "SKILL.md"), "---\nname: x\n---\n");
      }

      const roots = await discoverPluginRoots({
        agencHome,
        workspaceRoot,
        config: {
          plugins: {
            enabled: {
              configured: { path: "vendor/configured" },
              disabled: { path: "vendor/disabled", enabled: false },
            },
          },
        },
      });
      const skillRoots = await discoverPluginSkillRoots({
        agencHome,
        workspaceRoot,
        config: {
          plugins: {
            enabled: {
              configured: { path: "vendor/configured" },
              disabled: { path: "vendor/disabled", enabled: false },
            },
          },
        },
      });

      expect(roots.map((entry) => entry.path).sort()).toEqual([
        configuredPlugin,
        disabledPlugin,
        userPlugin,
        workspacePlugin,
      ].sort());
      expect(skillRoots.sort()).toEqual([
        join(configuredPlugin, "skills"),
        join(userPlugin, "skills"),
        join(workspacePlugin, "skills"),
      ].sort());
    });
  });
});

describe("plugin directories", () => {
  test("uses AgenC directory environment and data-dir sanitation", async () => {
    await withTempDir(async (root) => {
      const env = {
        AGENC_PLUGIN_CACHE_DIR: "~/plugin-cache",
        AGENC_PLUGIN_SEED_DIR: `~/seed-a${process.platform === "win32" ? ";" : ":"}${join(root, "seed-b")}`,
      };

      expect(getPluginsDirectory(env, root)).toBe(join(root, "plugin-cache"));
      expect(getPluginSeedDirs(env, root)).toEqual([
        join(root, "seed-a"),
        join(root, "seed-b"),
      ]);
      expect(sanitizePluginId("team/plugin@1")).toBe("team-plugin-1");

      const dataDir = getPluginDataDir("team/plugin@1", env, root);
      await writeFileAt(join(dataDir, "state.json"), "{}");

      await expect(getPluginDataDirSize("team/plugin@1", env, root)).resolves.toMatchObject({
        bytes: 2,
      });
      await deletePluginDataDir("team/plugin@1", env, root);
      await expect(getPluginDataDirSize("team/plugin@1", env, root)).resolves.toBeNull();
    });
  });
});

describe("plugin validation", () => {
  test("rejects malformed markdown component metadata", async () => {
    await withTempDir(async (root) => {
      const pluginRoot = join(root, "plugins", "bad-metadata");
      await writePluginManifest(pluginRoot, { name: "bad-metadata" });
      await writeFileAt(
        join(pluginRoot, "skills", "broken", "SKILL.md"),
        "---\ndescription: 12\nallowed-tools: [Read, 3]\nunknown-field: true\n---\nBody\n",
      );

      const results = await validatePluginContents(pluginRoot);
      const skillResult = results.find((result) => result.fileType === "skill");

      expect(skillResult?.success).toBe(false);
      expect(skillResult?.errors.map((error) => error.path)).toEqual(
        expect.arrayContaining(["description", "allowed-tools"]),
      );
      expect(skillResult?.warnings.map((warning) => warning.path)).toContain("unknown-field");
    });
  });
});

async function withTempDir<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await import("node:fs/promises").then(({ mkdtemp }) =>
    mkdtemp(join(tmpdir(), "agenc-plugin-test-")),
  );
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writePluginManifest(
  pluginRoot: string,
  manifest: Record<string, unknown>,
): Promise<void> {
  await writeJson(join(pluginRoot, PLUGIN_MANIFEST_RELATIVE_PATH), manifest);
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFileAt(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeFileAt(path: string, content: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content, "utf8");
}
