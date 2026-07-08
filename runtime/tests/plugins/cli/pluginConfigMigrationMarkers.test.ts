/**
 * Managed plugin config entries must survive the config-file migration
 * rewrite.
 *
 * `installPluginOp` writes an unversioned config.toml whose plugin entry is
 * wrapped in `# BEGIN agenc plugin` / `# END agenc plugin` managed-block
 * markers. Any subsequent `loadConfig` (which `uninstallPluginOp` itself
 * triggers through `listInstalledPlugins`) runs `runConfigFileMigrations`,
 * which canonically re-serializes the file and strips all comments —
 * including the managed-block markers. Removal must still work afterwards
 * via TOML-aware editing instead of silently leaving the entry behind.
 */
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, parseToml } from "../../config/loader.js";
import { installPluginOp, uninstallPluginOp } from "./pluginOperations.js";

interface ParsedPluginsConfig {
  readonly plugins?: {
    readonly enabled?: unknown;
    readonly plugins?: Readonly<Record<string, unknown>>;
  };
}

async function tempRuntime(): Promise<{
  readonly root: string;
  readonly agencHome: string;
  readonly workspaceRoot: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "agenc-plugin-migration-"));
  const agencHome = join(root, "home");
  const workspaceRoot = join(root, "workspace");
  await mkdir(agencHome, { recursive: true });
  await mkdir(workspaceRoot, { recursive: true });
  return { root, agencHome, workspaceRoot };
}

async function writePlugin(root: string, name: string): Promise<string> {
  const pluginRoot = join(root, name);
  await mkdir(join(pluginRoot, ".agenc-plugin"), { recursive: true });
  await writeFile(
    join(pluginRoot, ".agenc-plugin", "plugin.json"),
    JSON.stringify({
      name,
      version: "1.0.0",
      description: "Test plugin",
      commands: "./commands",
    }, null, 2),
  );
  await mkdir(join(pluginRoot, "commands"), { recursive: true });
  await writeFile(join(pluginRoot, "commands", "hello.md"), "# Hello\n");
  return pluginRoot;
}

describe("plugin config entries across config-file migration", () => {
  it("uninstall removes the plugin entry after migration strips the managed-block markers", async () => {
    const { root, agencHome, workspaceRoot } = await tempRuntime();
    const pluginSource = await writePlugin(root, "alpha");
    const configPath = join(agencHome, "config.toml");

    await installPluginOp({ source: pluginSource, agencHome, workspaceRoot });
    const freshText = await readFile(configPath, "utf8");
    expect(freshText).toContain("# BEGIN agenc plugin");

    // Force the canonical rewrite the real runtime performs on any config
    // load: the unversioned file is migrated, re-serialized, and stripped
    // of all comments — the managed-block markers are gone afterwards.
    const loaded = await loadConfig({ home: agencHome, onWarn: () => {} });
    expect(loaded.exists).toBe(true);
    const migratedText = await readFile(configPath, "utf8");
    expect(migratedText).not.toContain("# BEGIN agenc plugin");
    expect(
      (parseToml(migratedText) as ParsedPluginsConfig).plugins?.plugins?.alpha,
    ).toBeDefined();

    const result = await uninstallPluginOp({
      pluginId: "alpha",
      agencHome,
      workspaceRoot,
    });
    expect(result.removedConfig).toBe(true);

    const finalText = await readFile(configPath, "utf8");
    const parsed = parseToml(finalText) as ParsedPluginsConfig;
    expect(parsed.plugins?.plugins?.alpha).toBeUndefined();
    expect(finalText).not.toContain("alpha");
  });

  it("uninstall surgically removes a marker-less entry while preserving unrelated config", async () => {
    const { root, agencHome, workspaceRoot } = await tempRuntime();
    const alphaSource = await writePlugin(root, "alpha");
    const configPath = join(agencHome, "config.toml");

    await installPluginOp({ source: alphaSource, agencHome, workspaceRoot });

    // Model a config that was migrated (or hand-written) without managed
    // markers: already versioned so migrations leave it untouched.
    await writeFile(
      configPath,
      [
        "configVersion = 1",
        'model = "claude-opus"',
        "",
        "[plugins]",
        "enabled = true",
        "",
        '["plugins"."plugins"."alpha"]',
        "enabled = true",
        "",
        '["plugins"."plugins"."beta"]',
        "enabled = false",
        "",
        "[providers.anthropic]",
        'default_model = "claude-opus"',
        "",
      ].join("\n"),
    );

    const result = await uninstallPluginOp({
      pluginId: "alpha",
      agencHome,
      workspaceRoot,
    });
    expect(result.removedConfig).toBe(true);

    const finalText = await readFile(configPath, "utf8");
    const parsed = parseToml(finalText) as ParsedPluginsConfig & {
      readonly model?: unknown;
      readonly providers?: Readonly<Record<string, unknown>>;
    };
    expect(parsed.plugins?.plugins?.alpha).toBeUndefined();
    // Unrelated config survives untouched.
    expect(parsed.model).toBe("claude-opus");
    expect(parsed.plugins?.enabled).toBe(true);
    expect(parsed.plugins?.plugins?.beta).toEqual({ enabled: false });
    expect(parsed.providers?.anthropic).toEqual({ default_model: "claude-opus" });
    // The surgical path keeps the original formatting for untouched lines.
    expect(finalText).toContain('model = "claude-opus"');
    expect(finalText).toContain('["plugins"."plugins"."beta"]');
    expect(finalText).not.toContain('"alpha"');
  });

  it("uninstall reports removedConfig=false when the config has no entry for the plugin", async () => {
    const { root, agencHome, workspaceRoot } = await tempRuntime();
    const alphaSource = await writePlugin(root, "alpha");
    const configPath = join(agencHome, "config.toml");

    await installPluginOp({ source: alphaSource, agencHome, workspaceRoot });
    // Marker-less config that never mentions the plugin.
    await writeFile(
      configPath,
      "configVersion = 1\n\n[plugins]\nenabled = true\n",
    );

    const result = await uninstallPluginOp({
      pluginId: "alpha",
      agencHome,
      workspaceRoot,
    });
    expect(result.removedConfig).toBe(false);

    const finalText = await readFile(configPath, "utf8");
    const parsed = parseToml(finalText) as ParsedPluginsConfig;
    expect(parsed.plugins?.enabled).toBe(true);
  });
});
