import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildMarketplaceCatalog,
  marketplacePluginSupportsProduct,
  parseQualifiedMarketplacePluginId,
  resolveMarketplaceInstallTarget,
} from "./catalog-cli.js";
import { addMarketplaceOp } from "./marketplace.js";

async function tempRuntime(): Promise<{
  readonly root: string;
  readonly pluginStorageRoot: string;
  readonly workspaceRoot: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "agenc-marketplace-catalog-"));
  const pluginStorageRoot = join(root, "plugin-storage");
  const workspaceRoot = join(root, "workspace");
  await mkdir(pluginStorageRoot, { recursive: true });
  await mkdir(workspaceRoot, { recursive: true });
  return { root, pluginStorageRoot, workspaceRoot };
}

async function writePlugin(
  root: string,
  name: string,
  options: { readonly logo?: boolean } = {},
): Promise<void> {
  const pluginRoot = join(root, name);
  await mkdir(join(pluginRoot, ".agenc-plugin"), { recursive: true });
  if (options.logo === true) {
    await mkdir(join(pluginRoot, "assets"), { recursive: true });
    await writeFile(join(pluginRoot, "assets", "logo.png"), "png-bytes");
  }
  await writeFile(
    join(pluginRoot, ".agenc-plugin", "plugin.json"),
    `${JSON.stringify({
      name,
      version: "1.0.0",
      description: `${name} plugin`,
      commands: "./commands",
      ...(options.logo === true
        ? { interface: { displayName: name, logo: "./assets/logo.png" } }
        : {}),
    }, null, 2)}\n`,
  );
  await mkdir(join(pluginRoot, "commands"), { recursive: true });
  await writeFile(join(pluginRoot, "commands", "hello.md"), "# Hello\n");
}

async function writeMarketplace(root: string): Promise<string> {
  await writePlugin(root, "desktop-only", { logo: true });
  await writePlugin(root, "everywhere");
  await writePlugin(root, "hidden");
  await writePlugin(root, "nobody");
  await mkdir(join(root, ".agenc-plugin"), { recursive: true });
  await writeFile(
    join(root, ".agenc-plugin", "marketplace.json"),
    `${JSON.stringify({
      metadata: { name: "team", displayName: "Team Marketplace" },
      plugins: [
        {
          name: "desktop-only",
          source: "./desktop-only",
          policy: {
            installation: "AVAILABLE",
            authentication: "ON_USE",
            products: ["desktop"],
          },
        },
        {
          name: "everywhere",
          source: "./everywhere",
          policy: { installation: "AVAILABLE", authentication: "ON_USE" },
        },
        {
          name: "hidden",
          source: "./hidden",
          policy: { installation: "NOT_AVAILABLE", authentication: "ON_USE" },
        },
        {
          name: "nobody",
          source: "./nobody",
          policy: {
            installation: "AVAILABLE",
            authentication: "ON_USE",
            products: [],
          },
        },
      ],
    }, null, 2)}\n`,
  );
  return root;
}

describe("marketplace catalog CLI surface", () => {
  it("gates plugins by product policy", () => {
    expect(
      marketplacePluginSupportsProduct(
        { installation: "AVAILABLE", authentication: "ON_USE" },
        undefined,
      ),
    ).toBe(true);
    expect(
      marketplacePluginSupportsProduct(
        {
          installation: "AVAILABLE",
          authentication: "ON_USE",
          products: ["desktop"],
        },
        "desktop",
      ),
    ).toBe(true);
    expect(
      marketplacePluginSupportsProduct(
        {
          installation: "AVAILABLE",
          authentication: "ON_USE",
          products: ["desktop"],
        },
        undefined,
      ),
    ).toBe(false);
    expect(
      marketplacePluginSupportsProduct(
        { installation: "AVAILABLE", authentication: "ON_USE", products: [] },
        "desktop",
      ),
    ).toBe(false);
  });

  it("splits qualified ids on the last @ and accepts bare names", () => {
    expect(parseQualifiedMarketplacePluginId("llm-checker@agenc-plugins")).toEqual({
      pluginName: "llm-checker",
      marketplaceName: "agenc-plugins",
    });
    expect(parseQualifiedMarketplacePluginId("@scope/tool@shop")).toEqual({
      pluginName: "@scope/tool",
      marketplaceName: "shop",
    });
    expect(parseQualifiedMarketplacePluginId("solo")).toEqual({
      pluginName: "solo",
    });
    expect(() => parseQualifiedMarketplacePluginId("  ")).toThrow(
      /must not be empty/,
    );
  });

  it("serializes the product-filtered catalog with in-root logo paths", async () => {
    const { pluginStorageRoot, workspaceRoot } = await tempRuntime();
    const marketplaceRoot = await writeMarketplace(
      join(workspaceRoot, "market"),
    );
    await addMarketplaceOp({
      pluginStorageRoot,
      workspaceRoot,
      source: marketplaceRoot,
      force: false,
    });

    const catalog = await buildMarketplaceCatalog(
      { pluginStorageRoot, workspaceRoot },
      "desktop",
    );
    expect(catalog.kind).toBe("agenc.plugin.marketplace.catalog");
    expect(catalog.product).toBe("desktop");
    expect(catalog.errors).toEqual([]);
    expect(catalog.marketplaces).toHaveLength(1);
    const [market] = catalog.marketplaces;
    const ids = market!.plugins.map((plugin) => plugin.id);
    expect(ids).toContain("desktop-only@team");
    expect(ids).toContain("everywhere@team");
    expect(ids).not.toContain("hidden@team");
    expect(ids).not.toContain("nobody@team");
    const withLogo = market!.plugins.find(
      (plugin) => plugin.name === "desktop-only",
    );
    expect(withLogo?.logoPath).toBeDefined();
    expect(withLogo!.logoPath!.startsWith(withLogo!.root)).toBe(true);
    expect(withLogo!.logoPath!.endsWith("logo.png")).toBe(true);
    const withoutLogo = market!.plugins.find(
      (plugin) => plugin.name === "everywhere",
    );
    expect(withoutLogo?.logoPath).toBeUndefined();

    // A CLI product filters desktop-only plugins away.
    const cliCatalog = await buildMarketplaceCatalog(
      { pluginStorageRoot, workspaceRoot },
      "cli",
    );
    expect(
      cliCatalog.marketplaces[0]!.plugins.map((plugin) => plugin.name),
    ).toEqual(["everywhere"]);
  });

  it("resolves qualified installs and rejects unavailable or unknown ones", async () => {
    const { pluginStorageRoot, workspaceRoot } = await tempRuntime();
    const marketplaceRoot = await writeMarketplace(
      join(workspaceRoot, "market"),
    );
    await addMarketplaceOp({
      pluginStorageRoot,
      workspaceRoot,
      source: marketplaceRoot,
      force: false,
    });
    const options = { pluginStorageRoot, workspaceRoot };

    const target = await resolveMarketplaceInstallTarget(
      options,
      "desktop-only@team",
      "desktop",
    );
    expect(target.marketplaceName).toBe("team");
    expect(target.source).toMatchObject({ type: "local" });

    // Bare names resolve when unambiguous.
    const bare = await resolveMarketplaceInstallTarget(
      options,
      "everywhere",
      "desktop",
    );
    expect(bare.pluginName).toBe("everywhere");

    await expect(
      resolveMarketplaceInstallTarget(options, "desktop-only@team", "cli"),
    ).rejects.toThrow(/not installable/);
    await expect(
      resolveMarketplaceInstallTarget(options, "hidden@team", "desktop"),
    ).rejects.toThrow(/not installable/);
    await expect(
      resolveMarketplaceInstallTarget(options, "missing@nowhere", "desktop"),
    ).rejects.toThrow(/not configured/);
  });
});
