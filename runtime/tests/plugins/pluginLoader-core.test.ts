import { execFile as execFileCallback } from "node:child_process";
import { chmod, mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, test, vi } from "vitest";

import type { LoadedPlugin } from "../../src/types/plugin.js";
import type { PluginSource } from "../../src/utils/plugins/schemas.js";
import { setInlinePlugins } from "../../src/bootstrap/state.js";
import { clearInstalledPluginsCache } from "../../src/utils/plugins/installedPluginsManager.js";
import {
  cachePluginSettings,
  clearPluginCache,
  copyDir,
  copyPluginToVersionedCache,
  createPluginFromPath,
  generateTemporaryCacheNameForPlugin,
  getLegacyCachePath,
  getPluginCachePath,
  getVersionedCachePath,
  getVersionedCachePathIn,
  getVersionedZipCachePath,
  cachePlugin,
  installFromGitSubdir,
  loadAllPlugins,
  loadAllPluginsCacheOnly,
  loadPluginManifest,
  probeSeedCacheAnyVersion,
  resolvePluginPath,
} from "../../src/utils/plugins/pluginLoader.js";
import {
  getPluginSettingsBase,
  resetSettingsCache,
  setPluginSettingsBase,
} from "../../src/utils/settings/settingsCache.js";

const originalConfigDir = process.env.AGENC_CONFIG_DIR;
const originalPluginCacheDir = process.env.AGENC_PLUGIN_CACHE_DIR;
const originalPluginSeedDir = process.env.AGENC_PLUGIN_SEED_DIR;
const originalSyncPluginInstall = process.env.AGENC_SYNC_PLUGIN_INSTALL;
const originalPath = process.env.PATH;
const tempDirs: string[] = [];
const execFile = promisify(execFileCallback);

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function withPluginCacheDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await tempDir("agenc-plugin-loader-");
  process.env.AGENC_PLUGIN_CACHE_DIR = dir;
  return await run(dir);
}

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFile("git", args, { cwd });
  return stdout.trim();
}

afterEach(async () => {
  if (originalConfigDir === undefined) {
    delete process.env.AGENC_CONFIG_DIR;
  } else {
    process.env.AGENC_CONFIG_DIR = originalConfigDir;
  }
  if (originalPluginCacheDir === undefined) {
    delete process.env.AGENC_PLUGIN_CACHE_DIR;
  } else {
    process.env.AGENC_PLUGIN_CACHE_DIR = originalPluginCacheDir;
  }
  if (originalPluginSeedDir === undefined) {
    delete process.env.AGENC_PLUGIN_SEED_DIR;
  } else {
    process.env.AGENC_PLUGIN_SEED_DIR = originalPluginSeedDir;
  }
  if (originalSyncPluginInstall === undefined) {
    delete process.env.AGENC_SYNC_PLUGIN_INSTALL;
  } else {
    process.env.AGENC_SYNC_PLUGIN_INSTALL = originalSyncPluginInstall;
  }
  if (originalPath === undefined) {
    delete process.env.PATH;
  } else {
    process.env.PATH = originalPath;
  }
  vi.restoreAllMocks();
  setInlinePlugins([]);
  setPluginSettingsBase(undefined);
  resetSettingsCache();
  clearInstalledPluginsCache();
  clearPluginCache("test cleanup");
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe("plugin loader path helpers", () => {
  test("builds sanitized plugin cache paths", async () => {
    await withPluginCacheDir(async cacheRoot => {
      expect(getPluginCachePath()).toBe(join(cacheRoot, "cache"));
      expect(getVersionedCachePathIn("/seed", "bad/name@market.place", "v1/../../x")).toBe(
        join("/seed", "cache", "market-place", "bad-name", "v1-..-..-x"),
      );
      expect(getVersionedCachePath("bad/name@market.place", "1.2.3")).toBe(
        join(cacheRoot, "cache", "market-place", "bad-name", "1.2.3"),
      );
      expect(getVersionedZipCachePath("bad/name@market.place", "1.2.3")).toBe(
        join(cacheRoot, "cache", "market-place", "bad-name", "1.2.3.zip"),
      );
      expect(getLegacyCachePath("bad/name")).toBe(join(cacheRoot, "cache", "bad-name"));
    });
  });

  test("resolves versioned cache first, legacy cache second, then new target", async () => {
    await withPluginCacheDir(async cacheRoot => {
      const versioned = getVersionedCachePath("demo@market", "1.0.0");
      await mkdir(versioned, { recursive: true });
      expect(await resolvePluginPath("demo@market", "1.0.0")).toBe(versioned);

      await rm(versioned, { recursive: true, force: true });
      const legacy = getLegacyCachePath("demo");
      await mkdir(legacy, { recursive: true });
      expect(await resolvePluginPath("demo@market", "1.0.0")).toBe(legacy);

      await rm(legacy, { recursive: true, force: true });
      expect(await resolvePluginPath("demo@market", "1.0.0")).toBe(
        join(cacheRoot, "cache", "market", "demo", "1.0.0"),
      );
      expect(await resolvePluginPath("demo@market")).toBe(legacy);
    });
  });

  test("probes seed caches only when a single populated version exists", async () => {
    expect(await probeSeedCacheAnyVersion("demo@market")).toBeNull();

    const root = await tempDir("agenc-plugin-seed-");
    const ambiguousSeed = join(root, "ambiguous");
    const emptySeed = join(root, "empty");
    const populatedSeed = join(root, "populated");
    await mkdir(getVersionedCachePathIn(ambiguousSeed, "demo@market", "1.0.0"), {
      recursive: true,
    });
    await mkdir(getVersionedCachePathIn(ambiguousSeed, "demo@market", "2.0.0"), {
      recursive: true,
    });
    const emptyVersion = getVersionedCachePathIn(emptySeed, "demo@market", "3.0.0");
    await mkdir(emptyVersion, { recursive: true });
    const populatedVersion = getVersionedCachePathIn(populatedSeed, "demo@market", "4.0.0");
    await mkdir(populatedVersion, { recursive: true });
    await writeFile(join(populatedVersion, "plugin.json"), "{}", "utf8");

    process.env.AGENC_PLUGIN_SEED_DIR = [
      join(root, "missing"),
      ambiguousSeed,
      emptySeed,
      populatedSeed,
    ].join(delimiter);

    expect(await probeSeedCacheAnyVersion("demo@market")).toBe(populatedVersion);
  });

  test("generates temporary cache names with source-specific prefixes", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    vi.spyOn(Math, "random").mockReturnValue(0.5);

    const cases: Array<[PluginSource, string]> = [
      ["./local-plugin", "local"],
      [{ source: "npm", package: "demo" }, "npm"],
      [{ source: "pip", package: "demo" }, "pip"],
      [{ source: "github", repo: "owner/repo" }, "github"],
      [{ source: "url", url: "https://example.com/repo.git" }, "git"],
      [{ source: "git-subdir", url: "owner/repo", path: "plugins/demo" }, "subdir"],
    ];

    for (const [source, prefix] of cases) {
      expect(generateTemporaryCacheNameForPlugin(source)).toBe(
        `temp_${prefix}_1700000000000_i`,
      );
    }
    expect(
      generateTemporaryCacheNameForPlugin({ source: "future-source" } as never),
    ).toBe("temp_unknown_1700000000000_i");
  });
});

describe("plugin loader file copying", () => {
  test("copyDir recursively copies files and preserves symlink intent", async () => {
    const root = await tempDir("agenc-plugin-copy-");
    const src = join(root, "src");
    const dest = join(root, "dest");
    const external = join(root, "external.txt");
    await mkdir(join(src, "nested"), { recursive: true });
    await writeFile(join(src, "nested", "file.txt"), "nested content", "utf8");
    await writeFile(external, "external content", "utf8");
    await symlink(join(src, "nested", "file.txt"), join(src, "inside-link"));
    await symlink(external, join(src, "outside-link"));
    await symlink("missing-target", join(src, "broken-link"));

    await copyDir(src, dest);

    expect(await readFile(join(dest, "nested", "file.txt"), "utf8")).toBe("nested content");
    expect(await readFile(join(dest, "inside-link"), "utf8")).toBe("nested content");
    expect(await readFile(join(dest, "outside-link"), "utf8")).toBe("external content");
    await expect(readFile(join(dest, "broken-link"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("copyPluginToVersionedCache copies source, removes git metadata, and rejects empty copies", async () => {
    await withPluginCacheDir(async () => {
      const root = await tempDir("agenc-plugin-cache-copy-");
      const source = join(root, "source");
      await mkdir(join(source, ".git"), { recursive: true });
      await writeFile(join(source, ".git", "config"), "private", "utf8");
      await writeFile(join(source, "plugin.json"), JSON.stringify({ name: "cached" }), "utf8");

      const cachedPath = await copyPluginToVersionedCache(
        source,
        "cached@market",
        "1.0.0",
      );

      expect(cachedPath).toBe(getVersionedCachePath("cached@market", "1.0.0"));
      expect(await readFile(join(cachedPath, "plugin.json"), "utf8")).toContain("cached");
      await expect(readFile(join(cachedPath, ".git", "config"), "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });

      const emptySource = join(root, "empty");
      await mkdir(emptySource, { recursive: true });
      await expect(
        copyPluginToVersionedCache(emptySource, "empty@market", "1.0.0"),
      ).rejects.toThrow("destination is empty after copy");
    });
  });

  test("copyPluginToVersionedCache reuses populated caches and replaces empty cache dirs", async () => {
    await withPluginCacheDir(async () => {
      const root = await tempDir("agenc-plugin-existing-cache-");
      const source = join(root, "source");
      await mkdir(source, { recursive: true });
      await writeFile(join(source, "plugin.json"), JSON.stringify({ name: "fresh" }), "utf8");

      const populatedCache = getVersionedCachePath("existing@market", "1.0.0");
      await mkdir(populatedCache, { recursive: true });
      await writeFile(join(populatedCache, "plugin.json"), "stale", "utf8");

      await expect(
        copyPluginToVersionedCache(source, "existing@market", "1.0.0"),
      ).resolves.toBe(populatedCache);
      expect(await readFile(join(populatedCache, "plugin.json"), "utf8")).toBe("stale");

      const emptyCache = getVersionedCachePath("empty@market", "1.0.0");
      await mkdir(emptyCache, { recursive: true });

      await expect(
        copyPluginToVersionedCache(source, "empty@market", "1.0.0"),
      ).resolves.toBe(emptyCache);
      expect(await readFile(join(emptyCache, "plugin.json"), "utf8")).toContain("fresh");
    });
  });

  test("copyPluginToVersionedCache returns an exact seed-cache hit without copying source", async () => {
    await withPluginCacheDir(async () => {
      const seedRoot = await tempDir("agenc-plugin-exact-seed-");
      const seedPath = getVersionedCachePathIn(seedRoot, "seeded@market", "9.0.0");
      await mkdir(seedPath, { recursive: true });
      await writeFile(join(seedPath, "plugin.json"), JSON.stringify({ name: "seeded" }), "utf8");
      process.env.AGENC_PLUGIN_SEED_DIR = seedRoot;

      await expect(
        copyPluginToVersionedCache("/missing/source", "seeded@market", "9.0.0"),
      ).resolves.toBe(seedPath);
    });
  });

  test("copyPluginToVersionedCache uses marketplace entry source relative to marketplace dir", async () => {
    await withPluginCacheDir(async () => {
      const root = await tempDir("agenc-plugin-market-source-");
      const marketplaceDir = join(root, "marketplace");
      const pluginSource = join(marketplaceDir, "plugins", "demo");
      await mkdir(pluginSource, { recursive: true });
      await writeFile(join(pluginSource, "plugin.json"), JSON.stringify({ name: "demo" }), "utf8");

      const cachedPath = await copyPluginToVersionedCache(
        join(root, "unused-fallback"),
        "demo@market",
        "2.0.0",
        { name: "demo", version: "2.0.0", source: "./plugins/demo" } as never,
        marketplaceDir,
      );

      expect(await readFile(join(cachedPath, "plugin.json"), "utf8")).toContain("demo");

      await expect(
        copyPluginToVersionedCache(
          join(root, "unused-fallback"),
          "missing@market",
          "2.0.0",
          { name: "missing", version: "2.0.0", source: "./plugins/missing" } as never,
          marketplaceDir,
        ),
      ).rejects.toThrow(`Plugin source directory not found: ${join(marketplaceDir, "plugins", "missing")}`);
    });
  });
});

describe("plugin loader cache and git-subdir installs", () => {
  test("cachePlugin caches a local plugin, replaces stale cache, and removes git metadata", async () => {
    await withPluginCacheDir(async cacheRoot => {
      const root = await tempDir("agenc-plugin-cache-local-");
      const source = join(root, "source");
      await mkdir(join(source, ".agenc-plugin"), { recursive: true });
      await mkdir(join(source, ".git"), { recursive: true });
      await writeFile(join(source, ".git", "config"), "private", "utf8");
      await writeFile(join(source, "README.md"), "# cached\n", "utf8");
      await writeFile(
        join(source, ".agenc-plugin", "plugin.json"),
        JSON.stringify({ name: "cached-local", description: "cached desc" }),
        "utf8",
      );

      const staleFinalPath = join(cacheRoot, "cache", "cached-local");
      await mkdir(staleFinalPath, { recursive: true });
      await writeFile(join(staleFinalPath, "stale.txt"), "old", "utf8");

      const result = await cachePlugin(source);

      expect(result).toMatchObject({
        path: staleFinalPath,
        manifest: { name: "cached-local", description: "cached desc" },
      });
      expect(await readFile(join(result.path, "README.md"), "utf8")).toBe("# cached\n");
      await expect(readFile(join(result.path, ".git", "config"), "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(readFile(join(result.path, "stale.txt"), "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  });

  test("cachePlugin uses the provided manifest when cached content has no manifest", async () => {
    await withPluginCacheDir(async cacheRoot => {
      const source = await tempDir("agenc-plugin-cache-manifest-option-");
      await writeFile(join(source, "command.md"), "# command\n", "utf8");

      const result = await cachePlugin(source, {
        manifest: { name: "provided-manifest", description: "provided desc" },
      });

      expect(result).toEqual({
        path: join(cacheRoot, "cache", "provided-manifest"),
        manifest: { name: "provided-manifest", description: "provided desc" },
      });
      expect(await readFile(join(result.path, "command.md"), "utf8")).toBe("# command\n");
    });
  });

  test("cachePlugin loads legacy root manifests and rejects corrupt manifests", async () => {
    await withPluginCacheDir(async cacheRoot => {
      const source = await tempDir("agenc-plugin-cache-legacy-manifest-");
      await writeFile(
        join(source, "plugin.json"),
        JSON.stringify({ name: "legacy-manifest", description: "legacy desc" }),
        "utf8",
      );

      await expect(cachePlugin(source)).resolves.toEqual({
        path: join(cacheRoot, "cache", "legacy-manifest"),
        manifest: { name: "legacy-manifest", description: "legacy desc" },
      });

      const corruptSource = await tempDir("agenc-plugin-cache-corrupt-manifest-");
      await mkdir(join(corruptSource, ".agenc-plugin"), { recursive: true });
      await writeFile(join(corruptSource, ".agenc-plugin", "plugin.json"), "{", "utf8");

      await expect(cachePlugin(corruptSource)).rejects.toThrow(
        "Plugin has a corrupt manifest file",
      );
    });
  });

  test("cachePlugin rejects unsupported Python package sources without leaving temp cache entries", async () => {
    await withPluginCacheDir(async () => {
      await expect(
        cachePlugin({ source: "pip", package: "demo-package" }),
      ).rejects.toThrow("Python package plugins are not yet supported");

      expect(await readdir(getPluginCachePath())).toEqual([]);
    });
  });

  test("installFromGitSubdir sparsely extracts a local git subdirectory and returns HEAD sha", async () => {
    const root = await tempDir("agenc-plugin-git-subdir-");
    const repo = join(root, "repo");
    const target = join(root, "target");
    await mkdir(join(repo, "plugins", "demo", ".agenc-plugin"), { recursive: true });
    await mkdir(join(repo, "unrelated"), { recursive: true });
    await writeFile(join(repo, "plugins", "demo", "command.md"), "# demo\n", "utf8");
    await writeFile(
      join(repo, "plugins", "demo", ".agenc-plugin", "plugin.json"),
      JSON.stringify({ name: "subdir-demo" }),
      "utf8",
    );
    await writeFile(join(repo, "unrelated", "ignored.txt"), "ignored", "utf8");
    await git(["init"], repo);
    await git(["add", "."], repo);
    await git(
      ["-c", "user.name=AgenC Test", "-c", "user.email=test@example.com", "commit", "-m", "init"],
      repo,
    );
    const sha = await git(["rev-parse", "HEAD"], repo);

    const resolvedSha = await installFromGitSubdir(
      pathToFileURL(repo).href,
      target,
      "plugins/demo",
    );

    expect(resolvedSha).toBe(sha);
    expect(await readFile(join(target, "command.md"), "utf8")).toBe("# demo\n");
    expect(await readFile(join(target, ".agenc-plugin", "plugin.json"), "utf8")).toContain(
      "subdir-demo",
    );
    await expect(readFile(join(target, "..", "unrelated", "ignored.txt"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readdir(`${target}.clone`)).rejects.toMatchObject({ code: "ENOENT" });

    const pinnedTarget = join(root, "target-pinned");
    await expect(
      installFromGitSubdir(pathToFileURL(repo).href, pinnedTarget, "plugins/demo", undefined, sha),
    ).resolves.toBe(sha);
    expect(await readFile(join(pinnedTarget, "command.md"), "utf8")).toBe("# demo\n");

    const missingTarget = join(root, "target-missing");
    await expect(
      installFromGitSubdir(pathToFileURL(repo).href, missingTarget, "plugins/missing"),
    ).rejects.toThrow("Subdirectory 'plugins/missing' not found");
    await expect(readdir(`${missingTarget}.clone`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("installFromGitSubdir rejects invalid repository URLs", async () => {
    const root = await tempDir("agenc-plugin-git-subdir-invalid-");

    await expect(
      installFromGitSubdir("not a url", join(root, "target"), "plugins/demo"),
    ).rejects.toThrow("Invalid git URL: not a url");
  });

  test("cachePlugin installs npm sources through the global npm cache", async () => {
    await withPluginCacheDir(async cacheRoot => {
      const root = await tempDir("agenc-plugin-fake-npm-");
      const binDir = join(root, "bin");
      await mkdir(binDir, { recursive: true });
      await writeFile(
        join(binDir, "npm"),
        [
          "#!/bin/sh",
          "pkg=\"\"",
          "prefix=\"\"",
          "while [ \"$#\" -gt 0 ]; do",
          "  case \"$1\" in",
          "    install) shift; pkg=\"$1\" ;;",
          "    --prefix) shift; prefix=\"$1\" ;;",
          "  esac",
          "  shift || true",
          "done",
          "name=\"${pkg%@*}\"",
          "mkdir -p \"$prefix/node_modules/$name/.agenc-plugin\"",
          "printf '%s' '{\"name\":\"npm-cached\",\"description\":\"from npm\"}' > \"$prefix/node_modules/$name/.agenc-plugin/plugin.json\"",
          "printf '%s\\n' '# npm command' > \"$prefix/node_modules/$name/command.md\"",
        ].join("\n"),
        "utf8",
      );
      await chmod(join(binDir, "npm"), 0o755);
      process.env.PATH = `${binDir}${delimiter}${originalPath ?? ""}`;

      const result = await cachePlugin({
        source: "npm",
        package: "demo-package",
        version: "1.2.3",
        registry: "https://registry.test",
      });

      expect(result).toEqual({
        path: join(cacheRoot, "cache", "npm-cached"),
        manifest: { name: "npm-cached", description: "from npm" },
      });
      expect(await readFile(join(result.path, "command.md"), "utf8")).toBe("# npm command\n");

      await writeFile(
        join(binDir, "npm"),
        [
          "#!/bin/sh",
          "prefix=\"\"",
          "while [ \"$#\" -gt 0 ]; do",
          "  if [ \"$1\" = \"--prefix\" ]; then shift; prefix=\"$1\"; fi",
          "  shift || true",
          "done",
          "mkdir -p \"$prefix/node_modules/demo-fail\"",
          "printf '%s' 'simulated npm failure' >&2",
          "exit 42",
        ].join("\n"),
        "utf8",
      );
      await chmod(join(binDir, "npm"), 0o755);

      await expect(
        cachePlugin({ source: "npm", package: "demo-fail" }),
      ).rejects.toThrow("Failed to install npm package: simulated npm failure");
    });
  });

  test("cachePlugin caches local file-url git and git-subdir sources", async () => {
    await withPluginCacheDir(async cacheRoot => {
      const root = await tempDir("agenc-plugin-cache-git-");
      const repo = join(root, "repo");
      await mkdir(join(repo, ".agenc-plugin"), { recursive: true });
      await mkdir(join(repo, "plugins", "nested", ".agenc-plugin"), { recursive: true });
      await writeFile(join(repo, "command.md"), "# git command\n", "utf8");
      await writeFile(
        join(repo, ".agenc-plugin", "plugin.json"),
        JSON.stringify({ name: "git-cached" }),
        "utf8",
      );
      await writeFile(join(repo, "plugins", "nested", "command.md"), "# nested command\n", "utf8");
      await writeFile(
        join(repo, "plugins", "nested", ".agenc-plugin", "plugin.json"),
        JSON.stringify({ name: "subdir-cached" }),
        "utf8",
      );
      await git(["init"], repo);
      await git(["add", "."], repo);
      await git(
        ["-c", "user.name=AgenC Test", "-c", "user.email=test@example.com", "commit", "-m", "init"],
        repo,
      );
      const sha = await git(["rev-parse", "HEAD"], repo);
      const defaultBranch = await git(["branch", "--show-current"], repo);
      await git(["checkout", "-b", "feature"], repo);
      await writeFile(join(repo, "command.md"), "# feature command\n", "utf8");
      await writeFile(
        join(repo, ".agenc-plugin", "plugin.json"),
        JSON.stringify({ name: "git-ref-cached" }),
        "utf8",
      );
      await git(["add", "."], repo);
      await git(
        ["-c", "user.name=AgenC Test", "-c", "user.email=test@example.com", "commit", "-m", "feature"],
        repo,
      );
      await git(["checkout", defaultBranch], repo);

      await expect(
        cachePlugin({ source: "url", url: pathToFileURL(repo).href }),
      ).resolves.toEqual({
        path: join(cacheRoot, "cache", "git-cached"),
        manifest: { name: "git-cached" },
      });
      expect(await readFile(join(cacheRoot, "cache", "git-cached", "command.md"), "utf8")).toBe(
        "# git command\n",
      );

      await expect(
        cachePlugin({ source: "url", url: pathToFileURL(repo).href, ref: "feature" }),
      ).resolves.toEqual({
        path: join(cacheRoot, "cache", "git-ref-cached"),
        manifest: { name: "git-ref-cached" },
      });
      expect(await readFile(join(cacheRoot, "cache", "git-ref-cached", "command.md"), "utf8")).toBe(
        "# feature command\n",
      );

      await expect(
        cachePlugin({ source: "url", url: pathToFileURL(repo).href, sha }),
      ).resolves.toEqual({
        path: join(cacheRoot, "cache", "git-cached"),
        manifest: { name: "git-cached" },
      });

      await expect(
        cachePlugin({
          source: "git-subdir",
          url: pathToFileURL(repo).href,
          path: "plugins/nested",
        }),
      ).resolves.toEqual({
        path: join(cacheRoot, "cache", "subdir-cached"),
        manifest: { name: "subdir-cached" },
        gitCommitSha: sha,
      });
      expect(await readFile(join(cacheRoot, "cache", "subdir-cached", "command.md"), "utf8")).toBe(
        "# nested command\n",
      );

      await expect(cachePlugin(join(root, "missing-local"))).rejects.toThrow(
        "Source path does not exist",
      );
    });
  });

  test("cachePlugin rejects invalid remote sources and manifest schemas", async () => {
    await withPluginCacheDir(async () => {
      await expect(
        cachePlugin({ source: "github", repo: "bad repo" }),
      ).rejects.toThrow("Invalid GitHub repository format");
      await expect(
        cachePlugin({ source: "future-source" } as never),
      ).rejects.toThrow("Unsupported plugin source type");

      const invalidManifestSource = await tempDir("agenc-plugin-invalid-manifest-");
      await mkdir(join(invalidManifestSource, ".agenc-plugin"), { recursive: true });
      await writeFile(
        join(invalidManifestSource, ".agenc-plugin", "plugin.json"),
        JSON.stringify({ name: 42 }),
        "utf8",
      );
      await expect(cachePlugin(invalidManifestSource)).rejects.toThrow(
        "invalid manifest file",
      );

      const invalidLegacyManifestSource = await tempDir("agenc-plugin-invalid-legacy-manifest-");
      await writeFile(
        join(invalidLegacyManifestSource, "plugin.json"),
        JSON.stringify({ name: 42 }),
        "utf8",
      );
      await expect(cachePlugin(invalidLegacyManifestSource)).rejects.toThrow(
        "invalid manifest file",
      );
    });
  });
});

describe("plugin loader manifest and settings helpers", () => {
  test("loadPluginManifest returns defaults, strips unknown keys, and reports invalid files", async () => {
    const root = await tempDir("agenc-plugin-manifest-");
    const missingManifest = join(root, "missing", "plugin.json");

    await expect(loadPluginManifest(missingManifest, "missing", "local")).resolves.toEqual({
      name: "missing",
      description: "Plugin from local",
    });

    const validManifest = join(root, "plugin.json");
    await writeFile(
      validManifest,
      JSON.stringify({ name: "demo", description: "desc", extra: "stripped" }),
      "utf8",
    );
    await expect(loadPluginManifest(validManifest, "fallback", "local")).resolves.toEqual({
      name: "demo",
      description: "desc",
    });

    const corruptManifest = join(root, "corrupt.json");
    await writeFile(corruptManifest, "{", "utf8");
    await expect(loadPluginManifest(corruptManifest, "bad", "local")).rejects.toThrow(
      "corrupt manifest file",
    );

    const invalidManifest = join(root, "invalid.json");
    await writeFile(invalidManifest, JSON.stringify({ name: 42 }), "utf8");
    await expect(loadPluginManifest(invalidManifest, "bad", "local")).rejects.toThrow(
      "invalid manifest file",
    );
  });

  test("createPluginFromPath detects default component directories without a manifest", async () => {
    const pluginRoot = await tempDir("agenc-plugin-default-components-");
    await mkdir(join(pluginRoot, "commands"), { recursive: true });
    await mkdir(join(pluginRoot, "agents"), { recursive: true });
    await mkdir(join(pluginRoot, "skills"), { recursive: true });
    await mkdir(join(pluginRoot, "output-styles"), { recursive: true });

    const { plugin, errors } = await createPluginFromPath(
      pluginRoot,
      "session:/plugin-root",
      false,
      "fallback-plugin",
    );

    expect(errors).toEqual([]);
    expect(plugin).toMatchObject({
      name: "fallback-plugin",
      source: "session:/plugin-root",
      repository: "session:/plugin-root",
      enabled: false,
      commandsPath: join(pluginRoot, "commands"),
      agentsPath: join(pluginRoot, "agents"),
      skillsPath: join(pluginRoot, "skills"),
      outputStylesPath: join(pluginRoot, "output-styles"),
    });
  });

  test("createPluginFromPath loads manifest components, hooks, settings, and non-fatal path errors", async () => {
    const pluginRoot = await tempDir("agenc-plugin-manifest-components-");
    await mkdir(join(pluginRoot, ".agenc-plugin"), { recursive: true });
    await mkdir(join(pluginRoot, "extra"), { recursive: true });
    await mkdir(join(pluginRoot, "extra", "skill"), { recursive: true });
    await mkdir(join(pluginRoot, "hooks"), { recursive: true });
    await writeFile(join(pluginRoot, "extra", "command.md"), "# command\n", "utf8");
    await writeFile(join(pluginRoot, "extra", "agent.md"), "# agent\n", "utf8");
    await writeFile(join(pluginRoot, "extra", "skill", "SKILL.md"), "# skill\n", "utf8");
    await writeFile(join(pluginRoot, "extra", "style.md"), "# style\n", "utf8");
    await writeFile(
      join(pluginRoot, "hooks", "hooks.json"),
      JSON.stringify({
        hooks: {
          Stop: [{ hooks: [{ type: "command", command: "echo stop" }] }],
        },
      }),
      "utf8",
    );
    await writeFile(
      join(pluginRoot, "extra-hooks.json"),
      JSON.stringify({
        hooks: {
          SessionStart: [{ hooks: [{ type: "command", command: "echo start" }] }],
        },
      }),
      "utf8",
    );
    await writeFile(
      join(pluginRoot, "settings.json"),
      JSON.stringify({ agent: "file-agent", model: "ignored" }),
      "utf8",
    );
    await writeFile(
      join(pluginRoot, ".agenc-plugin", "plugin.json"),
      JSON.stringify({
        name: "manifest-plugin",
        commands: {
          file: { source: "./extra/command.md", description: "File command" },
          inline: { content: "# inline" },
          missing: { source: "./extra/missing.md" },
        },
        agents: ["./extra/agent.md", "./extra/missing-agent.md"],
        skills: ["./extra/skill", "./extra/missing-skill"],
        outputStyles: ["./extra/style.md", "./extra/missing-style.md"],
        hooks: [
          "./extra-hooks.json",
          { Stop: [{ hooks: [{ type: "command", command: "echo inline" }] }] },
        ],
        settings: { agent: "manifest-agent" },
      }),
      "utf8",
    );

    const { plugin, errors } = await createPluginFromPath(
      pluginRoot,
      "marketplace:manifest-plugin",
      true,
      "fallback",
    );

    expect(plugin.name).toBe("manifest-plugin");
    expect(plugin.enabled).toBe(true);
    expect(plugin.commandsPaths).toEqual([join(pluginRoot, "extra", "command.md")]);
    expect(plugin.commandsMetadata).toMatchObject({
      file: { source: "./extra/command.md", description: "File command" },
      inline: { content: "# inline" },
    });
    expect(plugin.agentsPaths).toEqual([join(pluginRoot, "extra", "agent.md")]);
    expect(plugin.skillsPaths).toEqual([join(pluginRoot, "extra", "skill")]);
    expect(plugin.outputStylesPaths).toEqual([join(pluginRoot, "extra", "style.md")]);
    expect(plugin.hooksConfig?.Stop).toHaveLength(2);
    expect(plugin.hooksConfig?.SessionStart).toHaveLength(1);
    expect(plugin.settings).toEqual({ agent: "file-agent" });
    expect(errors).toEqual([
      {
        type: "path-not-found",
        source: "marketplace:manifest-plugin",
        plugin: "manifest-plugin",
        path: join(pluginRoot, "extra", "missing.md"),
        component: "commands",
      },
      {
        type: "path-not-found",
        source: "marketplace:manifest-plugin",
        plugin: "manifest-plugin",
        path: join(pluginRoot, "extra", "missing-agent.md"),
        component: "agents",
      },
      {
        type: "path-not-found",
        source: "marketplace:manifest-plugin",
        plugin: "manifest-plugin",
        path: join(pluginRoot, "extra", "missing-skill"),
        component: "skills",
      },
      {
        type: "path-not-found",
        source: "marketplace:manifest-plugin",
        plugin: "manifest-plugin",
        path: join(pluginRoot, "extra", "missing-style.md"),
        component: "output-styles",
      },
    ]);
  });

  test("createPluginFromPath falls back to manifest settings and reports duplicate hooks in strict mode", async () => {
    const pluginRoot = await tempDir("agenc-plugin-duplicate-hooks-");
    await mkdir(join(pluginRoot, ".agenc-plugin"), { recursive: true });
    await mkdir(join(pluginRoot, "hooks"), { recursive: true });
    await writeFile(join(pluginRoot, "settings.json"), "{", "utf8");
    await writeFile(
      join(pluginRoot, "hooks", "hooks.json"),
      JSON.stringify({
        hooks: {
          Stop: [{ hooks: [{ type: "command", command: "echo stop" }] }],
        },
      }),
      "utf8",
    );
    await writeFile(
      join(pluginRoot, ".agenc-plugin", "plugin.json"),
      JSON.stringify({
        name: "duplicate-hooks",
        hooks: "./hooks/hooks.json",
        settings: { agent: "manifest-agent", model: "ignored" },
      }),
      "utf8",
    );

    const strict = await createPluginFromPath(
      pluginRoot,
      "marketplace:duplicate-hooks",
      true,
      "fallback",
    );
    expect(strict.plugin.settings).toEqual({ agent: "manifest-agent" });
    expect(strict.plugin.hooksConfig?.Stop).toHaveLength(1);
    expect(strict.errors).toHaveLength(1);
    expect(strict.errors[0]).toMatchObject({
      type: "hook-load-failed",
      source: "marketplace:duplicate-hooks",
      plugin: "duplicate-hooks",
      hookPath: join(pluginRoot, "hooks", "hooks.json"),
    });
    expect(strict.errors[0]?.reason).toContain("Duplicate hooks file detected");

    const loose = await createPluginFromPath(
      pluginRoot,
      "marketplace:duplicate-hooks",
      true,
      "fallback",
      false,
    );
    expect(loose.plugin.settings).toEqual({ agent: "manifest-agent" });
    expect(loose.errors).toEqual([]);
  });

  test("createPluginFromPath reports path-array command and hook loading errors", async () => {
    const pluginRoot = await tempDir("agenc-plugin-hook-errors-");
    await mkdir(join(pluginRoot, ".agenc-plugin"), { recursive: true });
    await mkdir(join(pluginRoot, "hooks"), { recursive: true });
    await writeFile(join(pluginRoot, "command.md"), "# command\n", "utf8");
    await writeFile(join(pluginRoot, "hooks", "hooks.json"), "{", "utf8");
    await writeFile(join(pluginRoot, "bad-hooks.json"), "{", "utf8");
    await writeFile(
      join(pluginRoot, ".agenc-plugin", "plugin.json"),
      JSON.stringify({
        name: "hook-errors",
        commands: ["./command.md", "./missing-command.md"],
        hooks: [
          "./missing-hooks.json",
          "./bad-hooks.json",
          { Stop: [{ hooks: [{ type: "command", command: "echo inline" }] }] },
        ],
        settings: { agent: 42, model: "ignored" },
      }),
      "utf8",
    );

    const { plugin, errors } = await createPluginFromPath(
      pluginRoot,
      "marketplace:hook-errors",
      true,
      "fallback",
    );

    expect(plugin).toMatchObject({
      name: "hook-errors",
      commandsPaths: [join(pluginRoot, "command.md")],
      hooksConfig: {
        Stop: [{ hooks: [{ type: "command", command: "echo inline" }] }],
      },
    });
    expect(plugin.settings).toBeUndefined();
    expect(errors).toHaveLength(4);
    expect(errors).toEqual([
      {
        type: "path-not-found",
        source: "marketplace:hook-errors",
        plugin: "hook-errors",
        path: join(pluginRoot, "missing-command.md"),
        component: "commands",
      },
      {
        type: "hook-load-failed",
        source: "marketplace:hook-errors",
        plugin: "hook-errors",
        hookPath: join(pluginRoot, "hooks", "hooks.json"),
        reason: expect.any(String),
      },
      {
        type: "path-not-found",
        source: "marketplace:hook-errors",
        plugin: "hook-errors",
        path: join(pluginRoot, "missing-hooks.json"),
        component: "hooks",
      },
      {
        type: "hook-load-failed",
        source: "marketplace:hook-errors",
        plugin: "hook-errors",
        hookPath: join(pluginRoot, "bad-hooks.json"),
        reason: expect.any(String),
      },
    ]);
  });

  test("cachePluginSettings merges enabled plugin settings and clearPluginCache drops them", () => {
    const first = {
      name: "first",
      manifest: { name: "first" },
      path: "/tmp/first",
      source: "first",
      enabled: true,
      settings: { model: "one", theme: "dark" },
    } as LoadedPlugin;
    const second = {
      name: "second",
      manifest: { name: "second" },
      path: "/tmp/second",
      source: "second",
      enabled: true,
      settings: { model: "two", statusLine: { type: "command", command: "echo ok" } },
    } as LoadedPlugin;

    cachePluginSettings([first, second]);
    expect(getPluginSettingsBase()).toEqual({
      model: "two",
      theme: "dark",
      statusLine: { type: "command", command: "echo ok" },
    });

    clearPluginCache("settings test");
    expect(getPluginSettingsBase()).toBeUndefined();
  });

  test("cachePluginSettings ignores plugins without settings", () => {
    cachePluginSettings([
      {
        name: "plain",
        manifest: { name: "plain" },
        path: "/tmp/plain",
        source: "plain",
        enabled: true,
      } as LoadedPlugin,
    ]);

    expect(getPluginSettingsBase()).toBeUndefined();
  });
});

describe("plugin loader orchestration", () => {
  test("loadAllPlugins loads session-only plugins, records missing inline paths, and caches settings", async () => {
    const configRoot = await tempDir("agenc-plugin-load-config-");
    const pluginRoot = await tempDir("agenc-plugin-inline-load-");
    const missingPluginRoot = join(pluginRoot, "..", "missing-inline");
    process.env.AGENC_CONFIG_DIR = configRoot;
    resetSettingsCache();

    await mkdir(join(pluginRoot, ".agenc-plugin"), { recursive: true });
    await mkdir(join(pluginRoot, "commands"), { recursive: true });
    await writeFile(join(pluginRoot, "commands", "hello.md"), "# hello\n", "utf8");
    await writeFile(
      join(pluginRoot, ".agenc-plugin", "plugin.json"),
      JSON.stringify({ name: "inline-loaded", description: "inline desc" }),
      "utf8",
    );
    await writeFile(join(pluginRoot, "settings.json"), JSON.stringify({ agent: "inline-agent" }), "utf8");

    setInlinePlugins([missingPluginRoot, pluginRoot]);

    const result = await loadAllPlugins();

    expect(result.enabled.map(plugin => plugin.name)).toEqual(["inline-loaded"]);
    expect(result.enabled[0]).toMatchObject({
      name: "inline-loaded",
      source: "inline-loaded@inline",
      repository: "inline-loaded@inline",
      enabled: true,
      commandsPath: join(pluginRoot, "commands"),
      settings: { agent: "inline-agent" },
    });
    expect(result.disabled).toEqual([]);
    expect(result.errors).toEqual([
      {
        type: "path-not-found",
        source: "inline[0]",
        path: missingPluginRoot,
        component: "commands",
      },
    ]);
    expect(getPluginSettingsBase()).toEqual({ agent: "inline-agent" });

    await expect(loadAllPluginsCacheOnly()).resolves.toEqual(result);
  });

  test("loadAllPluginsCacheOnly honors synchronous plugin install mode", async () => {
    const configRoot = await tempDir("agenc-plugin-load-sync-config-");
    const pluginRoot = await tempDir("agenc-plugin-inline-sync-");
    process.env.AGENC_CONFIG_DIR = configRoot;
    process.env.AGENC_SYNC_PLUGIN_INSTALL = "1";
    resetSettingsCache();

    await mkdir(join(pluginRoot, ".agenc-plugin"), { recursive: true });
    await writeFile(
      join(pluginRoot, ".agenc-plugin", "plugin.json"),
      JSON.stringify({ name: "sync-inline" }),
      "utf8",
    );
    setInlinePlugins([pluginRoot]);

    const result = await loadAllPluginsCacheOnly();

    expect(result.enabled.map(plugin => plugin.name)).toEqual(["sync-inline"]);
  });

  test("loadAllPluginsCacheOnly loads cached local marketplace plugins and reports missing marketplace components", async () => {
    await withPluginCacheDir(async cacheRoot => {
      const configRoot = await tempDir("agenc-plugin-market-config-");
      const marketplaceRoot = await tempDir("agenc-plugin-marketplace-");
      const pluginRoot = join(marketplaceRoot, "plugins", "market-plugin");
      process.env.AGENC_CONFIG_DIR = configRoot;
      resetSettingsCache();

      await mkdir(configRoot, { recursive: true });
      await writeFile(
        join(configRoot, "settings.json"),
        JSON.stringify({ enabledPlugins: { "market-plugin@test-market": true } }),
        "utf8",
      );

      await mkdir(join(cacheRoot), { recursive: true });
      await writeFile(
        join(cacheRoot, "known_marketplaces.json"),
        JSON.stringify({
          "test-market": {
            source: { source: "directory", path: marketplaceRoot },
            installLocation: marketplaceRoot,
            lastUpdated: "2026-06-03T00:00:00.000Z",
          },
        }),
        "utf8",
      );

      await mkdir(join(marketplaceRoot, ".agenc-plugin"), { recursive: true });
      await mkdir(pluginRoot, { recursive: true });
      await writeFile(join(pluginRoot, "command.md"), "# command\n", "utf8");
      await writeFile(join(pluginRoot, "agent.md"), "# agent\n", "utf8");
      await mkdir(join(pluginRoot, "skill"), { recursive: true });
      await writeFile(join(pluginRoot, "skill", "SKILL.md"), "# skill\n", "utf8");
      await writeFile(join(pluginRoot, "style.md"), "# style\n", "utf8");
      await writeFile(
        join(marketplaceRoot, ".agenc-plugin", "marketplace.json"),
        JSON.stringify({
          name: "test-market",
          owner: { name: "Tests" },
          plugins: [
            {
              name: "market-plugin",
              source: "./plugins/market-plugin",
              commands: {
                file: { source: "./command.md", description: "File command" },
                inline: { content: "# inline" },
                missing: { source: "./missing-command.md" },
              },
              agents: ["./agent.md", "./missing-agent.md"],
              skills: ["./skill", "./missing-skill"],
              outputStyles: ["./style.md", "./missing-style.md"],
              hooks: {
                Stop: [{ hooks: [{ type: "command", command: "echo stop" }] }],
              },
              strict: true,
            },
          ],
        }),
        "utf8",
      );

      const result = await loadAllPluginsCacheOnly();

      expect(result.enabled).toHaveLength(1);
      expect(result.enabled[0]).toMatchObject({
        name: "market-plugin",
        source: "market-plugin@test-market",
        enabled: true,
        commandsPaths: [join(pluginRoot, "command.md")],
        commandsMetadata: {
          file: { source: "./command.md", description: "File command" },
        },
        agentsPaths: [join(pluginRoot, "agent.md")],
        skillsPaths: [join(pluginRoot, "skill")],
        outputStylesPaths: [join(pluginRoot, "style.md")],
        hooksConfig: {
          Stop: [{ hooks: [{ type: "command", command: "echo stop" }] }],
        },
      });
      expect(result.disabled).toEqual([]);
      expect(result.errors).toEqual([
        {
          type: "path-not-found",
          source: "market-plugin@test-market",
          plugin: "market-plugin",
          path: join(pluginRoot, "missing-command.md"),
          component: "commands",
        },
        {
          type: "path-not-found",
          source: "market-plugin@test-market",
          plugin: "market-plugin",
          path: join(pluginRoot, "missing-agent.md"),
          component: "agents",
        },
        {
          type: "path-not-found",
          source: "market-plugin@test-market",
          plugin: "market-plugin",
          path: join(pluginRoot, "missing-skill"),
          component: "skills",
        },
        {
          type: "path-not-found",
          source: "market-plugin@test-market",
          plugin: "market-plugin",
          path: join(pluginRoot, "missing-style.md"),
          component: "output-styles",
        },
      ]);
    });
  });

  test("loadAllPluginsCacheOnly reports external marketplace plugins with no recorded install path", async () => {
    await withPluginCacheDir(async cacheRoot => {
      const configRoot = await tempDir("agenc-plugin-external-cache-config-");
      const marketplaceRoot = await tempDir("agenc-plugin-external-marketplace-");
      process.env.AGENC_CONFIG_DIR = configRoot;
      resetSettingsCache();

      await mkdir(configRoot, { recursive: true });
      await writeFile(
        join(configRoot, "settings.json"),
        JSON.stringify({ enabledPlugins: { "remote-plugin@test-market": true } }),
        "utf8",
      );
      await writeFile(
        join(cacheRoot, "known_marketplaces.json"),
        JSON.stringify({
          "test-market": {
            source: { source: "directory", path: marketplaceRoot },
            installLocation: marketplaceRoot,
            lastUpdated: "2026-06-03T00:00:00.000Z",
          },
        }),
        "utf8",
      );
      await mkdir(join(marketplaceRoot, ".agenc-plugin"), { recursive: true });
      await writeFile(
        join(marketplaceRoot, ".agenc-plugin", "marketplace.json"),
        JSON.stringify({
          name: "test-market",
          owner: { name: "Tests" },
          plugins: [
            {
              name: "remote-plugin",
              source: { source: "github", repo: "owner/repo" },
              version: "1.0.0",
            },
          ],
        }),
        "utf8",
      );

      const result = await loadAllPluginsCacheOnly();

      expect(result.enabled).toEqual([]);
      expect(result.disabled).toEqual([]);
      expect(result.errors).toEqual([
        {
          type: "plugin-cache-miss",
          source: "remote-plugin@test-market",
          plugin: "remote-plugin",
          installPath: "(not recorded)",
        },
      ]);
    });
  });

  test("loadAllPluginsCacheOnly reports external marketplace plugins with missing install paths", async () => {
    await withPluginCacheDir(async cacheRoot => {
      const configRoot = await tempDir("agenc-plugin-missing-install-config-");
      const marketplaceRoot = await tempDir("agenc-plugin-missing-install-marketplace-");
      const missingInstallPath = join(cacheRoot, "cache", "test-market", "remote-plugin", "missing");
      process.env.AGENC_CONFIG_DIR = configRoot;
      resetSettingsCache();
      clearInstalledPluginsCache();

      await mkdir(configRoot, { recursive: true });
      await writeFile(
        join(configRoot, "settings.json"),
        JSON.stringify({ enabledPlugins: { "remote-plugin@test-market": true } }),
        "utf8",
      );
      await writeFile(
        join(cacheRoot, "known_marketplaces.json"),
        JSON.stringify({
          "test-market": {
            source: { source: "directory", path: marketplaceRoot },
            installLocation: marketplaceRoot,
            lastUpdated: "2026-06-03T00:00:00.000Z",
          },
        }),
        "utf8",
      );
      await writeFile(
        join(cacheRoot, "installed_plugins.json"),
        JSON.stringify({
          version: 2,
          plugins: {
            "remote-plugin@test-market": [
              {
                scope: "user",
                installPath: missingInstallPath,
                version: "1.0.0",
                installedAt: "2026-06-03T00:00:00.000Z",
              },
            ],
          },
        }),
        "utf8",
      );
      await mkdir(join(marketplaceRoot, ".agenc-plugin"), { recursive: true });
      await writeFile(
        join(marketplaceRoot, ".agenc-plugin", "marketplace.json"),
        JSON.stringify({
          name: "test-market",
          owner: { name: "Tests" },
          plugins: [
            {
              name: "remote-plugin",
              source: { source: "github", repo: "owner/repo" },
              version: "1.0.0",
            },
          ],
        }),
        "utf8",
      );

      const result = await loadAllPluginsCacheOnly();

      expect(result.enabled).toEqual([]);
      expect(result.disabled).toEqual([]);
      expect(result.errors).toEqual([
        {
          type: "plugin-cache-miss",
          source: "remote-plugin@test-market",
          plugin: "remote-plugin",
          installPath: missingInstallPath,
        },
      ]);
    });
  });

  test("loadAllPlugins loads local marketplace plugins through versioned cache and supplements manifest components", async () => {
    await withPluginCacheDir(async cacheRoot => {
      const configRoot = await tempDir("agenc-plugin-full-market-config-");
      const marketplaceRoot = await tempDir("agenc-plugin-full-marketplace-");
      const pluginRoot = join(marketplaceRoot, "plugins", "manifest-market");
      process.env.AGENC_CONFIG_DIR = configRoot;
      resetSettingsCache();

      await mkdir(configRoot, { recursive: true });
      await writeFile(
        join(configRoot, "settings.json"),
        JSON.stringify({ enabledPlugins: { "manifest-market@test-market": true } }),
        "utf8",
      );
      await writeFile(
        join(cacheRoot, "known_marketplaces.json"),
        JSON.stringify({
          "test-market": {
            source: { source: "directory", path: marketplaceRoot },
            installLocation: marketplaceRoot,
            lastUpdated: "2026-06-03T00:00:00.000Z",
          },
        }),
        "utf8",
      );

      await mkdir(join(marketplaceRoot, ".agenc-plugin"), { recursive: true });
      await mkdir(join(pluginRoot, ".agenc-plugin"), { recursive: true });
      await mkdir(join(pluginRoot, "manifest-skill"), { recursive: true });
      await mkdir(join(pluginRoot, "entry-skill"), { recursive: true });
      await writeFile(join(pluginRoot, "manifest-command.md"), "# manifest\n", "utf8");
      await writeFile(join(pluginRoot, "entry-command.md"), "# entry\n", "utf8");
      await writeFile(join(pluginRoot, "manifest-agent.md"), "# manifest agent\n", "utf8");
      await writeFile(join(pluginRoot, "entry-agent.md"), "# entry agent\n", "utf8");
      await writeFile(join(pluginRoot, "manifest-skill", "SKILL.md"), "# manifest skill\n", "utf8");
      await writeFile(join(pluginRoot, "entry-skill", "SKILL.md"), "# entry skill\n", "utf8");
      await writeFile(join(pluginRoot, "manifest-style.md"), "# manifest style\n", "utf8");
      await writeFile(join(pluginRoot, "entry-style.md"), "# entry style\n", "utf8");
      await writeFile(
        join(pluginRoot, ".agenc-plugin", "plugin.json"),
        JSON.stringify({
          name: "manifest-market",
          version: "1.0.0",
          commands: {
            manifest: { source: "./manifest-command.md", description: "Manifest command" },
          },
          agents: "./manifest-agent.md",
          skills: "./manifest-skill",
          outputStyles: "./manifest-style.md",
          hooks: {
            Stop: [{ hooks: [{ type: "command", command: "echo manifest" }] }],
          },
        }),
        "utf8",
      );
      await writeFile(
        join(marketplaceRoot, ".agenc-plugin", "marketplace.json"),
        JSON.stringify({
          name: "test-market",
          owner: { name: "Tests" },
          plugins: [
            {
              name: "manifest-market",
              source: "./plugins/manifest-market",
              commands: {
                entry: { source: "./entry-command.md", description: "Entry command" },
              },
              agents: "./entry-agent.md",
              skills: "./entry-skill",
              outputStyles: "./entry-style.md",
              hooks: {
                SessionStart: [{ hooks: [{ type: "command", command: "echo entry" }] }],
              },
              strict: true,
            },
          ],
        }),
        "utf8",
      );

      const result = await loadAllPlugins();
      const cachedPluginPath = getVersionedCachePath("manifest-market@test-market", "1.0.0");

      expect(result.enabled).toHaveLength(1);
      expect(result.enabled[0]).toMatchObject({
        name: "manifest-market",
        source: "manifest-market@test-market",
        path: cachedPluginPath,
        enabled: true,
        commandsPaths: [
          join(cachedPluginPath, "manifest-command.md"),
          join(cachedPluginPath, "entry-command.md"),
        ],
        commandsMetadata: {
          manifest: { source: "./manifest-command.md", description: "Manifest command" },
          entry: { source: "./entry-command.md", description: "Entry command" },
        },
        agentsPaths: [
          join(cachedPluginPath, "manifest-agent.md"),
          join(cachedPluginPath, "entry-agent.md"),
        ],
        skillsPaths: [
          join(cachedPluginPath, "manifest-skill"),
          join(cachedPluginPath, "entry-skill"),
        ],
        outputStylesPaths: [
          join(cachedPluginPath, "manifest-style.md"),
          join(cachedPluginPath, "entry-style.md"),
        ],
        hooksConfig: {
          Stop: [{ hooks: [{ type: "command", command: "echo manifest" }] }],
          SessionStart: [{ hooks: [{ type: "command", command: "echo entry" }] }],
        },
      });
      expect(result.disabled).toEqual([]);
      expect(result.errors).toEqual([]);
      expect(await readFile(join(cachedPluginPath, "entry-command.md"), "utf8")).toBe("# entry\n");
    });
  });

  test("loadAllPluginsCacheOnly rejects non-strict marketplace component conflicts with plugin manifests", async () => {
    await withPluginCacheDir(async cacheRoot => {
      const configRoot = await tempDir("agenc-plugin-conflict-config-");
      const marketplaceRoot = await tempDir("agenc-plugin-conflict-marketplace-");
      const pluginRoot = join(marketplaceRoot, "plugins", "conflict-plugin");
      process.env.AGENC_CONFIG_DIR = configRoot;
      resetSettingsCache();

      await mkdir(configRoot, { recursive: true });
      await writeFile(
        join(configRoot, "settings.json"),
        JSON.stringify({ enabledPlugins: { "conflict-plugin@test-market": true } }),
        "utf8",
      );
      await writeFile(
        join(cacheRoot, "known_marketplaces.json"),
        JSON.stringify({
          "test-market": {
            source: { source: "directory", path: marketplaceRoot },
            installLocation: marketplaceRoot,
            lastUpdated: "2026-06-03T00:00:00.000Z",
          },
        }),
        "utf8",
      );
      await mkdir(join(marketplaceRoot, ".agenc-plugin"), { recursive: true });
      await mkdir(join(pluginRoot, ".agenc-plugin"), { recursive: true });
      await writeFile(join(pluginRoot, "entry-command.md"), "# entry\n", "utf8");
      await writeFile(
        join(pluginRoot, ".agenc-plugin", "plugin.json"),
        JSON.stringify({ name: "conflict-plugin" }),
        "utf8",
      );
      await writeFile(
        join(marketplaceRoot, ".agenc-plugin", "marketplace.json"),
        JSON.stringify({
          name: "test-market",
          owner: { name: "Tests" },
          plugins: [
            {
              name: "conflict-plugin",
              source: "./plugins/conflict-plugin",
              commands: "./entry-command.md",
              strict: false,
            },
          ],
        }),
        "utf8",
      );

      const result = await loadAllPluginsCacheOnly();

      expect(result.enabled).toEqual([]);
      expect(result.disabled).toEqual([]);
      expect(result.errors).toEqual([
        {
          type: "generic-error",
          source: "conflict-plugin@test-market",
          error:
            "Plugin conflict-plugin has conflicting manifests: both plugin.json and marketplace entry specify components. Set strict: true in marketplace entry or remove component specs from one location.",
        },
      ]);
    });
  });

  test("loadAllPlugins loads external marketplace plugins from existing versioned cache", async () => {
    await withPluginCacheDir(async cacheRoot => {
      const configRoot = await tempDir("agenc-plugin-external-full-config-");
      const marketplaceRoot = await tempDir("agenc-plugin-external-full-marketplace-");
      const sha = "1234567890abcdef1234567890abcdef12345678";
      const cachedPluginPath = getVersionedCachePath("external-cached@test-market", "1.2.3");
      process.env.AGENC_CONFIG_DIR = configRoot;
      resetSettingsCache();

      await mkdir(configRoot, { recursive: true });
      await writeFile(
        join(configRoot, "settings.json"),
        JSON.stringify({ enabledPlugins: { "external-cached@test-market": true } }),
        "utf8",
      );
      await writeFile(
        join(cacheRoot, "known_marketplaces.json"),
        JSON.stringify({
          "test-market": {
            source: { source: "directory", path: marketplaceRoot },
            installLocation: marketplaceRoot,
            lastUpdated: "2026-06-03T00:00:00.000Z",
          },
        }),
        "utf8",
      );
      await mkdir(join(marketplaceRoot, ".agenc-plugin"), { recursive: true });
      await writeFile(
        join(marketplaceRoot, ".agenc-plugin", "marketplace.json"),
        JSON.stringify({
          name: "test-market",
          owner: { name: "Tests" },
          plugins: [
            {
              name: "external-cached",
              source: { source: "github", repo: "owner/repo", sha },
              version: "1.2.3",
            },
          ],
        }),
        "utf8",
      );
      await mkdir(join(cachedPluginPath, ".agenc-plugin"), { recursive: true });
      await writeFile(
        join(cachedPluginPath, ".agenc-plugin", "plugin.json"),
        JSON.stringify({ name: "external-cached", version: "1.2.3" }),
        "utf8",
      );

      const result = await loadAllPlugins();

      expect(result.enabled).toHaveLength(1);
      expect(result.enabled[0]).toMatchObject({
        name: "external-cached",
        source: "external-cached@test-market",
        path: cachedPluginPath,
        sha,
        enabled: true,
      });
      expect(result.disabled).toEqual([]);
      expect(result.errors).toEqual([]);
    });
  });

  test("loadAllPlugins handles missing and uncached local marketplace sources", async () => {
    await withPluginCacheDir(async cacheRoot => {
      const configRoot = await tempDir("agenc-plugin-local-edge-config-");
      const marketplaceRoot = await tempDir("agenc-plugin-local-edge-marketplace-");
      const emptyPluginRoot = join(marketplaceRoot, "plugins", "empty-local");
      process.env.AGENC_CONFIG_DIR = configRoot;
      resetSettingsCache();

      await mkdir(configRoot, { recursive: true });
      await writeFile(
        join(configRoot, "settings.json"),
        JSON.stringify({
          enabledPlugins: {
            "missing-local@test-market": true,
            "empty-local@test-market": true,
          },
        }),
        "utf8",
      );
      await writeFile(
        join(cacheRoot, "known_marketplaces.json"),
        JSON.stringify({
          "test-market": {
            source: { source: "directory", path: marketplaceRoot },
            installLocation: marketplaceRoot,
            lastUpdated: "2026-06-03T00:00:00.000Z",
          },
        }),
        "utf8",
      );
      await mkdir(join(marketplaceRoot, ".agenc-plugin"), { recursive: true });
      await mkdir(emptyPluginRoot, { recursive: true });
      await writeFile(
        join(marketplaceRoot, ".agenc-plugin", "marketplace.json"),
        JSON.stringify({
          name: "test-market",
          owner: { name: "Tests" },
          plugins: [
            {
              name: "missing-local",
              source: "./plugins/missing-local",
              version: "1.0.0",
            },
            {
              name: "empty-local",
              source: "./plugins/empty-local",
              version: "1.0.0",
            },
          ],
        }),
        "utf8",
      );

      const result = await loadAllPlugins();

      expect(result.enabled).toHaveLength(1);
      expect(result.enabled[0]).toMatchObject({
        name: "empty-local",
        source: "empty-local@test-market",
        path: emptyPluginRoot,
        enabled: true,
      });
      expect(result.disabled).toEqual([]);
      expect(result.errors).toEqual([
        {
          type: "generic-error",
          source: "missing-local@test-market",
          error: `Plugin directory not found at path: ${join(marketplaceRoot, "plugins", "missing-local")}. Check that the marketplace entry has the correct path.`,
        },
      ]);
    });
  });

  test("loadAllPlugins downloads uncached git-subdir marketplace plugins and reports external cache failures", async () => {
    await withPluginCacheDir(async cacheRoot => {
      const configRoot = await tempDir("agenc-plugin-external-download-config-");
      const marketplaceRoot = await tempDir("agenc-plugin-external-download-marketplace-");
      const repoRoot = await tempDir("agenc-plugin-external-download-repo-");
      process.env.AGENC_CONFIG_DIR = configRoot;
      resetSettingsCache();

      await mkdir(join(repoRoot, "plugins", "demo", ".agenc-plugin"), { recursive: true });
      await writeFile(join(repoRoot, "plugins", "demo", "command.md"), "# downloaded\n", "utf8");
      await writeFile(
        join(repoRoot, "plugins", "demo", ".agenc-plugin", "plugin.json"),
        JSON.stringify({ name: "git-subdir-market" }),
        "utf8",
      );
      await git(["init"], repoRoot);
      await git(["add", "."], repoRoot);
      await git(
        ["-c", "user.name=AgenC Test", "-c", "user.email=test@example.com", "commit", "-m", "init"],
        repoRoot,
      );

      await mkdir(configRoot, { recursive: true });
      await writeFile(
        join(configRoot, "settings.json"),
        JSON.stringify({
          enabledPlugins: {
            "git-subdir-market@test-market": true,
            "broken-remote@test-market": true,
          },
        }),
        "utf8",
      );
      await writeFile(
        join(cacheRoot, "known_marketplaces.json"),
        JSON.stringify({
          "test-market": {
            source: { source: "directory", path: marketplaceRoot },
            installLocation: marketplaceRoot,
            lastUpdated: "2026-06-03T00:00:00.000Z",
          },
        }),
        "utf8",
      );
      await mkdir(join(marketplaceRoot, ".agenc-plugin"), { recursive: true });
      await writeFile(
        join(marketplaceRoot, ".agenc-plugin", "marketplace.json"),
        JSON.stringify({
          name: "test-market",
          owner: { name: "Tests" },
          plugins: [
            {
              name: "git-subdir-market",
              source: {
                source: "git-subdir",
                url: pathToFileURL(repoRoot).href,
                path: "plugins/demo",
              },
            },
            {
              name: "broken-remote",
              source: { source: "url", url: "file:///definitely/missing/repo" },
            },
          ],
        }),
        "utf8",
      );

      const result = await loadAllPlugins();

      expect(result.enabled).toHaveLength(1);
      expect(result.enabled[0]).toMatchObject({
        name: "git-subdir-market",
        source: "git-subdir-market@test-market",
        enabled: true,
      });
      expect(result.enabled[0]?.path).toContain(join(cacheRoot, "cache", "test-market", "git-subdir-market"));
      expect(await readFile(join(result.enabled[0]!.path, "command.md"), "utf8")).toBe("# downloaded\n");
      expect(result.disabled).toEqual([]);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toMatchObject({
        type: "generic-error",
        source: "broken-remote@test-market",
      });
      expect(result.errors[0]?.error).toContain("Failed to download/cache plugin broken-remote");
    });
  });

  test("loadAllPluginsCacheOnly supports no-manifest path commands and reports missing catalogs", async () => {
    await withPluginCacheDir(async cacheRoot => {
      const configRoot = await tempDir("agenc-plugin-path-command-config-");
      const marketplaceRoot = await tempDir("agenc-plugin-path-command-marketplace-");
      const pluginRoot = join(marketplaceRoot, "plugins", "path-command");
      process.env.AGENC_CONFIG_DIR = configRoot;
      resetSettingsCache();

      await mkdir(configRoot, { recursive: true });
      await writeFile(
        join(configRoot, "settings.json"),
        JSON.stringify({
          enabledPlugins: {
            "path-command@test-market": true,
            "missing-catalog@missing-market": true,
          },
        }),
        "utf8",
      );
      await writeFile(
        join(cacheRoot, "known_marketplaces.json"),
        JSON.stringify({
          "test-market": {
            source: { source: "directory", path: marketplaceRoot },
            installLocation: marketplaceRoot,
            lastUpdated: "2026-06-03T00:00:00.000Z",
          },
          "missing-market": {
            source: { source: "directory", path: join(marketplaceRoot, "missing-market") },
            installLocation: join(marketplaceRoot, "missing-market"),
            lastUpdated: "2026-06-03T00:00:00.000Z",
          },
        }),
        "utf8",
      );
      await mkdir(join(marketplaceRoot, ".agenc-plugin"), { recursive: true });
      await mkdir(pluginRoot, { recursive: true });
      await writeFile(join(pluginRoot, "command.md"), "# path command\n", "utf8");
      await writeFile(
        join(marketplaceRoot, ".agenc-plugin", "marketplace.json"),
        JSON.stringify({
          name: "test-market",
          owner: { name: "Tests" },
          plugins: [
            {
              name: "path-command",
              source: "./plugins/path-command",
              commands: ["./command.md", "./missing-command.md"],
            },
          ],
        }),
        "utf8",
      );

      const result = await loadAllPluginsCacheOnly();

      expect(result.enabled).toHaveLength(1);
      expect(result.enabled[0]).toMatchObject({
        name: "path-command",
        commandsPaths: [join(pluginRoot, "command.md")],
      });
      expect(result.disabled).toEqual([]);
      expect(result.errors).toHaveLength(2);
      expect(result.errors).toContainEqual({
        type: "plugin-not-found",
        source: "missing-catalog@missing-market",
        pluginId: "missing-catalog",
        marketplace: "missing-market",
      });
      expect(result.errors).toContainEqual({
        type: "path-not-found",
        source: "path-command@test-market",
        plugin: "path-command",
        path: join(pluginRoot, "missing-command.md"),
        component: "commands",
      });
    });
  });
});
