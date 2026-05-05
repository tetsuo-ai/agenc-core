import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getPluginSeedDirs } from "../directories.js";
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
  type MarketplaceSourceType,
  type RawMarketplaceManifestPlugin,
} from "./marketplace.js";

export type KnownMarketplace = MarketplaceRecord;
export type KnownMarketplacesConfig = MarketplaceIndex["marketplaces"];

const marketplaceCache = new Map<string, Promise<Marketplace>>();
const SEED_MARKETPLACE_INDEX_FILE = "known_marketplaces.json";
const SEED_MARKETPLACE_MANIFEST_RELATIVE_PATHS = [
  "marketplace.json",
  ".agents/plugins/marketplace.json",
  ".agenc-plugin/marketplace.json",
] as const;

export interface DeclaredMarketplace {
  readonly source: string | MarketplaceSource;
  readonly autoUpdate?: boolean;
  readonly sourceIsFallback?: boolean;
}

export interface MarketplaceDiff {
  readonly missing: readonly string[];
  readonly sourceChanged: readonly {
    readonly name: string;
    readonly declared: DeclaredMarketplace;
    readonly materialized: MarketplaceRecord;
  }[];
  readonly upToDate: readonly string[];
}

export type MarketplaceReconcileProgress =
  | { readonly type: "installing"; readonly name: string }
  | { readonly type: "installed"; readonly name: string }
  | { readonly type: "failed"; readonly name: string; readonly error: string };

export interface ReconcileMarketplacesOptions extends MarketplaceOperationOptions {
  readonly declaredMarketplaces?: Readonly<Record<string, DeclaredMarketplace>>;
  readonly onMarketplaceProgress?: (event: MarketplaceReconcileProgress) => void;
}

export interface MarketplaceReconcileResult {
  readonly installed: readonly MarketplaceRecord[];
  readonly updated: readonly MarketplaceRecord[];
  readonly failed: readonly { readonly name: string; readonly error: string }[];
  readonly upToDate: readonly string[];
}

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
  seedMarketplaces: Readonly<Record<string, KnownMarketplace>> | undefined = undefined,
  options: MarketplaceOperationOptions = {},
): Promise<boolean> {
  const seeds = seedMarketplaces ?? await loadSeedMarketplaces(options);
  const current = await loadKnownMarketplacesConfig(options);
  let changed = false;
  const next: Record<string, KnownMarketplace> = { ...current };
  for (const [name, entry] of Object.entries(seeds).sort(([a], [b]) => a.localeCompare(b))) {
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

export async function loadSeedMarketplaces(
  options: MarketplaceOperationOptions = {},
): Promise<Readonly<Record<string, KnownMarketplace>>> {
  const seedDirs = getPluginSeedDirs(options.env);
  const seeds: Record<string, KnownMarketplace> = {};
  const claimed = new Set<string>();
  for (const seedDir of seedDirs) {
    const config = await readSeedKnownMarketplaces(seedDir);
    if (config === null) continue;
    for (const [name, rawEntry] of Object.entries(config)) {
      if (claimed.has(name)) continue;
      const location = await findSeedMarketplaceLocation(seedDir, name);
      if (location === null) continue;
      const sourceDescriptor = normalizeSeedMarketplaceSource(rawEntry, location.installedPath);
      seeds[name] = {
        name,
        source: displaySeedMarketplaceSource(sourceDescriptor),
        sourceType: seedMarketplaceSourceType(sourceDescriptor),
        sourceDescriptor,
        installedPath: location.installedPath,
        manifestPath: location.manifestPath,
        ...(sourceDescriptor.source === "git" && sourceDescriptor.ref !== undefined
          ? { ref: sourceDescriptor.ref }
          : {}),
        ...(sourceDescriptor.source === "git" && sourceDescriptor.sparse !== undefined
          ? { sparse: sourceDescriptor.sparse }
          : {}),
        ...(sourceDescriptor.source === "github" && sourceDescriptor.ref !== undefined
          ? { ref: sourceDescriptor.ref }
          : {}),
        ...(sourceDescriptor.source === "github" && sourceDescriptor.path !== undefined
          ? { sparse: sourceDescriptor.path }
          : {}),
        autoUpdate: false,
        updatedAt: seedMarketplaceUpdatedAt(rawEntry),
      };
      claimed.add(name);
    }
  }
  return seeds;
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

export function diffMarketplaces(
  declared: Readonly<Record<string, DeclaredMarketplace>>,
  materialized: KnownMarketplacesConfig,
): MarketplaceDiff {
  const missing: string[] = [];
  const sourceChanged: Array<{
    readonly name: string;
    readonly declared: DeclaredMarketplace;
    readonly materialized: MarketplaceRecord;
  }> = [];
  const upToDate: string[] = [];
  for (const [name, declaration] of Object.entries(declared).sort(([a], [b]) => a.localeCompare(b))) {
    const existingName = findMarketplaceName({ version: 1, marketplaces: materialized }, name);
    if (existingName === undefined) {
      missing.push(name);
      continue;
    }
    const existing = materialized[existingName]!;
    if (declaration.sourceIsFallback || marketplaceDeclarationMatches(existing, declaration)) {
      upToDate.push(existingName);
      continue;
    }
    sourceChanged.push({ name: existingName, declared: declaration, materialized: existing });
  }
  return { missing, sourceChanged, upToDate };
}

export async function reconcileMarketplaces(
  options: ReconcileMarketplacesOptions = {},
): Promise<MarketplaceReconcileResult> {
  const declared = options.declaredMarketplaces ?? {};
  const materialized = await loadKnownMarketplacesConfigSafe(options);
  const diff = diffMarketplaces(declared, materialized);
  const installed: MarketplaceRecord[] = [];
  const updated: MarketplaceRecord[] = [];
  const failed: Array<{ readonly name: string; readonly error: string }> = [];
  const targets = [
    ...diff.missing.map((name) => ({
      name,
      kind: "installed" as const,
      declaration: declared[name]!,
    })),
    ...diff.sourceChanged.map((entry) => ({
      name: entry.name,
      kind: "updated" as const,
      declaration: entry.declared,
    })),
  ];
  for (const target of targets) {
    options.onMarketplaceProgress?.({ type: "installing", name: target.name });
    try {
      const result = await addMarketplaceOp({
        ...options,
        source: target.declaration.source,
        name: target.name,
        force: true,
        ...(target.declaration.autoUpdate !== undefined
          ? { autoUpdate: target.declaration.autoUpdate }
          : {}),
      });
      if (target.kind === "installed") {
        installed.push(result.marketplace);
      } else {
        updated.push(result.marketplace);
      }
      options.onMarketplaceProgress?.({ type: "installed", name: target.name });
    } catch (error) {
      const failure = { name: target.name, error: message(error) };
      failed.push(failure);
      options.onMarketplaceProgress?.({
        type: "failed",
        name: target.name,
        error: failure.error,
      });
    }
  }
  if (installed.length > 0 || updated.length > 0) {
    clearMarketplacesCache();
  }
  return { installed, updated, failed, upToDate: diff.upToDate };
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

async function readSeedKnownMarketplaces(
  seedDir: string,
): Promise<Readonly<Record<string, unknown>> | null> {
  try {
    const parsed = JSON.parse(
      await readFile(join(seedDir, SEED_MARKETPLACE_INDEX_FILE), "utf8"),
    ) as unknown;
    if (isRecord(parsed) && isRecord(parsed.marketplaces)) {
      return objectEntriesOnly(parsed.marketplaces);
    }
    if (isRecord(parsed)) {
      return objectEntriesOnly(parsed);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      // Seed dirs are administrator-managed and optional. Ignore invalid seeds
      // so a later seed dir can still provide a working marketplace.
    }
  }
  return null;
}

async function findSeedMarketplaceLocation(
  seedDir: string,
  name: string,
): Promise<{ readonly installedPath: string; readonly manifestPath: string } | null> {
  const marketplaceRoot = join(seedDir, "marketplaces", name);
  for (const relativePath of SEED_MARKETPLACE_MANIFEST_RELATIVE_PATHS) {
    const manifestPath = join(marketplaceRoot, relativePath);
    if (await marketplaceManifestLoads(manifestPath)) {
      return { installedPath: marketplaceRoot, manifestPath };
    }
  }
  const jsonMarketplace = join(seedDir, "marketplaces", `${name}.json`);
  if (await marketplaceManifestLoads(jsonMarketplace)) {
    return { installedPath: jsonMarketplace, manifestPath: jsonMarketplace };
  }
  return null;
}

async function marketplaceManifestLoads(manifestPath: string): Promise<boolean> {
  try {
    await loadMarketplace(manifestPath);
    return true;
  } catch {
    return false;
  }
}

function normalizeSeedMarketplaceSource(rawEntry: unknown, installedPath: string): MarketplaceSource {
  if (isRecord(rawEntry)) {
    if (isMarketplaceSource(rawEntry.sourceDescriptor)) return rawEntry.sourceDescriptor;
    if (isMarketplaceSource(rawEntry.source)) return rawEntry.source;
  }
  return { source: "local", path: installedPath };
}

function displaySeedMarketplaceSource(source: MarketplaceSource): string {
  switch (source.source) {
    case "local":
    case "file":
    case "directory":
      return source.path;
    case "git":
      return source.url;
    case "github":
      return source.repo;
    case "url":
      return source.url;
    case "settings":
      return source.name;
  }
}

function seedMarketplaceSourceType(source: MarketplaceSource): MarketplaceSourceType {
  switch (source.source) {
    case "git":
    case "github":
      return "git";
    case "url":
      return "url";
    case "settings":
      return "settings";
    case "local":
    case "file":
    case "directory":
      return "local";
  }
}

function seedMarketplaceUpdatedAt(rawEntry: unknown): string {
  if (isRecord(rawEntry)) {
    if (typeof rawEntry.updatedAt === "string" && rawEntry.updatedAt.trim().length > 0) {
      return rawEntry.updatedAt;
    }
    if (typeof rawEntry.lastUpdated === "string" && rawEntry.lastUpdated.trim().length > 0) {
      return rawEntry.lastUpdated;
    }
  }
  return "1970-01-01T00:00:00.000Z";
}

function objectEntriesOnly(
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => isRecord(entry)),
  );
}

function parsePluginId(pluginId: string): { readonly name: string; readonly marketplace: string } | null {
  const at = pluginId.lastIndexOf("@");
  if (at <= 0 || at === pluginId.length - 1) return null;
  return {
    name: pluginId.slice(0, at),
    marketplace: pluginId.slice(at + 1),
  };
}

function marketplaceDeclarationMatches(
  existing: MarketplaceRecord,
  declaration: DeclaredMarketplace,
): boolean {
  return JSON.stringify(existing.sourceDescriptor) === JSON.stringify(declaration.source) &&
    (declaration.autoUpdate === undefined || existing.autoUpdate === declaration.autoUpdate);
}

function isMarketplaceSource(value: unknown): value is MarketplaceSource {
  if (!isRecord(value) || typeof value.source !== "string") return false;
  return ["local", "file", "directory", "git", "github", "url", "settings"].includes(value.source);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
