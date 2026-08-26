import type { ConfigLayerSnapshot } from "../config/repository.js";
import { mergeConfigLayerSnapshots } from "../config/repository.js";
import type { AgenCConfig, HookMatcher, HooksMap } from "../config/schema.js";

export interface ConfiguredHookAuthoritySnapshot {
  readonly config: AgenCConfig;
  readonly layers: readonly ConfigLayerSnapshot[];
}

function mergeHookMaps(
  configHooks: HooksMap | undefined,
  pluginHooks: HooksMap | undefined,
): HooksMap | undefined {
  if (configHooks === undefined) return pluginHooks;
  if (pluginHooks === undefined) return configHooks;

  const merged: Record<string, HookMatcher[]> = {};
  for (const [event, matchers] of Object.entries(configHooks)) {
    merged[event] = [...matchers];
  }
  for (const [event, matchers] of Object.entries(pluginHooks)) {
    merged[event] = [...(merged[event] ?? []), ...matchers];
  }
  return Object.freeze(merged);
}

function managedConfig(layers: readonly ConfigLayerSnapshot[]): AgenCConfig {
  return (
    mergeConfigLayerSnapshots(
      layers.filter((layer) => layer.scope === "managed"),
    ) ?? {}
  );
}

function restrictsHooksToPlugins(
  strictPluginOnlyCustomization:
    AgenCConfig["strictPluginOnlyCustomization"] | undefined,
): boolean {
  return (
    strictPluginOnlyCustomization === true ||
    (Array.isArray(strictPluginOnlyCustomization) &&
      strictPluginOnlyCustomization.includes("hooks"))
  );
}

/**
 * Resolve command-hook sources from one atomic canonical-config snapshot.
 *
 * Canonical config and explicit plugin hooks are deliberately separate inputs:
 * a config reload must not erase plugin registrations, and a plugin refresh
 * must not reconstruct config precedence. Managed hook policy is evaluated
 * from the ordered source layers rather than from a second settings facade.
 */
export function resolveConfiguredHookSources(
  authority: ConfiguredHookAuthoritySnapshot | undefined,
  pluginHooks: HooksMap | undefined,
): HooksMap | undefined {
  // Plugin commands cannot run before the canonical policy layers are known.
  if (authority === undefined) return undefined;

  const managed = managedConfig(authority.layers);
  if (managed.disableAllHooks === true) return undefined;

  // A managed disable returned above, so any remaining effective disable was
  // contributed by a lower authority and must leave managed hooks intact.
  const nonManagedDisableAll = authority.config.disableAllHooks === true;
  if (managed.allowManagedHooksOnly === true || nonManagedDisableAll) {
    return managed.hooks;
  }

  if (restrictsHooksToPlugins(managed.strictPluginOnlyCustomization)) {
    return mergeHookMaps(managed.hooks, pluginHooks);
  }

  return mergeHookMaps(authority.config.hooks, pluginHooks);
}
