/** Managed plugin entries remain removable after canonical editing. */
import { access, cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseToml } from "../../../src/config/loader.js";
import {
  pluginDataDirPath,
  pluginFilesystemKey,
} from "../../../src/plugins/directories.js";
import {
  installPluginOp,
  listInstalledPlugins,
  setPluginEnabledOp,
  uninstallPluginOp,
  updatePluginOp,
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

function pluginAuthority(agencHome: string, workspaceRoot: string) {
  return {
    agencHome,
    pluginStorageRoot: join(agencHome, "plugins"),
    sessionTempRoot: join(agencHome, "tmp"),
    workspaceRoot,
    env: Object.freeze({}) as NodeJS.ProcessEnv,
  };
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

    await installPluginOp({
      ...pluginAuthority(agencHome, workspaceRoot),
      source: alphaSource,
    });

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

    await installPluginOp({
      ...pluginAuthority(agencHome, workspaceRoot),
      source: alphaSource,
    });
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
      ...pluginAuthority(agencHome, workspaceRoot),
      pluginId: "alpha",
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
      ...pluginAuthority(agencHome, workspaceRoot),
      pluginId: "alpha",
      enabled: false,
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

    await installPluginOp({
      ...pluginAuthority(agencHome, workspaceRoot),
      source: alphaSource,
    });
    // Marker-less config that never mentions the plugin.
    const original = "config_version = 2\n\n[plugins]\nenabled = true\n";
    await writeFile(configPath, original);

    const result = await uninstallPluginOp({
      ...pluginAuthority(agencHome, workspaceRoot),
      pluginId: "alpha",
    });
    expect(result.removedConfig).toBe(false);

    const finalText = await readFile(configPath, "utf8");
    const parsed = parseToml(finalText) as ParsedPluginsConfig;
    expect(parsed.plugins?.enabled).toBe(true);
    expect(finalText).toBe(original);
  });

  it.each([
    ["user", "project"],
    ["project", "user"],
  ] as const)(
    "rejects a second %s/%s scope install without disabling the first copy",
    async (firstScope, secondScope) => {
      const { root, agencHome, workspaceRoot } = await tempRuntime();
      const source = await writePlugin(root, "manifest-name");
      const authority = pluginAuthority(agencHome, workspaceRoot);
      const pluginId = "single-scope-id";
      const first = await installPluginOp({
        ...authority,
        source,
        name: pluginId,
        scope: firstScope,
      });
      const configPath = join(agencHome, "config.toml");
      const configBefore = await readFile(configPath, "utf8");
      const secondRoot = secondScope === "user"
        ? authority.pluginStorageRoot
        : join(workspaceRoot, ".agents", "plugins");
      const secondDestination = join(
        secondRoot,
        pluginFilesystemKey(pluginId),
      );

      await expect(installPluginOp({
        ...authority,
        source,
        name: pluginId,
        scope: secondScope,
      })).rejects.toThrow(
        `plugin is already installed in another scope: ${pluginId}`,
      );

      await expect(access(secondDestination)).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await readFile(configPath, "utf8")).toBe(configBefore);
      const listed = await listInstalledPlugins(authority);
      expect(listed.errors).toEqual([]);
      expect(listed.plugins).toEqual([
        expect.objectContaining({
          id: pluginId,
          enabled: true,
          root: first.destination,
        }),
      ]);
    },
  );

  it("keeps shared config and data while removing historical duplicate scopes", async () => {
    const { root, agencHome, workspaceRoot } = await tempRuntime();
    const source = await writePlugin(root, "manifest-name");
    const authority = pluginAuthority(agencHome, workspaceRoot);
    const pluginId = "shared-id";
    const installed = await installPluginOp({
      ...authority,
      source,
      name: pluginId,
      scope: "user",
    });
    const projectRoot = join(
      workspaceRoot,
      ".agents",
      "plugins",
      pluginFilesystemKey(pluginId),
    );
    await mkdir(join(workspaceRoot, ".agents", "plugins"), { recursive: true });
    await cp(installed.destination, projectRoot, { recursive: true });
    const metadataPath = join(
      projectRoot,
      ".agenc-plugin",
      "agenc-install.json",
    );
    const metadata = JSON.parse(
      await readFile(metadataPath, "utf8"),
    ) as Record<string, unknown>;
    await writeFile(
      metadataPath,
      `${JSON.stringify({ ...metadata, scope: "project" }, null, 2)}\n`,
    );
    const dataFile = join(pluginDataDirPath(pluginId, authority), "state.json");
    await mkdir(join(dataFile, ".."), { recursive: true });
    await writeFile(dataFile, "{}\n");

    const first = await uninstallPluginOp({
      ...authority,
      pluginId,
      scope: "user",
    });
    expect(first.removedConfig).toBe(false);
    expect(first.removedData).toBe(false);
    await expect(access(dataFile)).resolves.toBeUndefined();
    await expect(
      access(join(
        workspaceRoot,
        ".agents",
        "plugins",
        pluginFilesystemKey(pluginId),
      )),
    ).resolves.toBeUndefined();
    expect(
      (parseToml(await readFile(join(agencHome, "config.toml"), "utf8")) as ParsedPluginsConfig)
        .plugins?.plugins?.[pluginId],
    ).toEqual({ enabled: true });

    const last = await uninstallPluginOp({
      ...authority,
      pluginId,
      scope: "project",
    });
    expect(last.removedConfig).toBe(true);
    expect(last.removedData).toBe(true);
    await expect(access(dataFile)).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      (parseToml(await readFile(join(agencHome, "config.toml"), "utf8")) as ParsedPluginsConfig)
        .plugins?.plugins?.[pluginId],
    ).toBeUndefined();
  });

  it("keeps colliding readable IDs isolated and updates the metadata-matched root", async () => {
    const { root, agencHome, workspaceRoot } = await tempRuntime();
    const source = await writePlugin(root, "manifest-name");
    const authority = pluginAuthority(agencHome, workspaceRoot);
    const qualified = await installPluginOp({
      ...authority,
      source,
      name: "foo@bar",
    });
    const dashed = await installPluginOp({
      ...authority,
      source,
      name: "foo-bar",
    });

    expect(qualified.destination).toBe(join(
      authority.pluginStorageRoot,
      pluginFilesystemKey("foo@bar"),
    ));
    expect(dashed.destination).toBe(join(
      authority.pluginStorageRoot,
      pluginFilesystemKey("foo-bar"),
    ));
    expect(qualified.destination).not.toBe(dashed.destination);

    const updated = await updatePluginOp({
      ...authority,
      pluginId: "foo@bar",
    });
    expect(updated.destination).toBe(qualified.destination);
    const listed = await listInstalledPlugins(authority);
    expect(listed.plugins.map((plugin) => plugin.id)).toEqual([
      "foo-bar",
      "foo@bar",
    ]);
    expect(listed.plugins.map((plugin) => plugin.root)).toEqual([
      dashed.destination,
      qualified.destination,
    ]);
  });
});
