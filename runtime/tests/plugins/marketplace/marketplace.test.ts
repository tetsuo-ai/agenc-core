import { mkdtemp, mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  addMarketplaceOp,
  findInstallableMarketplacePlugin,
  listMarketplaces,
  loadMarketplace,
  marketplaceIndexPath,
  marketplaceInstalledPath,
  marketplaceStoreRoot,
  normalizeSparsePath,
  readMarketplaceIndex,
  removeMarketplaceOp,
  upgradeMarketplaceOp,
  type Fetcher,
} from "./marketplace.js";
import { parseMarketplaceInput } from "./parseMarketplaceInput.js";
import { validateMarketplaceManifest } from "../validation.js";

async function tempRuntime(): Promise<{
  readonly root: string;
  readonly agencHome: string;
  readonly pluginStorageRoot: string;
  readonly workspaceRoot: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "agenc-marketplace-"));
  const agencHome = join(root, "home");
  const pluginStorageRoot = join(root, "plugin-storage");
  const workspaceRoot = join(root, "workspace");
  await mkdir(agencHome, { recursive: true });
  await mkdir(pluginStorageRoot, { recursive: true });
  await mkdir(workspaceRoot, { recursive: true });
  return { root, agencHome, pluginStorageRoot, workspaceRoot };
}

async function writePlugin(root: string, name: string): Promise<string> {
  const pluginRoot = join(root, name);
  await mkdir(join(pluginRoot, ".agenc-plugin"), { recursive: true });
  await writeFile(
    join(pluginRoot, ".agenc-plugin", "plugin.json"),
    `${JSON.stringify({
      name,
      version: "1.0.0",
      description: "Test plugin",
      commands: "./commands",
    }, null, 2)}\n`,
  );
  await mkdir(join(pluginRoot, "commands"), { recursive: true });
  await writeFile(join(pluginRoot, "commands", "hello.md"), "# Hello\n");
  return pluginRoot;
}

async function writeMarketplace(root: string, name: string): Promise<string> {
  await writePlugin(root, "alpha");
  await mkdir(join(root, ".agenc-plugin"), { recursive: true });
  await writeFile(
    marketplaceManifestPath(root),
    `${JSON.stringify({
      metadata: {
        name,
        displayName: "Team Marketplace",
      },
      plugins: [{
        name: "alpha",
        source: "./alpha",
        category: "productivity",
        policy: {
          installation: "AVAILABLE",
          authentication: "ON_USE",
        },
      }],
    }, null, 2)}\n`,
  );
  return root;
}

function marketplaceManifestPath(root: string): string {
  return join(root, ".agenc-plugin", "marketplace.json");
}

describe("plugin marketplace runtime", () => {
  it("isolates same-home operations by explicit plugin storage root without fallback", async () => {
    const { agencHome, root, workspaceRoot } = await tempRuntime();
    const pluginStorageRootA = join(root, "plugin-storage-a");
    const pluginStorageRootB = join(root, "plugin-storage-b");
    const marketplaceRoot = await writeMarketplace(
      join(workspaceRoot, "isolated-marketplace"),
      "isolated",
    );
    const env = {
      AGENC_HOME: agencHome,
      HOME: join(root, "platform-home"),
    };

    await Promise.all([
      addMarketplaceOp({
        pluginStorageRoot: pluginStorageRootA,
        workspaceRoot,
        source: marketplaceRoot,
        env,
      }),
      addMarketplaceOp({
        pluginStorageRoot: pluginStorageRootB,
        workspaceRoot,
        source: marketplaceRoot,
        env,
      }),
    ]);

    expect(marketplaceStoreRoot({ pluginStorageRoot: pluginStorageRootA }))
      .toBe(join(pluginStorageRootA, "marketplaces"));
    expect(marketplaceStoreRoot({ pluginStorageRoot: pluginStorageRootB }))
      .toBe(join(pluginStorageRootB, "marketplaces"));
    expect(marketplaceIndexPath({ pluginStorageRoot: pluginStorageRootA }))
      .toBe(join(pluginStorageRootA, "known_marketplaces.json"));
    expect(marketplaceIndexPath({ pluginStorageRoot: pluginStorageRootB }))
      .toBe(join(pluginStorageRootB, "known_marketplaces.json"));
    expect(
      marketplaceInstalledPath("isolated", {
        pluginStorageRoot: pluginStorageRootA,
      }),
    ).not.toBe(
      marketplaceInstalledPath("isolated", {
        pluginStorageRoot: pluginStorageRootB,
      }),
    );

    const [indexA, indexB] = await Promise.all([
      readMarketplaceIndex({ pluginStorageRoot: pluginStorageRootA }),
      readMarketplaceIndex({ pluginStorageRoot: pluginStorageRootB }),
    ]);
    expect(indexA.marketplaces.isolated?.installedPath)
      .toBe(join(pluginStorageRootA, "marketplaces", "isolated"));
    expect(indexB.marketplaces.isolated?.installedPath)
      .toBe(join(pluginStorageRootB, "marketplaces", "isolated"));
    await expect(stat(join(agencHome, "plugins")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("materializes local marketplaces, indexes them, and resolves installable plugin entries", async () => {
    const { pluginStorageRoot, workspaceRoot } = await tempRuntime();
    const marketplaceRoot = await writeMarketplace(join(workspaceRoot, "team-marketplace"), "team");

    const result = await addMarketplaceOp({
      pluginStorageRoot,
      workspaceRoot,
      source: marketplaceRoot,
      now: () => new Date("2026-05-05T00:00:00.000Z"),
    });

    expect(result.replaced).toBe(false);
    expect(result.marketplace.name).toBe("team");
    expect(result.marketplace.installedPath).toBe(
      marketplaceInstalledPath("team", { pluginStorageRoot }),
    );
    expect(
      JSON.parse(
        await readFile(marketplaceIndexPath({ pluginStorageRoot }), "utf8"),
      ),
    )
      .toMatchObject({
        team: {
          source: { source: "directory", path: marketplaceRoot },
          installLocation: marketplaceInstalledPath("team", {
            pluginStorageRoot,
          }),
          manifestPath: result.marketplace.manifestPath,
        },
      });

    const marketplace = await loadMarketplace(result.marketplace.manifestPath);
    expect(marketplace.plugins.map((plugin) => plugin.name)).toEqual(["alpha"]);
    const plugin = await findInstallableMarketplacePlugin(result.marketplace.manifestPath, "alpha");
    expect(plugin).toMatchObject({
      pluginId: "alpha@team",
      policy: {
        installation: "AVAILABLE",
        authentication: "ON_USE",
      },
      interface: {
        category: "productivity",
      },
    });
  });

  it("rejects duplicate object keys in canonical marketplace manifests", async () => {
    const { workspaceRoot } = await tempRuntime();
    const marketplaceRoot = join(workspaceRoot, "duplicate-marketplace");
    await mkdir(join(marketplaceRoot, ".agenc-plugin"), { recursive: true });
    const manifestPath = marketplaceManifestPath(marketplaceRoot);
    await writeFile(
      manifestPath,
      '{"metadata":{"name":"team","name":"shadow"},"plugins":[]}',
      "utf8",
    );

    await expect(loadMarketplace(manifestPath))
      .rejects.toThrow("duplicate object keys");
  });

  it("rejects every reserved plugin storage name during catalog load and validation", async () => {
    const { workspaceRoot } = await tempRuntime();
    const reservedNames = [
      "build",
      "cache",
      "coverage",
      "data",
      "dist",
      "marketplaces",
      "node_modules",
    ] as const;

    for (const name of reservedNames) {
      const marketplaceRoot = join(workspaceRoot, `reserved-${name}`);
      await mkdir(join(marketplaceRoot, ".agenc-plugin"), { recursive: true });
      const manifestPath = marketplaceManifestPath(marketplaceRoot);
      await writeFile(
        manifestPath,
        JSON.stringify({
          metadata: { name: "reserved-test" },
          plugins: [{ name: name.toUpperCase(), source: "./plugin" }],
        }),
      );

      await expect(loadMarketplace(manifestPath), name)
        .rejects.toThrow("reserved for plugin storage");
      const validation = await validateMarketplaceManifest(manifestPath);
      expect(validation.success, name).toBe(false);
      expect(validation.errors, name).toEqual([
        expect.objectContaining({
          path: "plugins[0].name",
          message: expect.stringContaining("reserved for plugin storage"),
        }),
      ]);
    }
  });

  it.each(["Alpha", "alpha/beta", "alpha:beta"])(
    "rejects non-canonical marketplace plugin name %s during load, add, and validation",
    async (name) => {
      const { pluginStorageRoot, workspaceRoot } = await tempRuntime();
      const marketplaceRoot = join(workspaceRoot, "invalid-plugin-name");
      await mkdir(join(marketplaceRoot, ".agenc-plugin"), { recursive: true });
      const manifestPath = marketplaceManifestPath(marketplaceRoot);
      await writeFile(
        manifestPath,
        JSON.stringify({
          metadata: { name: "invalid-name-test" },
          plugins: [{ name, source: "./plugin" }],
        }),
      );

      await expect(loadMarketplace(manifestPath))
        .rejects.toThrow("lowercase canonical identifier");
      await expect(addMarketplaceOp({
        pluginStorageRoot,
        workspaceRoot,
        source: marketplaceRoot,
      })).rejects.toThrow("lowercase canonical identifier");
      const validation = await validateMarketplaceManifest(manifestPath);
      expect(validation.success).toBe(false);
      expect(validation.errors).toContainEqual(
        expect.objectContaining({
          path: "plugins[0].name",
          message: expect.stringContaining("lowercase canonical identifier"),
        }),
      );
    },
  );

  it("rejects plugin names that collide at the canonical storage path", async () => {
    const { workspaceRoot } = await tempRuntime();
    const marketplaceRoot = join(workspaceRoot, "storage-name-collision");
    await mkdir(join(marketplaceRoot, ".agenc-plugin"), { recursive: true });
    const manifestPath = marketplaceManifestPath(marketplaceRoot);
    await writeFile(
      manifestPath,
      JSON.stringify({
        metadata: { name: "collision-test" },
        plugins: [
          { name: "alpha.beta", source: "./alpha" },
          { name: "alpha-beta", source: "./beta" },
        ],
      }),
    );

    await expect(loadMarketplace(manifestPath))
      .rejects.toThrow("same canonical storage name");
    const validation = await validateMarketplaceManifest(manifestPath);
    expect(validation.errors).toContainEqual(
      expect.objectContaining({
        path: "plugins[1].name",
        message: expect.stringContaining("same canonical storage name"),
      }),
    );
  });

  it("preserves configured marketplace names when manifest metadata differs", async () => {
    const { pluginStorageRoot, workspaceRoot } = await tempRuntime();
    const marketplaceRoot = await writeMarketplace(join(workspaceRoot, "team-marketplace"), "upstream");

    const result = await addMarketplaceOp({
      pluginStorageRoot,
      workspaceRoot,
      source: marketplaceRoot,
      name: "team",
      now: () => new Date("2026-05-05T00:00:00.000Z"),
    });

    expect(result.marketplace.name).toBe("team");

    const plugin = await findInstallableMarketplacePlugin(
      result.marketplace.manifestPath,
      "alpha",
      undefined,
      result.marketplace.name,
    );
    expect(plugin.pluginId).toBe("alpha@team");
    expect(plugin.marketplaceName).toBe("team");
  });

  it.each(["Team", "1team"])(
    "rejects non-canonical marketplace name %s during add",
    async (name) => {
      const { pluginStorageRoot, workspaceRoot } = await tempRuntime();
      const marketplaceRoot = await writeMarketplace(
        join(workspaceRoot, `invalid-marketplace-${name}`),
        "upstream",
      );

      await expect(addMarketplaceOp({
        pluginStorageRoot,
        workspaceRoot,
        source: marketplaceRoot,
        name,
      })).rejects.toThrow("lowercase canonical segment");
      await expect(readMarketplaceIndex({
        pluginStorageRoot,
        workspaceRoot,
      })).resolves.toEqual({ version: 1, marketplaces: {} });
    },
  );

  it("fails closed on an invalid marketplace inventory instead of trusting alternate fields", async () => {
    const { pluginStorageRoot, root, workspaceRoot } = await tempRuntime();
    const marketplaceRoot = await writeMarketplace(join(workspaceRoot, "team-marketplace"), "team");
    await addMarketplaceOp({
      pluginStorageRoot,
      workspaceRoot,
      source: marketplaceRoot,
    });
    const outside = join(root, "outside");
    await mkdir(outside, { recursive: true });
    const index = await readMarketplaceIndex({ pluginStorageRoot });
    await writeFile(
      marketplaceIndexPath({ pluginStorageRoot }),
      `${JSON.stringify({
        version: 1,
        marketplaces: {
          team: {
            ...index.marketplaces.team,
            installedPath: outside,
            manifestPath: join(outside, "marketplace.json"),
          },
        },
      }, null, 2)}\n`,
    );

    await expect(removeMarketplaceOp({ pluginStorageRoot, name: "team" }))
      .rejects.toThrow("Marketplace inventory is invalid");

    expect(
      (
        await stat(marketplaceInstalledPath("team", { pluginStorageRoot }))
      ).isDirectory(),
    )
      .toBe(true);
    expect((await stat(outside)).isDirectory()).toBe(true);
  });

  it("parses marketplace inputs and rejects unsafe sparse checkout paths", async () => {
    const { workspaceRoot } = await tempRuntime();
    const marketplaceRoot = await writeMarketplace(join(workspaceRoot, "local-marketplace"), "local-team");

    await expect(parseMarketplaceInput(marketplaceRoot)).resolves.toEqual({
      ok: true,
      source: { source: "directory", path: marketplaceRoot },
    });
    await expect(parseMarketplaceInput("agenc-org/plugins#stable")).resolves.toEqual({
      ok: true,
      source: { source: "github", repo: "agenc-org/plugins", ref: "stable" },
    });
    await expect(parseMarketplaceInput("https://github.com/agenc-org/plugins/tree/stable/marketplaces/team")).resolves.toEqual({
      ok: true,
      source: {
        source: "github",
        repo: "agenc-org/plugins",
        ref: "stable",
        path: "marketplaces/team",
      },
    });
    await expect(parseMarketplaceInput("https://github.com/agenc-org/plugins/tree/feature/team/marketplaces/internal")).resolves.toEqual({
      ok: true,
      source: {
        source: "github",
        repo: "agenc-org/plugins",
        ref: "feature/team",
        path: "marketplaces/internal",
      },
    });
    await expect(parseMarketplaceInput("owner/repo/extra")).resolves.toEqual({
      ok: false,
      unrecognized: true,
    });
    await expect(parseMarketplaceInput("http://agenc.tech/marketplace.json")).resolves.toEqual({
      ok: false,
      error: "Marketplace URL must use HTTPS or loopback HTTP",
    });
    await expect(parseMarketplaceInput("http://agenc.tech/plugins.git")).resolves.toEqual({
      ok: false,
      error: "Marketplace URL must use HTTPS or loopback HTTP",
    });
    expect(normalizeSparsePath("marketplaces/team")).toBe("marketplaces/team");
    expect(() => normalizeSparsePath("../team")).toThrow("--sparse must not contain");
  });

  it("normalizes addMarketplace string inputs through the parser grammar", async () => {
    const { pluginStorageRoot, workspaceRoot } = await tempRuntime();
    const cloneCalls: string[][] = [];

    const result = await addMarketplaceOp({
      pluginStorageRoot,
      workspaceRoot,
      env: {},
      source: "agenc-org/plugins#stable",
      runProcess: async (_command, args) => {
        if (args.includes("clone")) {
          cloneCalls.push([...args]);
          const target = args.at(-1);
          if (target === undefined) throw new Error("missing clone target");
          await writeMarketplace(target, "team");
          return { stdout: "", stderr: "" };
        }
        if (args.includes("rev-parse")) {
          return { stdout: "abc123\n", stderr: "" };
        }
        return { stdout: "", stderr: "" };
      },
    });

    expect(result.marketplace.sourceDescriptor).toEqual({
      source: "github",
      repo: "agenc-org/plugins",
      ref: "stable",
    });
    expect(cloneCalls[0]).toContain("https://github.com/agenc-org/plugins.git");
    expect(cloneCalls[0]).toContain("--branch");
    expect(cloneCalls[0]).toContain("stable");
    const repositorySeparator = cloneCalls[0]!.indexOf("--");
    expect(repositorySeparator).toBeGreaterThan(-1);
    expect(cloneCalls[0]![repositorySeparator + 1]).toBe("https://github.com/agenc-org/plugins.git");
  });

  it("requires safe URL marketplace transport and bounded manifest downloads", async () => {
    const { pluginStorageRoot, workspaceRoot } = await tempRuntime();
    const fetcher: Fetcher = async () => {
      throw new Error("fetch should not run for unsafe URL");
    };

    await expect(addMarketplaceOp({
      pluginStorageRoot,
      workspaceRoot,
      source: { source: "url", url: "http://agenc.tech/marketplace.json" },
      fetcher,
    })).rejects.toThrow("must use HTTPS or loopback HTTP");
    await expect(addMarketplaceOp({
      pluginStorageRoot,
      workspaceRoot,
      source: "http://agenc.tech/plugins.git",
      runProcess: async () => {
        throw new Error("git should not run for unsafe HTTP git sources");
      },
    })).rejects.toThrow("must use HTTPS or loopback HTTP");

    const largeBody = "x".repeat(1024 * 1024 + 1);
    await expect(addMarketplaceOp({
      pluginStorageRoot,
      workspaceRoot,
      source: { source: "url", url: "http://127.0.0.1/marketplace.json" },
      fetcher: async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => largeBody,
        arrayBuffer: async () => exactArrayBuffer(Buffer.from(largeBody, "utf8")),
      }),
    })).rejects.toThrow("exceeded maximum size");
  });

  it("does not persist URL marketplace headers or credential-bearing URLs", async () => {
    const { pluginStorageRoot, workspaceRoot } = await tempRuntime();

    await addMarketplaceOp({
      pluginStorageRoot,
      workspaceRoot,
      source: {
        source: "url",
        url: "https://agenc.tech/marketplace.json?token=secret-token",
        headers: {
          Authorization: "Bearer secret-token",
          "X-API-Key": "secret-token",
        },
      },
      fetcher: async () => jsonResponse({
        metadata: { name: "url-team" },
        plugins: [],
      }),
    });

    const rawIndex = await readFile(
      marketplaceIndexPath({ pluginStorageRoot }),
      "utf8",
    );
    expect(rawIndex).not.toContain("secret-token");
    expect(rawIndex).not.toContain("Authorization");
    expect(rawIndex).not.toContain("X-API-Key");
    const index = JSON.parse(rawIndex) as Record<string, {
      source?: { source?: string; url?: string; headers?: unknown };
      refreshable?: boolean;
    }>;
    expect(index["url-team"]?.source).toEqual({
      source: "url",
      url: "https://agenc.tech/marketplace.json?redacted=1",
    });
    expect(index["url-team"]?.refreshable).toBe(false);
  });

  it("keeps canonicalized safe URLs refreshable", async () => {
    const { pluginStorageRoot, workspaceRoot } = await tempRuntime();
    const sourceUrl = "https://EXAMPLE.com:443";

    const added = await addMarketplaceOp({
      pluginStorageRoot,
      workspaceRoot,
      source: { source: "url", url: sourceUrl },
      fetcher: async () => jsonResponse({
        metadata: { name: "safe-url-team" },
        plugins: [],
      }),
    });

    expect(added.marketplace.sourceDescriptor).toEqual({
      source: "url",
      url: sourceUrl,
    });
    expect(added.marketplace.refreshable).toBeUndefined();
    const index = JSON.parse(await readFile(
      marketplaceIndexPath({ pluginStorageRoot }),
      "utf8",
    )) as Record<string, {
      source?: { source?: string; url?: string };
      refreshable?: boolean;
    }>;
    expect(index["safe-url-team"]?.source).toEqual({
      source: "url",
      url: "https://example.com",
    });
    expect(index["safe-url-team"]?.refreshable).toBeUndefined();
  });

  it("skips credential-bearing URL marketplace upgrades instead of fetching redacted URLs", async () => {
    const { pluginStorageRoot, workspaceRoot } = await tempRuntime();

    await addMarketplaceOp({
      pluginStorageRoot,
      workspaceRoot,
      source: {
        source: "url",
        url: "https://agenc.tech/marketplace.json?token=secret-token",
        headers: {
          Authorization: "Bearer secret-token",
        },
      },
      fetcher: async () => jsonResponse({
        metadata: { name: "url-team" },
        plugins: [],
      }),
    });

    const result = await upgradeMarketplaceOp({
      pluginStorageRoot,
      workspaceRoot,
      fetcher: async () => {
        throw new Error("fetch should not run for non-refreshable URL marketplaces");
      },
    });

    expect(result.upgraded).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toMatchObject({
      marketplace: { name: "url-team" },
      reason: expect.stringContaining("credentials that are not stored"),
    });
  });

  it("does not persist or list credentials from git marketplace sources", async () => {
    const { pluginStorageRoot, workspaceRoot } = await tempRuntime();
    const credentialUrl =
      "https://opaque-token@agenc.tech/private/marketplace.git?X-Amz-Signature=opaque-signature#opaque-fragment";
    const cloneUrls: string[] = [];

    const added = await addMarketplaceOp({
      pluginStorageRoot,
      workspaceRoot,
      env: {},
      source: { source: "git", url: credentialUrl },
      runProcess: async (_command, args) => {
        if (args.includes("clone")) {
          const repositorySeparator = args.indexOf("--");
          const gitUrl = args[repositorySeparator + 1];
          const target = args.at(-1);
          if (gitUrl === undefined || target === undefined) {
            throw new Error("missing git clone arguments");
          }
          cloneUrls.push(gitUrl);
          await writeMarketplace(target, "git-team");
          return { stdout: "", stderr: "" };
        }
        if (args.includes("rev-parse")) {
          return { stdout: "abc123\n", stderr: "" };
        }
        return { stdout: "", stderr: "" };
      },
    });

    expect(cloneUrls).toEqual([credentialUrl]);
    expect(added.marketplace.source).not.toContain("opaque-token");
    expect(added.marketplace.sourceDescriptor).toEqual({
      source: "git",
      url:
        "https://redacted@agenc.tech/private/marketplace.git?redacted=1#redacted",
    });
    expect(added.marketplace.refreshable).toBe(false);

    const rawIndex = await readFile(
      marketplaceIndexPath({ pluginStorageRoot }),
      "utf8",
    );
    expect(rawIndex).not.toContain("opaque-token");
    expect(rawIndex).not.toContain("opaque-signature");
    expect(rawIndex).not.toContain("opaque-fragment");
    const listed = await readMarketplaceIndex({
      pluginStorageRoot,
      workspaceRoot,
    });
    expect(listed.marketplaces["git-team"]?.source).not.toContain("opaque-token");
    expect(listed.marketplaces["git-team"]?.sourceDescriptor).toEqual({
      source: "git",
      url:
        "https://redacted@agenc.tech/private/marketplace.git?redacted=1#redacted",
    });

    const upgraded = await upgradeMarketplaceOp({
      pluginStorageRoot,
      workspaceRoot,
      env: {},
      runProcess: async () => {
        throw new Error("git should not run for redacted git marketplace upgrades");
      },
    });
    expect(upgraded.upgraded).toEqual([]);
    expect(upgraded.skipped).toHaveLength(1);
    expect(upgraded.skipped[0]).toMatchObject({
      marketplace: { name: "git-team" },
      reason: expect.stringContaining("credentials that are not stored"),
    });
  });

  it("fails malformed marketplace plugin entries instead of silently skipping them", async () => {
    const { workspaceRoot } = await tempRuntime();
    const marketplaceRoot = join(workspaceRoot, "bad-marketplace");
    await mkdir(join(marketplaceRoot, ".agenc-plugin"), { recursive: true });

    await writeFile(
      marketplaceManifestPath(marketplaceRoot),
      JSON.stringify({
        metadata: { name: "bad" },
        plugins: [{ name: "alpha" }],
      }),
    );
    await expect(loadMarketplace(marketplaceManifestPath(marketplaceRoot)))
      .rejects.toThrow("must define source");

    await writeFile(
      marketplaceManifestPath(marketplaceRoot),
      JSON.stringify({
        metadata: { name: "bad" },
        plugins: [{ name: "alpha", source: { source: "git-subdir", url: "https://github.com/agenc-org/plugins.git" } }],
      }),
    );
    await expect(loadMarketplace(marketplaceManifestPath(marketplaceRoot)))
      .rejects.toThrow("must include a non-empty string path");

    await writeFile(
      marketplaceManifestPath(marketplaceRoot),
      JSON.stringify({
        metadata: { name: "bad" },
        plugins: [{ name: "alpha", source: { source: "git", url: "http://agenc.tech/plugins.git" } }],
      }),
    );
    await expect(loadMarketplace(marketplaceManifestPath(marketplaceRoot)))
      .rejects.toThrow("marketplace plugin git URL must use HTTPS or loopback HTTP");

    await writeFile(
      marketplaceManifestPath(marketplaceRoot),
      JSON.stringify({
        metadata: { name: "bad" },
        plugins: [{ name: "alpha", source: "../outside" }],
      }),
    );
    await expect(loadMarketplace(marketplaceManifestPath(marketplaceRoot)))
      .rejects.toThrow("must start with './'");

    const outsidePlugin = await writePlugin(join(workspaceRoot, "outside"), "alpha");
    await symlink(outsidePlugin, join(marketplaceRoot, "alpha"));
    await writeFile(
      marketplaceManifestPath(marketplaceRoot),
      JSON.stringify({
        metadata: { name: "bad" },
        plugins: [{ name: "alpha", source: "./alpha" }],
      }),
    );
    await expect(loadMarketplace(marketplaceManifestPath(marketplaceRoot)))
      .rejects.toThrow("must stay within the marketplace root");

    await writeFile(
      marketplaceManifestPath(marketplaceRoot),
      JSON.stringify({
        metadata: { name: "bad" },
        plugins: [
          { name: "Alpha", source: "./alpha" },
          { name: "alpha", source: "./alpha2" },
        ],
      }),
    );
    await expect(loadMarketplace(marketplaceManifestPath(marketplaceRoot)))
      .rejects.toThrow("duplicate plugin names");
    const duplicateValidation = await validateMarketplaceManifest(
      marketplaceManifestPath(marketplaceRoot),
    );
    expect(duplicateValidation.errors).toContainEqual(
      expect.objectContaining({
        path: "plugins[1].name",
        message: expect.stringContaining("duplicate plugin names"),
      }),
    );
  });

  it.each([
    [
      "local without path",
      { source: "local" },
      "plugins[0].source.path",
      "non-empty string path",
    ],
    [
      "git with a non-string URL",
      { source: "git", url: 42 },
      "plugins[0].source.url",
      "non-empty string url",
    ],
    [
      "object without discriminator",
      {},
      "plugins[0].source.source",
      "supported source type",
    ],
  ] as const)(
    "rejects malformed structured source: %s",
    async (_label, source, issuePath, errorText) => {
      const { pluginStorageRoot, workspaceRoot } = await tempRuntime();
      const marketplaceRoot = join(workspaceRoot, "malformed-source-marketplace");
      await mkdir(join(marketplaceRoot, ".agenc-plugin"), { recursive: true });
      const manifestPath = marketplaceManifestPath(marketplaceRoot);
      await writeFile(
        manifestPath,
        JSON.stringify({
          metadata: { name: "malformed" },
          plugins: [{ name: "alpha", source }],
        }),
      );

      const validation = await validateMarketplaceManifest(manifestPath);
      expect(validation.success).toBe(false);
      expect(validation.errors).toContainEqual(expect.objectContaining({
        path: issuePath,
        message: expect.stringContaining(errorText),
      }));
      await expect(loadMarketplace(manifestPath)).rejects.toThrow(errorText);
      await expect(addMarketplaceOp({
        pluginStorageRoot,
        workspaceRoot,
        source: marketplaceRoot,
      })).rejects.toThrow(errorText);
      await expect(readMarketplaceIndex({
        pluginStorageRoot,
        workspaceRoot,
      })).resolves.toEqual({ version: 1, marketplaces: {} });
    },
  );

  it.each([
    ["path string", "./alpha", "local"],
    ["local", { source: "local", path: "./alpha" }, "local"],
    ["url", { source: "url", url: "https://github.com/agenc-org/alpha.git" }, "git"],
    ["git", { source: "git", url: "https://github.com/agenc-org/alpha.git" }, "git"],
    [
      "git-subdir",
      {
        source: "git-subdir",
        url: "https://github.com/agenc-org/plugins.git",
        path: "plugins/alpha",
        ref: "stable",
        sha: "a".repeat(40),
      },
      "git",
    ],
  ] as const)(
    "keeps validation, list, and add aligned for the supported %s catalog source",
    async (_label, source, expectedType) => {
      const { pluginStorageRoot, workspaceRoot } = await tempRuntime();
      const marketplaceRoot = join(workspaceRoot, `supported-${_label}`);
      await mkdir(join(marketplaceRoot, ".agenc-plugin"), { recursive: true });
      if (expectedType === "local") {
        await writePlugin(marketplaceRoot, "alpha");
      }
      const manifestPath = marketplaceManifestPath(marketplaceRoot);
      await writeFile(
        manifestPath,
        JSON.stringify({
          metadata: { name: "parity" },
          plugins: [{ name: "alpha", source }],
        }),
      );

      await expect(validateMarketplaceManifest(manifestPath)).resolves.toMatchObject({
        success: true,
        errors: [],
      });
      const listedSource = await listMarketplaces([marketplaceRoot]);
      expect(listedSource.errors).toEqual([]);
      expect(listedSource.marketplaces[0]?.plugins[0]?.source.type).toBe(expectedType);

      const added = await addMarketplaceOp({
        pluginStorageRoot,
        workspaceRoot,
        source: marketplaceRoot,
      });
      const listedInstall = await listMarketplaces([added.marketplace.installedPath]);
      expect(listedInstall.errors).toEqual([]);
      expect(listedInstall.marketplaces[0]?.plugins[0]?.source.type).toBe(expectedType);
    },
  );

  it.each([
    ["npm", { source: "npm", package: "alpha" }],
    ["pip", { source: "pip", package: "alpha" }],
    ["github", { source: "github", repo: "agenc-org/alpha" }],
  ] as const)(
    "rejects the unsupported %s catalog source consistently",
    async (discriminator, source) => {
      const { pluginStorageRoot, workspaceRoot } = await tempRuntime();
      const marketplaceRoot = join(workspaceRoot, `unsupported-${discriminator}`);
      await mkdir(join(marketplaceRoot, ".agenc-plugin"), { recursive: true });
      const manifestPath = marketplaceManifestPath(marketplaceRoot);
      await writeFile(
        manifestPath,
        JSON.stringify({
          metadata: { name: "unsupported" },
          plugins: [{ name: "alpha", source }],
        }),
      );
      const errorText = `Unsupported marketplace plugin source type '${discriminator}'`;

      const validation = await validateMarketplaceManifest(manifestPath);
      expect(validation.success).toBe(false);
      expect(validation.errors).toContainEqual(expect.objectContaining({
        path: "plugins[0].source.source",
        message: errorText,
      }));
      const listed = await listMarketplaces([marketplaceRoot]);
      expect(listed.marketplaces).toEqual([]);
      expect(listed.errors).toContainEqual(expect.objectContaining({
        message: expect.stringContaining(errorText),
      }));
      await expect(addMarketplaceOp({
        pluginStorageRoot,
        workspaceRoot,
        source: marketplaceRoot,
      })).rejects.toThrow(errorText);
      await expect(readMarketplaceIndex({
        pluginStorageRoot,
        workspaceRoot,
      })).resolves.toEqual({ version: 1, marketplaces: {} });
    },
  );

  it("rejects invalid plugin source metadata during marketplace add before persistence", async () => {
    async function expectAtomicAddRejection(
      source: unknown,
      expectedError: string,
      setup?: (paths: {
        readonly marketplaceRoot: string;
        readonly workspaceRoot: string;
      }) => Promise<void>,
    ): Promise<void> {
      const { pluginStorageRoot, workspaceRoot } = await tempRuntime();
      const marketplaceRoot = join(workspaceRoot, "bad-marketplace");
      await mkdir(join(marketplaceRoot, ".agenc-plugin"), { recursive: true });
      await setup?.({ marketplaceRoot, workspaceRoot });
      await writeFile(
        marketplaceManifestPath(marketplaceRoot),
        JSON.stringify({
          metadata: { name: "bad" },
          plugins: [{ name: "alpha", source }],
        }, null, 2),
      );

      await expect(addMarketplaceOp({
        pluginStorageRoot,
        workspaceRoot,
        source: marketplaceRoot,
      })).rejects.toThrow(expectedError);
      await expect(
        readFile(marketplaceIndexPath({ pluginStorageRoot }), "utf8"),
      )
        .rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        stat(marketplaceInstalledPath("bad", { pluginStorageRoot })),
      )
        .rejects.toMatchObject({ code: "ENOENT" });
    }

    await expectAtomicAddRejection(
      "./alpha",
      "must exist within the marketplace root",
    );
    await expectAtomicAddRejection(
      "./alpha",
      "Plugin manifest has invalid JSON",
      async ({ marketplaceRoot }) => {
        await mkdir(join(marketplaceRoot, "alpha", ".agenc-plugin"), { recursive: true });
        await writeFile(join(marketplaceRoot, "alpha", ".agenc-plugin", "plugin.json"), "{invalid");
      },
    );
    await expectAtomicAddRejection(
      { source: "npm", package: "alpha" },
      "Unsupported marketplace plugin source type 'npm'",
    );
    await expectAtomicAddRejection(
      { source: "local", path: "./../outside" },
      "must stay within the marketplace root",
    );
    await expectAtomicAddRejection(
      { source: "git", url: "http://agenc.tech/plugin.git" },
      "marketplace plugin git URL must use HTTPS or loopback HTTP",
    );
    await expectAtomicAddRejection(
      "./alpha",
      "must stay within the marketplace root",
      async ({ marketplaceRoot, workspaceRoot }) => {
        const outsidePlugin = await writePlugin(join(workspaceRoot, "outside"), "alpha");
        await symlink(outsidePlugin, join(marketplaceRoot, "alpha"));
      },
    );
  });

});

function exactArrayBuffer(bytes: Buffer): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 500): Awaited<ReturnType<Fetcher>> {
  const text = JSON.stringify(body);
  const bytes = Buffer.from(text, "utf8");
  return {
    ok,
    status,
    statusText: ok ? "OK" : "Error",
    text: async () => text,
    arrayBuffer: async () => exactArrayBuffer(bytes),
  };
}
