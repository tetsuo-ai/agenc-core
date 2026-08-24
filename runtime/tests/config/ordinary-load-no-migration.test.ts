import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { loadCanonicalConfig } from "../../src/config/repository.js";
import { ConfigStore } from "../../src/config/store.js";

const temporaryDirectories: string[] = [];

function temp(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), `${prefix}-`));
  temporaryDirectories.push(path);
  return path;
}

function write(path: string, content: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content, { mode: 0o600 });
}

function fileSnapshot(root: string): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  const visit = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile()) out[relative(root, child)] = readFileSync(child, "utf8");
    }
  };
  if (statSync(root).isDirectory()) visit(root);
  return out;
}

function repositoryOptions(root: string, home: string) {
  return {
    home,
    env: {},
    cwd: join(root, "workspace"),
    projectRoot: join(root, "workspace"),
    projectTrusted: false,
    managedConfigPath: join(root, "managed", "config.toml"),
    managedDropInDir: join(root, "managed", "config.d"),
  } as const;
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("ordinary config loading never migrates legacy inputs", () => {
  test.each([
    ["user config.json", (root: string, home: string) =>
      join(home, "config.json")],
    ["user settings.json", (root: string, home: string) =>
      join(home, "settings.json")],
    ["user keybindings.json", (root: string, home: string) =>
      join(home, "keybindings.json")],
    ["gateway config.json", (root: string, home: string) =>
      join(home, "gateway", "config.json")],
    ["project settings.json", (root: string) =>
      join(root, "workspace", ".agenc", "settings.json")],
    ["project settings.local.json", (root: string) =>
      join(root, "workspace", ".agenc", "settings.local.json")],
    ["project .mcp.json", (root: string) =>
      join(root, "workspace", ".mcp.json")],
    ["ancestor .mcp.json", (root: string) => join(root, ".mcp.json")],
    ["managed-settings.json", (root: string) =>
      join(root, "managed", "managed-settings.json")],
    ["managed settings drop-in", (root: string) =>
      join(root, "managed", "managed-settings.d", "policy.json")],
    ["managed-mcp.json", (root: string) =>
      join(root, "managed", "managed-mcp.json")],
  ] as const)(
    "loadCanonicalConfig rejects retired %s without reading or mutating it",
    async (_name, retiredPath) => {
      const root = temp("agenc-load-retired-input");
      const home = join(root, "home");
      const path = retiredPath(root, home);
      write(path, "{ definitely not parsed\n");
      const before = fileSnapshot(root);

      await expect(loadCanonicalConfig(repositoryOptions(root, home))).rejects
        .toMatchObject({
          code: "retired-input",
          path,
          message: expect.stringMatching(
            /agenc config migrate check.*agenc config migrate apply/u,
          ),
        });
      expect(fileSnapshot(root)).toEqual(before);
    },
  );

  test("loadCanonicalConfig rejects v1 TOML with migration guidance and no writes", async () => {
    const root = temp("agenc-load-v1");
    const home = join(root, "home");
    write(join(home, "config.toml"), 'configVersion = 1\nmodel = "legacy"\n');
    const before = fileSnapshot(root);

    await expect(loadCanonicalConfig(repositoryOptions(root, home))).rejects
      .toMatchObject({
        code: "invalid-version",
        message: expect.stringContaining("agenc config migrate check"),
      });
    expect(fileSnapshot(root)).toEqual(before);
  });

  test("ConfigStore binds injected AGENC_HOME and rejects settings.json", async () => {
    const root = temp("agenc-store-settings-only");
    const home = join(root, "injected-home");
    write(join(home, "settings.json"), '{"model":"legacy-model"}\n');
    const before = fileSnapshot(root);
    const store = new ConfigStore({
      ...repositoryOptions(root, home),
      home: undefined,
      env: { AGENC_HOME: home, HOME: join(root, "platform-home") },
    });

    expect(store.agencHome).toBe(home);
    expect(store.homeContext.path).toBe(home);
    await expect(store.reload()).rejects.toMatchObject({
      code: "retired-input",
      path: join(home, "settings.json"),
      message: expect.stringMatching(
        /agenc config migrate check.*agenc config migrate apply/u,
      ),
    });
    expect(fileSnapshot(root)).toEqual(before);
  });

  test("does not confuse nested plugin package metadata with operator inputs", async () => {
    const root = temp("agenc-load-plugin-metadata");
    const home = join(root, "home");
    const pluginRoot = join(home, "plugins", "bundle");
    write(join(pluginRoot, "settings.json"), "{ package defaults\n");
    write(join(pluginRoot, ".mcp.json"), "{ package servers\n");
    const before = fileSnapshot(root);

    const loaded = await loadCanonicalConfig(repositoryOptions(root, home));

    expect(loaded.exists).toBe(false);
    expect(fileSnapshot(root)).toEqual(before);
  });

  test("ConfigStore rejects v1 TOML without touching disk", async () => {
    const root = temp("agenc-store-v1");
    const home = join(root, "home");
    write(join(home, "config.toml"), 'configVersion = 1\nmodel = "legacy"\n');
    const before = fileSnapshot(root);
    const store = new ConfigStore(repositoryOptions(root, home));

    await expect(store.reload()).rejects.toMatchObject({
      code: "invalid-version",
      message: expect.stringContaining("agenc config migrate check"),
    });
    expect(fileSnapshot(root)).toEqual(before);
  });
});
