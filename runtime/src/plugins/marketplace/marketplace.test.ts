import { mkdtemp, mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  addMarketplaceOp,
  findInstallableMarketplacePlugin,
  loadMarketplace,
  marketplaceIndexPath,
  marketplaceInstalledPath,
  normalizeSparsePath,
  readMarketplaceIndex,
  removeMarketplaceOp,
  type Fetcher,
} from "./marketplace.js";
import {
  createPluginId,
  isSourceAllowedByPolicy,
  loadMarketplacesWithGracefulDegradation,
} from "./marketplaceHelpers.js";
import { getMarketplace, reconcileMarketplaces } from "./marketplaceManager.js";
import { parseMarketplaceInput } from "./parseMarketplaceInput.js";

async function tempRuntime(): Promise<{
  readonly root: string;
  readonly agencHome: string;
  readonly workspaceRoot: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "agenc-marketplace-"));
  const agencHome = join(root, "home");
  const workspaceRoot = join(root, "workspace");
  await mkdir(agencHome, { recursive: true });
  await mkdir(workspaceRoot, { recursive: true });
  return { root, agencHome, workspaceRoot };
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
  await writeFile(
    join(root, "marketplace.json"),
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

describe("plugin marketplace runtime", () => {
  it("materializes local marketplaces, indexes them, and resolves installable plugin entries", async () => {
    const { agencHome, workspaceRoot } = await tempRuntime();
    const marketplaceRoot = await writeMarketplace(join(workspaceRoot, "team-marketplace"), "team");

    const result = await addMarketplaceOp({
      agencHome,
      workspaceRoot,
      source: marketplaceRoot,
      now: () => new Date("2026-05-05T00:00:00.000Z"),
    });

    expect(result.replaced).toBe(false);
    expect(result.marketplace.name).toBe("team");
    expect(result.marketplace.installedPath).toBe(marketplaceInstalledPath("team", { agencHome }));
    expect(JSON.parse(await readFile(marketplaceIndexPath({ agencHome }), "utf8")))
      .toMatchObject({
        version: 1,
        marketplaces: {
          team: {
            name: "team",
            sourceType: "local",
            sourceDescriptor: { source: "directory", path: marketplaceRoot },
          },
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

  it("preserves configured marketplace names when manifest metadata differs", async () => {
    const { agencHome, workspaceRoot } = await tempRuntime();
    const marketplaceRoot = await writeMarketplace(join(workspaceRoot, "team-marketplace"), "upstream");

    const result = await addMarketplaceOp({
      agencHome,
      workspaceRoot,
      source: marketplaceRoot,
      name: "team",
      now: () => new Date("2026-05-05T00:00:00.000Z"),
    });

    expect(result.marketplace.name).toBe("team");

    const marketplace = await getMarketplace("team", { agencHome, workspaceRoot });
    expect(marketplace.name).toBe("team");
    expect(marketplace.plugins.map((plugin) => plugin.name)).toEqual(["alpha"]);

    const plugin = await findInstallableMarketplacePlugin(
      result.marketplace.manifestPath,
      "alpha",
      undefined,
      result.marketplace.name,
    );
    expect(plugin.pluginId).toBe("alpha@team");
    expect(plugin.marketplaceName).toBe("team");
  });

  it("removes by computed install path and ignores untrusted index paths", async () => {
    const { agencHome, root, workspaceRoot } = await tempRuntime();
    const marketplaceRoot = await writeMarketplace(join(workspaceRoot, "team-marketplace"), "team");
    await addMarketplaceOp({ agencHome, workspaceRoot, source: marketplaceRoot });
    const outside = join(root, "outside");
    await mkdir(outside, { recursive: true });
    const index = await readMarketplaceIndex({ agencHome });
    await writeFile(
      marketplaceIndexPath({ agencHome }),
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

    await removeMarketplaceOp({ agencHome, name: "team" });

    await expect(stat(marketplaceInstalledPath("team", { agencHome })))
      .rejects.toMatchObject({ code: "ENOENT" });
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
    const { agencHome, workspaceRoot } = await tempRuntime();
    const cloneCalls: string[][] = [];

    const result = await addMarketplaceOp({
      agencHome,
      workspaceRoot,
      source: "agenc-org/plugins#stable",
      runProcess: async (_command, args) => {
        if (args[0] === "clone") {
          cloneCalls.push([...args]);
          const target = args.at(-1);
          if (target === undefined) throw new Error("missing clone target");
          await writeMarketplace(target, "team");
          return { stdout: "", stderr: "" };
        }
        if (args[0] === "rev-parse") {
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

  it("rejects leading-dash object-form git marketplace sources before running git", async () => {
    const { agencHome, workspaceRoot } = await tempRuntime();
    const calls: string[][] = [];

    const result = await reconcileMarketplaces({
      agencHome,
      workspaceRoot,
      declaredMarketplaces: {
        team: {
          source: { source: "git", url: "--upload-pack=x.git" },
        },
      },
      runProcess: async (_command, args) => {
        calls.push([...args]);
        throw new Error("git should not run for unsafe object-form git sources");
      },
    });

    expect(calls).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toMatchObject({
      name: "team",
      error: expect.stringContaining("must not start with '-'"),
    });
  });

  it("requires safe URL marketplace transport and bounded manifest downloads", async () => {
    const { agencHome, workspaceRoot } = await tempRuntime();
    const fetcher: Fetcher = async () => {
      throw new Error("fetch should not run for unsafe URL");
    };

    await expect(addMarketplaceOp({
      agencHome,
      workspaceRoot,
      source: { source: "url", url: "http://agenc.tech/marketplace.json" },
      fetcher,
    })).rejects.toThrow("must use HTTPS or loopback HTTP");
    await expect(addMarketplaceOp({
      agencHome,
      workspaceRoot,
      source: "http://agenc.tech/plugins.git",
      runProcess: async () => {
        throw new Error("git should not run for unsafe HTTP git sources");
      },
    })).rejects.toThrow("must use HTTPS or loopback HTTP");

    const largeBody = "x".repeat(1024 * 1024 + 1);
    await expect(addMarketplaceOp({
      agencHome,
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
    const { agencHome, workspaceRoot } = await tempRuntime();

    await addMarketplaceOp({
      agencHome,
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

    const rawIndex = await readFile(marketplaceIndexPath({ agencHome }), "utf8");
    expect(rawIndex).not.toContain("secret-token");
    expect(rawIndex).not.toContain("Authorization");
    expect(rawIndex).not.toContain("X-API-Key");
    const index = JSON.parse(rawIndex) as {
      marketplaces: Record<string, {
        source?: string;
        sourceDescriptor?: { source?: string; url?: string; headers?: unknown };
      }>;
    };
    expect(index.marketplaces["url-team"]?.source).toBe(
      "https://agenc.tech/marketplace.json?token=<redacted>",
    );
    expect(index.marketplaces["url-team"]?.sourceDescriptor).toEqual({
      source: "url",
      url: "https://agenc.tech/marketplace.json?token=<redacted>",
    });
  });

  it("fails malformed marketplace plugin entries instead of silently skipping them", async () => {
    const { workspaceRoot } = await tempRuntime();
    const marketplaceRoot = join(workspaceRoot, "bad-marketplace");
    await mkdir(marketplaceRoot, { recursive: true });

    await writeFile(
      join(marketplaceRoot, "marketplace.json"),
      JSON.stringify({
        metadata: { name: "bad" },
        plugins: [{ name: "alpha" }],
      }),
    );
    await expect(loadMarketplace(join(marketplaceRoot, "marketplace.json")))
      .rejects.toThrow("must define source");

    await writeFile(
      join(marketplaceRoot, "marketplace.json"),
      JSON.stringify({
        metadata: { name: "bad" },
        plugins: [{ name: "alpha", source: { source: "git-subdir", url: "https://github.com/agenc-org/plugins.git" } }],
      }),
    );
    await expect(loadMarketplace(join(marketplaceRoot, "marketplace.json")))
      .rejects.toThrow("git-subdir marketplace plugin source must include a path");

    await writeFile(
      join(marketplaceRoot, "marketplace.json"),
      JSON.stringify({
        metadata: { name: "bad" },
        plugins: [{ name: "alpha", source: { source: "git", url: "http://agenc.tech/plugins.git" } }],
      }),
    );
    await expect(loadMarketplace(join(marketplaceRoot, "marketplace.json")))
      .rejects.toThrow("marketplace plugin git URL must use HTTPS or loopback HTTP");

    await writeFile(
      join(marketplaceRoot, "marketplace.json"),
      JSON.stringify({
        metadata: { name: "bad" },
        plugins: [{ name: "alpha", source: "../outside" }],
      }),
    );
    await expect(loadMarketplace(join(marketplaceRoot, "marketplace.json")))
      .rejects.toThrow("must start with './'");

    const outsidePlugin = await writePlugin(join(workspaceRoot, "outside"), "alpha");
    await symlink(outsidePlugin, join(marketplaceRoot, "alpha"));
    await writeFile(
      join(marketplaceRoot, "marketplace.json"),
      JSON.stringify({
        metadata: { name: "bad" },
        plugins: [{ name: "alpha", source: "./alpha" }],
      }),
    );
    await expect(loadMarketplace(join(marketplaceRoot, "marketplace.json")))
      .rejects.toThrow("must stay within the marketplace root");

    await writeFile(
      join(marketplaceRoot, "marketplace.json"),
      JSON.stringify({
        metadata: { name: "bad" },
        plugins: [
          { name: "Alpha", source: "./alpha" },
          { name: "alpha", source: "./alpha2" },
        ],
      }),
    );
    await expect(loadMarketplace(join(marketplaceRoot, "marketplace.json")))
      .rejects.toThrow("duplicate plugin names");
  });

  it("rejects invalid plugin source metadata during marketplace add before persistence", async () => {
    async function expectAtomicAddRejection(
      source: unknown,
      expectedError: string,
      setup?: (paths: {
        readonly marketplaceRoot: string;
        readonly workspaceRoot: string;
      }) => Promise<void>,
    ): Promise<void> {
      const { agencHome, workspaceRoot } = await tempRuntime();
      const marketplaceRoot = join(workspaceRoot, "bad-marketplace");
      await mkdir(marketplaceRoot, { recursive: true });
      await setup?.({ marketplaceRoot, workspaceRoot });
      await writeFile(
        join(marketplaceRoot, "marketplace.json"),
        JSON.stringify({
          metadata: { name: "bad" },
          plugins: [{ name: "alpha", source }],
        }, null, 2),
      );

      await expect(addMarketplaceOp({
        agencHome,
        workspaceRoot,
        source: marketplaceRoot,
      })).rejects.toThrow(expectedError);
      await expect(readFile(marketplaceIndexPath({ agencHome }), "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(marketplaceInstalledPath("bad", { agencHome })))
        .rejects.toMatchObject({ code: "ENOENT" });
    }

    await expectAtomicAddRejection(
      { source: "npm", package: "alpha" },
      "unsupported marketplace plugin source",
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

  it("keeps marketplace reconciliation atomic when plugin source metadata is invalid", async () => {
    const { agencHome, workspaceRoot } = await tempRuntime();
    const marketplaceRoot = join(workspaceRoot, "bad-marketplace");
    await mkdir(marketplaceRoot, { recursive: true });
    await writeFile(
      join(marketplaceRoot, "marketplace.json"),
      JSON.stringify({
        metadata: { name: "bad" },
        plugins: [{
          name: "alpha",
          source: { source: "git", url: "http://agenc.tech/plugin.git" },
        }],
      }, null, 2),
    );

    const result = await reconcileMarketplaces({
      agencHome,
      workspaceRoot,
      declaredMarketplaces: {
        bad: { source: { source: "directory", path: marketplaceRoot } },
      },
    });

    expect(result.installed).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toMatchObject({
      name: "bad",
      error: expect.stringContaining("must use HTTPS or loopback HTTP"),
    });
    await expect(readFile(marketplaceIndexPath({ agencHome }), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(marketplaceInstalledPath("bad", { agencHome })))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("treats policy host and path patterns as a safe bounded subset", () => {
    expect(isSourceAllowedByPolicy(
      { source: "github", repo: "agenc-org/plugins" },
      {
        strictKnownMarketplaces: [{
          source: "settings",
          name: String.raw`hostPattern:^github\.com$`,
          plugins: [],
        }],
      },
    )).toBe(true);
    expect(isSourceAllowedByPolicy(
      { source: "directory", path: "/opt/approved/team-marketplace" },
      {
        strictKnownMarketplaces: [{
          source: "settings",
          name: "pathPattern:^/opt/approved/",
          plugins: [],
        }],
      },
    )).toBe(true);
    expect(isSourceAllowedByPolicy(
      { source: "git", url: "https://github.com/agenc-org/plugins.git" },
      {
        strictKnownMarketplaces: [{
          source: "settings",
          name: "hostPattern:(a+)+$",
          plugins: [],
        }],
      },
    )).toBe(false);
    expect(isSourceAllowedByPolicy(
      { source: "git", url: "https://github.com/agenc-org/plugins.git" },
      {
        strictKnownMarketplaces: [{
          source: "settings",
          name: `hostPattern:${"a".repeat(257)}`,
          plugins: [],
        }],
      },
    )).toBe(false);
  });

  it("handles empty marketplace maps and unicode plugin ids at helper boundaries", async () => {
    await expect(loadMarketplacesWithGracefulDegradation({}, async () => {
      throw new Error("no marketplaces should load");
    })).resolves.toEqual({ marketplaces: [], failures: [] });
    expect(createPluginId("überblick", "team")).toBe("überblick@team");
  });

  it("evicts rejected marketplace cache entries before retrying", async () => {
    const { agencHome, workspaceRoot } = await tempRuntime();
    await expect(getMarketplace("team", { agencHome, workspaceRoot }))
      .rejects.toThrow("not found");

    const marketplaceRoot = await writeMarketplace(join(workspaceRoot, "team-marketplace"), "team");
    await addMarketplaceOp({ agencHome, workspaceRoot, source: marketplaceRoot });

    await expect(getMarketplace("team", { agencHome, workspaceRoot }))
      .resolves.toMatchObject({ name: "team" });
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
