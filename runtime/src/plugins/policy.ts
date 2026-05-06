export type PluginPolicyEntry =
  | boolean
  | {
    readonly enabled?: boolean;
  };

export interface PluginPolicySettings {
  readonly enabledPlugins?: Readonly<Record<string, unknown>>;
  readonly plugins?: {
    readonly allowlist?: readonly string[];
    readonly plugins?: Readonly<Record<string, unknown>>;
  };
}

export interface PluginPolicySubject {
  readonly manifest: {
    readonly interface?: {
      readonly capabilities?: readonly string[];
    };
  };
}

export interface PluginCapabilityPolicy {
  readonly allow?: readonly string[];
  readonly deny?: readonly string[];
}

export interface PluginPolicyDecision {
  readonly pluginId: string;
  readonly allowed: boolean;
  readonly reason?: "blocked-by-policy" | "capability-denied";
  readonly capabilities: readonly string[];
  readonly deniedCapabilities: readonly string[];
}

export interface PluginPolicyDecisionInput {
  readonly pluginId: string;
  readonly plugin?: PluginPolicySubject;
  readonly capabilities?: readonly string[];
  readonly settings?: PluginPolicySettings | null;
  readonly capabilityPolicy?: PluginCapabilityPolicy;
}

export function isPluginBlockedByPolicy(
  pluginId: string,
  settings?: PluginPolicySettings | null,
): boolean {
  const entry = pluginPolicyEntry(pluginId, settings);
  return !isPluginAllowedByConfigAllowlist(pluginId, settings) ||
    entry === false ||
    (isRecord(entry) && entry.enabled === false);
}

export function getManagedPluginNames(
  settings?: PluginPolicySettings | null,
): Set<string> | null {
  const entries = {
    ...(isRecord(settings?.plugins?.plugins) ? settings.plugins.plugins : {}),
    ...(isRecord(settings?.enabledPlugins) ? settings.enabledPlugins : {}),
  };
  if (Object.keys(entries).length === 0) return null;

  const names = new Set<string>();
  for (const [pluginId, value] of Object.entries(entries)) {
    if (typeof value !== "boolean" || !pluginId.includes("@")) continue;
    const [name] = pluginId.split("@");
    if (name) names.add(name);
  }
  return names.size > 0 ? names : null;
}

export function collectPluginCapabilities(
  plugin: PluginPolicySubject | undefined,
): readonly string[] {
  return normalizeCapabilities(plugin?.manifest.interface?.capabilities ?? []);
}

export function evaluatePluginPolicy(
  input: PluginPolicyDecisionInput,
): PluginPolicyDecision {
  const capabilities = normalizeCapabilities(
    input.capabilities ?? collectPluginCapabilities(input.plugin),
  );
  if (isPluginBlockedByPolicy(input.pluginId, input.settings)) {
    return {
      pluginId: input.pluginId,
      allowed: false,
      reason: "blocked-by-policy",
      capabilities,
      deniedCapabilities: [],
    };
  }

  const deniedCapabilities = capabilities.filter(
    (capability) => !isPluginCapabilityAllowed(capability, input.capabilityPolicy),
  );
  if (deniedCapabilities.length > 0) {
    return {
      pluginId: input.pluginId,
      allowed: false,
      reason: "capability-denied",
      capabilities,
      deniedCapabilities,
    };
  }

  return {
    pluginId: input.pluginId,
    allowed: true,
    capabilities,
    deniedCapabilities: [],
  };
}

export function isPluginCapabilityAllowed(
  capability: string,
  policy?: PluginCapabilityPolicy,
): boolean {
  const normalized = capability.trim();
  if (normalized.length === 0) return false;
  const deny = new Set((policy?.deny ?? []).map((entry) => entry.trim()).filter(Boolean));
  if (deny.has("*") || deny.has(normalized)) return false;

  const allow = new Set((policy?.allow ?? []).map((entry) => entry.trim()).filter(Boolean));
  if (allow.size === 0 || allow.has("*")) return true;
  return allow.has(normalized);
}

export function pluginPolicyEntry(
  pluginId: string,
  settings?: PluginPolicySettings | null,
): unknown {
  const managedEntry = settings?.enabledPlugins?.[pluginId];
  if (managedEntry !== undefined) return managedEntry;
  return settings?.plugins?.plugins?.[pluginId];
}

function isPluginAllowedByConfigAllowlist(
  pluginId: string,
  settings?: PluginPolicySettings | null,
): boolean {
  const allowlist = settings?.plugins?.allowlist;
  if (!Array.isArray(allowlist) || allowlist.length === 0) return true;
  const allowed = new Set(
    allowlist
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
  if (allowed.size === 0) return true;
  const at = pluginId.lastIndexOf("@");
  const name = at > 0 ? pluginId.slice(0, at) : pluginId;
  return allowed.has(pluginId) || allowed.has(name);
}

function normalizeCapabilities(capabilities: readonly string[]): readonly string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of capabilities) {
    const capability = raw.trim();
    if (capability.length === 0 || seen.has(capability)) continue;
    seen.add(capability);
    out.push(capability);
  }
  return Object.freeze(out);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
