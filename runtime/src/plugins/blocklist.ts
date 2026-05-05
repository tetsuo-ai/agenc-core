import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const FLAGGED_PLUGINS_FILENAME = "flagged-plugins.json";
export const FLAGGED_PLUGIN_SEEN_EXPIRY_MS = 48 * 60 * 60 * 1000;

export interface FlaggedPlugin {
  readonly flaggedAt: string;
  readonly seenAt?: string;
}

export type FlaggedPlugins = Readonly<Record<string, FlaggedPlugin>>;

export interface InstalledPluginInstallation {
  readonly scope: string;
}

export interface InstalledPluginsFileV2 {
  readonly plugins: Readonly<Record<string, readonly InstalledPluginInstallation[]>>;
}

export interface PluginMarketplace {
  readonly plugins: readonly { readonly name: string }[];
  readonly forceRemoveDeletedPlugins?: boolean;
}

export type DelistedPluginLogLevel = "debug" | "warn" | "error";

export interface DelistedPluginEnforcer {
  readonly loadFlaggedPlugins: () => Promise<FlaggedPlugins>;
  readonly loadInstalledPlugins: () => InstalledPluginsFileV2;
  readonly loadKnownMarketplaces: () => Promise<Readonly<Record<string, unknown>>>;
  readonly getMarketplace: (marketplaceName: string) => Promise<PluginMarketplace>;
  readonly uninstallPlugin: (pluginId: string, scope: string) => Promise<void>;
  readonly addFlaggedPlugin: (pluginId: string) => Promise<void>;
  readonly log?: (message: string, level: DelistedPluginLogLevel) => void;
}

export interface FlaggedPluginStoreOptions {
  readonly pluginsDirectory: string;
  readonly now?: () => Date;
  readonly tokenBytes?: () => Buffer;
  readonly onError?: (error: unknown) => void;
}

export function detectDelistedPlugins(
  installedPlugins: InstalledPluginsFileV2,
  marketplace: PluginMarketplace,
  marketplaceName: string,
): string[] {
  const marketplacePluginNames = new Set(marketplace.plugins.map((plugin) => plugin.name));
  const suffix = `@${marketplaceName}`;

  const delisted: string[] = [];
  for (const pluginId of Object.keys(installedPlugins.plugins)) {
    if (!pluginId.endsWith(suffix)) continue;
    const pluginName = pluginId.slice(0, -suffix.length);
    if (!marketplacePluginNames.has(pluginName)) delisted.push(pluginId);
  }

  return delisted;
}

export async function detectAndUninstallDelistedPlugins(
  enforcer: DelistedPluginEnforcer,
): Promise<string[]> {
  const alreadyFlagged = await enforcer.loadFlaggedPlugins();
  const installedPlugins = enforcer.loadInstalledPlugins();
  const knownMarketplaces = await enforcer.loadKnownMarketplaces();
  const newlyFlagged: string[] = [];

  for (const marketplaceName of Object.keys(knownMarketplaces)) {
    try {
      const marketplace = await enforcer.getMarketplace(marketplaceName);
      if (!marketplace.forceRemoveDeletedPlugins) continue;

      const delisted = detectDelistedPlugins(
        installedPlugins,
        marketplace,
        marketplaceName,
      );

      for (const pluginId of delisted) {
        if (pluginId in alreadyFlagged) continue;

        const installations = installedPlugins.plugins[pluginId] ?? [];
        const userControllableInstallations = installations.filter(
          (installation) => isUserControllableScope(installation.scope),
        );
        if (userControllableInstallations.length === 0) continue;

        for (const installation of userControllableInstallations) {
          try {
            await enforcer.uninstallPlugin(pluginId, installation.scope);
          } catch (error) {
            enforcer.log?.(
              `Failed to auto-uninstall delisted plugin ${pluginId} from ${installation.scope}: ${errorMessage(error)}`,
              "error",
            );
          }
        }

        await enforcer.addFlaggedPlugin(pluginId);
        newlyFlagged.push(pluginId);
      }
    } catch (error) {
      enforcer.log?.(
        `Failed to check for delisted plugins in "${marketplaceName}": ${errorMessage(error)}`,
        "warn",
      );
    }
  }

  return newlyFlagged;
}

export function parseFlaggedPluginsData(content: string): FlaggedPlugins {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return Object.freeze({});
  }
  if (!isRecord(parsed) || !isRecord(parsed.plugins)) return Object.freeze({});

  const result: Record<string, FlaggedPlugin> = {};
  for (const [id, entry] of Object.entries(parsed.plugins)) {
    if (!isRecord(entry) || typeof entry.flaggedAt !== "string") continue;
    result[id] = {
      flaggedAt: entry.flaggedAt,
      ...(typeof entry.seenAt === "string" ? { seenAt: entry.seenAt } : {}),
    };
  }
  return Object.freeze(result);
}

export function pruneExpiredFlaggedPlugins(
  plugins: FlaggedPlugins,
  nowMs = Date.now(),
): { readonly plugins: FlaggedPlugins; readonly changed: boolean } {
  const result: Record<string, FlaggedPlugin> = {};
  let changed = false;
  for (const [id, entry] of Object.entries(plugins)) {
    if (entry.seenAt && nowMs - new Date(entry.seenAt).getTime() >= FLAGGED_PLUGIN_SEEN_EXPIRY_MS) {
      changed = true;
      continue;
    }
    result[id] = entry;
  }
  return {
    plugins: Object.freeze(result),
    changed,
  };
}

export function addFlaggedPluginState(
  plugins: FlaggedPlugins,
  pluginId: string,
  flaggedAt = new Date().toISOString(),
): FlaggedPlugins {
  return Object.freeze({
    ...plugins,
    [pluginId]: { flaggedAt },
  });
}

export function markFlaggedPluginsSeenState(
  plugins: FlaggedPlugins,
  pluginIds: readonly string[],
  seenAt = new Date().toISOString(),
): { readonly plugins: FlaggedPlugins; readonly changed: boolean } {
  const updated: Record<string, FlaggedPlugin> = { ...plugins };
  let changed = false;
  for (const id of pluginIds) {
    const entry = updated[id];
    if (entry && !entry.seenAt) {
      updated[id] = { ...entry, seenAt };
      changed = true;
    }
  }
  return {
    plugins: Object.freeze(updated),
    changed,
  };
}

export function removeFlaggedPluginState(
  plugins: FlaggedPlugins,
  pluginId: string,
): { readonly plugins: FlaggedPlugins; readonly changed: boolean } {
  if (!(pluginId in plugins)) {
    return { plugins, changed: false };
  }
  const rest = Object.fromEntries(
    Object.entries(plugins).filter(([id]) => id !== pluginId),
  ) as Record<string, FlaggedPlugin>;
  return {
    plugins: Object.freeze(rest),
    changed: true,
  };
}

export class FlaggedPluginStore {
  private cache: FlaggedPlugins | null = null;

  constructor(private readonly options: FlaggedPluginStoreOptions) {}

  get path(): string {
    return join(this.options.pluginsDirectory, FLAGGED_PLUGINS_FILENAME);
  }

  getFlaggedPlugins(): FlaggedPlugins {
    return this.cache ?? Object.freeze({});
  }

  async loadFlaggedPlugins(): Promise<void> {
    const all = await this.readFromDisk();
    const pruned = pruneExpiredFlaggedPlugins(
      all,
      this.options.now?.().getTime() ?? Date.now(),
    );
    this.cache = pruned.plugins;
    if (pruned.changed) await this.writeToDisk(pruned.plugins);
  }

  async addFlaggedPlugin(pluginId: string): Promise<boolean> {
    if (this.cache === null) this.cache = await this.readFromDisk();
    return await this.writeToDisk(
      addFlaggedPluginState(
        this.cache,
        pluginId,
        this.options.now?.().toISOString(),
      ),
    );
  }

  async markFlaggedPluginsSeen(pluginIds: readonly string[]): Promise<boolean> {
    if (this.cache === null) this.cache = await this.readFromDisk();
    const updated = markFlaggedPluginsSeenState(
      this.cache,
      pluginIds,
      this.options.now?.().toISOString(),
    );
    if (!updated.changed) return false;
    return await this.writeToDisk(updated.plugins);
  }

  async removeFlaggedPlugin(pluginId: string): Promise<boolean> {
    if (this.cache === null) this.cache = await this.readFromDisk();
    const updated = removeFlaggedPluginState(this.cache, pluginId);
    if (!updated.changed) return false;
    return await this.writeToDisk(updated.plugins);
  }

  private async readFromDisk(): Promise<FlaggedPlugins> {
    try {
      return parseFlaggedPluginsData(await readFile(this.path, "utf8"));
    } catch {
      return Object.freeze({});
    }
  }

  private async writeToDisk(plugins: FlaggedPlugins): Promise<boolean> {
    const tempPath = `${this.path}.${(this.options.tokenBytes?.() ?? randomBytes(8)).toString("hex")}.tmp`;
    try {
      await mkdir(this.options.pluginsDirectory, { recursive: true, mode: 0o700 });
      await writeFile(tempPath, JSON.stringify({ plugins }, null, 2), {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(tempPath, this.path);
      this.cache = plugins;
      return true;
    } catch (error) {
      this.options.onError?.(error);
      try {
        await unlink(tempPath);
      } catch {
        // Cleanup failure should not mask the original write failure.
      }
      return false;
    }
  }
}

function isUserControllableScope(scope: string): boolean {
  return scope === "user" || scope === "project" || scope === "local";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
