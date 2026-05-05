import {
  addMarketplaceOp,
  findMarketplaceName,
  loadMarketplace,
  marketplaceInstalledPath,
  readMarketplaceIndex,
  removeMarketplaceOp,
  upgradeMarketplaceOp,
  writeMarketplaceIndex,
  type Marketplace,
  type MarketplaceIndex,
  type MarketplaceOperationOptions,
  type MarketplaceRecord,
  type MarketplaceSource,
  type RawMarketplaceManifestPlugin,
} from "./marketplace.js";

export type KnownMarketplace = MarketplaceRecord;
export type KnownMarketplacesConfig = MarketplaceIndex["marketplaces"];

const marketplaceCache = new Map<string, Promise<Marketplace>>();

export function clearMarketplacesCache(): void {
  marketplaceCache.clear();
}

export async function loadKnownMarketplacesConfig(
  options: MarketplaceOperationOptions = {},
): Promise<KnownMarketplacesConfig> {
  return (await readMarketplaceIndex(options)).marketplaces;
}

export async function loadKnownMarketplacesConfigSafe(
  options: MarketplaceOperationOptions = {},
): Promise<KnownMarketplacesConfig> {
  try {
    return await loadKnownMarketplacesConfig(options);
  } catch {
    return {};
  }
}

export async function saveKnownMarketplacesConfig(
  config: KnownMarketplacesConfig,
  options: MarketplaceOperationOptions = {},
): Promise<void> {
  await writeMarketplaceIndex({ version: 1, marketplaces: config }, options);
}

export async function registerSeedMarketplaces(
  seedMarketplaces: Readonly<Record<string, KnownMarketplace>> = {},
  options: MarketplaceOperationOptions = {},
): Promise<boolean> {
  const current = await loadKnownMarketplacesConfig(options);
  let changed = false;
  const next: Record<string, KnownMarketplace> = { ...current };
  for (const [name, entry] of Object.entries(seedMarketplaces).sort(([a], [b]) => a.localeCompare(b))) {
    if (JSON.stringify(next[name]) === JSON.stringify(entry)) continue;
    next[name] = {
      ...entry,
      autoUpdate: false,
    };
    changed = true;
  }
  if (changed) {
    await saveKnownMarketplacesConfig(next, options);
    clearMarketplacesCache();
  }
  return changed;
}

export function getDeclaredMarketplaces(
  config: KnownMarketplacesConfig,
): Readonly<Record<string, { readonly source: MarketplaceSource; readonly autoUpdate?: boolean }>> {
  return Object.fromEntries(
    Object.entries(config).map(([name, entry]) => [
      name,
      {
        source: entry.sourceDescriptor,
        ...(entry.autoUpdate !== undefined ? { autoUpdate: entry.autoUpdate } : {}),
      },
    ]),
  );
}

export async function addMarketplaceSource(
  source: MarketplaceSource,
  onProgress?: (message: string) => void,
  options: MarketplaceOperationOptions = {},
): Promise<{
  readonly name: string;
  readonly alreadyMaterialized: boolean;
  readonly resolvedSource: MarketplaceSource;
}> {
  const existingConfig = await loadKnownMarketplacesConfig(options);
  for (const [name, entry] of Object.entries(existingConfig)) {
    if (JSON.stringify(entry.sourceDescriptor) === JSON.stringify(source)) {
      return { name, alreadyMaterialized: true, resolvedSource: source };
    }
  }
  const result = await addMarketplaceOp({
    ...options,
    source,
    force: true,
    onProgress,
  });
  clearMarketplacesCache();
  return {
    name: result.marketplace.name,
    alreadyMaterialized: false,
    resolvedSource: source,
  };
}

export async function removeMarketplaceSource(
  name: string,
  options: MarketplaceOperationOptions = {},
): Promise<void> {
  await removeMarketplaceOp({ ...options, name });
  clearMarketplacesCache();
}

export async function getMarketplaceCacheOnly(
  name: string,
  options: MarketplaceOperationOptions = {},
): Promise<Marketplace | null> {
  const config = await loadKnownMarketplacesConfigSafe(options);
  const matched = findMarketplaceName({ version: 1, marketplaces: config }, name);
  if (matched === undefined) return null;
  try {
    return await loadMarketplace(config[matched]!.manifestPath);
  } catch {
    return null;
  }
}

export function getMarketplace(
  name: string,
  options: MarketplaceOperationOptions = {},
): Promise<Marketplace> {
  const cacheKey = [
    marketplaceInstalledPath("cache-key", options).replace(/[/\\]cache-key$/u, ""),
    options.workspaceRoot ?? process.cwd(),
    name.toLowerCase(),
  ].join("\0");
  const cached = marketplaceCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const promise = (async () => {
    const config = await loadKnownMarketplacesConfig(options);
    const matched = findMarketplaceName({ version: 1, marketplaces: config }, name);
    if (matched === undefined) {
      throw new Error(
        `Marketplace '${name}' not found in configuration. Available marketplaces: ${Object.keys(config).join(", ")}`,
      );
    }
    try {
      return await loadMarketplace(config[matched]!.manifestPath);
    } catch {
      const result = await addMarketplaceOp({
        ...options,
        source: config[matched]!.sourceDescriptor,
        name: config[matched]!.name,
        force: true,
        autoUpdate: config[matched]!.autoUpdate,
      });
      return loadMarketplace(result.marketplace.manifestPath);
    }
  })();
  promise.catch(() => {
    if (marketplaceCache.get(cacheKey) === promise) {
      marketplaceCache.delete(cacheKey);
    }
  });
  marketplaceCache.set(cacheKey, promise);
  return promise;
}

export async function getPluginByIdCacheOnly(
  pluginId: string,
  options: MarketplaceOperationOptions = {},
): Promise<{
  readonly entry: RawMarketplaceManifestPlugin;
  readonly marketplaceInstallLocation: string;
} | null> {
  const parsed = parsePluginId(pluginId);
  if (parsed === null) return null;
  const marketplace = await getMarketplaceCacheOnly(parsed.marketplace, options);
  if (marketplace === null) return null;
  const raw = await readRawPluginFromManifest(marketplace.path, parsed.name);
  if (raw === null) return null;
  return {
    entry: raw,
    marketplaceInstallLocation: marketplace.root,
  };
}

export async function getPluginById(
  pluginId: string,
  options: MarketplaceOperationOptions = {},
): Promise<{
  readonly entry: RawMarketplaceManifestPlugin;
  readonly marketplaceInstallLocation: string;
} | null> {
  const cached = await getPluginByIdCacheOnly(pluginId, options);
  if (cached !== null) return cached;
  const parsed = parsePluginId(pluginId);
  if (parsed === null) return null;
  const marketplace = await getMarketplace(parsed.marketplace, options).catch(() => null);
  if (marketplace === null) return null;
  const raw = await readRawPluginFromManifest(marketplace.path, parsed.name);
  if (raw === null) return null;
  return {
    entry: raw,
    marketplaceInstallLocation: marketplace.root,
  };
}

export async function refreshAllMarketplaces(
  options: MarketplaceOperationOptions = {},
): Promise<void> {
  await upgradeMarketplaceOp(options);
  clearMarketplacesCache();
}

export async function refreshMarketplace(
  name: string,
  onProgress?: (message: string) => void,
  options: MarketplaceOperationOptions = {},
): Promise<void> {
  await upgradeMarketplaceOp({ ...options, name, onProgress });
  clearMarketplacesCache();
}

export async function setMarketplaceAutoUpdate(
  name: string,
  autoUpdate: boolean,
  options: MarketplaceOperationOptions = {},
): Promise<void> {
  const index = await readMarketplaceIndex(options);
  const matched = findMarketplaceName(index, name);
  if (matched === undefined) {
    throw new Error(`Marketplace '${name}' not found. Available marketplaces: ${Object.keys(index.marketplaces).join(", ")}`);
  }
  const existing = index.marketplaces[matched]!;
  if (existing.autoUpdate === autoUpdate) return;
  await writeMarketplaceIndex({
    version: 1,
    marketplaces: {
      ...index.marketplaces,
      [matched]: {
        ...existing,
        autoUpdate,
      },
    },
  }, options);
}

export function marketplaceInstallLocation(
  name: string,
  options: MarketplaceOperationOptions = {},
): string {
  return marketplaceInstalledPath(name, options);
}

async function readRawPluginFromManifest(
  manifestPath: string,
  pluginName: string,
): Promise<RawMarketplaceManifestPlugin | null> {
  const { readFile } = await import("node:fs/promises");
  const parsed = JSON.parse(await readFile(manifestPath, "utf8")) as { readonly plugins?: unknown };
  if (!Array.isArray(parsed.plugins)) return null;
  for (const plugin of parsed.plugins) {
    if (
      typeof plugin === "object" &&
      plugin !== null &&
      "name" in plugin &&
      (plugin as { readonly name?: unknown }).name === pluginName
    ) {
      return plugin as RawMarketplaceManifestPlugin;
    }
  }
  return null;
}

function parsePluginId(pluginId: string): { readonly name: string; readonly marketplace: string } | null {
  const at = pluginId.lastIndexOf("@");
  if (at <= 0 || at === pluginId.length - 1) return null;
  return {
    name: pluginId.slice(0, at),
    marketplace: pluginId.slice(at + 1),
  };
}
