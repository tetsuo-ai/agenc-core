import { afterEach, describe, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  clearAllOutputStylesCache,
  getAllOutputStyles,
  getOutputStyleConfig,
} from "../../src/constants/outputStyles.js";
import { loadPluginOutputStyles } from "../../src/plugins/registration/load-plugin-output-styles.js";
import { getOutputStyleDirStyles } from "../../src/outputStyles/loadOutputStylesDir.js";
import {
  resolveAgentRuntimeOptions,
  runWithAgentRuntimeOptions,
} from "../../src/session/runtime-options.js";
import { ConfigStore } from "../../src/config/store.js";
import {
  getCanonicalSettingsAuthority,
  resetCanonicalSettingsAuthorityForTesting,
  runWithCanonicalSettingsAuthority,
} from "../../src/utils/settings/canonicalAuthority.js";

vi.mock("../../src/outputStyles/loadOutputStylesDir.js", () => ({
  getOutputStyleDirStyles: vi.fn(),
}));

vi.mock("../../src/plugins/registration/load-plugin-output-styles.js", () => ({
  clearPluginOutputStyleCache: vi.fn(),
  loadPluginOutputStyles: vi.fn(),
}));

const temporaryRoots: string[] = [];

function tempPluginRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `agenc-output-style-${label}-`));
  temporaryRoots.push(root);
  return root;
}

describe("getAllOutputStyles", () => {
  afterEach(() => {
    resetCanonicalSettingsAuthorityForTesting();
    clearAllOutputStylesCache();
    vi.mocked(getOutputStyleDirStyles).mockReset();
    vi.mocked(loadPluginOutputStyles).mockReset();
    for (const root of temporaryRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("merges plugin styles from the registration loader", async () => {
    vi.mocked(getOutputStyleDirStyles).mockResolvedValue([]);
    vi.mocked(loadPluginOutputStyles).mockResolvedValue([
      {
        name: "sample:terse",
        description: "Short plugin replies",
        prompt: "Use short responses.",
        source: "plugin",
        plugin: "sample",
        filePath: "/plugin/output-styles/terse.md",
        forceForPlugin: true,
      },
    ]);

    const cwd = tempPluginRoot("merge-cwd");
    const pluginStorageRoot = tempPluginRoot("merge");
    const authority = new ConfigStore({
      home: join(cwd, "home"),
      cwd,
      projectRoot: cwd,
      projectTrusted: false,
      env: {},
    });
    const styles = await runWithCanonicalSettingsAuthority(authority, () =>
      getAllOutputStyles(cwd, pluginStorageRoot)
    );

    expect(loadPluginOutputStyles).toHaveBeenCalledTimes(1);
    expect(loadPluginOutputStyles).toHaveBeenCalledWith({
      cwd,
      pluginStorageRoot,
      config: authority.current(),
    });
    expect(styles["sample:terse"]).toMatchObject({
      name: "sample:terse",
      description: "Short plugin replies",
      prompt: "Use short responses.",
      source: "plugin",
      forceForPlugin: true,
    });
  });

  test("selects forced plugin styles from the registration loader", async () => {
    vi.mocked(getOutputStyleDirStyles).mockResolvedValue([]);
    vi.mocked(loadPluginOutputStyles).mockResolvedValue([
      {
        name: "sample:forced",
        description: "Forced plugin style",
        prompt: "Use plugin policy.",
        source: "plugin",
        plugin: "sample",
        filePath: "/plugin/output-styles/forced.md",
        forceForPlugin: true,
      },
    ]);

    const runtimeOptions = resolveAgentRuntimeOptions({}, {
      pluginStorageRoot: tempPluginRoot("forced"),
    });
    await runWithAgentRuntimeOptions(runtimeOptions, () =>
      expect(getOutputStyleConfig()).resolves.toMatchObject({
        name: "sample:forced",
        source: "plugin",
        prompt: "Use plugin policy.",
        forceForPlugin: true,
      }),
    );
  });

  test("isolates cached plugin styles by captured plugin root", async () => {
    vi.mocked(getOutputStyleDirStyles).mockResolvedValue([]);
    vi.mocked(loadPluginOutputStyles).mockImplementation(async ({ pluginStorageRoot }) => {
      return [{
        name: "sample:isolated",
        description: "Root-isolated style",
        prompt: `Plugin root: ${pluginStorageRoot}`,
        source: "plugin",
        plugin: "sample",
        filePath: join(pluginStorageRoot, "isolated.md"),
      }];
    });
    const cwd = "/workspace";
    const pluginStorageRootA = tempPluginRoot("root-a");
    const pluginStorageRootB = tempPluginRoot("root-b");
    const optionsA = resolveAgentRuntimeOptions({}, { pluginStorageRoot: pluginStorageRootA });
    const optionsB = resolveAgentRuntimeOptions({}, { pluginStorageRoot: pluginStorageRootB });

    const [stylesA, stylesB] = await Promise.all([
      runWithAgentRuntimeOptions(optionsA, () => getAllOutputStyles(cwd)),
      runWithAgentRuntimeOptions(optionsB, () => getAllOutputStyles(cwd)),
    ]);

    expect(loadPluginOutputStyles).toHaveBeenCalledTimes(2);
    expect(stylesA["sample:isolated"]?.prompt).toBe(
      `Plugin root: ${pluginStorageRootA}`,
    );
    expect(stylesB["sample:isolated"]?.prompt).toBe(
      `Plugin root: ${pluginStorageRootB}`,
    );
  });

  test("isolates cached custom styles by canonical home authority", async () => {
    const cwd = tempPluginRoot("shared-cwd");
    const pluginStorageRoot = tempPluginRoot("shared-plugin-root");
    const homeA = join(cwd, "home-a");
    const homeB = join(cwd, "home-b");
    const authorityA = new ConfigStore({
      home: homeA,
      cwd,
      projectRoot: cwd,
      projectTrusted: false,
      env: {},
    });
    const authorityB = new ConfigStore({
      home: homeB,
      cwd,
      projectRoot: cwd,
      projectTrusted: false,
      env: {},
    });
    const customLoaderHomes: string[] = [];
    const pluginLoaderHomes: string[] = [];

    vi.mocked(getOutputStyleDirStyles).mockImplementation(async () => {
      const home = getCanonicalSettingsAuthority()?.homeContext.path;
      if (home === undefined) throw new Error("Missing canonical home authority");
      customLoaderHomes.push(home);
      return [{
        name: "home:isolated",
        description: "Home-isolated style",
        prompt: `Custom style from ${home}`,
        source: "userSettings",
      }];
    });
    vi.mocked(loadPluginOutputStyles).mockImplementation(async () => {
      const home = getCanonicalSettingsAuthority()?.homeContext.path;
      if (home === undefined) throw new Error("Missing canonical home authority");
      pluginLoaderHomes.push(home);
      return [];
    });

    const [stylesA, stylesB] = await Promise.all([
      runWithCanonicalSettingsAuthority(authorityA, () =>
        getAllOutputStyles(cwd, pluginStorageRoot),
      ),
      runWithCanonicalSettingsAuthority(authorityB, () =>
        getAllOutputStyles(cwd, pluginStorageRoot),
      ),
    ]);

    expect(customLoaderHomes.sort()).toEqual([homeA, homeB].sort());
    expect(pluginLoaderHomes.sort()).toEqual([homeA, homeB].sort());
    expect(getOutputStyleDirStyles).toHaveBeenCalledTimes(2);
    expect(loadPluginOutputStyles).toHaveBeenCalledTimes(2);
    expect(stylesA["home:isolated"]?.prompt).toBe(`Custom style from ${homeA}`);
    expect(stylesB["home:isolated"]?.prompt).toBe(`Custom style from ${homeB}`);
  });
});
