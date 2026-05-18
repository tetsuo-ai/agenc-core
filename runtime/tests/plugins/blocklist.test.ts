import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import {
  FLAGGED_PLUGIN_SEEN_EXPIRY_MS,
  FLAGGED_PLUGINS_FILENAME,
  FlaggedPluginStore,
  addFlaggedPluginState,
  detectAndUninstallDelistedPlugins,
  detectDelistedPlugins,
  markFlaggedPluginsSeenState,
  parseFlaggedPluginsData,
  pruneExpiredFlaggedPlugins,
  removeFlaggedPluginState,
} from "./blocklist.js";

describe("plugin blocklist", () => {
  test("detects installed marketplace plugins missing from the marketplace manifest", () => {
    expect(
      detectDelistedPlugins(
        {
          plugins: {
            "alpha@team": [{ scope: "user" }],
            "beta@team": [{ scope: "project" }],
            "beta@other": [{ scope: "user" }],
            local: [{ scope: "local" }],
          },
        },
        {
          plugins: [{ name: "alpha" }],
        },
        "team",
      ),
    ).toEqual(["beta@team"]);
  });

  test("auto-uninstalls delisted user-controllable installs and flags them", async () => {
    const uninstalled: string[] = [];
    const flagged: string[] = [];
    const logs: string[] = [];

    await expect(
      detectAndUninstallDelistedPlugins({
        loadFlaggedPlugins: async () => ({
          "already@team": { flaggedAt: "2026-01-01T00:00:00.000Z" },
        }),
        loadInstalledPlugins: () => ({
          plugins: {
            "present@team": [{ scope: "user" }],
            "gone@team": [{ scope: "user" }, { scope: "project" }, { scope: "managed" }],
            "partial@team": [{ scope: "local" }],
            "managed-only@team": [{ scope: "managed" }],
            "already@team": [{ scope: "user" }],
          },
        }),
        loadKnownMarketplaces: async () => ({
          team: {},
          disabled: {},
          broken: {},
        }),
        getMarketplace: async (marketplaceName) => {
          if (marketplaceName === "broken") throw new Error("offline");
          if (marketplaceName === "disabled") {
            return { plugins: [], forceRemoveDeletedPlugins: false };
          }
          return {
            plugins: [{ name: "present" }],
            forceRemoveDeletedPlugins: true,
          };
        },
        uninstallPlugin: async (pluginId, scope) => {
          uninstalled.push(`${pluginId}:${scope}`);
          if (pluginId === "partial@team") throw new Error("locked");
        },
        addFlaggedPlugin: async (pluginId) => {
          flagged.push(pluginId);
        },
        log: (message, level) => {
          logs.push(`${level}:${message}`);
        },
      }),
    ).resolves.toEqual(["gone@team", "partial@team"]);

    expect(uninstalled).toEqual([
      "gone@team:user",
      "gone@team:project",
      "partial@team:local",
    ]);
    expect(flagged).toEqual(["gone@team", "partial@team"]);
    expect(logs.some((entry) => entry.includes("locked"))).toBe(true);
    expect(logs.some((entry) => entry.includes("offline"))).toBe(true);
  });

  test("parses, updates, prunes, and removes flagged plugin state", () => {
    const parsed = parseFlaggedPluginsData(JSON.stringify({
      plugins: {
        good: { flaggedAt: "2026-01-01T00:00:00.000Z", seenAt: "2026-01-02T00:00:00.000Z" },
        bad: { seenAt: "2026-01-02T00:00:00.000Z" },
      },
    }));
    expect(parsed).toEqual({
      good: {
        flaggedAt: "2026-01-01T00:00:00.000Z",
        seenAt: "2026-01-02T00:00:00.000Z",
      },
    });

    const added = addFlaggedPluginState(parsed, "fresh", "2026-01-03T00:00:00.000Z");
    expect(added.fresh).toEqual({ flaggedAt: "2026-01-03T00:00:00.000Z" });

    const marked = markFlaggedPluginsSeenState(
      added,
      ["fresh", "missing"],
      "2026-01-03T01:00:00.000Z",
    );
    expect(marked.changed).toBe(true);
    expect(marked.plugins.fresh?.seenAt).toBe("2026-01-03T01:00:00.000Z");

    const pruned = pruneExpiredFlaggedPlugins(
      marked.plugins,
      Date.parse("2026-01-03T01:00:00.000Z") + FLAGGED_PLUGIN_SEEN_EXPIRY_MS,
    );
    expect(pruned.changed).toBe(true);
    expect(pruned.plugins.fresh).toBeUndefined();

    const removed = removeFlaggedPluginState(added, "fresh");
    expect(removed).toMatchObject({ changed: true });
    expect(removed.plugins.fresh).toBeUndefined();
  });

  test("stores flagged plugins with private atomic writes", async () => {
    await withTempDir(async (root) => {
      const pluginsDirectory = join(root, "plugins");
      const store = new FlaggedPluginStore({
        pluginsDirectory,
        now: () => new Date("2026-02-01T00:00:00.000Z"),
        tokenBytes: () => Buffer.from("0123456789abcdef", "hex"),
      });

      await expect(store.addFlaggedPlugin("alpha@team")).resolves.toBe(true);
      expect(store.getFlaggedPlugins()).toEqual({
        "alpha@team": { flaggedAt: "2026-02-01T00:00:00.000Z" },
      });

      const filePath = join(pluginsDirectory, FLAGGED_PLUGINS_FILENAME);
      expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual({
        plugins: {
          "alpha@team": { flaggedAt: "2026-02-01T00:00:00.000Z" },
        },
      });
      expect((await stat(filePath)).mode & 0o777).toBe(0o600);

      const reloaded = new FlaggedPluginStore({ pluginsDirectory });
      await reloaded.loadFlaggedPlugins();
      expect(reloaded.getFlaggedPlugins()).toEqual(store.getFlaggedPlugins());
    });
  });
});

async function withTempDir(fn: (root: string) => Promise<void>): Promise<void> {
  const root = join(tmpdir(), `agenc-plugin-policy-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(root, { recursive: true });
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
