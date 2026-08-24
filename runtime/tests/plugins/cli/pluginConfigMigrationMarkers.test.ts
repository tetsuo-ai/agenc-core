/** Managed plugin entries remain removable after canonical editing. */
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseToml } from "../../../src/config/loader.js";
import {
  installPluginOp,
  setPluginEnabledOp,
  uninstallPluginOp,
} from "../../../src/plugins/cli/pluginOperations.js";

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

describe("plugin entries in canonical config", () => {
  it("install patches the exact canonical document without replacing existing plugin fields", async () => {
    const { root, agencHome, workspaceRoot } = await tempRuntime();
    const alphaSource = await writePlugin(root, "alpha");
    const configPath = join(agencHome, "config.toml");

    await writeFile(
      configPath,
      [
        "config_version = 2",
        'model = "claude-opus"',
        "",
        "[plugins]",
        "enabled = false",
        "",
        '["plugins"."plugins"."alpha"]',
        "enabled = false",
        'path = "/opt/agenc/alpha"',
        "",
        '["plugins"."plugins"."alpha"."mcp_servers"."docs"]',
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

    await installPluginOp({ source: alphaSource, agencHome, workspaceRoot });

    const finalText = await readFile(configPath, "utf8");
    const parsed = parseToml(finalText) as ParsedPluginsConfig & {
      readonly model?: unknown;
      readonly providers?: Readonly<Record<string, unknown>>;
    };
    expect(parsed).toMatchObject({ config_version: 2 });
    expect(parsed.model).toBe("claude-opus");
    expect(parsed.plugins?.enabled).toBe(true);
    expect(parsed.plugins?.plugins?.alpha).toEqual({
      enabled: true,
      path: "/opt/agenc/alpha",
      mcp_servers: { docs: { enabled: true } },
    });
    expect(parsed.plugins?.plugins?.beta).toEqual({ enabled: false });
    expect(parsed.providers?.anthropic).toEqual({ default_model: "claude-opus" });
    expect(finalText).not.toMatch(/# (?:BEGIN|END) agenc plugin/u);
  });

  it("uninstall removes the complete canonical entry while preserving siblings", async () => {
    const { root, agencHome, workspaceRoot } = await tempRuntime();
    const alphaSource = await writePlugin(root, "alpha");
    const configPath = join(agencHome, "config.toml");

    await installPluginOp({ source: alphaSource, agencHome, workspaceRoot });
    await writeFile(
      configPath,
      [
        "config_version = 2",
        'model = "claude-opus"',
        "",
        "[plugins]",
        "enabled = true",
        "",
        '["plugins"."plugins"."alpha"]',
        "enabled = true",
        'path = "/opt/agenc/alpha"',
        "",
        '["plugins"."plugins"."alpha"."mcp_servers"."docs"]',
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
    expect(parsed.model).toBe("claude-opus");
    expect(parsed.plugins?.enabled).toBe(true);
    expect(parsed.plugins?.plugins?.beta).toEqual({ enabled: false });
    expect(parsed.providers?.anthropic).toEqual({ default_model: "claude-opus" });
    expect(finalText).toContain('"model" = "claude-opus"');
    expect(finalText).toContain('["plugins"."plugins"."beta"]');
    expect(finalText).not.toContain('"alpha"');
  });

  it("disable patches enablement without discarding the configured path or MCP policy", async () => {
    const { agencHome, workspaceRoot } = await tempRuntime();
    const configPath = join(agencHome, "config.toml");
    await writeFile(
      configPath,
      [
        "config_version = 2",
        "",
        "[plugins]",
        "enabled = true",
        "",
        '["plugins"."plugins"."alpha"]',
        "enabled = true",
        'path = "/opt/agenc/alpha"',
        "",
        '["plugins"."plugins"."alpha"."mcp_servers"."docs"]',
        "enabled = true",
        "",
      ].join("\n"),
    );

    await setPluginEnabledOp({
      pluginId: "alpha",
      enabled: false,
      agencHome,
      workspaceRoot,
    });

    const parsed = parseToml(await readFile(configPath, "utf8")) as ParsedPluginsConfig;
    expect(parsed.plugins?.plugins?.alpha).toEqual({
      enabled: false,
      path: "/opt/agenc/alpha",
      mcp_servers: { docs: { enabled: true } },
    });
    expect(parsed.plugins?.enabled).toBe(true);
  });

  it("uninstall reports removedConfig=false when the config has no entry for the plugin", async () => {
    const { root, agencHome, workspaceRoot } = await tempRuntime();
    const alphaSource = await writePlugin(root, "alpha");
    const configPath = join(agencHome, "config.toml");

    await installPluginOp({ source: alphaSource, agencHome, workspaceRoot });
    // Marker-less config that never mentions the plugin.
    const original = "config_version = 2\n\n[plugins]\nenabled = true\n";
    await writeFile(configPath, original);

    const result = await uninstallPluginOp({
      pluginId: "alpha",
      agencHome,
      workspaceRoot,
    });
    expect(result.removedConfig).toBe(false);

    const finalText = await readFile(configPath, "utf8");
    const parsed = parseToml(finalText) as ParsedPluginsConfig;
    expect(parsed.plugins?.enabled).toBe(true);
    expect(finalText).toBe(original);
  });
});
