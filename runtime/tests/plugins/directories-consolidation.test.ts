import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  createPluginStorageAuthority,
  deletePluginDataDir,
  getPluginDataDir,
  getPluginDataDirSize,
  getPluginsDirectory,
  isReservedPluginStorageChildName,
  migrateLegacyPluginDataDirectories,
  pluginCacheDirPath,
  pluginDataDirPath,
  pluginDataRootPath,
  pluginFilesystemKey,
  pluginInventoryPath,
  pluginMarketplaceRootPath,
  pluginStorageRootPath,
  resolvePluginStorageAuthority,
} from "../../src/plugins/directories.js";
import { clearCurrentRuntimeSession } from "../../src/session/current-session.js";
import {
  resolveAgentRuntimeOptions,
  runWithAgentRuntimeOptions,
} from "../../src/session/runtime-options.js";

afterEach(() => {
  clearCurrentRuntimeSession();
});

describe("plugin directory authority", () => {
  test("owns the complete set of reserved plugin-storage child names", () => {
    for (const name of [
      "build",
      "cache",
      "coverage",
      "data",
      "dist",
      "marketplaces",
      "node_modules",
    ]) {
      expect(isReservedPluginStorageChildName(name), name).toBe(true);
      expect(isReservedPluginStorageChildName(name.toUpperCase()), name)
        .toBe(true);
    }
    expect(isReservedPluginStorageChildName("ordinary-plugin")).toBe(false);
  });

  test("derives every storage path from one explicit normalized root", () => {
    const root = normalize(
      join(tmpdir(), "agenc-plugin-authority", "nested", ".."),
    );
    const authority = createPluginStorageAuthority(root);

    expect(pluginStorageRootPath(authority)).toBe(root);
    expect(pluginCacheDirPath(authority)).toBe(join(root, "cache"));
    expect(pluginDataRootPath(authority)).toBe(join(root, "data"));
    expect(pluginDataDirPath("team/plugin@1", authority)).toBe(
      join(root, "data", pluginFilesystemKey("team/plugin@1")),
    );
    expect(pluginMarketplaceRootPath(authority)).toBe(
      join(root, "marketplaces"),
    );
    expect(pluginInventoryPath(authority)).toBe(
      join(root, "known_marketplaces.json"),
    );
    expect(() => createPluginStorageAuthority("relative/plugins")).toThrow(
      "must be an absolute path",
    );
  });

  test("uses the immutable active runtime root for adapter calls", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenc-plugin-active-"));
    try {
      const options = resolveAgentRuntimeOptions({}, { pluginStorageRoot: root });
      await runWithAgentRuntimeOptions(options, async () => {
        expect(resolvePluginStorageAuthority()).toEqual({
          pluginStorageRoot: root,
        });
        expect(getPluginsDirectory()).toBe(root);

        const dataDir = getPluginDataDir("team/plugin@1");
        await writeFile(join(dataDir, "state.bin"), Buffer.alloc(1024));
        await expect(getPluginDataDirSize("team/plugin@1")).resolves.toEqual({
          bytes: 1024,
          human: "1KB",
        });
        await deletePluginDataDir("team/plugin@1");
        await expect(stat(dataDir)).rejects.toMatchObject({ code: "ENOENT" });
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("migrates unambiguous old data once and rejects lossy collisions", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenc-plugin-data-migration-"));
    try {
      const authority = createPluginStorageAuthority(root);
      const legacyUnique = join(root, "data", "unique_plugin");
      await mkdir(legacyUnique, { recursive: true });
      await writeFile(join(legacyUnique, "state.json"), "preserved", "utf8");

      await expect(
        migrateLegacyPluginDataDirectories(["unique_plugin"], authority),
      ).resolves.toEqual([]);
      const canonicalUnique = pluginDataDirPath("unique_plugin", authority);
      await expect(readFile(join(canonicalUnique, "state.json"), "utf8"))
        .resolves.toBe("preserved");
      await expect(stat(legacyUnique)).rejects.toMatchObject({ code: "ENOENT" });

      const ambiguous = join(root, "data", "foo-bar");
      await mkdir(ambiguous, { recursive: true });
      await writeFile(join(ambiguous, "state.json"), "ambiguous", "utf8");
      const issues = await migrateLegacyPluginDataDirectories(
        ["foo@bar", "foo-bar"],
        authority,
      );
      expect(issues).toEqual([
        expect.objectContaining({
          pluginIds: ["foo-bar", "foo@bar"],
          legacyPath: ambiguous,
          message: expect.stringContaining("cannot be attributed safely"),
        }),
      ]);
      await expect(stat(ambiguous)).resolves.toMatchObject({});
      await expect(stat(pluginDataDirPath("foo@bar", authority)))
        .rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(pluginDataDirPath("foo-bar", authority)))
        .rejects.toMatchObject({ code: "ENOENT" });

      await rm(ambiguous, { recursive: true, force: true });
      await mkdir(ambiguous, { recursive: true });
      await writeFile(join(ambiguous, "kept.json"), "old-owner", "utf8");
      const orphanCollision = await migrateLegacyPluginDataDirectories(
        ["foo@bar"],
        authority,
      );
      expect(orphanCollision).toEqual([
        expect.objectContaining({
          pluginIds: ["foo@bar"],
          message: expect.stringContaining("cannot be attributed safely"),
        }),
      ]);
      await expect(readFile(join(ambiguous, "kept.json"), "utf8"))
        .resolves.toBe("old-owner");
      await expect(stat(pluginDataDirPath("foo@bar", authority)))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("keeps concurrent plugin roots isolated even when other inputs match", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenc-plugin-isolation-"));
    try {
      const rootA = join(root, "plugins-a");
      const rootB = join(root, "plugins-b");
      const optionsA = resolveAgentRuntimeOptions(
        {},
        { pluginStorageRoot: rootA },
      );
      const optionsB = resolveAgentRuntimeOptions(
        {},
        { pluginStorageRoot: rootB },
      );

      const [resolvedA, resolvedB] = await Promise.all([
        runWithAgentRuntimeOptions(optionsA, async () => {
          await Promise.resolve();
          return {
            root: getPluginsDirectory(),
            data: getPluginDataDir("shared/plugin"),
          };
        }),
        runWithAgentRuntimeOptions(optionsB, async () => {
          await Promise.resolve();
          return {
            root: getPluginsDirectory(),
            data: getPluginDataDir("shared/plugin"),
          };
        }),
      ]);

      expect(resolvedA).toEqual({
        root: rootA,
        data: join(rootA, "data", pluginFilesystemKey("shared/plugin")),
      });
      expect(resolvedB).toEqual({
        root: rootB,
        data: join(rootB, "data", pluginFilesystemKey("shared/plugin")),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("fails closed without an explicit or active runtime authority", () => {
    clearCurrentRuntimeSession();
    expect(() => resolvePluginStorageAuthority()).toThrow(
      "requires an explicit root or active runtime options",
    );
    expect(() => getPluginsDirectory()).toThrow(
      "requires an explicit root or active runtime options",
    );
  });
});
