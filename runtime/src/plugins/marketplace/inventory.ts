/**
 * Canonical marketplace inventory repository.
 *
 * `known_marketplaces.json` is plugin inventory/state, not operator settings.
 * This module is the only parser and writer for that file. It deliberately
 * performs no acquisition, refresh, migration, path probing, or package
 * mutation; marketplace operations live in `marketplace.ts` and commit their
 * validated result through this repository.
 */

import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import * as lockfile from "../../utils/lockfile.js";
import { z } from "zod/v4";

import {
  ConfigParseError,
  errorMessage,
  isENOENT,
} from "../../utils/errors.js";
import { duplicateJsonObjectPaths } from "../../config/json.js";
import { writeDurableAtomicFile } from "../../utils/durable-atomic-file.js";
import { getFsImplementation } from "../../utils/fsOperations.js";
import {
  jsonParse,
} from "../../utils/slowOperations.js";
import { getPluginsDirectory } from "../../utils/plugins/pluginDirectories.js";
import { parsePluginIdentifier } from "../identifier.js";
import {
  MarketplaceSourceSchema,
  type PluginMarketplace,
  type PluginMarketplaceEntry,
  PluginMarketplaceSchema,
} from "../../utils/plugins/schemas.js";

const KnownMarketplaceSchema = z.object({
  source: MarketplaceSourceSchema().describe(
    "Where to fetch the marketplace from",
  ),
  installLocation: z.string().refine(isAbsolute, {
    message:
      "Stored marketplace installLocation must be absolute; remove and re-add this marketplace",
  }),
  manifestPath: z.string().refine(isAbsolute, {
    message:
      "Stored marketplace manifestPath must be absolute; remove and re-add this marketplace",
  }),
  lastUpdated: z.string(),
  autoUpdate: z.boolean().optional(),
  revision: z.string().optional(),
  refreshable: z.boolean().optional(),
}).strict().superRefine((entry, context) => {
  if (
    entry.source.source === "hostPattern" ||
    entry.source.source === "pathPattern"
  ) {
    context.addIssue({
      code: "custom",
      path: ["source", "source"],
      message:
        "Policy matchers are not installable marketplace sources; remove and re-add this marketplace",
    });
  }
  if (
    (entry.source.source === "file" || entry.source.source === "directory") &&
    !isAbsolute(entry.source.path)
  ) {
    context.addIssue({
      code: "custom",
      path: ["source", "path"],
      message:
        "Stored local marketplace source paths must be absolute; remove and re-add this marketplace from the original directory",
    });
  }
});

const KnownMarketplacesFileSchema = z.record(
  z.string(),
  KnownMarketplaceSchema,
);

export type KnownMarketplace = z.infer<typeof KnownMarketplaceSchema>;
export type MarketplaceInventory = z.infer<
  typeof KnownMarketplacesFileSchema
>;

export interface MarketplaceInventoryAuthority {
  /** Exact `$AGENC_HOME/plugins` root selected at an ingress boundary. */
  readonly pluginsDirectory?: string;
}

export interface MarketplaceInventoryMutationAuthority {
  /** Exact `$AGENC_HOME/plugins` root selected at an ingress boundary. */
  readonly pluginsDirectory: string;
}

export function getKnownMarketplacesFilePath(
  authority: MarketplaceInventoryAuthority = {},
): string {
  return join(
    authority.pluginsDirectory ?? getPluginsDirectory(),
    "known_marketplaces.json",
  );
}

function getRetiredMarketplaceIndexPath(
  authority: MarketplaceInventoryAuthority,
): string {
  const pluginsDirectory = authority.pluginsDirectory ?? getPluginsDirectory();
  return join(pluginsDirectory, "marketplaces", "marketplaces.json");
}

async function assertNoRetiredMarketplaceIndex(
  authority: MarketplaceInventoryAuthority,
): Promise<void> {
  const retiredPath = getRetiredMarketplaceIndexPath(authority);
  try {
    await getFsImplementation().stat(retiredPath);
  } catch (error) {
    if (isENOENT(error)) return;
    throw new Error(
      `Failed to inspect retired marketplace index at ${retiredPath}: ${errorMessage(error)}`,
    );
  }
  throw new Error(
    `Retired marketplace index detected at ${retiredPath}. AgenC will not ` +
      "merge it with known_marketplaces.json. Remove its marketplaces with " +
      "the previous AgenC version or move the file aside, then re-add each " +
      "source with `agenc plugin marketplace add <source>`.",
  );
}

function parseMarketplaceInventory(
  data: unknown,
  filePath: string,
): MarketplaceInventory {
  const parsed = KnownMarketplacesFileSchema.safeParse(data);
  if (!parsed.success) {
    throw new ConfigParseError(
      `Marketplace inventory is invalid at ${filePath}: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join(", ")}. Remove and re-add the affected marketplace with ` +
        "`agenc plugin marketplace remove <name>` followed by " +
        "`agenc plugin marketplace add <source>`; AgenC will not reinterpret " +
        "or migrate this file during startup.",
      filePath,
      data,
    );
  }
  return parsed.data;
}

function parseMarketplaceInventoryText(
  content: string,
  filePath: string,
): MarketplaceInventory {
  const duplicatePaths = duplicateJsonObjectPaths(content);
  if (duplicatePaths.length > 0) {
    throw new ConfigParseError(
      `Marketplace inventory contains duplicate object keys at ${filePath}: ` +
        `${duplicatePaths.join(", ")}. Remove and re-add the affected ` +
        "marketplace; AgenC will not choose between duplicate entries.",
      filePath,
      undefined,
    );
  }
  try {
    return parseMarketplaceInventory(jsonParse(content), filePath);
  } catch (error) {
    if (error instanceof ConfigParseError) throw error;
    throw new ConfigParseError(
      `Marketplace inventory JSON is invalid at ${filePath}: ${errorMessage(error)}`,
      filePath,
      undefined,
    );
  }
}

export async function loadKnownMarketplacesConfig(
  authority: MarketplaceInventoryAuthority = {},
): Promise<MarketplaceInventory> {
  await assertNoRetiredMarketplaceIndex(authority);
  const filePath = getKnownMarketplacesFilePath(authority);
  try {
    const content = await getFsImplementation().readFile(filePath, {
      encoding: "utf-8",
    });
    return parseMarketplaceInventoryText(content, filePath);
  } catch (error) {
    if (isENOENT(error)) return {};
    if (error instanceof ConfigParseError) throw error;
    throw new Error(
      `Failed to load marketplace inventory at ${filePath}: ${errorMessage(error)}`,
    );
  }
}

export interface MarketplaceInventoryMutation<R> {
  readonly inventory: MarketplaceInventory;
  readonly result: R;
}

const INVENTORY_LOCK_OPTIONS = Object.freeze({
  realpath: false,
  stale: 30_000,
  retries: Object.freeze({
    retries: 20,
    factor: 1.35,
    minTimeout: 10,
    maxTimeout: 250,
    randomize: true,
  }),
});

/**
 * Serialize a complete inventory read-modify-write transaction by canonical
 * plugins root. The callback runs while the cross-process lock is held; its
 * validated result is committed with fsync + same-directory atomic rename.
 */
export async function updateMarketplaceInventory<R>(
  authority: MarketplaceInventoryMutationAuthority,
  operation: (
    current: MarketplaceInventory,
  ) => Promise<MarketplaceInventoryMutation<R>> | MarketplaceInventoryMutation<R>,
): Promise<R> {
  const filePath = getKnownMarketplacesFilePath(authority);
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  const release = await lockfile.lock(filePath, {
    ...INVENTORY_LOCK_OPTIONS,
    lockfilePath: `${filePath}.agenc-marketplace-inventory.lock`,
  });
  try {
    const current = await loadKnownMarketplacesConfig(authority);
    const mutation = await operation(current);
    const inventory = parseMarketplaceInventory(mutation.inventory, filePath);
    const temporaryPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
    await writeDurableAtomicFile(
      filePath,
      temporaryPath,
      `${JSON.stringify(inventory, null, 2)}\n`,
      0o600,
    );
    return mutation.result;
  } finally {
    await release();
  }
}

async function readCachedMarketplace(
  manifestPath: string,
): Promise<PluginMarketplace> {
  const content = await getFsImplementation().readFile(manifestPath, {
    encoding: "utf-8",
  });
  const duplicatePaths = duplicateJsonObjectPaths(content);
  if (duplicatePaths.length > 0) {
    throw new ConfigParseError(
      `Marketplace manifest contains duplicate object keys at ${manifestPath}: ` +
        `${duplicatePaths.join(", ")}. Re-add the marketplace from a ` +
        "corrected source; AgenC will not choose between duplicate declarations.",
      manifestPath,
      undefined,
    );
  }
  let data: unknown;
  try {
    data = jsonParse(content);
  } catch (error) {
    throw new ConfigParseError(
      `Invalid marketplace JSON at ${manifestPath}: ${errorMessage(error)}`,
      manifestPath,
      content,
    );
  }
  const parsed = PluginMarketplaceSchema().safeParse(data);
  if (!parsed.success) {
    throw new ConfigParseError(
      `Invalid marketplace schema at ${manifestPath}: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join(", ")}`,
      manifestPath,
      data,
    );
  }
  return parsed.data;
}

/** Read a catalog from the exact manifest path recorded in inventory. */
export async function getMarketplaceCacheOnly(
  name: string,
  authority: MarketplaceInventoryAuthority = {},
): Promise<PluginMarketplace | null> {
  const inventory = await loadKnownMarketplacesConfig(authority);
  const entry = inventory[name];
  if (entry === undefined) return null;
  try {
    return await readCachedMarketplace(entry.manifestPath);
  } catch (error) {
    if (error instanceof ConfigParseError) throw error;
    if (isENOENT(error)) return null;
    throw error;
  }
}

/**
 * Required read-only catalog lookup. Missing/corrupt cache never triggers an
 * implicit network refresh or alternate-path probe.
 */
export async function getMarketplace(
  name: string,
  authority: MarketplaceInventoryAuthority = {},
): Promise<PluginMarketplace> {
  const inventory = await loadKnownMarketplacesConfig(authority);
  const entry = inventory[name];
  if (entry === undefined) {
    throw new Error(
      `Marketplace '${name}' is not registered. Available marketplaces: ${Object.keys(inventory).join(", ")}`,
    );
  }
  try {
    return await readCachedMarketplace(entry.manifestPath);
  } catch (error) {
    throw new Error(
      `Marketplace '${name}' is unavailable at its recorded manifest path ` +
        `${entry.manifestPath}: ${errorMessage(error)}. Re-add it with ` +
        "`agenc plugin marketplace add <source>`; AgenC will not fetch or " +
        "infer another cache location during ordinary loading.",
    );
  }
}

export interface MarketplacePluginLookup {
  readonly entry: PluginMarketplaceEntry;
  readonly marketplaceInstallLocation: string;
}

export async function getPluginByIdCacheOnly(
  pluginId: string,
  authority: MarketplaceInventoryAuthority = {},
): Promise<MarketplacePluginLookup | null> {
  const { name: pluginName, marketplace: marketplaceName } =
    parsePluginIdentifier(pluginId);
  if (!pluginName || !marketplaceName) return null;
  const inventory = await loadKnownMarketplacesConfig(authority);
  const marketplaceEntry = inventory[marketplaceName];
  if (marketplaceEntry === undefined) return null;
  const marketplace = await getMarketplaceCacheOnly(marketplaceName, authority);
  const entry = marketplace?.plugins.find((plugin) => plugin.name === pluginName);
  return entry === undefined
    ? null
    : {
        entry,
        marketplaceInstallLocation: marketplaceEntry.installLocation,
      };
}
