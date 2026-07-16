import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CONFIG_MIGRATION_VERSION_KEY,
  CURRENT_CONFIG_MIGRATION_VERSION,
  migrateRawAgenCConfig,
  runStartupConfigMigrations,
  type ConfigStoreLike,
} from "./migrations/config-migrations.js";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = join(
    tmpdir(),
    `${prefix}-${process.pid}-${Math.random().toString(16).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function makeConfigStore(
  unknown: Record<string, unknown> = {},
): ConfigStoreLike {
  return {
    current: () => ({
      _unknown: unknown,
      project_root_markers: [".git", "package.json"],
    }),
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("migrateRawAgenCConfig", () => {
  it("normalizes config-key aliases while canonical keys win", () => {
    const migrated = migrateRawAgenCConfig({
      provider: "xai",
      model_provider: "openai",
      replBridgeEnabled: true,
      remoteControlAtStartup: false,
      profiles: {
        canonical: {
          provider: "xai",
          modelProvider: "grok",
          model_provider: "anthropic",
        },
        aliasOnly: {
          provider: "xai",
        },
      },
      providers: {
        xai: { default_model: "grok-4-fast" },
        grok: { default_model: "grok-3" },
      },
    });

    expect(migrated.model_provider).toBe("openai");
    expect(migrated.provider).toBeUndefined();
    expect(migrated.replBridgeEnabled).toBeUndefined();
    expect(migrated.remoteControlAtStartup).toBe(false);
    expect(migrated.profiles).toEqual({
      canonical: { model_provider: "anthropic" },
      aliasOnly: { model_provider: "grok" },
    });
    expect(migrated.providers).toEqual({
      grok: { default_model: "grok-3" },
    });
  });

  it("moves providers.xai to providers.grok when canonical is absent", () => {
    const migrated = migrateRawAgenCConfig({
      providers: {
        xai: { default_model: "grok-4-fast" },
      },
    });

    expect(migrated.providers).toEqual({
      grok: { default_model: "grok-4-fast" },
    });
  });

  it("does not rewrite configured model IDs", () => {
    const migrated = migrateRawAgenCConfig({
      model: "grok-4",
      review_model: "grok-4-fast-reasoning",
      providers: {
        grok: {
          default_model: "grok-4.20-beta-0309-reasoning",
        },
      },
    });

    expect(migrated.model).toBe("grok-4");
    expect(migrated.review_model).toBe("grok-4-fast-reasoning");
    expect(migrated.providers).toEqual({
      grok: { default_model: "grok-4.20-beta-0309-reasoning" },
    });
  });
});

describe("runStartupConfigMigrations", () => {
  it("records legacy bypass permission acceptance in user settings", async () => {
    const home = makeTempDir("agenc-config-migration-home");
    const workspace = makeTempDir("agenc-config-migration-ws");
    const result = await runStartupConfigMigrations({
      home,
      cwd: workspace,
      configStore: makeConfigStore({ bypassPermissionsModeAccepted: true }),
    });

    expect(result.wrote).toBe(true);
    expect(result.applied).toContain(
      "userSettings:bypassPermissionsModeAccepted",
    );
    const userSettings = readJson(join(home, ".agenc", "settings.json"));
    expect(userSettings.bypassPermissionsModeAcceptedIn).toEqual([
      resolve(workspace),
    ]);
    expect(userSettings[CONFIG_MIGRATION_VERSION_KEY]).toBe(
      CURRENT_CONFIG_MIGRATION_VERSION,
    );
  });

  it("does not advance the user marker when legacy bypass lacks a workspace", async () => {
    const home = makeTempDir("agenc-config-migration-home");
    const warnings: string[] = [];
    const result = await runStartupConfigMigrations({
      home,
      configStore: makeConfigStore({ bypassPermissionsModeAccepted: true }),
      onWarn: (message) => warnings.push(message),
    });

    expect(result.wrote).toBe(false);
    expect(result.skipped).toContain(
      "userSettings:bypassPermissionsModeAccepted",
    );
    expect(existsSync(join(home, ".agenc", "settings.json"))).toBe(false);
    expect(warnings.join("\n")).toContain("workspace unavailable");
  });

  it("warns and preserves malformed user settings without advancing", async () => {
    const home = makeTempDir("agenc-config-migration-home");
    const workspace = makeTempDir("agenc-config-migration-ws");
    const userPath = join(home, ".agenc", "settings.json");
    mkdirSync(join(home, ".agenc"), { recursive: true });
    writeFileSync(userPath, "{not json", "utf8");
    const warnings: string[] = [];

    const result = await runStartupConfigMigrations({
      home,
      cwd: workspace,
      configStore: makeConfigStore({ bypassPermissionsModeAccepted: true }),
      onWarn: (message) => warnings.push(message),
    });

    expect(result.wrote).toBe(false);
    expect(result.skipped).toContain("userSettings");
    expect(readFileSync(userPath, "utf8")).toBe("{not json");
    expect(warnings.join("\n")).toContain("invalid JSON");
  });

  it("leaves legacy repository MCP flags inert and does not mutate the checkout", async () => {
    const home = makeTempDir("agenc-config-migration-home");
    const workspace = makeTempDir("agenc-config-migration-ws");
    const projectSettingsPath = join(workspace, ".agenc", "settings.json");
    const localSettingsPath = join(workspace, ".agenc", "settings.local.json");
    writeJson(projectSettingsPath, {
      enableAllProjectMcpServers: true,
      enabledMcpjsonServers: ["alpha", "beta"],
      disabledMcpjsonServers: ["blocked"],
      preserved: "value",
    });
    writeJson(localSettingsPath, {
      enabledMcpjsonServers: ["alpha"],
      disabledMcpjsonServers: ["local-blocked"],
    });

    const result = await runStartupConfigMigrations({
      home,
      cwd: workspace,
      configStore: makeConfigStore(),
    });

    expect(result.wrote).toBe(false);
    expect(result.skipped).toContain(
      "projectSettings:mcp-approval-migration-retired",
    );
    expect(readJson(projectSettingsPath)).toEqual({
      enableAllProjectMcpServers: true,
      enabledMcpjsonServers: ["alpha", "beta"],
      disabledMcpjsonServers: ["blocked"],
      preserved: "value",
    });
    expect(readJson(localSettingsPath)).toEqual({
      enabledMcpjsonServers: ["alpha"],
      disabledMcpjsonServers: ["local-blocked"],
    });

    const second = await runStartupConfigMigrations({
      home,
      cwd: workspace,
      configStore: makeConfigStore(),
    });
    expect(second.wrote).toBe(false);
    expect(second.skipped).toContain(
      "projectSettings:mcp-approval-migration-retired",
    );
  });

  it("does not read or overwrite malformed project settings", async () => {
    const home = makeTempDir("agenc-config-migration-home");
    const workspace = makeTempDir("agenc-config-migration-ws");
    const projectSettingsPath = join(workspace, ".agenc", "settings.json");
    mkdirSync(join(workspace, ".agenc"), { recursive: true });
    writeFileSync(projectSettingsPath, "{not json", "utf8");
    const warnings: string[] = [];

    const result = await runStartupConfigMigrations({
      home,
      cwd: workspace,
      configStore: makeConfigStore(),
      onWarn: (message) => warnings.push(message),
    });

    expect(result.wrote).toBe(false);
    expect(result.skipped).toContain(
      "projectSettings:mcp-approval-migration-retired",
    );
    expect(readFileSync(projectSettingsPath, "utf8")).toBe("{not json");
    expect(warnings).toEqual([]);
  });
});
