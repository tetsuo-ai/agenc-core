import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
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
import { isSourceAllowedByPolicy } from "./marketplaceHelpers.js";
import { getMarketplace } from "./marketplaceManager.js";
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
        plugins: [{ name: "alpha", source: "../outside" }],
      }),
    );
    await expect(loadMarketplace(join(marketplaceRoot, "marketplace.json")))
      .rejects.toThrow("must start with './'");

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
