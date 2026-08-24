import { mkdtemp, mkdir, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import {
  getMarketplaceCacheOnly,
  getKnownMarketplacesFilePath,
  loadKnownMarketplacesConfig,
  updateMarketplaceInventory,
  type KnownMarketplace,
  type MarketplaceInventoryMutationAuthority,
} from "../../../src/plugins/marketplace/inventory.js";

function entry(root: string, name: string): KnownMarketplace {
  const installLocation = join(root, "marketplaces", name);
  return {
    source: { source: "directory", path: installLocation },
    installLocation,
    manifestPath: join(
      installLocation,
      ".agenc-plugin",
      "marketplace.json",
    ),
    lastUpdated: "2026-08-24T00:00:00.000Z",
  };
}

async function addEntry(
  authority: MarketplaceInventoryMutationAuthority,
  name: string,
  value: KnownMarketplace,
): Promise<void> {
  await updateMarketplaceInventory(authority, async (current) => {
    await Promise.resolve();
    return {
      inventory: { ...current, [name]: value },
      result: undefined,
    };
  });
}

describe("marketplace inventory authority", () => {
  test("serializes same-home updates and isolates concurrent AgenC homes", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenc-marketplace-inventory-"));
    const pluginsA = join(root, "home-a", "plugins");
    const pluginsB = join(root, "home-b", "plugins");
    const authorityA = { pluginsDirectory: pluginsA };
    const authorityB = { pluginsDirectory: pluginsB };

    await Promise.all([
      addEntry(authorityA, "alpha", entry(pluginsA, "alpha")),
      addEntry(authorityA, "beta", entry(pluginsA, "beta")),
      addEntry(authorityB, "alpha", entry(pluginsB, "alpha")),
    ]);

    const [inventoryA, inventoryB] = await Promise.all([
      loadKnownMarketplacesConfig(authorityA),
      loadKnownMarketplacesConfig(authorityB),
    ]);
    expect(Object.keys(inventoryA).sort()).toEqual(["alpha", "beta"]);
    expect(Object.keys(inventoryB)).toEqual(["alpha"]);
    expect(inventoryA.alpha?.installLocation).toContain("home-a");
    expect(inventoryB.alpha?.installLocation).toContain("home-b");
    expect(await readdir(pluginsA)).toEqual(["known_marketplaces.json"]);
  });

  test("rejects duplicate JSON object keys before parsing", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenc-marketplace-duplicates-"));
    const authority = { pluginsDirectory: join(root, "plugins") };
    await mkdir(authority.pluginsDirectory, { recursive: true });
    const value = entry(authority.pluginsDirectory, "duplicate");
    await writeFile(
      getKnownMarketplacesFilePath(authority),
      `{\"duplicate\":${JSON.stringify(value)},\"duplicate\":${JSON.stringify(value)}}`,
      "utf8",
    );

    await expect(loadKnownMarketplacesConfig(authority))
      .rejects.toThrow("duplicate object keys");
  });

  test("rejects the retired competing marketplace index", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenc-marketplace-retired-index-"));
    const authority = { pluginsDirectory: join(root, "plugins") };
    const retiredDirectory = join(authority.pluginsDirectory, "marketplaces");
    await mkdir(retiredDirectory, { recursive: true });
    await writeFile(
      join(retiredDirectory, "marketplaces.json"),
      '{"version":1,"marketplaces":{}}',
      "utf8",
    );

    await expect(loadKnownMarketplacesConfig(authority))
      .rejects.toThrow("Retired marketplace index detected");
  });

  test("rejects duplicate keys in the exact cached catalog", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenc-marketplace-catalog-duplicates-"));
    const authority = { pluginsDirectory: join(root, "plugins") };
    const catalog = entry(authority.pluginsDirectory, "duplicate-catalog");
    await mkdir(join(catalog.installLocation, ".agenc-plugin"), {
      recursive: true,
    });
    await writeFile(
      catalog.manifestPath,
      '{"name":"duplicate-catalog","name":"shadow","owner":{"name":"Test"},"plugins":[]}',
      "utf8",
    );
    await addEntry(authority, "duplicate-catalog", catalog);

    await expect(getMarketplaceCacheOnly("duplicate-catalog", authority))
      .rejects.toThrow("duplicate object keys");
  });
});
