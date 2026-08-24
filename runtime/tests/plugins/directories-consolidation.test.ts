import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { ConfigStore } from "../../src/config/store.js";
import {
  getPluginsDirectory as getCanonicalPluginsDirectory,
  pluginDataDirPath as canonicalPluginDataDirPath,
} from "../../src/plugins/directories.js";
import {
  getPluginsDirectory,
  pluginDataDirPath,
} from "../../src/utils/plugins/pluginDirectories.js";
import {
  resolveAgentRuntimeOptions,
  runWithAgentRuntimeOptions,
} from "../../src/session/runtime-options.js";
import {
  resetCanonicalSettingsAuthorityForTesting,
  runWithCanonicalSettingsAuthority,
} from "../../src/utils/settings/canonicalAuthority.js";

const ENV_KEYS = [
  "AGENC_HOME",
  "AGENC_PLUGIN_CACHE_DIR",
] as const;
const originalEnv = Object.fromEntries(
  ENV_KEYS.map((key) => [key, process.env[key]]),
) as Record<(typeof ENV_KEYS)[number], string | undefined>;

function restoreEnvironment(): void {
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

afterEach(() => {
  restoreEnvironment();
  resetCanonicalSettingsAuthorityForTesting();
});

describe("plugin directory authority", () => {
  test("utility callers delegate home and data paths to the canonical resolver", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenc-plugin-dirs-"));
    try {
      delete process.env.AGENC_PLUGIN_CACHE_DIR;
      process.env.AGENC_HOME = root;
      const store = new ConfigStore({
        home: root,
        env: {},
        cwd: root,
        projectRoot: root,
        projectTrusted: false,
      });
      await store.reload();
      const runtimeOptions = resolveAgentRuntimeOptions(process.env);
      runWithCanonicalSettingsAuthority(store, () =>
        runWithAgentRuntimeOptions(runtimeOptions, () => {
          expect(getPluginsDirectory()).toBe(
            getCanonicalPluginsDirectory(process.env, homedir()),
          );
          expect(pluginDataDirPath("team/plugin@1")).toBe(
            canonicalPluginDataDirPath(
              "team/plugin@1",
              process.env,
              homedir(),
            ),
          );
        }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("keeps concurrent AgenC homes isolated by canonical session authority", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenc-plugin-home-isolation-"));
    try {
      const homeA = join(root, "home-a");
      const homeB = join(root, "home-b");
      const storeA = new ConfigStore({
        home: homeA,
        env: {},
        cwd: root,
        projectRoot: root,
        projectTrusted: false,
      });
      const storeB = new ConfigStore({
        home: homeB,
        env: {},
        cwd: root,
        projectRoot: root,
        projectTrusted: false,
      });

      const [resolvedA, resolvedB] = await Promise.all([
        runWithCanonicalSettingsAuthority(storeA, async () => {
          await Promise.resolve();
          return getPluginsDirectory();
        }),
        runWithCanonicalSettingsAuthority(storeB, async () => {
          await Promise.resolve();
          return getPluginsDirectory();
        }),
      ]);

      expect(resolvedA).toBe(join(homeA, "plugins"));
      expect(resolvedB).toBe(join(homeB, "plugins"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("fails closed when neither explicit nor session home authority exists", () => {
    resetCanonicalSettingsAuthorityForTesting();
    expect(() => getPluginsDirectory()).toThrow(
      "Canonical settings authority is required",
    );
  });

});
