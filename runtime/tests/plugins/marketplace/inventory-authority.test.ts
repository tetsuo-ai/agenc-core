import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, test } from "vitest";

import {
  getKnownMarketplacesFilePath,
  loadKnownMarketplacesConfig,
  removeMarketplaceInventoryEntryForRepair,
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
  await materializeEntry(value);
  await updateMarketplaceInventory(authority, async (current) => {
    await Promise.resolve();
    return {
      inventory: { ...current, [name]: value },
      result: undefined,
    };
  });
}

async function materializeEntry(value: KnownMarketplace): Promise<void> {
  await mkdir(dirname(value.manifestPath), { recursive: true });
  await writeFile(value.manifestPath, '{"plugins":[]}\n', "utf8");
}

async function writeInventory(
  authority: MarketplaceInventoryMutationAuthority,
  inventory: Readonly<Record<string, KnownMarketplace>>,
): Promise<void> {
  await mkdir(authority.pluginsDirectory, { recursive: true });
  await writeFile(
    getKnownMarketplacesFilePath(authority),
    `${JSON.stringify(inventory, null, 2)}\n`,
    "utf8",
  );
}

describe("marketplace inventory authority", () => {
  test("atomically scrubs credentials from legacy inventory before returning it", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenc-marketplace-credential-repair-"));
    const authority = { pluginsDirectory: join(root, "plugins") };
    const gitEntry = entry(authority.pluginsDirectory, "private-git");
    const urlEntry = entry(authority.pluginsDirectory, "private-url");
    await materializeEntry(gitEntry);
    await materializeEntry(urlEntry);
    await writeInventory(authority, {
      "private-git": {
        ...gitEntry,
        source: {
          source: "git",
          url:
            "https://opaque-token@agenc.tech/private/marketplace.git?X-Amz-Signature=opaque-signature#opaque-fragment",
        },
        refreshable: true,
      },
      "private-url": {
        ...urlEntry,
        source: {
          source: "url",
          url: "https://agenc.tech/private/marketplace.json?download=1#view",
          headers: { Authorization: "Bearer opaque-header" },
        },
        refreshable: true,
      },
    });

    const loaded = await loadKnownMarketplacesConfig(authority);
    expect(loaded["private-git"]?.source).toEqual({
      source: "git",
      url:
        "https://redacted@agenc.tech/private/marketplace.git?redacted=1#redacted",
    });
    expect(loaded["private-git"]?.refreshable).toBe(false);
    expect(loaded["private-url"]?.source).toEqual({
      source: "url",
      url: "https://agenc.tech/private/marketplace.json?redacted=1#redacted",
    });
    expect(loaded["private-url"]?.refreshable).toBe(false);

    const persisted = await readFile(
      getKnownMarketplacesFilePath(authority),
      "utf8",
    );
    expect(persisted).not.toContain("opaque-token");
    expect(persisted).not.toContain("opaque-signature");
    expect(persisted).not.toContain("opaque-fragment");
    expect(persisted).not.toContain("opaque-header");
    expect(persisted).not.toContain("Authorization");
  });

  test("keeps safe legacy source URLs refreshable", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenc-marketplace-safe-source-"));
    const authority = { pluginsDirectory: join(root, "plugins") };
    const gitEntry = entry(authority.pluginsDirectory, "safe-git");
    const urlEntry = entry(authority.pluginsDirectory, "safe-url");
    await materializeEntry(gitEntry);
    await materializeEntry(urlEntry);
    const gitUrl = "ssh://git@github.com/acme/marketplace.git";
    const url = "https://EXAMPLE.com:443";
    await writeInventory(authority, {
      "safe-git": {
        ...gitEntry,
        source: { source: "git", url: gitUrl },
        refreshable: true,
      },
      "safe-url": {
        ...urlEntry,
        source: { source: "url", url, headers: {} },
        refreshable: true,
      },
    });

    const loaded = await loadKnownMarketplacesConfig(authority);
    expect(loaded["safe-git"]?.source).toEqual({ source: "git", url: gitUrl });
    expect(loaded["safe-git"]?.refreshable).toBe(true);
    expect(loaded["safe-url"]?.source).toEqual({
      source: "url",
      url: "https://example.com",
    });
    expect(loaded["safe-url"]?.refreshable).toBe(true);
  });

  test("serializes same-root updates and isolates explicit plugin storage roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenc-marketplace-inventory-"));
    const pluginStorageRootA = join(root, "plugin-storage-a");
    const pluginStorageRootB = join(root, "plugin-storage-b");
    const authorityA = { pluginsDirectory: pluginStorageRootA };
    const authorityB = { pluginsDirectory: pluginStorageRootB };

    await Promise.all([
      addEntry(authorityA, "alpha", entry(pluginStorageRootA, "alpha")),
      addEntry(authorityA, "beta", entry(pluginStorageRootA, "beta")),
      addEntry(authorityB, "alpha", entry(pluginStorageRootB, "alpha")),
    ]);

    const [inventoryA, inventoryB] = await Promise.all([
      loadKnownMarketplacesConfig(authorityA),
      loadKnownMarketplacesConfig(authorityB),
    ]);
    expect(Object.keys(inventoryA).sort()).toEqual(["alpha", "beta"]);
    expect(Object.keys(inventoryB)).toEqual(["alpha"]);
    expect(inventoryA.alpha?.installLocation).toContain("plugin-storage-a");
    expect(inventoryB.alpha?.installLocation).toContain("plugin-storage-b");
    expect(getKnownMarketplacesFilePath(authorityA)).toBe(
      join(pluginStorageRootA, "known_marketplaces.json"),
    );
    expect(getKnownMarketplacesFilePath(authorityB)).toBe(
      join(pluginStorageRootB, "known_marketplaces.json"),
    );
    expect((await readdir(pluginStorageRootA)).sort()).toEqual([
      "known_marketplaces.json",
      "marketplaces",
    ]);
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

  test("removes one malformed exact-key entry without parsing its value", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenc-marketplace-repair-"));
    const authority = { pluginsDirectory: join(root, "plugins") };
    await mkdir(authority.pluginsDirectory, { recursive: true });
    await writeFile(
      getKnownMarketplacesFilePath(authority),
      '{"team":{"unexpected":true}}\n',
      "utf8",
    );

    await expect(loadKnownMarketplacesConfig(authority))
      .rejects.toThrow("Marketplace inventory is invalid");
    await expect(removeMarketplaceInventoryEntryForRepair(authority, "team"))
      .resolves.toBe(true);
    await expect(loadKnownMarketplacesConfig(authority)).resolves.toEqual({});
  });

  test("rejects install locations outside the selected plugin storage root", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenc-marketplace-outside-root-"));
    const authority = { pluginsDirectory: join(root, "plugins") };
    const outside = entry(join(root, "outside-storage"), "team");
    await materializeEntry(outside);

    await expect(
      updateMarketplaceInventory(authority, () => ({
        inventory: { team: outside },
        result: undefined,
      })),
    ).rejects.toThrow("installLocation");

    await writeInventory(authority, { team: outside });
    await expect(loadKnownMarketplacesConfig(authority))
      .rejects.toThrow("installLocation");
  });

  test("rejects install locations that do not match their marketplace key", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenc-marketplace-name-mismatch-"));
    const authority = { pluginsDirectory: join(root, "plugins") };
    const mismatched = entry(authority.pluginsDirectory, "beta");
    await materializeEntry(mismatched);
    await writeInventory(authority, { alpha: mismatched });

    await expect(loadKnownMarketplacesConfig(authority))
      .rejects.toThrow("marketplace key 'alpha'");
  });

  test.each([
    ["reserved", "reserved"],
    ["invalid", "lowercase canonical"],
    ["uppercase", "lowercase canonical"],
    ["digit-leading", "lowercase canonical"],
    ["case collision", "differs only by case"],
    ["storage collision", "same storage name"],
  ] as const)("rejects %s marketplace keys", async (label, message) => {
    const root = await mkdtemp(join(tmpdir(), "agenc-marketplace-invalid-key-"));
    const authority = { pluginsDirectory: join(root, "plugins") };
    const inventory: Record<string, KnownMarketplace> = label === "reserved"
      ? { builtin: entry(authority.pluginsDirectory, "builtin") }
      : label === "invalid"
        ? { "bad/name": entry(authority.pluginsDirectory, "bad-name") }
        : label === "uppercase"
          ? { Team: entry(authority.pluginsDirectory, "Team") }
          : label === "digit-leading"
            ? { "1team": entry(authority.pluginsDirectory, "1team") }
            : label === "case collision"
              ? {
                  Team: entry(authority.pluginsDirectory, "Team"),
                  team: entry(authority.pluginsDirectory, "team"),
                }
              : {
                  "team.one": entry(authority.pluginsDirectory, "team-one"),
                  "team-one": entry(authority.pluginsDirectory, "team-one"),
                };
    await writeInventory(authority, inventory);

    await expect(loadKnownMarketplacesConfig(authority))
      .rejects.toThrow(message);
  });

  test("rejects manifest paths outside the marketplace install", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenc-marketplace-manifest-outside-"));
    const authority = { pluginsDirectory: join(root, "plugins") };
    const canonical = entry(authority.pluginsDirectory, "team");
    await mkdir(canonical.installLocation, { recursive: true });
    const outsideManifest = join(root, "outside", "marketplace.json");
    await mkdir(dirname(outsideManifest), { recursive: true });
    await writeFile(outsideManifest, '{"plugins":[]}\n', "utf8");
    await writeInventory(authority, {
      team: { ...canonical, manifestPath: outsideManifest },
    });

    await expect(loadKnownMarketplacesConfig(authority))
      .rejects.toThrow("manifestPath must stay inside");
  });

  test("rejects a manifest directory symlink that escapes the install", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenc-marketplace-symlink-escape-"));
    const authority = { pluginsDirectory: join(root, "plugins") };
    const canonical = entry(authority.pluginsDirectory, "team");
    await mkdir(canonical.installLocation, { recursive: true });
    const outsideManifestDir = join(root, "outside-manifest");
    await mkdir(outsideManifestDir, { recursive: true });
    await writeFile(
      join(outsideManifestDir, "marketplace.json"),
      '{"plugins":[]}\n',
      "utf8",
    );
    await symlink(
      outsideManifestDir,
      dirname(canonical.manifestPath),
      process.platform === "win32" ? "junction" : "dir",
    );
    await writeInventory(authority, { team: canonical });

    await expect(loadKnownMarketplacesConfig(authority))
      .rejects.toThrow("resolves outside");
  });

  test("rejects an install directory symlink that escapes marketplace storage", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenc-marketplace-install-symlink-"));
    const authority = { pluginsDirectory: join(root, "plugins") };
    const canonical = entry(authority.pluginsDirectory, "team");
    const outsideInstall = entry(join(root, "outside-storage"), "team");
    await materializeEntry(outsideInstall);
    await mkdir(dirname(canonical.installLocation), { recursive: true });
    await symlink(
      outsideInstall.installLocation,
      canonical.installLocation,
      process.platform === "win32" ? "junction" : "dir",
    );
    await writeInventory(authority, { team: canonical });

    await expect(loadKnownMarketplacesConfig(authority))
      .rejects.toThrow("installLocation");
  });

  test("rejects a marketplace storage symlink outside the plugin storage root", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenc-marketplace-root-symlink-"));
    const authority = { pluginsDirectory: join(root, "plugins") };
    const outsideMarketplaceRoot = join(root, "outside-marketplaces");
    await mkdir(authority.pluginsDirectory, { recursive: true });
    await mkdir(outsideMarketplaceRoot, { recursive: true });
    await symlink(
      outsideMarketplaceRoot,
      join(authority.pluginsDirectory, "marketplaces"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const canonical = entry(authority.pluginsDirectory, "team");
    await materializeEntry(canonical);
    await writeInventory(authority, { team: canonical });

    await expect(loadKnownMarketplacesConfig(authority))
      .rejects.toThrow("marketplace storage root resolves outside");
  });
});
