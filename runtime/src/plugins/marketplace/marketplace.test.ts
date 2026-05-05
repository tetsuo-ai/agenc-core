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
} from "./marketplace.js";
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
            sourceDescriptor: { source: "local", path: marketplaceRoot },
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
    expect(normalizeSparsePath("marketplaces/team")).toBe("marketplaces/team");
    expect(() => normalizeSparsePath("../team")).toThrow("--sparse must not contain");
  });
});
