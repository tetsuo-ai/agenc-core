/**
 * Interactive /plugins menu — user-driven enable/disable, uninstall, and
 * marketplace install flows.
 *
 * Every test drives the NEW key handlers against real plugin operations
 * bound to a temp agencHome/workspace (local fixtures only, with no network).
 * If the menu wiring to the ops layer is removed, these fail.
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { promisify } from "node:util";
import React from "react";
import stripAnsi from "strip-ansi";
import { describe, expect, it, vi } from "vitest";

import {
  createPluginMenuActions,
  pluginsCommand,
  PluginsMenuView,
} from "./plugins.js";
import type { SlashCommandContext } from "./types.js";
import { parseToml } from "../config/loader.js";
import { ConfigStore } from "../config/store.js";
import { pluginFilesystemKey } from "../plugins/directories.js";
import {
  disableAllPluginsOp,
  formatPluginList,
  installPluginOp,
  listInstalledPlugins,
} from "../plugins/cli/pluginOperations.js";
import { addMarketplaceOp } from "../plugins/marketplace/marketplace.js";
import { createRoot } from "../tui/ink.js";
import { AppStateProvider, getDefaultAppState } from "../tui/state/AppState.js";

const SYNC_START = "\x1B[?2026h";
const SYNC_END = "\x1B[?2026l";
const execFileAsync = promisify(execFile);

function createStreams(): {
  readonly stdin: PassThrough;
  readonly stdout: PassThrough;
  readonly output: () => string;
} {
  let output = "";
  const stdin = new PassThrough() as PassThrough & {
    isTTY?: boolean;
    setRawMode?: (enabled: boolean) => void;
    ref?: () => void;
    unref?: () => void;
  };
  const stdout = new PassThrough() as PassThrough & {
    columns?: number;
    rows?: number;
    isTTY?: boolean;
  };
  stdin.isTTY = true;
  stdin.setRawMode = vi.fn();
  stdin.ref = () => {};
  stdin.unref = () => {};
  stdout.columns = 120;
  stdout.rows = 40;
  stdout.isTTY = true;
  stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  return { stdin, stdout, output: () => output };
}

function lastFrame(output: string): string {
  let frame: string | null = null;
  let cursor = 0;
  while (cursor < output.length) {
    const start = output.indexOf(SYNC_START, cursor);
    if (start === -1) break;
    const contentStart = start + SYNC_START.length;
    const end = output.indexOf(SYNC_END, contentStart);
    if (end === -1) break;
    const candidate = output.slice(contentStart, end);
    if (candidate.trim().length > 0) frame = candidate;
    cursor = end + SYNC_END.length;
  }
  return stripAnsi(frame ?? output);
}

async function waitFor(
  predicate: () => Promise<boolean> | boolean,
  label: string,
  detail?: () => string,
  timeoutMs = 8_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(
    `timed out waiting for: ${label}${detail ? `\nlast frame:\n${detail()}` : ""}`,
  );
}

function sleep(ms = 40): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function tempRuntime(): Promise<{
  readonly root: string;
  readonly agencHome: string;
  readonly workspaceRoot: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "agenc-plugins-menu-"));
  const agencHome = join(root, "home");
  const workspaceRoot = join(root, "workspace");
  await mkdir(agencHome, { recursive: true });
  await mkdir(workspaceRoot, { recursive: true });
  // Model the supported runtime state: config.toml is already canonical v2.
  await writeFile(join(agencHome, "config.toml"), "config_version = 2\n");
  return { root, agencHome, workspaceRoot };
}

async function writePlugin(
  root: string,
  name: string,
  version = "1.0.0",
): Promise<string> {
  const pluginRoot = join(root, name);
  await mkdir(join(pluginRoot, ".agenc-plugin"), { recursive: true });
  await writeFile(
    join(pluginRoot, ".agenc-plugin", "plugin.json"),
    JSON.stringify({
      name,
      version,
      description: "Test plugin",
      commands: "./commands",
    }, null, 2),
  );
  await mkdir(join(pluginRoot, "commands"), { recursive: true });
  await writeFile(join(pluginRoot, "commands", "hello.md"), "# Hello\n");
  return pluginRoot;
}

async function writeAliasedProjectPlugin(
  workspaceRoot: string,
  pluginId: string,
): Promise<string> {
  const pluginRoot = await writePlugin(
    join(workspaceRoot, ".agents", "plugins"),
    "manifest-name",
  );
  await writeFile(
    join(pluginRoot, ".agenc-plugin", "agenc-install.json"),
    JSON.stringify({
      name: "manifest-name",
      dependencyIdentity: pluginId,
      source: pluginRoot,
      sourceRoot: pluginRoot,
      scope: "project",
      installedAt: "2026-08-26T00:00:00.000Z",
    }, null, 2),
  );
  return pluginRoot;
}

async function runGit(root: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync(
    "git",
    ["-c", "core.hooksPath=/dev/null", ...args],
    { cwd: root },
  );
  return result.stdout.trim();
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

async function readPluginConfigEntry(
  agencHome: string,
  pluginId: string,
): Promise<{ enabled?: boolean } | undefined> {
  let text: string;
  try {
    text = await readFile(join(agencHome, "config.toml"), "utf8");
  } catch {
    return undefined;
  }
  const parsed = parseToml(text) as {
    plugins?: { plugins?: Record<string, { enabled?: boolean }> };
  };
  return parsed.plugins?.plugins?.[pluginId];
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

type Harness = {
  readonly stdin: PassThrough;
  readonly frame: () => string;
  /** Cumulative ANSI-stripped output with ALL whitespace removed. Ink paints
   * incrementally (diff repaints can split words across cursor moves), so
   * "text has appeared" assertions match the first full paint here instead
   * of a reconstructed last frame. */
  readonly compact: () => string;
  readonly cleanup: () => Promise<void>;
};

async function renderInTui(jsx: React.ReactNode): Promise<Harness> {
  const { stdin, stdout, output } = createStreams();
  const root = await createRoot({
    patchConsole: false,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  });
  root.render(
    <AppStateProvider initialState={getDefaultAppState()}>
      {jsx}
    </AppStateProvider>,
  );
  await sleep();
  return {
    stdin,
    frame: () => lastFrame(output()),
    compact: () => stripAnsi(output()).replace(/\s+/gu, ""),
    cleanup: async () => {
      root.unmount();
      stdin.end();
      stdout.end();
      await sleep();
    },
  };
}

function snapshotWith(
  enabled: readonly { name: string; version?: string }[],
): {
  readonly enabled: readonly { name: string; version?: string }[];
  readonly disabled: readonly never[];
  readonly errors: readonly never[];
  readonly needsRefresh: boolean;
} {
  return { enabled, disabled: [], errors: [], needsRefresh: false };
}

describe("interactive /plugins menu", () => {
  it("e toggles the selected plugin off through setPluginEnabledOp and flags a needed restart", async () => {
    const { root, agencHome, workspaceRoot } = await tempRuntime();
    const source = await writePlugin(root, "alpha");
    const authority = pluginAuthority(agencHome, workspaceRoot);
    await installPluginOp({ ...authority, source });
    expect((await readPluginConfigEntry(agencHome, "alpha"))?.enabled).toBe(true);
    const configStore = new ConfigStore({
      home: agencHome,
      cwd: workspaceRoot,
      projectRoot: workspaceRoot,
      env: {},
      projectTrusted: true,
    });
    await configStore.reload();

    // Drive the real command wiring: execute builds actions from ctx paths.
    const setToolJSX = vi.fn();
    const setAppState = vi.fn();
    const ctx: SlashCommandContext = {
      session: {
        services: {
          runtimeOptions: {
            pluginStorageRoot: authority.pluginStorageRoot,
            sessionTempRoot: authority.sessionTempRoot,
          },
          configStore,
        },
      } as SlashCommandContext["session"],
      argsRaw: "",
      cwd: workspaceRoot,
      home: root,
      agencHome,
      appState: {
        getAppState: () => ({
          plugins: {
            ...snapshotWith([{ name: "alpha", version: "1.0.0" }]),
          },
        }),
        setAppState,
        setToolJSX,
      },
    };
    const result = await pluginsCommand.execute(ctx);
    expect(result).toEqual({ kind: "skip" });
    const payload = setToolJSX.mock.calls[0]?.[0] as { jsx?: React.ReactNode };

    const harness = await renderInTui(payload.jsx);
    try {
      harness.stdin.write("e");
      await waitFor(
        async () => (await readPluginConfigEntry(agencHome, "alpha"))?.enabled === false,
        "alpha disabled in config.toml",
      );
      await waitFor(
        () => setAppState.mock.calls.length > 0,
        "plugin refresh state update",
        harness.frame,
      );
      await waitFor(
        () => harness.compact().includes("restarttoapply"),
        "post-operation restart notice in the menu frame",
        harness.frame,
      );
      // needsRefresh flows through the same AppState path the manager owns.
      expect(setAppState).toHaveBeenCalled();
      const updater = setAppState.mock.calls[0]?.[0] as (prev: unknown) => unknown;
      const next = updater({ plugins: { needsRefresh: false } }) as {
        plugins?: { needsRefresh?: boolean };
      };
      expect(next.plugins?.needsRefresh).toBe(true);
    } finally {
      await harness.cleanup();
    }
  });

  it("u asks for inline y/n confirmation and only y uninstalls through uninstallPluginOp", async () => {
    const { root, agencHome, workspaceRoot } = await tempRuntime();
    const source = await writePlugin(root, "beta");
    const authority = pluginAuthority(agencHome, workspaceRoot);
    const installed = await installPluginOp({ ...authority, source });
    const installedRoot = installed.destination;
    expect(await pathExists(installedRoot)).toBe(true);

    const actions = createPluginMenuActions(authority);
    const onChanged = vi.fn();
    const harness = await renderInTui(
      <PluginsMenuView
        snapshot={snapshotWith([{ name: "beta", version: "1.0.0" }])}
        actions={actions}
        onPluginsChangedOnDisk={onChanged}
        onDone={() => {}}
      />,
    );
    try {
      // u then n cancels: the confirm gate must exist, so nothing mutates.
      harness.stdin.write("u");
      await sleep(80);
      harness.stdin.write("n");
      await sleep(200);
      expect(await pathExists(installedRoot)).toBe(true);
      expect(onChanged).not.toHaveBeenCalled();

      // u then y confirms and removes the install root + config entry.
      harness.stdin.write("u");
      await sleep(80);
      harness.stdin.write("y");
      await waitFor(
        async () => !(await pathExists(installedRoot)),
        "beta install root removed",
        harness.frame,
      );
      await waitFor(
        async () => (await readPluginConfigEntry(agencHome, "beta")) === undefined,
        "beta config entry removed",
      );
      expect(onChanged).toHaveBeenCalled();
    } finally {
      await harness.cleanup();
    }
  });

  it("lists an install alias as its ID and uninstalls that exact ID from the menu", async () => {
    const { root, agencHome, workspaceRoot } = await tempRuntime();
    const source = await writePlugin(root, "manifest-name");
    const authority = pluginAuthority(agencHome, workspaceRoot);
    const installed = await installPluginOp({
      ...authority,
      source,
      name: "operator-alias",
    });
    expect(installed.plugin).toMatchObject({
      id: "operator-alias",
      name: "manifest-name",
    });
    expect(JSON.parse(await readFile(
      join(installed.destination, ".agenc-plugin", "agenc-install.json"),
      "utf8",
    ))).toMatchObject({
      name: "manifest-name",
      dependencyIdentity: "operator-alias",
      source,
    });

    const listed = await listInstalledPlugins(authority);
    expect(listed.plugins).toHaveLength(1);
    expect(listed.plugins[0]).toMatchObject({
      id: "operator-alias",
      name: "manifest-name",
      root: installed.destination,
    });
    expect(formatPluginList(listed)).toContain(
      "- operator-alias (manifest manifest-name)",
    );
    expect(await readPluginConfigEntry(agencHome, "operator-alias")).toEqual({
      enabled: true,
    });
    expect(await readPluginConfigEntry(agencHome, "manifest-name")).toBeUndefined();

    const harness = await renderInTui(
      <PluginsMenuView
        snapshot={{
          enabled: listed.plugins,
          disabled: [],
          errors: [],
          needsRefresh: false,
        }}
        actions={createPluginMenuActions(authority)}
        onPluginsChangedOnDisk={() => {}}
        onDone={() => {}}
      />,
    );
    try {
      harness.stdin.write("u");
      await sleep(80);
      expect(harness.compact()).toContain("Uninstalloperator-alias?");
      harness.stdin.write("y");
      await waitFor(
        async () => !(await pathExists(installed.destination)),
        "aliased plugin install removed",
        harness.frame,
      );
      await waitFor(
        async () => (await readPluginConfigEntry(agencHome, "operator-alias")) === undefined,
        "aliased plugin config entry removed",
      );
    } finally {
      await harness.cleanup();
    }
  });

  it("i browses a local marketplace and installs a plugin through installPluginOp", async () => {
    const { root, agencHome, workspaceRoot } = await tempRuntime();
    const marketplaceRoot = join(root, "marketplace");
    await mkdir(join(marketplaceRoot, ".agenc-plugin"), { recursive: true });
    await writePlugin(marketplaceRoot, "gamma");
    await writeFile(
      join(marketplaceRoot, ".agenc-plugin", "marketplace.json"),
      JSON.stringify({
        metadata: { name: "team" },
        plugins: [{ name: "gamma", source: "./gamma" }],
      }, null, 2),
    );
    await addMarketplaceOp({
      ...pluginAuthority(agencHome, workspaceRoot),
      source: marketplaceRoot,
      name: "team",
    });

    // Wrap the real actions so the test can wait for the async marketplace
    // load to finish before navigating (ink frame diffs are too lossy to
    // poll for intermediate screen text).
    const real = createPluginMenuActions(
      pluginAuthority(agencHome, workspaceRoot),
    );
    let marketplacesListed = 0;
    const actions = {
      ...real,
      listMarketplaces: async () => {
        const outcome = await real.listMarketplaces();
        marketplacesListed += 1;
        return outcome;
      },
    };
    const onChanged = vi.fn();
    const harness = await renderInTui(
      <PluginsMenuView
        snapshot={snapshotWith([])}
        actions={actions}
        onPluginsChangedOnDisk={onChanged}
        onDone={() => {}}
      />,
    );
    try {
      harness.stdin.write("i");
      await waitFor(
        () => marketplacesListed > 0,
        "marketplace list load completed",
        harness.frame,
      );
      await sleep(150);
      harness.stdin.write("\r");
      await sleep(150);
      harness.stdin.write("\r");
      await waitFor(
        () => pathExists(join(
          agencHome,
          "plugins",
          pluginFilesystemKey("gamma@team"),
          ".agenc-plugin",
          "plugin.json",
        )),
        "gamma installed into user scope",
        harness.frame,
      );
      await waitFor(
        async () => (await readPluginConfigEntry(agencHome, "gamma@team"))?.enabled === true,
        "gamma enabled in config.toml",
      );
      expect(onChanged).toHaveBeenCalled();
    } finally {
      await harness.cleanup();
    }
  });

  it("refuses an unsigned bundled plugin from a remote marketplace", async () => {
    const { root, agencHome, workspaceRoot } = await tempRuntime();
    const authority = pluginAuthority(agencHome, workspaceRoot);
    await addMarketplaceOp({
      ...authority,
      source: "https://github.com/attacker/market.git",
      name: "remote-team",
      runProcess: async (_command, args) => {
        if (args.includes("clone")) {
          const target = args.at(-1);
          if (target === undefined) throw new Error("missing clone target");
          await writePlugin(target, "evil");
          await mkdir(join(target, ".agenc-plugin"), { recursive: true });
          await writeFile(
            join(target, ".agenc-plugin", "marketplace.json"),
            JSON.stringify({
              metadata: { name: "remote-team" },
              plugins: [{ name: "evil", source: "./evil" }],
            }),
          );
        }
        if (args.includes("rev-parse")) {
          return { stdout: "abc123\n", stderr: "" };
        }
        return { stdout: "", stderr: "" };
      },
    });

    const actions = createPluginMenuActions(authority);
    const listed = await actions.listMarketplaces();
    const marketplace = listed.marketplaces.find(
      (candidate) => candidate.name === "remote-team",
    );
    expect(marketplace).toBeDefined();
    await expect(
      actions.installFromMarketplace(marketplace!, "evil"),
    ).rejects.toThrow(/signature is required/u);
    expect((await listInstalledPlugins(authority)).plugins).toEqual([]);
  });

  it("keeps same-named marketplace installs distinct by qualified plugin ID", async () => {
    const { root, agencHome, workspaceRoot } = await tempRuntime();
    const authority = pluginAuthority(agencHome, workspaceRoot);
    for (const marketplaceName of ["team", "community"] as const) {
      const marketplaceRoot = join(root, `marketplace-${marketplaceName}`);
      await mkdir(join(marketplaceRoot, ".agenc-plugin"), { recursive: true });
      await writePlugin(marketplaceRoot, "gamma");
      await writeFile(
        join(marketplaceRoot, ".agenc-plugin", "marketplace.json"),
        JSON.stringify({
          metadata: { name: marketplaceName },
          plugins: [{ name: "gamma", source: "./gamma" }],
        }, null, 2),
      );
      await addMarketplaceOp({
        ...authority,
        source: marketplaceRoot,
        name: marketplaceName,
      });
    }

    const actions = createPluginMenuActions(authority);
    const listed = await actions.listMarketplaces();
    expect(listed.errors).toEqual([]);
    for (const marketplaceName of ["team", "community"] as const) {
      const marketplace = listed.marketplaces.find(
        (candidate) => candidate.name === marketplaceName,
      );
      expect(marketplace).toBeDefined();
      const installed = await actions.installFromMarketplace(
        marketplace!,
        "gamma",
      );
      expect(installed.id).toBe(`gamma@${marketplaceName}`);
      await expect(stat(join(
        agencHome,
        "plugins",
        pluginFilesystemKey(`gamma@${marketplaceName}`),
        ".agenc-plugin",
        "plugin.json",
      ))).resolves.toBeDefined();
      expect(
        await readPluginConfigEntry(agencHome, `gamma@${marketplaceName}`),
      ).toEqual({ enabled: true });
    }
  });

  it("isolates interleaved plugin operations by the exact ConfigStore snapshot and project", async () => {
    const { root, agencHome } = await tempRuntime();
    const workspaceA = join(root, "workspace-a");
    const workspaceB = join(root, "workspace-b");
    await mkdir(workspaceA, { recursive: true });
    await mkdir(workspaceB, { recursive: true });
    const pluginRootA = await writeAliasedProjectPlugin(workspaceA, "alias");
    const pluginRootB = await writeAliasedProjectPlugin(workspaceB, "alias");
    const configPath = join(agencHome, "config.toml");

    await writeFile(
      configPath,
      [
        "config_version = 2",
        "[plugins]",
        "enabled = true",
        '["plugins"."plugins"."alias"]',
        "enabled = true",
        "",
      ].join("\n"),
    );
    const storeA = new ConfigStore({
      home: agencHome,
      cwd: workspaceA,
      projectRoot: workspaceA,
      env: {},
      projectTrusted: true,
    });
    await storeA.reload();

    await writeFile(
      configPath,
      [
        "config_version = 2",
        "[plugins]",
        "enabled = true",
        '["plugins"."plugins"."alias"]',
        "enabled = false",
        "",
      ].join("\n"),
    );
    const storeB = new ConfigStore({
      home: agencHome,
      cwd: workspaceB,
      projectRoot: workspaceB,
      env: {},
      projectTrusted: true,
    });
    await storeB.reload();

    const authorityA = { ...pluginAuthority(agencHome, workspaceA), configStore: storeA };
    const authorityB = { ...pluginAuthority(agencHome, workspaceB), configStore: storeB };
    const listAlias = async (authority: typeof authorityA) =>
      (await listInstalledPlugins(authority)).plugins.find(({ id }) => id === "alias");

    await expect(listAlias(authorityA)).resolves.toMatchObject({
      root: pluginRootA,
      enabled: true,
    });
    await expect(listAlias(authorityB)).resolves.toMatchObject({
      root: pluginRootB,
      enabled: false,
    });
    await expect(listAlias(authorityA)).resolves.toMatchObject({
      root: pluginRootA,
      enabled: true,
    });

    const actionsB = createPluginMenuActions(authorityB);
    await actionsB.setEnabled("alias", false);
    expect(storeB.current().plugins.plugins.alias?.enabled).toBe(false);
    expect(storeA.current().plugins.plugins.alias?.enabled).toBe(true);

    await actionsB.uninstall("alias", pluginRootB);
    expect(await pathExists(pluginRootB)).toBe(false);
    expect(await pathExists(pluginRootA)).toBe(true);
    await expect(listAlias(authorityA)).resolves.toMatchObject({
      root: pluginRootA,
      enabled: true,
    });

    const disabled = await disableAllPluginsOp(authorityA);
    expect(disabled.disabled).toEqual(["alias"]);
    expect(storeA.current().plugins.plugins.alias?.enabled).toBe(false);
    expect(await pathExists(pluginRootA)).toBe(true);
  });

  it("preserves a marketplace Git subdirectory, ref, and SHA through installation", async () => {
    const { root, agencHome, workspaceRoot } = await tempRuntime();
    const authority = pluginAuthority(agencHome, workspaceRoot);
    const repository = join(root, "plugin-repository");
    await mkdir(repository, { recursive: true });
    await runGit(repository, ["init"]);
    await runGit(repository, ["config", "user.email", "plugins-menu@example.invalid"]);
    await runGit(repository, ["config", "user.name", "Plugins Menu Test"]);
    await writePlugin(join(repository, "packages"), "selected", "1.0.0");
    await runGit(repository, ["add", "."]);
    await runGit(repository, ["commit", "-m", "first plugin version"]);
    const pinnedSha = await runGit(repository, ["rev-parse", "HEAD"]);
    await runGit(repository, ["tag", "release"]);

    await writePlugin(join(repository, "packages"), "selected", "2.0.0");
    await runGit(repository, ["add", "."]);
    await runGit(repository, ["commit", "-m", "second plugin version"]);

    const marketplaceRoot = join(root, "git-marketplace");
    await mkdir(join(marketplaceRoot, ".agenc-plugin"), { recursive: true });
    await writeFile(
      join(marketplaceRoot, ".agenc-plugin", "marketplace.json"),
      JSON.stringify({
        metadata: { name: "team" },
        plugins: [
          {
            name: "selected",
            source: {
              source: "git-subdir",
              url: repository,
              path: "packages/selected",
              ref: "release",
              sha: pinnedSha,
            },
          },
          {
            name: "tampered",
            source: {
              source: "git-subdir",
              url: repository,
              path: "packages/selected",
              ref: "release",
              sha: "0".repeat(40),
            },
          },
        ],
      }, null, 2),
    );
    await addMarketplaceOp({
      ...authority,
      source: marketplaceRoot,
      name: "team",
    });

    const actions = createPluginMenuActions(authority);
    const listed = await actions.listMarketplaces();
    expect(listed.errors).toEqual([]);
    const marketplace = listed.marketplaces.find(({ name }) => name === "team");
    expect(marketplace).toBeDefined();

    const installed = await actions.installFromMarketplace(
      marketplace!,
      "selected",
    );
    expect(installed).toMatchObject({
      id: "selected@team",
      name: "selected",
      version: "1.0.0",
    });
    expect(await readPluginConfigEntry(agencHome, "selected@team"))
      .toEqual({ enabled: true });
    expect(JSON.parse(await readFile(
      join(installed.root, ".agenc-plugin", "agenc-install.json"),
      "utf8",
    ))).toMatchObject({
      dependencyIdentity: "selected@team",
      source: {
        type: "git",
        url: repository,
        path: "packages/selected",
        ref: "release",
        sha: pinnedSha,
      },
    });

    await expect(actions.installFromMarketplace(marketplace!, "tampered"))
      .rejects.toThrow("does not match declared SHA");
  });

  it("i with no marketplaces shows the read-only add hint instead of mutating", async () => {
    const { agencHome, workspaceRoot } = await tempRuntime();
    const actions = createPluginMenuActions(
      pluginAuthority(agencHome, workspaceRoot),
    );
    const harness = await renderInTui(
      <PluginsMenuView
        snapshot={snapshotWith([])}
        actions={actions}
        onPluginsChangedOnDisk={() => {}}
        onDone={() => {}}
      />,
    );
    try {
      harness.stdin.write("i");
      await waitFor(
        () => harness.compact().includes("marketplaceadd"),
        "empty-marketplace hint",
        harness.frame,
      );
      expect(await pathExists(join(agencHome, "plugins", "marketplaces"))).toBe(false);
    } finally {
      await harness.cleanup();
    }
  });

  it("renders op failures inline instead of crashing", async () => {
    const { agencHome, workspaceRoot } = await tempRuntime();
    const actions = createPluginMenuActions(
      pluginAuthority(agencHome, workspaceRoot),
    );
    const harness = await renderInTui(
      <PluginsMenuView
        snapshot={snapshotWith([{ name: "ghost", version: "1.0.0" }])}
        actions={actions}
        onPluginsChangedOnDisk={() => {}}
        onDone={() => {}}
      />,
    );
    try {
      // "ghost" was never installed, so uninstall fails inside the op layer.
      harness.stdin.write("u");
      await waitFor(
        () => harness.compact().includes("Uninstallghost?"),
        "inline uninstall confirm",
        harness.frame,
      );
      harness.stdin.write("y");
      await waitFor(
        () => harness.compact().includes("notinstalled"),
        "op error rendered inline",
        harness.frame,
      );
    } finally {
      await harness.cleanup();
    }
  });
});
