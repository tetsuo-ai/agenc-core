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
import { dirname, isAbsolute, join, relative, sep } from "node:path";
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
import { normalizeExactAbsolutePath } from "../../utils/path-authority.js";
import { isRecord } from "../../utils/record.js";
import { jsonParse } from "../../utils/slowOperations.js";
import {
  pluginInventoryPath,
  pluginMarketplaceRootPath,
  resolvePluginStorageAuthority,
  sanitizePluginId,
  type PluginStorageAuthority,
} from "../directories.js";
import { isCanonicalMarketplaceName } from "../identifier.js";
import {
  pluginSourceNeedsRedaction,
  redactPluginSource,
} from "../resolution.js";
import { MarketplaceSourceSchema } from "../../utils/plugins/schemas.js";

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

const RESERVED_MARKETPLACE_NAMES = new Set(["agenc", "builtin", "curated"]);

export type KnownMarketplace = z.infer<typeof KnownMarketplaceSchema>;
export type MarketplaceInventory = z.infer<
  typeof KnownMarketplacesFileSchema
>;

export interface MarketplaceInventoryAuthority {
  /** Exact plugin storage root selected at an ingress boundary. */
  readonly pluginsDirectory?: string;
}

export interface MarketplaceInventoryMutationAuthority {
  /** Exact plugin storage root selected at an ingress boundary. */
  readonly pluginsDirectory: string;
}

interface SanitizedMarketplaceInventory {
  readonly inventory: MarketplaceInventory;
  readonly changed: boolean;
}

function sanitizeMarketplaceInventory(
  inventory: MarketplaceInventory,
): SanitizedMarketplaceInventory {
  let changed = false;
  const entries = Object.entries(inventory).map(([name, entry]) => {
    const source = entry.source;
    if (source.source !== "url" && source.source !== "git") {
      return [name, entry] as const;
    }

    const urlNeedsRedaction = pluginSourceNeedsRedaction(source.url);
    const hasHeaders = source.source === "url" &&
      source.headers !== undefined &&
      Object.keys(source.headers).length > 0;
    const hasEmptyHeaders = source.source === "url" &&
      source.headers !== undefined &&
      Object.keys(source.headers).length === 0;
    if (!urlNeedsRedaction && !hasHeaders && !hasEmptyHeaders) {
      return [name, entry] as const;
    }

    changed = true;
    const persistedUrl = urlNeedsRedaction
      ? redactPluginSource(source.url)
      : source.url;
    const sanitizedSource = source.source === "url"
      ? {
          source: "url" as const,
          url: persistedUrl,
        }
      : {
          ...source,
          url: persistedUrl,
        };
    return [name, {
      ...entry,
      source: sanitizedSource,
      ...((urlNeedsRedaction || hasHeaders) ? { refreshable: false } : {}),
    }] as const;
  });
  return {
    inventory: changed ? Object.fromEntries(entries) : inventory,
    changed,
  };
}

/** Normalize a user-facing marketplace name without changing its identity. */
export function normalizeMarketplaceName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new Error("marketplace name cannot be empty");
  }
  if (trimmed.length > 128 || !isCanonicalMarketplaceName(trimmed)) {
    throw new Error(
      "marketplace name must be a lowercase canonical segment starting with a letter and using only letters, digits, '.', '_', or '-'",
    );
  }
  if (RESERVED_MARKETPLACE_NAMES.has(trimmed.toLowerCase())) {
    throw new Error(`marketplace name is reserved: ${trimmed}`);
  }
  return trimmed;
}

/** Derive the only filesystem child name used for a marketplace. */
export function sanitizeMarketplaceInstallName(name: string): string {
  return sanitizePluginId(normalizeMarketplaceName(name));
}

export function getKnownMarketplacesFilePath(
  authority: MarketplaceInventoryAuthority = {},
): string {
  return pluginInventoryPath(
    resolvePluginStorageAuthority(authority.pluginsDirectory),
  );
}

function parseMarketplaceInventory(
  data: unknown,
  filePath: string,
  storageAuthority: PluginStorageAuthority,
): MarketplaceInventory {
  const parsed = KnownMarketplacesFileSchema.safeParse(data);
  if (!parsed.success) {
    invalidMarketplaceInventory(
      `${parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join(", ")}`,
      filePath,
      data,
    );
  }
  validateMarketplaceInventoryNames(parsed.data, filePath, data);
  validateMarketplaceInventoryPaths(
    parsed.data,
    filePath,
    data,
    storageAuthority,
  );
  return parsed.data;
}

function invalidMarketplaceInventory(
  detail: string,
  filePath: string,
  data: unknown,
): never {
  throw new ConfigParseError(
    `Marketplace inventory is invalid at ${filePath}: ${detail}. To remove one ` +
      "malformed entry stored under an exact canonical name, run `agenc plugin " +
      "marketplace remove <name>`. For invalid keys, duplicate keys, or damage " +
      "outside that entry, move this file aside and re-add the marketplaces. " +
      "AgenC will not reinterpret or migrate this file during startup.",
    filePath,
    data,
  );
}

function validateMarketplaceInventoryNames(
  inventory: MarketplaceInventory,
  filePath: string,
  data: unknown,
): void {
  const names = new Map<string, string>();
  const storageNames = new Map<string, string>();
  for (const name of Object.keys(inventory)) {
    const identity = name.toLowerCase();
    const existingName = names.get(identity);
    if (existingName !== undefined) {
      invalidMarketplaceInventory(
        `marketplace key '${name}' differs only by case from '${existingName}'`,
        filePath,
        data,
      );
    }
    names.set(identity, name);
  }

  for (const name of Object.keys(inventory)) {
    let normalized: string;
    try {
      normalized = normalizeMarketplaceName(name);
    } catch (error) {
      invalidMarketplaceInventory(
        `marketplace key '${name}' is invalid: ${errorMessage(error)}`,
        filePath,
        data,
      );
    }
    if (normalized !== name) {
      invalidMarketplaceInventory(
        `marketplace key '${name}' must be stored exactly as '${normalized}'`,
        filePath,
        data,
      );
    }

    const storageName = sanitizeMarketplaceInstallName(normalized)
      .toLowerCase();
    const existingStorageName = storageNames.get(storageName);
    if (existingStorageName !== undefined) {
      invalidMarketplaceInventory(
        `marketplace keys '${existingStorageName}' and '${name}' resolve to the same storage name`,
        filePath,
        data,
      );
    }
    storageNames.set(storageName, normalized);
  }
}

function validateMarketplaceInventoryPaths(
  inventory: MarketplaceInventory,
  filePath: string,
  data: unknown,
  storageAuthority: PluginStorageAuthority,
): void {
  const entries = Object.entries(inventory);
  if (entries.length === 0) return;

  const fs = getFsImplementation();
  const marketplaceRoot = pluginMarketplaceRootPath(storageAuthority);
  for (const [name, entry] of entries) {
    const storageName = sanitizeMarketplaceInstallName(name);
    const expectedInstallLocation = join(marketplaceRoot, storageName);
    if (entry.installLocation !== expectedInstallLocation) {
      invalidMarketplaceInventory(
        `installLocation for marketplace key '${name}' must be exactly ${expectedInstallLocation}`,
        filePath,
        data,
      );
    }

    let normalizedManifestPath: string;
    try {
      normalizedManifestPath = normalizeExactAbsolutePath(
        entry.manifestPath,
        `manifestPath for marketplace key '${name}'`,
      );
    } catch (error) {
      invalidMarketplaceInventory(errorMessage(error), filePath, data);
    }
    if (normalizedManifestPath !== entry.manifestPath) {
      invalidMarketplaceInventory(
        `manifestPath for marketplace key '${name}' must be stored as the exact normalized path ${normalizedManifestPath}`,
        filePath,
        data,
      );
    }
    if (!pathIsStrictlyInside(normalizedManifestPath, expectedInstallLocation)) {
      invalidMarketplaceInventory(
        `manifestPath must stay inside installLocation for marketplace key '${name}'`,
        filePath,
        data,
      );
    }
  }

  let storageRootReal: string;
  let marketplaceRootReal: string;
  try {
    storageRootReal = fs.realpathSync(storageAuthority.pluginStorageRoot);
    if (!fs.statSync(storageRootReal).isDirectory()) {
      invalidMarketplaceInventory(
        `plugin storage root is not a directory: ${storageAuthority.pluginStorageRoot}`,
        filePath,
        data,
      );
    }
    marketplaceRootReal = fs.realpathSync(marketplaceRoot);
    const expectedMarketplaceRootReal = join(
      storageRootReal,
      "marketplaces",
    );
    if (marketplaceRootReal !== expectedMarketplaceRootReal) {
      invalidMarketplaceInventory(
        `marketplace storage root resolves outside the selected plugin storage root: ${marketplaceRoot}`,
        filePath,
        data,
      );
    }
    if (!fs.statSync(marketplaceRootReal).isDirectory()) {
      invalidMarketplaceInventory(
        `marketplace storage root is not a directory: ${marketplaceRoot}`,
        filePath,
        data,
      );
    }
  } catch (error) {
    if (error instanceof ConfigParseError) throw error;
    invalidMarketplaceInventory(
      `cannot resolve marketplace storage under the selected plugin storage root: ${errorMessage(error)}`,
      filePath,
      data,
    );
  }

  for (const [name, entry] of entries) {
    const storageName = sanitizeMarketplaceInstallName(name);
    try {
      const installLocationReal = fs.realpathSync(entry.installLocation);
      const expectedInstallLocationReal = join(
        marketplaceRootReal,
        storageName,
      );
      if (installLocationReal !== expectedInstallLocationReal) {
        invalidMarketplaceInventory(
          `installLocation for marketplace key '${name}' resolves outside its canonical marketplace directory`,
          filePath,
          data,
        );
      }
      if (!fs.statSync(installLocationReal).isDirectory()) {
        invalidMarketplaceInventory(
          `installLocation for marketplace key '${name}' is not a directory`,
          filePath,
          data,
        );
      }

      const manifestPathReal = fs.realpathSync(entry.manifestPath);
      if (!pathIsStrictlyInside(manifestPathReal, installLocationReal)) {
        invalidMarketplaceInventory(
          `manifestPath for marketplace key '${name}' resolves outside installLocation`,
          filePath,
          data,
        );
      }
      if (!fs.statSync(manifestPathReal).isFile()) {
        invalidMarketplaceInventory(
          `manifestPath for marketplace key '${name}' is not a file`,
          filePath,
          data,
        );
      }
    } catch (error) {
      if (error instanceof ConfigParseError) throw error;
      invalidMarketplaceInventory(
        `cannot resolve the stored paths for marketplace key '${name}': ${errorMessage(error)}`,
        filePath,
        data,
      );
    }
  }
}

function pathIsStrictlyInside(candidate: string, boundary: string): boolean {
  const pathFromBoundary = relative(boundary, candidate);
  return pathFromBoundary.length > 0 &&
    pathFromBoundary !== ".." &&
    !pathFromBoundary.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromBoundary);
}

function parseMarketplaceInventoryText(
  content: string,
  filePath: string,
  storageAuthority: PluginStorageAuthority,
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
    return parseMarketplaceInventory(
      jsonParse(content),
      filePath,
      storageAuthority,
    );
  } catch (error) {
    if (error instanceof ConfigParseError) throw error;
    throw new ConfigParseError(
      `Marketplace inventory JSON is invalid at ${filePath}: ${errorMessage(error)}`,
      filePath,
      undefined,
    );
  }
}

async function loadKnownMarketplacesConfigUnlocked(
  storageAuthority: PluginStorageAuthority,
  filePath: string,
): Promise<MarketplaceInventory> {
  try {
    const content = await getFsImplementation().readFile(filePath, {
      encoding: "utf-8",
    });
    return parseMarketplaceInventoryText(
      content,
      filePath,
      storageAuthority,
    );
  } catch (error) {
    if (isENOENT(error)) return {};
    if (error instanceof ConfigParseError) throw error;
    throw new Error(
      `Failed to load marketplace inventory at ${filePath}: ${errorMessage(error)}`,
    );
  }
}

export async function loadKnownMarketplacesConfig(
  authority: MarketplaceInventoryAuthority = {},
): Promise<MarketplaceInventory> {
  const storageAuthority = resolvePluginStorageAuthority(
    authority.pluginsDirectory,
  );
  const filePath = pluginInventoryPath(storageAuthority);
  const loaded = await loadKnownMarketplacesConfigUnlocked(
    storageAuthority,
    filePath,
  );
  const sanitized = sanitizeMarketplaceInventory(loaded);
  if (!sanitized.changed) return sanitized.inventory;

  return withMarketplaceInventoryLock(filePath, async () => {
    const latest = await loadKnownMarketplacesConfigUnlocked(
      storageAuthority,
      filePath,
    );
    const repair = sanitizeMarketplaceInventory(latest);
    if (repair.changed) {
      await writeMarketplaceInventory(filePath, repair.inventory);
    }
    return repair.inventory;
  });
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
  const storageAuthority = resolvePluginStorageAuthority(
    authority.pluginsDirectory,
  );
  const filePath = pluginInventoryPath(storageAuthority);
  return withMarketplaceInventoryLock(filePath, async () => {
    const loaded = await loadKnownMarketplacesConfigUnlocked(
      storageAuthority,
      filePath,
    );
    const current = sanitizeMarketplaceInventory(loaded).inventory;
    const mutation = await operation(current);
    const parsed = parseMarketplaceInventory(
      mutation.inventory,
      filePath,
      storageAuthority,
    );
    const inventory = sanitizeMarketplaceInventory(parsed).inventory;
    await writeMarketplaceInventory(filePath, inventory);
    return mutation.result;
  });
}

/**
 * Remove one exact canonical key from an inventory that strict loading rejects.
 * The removed value is never parsed and none of its stored paths are used.
 */
export async function removeMarketplaceInventoryEntryForRepair(
  authority: MarketplaceInventoryMutationAuthority,
  name: string,
  beforeCommit?: () => Promise<void>,
): Promise<boolean> {
  const canonicalName = normalizeMarketplaceName(name);
  if (canonicalName !== name) {
    throw new Error(`marketplace repair requires the exact canonical name: ${canonicalName}`);
  }
  const storageAuthority = resolvePluginStorageAuthority(
    authority.pluginsDirectory,
  );
  const filePath = pluginInventoryPath(storageAuthority);
  return withMarketplaceInventoryLock(filePath, async () => {
    let content: string;
    try {
      content = await getFsImplementation().readFile(filePath, {
        encoding: "utf-8",
      });
    } catch (error) {
      if (isENOENT(error)) return false;
      throw error;
    }

    const duplicatePaths = duplicateJsonObjectPaths(content);
    if (duplicatePaths.length > 0) {
      throw new ConfigParseError(
        `Marketplace inventory contains duplicate object keys at ${filePath}: ` +
          `${duplicatePaths.join(", ")}. Move the inventory file aside and ` +
          "re-add the marketplaces; exact-key repair is ambiguous.",
        filePath,
        undefined,
      );
    }

    let untrusted: unknown;
    try {
      untrusted = jsonParse(content);
    } catch (error) {
      throw new ConfigParseError(
        `Marketplace inventory JSON is invalid at ${filePath}: ${errorMessage(error)}. ` +
          "Move the inventory file aside and re-add the marketplaces.",
        filePath,
        undefined,
      );
    }
    if (!isRecord(untrusted)) {
      throw new ConfigParseError(
        `Marketplace inventory is not an object at ${filePath}. Move the ` +
          "inventory file aside and re-add the marketplaces.",
        filePath,
        untrusted,
      );
    }
    if (!Object.hasOwn(untrusted, canonicalName)) return false;

    const remaining = Object.fromEntries(
      Object.entries(untrusted).filter(([key]) => key !== canonicalName),
    );
    const inventory = parseMarketplaceInventory(
      remaining,
      filePath,
      storageAuthority,
    );
    await beforeCommit?.();
    await writeMarketplaceInventory(filePath, inventory);
    return true;
  });
}

async function withMarketplaceInventoryLock<R>(
  filePath: string,
  operation: () => Promise<R>,
): Promise<R> {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  const release = await lockfile.lock(filePath, {
    ...INVENTORY_LOCK_OPTIONS,
    lockfilePath: `${filePath}.agenc-marketplace-inventory.lock`,
  });
  try {
    return await operation();
  } finally {
    await release();
  }
}

async function writeMarketplaceInventory(
  filePath: string,
  inventory: MarketplaceInventory,
): Promise<void> {
  const temporaryPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  await writeDurableAtomicFile(
    filePath,
    temporaryPath,
    `${JSON.stringify(inventory, null, 2)}\n`,
    0o600,
  );
}
