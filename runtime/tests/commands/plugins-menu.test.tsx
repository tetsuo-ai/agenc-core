/**
 * Interactive /plugins menu — user-driven enable/disable, uninstall, and
 * marketplace install flows.
 *
 * Every test drives the NEW key handlers against real plugin operations
 * bound to a temp agencHome/workspace (local fixtures only — no network,
 * no git). If the menu wiring to the ops layer is removed, these fail.
 */
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
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
import { installPluginOp } from "../plugins/cli/pluginOperations.js";
import { addMarketplaceOp } from "../plugins/marketplace/marketplace.js";
import { createRoot } from "../tui/ink.js";
import { AppStateProvider, getDefaultAppState } from "../tui/state/AppState.js";

const SYNC_START = "\x1B[?2026h";
const SYNC_END = "\x1B[?2026l";

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
  // Model the real-world state: config.toml exists and is already migrated.
  // A fresh, unversioned config gets canonically rewritten by loadConfig's
  // file migration, which strips the managed plugin block markers and would
  // leave uninstall unable to remove its config entry.
  await writeFile(join(agencHome, "config.toml"), "configVersion = 1\n");
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
    await installPluginOp({ source, agencHome, workspaceRoot });
    expect((await readPluginConfigEntry(agencHome, "alpha"))?.enabled).toBe(true);

    // Drive the real command wiring: execute builds actions from ctx paths.
    const setToolJSX = vi.fn();
    const setAppState = vi.fn();
    const ctx: SlashCommandContext = {
      session: { services: {} } as SlashCommandContext["session"],
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
        () => harness.compact().includes("restart"),
        "restart notice in the menu frame",
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
    await installPluginOp({ source, agencHome, workspaceRoot });
    const installedRoot = join(agencHome, "plugins", "beta");
    expect(await pathExists(installedRoot)).toBe(true);

    const actions = createPluginMenuActions({ agencHome, workspaceRoot });
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

  it("i browses a local marketplace and installs a plugin through installPluginOp", async () => {
    const { root, agencHome, workspaceRoot } = await tempRuntime();
    const marketplaceRoot = join(root, "marketplace");
    await mkdir(marketplaceRoot, { recursive: true });
    await writePlugin(marketplaceRoot, "gamma");
    await writeFile(
      join(marketplaceRoot, "marketplace.json"),
      JSON.stringify({
        metadata: { name: "team" },
        plugins: [{ name: "gamma", source: "./gamma" }],
      }, null, 2),
    );
    await addMarketplaceOp({
      source: marketplaceRoot,
      name: "team",
      agencHome,
      workspaceRoot,
    });

    // Wrap the real actions so the test can wait for the async marketplace
    // load to finish before navigating (ink frame diffs are too lossy to
    // poll for intermediate screen text).
    const real = createPluginMenuActions({ agencHome, workspaceRoot });
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
        () => pathExists(join(agencHome, "plugins", "gamma", ".agenc-plugin", "plugin.json")),
        "gamma installed into user scope",
        harness.frame,
      );
      await waitFor(
        async () => (await readPluginConfigEntry(agencHome, "gamma"))?.enabled === true,
        "gamma enabled in config.toml",
      );
      expect(onChanged).toHaveBeenCalled();
    } finally {
      await harness.cleanup();
    }
  });

  it("i with no marketplaces shows the read-only add hint instead of mutating", async () => {
    const { agencHome, workspaceRoot } = await tempRuntime();
    const actions = createPluginMenuActions({ agencHome, workspaceRoot });
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
    const actions = createPluginMenuActions({ agencHome, workspaceRoot });
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
