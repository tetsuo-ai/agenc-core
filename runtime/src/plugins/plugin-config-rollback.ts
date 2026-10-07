import { validatePluginsConfig } from "../config/schema.js";
import {
  parseOwnedPluginConfigSnapshot, reservePluginConfigRollback, finishPluginConfigRollback,
} from "./plugin-config-transaction.js";
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
  const owned = parseOwnedPluginConfigSnapshot(value);
  if (owned !== undefined) return owned;
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
  const owned = parseOwnedPluginConfigSnapshot(snapshot);
  if (owned === undefined) {
    throw new Error("legacy plugin config snapshot has no ownership proof; preserve the config and operation record for manual recovery");
  }
  reservePluginConfigRollback(configPath, pluginId, owned.token, owned);
  finishPluginConfigRollback(configPath, pluginId, owned.token, owned);
}
