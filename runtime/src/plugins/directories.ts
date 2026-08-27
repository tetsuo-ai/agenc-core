import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { lstat, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { getActiveAgentRuntimeOptions } from "../session/runtime-options.js";
import { formatFileSize } from "../utils/format.js";
import { normalizeExactAbsolutePath } from "../utils/path-authority.js";

export interface PluginStorageAuthority {
  readonly pluginStorageRoot: string;
}

export type PluginStorageAuthorityInput = PluginStorageAuthority | string;

const RESERVED_PLUGIN_STORAGE_CHILD_NAMES = new Set([
  "build",
  "cache",
  "coverage",
  "data",
  "dist",
  "marketplaces",
  "node_modules",
]);

/** Names owned by the plugin storage layout, never installable plugin roots. */
export function isReservedPluginStorageChildName(name: string): boolean {
  return RESERVED_PLUGIN_STORAGE_CHILD_NAMES.has(name.toLowerCase());
}

/** Validate an already-selected plugin root without creating filesystem state. */
export function createPluginStorageAuthority(
  pluginStorageRoot: string,
): PluginStorageAuthority {
  return Object.freeze({
    pluginStorageRoot: normalizeExactAbsolutePath(
      pluginStorageRoot,
      "Plugin storage authority pluginStorageRoot",
    ),
  });
}

/**
 * Resolve one explicit or session-owned plugin storage authority.
 *
 * Runtime ingress establishes the root. Plugin consumers must not reconstruct
 * it from an AgenC home or read a process-global environment as a fallback.
 */
export function resolvePluginStorageAuthority(
  explicit?: PluginStorageAuthorityInput,
): PluginStorageAuthority {
  if (typeof explicit === "string") {
    return createPluginStorageAuthority(explicit);
  }
  if (explicit !== undefined) {
    return createPluginStorageAuthority(explicit.pluginStorageRoot);
  }
  const pluginStorageRoot = getActiveAgentRuntimeOptions()?.pluginStorageRoot;
  if (pluginStorageRoot === undefined) {
    throw new Error(
      "Plugin storage authority requires an explicit root or active runtime options",
    );
  }
  return createPluginStorageAuthority(pluginStorageRoot);
}

export function pluginStorageRootPath(
  authority: PluginStorageAuthority,
): string {
  return authority.pluginStorageRoot;
}

export function pluginCacheDirPath(authority: PluginStorageAuthority): string {
  return join(pluginStorageRootPath(authority), "cache");
}

export function pluginDataRootPath(authority: PluginStorageAuthority): string {
  return join(pluginStorageRootPath(authority), "data");
}

export function pluginMarketplaceRootPath(
  authority: PluginStorageAuthority,
): string {
  return join(pluginStorageRootPath(authority), "marketplaces");
}

export function pluginInventoryPath(authority: PluginStorageAuthority): string {
  return join(pluginStorageRootPath(authority), "known_marketplaces.json");
}

/** Active-session adapter retained for call sites that do not need child paths. */
export function getPluginsDirectory(
  explicit?: PluginStorageAuthorityInput,
): string {
  return pluginStorageRootPath(resolvePluginStorageAuthority(explicit));
}

export function sanitizePluginId(pluginId: string): string {
  return pluginId.replace(/[^a-zA-Z0-9\-_]/g, "-");
}

/** Collision-resistant, case-stable filesystem key for a canonical plugin ID. */
export function pluginFilesystemKey(pluginId: string): string {
  const readable = sanitizePluginId(pluginId)
    .replace(/^-+|-+$/gu, "")
    .slice(0, 48) || "plugin";
  const digest = createHash("sha256")
    .update(pluginId, "utf8")
    .digest("hex");
  return `${readable}--${digest}`;
}

export function pluginDataDirPath(
  pluginId: string,
  authority: PluginStorageAuthority,
): string {
  return join(pluginDataRootPath(authority), pluginFilesystemKey(pluginId));
}

export interface PluginDataMigrationIssue {
  readonly pluginIds: readonly string[];
  readonly legacyPath: string;
  readonly message: string;
}

/**
 * Move the retired lossy data-directory layout into the canonical hashed
 * layout exactly once. Ambiguous or conflicting paths are never guessed.
 */
export async function migrateLegacyPluginDataDirectories(
  pluginIds: readonly string[],
  authority: PluginStorageAuthority,
): Promise<readonly PluginDataMigrationIssue[]> {
  const idsByLegacyKey = new Map<string, string[]>();
  for (const pluginId of new Set(pluginIds)) {
    const legacyKey = sanitizePluginId(pluginId);
    idsByLegacyKey.set(legacyKey, [
      ...(idsByLegacyKey.get(legacyKey) ?? []),
      pluginId,
    ]);
  }
  const issues: PluginDataMigrationIssue[] = [];
  for (const [legacyKey, unsortedIds] of idsByLegacyKey) {
    const ids = unsortedIds.sort();
    const legacyPath = join(pluginDataRootPath(authority), legacyKey);
    let legacyEntry;
    try {
      legacyEntry = await lstat(legacyPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (!legacyEntry.isDirectory() || legacyEntry.isSymbolicLink()) {
      issues.push({
        pluginIds: ids,
        legacyPath,
        message: `Legacy plugin data path is not a real directory: ${legacyPath}`,
      });
      continue;
    }
    if (ids.length !== 1 || legacyKey.includes("-")) {
      const destinations = ids.map((pluginId) =>
        pluginDataDirPath(pluginId, authority)
      );
      issues.push({
        pluginIds: ids,
        legacyPath,
        message:
          `Legacy plugin data path ${legacyPath} cannot be attributed safely to canonical IDs ${ids.join(", ")}. Move it explicitly to the correct canonical path (${destinations.join(", ")}) or remove it; no data was moved`,
      });
      continue;
    }
    const destination = pluginDataDirPath(ids[0]!, authority);
    try {
      await lstat(destination);
      issues.push({
        pluginIds: ids,
        legacyPath,
        message:
          `Legacy and canonical plugin data directories both exist for ${ids[0]}: ${legacyPath}, ${destination}; no data was moved`,
      });
      continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      await rename(legacyPath, destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        try {
          await lstat(destination);
          continue;
        } catch {
          // Report the original failed migration below.
        }
      }
      issues.push({
        pluginIds: ids,
        legacyPath,
        message:
          `Failed to migrate plugin data for ${ids[0]} from ${legacyPath} to ${destination}: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  return issues;
}

export function getPluginDataDir(
  pluginId: string,
  explicit?: PluginStorageAuthorityInput,
): string {
  const dir = pluginDataDirPath(
    pluginId,
    resolvePluginStorageAuthority(explicit),
  );
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export async function getPluginDataDirSize(
  pluginId: string,
  explicit?: PluginStorageAuthorityInput,
): Promise<{ bytes: number; human: string } | null> {
  const dir = pluginDataDirPath(
    pluginId,
    resolvePluginStorageAuthority(explicit),
  );
  let bytes = 0;
  async function walk(path: string): Promise<void> {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const fullPath = join(path, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      try {
        bytes += (await stat(fullPath)).size;
      } catch {
        // Broken links or concurrent deletes should not block cleanup prompts.
      }
    }
  }
  try {
    await walk(dir);
  } catch (error) {
    const { isFsInaccessible } = await import("../utils/errors.js");
    if (isFsInaccessible(error)) return null;
    throw error;
  }
  if (bytes === 0) return null;
  return { bytes, human: formatFileSize(bytes) };
}

export async function deletePluginDataDir(
  pluginId: string,
  explicit?: PluginStorageAuthorityInput,
): Promise<void> {
  const dir = pluginDataDirPath(
    pluginId,
    resolvePluginStorageAuthority(explicit),
  );
  try {
    await rm(dir, { recursive: true, force: true });
  } catch (error) {
    const [{ logForDebugging }, { errorMessage }] = await Promise.all([
      import("../utils/debug.js"),
      import("../utils/errors.js"),
    ]);
    logForDebugging(
      `Failed to delete plugin data dir ${dir}: ${errorMessage(error)}`,
      { level: "warn" },
    );
  }
}
