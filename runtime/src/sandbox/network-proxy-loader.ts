// Source parity for C-01g is tracked in ../../../parity/C-01g-parity.json.
import path from "node:path";
import { stat } from "node:fs/promises";

import type { EnvSnapshot } from "../config/env.js";
import { resolveAgencHome } from "../config/env.js";
import { readTextFile } from "../config/_deps/file-read.js";
import { parseToml } from "../config/loader.js";

export type NetworkMode = "limited" | "full";
export type NetworkDomainPermission = "none" | "allow" | "deny";
export type NetworkUnixSocketPermission = "allow" | "none";
export type ConfigLayerSource =
  | "system"
  | "managed"
  | "legacy_managed"
  | "user"
  | "project"
  | "session_flags";
export type ExecPolicyNetworkProtocol =
  | "http"
  | "https"
  | "socks5-tcp"
  | "socks5-udp";
export type ExecPolicyNetworkDecision = "allow" | "forbidden" | "prompt";

export interface NetworkDomainPermissionEntry {
  readonly pattern: string;
  readonly permission: NetworkDomainPermission;
}

export interface NetworkDomainPermissions {
  readonly entries: readonly NetworkDomainPermissionEntry[];
}

export interface NetworkUnixSocketPermissions {
  readonly entries: Readonly<Record<string, NetworkUnixSocketPermission>>;
}

export interface NetworkProxySettings {
  enabled: boolean;
  proxyUrl: string;
  enableSocks5: boolean;
  socksUrl: string;
  enableSocks5Udp: boolean;
  allowUpstreamProxy: boolean;
  dangerouslyAllowNonLoopbackProxy: boolean;
  dangerouslyAllowAllUnixSockets: boolean;
  mode: NetworkMode;
  domains: NetworkDomainPermissions | null;
  unixSockets: NetworkUnixSocketPermissions | null;
  allowLocalBinding: boolean;
  mitm: boolean;
}

export interface NetworkProxyConfig {
  network: NetworkProxySettings;
}

export interface NetworkProxyConstraints {
  readonly enabled?: boolean;
  readonly mode?: NetworkMode;
  readonly allowUpstreamProxy?: boolean;
  readonly dangerouslyAllowNonLoopbackProxy?: boolean;
  readonly dangerouslyAllowAllUnixSockets?: boolean;
  readonly allowedDomains?: readonly string[];
  readonly allowlistExpansionEnabled?: boolean;
  readonly deniedDomains?: readonly string[];
  readonly denylistExpansionEnabled?: boolean;
  readonly allowUnixSockets?: readonly string[];
  readonly allowLocalBinding?: boolean;
}

export interface ConfigState {
  readonly config: NetworkProxyConfig;
  readonly constraints: NetworkProxyConstraints;
  readonly allowedDomains: readonly string[];
  readonly deniedDomains: readonly string[];
}

export type HostPolicyDecision =
  | { readonly kind: "allowed" }
  | { readonly kind: "blocked"; readonly reason: "denied" | "not_allowed" };

export interface ConfigLayer {
  readonly source: ConfigLayerSource;
  readonly config: Readonly<Record<string, unknown>>;
  readonly path?: string;
}

export interface NetworkTablesToml {
  readonly defaultPermissions?: string;
  readonly permissions?: Readonly<Record<string, PermissionProfileToml>>;
}

export interface PermissionProfileToml {
  readonly network?: NetworkToml;
}

export interface NetworkToml {
  readonly enabled?: boolean;
  readonly proxyUrl?: string;
  readonly enableSocks5?: boolean;
  readonly socksUrl?: string;
  readonly enableSocks5Udp?: boolean;
  readonly allowUpstreamProxy?: boolean;
  readonly dangerouslyAllowNonLoopbackProxy?: boolean;
  readonly dangerouslyAllowAllUnixSockets?: boolean;
  readonly mode?: NetworkMode;
  readonly domains?: NetworkDomainPermissions;
  readonly unixSockets?: NetworkUnixSocketPermissions;
  readonly allowLocalBinding?: boolean;
}

export interface ExecPolicyNetworkRule {
  readonly host: string;
  readonly protocol: ExecPolicyNetworkProtocol | string;
  readonly decision: ExecPolicyNetworkDecision | string;
  readonly justification?: string;
}

export interface BuildNetworkProxyStateOptions {
  readonly agencHome?: string;
  readonly env?: EnvSnapshot;
  readonly layers?: readonly ConfigLayer[];
  readonly execPolicyNetworkRules?: readonly ExecPolicyNetworkRule[];
}

export interface BuildNetworkProxyStateAndReloaderResult {
  readonly state: ConfigState;
  readonly reloader: MtimeConfigReloader;
}

interface LoadedLayers {
  readonly layers: readonly ConfigLayer[];
  readonly layerMtimes: readonly LayerMtime[];
}

interface LayerMtime {
  readonly path: string;
  readonly mtimeMs: number | null;
}

export class NetworkProxyConstraintError extends Error {
  constructor(
    readonly fieldName: string,
    readonly candidate: string,
    readonly allowed: string,
  ) {
    super(`invalid value for ${fieldName}: ${candidate} (allowed ${allowed})`);
    this.name = "NetworkProxyConstraintError";
  }
}

export class NetworkProxyState {
  private state: ConfigState;

  constructor(
    initialState: ConfigState,
    private readonly reloader?: MtimeConfigReloader,
  ) {
    this.state = initialState;
  }

  current(): ConfigState {
    return this.state;
  }

  async maybeReload(): Promise<ConfigState | null> {
    const next = await this.reloader?.maybeReload();
    if (next === undefined || next === null) return null;
    this.state = next;
    return next;
  }

  async reloadNow(): Promise<ConfigState> {
    if (this.reloader === undefined) return this.state;
    const next = await this.reloader.reloadNow();
    this.state = next;
    return next;
  }
}

export class MtimeConfigReloader {
  private layerMtimes: readonly LayerMtime[];

  constructor(
    layerMtimes: readonly LayerMtime[],
    private readonly reloadConfigState: () => Promise<{
      readonly state: ConfigState;
      readonly layerMtimes: readonly LayerMtime[];
    }>,
  ) {
    this.layerMtimes = [...layerMtimes];
  }

  sourceLabel(): string {
    return "config layers";
  }

  async needsReload(): Promise<boolean> {
    const layers = this.layerMtimes;
    for (const layer of layers) {
      const current = await readMtimeMs(layer.path);
      if (current !== layer.mtimeMs) return true;
    }
    return false;
  }

  async maybeReload(): Promise<ConfigState | null> {
    if (!(await this.needsReload())) return null;
    return this.reloadNow();
  }

  async reloadNow(): Promise<ConfigState> {
    const next = await this.reloadConfigState();
    this.layerMtimes = [...next.layerMtimes];
    return next.state;
  }
}

export function defaultNetworkProxyConfig(): NetworkProxyConfig {
  return {
    network: {
      enabled: false,
      proxyUrl: "http://127.0.0.1:3128",
      enableSocks5: true,
      socksUrl: "http://127.0.0.1:8081",
      enableSocks5Udp: true,
      allowUpstreamProxy: true,
      dangerouslyAllowNonLoopbackProxy: false,
      dangerouslyAllowAllUnixSockets: false,
      mode: "full",
      domains: null,
      unixSockets: null,
      allowLocalBinding: false,
      mitm: false,
    },
  };
}

export function normalizeHost(host: string): string {
  const trimmed = host.trim();
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    if (end >= 0) {
      return normalizeDnsHostOrIpLiteral(trimmed.slice(1, end));
    }
  }

  if (colonCount(trimmed) === 1) {
    const [candidate, port] = splitOnce(trimmed, ":");
    if (candidate.length > 0 && /^[0-9]+$/u.test(port)) {
      return normalizeDnsHostOrIpLiteral(candidate);
    }
  }

  return normalizeDnsHostOrIpLiteral(trimmed);
}

export function allowedDomains(config: NetworkProxyConfig): readonly string[] {
  return domainEntries(config.network.domains, "allow");
}

export function deniedDomains(config: NetworkProxyConfig): readonly string[] {
  return domainEntries(config.network.domains, "deny");
}

export function allowUnixSockets(config: NetworkProxyConfig): readonly string[] {
  const unixSockets = config.network.unixSockets;
  if (unixSockets === null) return [];
  return Object.entries(unixSockets.entries)
    .filter(([, permission]) => permission === "allow")
    .map(([socketPath]) => socketPath);
}

export function setAllowedDomains(
  config: NetworkProxyConfig,
  entries: readonly string[],
): void {
  setDomainEntries(config, entries, "allow");
}

export function setDeniedDomains(
  config: NetworkProxyConfig,
  entries: readonly string[],
): void {
  setDomainEntries(config, entries, "deny");
}

export function upsertNetworkDomain(
  config: NetworkProxyConfig,
  host: string,
  permission: NetworkDomainPermission,
): void {
  const domains = config.network.domains ?? { entries: [] };
  const normalized = normalizeHost(host);
  const entries = domains.entries.filter(
    (entry) => normalizeHost(entry.pattern) !== normalized,
  );
  if (permission !== "none") {
    entries.push({ pattern: host, permission });
  }
  config.network.domains = entries.length > 0 ? { entries } : null;
}

export function setAllowUnixSockets(
  config: NetworkProxyConfig,
  entries: readonly string[],
): void {
  setUnixSocketEntries(config, entries, "allow");
}

export function networkTablesFromToml(
  value: unknown,
): NetworkTablesToml {
  if (!isPlainRecord(value)) {
    throw new Error("network config layer must be a TOML table");
  }

  const defaultPermissions = optionalString(value.default_permissions, "default_permissions");
  const permissionsRaw = value.permissions;
  let permissions: Record<string, PermissionProfileToml> | undefined;
  if (permissionsRaw !== undefined) {
    if (!isPlainRecord(permissionsRaw)) {
      throw new Error("permissions must be a TOML table");
    }
    permissions = {};
    for (const [name, profileRaw] of Object.entries(permissionsRaw)) {
      if (!isPlainRecord(profileRaw)) {
        throw new Error(`permissions.${name} must be a TOML table`);
      }
      const networkRaw = profileRaw.network;
      permissions[name] = {
        ...(networkRaw !== undefined
          ? { network: networkTomlFromRaw(networkRaw, `permissions.${name}.network`) }
          : {}),
      };
    }
  }

  return {
    ...(defaultPermissions !== undefined ? { defaultPermissions } : {}),
    ...(permissions !== undefined ? { permissions } : {}),
  };
}

export function selectedNetworkFromTables(
  parsed: NetworkTablesToml,
): NetworkToml | null {
  if (parsed.defaultPermissions === undefined) return null;
  const permissions = parsed.permissions;
  if (permissions === undefined) {
    throw new Error(
      "default_permissions requires a [permissions] table for network settings",
    );
  }
  const profile = permissions[parsed.defaultPermissions];
  if (profile === undefined) {
    throw new Error(
      `default_permissions profile '${parsed.defaultPermissions}' was not found`,
    );
  }
  return profile.network ?? null;
}

export function applyNetworkTomlToConfig(
  config: NetworkProxyConfig,
  network: NetworkToml,
): void {
  if (network.enabled !== undefined) config.network.enabled = network.enabled;
  if (network.proxyUrl !== undefined) config.network.proxyUrl = network.proxyUrl;
  if (network.enableSocks5 !== undefined) {
    config.network.enableSocks5 = network.enableSocks5;
  }
  if (network.socksUrl !== undefined) config.network.socksUrl = network.socksUrl;
  if (network.enableSocks5Udp !== undefined) {
    config.network.enableSocks5Udp = network.enableSocks5Udp;
  }
  if (network.allowUpstreamProxy !== undefined) {
    config.network.allowUpstreamProxy = network.allowUpstreamProxy;
  }
  if (network.dangerouslyAllowNonLoopbackProxy !== undefined) {
    config.network.dangerouslyAllowNonLoopbackProxy =
      network.dangerouslyAllowNonLoopbackProxy;
  }
  if (network.dangerouslyAllowAllUnixSockets !== undefined) {
    config.network.dangerouslyAllowAllUnixSockets =
      network.dangerouslyAllowAllUnixSockets;
  }
  if (network.mode !== undefined) config.network.mode = network.mode;
  if (network.domains !== undefined) {
    overlayNetworkDomainPermissions(config, network.domains);
  }
  if (network.unixSockets !== undefined) {
    overlayUnixSocketPermissions(config, network.unixSockets);
  }
  if (network.allowLocalBinding !== undefined) {
    config.network.allowLocalBinding = network.allowLocalBinding;
  }
}

export function applyNetworkTables(
  config: NetworkProxyConfig,
  parsed: NetworkTablesToml,
): void {
  const network = selectedNetworkFromTables(parsed);
  if (network !== null) applyNetworkTomlToConfig(config, network);
}

export function configFromLayers(
  layers: readonly ConfigLayer[],
  options: {
    readonly execPolicyNetworkRules?: readonly ExecPolicyNetworkRule[];
  } = {},
): NetworkProxyConfig {
  const config = defaultNetworkProxyConfig();
  for (const layer of layers) {
    applyNetworkTables(config, networkTablesFromToml(layer.config));
  }
  applyExecPolicyNetworkRules(config, options.execPolicyNetworkRules ?? []);
  return config;
}

export function networkConstraintsFromTrustedLayers(
  layers: readonly ConfigLayer[],
): NetworkProxyConstraints {
  const mutable: MutableNetworkProxyConstraints = {};
  for (const layer of layers) {
    if (!isTrustedLayerSource(layer.source)) continue;
    const network = selectedNetworkFromTables(networkTablesFromToml(layer.config));
    if (network !== null) applyNetworkConstraints(network, mutable);
  }
  return freezeConstraints(mutable);
}

export function applyNetworkConstraints(
  network: NetworkToml,
  constraints: MutableNetworkProxyConstraints,
): void {
  if (network.enabled !== undefined) constraints.enabled = network.enabled;
  if (network.mode !== undefined) constraints.mode = network.mode;
  if (network.allowUpstreamProxy !== undefined) {
    constraints.allowUpstreamProxy = network.allowUpstreamProxy;
  }
  if (network.dangerouslyAllowNonLoopbackProxy !== undefined) {
    constraints.dangerouslyAllowNonLoopbackProxy =
      network.dangerouslyAllowNonLoopbackProxy;
  }
  if (network.dangerouslyAllowAllUnixSockets !== undefined) {
    constraints.dangerouslyAllowAllUnixSockets =
      network.dangerouslyAllowAllUnixSockets;
  }
  if (network.domains !== undefined) {
    const config = defaultNetworkProxyConfig();
    if (constraints.allowedDomains !== undefined) {
      setAllowedDomains(config, constraints.allowedDomains);
    }
    if (constraints.deniedDomains !== undefined) {
      setDeniedDomains(config, constraints.deniedDomains);
    }
    overlayNetworkDomainPermissions(config, network.domains);
    const nextAllowed = allowedDomains(config);
    const nextDenied = deniedDomains(config);
    constraints.allowedDomains =
      nextAllowed.length > 0 ? [...nextAllowed] : undefined;
    constraints.deniedDomains =
      nextDenied.length > 0 ? [...nextDenied] : undefined;
  }
  if (network.unixSockets !== undefined) {
    const allowed = unixSocketAllowEntries(network.unixSockets);
    constraints.allowUnixSockets = allowed.length > 0 ? allowed : undefined;
  }
  if (network.allowLocalBinding !== undefined) {
    constraints.allowLocalBinding = network.allowLocalBinding;
  }
}

export function enforceTrustedConstraints(
  layers: readonly ConfigLayer[],
  config: NetworkProxyConfig,
): NetworkProxyConstraints {
  const constraints = networkConstraintsFromTrustedLayers(layers);
  validatePolicyAgainstConstraints(config, constraints);
  return constraints;
}

export function buildConfigState(
  config: NetworkProxyConfig,
  constraints: NetworkProxyConstraints = {},
): ConfigState {
  const configAllowedDomains = allowedDomains(config);
  const configDeniedDomains = deniedDomains(config);
  validateUnixSocketAllowlistPaths(config);
  validateDomainGlobPatterns("network.allowed_domains", configAllowedDomains, {
    allowGlobalWildcard: true,
  });
  validateDomainGlobPatterns("network.denied_domains", configDeniedDomains, {
    allowGlobalWildcard: false,
  });
  validateNonGlobalWildcardDomainPatterns(
    "network.denied_domains",
    configDeniedDomains,
  );
  validatePolicyAgainstConstraints(config, constraints);
  return {
    config: cloneNetworkProxyConfig(config),
    constraints: freezeConstraints({ ...constraints }),
    allowedDomains: [...configAllowedDomains],
    deniedDomains: [...configDeniedDomains],
  };
}

export function buildConfigStateFromLayers(
  layers: readonly ConfigLayer[],
  options: {
    readonly execPolicyNetworkRules?: readonly ExecPolicyNetworkRule[];
  } = {},
): ConfigState {
  const config = configFromLayers(layers, options);
  const constraints = enforceTrustedConstraints(layers, config);
  return buildConfigState(config, constraints);
}

export function hostPolicyDecision(
  state: ConfigState,
  host: string,
): HostPolicyDecision {
  const normalized = normalizeHost(host);
  if (state.deniedDomains.some((pattern) => hostMatchesPattern(pattern, normalized))) {
    return { kind: "blocked", reason: "denied" };
  }
  if (
    state.allowedDomains.length === 0 ||
    !state.allowedDomains.some((pattern) => hostMatchesPattern(pattern, normalized))
  ) {
    return { kind: "blocked", reason: "not_allowed" };
  }
  return { kind: "allowed" };
}

export function validatePolicyAgainstConstraints(
  config: NetworkProxyConfig,
  constraints: NetworkProxyConstraints,
): void {
  const network = config.network;
  const configAllowedDomains = allowedDomains(config);
  const configDeniedDomains = deniedDomains(config);
  const deniedDomainOverrides = new Set(
    configDeniedDomains.map((entry) => entry.toLowerCase()),
  );
  const configAllowUnixSockets = allowUnixSockets(config);

  validateNonGlobalWildcardDomainPatterns(
    "network.denied_domains",
    configDeniedDomains,
  );
  validateDomainGlobPatterns("network.allowed_domains", configAllowedDomains, {
    allowGlobalWildcard: true,
  });
  validateDomainGlobPatterns("network.denied_domains", configDeniedDomains, {
    allowGlobalWildcard: false,
  });

  if (constraints.enabled !== undefined && network.enabled && !constraints.enabled) {
    invalidValue("network.enabled", "true", "false (disabled by managed config)");
  }

  if (
    constraints.mode !== undefined &&
    networkModeRank(network.mode) > networkModeRank(constraints.mode)
  ) {
    invalidValue(
      "network.mode",
      network.mode,
      `${constraints.mode} or more restrictive`,
    );
  }

  if (
    constraints.allowUpstreamProxy === false &&
    network.allowUpstreamProxy
  ) {
    invalidValue(
      "network.allow_upstream_proxy",
      "true",
      "false (disabled by managed config)",
    );
  }

  if (
    constraints.dangerouslyAllowNonLoopbackProxy === false &&
    network.dangerouslyAllowNonLoopbackProxy
  ) {
    invalidValue(
      "network.dangerously_allow_non_loopback_proxy",
      "true",
      "false (disabled by managed config)",
    );
  }

  const allowAllUnixSockets =
    constraints.dangerouslyAllowAllUnixSockets ??
    constraints.allowUnixSockets === undefined;
  if (network.dangerouslyAllowAllUnixSockets && !allowAllUnixSockets) {
    invalidValue(
      "network.dangerously_allow_all_unix_sockets",
      "true",
      "false (disabled by managed config)",
    );
  }

  if (
    constraints.allowLocalBinding === false &&
    network.allowLocalBinding
  ) {
    invalidValue(
      "network.allow_local_binding",
      "true",
      "false (disabled by managed config)",
    );
  }

  if (constraints.allowedDomains !== undefined) {
    validateNonGlobalWildcardDomainPatterns(
      "network.allowed_domains",
      constraints.allowedDomains,
    );
    validateDomainGlobPatterns(
      "network.allowed_domains",
      constraints.allowedDomains,
      { allowGlobalWildcard: false },
    );
    validateAllowedDomainsConstraint(
      configAllowedDomains,
      constraints.allowedDomains,
      deniedDomainOverrides,
      constraints.allowlistExpansionEnabled,
    );
  }

  if (constraints.deniedDomains !== undefined) {
    validateNonGlobalWildcardDomainPatterns(
      "network.denied_domains",
      constraints.deniedDomains,
    );
    validateDomainGlobPatterns(
      "network.denied_domains",
      constraints.deniedDomains,
      { allowGlobalWildcard: false },
    );
    validateDeniedDomainsConstraint(
      configDeniedDomains,
      constraints.deniedDomains,
      constraints.denylistExpansionEnabled,
    );
  }

  if (constraints.allowUnixSockets !== undefined) {
    const allowedSet = new Set(
      constraints.allowUnixSockets.map((entry) => entry.toLowerCase()),
    );
    const invalid = configAllowUnixSockets.filter(
      (entry) => !allowedSet.has(entry.toLowerCase()),
    );
    if (invalid.length > 0) {
      invalidValue(
        "network.allow_unix_sockets",
        JSON.stringify(invalid),
        "subset of managed allow_unix_sockets",
      );
    }
  }
}

export function applyExecPolicyNetworkRules(
  config: NetworkProxyConfig,
  rules: readonly ExecPolicyNetworkRule[],
): void {
  const byHostProtocol = new Map<
    string,
    { readonly host: string; readonly decision: ExecPolicyNetworkDecision }
  >();

  for (const rule of rules) {
    const host = normalizeExecPolicyNetworkRuleHost(rule.host);
    const protocol = parseExecPolicyNetworkProtocol(rule.protocol);
    const decision = parseExecPolicyNetworkDecision(rule.decision);
    if (decision === "prompt") continue;
    byHostProtocol.set(`${host}\0${protocol}`, { host, decision });
  }

  const projectedByHost = new Map<string, ExecPolicyNetworkDecision>();
  for (const { host, decision } of byHostProtocol.values()) {
    const current = projectedByHost.get(host);
    if (current === "forbidden" || decision === "forbidden") {
      projectedByHost.set(host, "forbidden");
    } else {
      projectedByHost.set(host, "allow");
    }
  }

  for (const [host, decision] of projectedByHost) {
    upsertNetworkDomain(config, host, decision === "allow" ? "allow" : "deny");
  }
}

export async function buildNetworkProxyStateAndReloader(
  options: BuildNetworkProxyStateOptions = {},
): Promise<BuildNetworkProxyStateAndReloaderResult> {
  let reloader: MtimeConfigReloader | null = null;
  const load = async (): Promise<{
    readonly state: ConfigState;
    readonly layerMtimes: readonly LayerMtime[];
  }> => {
    const loaded = await loadConfigLayers(options);
    return {
      state: buildConfigStateFromLayers(loaded.layers, {
        execPolicyNetworkRules: options.execPolicyNetworkRules,
      }),
      layerMtimes: loaded.layerMtimes,
    };
  };
  const initial = await load();
  reloader = new MtimeConfigReloader(initial.layerMtimes, load);
  return {
    state: initial.state,
    reloader,
  };
}

export async function buildNetworkProxyState(
  options: BuildNetworkProxyStateOptions = {},
): Promise<NetworkProxyState> {
  const { state, reloader } = await buildNetworkProxyStateAndReloader(options);
  return new NetworkProxyState(state, reloader);
}

type MutableNetworkProxyConstraints = {
  -readonly [K in keyof NetworkProxyConstraints]: NetworkProxyConstraints[K];
};

function validateAllowedDomainsConstraint(
  candidate: readonly string[],
  required: readonly string[],
  deniedDomainOverrides: ReadonlySet<string>,
  expansionEnabled: boolean | undefined,
): void {
  const requiredSet = new Set(required.map((entry) => entry.toLowerCase()));
  const candidateSet = new Set(candidate.map((entry) => entry.toLowerCase()));

  if (expansionEnabled === true) {
    const missing = [...requiredSet].filter(
      (entry) => !candidateSet.has(entry) && !deniedDomainOverrides.has(entry),
    );
    if (missing.length > 0) {
      invalidValue(
        "network.allowed_domains",
        "missing managed allowed_domains entries",
        JSON.stringify(missing),
      );
    }
    return;
  }

  if (expansionEnabled === false) {
    const expected = new Set(
      [...requiredSet].filter((entry) => !deniedDomainOverrides.has(entry)),
    );
    if (!sameStringSet(candidateSet, expected)) {
      invalidValue(
        "network.allowed_domains",
        JSON.stringify(candidate),
        "must match managed allowed_domains",
      );
    }
    return;
  }

  const managedPatterns = required.map(parseDomainPattern);
  const invalid = candidate.filter((entry) => {
    const candidatePattern = parseDomainPatternForConstraints(entry);
    return !managedPatterns.some((managed) =>
      domainPatternAllows(managed, candidatePattern)
    );
  });
  if (invalid.length > 0) {
    invalidValue(
      "network.allowed_domains",
      JSON.stringify(invalid),
      "subset of managed allowed_domains",
    );
  }
}

function validateDeniedDomainsConstraint(
  candidate: readonly string[],
  required: readonly string[],
  expansionEnabled: boolean | undefined,
): void {
  const requiredSet = new Set(required.map((entry) => entry.toLowerCase()));
  const candidateSet = new Set(candidate.map((entry) => entry.toLowerCase()));
  if (expansionEnabled === false) {
    if (!sameStringSet(candidateSet, requiredSet)) {
      invalidValue(
        "network.denied_domains",
        JSON.stringify(candidate),
        "must match managed denied_domains",
      );
    }
    return;
  }

  const missing = [...requiredSet].filter((entry) => !candidateSet.has(entry));
  if (missing.length > 0) {
    invalidValue(
      "network.denied_domains",
      "missing managed denied_domains entries",
      JSON.stringify(missing),
    );
  }
}

function validateNonGlobalWildcardDomainPatterns(
  fieldName: string,
  patterns: readonly string[],
): void {
  const pattern = patterns.find(isGlobalWildcardDomainPattern);
  if (pattern !== undefined) {
    invalidValue(
      fieldName,
      pattern.trim(),
      "exact hosts or scoped wildcards like *.agenc.tech or **.agenc.tech",
    );
  }
}

function validateUnixSocketAllowlistPaths(config: NetworkProxyConfig): void {
  for (const socketPath of allowUnixSockets(config)) {
    if (!isPortableAbsolutePath(socketPath)) {
      invalidValue(
        "network.allow_unix_sockets",
        socketPath,
        "absolute filesystem paths",
      );
    }
  }
}

function networkTomlFromRaw(value: unknown, field: string): NetworkToml {
  if (!isPlainRecord(value)) {
    throw new Error(`${field} must be a TOML table`);
  }
  return {
    ...optionalBooleanEntry(value, "enabled", "enabled"),
    ...optionalStringEntry(value, "proxy_url", "proxyUrl"),
    ...optionalBooleanEntry(value, "enable_socks5", "enableSocks5"),
    ...optionalStringEntry(value, "socks_url", "socksUrl"),
    ...optionalBooleanEntry(value, "enable_socks5_udp", "enableSocks5Udp"),
    ...optionalBooleanEntry(value, "allow_upstream_proxy", "allowUpstreamProxy"),
    ...optionalBooleanEntry(
      value,
      "dangerously_allow_non_loopback_proxy",
      "dangerouslyAllowNonLoopbackProxy",
    ),
    ...optionalBooleanEntry(
      value,
      "dangerously_allow_all_unix_sockets",
      "dangerouslyAllowAllUnixSockets",
    ),
    ...optionalModeEntry(value),
    ...optionalDomainPermissionsEntry(value),
    ...optionalUnixSocketPermissionsEntry(value),
    ...optionalBooleanEntry(value, "allow_local_binding", "allowLocalBinding"),
  };
}

function overlayNetworkDomainPermissions(
  config: NetworkProxyConfig,
  domains: NetworkDomainPermissions,
): void {
  for (const entry of domains.entries) {
    upsertNetworkDomain(config, entry.pattern, entry.permission);
  }
}

function overlayUnixSocketPermissions(
  config: NetworkProxyConfig,
  unixSockets: NetworkUnixSocketPermissions,
): void {
  const current = { ...(config.network.unixSockets?.entries ?? {}) };
  for (const [socketPath, permission] of Object.entries(unixSockets.entries)) {
    current[socketPath] = permission;
  }
  config.network.unixSockets =
    Object.keys(current).length > 0 ? { entries: current } : null;
}

function setDomainEntries(
  config: NetworkProxyConfig,
  entries: readonly string[],
  permission: NetworkDomainPermission,
): void {
  const domains = config.network.domains ?? { entries: [] };
  const next = domains.entries.filter((entry) => entry.permission !== permission);
  for (const entry of entries) {
    if (!next.some((existing) =>
      existing.pattern === entry && existing.permission === permission
    )) {
      next.push({ pattern: entry, permission });
    }
  }
  config.network.domains = next.length > 0 ? { entries: next } : null;
}

function setUnixSocketEntries(
  config: NetworkProxyConfig,
  entries: readonly string[],
  permission: NetworkUnixSocketPermission,
): void {
  const current = { ...(config.network.unixSockets?.entries ?? {}) };
  for (const [socketPath, existing] of Object.entries(current)) {
    if (existing === permission) delete current[socketPath];
  }
  for (const entry of entries) current[entry] = permission;
  config.network.unixSockets =
    Object.keys(current).length > 0 ? { entries: current } : null;
}

function domainEntries(
  domains: NetworkDomainPermissions | null,
  permission: NetworkDomainPermission,
): readonly string[] {
  if (domains === null) return [];
  return effectiveDomainEntries(domains)
    .filter((entry) => entry.permission === permission)
    .map((entry) => entry.pattern);
}

function effectiveDomainEntries(
  domains: NetworkDomainPermissions,
): readonly NetworkDomainPermissionEntry[] {
  const order: string[] = [];
  const effective = new Map<string, NetworkDomainPermission>();
  for (const entry of domains.entries) {
    if (!effective.has(entry.pattern)) order.push(entry.pattern);
    const existing = effective.get(entry.pattern) ?? entry.permission;
    effective.set(
      entry.pattern,
      permissionRank(entry.permission) > permissionRank(existing)
        ? entry.permission
        : existing,
    );
  }
  return order.flatMap((pattern) => {
    const permission = effective.get(pattern);
    return permission === undefined || permission === "none"
      ? []
      : [{ pattern, permission }];
  });
}

function permissionRank(permission: NetworkDomainPermission): number {
  switch (permission) {
    case "none":
      return 0;
    case "allow":
      return 1;
    case "deny":
      return 2;
  }
}

function unixSocketAllowEntries(
  unixSockets: NetworkUnixSocketPermissions,
): string[] {
  return Object.entries(unixSockets.entries)
    .filter(([, permission]) => permission === "allow")
    .map(([socketPath]) => socketPath);
}

function parseExecPolicyNetworkProtocol(
  value: string,
): ExecPolicyNetworkProtocol {
  switch (value) {
    case "http":
      return "http";
    case "https":
    case "https_connect":
    case "http-connect":
      return "https";
    case "socks5-tcp":
    case "socks5_tcp":
      return "socks5-tcp";
    case "socks5-udp":
    case "socks5_udp":
      return "socks5-udp";
    default:
      throw new Error(
        `network rule protocol must be one of http, https, socks5_tcp, socks5_udp (got ${value})`,
      );
  }
}

function parseExecPolicyNetworkDecision(
  value: string,
): ExecPolicyNetworkDecision {
  switch (value) {
    case "allow":
    case "forbidden":
    case "prompt":
      return value;
    case "deny":
      return "forbidden";
    default:
      throw new Error(
        `network rule decision must be one of allow, forbidden, prompt (got ${value})`,
      );
  }
}

function normalizeExecPolicyNetworkRuleHost(raw: string): string {
  let host = raw.trim();
  if (host.length === 0) {
    throw new Error("network rule host cannot be empty");
  }
  if (host.includes("://") || /[/?#]/u.test(host)) {
    throw new Error("network rule host must be a hostname or IP literal");
  }
  host = normalizeHost(host);
  if (host.length === 0) throw new Error("network rule host cannot be empty");
  if (host.includes("*")) {
    throw new Error("network rule host must be a specific host");
  }
  if (/\s/u.test(host)) {
    throw new Error("network rule host cannot contain whitespace");
  }
  return host;
}

function parseDomainPattern(input: string): DomainPattern {
  return parseDomainPatternForConstraints(input);
}

function parseDomainPatternForConstraints(input: string): DomainPattern {
  const trimmed = input.trim();
  if (trimmed.length === 0) return { kind: "exact", domain: "" };
  if (trimmed.startsWith("**.")) {
    return {
      kind: "apex_and_subdomains",
      domain: parseDomainForConstraints(trimmed.slice(3)),
    };
  }
  if (trimmed.startsWith("*.")) {
    return {
      kind: "subdomains_only",
      domain: parseDomainForConstraints(trimmed.slice(2)),
    };
  }
  return { kind: "exact", domain: parseDomainForConstraints(trimmed) };
}

type DomainPattern =
  | { readonly kind: "exact"; readonly domain: string }
  | { readonly kind: "subdomains_only"; readonly domain: string }
  | { readonly kind: "apex_and_subdomains"; readonly domain: string };

function domainPatternAllows(
  managed: DomainPattern,
  candidate: DomainPattern,
): boolean {
  switch (managed.kind) {
    case "exact":
      return candidate.kind === "exact" &&
        domainEq(candidate.domain, managed.domain);
    case "subdomains_only":
      switch (candidate.kind) {
        case "exact":
          return isStrictSubdomain(candidate.domain, managed.domain);
        case "subdomains_only":
          return isSubdomainOrEqual(candidate.domain, managed.domain);
        case "apex_and_subdomains":
          return isStrictSubdomain(candidate.domain, managed.domain);
      }
    case "apex_and_subdomains":
      return isSubdomainOrEqual(candidate.domain, managed.domain);
  }
}

function hostMatchesPattern(pattern: string, normalizedHost: string): boolean {
  return compileDomainPattern(pattern, { allowGlobalWildcard: true }).some(
    (candidate) => candidate.test(normalizedHost),
  );
}

function isGlobalWildcardDomainPattern(pattern: string): boolean {
  const parsed = parseDomainPatternForConstraints(pattern);
  if (parsed.kind === "exact") return parsed.domain === "*";
  if (parsed.kind === "apex_and_subdomains") return parsed.domain === "*";
  return false;
}

function validateDomainGlobPatterns(
  fieldName: string,
  patterns: readonly string[],
  options: { readonly allowGlobalWildcard: boolean },
): void {
  for (const pattern of patterns) {
    compileDomainPattern(pattern, options, fieldName);
  }
}

function compileDomainPattern(
  input: string,
  options: { readonly allowGlobalWildcard: boolean },
  fieldName = "network.domains",
): readonly RegExp[] {
  const normalized = normalizeDomainPattern(input);
  const candidates = expandDomainPattern(normalized);
  if (!options.allowGlobalWildcard && candidates.some((entry) => entry === "*")) {
    invalidValue(
      fieldName,
      input,
      "exact hosts or scoped wildcards like *.agenc.tech or **.agenc.tech",
    );
  }

  return candidates.map((candidate) => {
    const source = globCandidateToRegex(candidate, fieldName);
    try {
      return new RegExp(`^${source}$`, "iu");
    } catch {
      invalidValue(fieldName, candidate, "valid domain glob pattern");
    }
  });
}

function normalizeDomainPattern(pattern: string): string {
  const trimmed = pattern.trim();
  if (trimmed === "*") return "*";

  if (trimmed.startsWith("**.")) {
    return `**.${normalizeHost(trimmed.slice(3))}`;
  }
  if (trimmed.startsWith("*.")) {
    return `*.${normalizeHost(trimmed.slice(2))}`;
  }
  return normalizeHost(trimmed);
}

function expandDomainPattern(pattern: string): readonly string[] {
  if (pattern.startsWith("**.")) {
    const domain = pattern.slice(3);
    return [domain, `?*.${domain}`];
  }
  if (pattern.startsWith("*.")) {
    return [`?*.${pattern.slice(2)}`];
  }
  return [pattern];
}

function globCandidateToRegex(candidate: string, fieldName: string): string {
  let result = "";
  for (let index = 0; index < candidate.length; index += 1) {
    const char = candidate[index];
    if (char === "*") {
      result += ".*";
      continue;
    }
    if (char === "?") {
      result += ".";
      continue;
    }
    if (char === "[") {
      const end = candidate.indexOf("]", index + 1);
      if (end < 0 || end === index + 1) {
        invalidValue(fieldName, candidate, "valid domain glob pattern");
      }
      result += candidate.slice(index, end + 1);
      index = end;
      continue;
    }
    if (char === "]") {
      invalidValue(fieldName, candidate, "valid domain glob pattern");
    }
    result += regexEscape(char);
  }
  return result;
}

function regexEscape(char: string): string {
  return /[\\^$+?.()|{}]/u.test(char) ? `\\${char}` : char;
}

function parseDomainForConstraints(domain: string): string {
  const trimmed = domain.trim().replace(/\.+$/u, "");
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return normalizeHost(trimmed);
  }
  if (/[?*%]/u.test(trimmed)) return trimmed;
  return normalizeHost(trimmed);
}

function domainEq(left: string, right: string): boolean {
  return normalizeDomain(left) === normalizeDomain(right);
}

function isSubdomainOrEqual(child: string, parent: string): boolean {
  const normalizedChild = normalizeDomain(child);
  const normalizedParent = normalizeDomain(parent);
  return normalizedChild === normalizedParent ||
    normalizedChild.endsWith(`.${normalizedParent}`);
}

function isStrictSubdomain(child: string, parent: string): boolean {
  const normalizedChild = normalizeDomain(child);
  const normalizedParent = normalizeDomain(parent);
  return normalizedChild !== normalizedParent &&
    normalizedChild.endsWith(`.${normalizedParent}`);
}

function normalizeDomain(domain: string): string {
  return domain.trim().replace(/\.+$/u, "").toLowerCase();
}

function normalizeDnsHostOrIpLiteral(host: string): string {
  const lower = host.trim().replace(/\.+$/u, "").toLowerCase();
  return lower.replace(/%25/gu, "%");
}

function colonCount(value: string): number {
  return [...value].filter((char) => char === ":").length;
}

function splitOnce(value: string, delimiter: string): [string, string] {
  const index = value.indexOf(delimiter);
  return [value.slice(0, index), value.slice(index + delimiter.length)];
}

function networkModeRank(mode: NetworkMode): number {
  switch (mode) {
    case "limited":
      return 0;
    case "full":
      return 1;
  }
}

function invalidValue(
  fieldName: string,
  candidate: string,
  allowed: string,
): never {
  throw new NetworkProxyConstraintError(fieldName, candidate, allowed);
}

function sameStringSet(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
): boolean {
  if (left.size !== right.size) return false;
  for (const value of left) {
    if (!right.has(value)) return false;
  }
  return true;
}

function freezeConstraints(
  constraints: MutableNetworkProxyConstraints,
): NetworkProxyConstraints {
  return Object.freeze({
    ...constraints,
    ...(constraints.allowedDomains !== undefined
      ? { allowedDomains: Object.freeze([...constraints.allowedDomains]) }
      : {}),
    ...(constraints.deniedDomains !== undefined
      ? { deniedDomains: Object.freeze([...constraints.deniedDomains]) }
      : {}),
    ...(constraints.allowUnixSockets !== undefined
      ? { allowUnixSockets: Object.freeze([...constraints.allowUnixSockets]) }
      : {}),
  });
}

function cloneNetworkProxyConfig(config: NetworkProxyConfig): NetworkProxyConfig {
  return {
    network: {
      ...config.network,
      domains: config.network.domains === null
        ? null
        : {
            entries: config.network.domains.entries.map((entry) => ({ ...entry })),
          },
      unixSockets: config.network.unixSockets === null
        ? null
        : { entries: { ...config.network.unixSockets.entries } },
    },
  };
}

function isTrustedLayerSource(source: ConfigLayerSource): boolean {
  return (
    source === "system" ||
    source === "managed" ||
    source === "legacy_managed"
  );
}

function optionalString(
  value: unknown,
  field: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string`);
  }
  return value;
}

function optionalBooleanEntry<T extends keyof NetworkToml>(
  value: Readonly<Record<string, unknown>>,
  source: string,
  target: T,
): Partial<Pick<NetworkToml, T>> {
  const raw = value[source];
  if (raw === undefined) return {};
  if (typeof raw !== "boolean") {
    throw new Error(`${source} must be a boolean`);
  }
  return { [target]: raw } as Partial<Pick<NetworkToml, T>>;
}

function optionalStringEntry<T extends keyof NetworkToml>(
  value: Readonly<Record<string, unknown>>,
  source: string,
  target: T,
): Partial<Pick<NetworkToml, T>> {
  const raw = value[source];
  if (raw === undefined) return {};
  if (typeof raw !== "string") {
    throw new Error(`${source} must be a string`);
  }
  return { [target]: raw } as Partial<Pick<NetworkToml, T>>;
}

function optionalModeEntry(
  value: Readonly<Record<string, unknown>>,
): Pick<NetworkToml, "mode"> | Record<string, never> {
  const raw = value.mode;
  if (raw === undefined) return {};
  if (raw !== "limited" && raw !== "full") {
    throw new Error("network.mode must be limited or full");
  }
  return { mode: raw };
}

function optionalDomainPermissionsEntry(
  value: Readonly<Record<string, unknown>>,
): Pick<NetworkToml, "domains"> | Record<string, never> {
  const raw = value.domains;
  if (raw === undefined) return {};
  if (!isPlainRecord(raw)) throw new Error("network.domains must be a table");
  return {
    domains: {
      entries: Object.entries(raw).map(([pattern, permission]) => {
        if (permission !== "allow" && permission !== "deny") {
          throw new Error(
            `network.domains.${pattern} must be allow or deny`,
          );
        }
        return { pattern, permission };
      }),
    },
  };
}

function optionalUnixSocketPermissionsEntry(
  value: Readonly<Record<string, unknown>>,
): Pick<NetworkToml, "unixSockets"> | Record<string, never> {
  const raw = value.unix_sockets;
  if (raw === undefined) return {};
  if (!isPlainRecord(raw)) {
    throw new Error("network.unix_sockets must be a table");
  }
  const entries: Record<string, NetworkUnixSocketPermission> = {};
  for (const [socketPath, permission] of Object.entries(raw)) {
    if (permission !== "allow" && permission !== "none") {
      throw new Error(
        `network.unix_sockets.${socketPath} must be allow or none`,
      );
    }
    entries[socketPath] = permission;
  }
  return { unixSockets: { entries } };
}

function isPortableAbsolutePath(value: string): boolean {
  return (
    path.posix.isAbsolute(value) ||
    /^[A-Za-z]:[\\/]/u.test(value) ||
    /^\\\\[^\\]+\\[^\\]+/u.test(value)
  );
}

async function loadConfigLayers(
  options: BuildNetworkProxyStateOptions,
): Promise<LoadedLayers> {
  if (options.layers !== undefined) {
    return {
      layers: options.layers,
      layerMtimes: await captureLayerMtimes(options.layers),
    };
  }

  const agencHome = options.agencHome ?? resolveAgencHome(options.env);
  const configPath = path.join(agencHome, "config.toml");
  let raw: string;
  try {
    raw = await readTextFile(configPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { layers: [], layerMtimes: [] };
    throw error;
  }
  const parsed = parseToml(raw);
  if (!isPlainRecord(parsed)) {
    throw new Error("config.toml must parse to a TOML table");
  }
  const layers: readonly ConfigLayer[] = [
    { source: "user", config: parsed, path: configPath },
  ];
  return {
    layers,
    layerMtimes: await captureLayerMtimes(layers),
  };
}

async function captureLayerMtimes(
  layers: readonly ConfigLayer[],
): Promise<readonly LayerMtime[]> {
  const mtimes: LayerMtime[] = [];
  for (const layer of layers) {
    if (layer.path === undefined) continue;
    mtimes.push({ path: layer.path, mtimeMs: await readMtimeMs(layer.path) });
  }
  return mtimes;
}

async function readMtimeMs(filePath: string): Promise<number | null> {
  try {
    return (await stat(filePath)).mtimeMs;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw error;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}
