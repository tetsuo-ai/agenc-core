import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";

import { describe, expect, it } from "vitest";

import { ConfigStore } from "../../src/config/store.js";
import {
  clearBuiltinPlugins,
  getBuiltinPlugins,
} from "../../src/plugins/builtinPlugins.js";
import {
  getBuiltinPluginSkillCommands,
  initBuiltinPlugins,
  resetBuiltinPluginInit,
} from "../../src/plugins/builtin/index.js";
import {
  readSkillReferenceFiles,
  resolveShippedPluginDir,
} from "../../src/plugins/builtin/repositoryPluginSkill.js";
import {
  loadRequiredPluginManifestSync,
  PLUGIN_MANIFEST_RELATIVE_PATH,
} from "../../src/plugins/manifest.js";
import { runWithCanonicalSettingsAuthority } from "../../src/utils/settings/canonicalAuthority.js";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const repositoryPluginsRoot = join(repositoryRoot, "plugins");

async function withSettingsAuthority<T>(run: () => T): Promise<Awaited<T>> {
  const root = await mkdtemp(join(tmpdir(), "agenc-builtin-plugin-"));
  const home = join(root, "home");
  try {
    await writeFile(join(root, "config.toml"), "config_version = 2\n", "utf8");
    const store = new ConfigStore({
      home,
      cwd: root,
      projectRoot: root,
      projectTrusted: false,
      env: { AGENC_HOME: home, HOME: root },
      userConfigPath: join(root, "config.toml"),
    });
    await store.reload();
    return await runWithCanonicalSettingsAuthority(store, run);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/**
 * zeroday-hunter ships in the repo but never loaded: `plugins.enabled` gates
 * auto-discovery and defaults to false, and the built-in registry — the path
 * that bypasses that gate — had no caller at all.
 *
 * The gate stays off. These plugins are enabled because they ship inside the
 * runtime package, which a third-party repository cannot forge.
 */
describe("plugins shipped in the runtime package", () => {
  it("keeps every repo-source plugin manifest canonical and tracked", () => {
    const pluginNames = readdirSync(repositoryPluginsRoot, {
      withFileTypes: true,
    })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .sort();

    expect(pluginNames.length).toBeGreaterThan(0);
    for (const pluginName of pluginNames) {
      const pluginRoot = join(repositoryPluginsRoot, pluginName);
      const parsed = loadRequiredPluginManifestSync(pluginRoot);
      expect(parsed.manifest.name, `${pluginName} manifest name`).toBe(
        pluginName,
      );

      const manifestPath = join(pluginRoot, PLUGIN_MANIFEST_RELATIVE_PATH);
      const repositoryPath = relative(repositoryRoot, manifestPath)
        .split(sep)
        .join("/");
      const trackedPath = execFileSync(
        "git",
        ["-C", repositoryRoot, "ls-files", "--cached", "--", repositoryPath],
        { encoding: "utf8" },
      ).trim();
      expect(
        trackedPath,
        `${repositoryPath} must be present in Git's index`,
      ).toBe(repositoryPath);
    }
  });

  it("resolves zeroday-hunter from the package, not the workspace", () => {
    const dir = resolveShippedPluginDir("zeroday-hunter");
    expect(dir).not.toBeNull();
    expect(dir).toMatch(/plugins[/\\]zeroday-hunter$/u);
  });

  it("registers it and offers its skill", async () => {
    clearBuiltinPlugins();
    resetBuiltinPluginInit();

    const commands = await withSettingsAuthority(() =>
      getBuiltinPluginSkillCommands()
    );
    const skill = commands.find((c) => c.name === "zeroday-hunter");

    expect(skill).toBeDefined();
    expect(skill?.userInvocable).toBe(true);
    // 'bundled', not 'builtin': 'builtin' means a hardcoded slash command and
    // would drop the skill from the Skill tool's listing.
    expect(skill?.source).toBe("bundled");
    expect(skill?.whenToUse).toMatch(/vulnerabilit|0-day/iu);
  });

  it("is enabled by default, with no [plugins] config present", async () => {
    clearBuiltinPlugins();
    resetBuiltinPluginInit();
    initBuiltinPlugins();

    const { enabled, disabled } = await withSettingsAuthority(() =>
      getBuiltinPlugins()
    );
    expect(enabled.map((p) => p.name)).toContain("zeroday-hunter");
    expect(disabled.map((p) => p.name)).not.toContain("zeroday-hunter");
    expect(enabled.find((p) => p.name === "zeroday-hunter")?.isBuiltin).toBe(
      true,
    );
  });

  it("registering twice does not duplicate the skill", async () => {
    clearBuiltinPlugins();
    resetBuiltinPluginInit();

    initBuiltinPlugins();
    initBuiltinPlugins();

    const names = (await withSettingsAuthority(() =>
      getBuiltinPluginSkillCommands()
    )).map((c) => c.name);
    expect(names.filter((n) => n === "zeroday-hunter")).toHaveLength(1);
  });

  it("carries the skill's reference files for on-demand reading", () => {
    const dir = resolveShippedPluginDir("zeroday-hunter")!;
    const files = readSkillReferenceFiles(`${dir}/skills/zeroday-hunter`);
    const keys = Object.keys(files);

    expect(keys.length).toBeGreaterThan(0);
    // Relative, forward-slashed, no traversal — the bundled-skill file
    // contract, since these are extracted to disk on first invocation.
    for (const key of keys) {
      expect(key).toMatch(/^references\//u);
      expect(key).not.toContain("..");
      expect(key).not.toContain("\\");
      expect(files[key]!.length).toBeGreaterThan(0);
    }
  });
});
