import { validatePluginsConfig } from "../config/schema.js";
import { mutateCanonicalUserConfigSync } from "../config/update-sync.js";
import { isRecord } from "../utils/record.js";

export interface PluginConfigRollbackSnapshot {
  readonly entryPresent: boolean;
  readonly entry?: unknown;
  readonly pluginsEnabledPresent: boolean;
  readonly pluginsEnabled?: unknown;
}

export function parsePluginConfigRollbackSnapshot(
  value: unknown,
): PluginConfigRollbackSnapshot | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.entryPresent !== "boolean") return undefined;
  if (typeof value.pluginsEnabledPresent !== "boolean") return undefined;
  return {
    entryPresent: value.entryPresent,
    ...(value.entryPresent ? { entry: value.entry } : {}),
    pluginsEnabledPresent: value.pluginsEnabledPresent,
    ...(value.pluginsEnabledPresent ? { pluginsEnabled: value.pluginsEnabled } : {}),
  };
}

export function restoreTrustedUserPluginConfig(
  configPath: string,
  pluginId: string,
  previous: unknown,
): void {
  const snapshot = parsePluginConfigRollbackSnapshot(previous);
  if (snapshot === undefined) {
    throw new Error("plugin config snapshot is not a rollback record");
  }
  if (snapshot.entryPresent) {
    validatePluginsConfig({ plugins: { [pluginId]: snapshot.entry } });
  }
  if (snapshot.pluginsEnabledPresent && typeof snapshot.pluginsEnabled !== "boolean") {
    throw new Error("plugin config snapshot enabled flag is not a boolean");
  }
  writePluginConfigRollback(configPath, pluginId, snapshot);
}

export function writePluginConfigRollback(
  configPath: string,
  pluginId: string,
  snapshot: PluginConfigRollbackSnapshot,
): void {
  mutateCanonicalUserConfigSync(configPath, (raw) => {
    const plugins = isRecord(raw.plugins) ? raw.plugins : {};
    if (!isRecord(raw.plugins)) raw.plugins = plugins;
    const pluginEntries = isRecord(plugins.plugins) ? plugins.plugins : {};
    if (!isRecord(plugins.plugins)) plugins.plugins = pluginEntries;
    if (!snapshot.entryPresent) delete pluginEntries[pluginId];
    else {
      Object.defineProperty(pluginEntries, pluginId, {
        value: snapshot.entry,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    if (snapshot.pluginsEnabledPresent) plugins.enabled = snapshot.pluginsEnabled;
    else delete plugins.enabled;
    if (Object.keys(pluginEntries).length === 0) delete plugins.plugins;
    if (Object.keys(plugins).length === 0) delete raw.plugins;
  });
}
