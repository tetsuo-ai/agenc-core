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
        apps: "./config/apps.json",
        settings: { options: { fromManifest: true }, unsupported: true },
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
      await writeJson(join(pluginRoot, "config", "apps.json"), {
        apps: {
          calendar: { id: "calendar" },
        },
      });
      await writeJson(join(pluginRoot, "settings.json"), {
        options: { fromFile: true },
        metadata: { owner: "team" },
        unsupported: true,
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
      expect(plugin?.settings).toEqual({
        options: { fromFile: true },
        metadata: { owner: "team" },
      });
    });
  });

  test("filters manifest settings and reports invalid settings files", async () => {
    await withTempDir(async (root) => {
      const manifestOnly = join(root, "plugins", "manifest-settings");
      await writePluginManifest(manifestOnly, {
        name: "manifest-settings",
        settings: {
          options: { enabled: true },
          unknown: true,
        },
      });
      const badSettings = join(root, "plugins", "bad-settings");
      await writePluginManifest(badSettings, { name: "bad-settings" });
      await writeFileAt(join(badSettings, "settings.json"), "{ bad json");

      const manifestResult = await createPluginFromPath(manifestOnly, {
        source: "test",
        enabled: true,
        fallbackName: "manifest-settings",
      });
      const badResult = await createPluginFromPath(badSettings, {
        source: "test",
        enabled: true,
        fallbackName: "bad-settings",
      });

      expect(manifestResult.plugin.settings).toEqual({
        options: { enabled: true },
      });
      expect(badResult.plugin.settings).toBeUndefined();
      expect(badResult.errors).toMatchObject([
        { type: "settings", path: join(badSettings, "settings.json") },
      ]);
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

  test("keeps malformed manifests disabled and reports the real manifest path", async () => {
    await withTempDir(async (root) => {
      const pluginRoot = join(root, "plugins", "bad-json");
      await writeFileAt(join(pluginRoot, "plugin.json"), "{ invalid json");
      await writeFileAt(join(pluginRoot, "commands", "ghost.md"), "# ghost\n");

      const { plugin, errors } = await createPluginFromPath(pluginRoot, {
        source: "test",
        enabled: true,
        fallbackName: "bad-json",
      });

      expect(plugin.enabled).toBe(false);
      expect(plugin.commands).toEqual([]);
      expect(errors).toMatchObject([
        { type: "manifest", path: join(pluginRoot, "plugin.json") },
      ]);
    });
  });

  test("reports missing configured roots without enabling phantom plugins", async () => {
    await withTempDir(async (root) => {
      const agencHome = join(root, "home");
      const workspaceRoot = join(root, "workspace");

      const result = await loadPlugins({
        agencHome,
        workspaceRoot,
        config: {
          plugins: {
            enabled: {
              missing: { path: "vendor/missing" },
            },
          },
        },
      });

      expect(result.enabled).toEqual([]);
      expect(result.disabled.map((plugin) => plugin.name)).toEqual(["missing"]);
      expect(result.errors).toMatchObject([
        { type: "path-not-found", plugin: "missing" },
      ]);
    });
  });

  test("does not read component files for disabled configured plugins", async () => {
    await withTempDir(async (root) => {
      const agencHome = join(root, "home");
      const workspaceRoot = join(root, "workspace");
      const pluginRoot = join(workspaceRoot, "vendor", "disabled");
      await writePluginManifest(pluginRoot, {
        name: "disabled",
        hooks: "./missing-hooks.json",
      });

      const result = await loadPlugins({
        agencHome,
        workspaceRoot,
        config: {
          plugins: {
            enabled: {
              disabled: { path: "vendor/disabled", enabled: false },
            },
          },
        },
      });

      expect(result.enabled).toEqual([]);
      expect(result.disabled.map((plugin) => plugin.name)).toEqual(["disabled"]);
      expect(result.errors).toEqual([]);
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
    "escape": { "command": "node", "cwd": "../outside" },
    "absolute": { "command": "node", "cwd": ${JSON.stringify(join(root, "outside"))} }
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
          absolute: {
            command: "server",
            extensionToLanguage: { ".js": "javascript" },
            workspaceFolder: join(root, "outside"),
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
          expect.stringContaining("path must be relative to the plugin root"),
        ]),
      );
    });
  });

  test("disables auto-discovered plugins by manifest name", async () => {
    await withTempDir(async (root) => {
      const agencHome = join(root, "home");
      const workspaceRoot = join(root, "workspace");
      const pluginRoot = join(agencHome, "plugins", "directory-name");
      await writePluginManifest(pluginRoot, {
        name: "manifest-name",
        hooks: "./missing-hooks.json",
      });

      const result = await loadPlugins({
        agencHome,
        workspaceRoot,
        config: {
          plugins: {
            enabled: {
              "manifest-name": false,
            },
          },
        },
      });

      expect(result.enabled).toEqual([]);
      expect(result.disabled.map((plugin) => plugin.name)).toEqual(["manifest-name"]);
      expect(result.errors).toEqual([]);
    });
  });

  test("loads command map content and metadata sources", async () => {
    await withTempDir(async (root) => {
      const pluginRoot = join(root, "plugins", "mapped-commands");
      await writePluginManifest(pluginRoot, {
        name: "mapped-commands",
        commands: {
          inline: { content: "Inline command", description: "Inline" },
          file: { source: "./commands/file.md", argumentHint: "<topic>" },
        },
      });
      await writeFileAt(join(pluginRoot, "commands", "file.md"), "# file\n");

      const { plugin, errors } = await createPluginFromPath(pluginRoot, {
        source: "test",
        enabled: true,
        fallbackName: "mapped-commands",
      });

      expect(errors).toEqual([]);
      expect(plugin.commands.map((command) => command.name)).toEqual(["file", "inline"]);
      expect(plugin.commands.find((command) => command.name === "inline")?.content)
        .toBe("Inline command");
      expect(plugin.commands.find((command) => command.name === "file")?.metadata.argumentHint)
        .toBe("<topic>");
    });
  });

  test("rejects unsafe command and settings keys", async () => {
    await withTempDir(async (root) => {
      const pluginRoot = join(root, "plugins", "unsafe-manifest");
      await writeFileAt(
        join(pluginRoot, PLUGIN_MANIFEST_RELATIVE_PATH),
        `{
  "name": "unsafe-manifest",
  "commands": {
    "__proto__": { "content": "bad" }
  },
  "settings": {
    "constructor": true
  },
  "userConfig": {
    "prototype": true
  }
}
`,
      );

      const { plugin, errors } = await createPluginFromPath(pluginRoot, {
        source: "test",
        enabled: true,
        fallbackName: "unsafe-manifest",
      });

      expect(plugin.enabled).toBe(false);
      expect(errors.map((error) => error.message)).toContain(
        "Plugin manifest failed validation",
      );
    });
  });

  test("rejects unsafe hook event keys", async () => {
    await withTempDir(async (root) => {
      const pluginRoot = join(root, "plugins", "hook-safety");
      await writePluginManifest(pluginRoot, { name: "hook-safety" });
      await writeFileAt(
        join(pluginRoot, "hooks", "hooks.json"),
        `{
  "hooks": {
    "__proto__": [{ "hooks": [{ "type": "command", "command": "true" }] }]
  }
}
`,
      );

      const { plugin, errors } = await createPluginFromPath(pluginRoot, {
        source: "test",
        enabled: true,
        fallbackName: "hook-safety",
      });

      expect(Object.getPrototypeOf(plugin.hookSources)).toBe(Array.prototype);
      expect(plugin.hookSources).toEqual([]);
      expect(errors.map((error) => error.message)).toContain(
        "Hook map contains an unsafe key or invalid matcher list",
      );
    });
  });

  test("rejects malformed hook matcher entries", async () => {
    await withTempDir(async (root) => {
      const pluginRoot = join(root, "plugins", "bad-hooks");
      await writePluginManifest(pluginRoot, {
        name: "bad-hooks",
        hooks: {
          Stop: [3],
        },
      });

      const { plugin, errors } = await createPluginFromPath(pluginRoot, {
        source: "test",
        enabled: true,
        fallbackName: "bad-hooks",
      });

      expect(plugin.hookSources).toEqual([]);
      expect(errors.map((error) => error.message)).toContain(
        "Inline hooks must be a hooks map or an object with a hooks map",
      );
    });
  });

  test("uses the real manifest path for inline hook diagnostics", async () => {
    await withTempDir(async (root) => {
      const pluginRoot = join(root, "plugins", "root-hooks");
      await writeJson(join(pluginRoot, "plugin.json"), {
        name: "root-hooks",
        hooks: {
          Stop: [{ hooks: [{ type: "command", command: "true" }] }],
        },
      });

      const { plugin } = await createPluginFromPath(pluginRoot, {
        source: "test",
        enabled: true,
        fallbackName: "root-hooks",
      });

      expect(plugin.hookSources[0]?.sourcePath).toBe(join(pluginRoot, "plugin.json"));
      expect(plugin.hookSources[0]?.sourceRelativePath).toBe("plugin.json#hooks[0]");
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

  test("discovers manifestless app-only and output-style-only plugins", async () => {
    await withTempDir(async (root) => {
      const agencHome = join(root, "home");
      const workspaceRoot = join(root, "workspace");
      const appPlugin = join(workspaceRoot, ".agents", "plugins", "app-only");
      const stylePlugin = join(agencHome, "plugins", "style-only");
      await writeJson(join(appPlugin, ".app.json"), {
        apps: { calendar: { id: "calendar" } },
      });
      await writeFileAt(join(stylePlugin, "output-styles", "plain.md"), "# plain\n");

      const result = await loadPlugins({ agencHome, workspaceRoot });

      expect(result.enabled.map((plugin) => plugin.name).sort()).toEqual([
        "app-only",
        "style-only",
      ]);
      expect(result.enabled.find((plugin) => plugin.name === "app-only")?.appConnectorIds)
        .toEqual(["calendar"]);
      expect(result.enabled.find((plugin) => plugin.name === "style-only")?.outputStylesPaths)
        .toEqual([join(stylePlugin, "output-styles")]);
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

  test("validates path-bearing manifest fields", async () => {
    await withTempDir(async (root) => {
      const pluginRoot = join(root, "plugins", "bad-paths");
      await writePluginManifest(pluginRoot, {
        name: "bad-paths",
        commands: {
          bad: { source: "../outside.md" },
        },
        outputStyles: "./styles/../outside",
        apps: "apps.json",
        hooks: "../hooks.json",
        mcpServers: "./mcp/../servers.json",
        lspServers: "../lsp.json",
      });

      const result = await validateManifest(pluginRoot);

      expect(result.success).toBe(false);
      expect(result.errors.map((error) => error.path)).toEqual(
        expect.arrayContaining([
          "commands.bad.source",
          "outputStyles",
          "apps",
          "hooks",
          "mcpServers",
          "lspServers",
        ]),
      );
    });
  });

  test("rejects malformed optional manifest fields", async () => {
    await withTempDir(async (root) => {
      const pluginRoot = join(root, "plugins", "bad-fields");
      await writePluginManifest(pluginRoot, {
        name: "bad-fields",
        version: 12,
        keywords: ["ok", 3],
        settings: "bad",
        interface: {
          capabilities: ["ok", 4],
        },
      });

      const result = await validateManifest(pluginRoot);

      expect(result.success).toBe(false);
      expect(result.errors.map((error) => error.path)).toEqual(
        expect.arrayContaining([
          "version",
          "keywords",
          "settings",
          "interface.capabilities",
        ]),
      );
    });
  });

  test("caps JSON plugin file reads", async () => {
    await withTempDir(async (root) => {
      const pluginRoot = join(root, "plugins", "huge");
      await writeFileAt(
        join(pluginRoot, PLUGIN_MANIFEST_RELATIVE_PATH),
        JSON.stringify({ name: "huge", description: "x".repeat(1_100_000) }),
      );

      const result = await validateManifest(pluginRoot);

      expect(result.success).toBe(false);
      expect(result.errors.map((error) => error.message).join("\n"))
        .toContain("too large");
    });
  });

  test("validates inline and external server working directories", async () => {
    await withTempDir(async (root) => {
      const pluginRoot = join(root, "plugins", "bad-server-paths");
      await writePluginManifest(pluginRoot, {
        name: "bad-server-paths",
        mcpServers: {
          inline: { command: "node", cwd: "../outside" },
        },
        lspServers: "./lsp.json",
      });
      await writeJson(join(pluginRoot, "lsp.json"), {
        lspServers: {
          ts: {
            command: "server",
            extensionToLanguage: { ".ts": "typescript" },
            workspaceFolder: join(root, "outside"),
          },
        },
      });

      const result = await validateManifest(pluginRoot);

      expect(result.success).toBe(false);
      expect(result.errors.map((error) => error.path)).toEqual(
        expect.arrayContaining([
          "mcpServers.inline.cwd",
          "lspServers.ts.workspaceFolder",
        ]),
      );
    });
  });

  test("allows normalized in-root filenames that contain double dots", async () => {
    await withTempDir(async (root) => {
      const pluginRoot = join(root, "plugins", "dots");
      await writePluginManifest(pluginRoot, {
        name: "dots",
        commands: "./commands/v1..v2.md",
      });
      await writeFileAt(join(pluginRoot, "commands", "v1..v2.md"), "# ok\n");

      const result = await validateManifest(pluginRoot);

      expect(result.success).toBe(true);
    });
  });

  test("validates nested plugin skills", async () => {
    await withTempDir(async (root) => {
      const pluginRoot = join(root, "plugins", "nested-skill");
      await writePluginManifest(pluginRoot, { name: "nested-skill" });
      await writeFileAt(
        join(pluginRoot, "skills", "a", "b", "SKILL.md"),
        "---\ndescription: 10\n---\nBody\n",
      );

      const results = await validatePluginContents(pluginRoot);

      expect(results.find((result) => result.filePath.endsWith("skills/a/b/SKILL.md"))?.success)
        .toBe(false);
    });
  });

  test("bounds markdown component validation scans", async () => {
    await withTempDir(async (root) => {
      const pluginRoot = join(root, "plugins", "many-components");
      await writePluginManifest(pluginRoot, { name: "many-components" });
      for (let index = 0; index < 520; index += 1) {
        await writeFileAt(join(pluginRoot, "commands", `cmd-${index}.md`), "# command\n");
      }
      await writeFileAt(
        join(pluginRoot, "commands", "d1", "d2", "d3", "d4", "d5", "d6", "d7", "d8", "d9", "deep.md"),
        "# deep\n",
      );

      const results = await validatePluginContents(pluginRoot);
      const commandFiles = results
        .filter((result) => result.fileType === "command")
        .map((result) => result.filePath);

      expect(commandFiles).toHaveLength(512);
      expect(commandFiles.some((file) => file.endsWith("deep.md"))).toBe(false);
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
