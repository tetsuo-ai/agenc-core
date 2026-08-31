import { readdirSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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
 * The runtime keeps a single catalog: nothing ships in-package as a
 * builtin plugin anymore. Capabilities that used to double-ship here
 * (zeroday-hunter) are distributed only through the signed plugin
 * marketplace, so one name can never mean two diverging copies. These
 * tests pin that contract.
 */
describe("plugins shipped in the runtime package", () => {
  it("ships no repo-source plugins", () => {
    let entries: string[] = [];
    try {
      entries = readdirSync(repositoryPluginsRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
        .map((entry) => entry.name);
    } catch {
      // An absent plugins/ directory is the same contract.
    }
    expect(entries).toEqual([]);
  });

  it("registers no builtin plugins", async () => {
    clearBuiltinPlugins();
    resetBuiltinPluginInit();

    const commands = await withSettingsAuthority(() =>
      getBuiltinPluginSkillCommands()
    );
    expect(commands).toEqual([]);

    initBuiltinPlugins();
    const { enabled, disabled } = await withSettingsAuthority(() =>
      getBuiltinPlugins()
    );
    expect(enabled).toEqual([]);
    expect(disabled).toEqual([]);
  });
});
