import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { parseToml } from "../config/loader.js";
import { ConfigStore } from "../config/store.js";
import {
  DEFAULT_OUTPUT_STYLE_NAME,
  clearAllOutputStylesCache,
  getAllOutputStyles,
  getOutputStyleConfig,
} from "../constants/outputStyles.js";
import {
  getOriginalCwd,
  setOriginalCwd,
} from "../bootstrap/state.js";
import type { Session } from "../session/session.js";
import { outputStyleCommand, outputStyleNewCommand } from "./output-style.js";
import type { SlashCommandContext } from "./types.js";
import {
  resetCanonicalSettingsAuthorityForTesting,
  runWithCanonicalSettingsAuthority,
} from "../utils/settings/canonicalAuthority.js";
import {
  resolveAgentRuntimeOptions,
  runWithAgentRuntimeOptions,
} from "../session/runtime-options.js";

function stubSession(): Session {
  return {
    services: {},
    nextInternalSubId: () => "sub-output-style-test",
    emit: () => {},
  } as unknown as Session;
}

function stubCtx(
  cwd: string,
  argsRaw = "",
  appState?: SlashCommandContext["appState"],
  configStore?: ConfigStore,
): SlashCommandContext {
  return {
    session: stubSession(),
    argsRaw,
    cwd,
    home: join(cwd, "platform-home"),
    agencHome: join(cwd, "agenc-home"),
    ...(appState !== undefined ? { appState } : {}),
    ...(configStore !== undefined ? { configStore } : {}),
  };
}

describe("output-style commands", () => {
  const originalCwd = getOriginalCwd();
  const originalAgencHome = process.env.AGENC_HOME;
  const tempDirs: string[] = [];

  afterEach(() => {
    setOriginalCwd(originalCwd);
    if (originalAgencHome === undefined) {
      delete process.env.AGENC_HOME;
    } else {
      process.env.AGENC_HOME = originalAgencHome;
    }
    resetCanonicalSettingsAuthorityForTesting();
    clearAllOutputStylesCache();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function tempProject(): string {
    const dir = mkdtempSync(join(tmpdir(), "agenc-output-style-"));
    tempDirs.push(dir);
    setOriginalCwd(dir);
    process.env.AGENC_HOME = join(dir, "agenc-home");
    return dir;
  }

  function withOutputStyleRuntime<T>(cwd: string, operation: () => T): T {
    const runtimeOptions = resolveAgentRuntimeOptions({}, {
      pluginStorageRoot: join(cwd, "agenc-home", "plugins"),
    });
    return runWithAgentRuntimeOptions(runtimeOptions, operation);
  }

  it("lists available styles outside the TUI", async () => {
    const cwd = tempProject();

    const result = await withOutputStyleRuntime(cwd, () =>
      outputStyleCommand.execute(stubCtx(cwd))
    );

    expect(result.kind).toBe("text");
    if (result.kind !== "text") throw new Error("expected text");
    expect(result.text).toContain("Output styles:");
    expect(result.text).toContain(DEFAULT_OUTPUT_STYLE_NAME);
    expect(result.text).toContain("Explanatory");
    expect(result.text).toContain("/output-style <name>");
  });

  it("opens a local picker when TUI app-state is wired", async () => {
    const cwd = tempProject();
    const setToolJSX = vi.fn();

    const result = await withOutputStyleRuntime(cwd, () =>
      outputStyleCommand.execute(
        stubCtx(cwd, "", { setToolJSX }),
      )
    );

    expect(result.kind).toBe("skip");
    expect(setToolJSX).toHaveBeenCalledWith(
      expect.objectContaining({
        isLocalJSXCommand: true,
        shouldHidePromptInput: true,
      }),
    );
  });

  it("persists the active style through trusted user settings and survives cache reset", async () => {
    const cwd = tempProject();
    const agencHome = join(cwd, "agenc-home");
    const configStore = new ConfigStore({
      home: agencHome,
      env: {},
      cwd,
      projectRoot: cwd,
      projectTrusted: false,
    });
    await configStore.reload();
    let appState: unknown = { settings: {} };
    const setAppState = vi.fn((updater: (prev: unknown) => unknown) => {
      appState = updater(appState);
    });

    const result = await runWithCanonicalSettingsAuthority(
      configStore,
      () => withOutputStyleRuntime(cwd, () =>
        outputStyleCommand.execute(
          stubCtx(cwd, "explanatory", { setAppState }),
        )
      ),
    );

    expect(result).toEqual({
      kind: "text",
      text: 'Output style switched to "Explanatory".',
    });
    const config = parseToml(
      readFileSync(join(agencHome, "config.toml"), "utf8"),
    );
    expect(config.outputStyle).toBe("Explanatory");
    expect(appState).toEqual({ settings: { outputStyle: "Explanatory" } });
    clearAllOutputStylesCache();
    await expect(
      runWithCanonicalSettingsAuthority(configStore, () =>
        withOutputStyleRuntime(cwd, () => getOutputStyleConfig()),
      ),
    ).resolves.toMatchObject({ name: "Explanatory" });
  });

  it("returns a clear error for unknown styles", async () => {
    const cwd = tempProject();

    const result = await withOutputStyleRuntime(cwd, () =>
      outputStyleCommand.execute(
        stubCtx(cwd, "does-not-exist"),
      )
    );

    expect(result.kind).toBe("text");
    if (result.kind !== "text") throw new Error("expected text");
    expect(result.text).toContain('Unknown output style "does-not-exist"');
  });

  it("lists and applies a forced style from a real enabled plugin", async () => {
    const cwd = tempProject();
    const home = join(cwd, "agenc-home");
    const pluginStorageRoot = join(home, "plugins");
    installOutputStylePlugin(pluginStorageRoot, "Use the enabled plugin style.");
    const configStore = new ConfigStore({
      home,
      base: { plugins: { enabled: true } },
      env: {},
      cwd,
      projectRoot: cwd,
      projectTrusted: false,
    });

    const result = await runWithCanonicalSettingsAuthority(configStore, () =>
      withOutputStyleRuntime(cwd, () =>
        outputStyleCommand.execute(stubCtx(cwd))
      )
    );

    expect(result.kind).toBe("text");
    if (result.kind !== "text") throw new Error("expected text");
    expect(result.text).toContain("sample:forced");
    expect(result.text).toContain("A plugin is forcing the effective style.");
    await expect(
      runWithCanonicalSettingsAuthority(configStore, () =>
        withOutputStyleRuntime(cwd, () => getOutputStyleConfig())
      ),
    ).resolves.toMatchObject({
      name: "sample:forced",
      prompt: "Use the enabled plugin style.",
      forceForPlugin: true,
    });
  });

  it("isolates interleaved plugin styles for same-home ConfigStores", async () => {
    const cwd = tempProject();
    const home = join(cwd, "agenc-home");
    const pluginStorageRoot = join(home, "plugins");
    installOutputStylePlugin(pluginStorageRoot, "Only the enabled store sees this.");
    const common = {
      home,
      env: {},
      cwd,
      projectRoot: cwd,
      projectTrusted: false,
    } as const;
    const enabledStore = new ConfigStore({
      ...common,
      base: { plugins: { enabled: true } },
    });
    const disabledStore = new ConfigStore({
      ...common,
      base: { plugins: { enabled: false } },
    });
    const loadFor = (store: ConfigStore) =>
      runWithCanonicalSettingsAuthority(store, () =>
        withOutputStyleRuntime(cwd, () => getAllOutputStyles(cwd))
      );

    const enabledFirst = await loadFor(enabledStore);
    const disabled = await loadFor(disabledStore);
    const enabledAgain = await loadFor(enabledStore);

    expect(enabledFirst["sample:forced"]?.prompt).toBe(
      "Only the enabled store sees this.",
    );
    expect(disabled["sample:forced"]).toBeUndefined();
    expect(enabledAgain["sample:forced"]?.prompt).toBe(
      "Only the enabled store sees this.",
    );
  });

  it("clears only the active ConfigStore plugin-style cache partition", async () => {
    const cwd = tempProject();
    const home = join(cwd, "agenc-home");
    const pluginStorageRoot = join(home, "plugins");
    installOutputStylePlugin(pluginStorageRoot, "Original cached prompt.");
    const common = {
      home,
      env: {},
      cwd,
      projectRoot: cwd,
      projectTrusted: false,
    } as const;
    const storeA = new ConfigStore({
      ...common,
      base: { plugins: { enabled: true } },
    });
    const storeB = new ConfigStore({
      ...common,
      base: { plugins: { enabled: true, allowlist: ["sample"] } },
    });
    const loadFor = (store: ConfigStore) =>
      runWithCanonicalSettingsAuthority(store, () =>
        withOutputStyleRuntime(cwd, () => getAllOutputStyles(cwd))
      );

    await loadFor(storeA);
    await loadFor(storeB);
    writePluginOutputStyle(pluginStorageRoot, "Updated prompt.");

    const reloadedA = await runWithCanonicalSettingsAuthority(storeA, () => {
      clearAllOutputStylesCache();
      return withOutputStyleRuntime(cwd, () => getAllOutputStyles(cwd));
    });
    const stillCachedB = await loadFor(storeB);

    expect(reloadedA["sample:forced"]?.prompt).toBe("Updated prompt.");
    expect(stillCachedB["sample:forced"]?.prompt).toBe(
      "Original cached prompt.",
    );

    resetCanonicalSettingsAuthorityForTesting();
    clearAllOutputStylesCache();
    const globallyReloadedB = await loadFor(storeB);
    expect(globallyReloadedB["sample:forced"]?.prompt).toBe("Updated prompt.");
  });

  it("routes both authoring spellings through the ConfigStore home and reloads the result", async () => {
    const cwd = tempProject();
    const agencHome = join(cwd, "relocated-agenc-home");
    const configStore = new ConfigStore({
      home: agencHome,
      env: {},
      cwd,
      projectRoot: cwd,
      projectTrusted: false,
    });
    await configStore.reload();
    const directContext = {
      ...stubCtx(cwd, "terse Short replies", undefined, configStore),
      home: "",
    };

    const [directResult, nestedResult] = await Promise.all([
      outputStyleNewCommand.execute(directContext),
      outputStyleCommand.execute(
        stubCtx(cwd, "new terse Short replies", undefined, configStore),
      ),
    ]);

    const expectedPath = join(agencHome, "output-styles", "terse.md");
    for (const result of [directResult, nestedResult]) {
      expect(result.kind).toBe("prompt");
      if (result.kind !== "prompt") throw new Error("expected prompt");
      expect(result.content).toContain(
        `Create a new user-owned output style at ${expectedPath}`,
      );
      expect(result.content).toContain("name: terse");
      expect(result.content).toContain("description: Short replies");
    }

    mkdirSync(join(agencHome, "output-styles"), { recursive: true });
    writeFileSync(
      expectedPath,
      [
        "---",
        "name: terse",
        "description: Short replies",
        "keep-coding-instructions: true",
        "---",
        "",
        "Keep every response terse.",
        "",
      ].join("\n"),
      "utf8",
    );
    clearAllOutputStylesCache();
    const styles = await runWithCanonicalSettingsAuthority(
      configStore,
      () => withOutputStyleRuntime(cwd, () => getAllOutputStyles(cwd)),
    );
    expect(styles.terse).toMatchObject({
      name: "terse",
      prompt: "Keep every response terse.",
      source: "userSettings",
    });
  });

  it("refuses to invent an output-style home without ConfigStore authority", async () => {
    const cwd = tempProject();
    await expect(
      outputStyleNewCommand.execute(stubCtx(cwd, "terse")),
    ).resolves.toEqual({
      kind: "error",
      message: "Slash command requires the canonical ConfigStore authority",
    });
  });
});

function installOutputStylePlugin(
  pluginStorageRoot: string,
  prompt: string,
): void {
  const pluginRoot = join(pluginStorageRoot, "sample-plugin");
  mkdirSync(join(pluginRoot, ".agenc-plugin"), { recursive: true });
  mkdirSync(join(pluginRoot, "output-styles"), { recursive: true });
  writeFileSync(
    join(pluginRoot, ".agenc-plugin", "plugin.json"),
    `${JSON.stringify({ name: "sample" }, null, 2)}\n`,
  );
  writePluginOutputStyle(pluginStorageRoot, prompt);
}

function writePluginOutputStyle(
  pluginStorageRoot: string,
  prompt: string,
): void {
  const pluginRoot = join(pluginStorageRoot, "sample-plugin");
  writeFileSync(
    join(pluginRoot, "output-styles", "forced.md"),
    [
      "---",
      "name: forced",
      "description: Forced plugin style",
      "force-for-plugin: true",
      "---",
      prompt,
      "",
    ].join("\n"),
  );
}
