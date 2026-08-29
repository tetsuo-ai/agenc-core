import { dirname, join, resolve } from "node:path";

import { findProjectRootSync } from "../session/session-store.js";
import { resolveManagedConfigPath } from "../utils/settings/managedPath.js";
import {
  applyEnvOverrides,
  resolveProfileName,
  type EnvSnapshot,
} from "./env.js";
import { resolveHomeContext, type HomeContext } from "./home.js";
import { cloneRecord, isPlainRecord, stableJson, type JsonRecord } from "./json.js";
import {
  MANAGED_ONLY_CONFIG_KEYS,
  OPERATOR_ONLY_CONFIG_KEYS,
  OPERATOR_ONLY_CONFIG_PATHS,
} from "./layer-authority.js";
import { parseToml } from "./loader.js";
import { resolveProfile } from "./profiles.js";
import {
  assertNoSymlinkAncestors,
  readStableDirectory,
  readStableFile,
  stableUtf8Text,
} from "./stable-file.js";
import { detectRetiredConfigInputs } from "./retired-input-preflight.js";
import {
  defaultConfig,
  KNOWN_CONFIG_KEYS,
  mergeConfigs,
  normalizeRawConfig,
  validateAgenCConfigBlocks,
  validatePermissionsConfig,
  type AgenCConfig,
  type McpServerConfig,
} from "./schema.js";
import { resolveProviderModelLayer } from "./provider-model-authority.js";

export const CANONICAL_CONFIG_VERSION = 2 as const;
export const CANONICAL_CONFIG_VERSION_KEY = "config_version" as const;

export type ConfigScope =
  | "default"
  | "plugin"
  | "user"
  | "project"
  | "local"
  | "flag"
  | "profile"
  | "environment"
  | "cli"
  | "managed";

export interface ConfigLayerSource {
  readonly scope: ConfigScope;
  readonly path?: string;
  readonly label: string;
}

export interface ConfigProvenanceEntry extends ConfigLayerSource {
  readonly contributors: readonly ConfigLayerSource[];
}

export interface IgnoredConfigValue extends ConfigLayerSource {
  readonly key: string;
  readonly reason: string;
}

export interface ConfigLayerSnapshot extends ConfigLayerSource {
  readonly config: AgenCConfig;
}

export interface McpLayerCandidate {
  readonly name: string;
  readonly source: ConfigLayerSource;
  readonly contributors: readonly ConfigLayerSource[];
  readonly declaration: McpServerConfig;
  readonly config: McpServerConfig;
}

export interface ResolvedMcpLayerCandidates {
  readonly managedExclusive: boolean;
  readonly candidatesByName: ReadonlyMap<
    string,
    readonly McpLayerCandidate[]
  >;
  /** Incomplete admitted substrate that no later layer completed. */
  readonly unresolved: ReadonlyMap<string, McpLayerCandidate>;
  readonly winners: ReadonlyMap<string, McpLayerCandidate>;
}

export type McpLayerCandidateDecision = "accept" | "defer" | "reject";

interface StableLayerIdentity {
  readonly path: string;
  readonly resolvedPath: string;
  readonly dev: number;
  readonly ino: number;
  readonly identity: string;
}

const STABLE_LAYER_IDENTITIES = new WeakMap<ConfigLayerSnapshot, StableLayerIdentity>();

export interface ResolvedLayeredConfig {
  readonly config: AgenCConfig;
  readonly home: HomeContext;
  readonly projectRoot: string;
  readonly sources: readonly ConfigLayerSnapshot[];
  readonly provenance: Readonly<Record<string, ConfigProvenanceEntry>>;
  readonly ignored: readonly IgnoredConfigValue[];
}

export interface LoadedCanonicalConfig extends ResolvedLayeredConfig {
  /** Canonical user configuration path (kept for CLI/status callers). */
  readonly path: string;
  readonly exists: boolean;
}

export interface LoadCanonicalConfigOptions
  extends Omit<LayeredConfigRepositoryOptions, "home" | "pluginDefaults"> {
  readonly home?: HomeContext | string;
  /** Lowest-priority programmatic defaults used by embedders/tests. */
  readonly base?: AgenCConfig;
}

export interface LoadCanonicalDaemonConfigOptions {
  readonly env?: EnvSnapshot;
  readonly home?: HomeContext | string;
  readonly managedConfigPath?: string;
  readonly managedDropInDir?: string;
  readonly profileName?: string;
  readonly onWarn?: (message: string) => void;
  /** Lowest-priority programmatic defaults used by embedders/tests. */
  readonly base?: AgenCConfig;
}

export interface LayeredConfigRepositoryOptions {
  readonly env?: EnvSnapshot;
  readonly home?: HomeContext;
  readonly cwd?: string;
  readonly projectRoot?: string;
  readonly projectTrusted?: boolean;
  readonly retainUntrustedProjectCommandHooks?: boolean;
  readonly flagConfigPath?: string;
  readonly managedConfigPath?: string;
  readonly managedDropInDir?: string;
  readonly pluginDefaults?: AgenCConfig;
  /**
   * Immutable command-line layer. The canonical layer merger couples any
   * provider/model selector after applying lower-priority authorities.
   */
  readonly cliOverrides?: AgenCConfig;
  readonly profileName?: string;
  readonly onWarn?: (message: string) => void;
}

export class ConfigRepositoryError extends Error {
  readonly code:
    | "duplicate-key"
    | "invalid-toml"
    | "invalid-version"
    | "unknown-key"
    | "invalid-config"
    | "invalid-source"
    | "retired-input";
  readonly path?: string;

  constructor(
    code: ConfigRepositoryError["code"],
    message: string,
    path?: string,
  ) {
    super(message);
    this.name = "ConfigRepositoryError";
    this.code = code;
    this.path = path;
  }
}

const V2_TOP_LEVEL_KEYS = new Set(
  KNOWN_CONFIG_KEYS.filter(
    (key) => key !== "configVersion" && key !== "_unknown",
  ),
);
V2_TOP_LEVEL_KEYS.add(CANONICAL_CONFIG_VERSION_KEY);

const REPOSITORY_SCOPES = new Set<ConfigScope>(["project", "local"]);
const NON_OPERATOR_SCOPES = new Set<ConfigScope>([
  "default",
  "plugin",
  "project",
  "local",
]);
/**
 * An untrusted repository may only add restrictions. This is deliberately an
 * allowlist: adding a new schema key must not accidentally make it active in
 * a cloned workspace before the user records trust.
 */
const UNTRUSTED_REPOSITORY_ALLOWED_KEYS = new Set([
  "configVersion",
  "permissions",
  "sandbox_mode",
  "sandbox",
]);

function source(
  scope: ConfigScope,
  label: string,
  path?: string,
): ConfigLayerSource {
  return Object.freeze({
    scope,
    label,
    ...(path !== undefined ? { path } : {}),
  });
}

async function readConfigSource(
  path: string,
  scope: ConfigScope,
): Promise<Awaited<ReturnType<typeof readStableFile>>> {
  let snapshot: Awaited<ReturnType<typeof readStableFile>>;
  try {
    snapshot = await readStableFile(path, {
      allowLeafSymlink: scope !== "managed",
    });
  } catch (error) {
    throw new ConfigRepositoryError(
      "invalid-source",
      scope === "managed" &&
          (error as { readonly code?: unknown }).code === "symbolic-link"
        ? `managed configuration may not be a symbolic link: ${path}`
        : error instanceof Error
          ? error.message
          : `could not read configuration source: ${path}`,
      path,
    );
  }
  if (
    snapshot !== null &&
    scope === "managed" &&
    process.platform !== "win32" &&
    (snapshot.mode & 0o022) !== 0
  ) {
    throw new ConfigRepositoryError(
      "invalid-source",
      `managed configuration must not be group- or world-writable: ${path}`,
      path,
    );
  }
  return snapshot;
}

export function validateStrictConfigDocument(
  raw: Readonly<JsonRecord>,
  path = "<config>",
): AgenCConfig {
  const version = raw[CANONICAL_CONFIG_VERSION_KEY];
  if (version !== CANONICAL_CONFIG_VERSION) {
    throw new ConfigRepositoryError(
      "invalid-version",
      `${path} must declare ${CANONICAL_CONFIG_VERSION_KEY} = ${CANONICAL_CONFIG_VERSION}; ` +
        'run "agenc config migrate check" to inspect retired pre-v2 configuration',
      path,
    );
  }

  const unknown = Object.keys(raw).filter((key) => !V2_TOP_LEVEL_KEYS.has(key));
  if (unknown.length > 0) {
    throw new ConfigRepositoryError(
      "unknown-key",
      `${path} contains unknown schema-v2 key${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`,
      path,
    );
  }

  const canonical = cloneRecord(raw);
  delete canonical[CANONICAL_CONFIG_VERSION_KEY];
  canonical.configVersion = CANONICAL_CONFIG_VERSION;
  try {
    const normalized = normalizeRawConfig(canonical);
    if (normalized._unknown && Object.keys(normalized._unknown).length > 0) {
      throw new Error(`unknown keys: ${Object.keys(normalized._unknown).join(", ")}`);
    }
    const validated = validateAgenCConfigBlocks(normalized);
    validatePermissionsConfig(validated.permissions);
    return validated;
  } catch (error) {
    throw new ConfigRepositoryError(
      "invalid-config",
      `invalid schema-v2 config at ${path}: ${error instanceof Error ? error.message : String(error)}`,
      path,
    );
  }
}

export async function readStrictConfigLayer(
  path: string,
  scope: ConfigScope,
  label: string = scope,
): Promise<ConfigLayerSnapshot | null> {
  const snapshot = await readConfigSource(path, scope);
  if (snapshot === null) return null;
  let duplicate = false;
  let parsed: JsonRecord;
  try {
    parsed = cloneRecord(parseToml(stableUtf8Text(snapshot), {
      onDuplicateKey: () => {
        duplicate = true;
      },
    }));
  } catch (error) {
    throw new ConfigRepositoryError(
      "invalid-toml",
      `invalid TOML at ${path}: ${error instanceof Error ? error.message : String(error)}`,
      path,
    );
  }
  if (duplicate) {
    throw new ConfigRepositoryError(
      "duplicate-key",
      `duplicate TOML keys are not allowed in schema-v2 config: ${path}`,
      path,
    );
  }
  const layer = Object.freeze({
    ...source(scope, label, path),
    config: validateStrictConfigDocument(parsed, path),
  });
  STABLE_LAYER_IDENTITIES.set(layer, Object.freeze({
    path: resolve(path),
    resolvedPath: snapshot.resolvedPath,
    dev: snapshot.dev,
    ino: snapshot.ino,
    identity: snapshot.identity,
  }));
  return layer;
}

async function readManagedLayers(
  basePath: string,
  dropInDir: string,
): Promise<ConfigLayerSnapshot[]> {
  for (const path of [basePath, dropInDir]) {
    try {
      await assertNoSymlinkAncestors(path);
    } catch (error) {
      throw new ConfigRepositoryError(
        "invalid-source",
        error instanceof Error
          ? error.message
          : `could not validate managed configuration ancestors: ${path}`,
        path,
      );
    }
  }
  const layers: ConfigLayerSnapshot[] = [];
  const base = await readStrictConfigLayer(basePath, "managed", "managed base");
  if (base) layers.push(base);
  let directory: Awaited<ReturnType<typeof readStableDirectory>>;
  try {
    directory = await readStableDirectory(dropInDir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return layers;
    throw new ConfigRepositoryError(
      "invalid-source",
      error instanceof Error
        ? error.message
        : `could not read managed configuration directory: ${dropInDir}`,
      dropInDir,
    );
  }
  if (directory === null) return layers;
  const names = directory.entries
    .filter((entry) =>
      entry.name.endsWith(".toml") && !entry.name.startsWith(".")
    )
    .map((entry) => entry.name)
    .sort();
  for (const name of names) {
    const path = join(dropInDir, name);
    const layer = await readStrictConfigLayer(path, "managed", `managed drop-in ${name}`);
    if (layer) layers.push(layer);
  }
  return layers;
}

function leafPaths(value: unknown, prefix = ""): string[] {
  if (!isPlainRecord(value) || Object.keys(value).length === 0) {
    return prefix.length > 0 ? [prefix] : [];
  }
  const paths: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    const path = prefix.length > 0 ? `${prefix}.${key}` : key;
    if (isPlainRecord(child) && Object.keys(child).length > 0) {
      paths.push(...leafPaths(child, path));
    } else {
      paths.push(path);
    }
  }
  return paths;
}

function recordIgnored(
  ignored: IgnoredConfigValue[],
  layer: ConfigLayerSnapshot,
  key: string,
  reason: string,
): void {
  ignored.push(Object.freeze({ ...source(layer.scope, layer.label, layer.path), key, reason }));
}

function removeKey(
  raw: JsonRecord,
  key: string,
  layer: ConfigLayerSnapshot,
  ignored: IgnoredConfigValue[],
  reason: string,
): void {
  if (!Object.prototype.hasOwnProperty.call(raw, key)) return;
  delete raw[key];
  recordIgnored(ignored, layer, key, reason);
}

function removeNestedKey(
  raw: JsonRecord,
  parent: string,
  key: string,
  layer: ConfigLayerSnapshot,
  ignored: IgnoredConfigValue[],
  reason: string,
): void {
  const value = raw[parent];
  if (!isPlainRecord(value) || !Object.prototype.hasOwnProperty.call(value, key)) {
    return;
  }
  const next = cloneRecord(value);
  delete next[key];
  raw[parent] = next;
  recordIgnored(ignored, layer, `${parent}.${key}`, reason);
}

function removeNestedPath(
  raw: JsonRecord,
  path: readonly string[],
  layer: ConfigLayerSnapshot,
  ignored: IgnoredConfigValue[],
  reason: string,
): void {
  if (path.length === 0) return;
  let cursor = raw;
  for (const segment of path.slice(0, -1)) {
    const child = cursor[segment];
    if (!isPlainRecord(child)) return;
    cursor = child;
  }
  const leaf = path.at(-1);
  if (leaf === undefined || !Object.prototype.hasOwnProperty.call(cursor, leaf)) {
    return;
  }
  delete cursor[leaf];
  recordIgnored(ignored, layer, path.join("."), reason);
}

function sanitizeTopLevelAuthority(
  layer: ConfigLayerSnapshot,
  ignored: IgnoredConfigValue[],
): AgenCConfig {
  const raw = cloneRecord(layer.config as Readonly<Record<string, unknown>>);
  for (const key of MANAGED_ONLY_CONFIG_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(raw, key) || layer.scope === "managed") {
      continue;
    }
    if (
      layer.scope === "user" ||
      layer.scope === "flag" ||
      layer.scope === "profile" ||
      layer.scope === "environment" ||
      layer.scope === "cli"
    ) {
      throw new ConfigRepositoryError(
        "invalid-source",
        `${layer.label} cannot set managed-only key ${key}; move it to canonical managed config.toml`,
        layer.path,
      );
    }
    removeKey(
      raw,
      key,
      layer,
      ignored,
      "only canonical managed config.toml may set this policy value",
    );
  }
  for (const key of OPERATOR_ONLY_CONFIG_KEYS) {
    if (
      !Object.prototype.hasOwnProperty.call(raw, key) ||
      !NON_OPERATOR_SCOPES.has(layer.scope)
    ) {
      continue;
    }
    removeKey(
      raw,
      key,
      layer,
      ignored,
      "only an explicit operator or managed layer may set this value",
    );
  }
  if (NON_OPERATOR_SCOPES.has(layer.scope)) {
    for (const path of OPERATOR_ONLY_CONFIG_PATHS) {
      removeNestedPath(
        raw,
        path,
        layer,
        ignored,
        "only an explicit operator or managed layer may set this value",
      );
    }
  }
  return mergeConfigs({}, raw as AgenCConfig);
}

function sandboxRank(value: unknown): number | undefined {
  switch (value) {
    case "danger-full-access":
    case "off":
      return 0;
    case "workspace-write":
      return 1;
    case "read-only":
      return 2;
    default:
      return undefined;
  }
}

function currentSandboxMode(config: AgenCConfig): unknown {
  return config.sandbox_mode;
}

function sanitizeRepositoryLayer(
  base: AgenCConfig,
  layer: ConfigLayerSnapshot,
  projectTrusted: boolean,
  ignored: IgnoredConfigValue[],
  retainUntrustedProjectCommandHooks = false,
): AgenCConfig {
  const authoritySafe = sanitizeTopLevelAuthority(layer, ignored);
  if (!REPOSITORY_SCOPES.has(layer.scope)) return authoritySafe;
  const raw = cloneRecord(authoritySafe as Readonly<Record<string, unknown>>);

  removeKey(
    raw,
    "project_root_markers",
    layer,
    ignored,
    "a repository cannot redefine the root used to locate its own config",
  );
  removeKey(
    raw,
    "approval_policy",
    layer,
    ignored,
    "repository configuration cannot grant or change approval authority",
  );

  if (!projectTrusted) {
    for (const key of Object.keys(raw)) {
      if (
        UNTRUSTED_REPOSITORY_ALLOWED_KEYS.has(key) ||
        (retainUntrustedProjectCommandHooks && key === "hooks")
      ) {
        continue;
      }
      removeKey(
        raw,
        key,
        layer,
        ignored,
        "inactive until the canonical project root is trusted",
      );
    }
  }

  if (isPlainRecord(raw.permissions)) {
    const permissions = cloneRecord(raw.permissions);
    for (const key of ["allow", "additionalDirectories", "defaultMode"] as const) {
      if (Object.prototype.hasOwnProperty.call(permissions, key)) {
        delete permissions[key];
        recordIgnored(
          ignored,
          layer,
          `permissions.${key}`,
          "project/local configuration may restrict execution but cannot grant authority",
        );
      }
    }
    if (permissions.bypassPermissionsMode === "allow") {
      delete permissions.bypassPermissionsMode;
      recordIgnored(
        ignored,
        layer,
        "permissions.bypassPermissionsMode",
        "project/local configuration cannot enable permission bypass",
      );
    }
    raw.permissions = permissions;
  }

  for (const key of [
    "auth",
    "profiles",
    "providers",
    "attachments",
    "mcp",
    "protocol",
    "daemon",
    "xaa_idp",
    "autoMode",
    "plugins",
    "pluginConfigs",
    "statusLine",
    "fileSuggestion",
  ] as const) {
    removeKey(
      raw,
      key,
      layer,
      ignored,
      "project/local configuration cannot install an operator-owned capability or executable authority",
    );
  }

  for (const key of ["autonomous_mode", "coordinator_mode"] as const) {
    if (raw[key] === true) {
      removeKey(
        raw,
        key,
        layer,
        ignored,
        "project/local configuration cannot enable autonomous execution",
      );
    }
  }
  if (raw.disableAllHooks === false) {
    removeKey(
      raw,
      "disableAllHooks",
      layer,
      ignored,
      "project/local configuration cannot undo an earlier hook restriction",
    );
  }

  if (isPlainRecord(raw.heartbeat) && raw.heartbeat.enabled !== false) {
    removeKey(
      raw,
      "heartbeat",
      layer,
      ignored,
      "project/local configuration cannot enable or retarget autonomous heartbeat execution",
    );
  }
  if (isPlainRecord(raw.autoFix) && raw.autoFix.enabled !== false) {
    removeKey(
      raw,
      "autoFix",
      layer,
      ignored,
      "project/local configuration cannot install executable auto-fix commands",
    );
  }

  if (isPlainRecord(raw.tools_config)) {
    const tools = raw.tools_config;
    for (const key of [
      "enabled_tools",
      "web_search_endpoint",
      "web_search_endpoint_kind",
    ] as const) {
      if (!Object.prototype.hasOwnProperty.call(tools, key)) continue;
      delete tools[key];
      recordIgnored(
        ignored,
        layer,
        `tools_config.${key}`,
        "project/local configuration cannot enable tools or choose remote tool endpoints",
      );
    }
    for (const [toolName, value] of Object.entries(tools)) {
      if (toolName === "disabled_tools") continue;
      if (!isPlainRecord(value)) continue;
      if (Object.prototype.hasOwnProperty.call(value, "default_permission_mode")) {
        delete value.default_permission_mode;
        recordIgnored(
          ignored,
          layer,
          `tools_config.${toolName}.default_permission_mode`,
          "project/local configuration cannot choose approval defaults",
        );
      }
    }
  }

  if (isPlainRecord(raw.mcp_servers)) {
    for (const [serverName, value] of Object.entries(raw.mcp_servers)) {
      if (!isPlainRecord(value)) continue;
      for (const key of ["default_tools_approval_mode", "enabled_tools"] as const) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
        delete value[key];
        recordIgnored(
          ignored,
          layer,
          `mcp_servers.${serverName}.${key}`,
          "MCP declarations require independent approval and cannot grant tool authority",
        );
      }
      if (!isPlainRecord(value.tools)) continue;
      for (const [toolName, toolValue] of Object.entries(value.tools)) {
        if (!isPlainRecord(toolValue)) continue;
        if (Object.prototype.hasOwnProperty.call(toolValue, "default_permission_mode")) {
          delete toolValue.default_permission_mode;
          recordIgnored(
            ignored,
            layer,
            `mcp_servers.${serverName}.tools.${toolName}.default_permission_mode`,
            "project/local configuration cannot choose MCP approval defaults",
          );
        }
      }
    }
  }

  for (const path of [
    ["browser", "executable_path"],
    ["browser", "profile_dir"],
    ["buffer", "neovim", "executable"],
    ["llm", "xai", "remote_mcp"],
  ] as const) {
    removeNestedPath(
      raw,
      path,
      layer,
      ignored,
      "project/local configuration cannot choose an executable, profile, or remote endpoint",
    );
  }
  for (const key of ["allow_private_network", "no_sandbox"] as const) {
    if (isPlainRecord(raw.browser) && raw.browser[key] === true) {
      removeNestedKey(
        raw,
        "browser",
        key,
        layer,
        ignored,
        "project/local configuration cannot weaken browser isolation",
      );
    }
  }

  if (isPlainRecord(raw.buffer) && isPlainRecord(raw.buffer.prediction)) {
    const prediction = raw.buffer.prediction;
    if (prediction.enabled !== "off") {
      removeNestedPath(
        raw,
        ["buffer", "prediction"],
        layer,
        ignored,
        "project/local configuration cannot enable or route source-code prediction",
      );
    }
  }

  if (isPlainRecord(raw.shell_environment_policy)) {
    const shell = raw.shell_environment_policy;
    if (Object.prototype.hasOwnProperty.call(shell, "set")) {
      delete shell.set;
      recordIgnored(
        ignored,
        layer,
        "shell_environment_policy.set",
        "project/local configuration cannot set process environment variables",
      );
    }
  }

  const baseRank = sandboxRank(currentSandboxMode(base));
  const incomingRank = sandboxRank(raw.sandbox_mode);
  if (
    baseRank !== undefined &&
    incomingRank !== undefined &&
    incomingRank < baseRank
  ) {
    removeKey(
      raw,
      "sandbox_mode",
      layer,
      ignored,
      "project/local configuration cannot weaken the active sandbox mode",
    );
  }
  if (isPlainRecord(raw.sandbox) && raw.sandbox.allow_gpu === true) {
    removeNestedKey(
      raw,
      "sandbox",
      "allow_gpu",
      layer,
      ignored,
      "project/local configuration cannot enable additional kernel attack surface",
    );
  }

  for (const key of [
    "autoAllowBashIfSandboxed",
    "allowUnsandboxedCommands",
    "enableWeakerNestedSandbox",
    "enableWeakerNetworkIsolation",
  ] as const) {
    if (isPlainRecord(raw.sandbox) && raw.sandbox[key] === true) {
      removeNestedKey(
        raw,
        "sandbox",
        key,
        layer,
        ignored,
        "project/local configuration cannot enable a sandbox escape or approval bypass",
      );
    }
  }
  for (const key of [
    "network",
    "filesystem",
    "ignoreViolations",
    "excludedCommands",
    "ripgrep",
  ] as const) {
    removeNestedKey(
      raw,
      "sandbox",
      key,
      layer,
      ignored,
      "project/local configuration cannot add sandbox exceptions",
    );
  }

  if (isPlainRecord(raw.sandbox) && raw.sandbox.network_access === true) {
    removeNestedKey(
      raw,
      "sandbox",
      "network_access",
      layer,
      ignored,
      "project/local configuration cannot grant network access",
    );
  }
  return validateAgenCConfigBlocks(normalizeRawConfig(raw));
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function mergePermissionRules(
  base: AgenCConfig,
  incoming: AgenCConfig,
  merged: AgenCConfig,
): AgenCConfig {
  if (!incoming.permissions) return merged;
  const permissions = { ...(merged.permissions ?? {}) };
  for (const behavior of ["allow", "deny", "ask"] as const) {
    if (incoming.permissions[behavior] === undefined) continue;
    permissions[behavior] = Object.freeze([
      ...new Set([
        ...stringArray(base.permissions?.[behavior]),
        ...stringArray(incoming.permissions[behavior]),
      ]),
    ]);
  }
  return mergeConfigs(merged, { permissions });
}

function uniqueStructuralValues<T>(values: readonly T[]): readonly T[] {
  const seen = new Set<string>();
  return Object.freeze(values.filter((value) => {
    const key = stableJson(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }));
}

function mergeMonotonicPolicy(
  base: AgenCConfig,
  incoming: AgenCConfig,
  merged: AgenCConfig,
): AgenCConfig {
  let next = merged;
  if (incoming.deniedMcpServers !== undefined) {
    next = mergeConfigs(next, {
      deniedMcpServers: uniqueStructuralValues([
        ...(base.deniedMcpServers ?? []),
        ...incoming.deniedMcpServers,
      ]),
    });
  }
  if (base.disableAllHooks === true || incoming.disableAllHooks === true) {
    next = mergeConfigs(next, { disableAllHooks: true });
  }
  if (base.disableAutoMode === "disable" || incoming.disableAutoMode === "disable") {
    next = mergeConfigs(next, { disableAutoMode: "disable" });
  }
  return next;
}

function mergeRepositoryRestrictions(
  base: AgenCConfig,
  incoming: AgenCConfig,
  merged: AgenCConfig,
): AgenCConfig {
  let next = merged;

  const incomingDisabledTools = incoming.tools_config?.disabled_tools;
  if (incomingDisabledTools !== undefined) {
    next = mergeConfigs(next, {
      tools_config: {
        ...(next.tools_config ?? {}),
        disabled_tools: Object.freeze([
          ...new Set([
            ...(base.tools_config?.disabled_tools ?? []),
            ...incomingDisabledTools,
          ]),
        ]),
      },
    });
  }

  if (incoming.mcp_servers !== undefined) {
    const servers = { ...(next.mcp_servers ?? {}) };
    for (const [serverName, incomingServer] of Object.entries(incoming.mcp_servers)) {
      if (incomingServer.disabled_tools === undefined) continue;
      const baseServer = base.mcp_servers?.[serverName];
      servers[serverName] = {
        ...(servers[serverName] ?? {}),
        disabled_tools: Object.freeze([
          ...new Set([
            ...(baseServer?.disabled_tools ?? []),
            ...incomingServer.disabled_tools,
          ]),
        ]),
      };
    }
    next = mergeConfigs(next, { mcp_servers: servers });
  }
  return next;
}

/**
 * Merge already-sanitized repository layer snapshots with the exact same
 * precedence rules used by the effective configuration repository.
 *
 * This is the only supported way to build a scope-specific projection from
 * `ResolvedLayeredConfig.sources`: ordinary arrays are replaced by the
 * highest-priority layer, while permission rule arrays accumulate so a later
 * layer cannot erase an earlier restriction.
 */
export function mergeConfigLayerSnapshots(
  layers: readonly ConfigLayerSnapshot[],
  base?: AgenCConfig,
): AgenCConfig | null {
  if (layers.length === 0) return base ?? null;
  let config: AgenCConfig = base ?? {};
  for (const layer of layers) {
    const before = config;
    let merged = mergePermissionRules(
      before,
      layer.config,
      mergeConfigs(before, layer.config),
    );
    merged = mergeMonotonicPolicy(before, layer.config, merged);
    if (REPOSITORY_SCOPES.has(layer.scope)) {
      merged = mergeRepositoryRestrictions(before, layer.config, merged);
    }
    config = merged;
  }
  return config;
}

/**
 * Fold MCP declarations in the repository's already-resolved layer order.
 *
 * Admission happens before a declaration enters the accumulator. This is
 * essential for same-name fallthrough: an unapproved project declaration or
 * policy-blocked command must not contaminate a later local/flag/CLI
 * definition through the repository's ordinary deep-merge rules.
 *
 * An explicit managed `mcp_servers` table is exclusive even when empty. In
 * that case lower authorities are never offered to the admission callback.
 */
export function resolveMcpLayerCandidates(
  layers: readonly ConfigLayerSnapshot[],
  decide: (
    candidate: McpLayerCandidate,
  ) => McpLayerCandidateDecision | boolean = () => "accept",
): ResolvedMcpLayerCandidates {
  const managedExclusive = layers.some(
    (layer) =>
      layer.scope === "managed" &&
      Object.prototype.hasOwnProperty.call(layer.config, "mcp_servers"),
  );
  const activeLayers = managedExclusive
    ? layers.filter((layer) => layer.scope === "managed")
    : layers.filter((layer) => layer.scope !== "managed");
  let effective: AgenCConfig = {};
  const contributorsByName = new Map<string, readonly ConfigLayerSource[]>();
  const candidatesByName = new Map<string, McpLayerCandidate[]>();
  const unresolved = new Map<string, McpLayerCandidate>();
  const winners = new Map<string, McpLayerCandidate>();

  for (const layer of activeLayers) {
    const declarations = layer.config.mcp_servers;
    if (declarations === undefined) continue;
    for (const [name, declaration] of Object.entries(declarations)) {
      const prospective = mergeConfigLayerSnapshots(
        [
          Object.freeze({
            scope: layer.scope,
            label: layer.label,
            ...(layer.path !== undefined ? { path: layer.path } : {}),
            config: Object.freeze({
              mcp_servers: Object.freeze({ [name]: declaration }),
            }),
          }),
        ],
        effective,
      )?.mcp_servers?.[name];
      if (prospective === undefined) continue;
      const source = Object.freeze({
        scope: layer.scope,
        label: layer.label,
        ...(layer.path !== undefined ? { path: layer.path } : {}),
      });
      const contributors = Object.freeze([
        ...(contributorsByName.get(name) ?? []),
        source,
      ]);
      const candidate = Object.freeze({
        name,
        source,
        contributors,
        declaration,
        config: prospective,
      });
      const decision = decide(candidate);
      if (decision === false || decision === "reject") continue;

      effective = mergeConfigLayerSnapshots(
        [
          Object.freeze({
            scope: layer.scope,
            label: layer.label,
            ...(layer.path !== undefined ? { path: layer.path } : {}),
            config: Object.freeze({
              mcp_servers: Object.freeze({ [name]: declaration }),
            }),
          }),
        ],
        effective,
      ) ?? effective;
      contributorsByName.set(name, contributors);
      if (decision === "defer") {
        unresolved.set(name, candidate);
        continue;
      }
      unresolved.delete(name);
      const history = candidatesByName.get(name) ?? [];
      history.push(candidate);
      candidatesByName.set(name, history);
      winners.set(name, candidate);
    }
  }

  return Object.freeze({
    managedExclusive,
    candidatesByName: new Map(
      Array.from(candidatesByName, ([name, candidates]) => [
        name,
        Object.freeze([...candidates]),
      ]),
    ),
    unresolved: new Map(unresolved),
    winners: new Map(winners),
  });
}

function updateProvenance(
  provenance: Record<string, ConfigProvenanceEntry>,
  layer: ConfigLayerSnapshot,
): void {
  for (const key of leafPaths(layer.config)) {
    if (key === "configVersion") continue;
    const prior = provenance[key];
    const contributor = source(layer.scope, layer.label, layer.path);
    provenance[key] = Object.freeze({
      ...contributor,
      contributors: Object.freeze([
        ...(prior?.contributors ?? []),
        contributor,
      ]),
    });
  }
}

function mergeLayer(
  base: AgenCConfig,
  layer: ConfigLayerSnapshot,
  projectTrusted: boolean,
  provenance: Record<string, ConfigProvenanceEntry>,
  ignored: IgnoredConfigValue[],
  retainUntrustedProjectCommandHooks = false,
): {
  readonly config: AgenCConfig;
  readonly source: ConfigLayerSnapshot;
} {
  const safe = sanitizeRepositoryLayer(
    base,
    layer,
    projectTrusted,
    ignored,
    retainUntrustedProjectCommandHooks,
  );
  const safeLayer = Object.freeze({
    ...layer,
    config: resolveProviderModelLayer(base, safe),
  });
  const merged = mergeConfigLayerSnapshots([safeLayer], base);
  if (merged === null) {
    throw new Error("repository layer merge unexpectedly produced no config");
  }
  updateProvenance(provenance, safeLayer);
  return Object.freeze({ config: merged, source: safeLayer });
}

function syntheticLayer(
  scope: ConfigScope,
  label: string,
  config: AgenCConfig,
): ConfigLayerSnapshot {
  const normalized = mergeConfigs(config, {
    configVersion: CANONICAL_CONFIG_VERSION,
  });
  return Object.freeze({ ...source(scope, label), config: normalized });
}

async function assertNoRetiredConfigInputs(options: {
  readonly home: HomeContext;
  readonly cwd: string;
  readonly projectRoot: string;
  readonly managedConfigPath: string;
  readonly includeProjectInputs?: boolean;
}): Promise<void> {
  let retired;
  try {
    retired = await detectRetiredConfigInputs({
      homePath: options.home.path,
      cwd: options.cwd,
      projectRoot: options.projectRoot,
      managedConfigPath: options.managedConfigPath,
      includeProjectInputs: options.includeProjectInputs,
    });
  } catch (error) {
    throw new ConfigRepositoryError(
      "invalid-source",
      `Could not inspect retired configuration inputs: ${
        (error as NodeJS.ErrnoException).code ??
        (error instanceof Error ? error.message : String(error))
      }. Ordinary loading will not guess; run \`agenc config migrate check\` and then \`agenc config migrate apply\`.`,
    );
  }
  if (retired.length === 0) return;
  const paths = retired.map((input) => input.path);
  throw new ConfigRepositoryError(
    "retired-input",
    `Retired configuration input${paths.length === 1 ? "" : "s"} detected: ${
      paths.join(", ")
    }. Ordinary loading never parses or modifies retired inputs. Run \`agenc config migrate check\` to review the conversion, then \`agenc config migrate apply\`.`,
    paths[0],
  );
}

/**
 * Mutation preflight that inspects retired inputs without opening the current
 * user config. This lets `config unset` repair a malformed canonical file
 * while still refusing to create a second live authority beside retired JSON.
 */
export async function assertNoRetiredConfigInputsForMutation(
  options: LayeredConfigRepositoryOptions = {},
): Promise<void> {
  const env = options.env ?? process.env;
  const home = options.home ?? resolveHomeContext(env, {
    ...(env.HOME ? { platformHome: env.HOME } : {}),
  });
  const cwd = resolve(options.cwd ?? process.cwd());
  const projectRoot = resolve(
    options.projectRoot ??
      findProjectRootSync(cwd, defaultConfig().project_root_markers)?.rootDir ??
      cwd,
  );
  await assertNoRetiredConfigInputs({
    home,
    cwd,
    projectRoot,
    managedConfigPath:
      options.managedConfigPath ?? resolveManagedConfigPath(env),
  });
}

function diffLayer(
  before: AgenCConfig,
  after: AgenCConfig,
  scope: ConfigScope,
  label: string,
  preserveKeys: readonly (keyof AgenCConfig)[] = [],
): ConfigLayerSnapshot | null {
  const patch: JsonRecord = {};
  const beforeRecord = before as Readonly<Record<string, unknown>>;
  for (const [key, value] of Object.entries(after)) {
    if (
      preserveKeys.includes(key as keyof AgenCConfig) ||
      JSON.stringify(beforeRecord[key]) !== JSON.stringify(value)
    ) {
      patch[key] = value;
    }
  }
  if (Object.keys(patch).length === 0) return null;
  return syntheticLayer(scope, label, normalizeRawConfig(patch));
}

async function loadLayeredConfigInternal(
  options: LayeredConfigRepositoryOptions,
  includeWorkspaceLayers: boolean,
): Promise<ResolvedLayeredConfig> {
  const env = options.env ?? process.env;
  const home = options.home ?? resolveHomeContext(env, {
    ...(env.HOME ? { platformHome: env.HOME } : {}),
  });
  const cwd = includeWorkspaceLayers
    ? resolve(options.cwd ?? process.cwd())
    : home.path;
  const managedPath =
    options.managedConfigPath ?? resolveManagedConfigPath(env);
  const managedDir = options.managedDropInDir ?? join(dirname(managedPath), "config.d");
  const managedLayers = await readManagedLayers(managedPath, managedDir);
  const sources: ConfigLayerSnapshot[] = [];
  const physicalSources: ConfigLayerSnapshot[] = [];
  const ignored: IgnoredConfigValue[] = [];
  const provenance: Record<string, ConfigProvenanceEntry> = {};

  const registerPhysicalSource = (
    layer: ConfigLayerSnapshot | null,
  ): void => {
    if (layer?.path === undefined) return;
    const identity = STABLE_LAYER_IDENTITIES.get(layer);
    if (identity === undefined) return;
    for (const existing of physicalSources) {
      const earlier = STABLE_LAYER_IDENTITIES.get(existing);
      if (earlier === undefined) continue;
      const reason = earlier.path === identity.path
        ? "path"
        : earlier.resolvedPath === identity.resolvedPath
          ? "realpath"
          : earlier.identity === identity.identity
            ? "inode"
            : undefined;
      if (reason === undefined) continue;
      throw new ConfigRepositoryError(
        "invalid-source",
        `configuration authorities ${existing.scope} (${existing.label}) and ${layer.scope} (${layer.label}) resolve to the same physical file (${reason}); use distinct files for distinct scopes`,
        layer.path,
      );
    }
    physicalSources.push(layer);
  };

  for (const managed of managedLayers) registerPhysicalSource(managed);

  let config = mergeConfigs(defaultConfig(), {
    configVersion: CANONICAL_CONFIG_VERSION,
  });
  const defaults = syntheticLayer("default", "built-in defaults", config);
  sources.push(defaults);
  updateProvenance(provenance, defaults);

  if (options.pluginDefaults) {
    const plugin = syntheticLayer("plugin", "plugin defaults", options.pluginDefaults);
    const merged = mergeLayer(config, plugin, options.projectTrusted === true, provenance, ignored);
    config = merged.config;
    sources.push(merged.source);
  }

  const user = await readStrictConfigLayer(home.configTomlPath, "user", "user config");
  registerPhysicalSource(user);
  if (user) {
    const merged = mergeLayer(config, user, options.projectTrusted === true, provenance, ignored);
    config = merged.config;
    sources.push(merged.source);
  }

  // An explicit --config file is an operator authority and may select custom
  // root markers. Read and validate it before repository discovery, while
  // preserving its documented merge position after project/local layers.
  // This prevents one root from supplying configuration while a later marker
  // value authorizes a different root.
  let flag: ConfigLayerSnapshot | null = null;
  if (includeWorkspaceLayers && options.flagConfigPath) {
    flag = await readStrictConfigLayer(
      options.flagConfigPath,
      "flag",
      "explicit config file",
    );
    if (!flag) {
      throw new ConfigRepositoryError(
        "invalid-source",
        `explicit config file does not exist: ${options.flagConfigPath}`,
        options.flagConfigPath,
      );
    }
    registerPhysicalSource(flag);
  }

  const rootMarkers = includeWorkspaceLayers
    ? managedLayers
        .map((layer) => layer.config.project_root_markers)
        .findLast((markers) => markers !== undefined) ??
      flag?.config.project_root_markers ??
      config.project_root_markers
    : undefined;
  const projectRoot = includeWorkspaceLayers
    ? resolve(
        options.projectRoot ??
          findProjectRootSync(cwd, rootMarkers)?.rootDir ??
          cwd,
      )
    : home.path;
  await assertNoRetiredConfigInputs({
    home,
    cwd,
    projectRoot,
    managedConfigPath: managedPath,
    includeProjectInputs: includeWorkspaceLayers,
  });
  const project = includeWorkspaceLayers
    ? await readStrictConfigLayer(
        join(projectRoot, ".agenc", "config.toml"),
        "project",
        "project config",
      )
    : null;
  registerPhysicalSource(project);
  if (project) {
    const merged = mergeLayer(
      config,
      project,
      options.projectTrusted === true,
      provenance,
      ignored,
      options.retainUntrustedProjectCommandHooks === true,
    );
    config = merged.config;
    sources.push(merged.source);
  }
  const local = includeWorkspaceLayers
    ? await readStrictConfigLayer(
        join(projectRoot, ".agenc", "config.local.toml"),
        "local",
        "local config",
      )
    : null;
  registerPhysicalSource(local);
  if (local) {
    const merged = mergeLayer(
      config,
      local,
      options.projectTrusted === true,
      provenance,
      ignored,
      options.retainUntrustedProjectCommandHooks === true,
    );
    config = merged.config;
    sources.push(merged.source);
  }
  if (flag) {
    const merged = mergeLayer(config, flag, true, provenance, ignored);
    config = merged.config;
    sources.push(merged.source);
  }

  const profileName = options.profileName ?? resolveProfileName(env);
  if (profileName) {
    const profiled = resolveProfile(config, profileName);
    const selectedProfile = config.profiles?.[profileName];
    const hasProfileSelection =
      selectedProfile !== undefined &&
      (Object.prototype.hasOwnProperty.call(selectedProfile, "model_provider") ||
        Object.prototype.hasOwnProperty.call(selectedProfile, "model"));
    const profile = diffLayer(
      config,
      profiled,
      "profile",
      `profile ${profileName}`,
      hasProfileSelection ? ["model_provider", "model"] : [],
    );
    if (profile) {
      const merged = mergeLayer(config, profile, true, provenance, ignored);
      config = merged.config;
      sources.push(merged.source);
    }
  }

  const withEnv = applyEnvOverrides(config, env, options.onWarn);
  const hasEnvironmentSelection =
    (env.AGENC_PROVIDER?.trim().length ?? 0) > 0 ||
    (env.AGENC_MODEL?.trim().length ?? 0) > 0;
  const environment = diffLayer(
    config,
    withEnv,
    "environment",
    "environment overrides",
    hasEnvironmentSelection ? ["model_provider", "model"] : [],
  );
  if (environment) {
    const merged = mergeLayer(config, environment, true, provenance, ignored);
    config = merged.config;
    sources.push(merged.source);
  }
  if (options.cliOverrides) {
    if (
      Object.prototype.hasOwnProperty.call(
        options.cliOverrides,
        "project_root_markers",
      )
    ) {
      throw new ConfigRepositoryError(
        "invalid-source",
        "command-line overrides cannot set project_root_markers after root discovery; set root markers in user config.toml, an explicit --config file, or managed config.toml",
      );
    }
    const cli = syntheticLayer(
      "cli",
      "command-line overrides",
      options.cliOverrides,
    );
    const merged = mergeLayer(config, cli, true, provenance, ignored);
    config = merged.config;
    sources.push(merged.source);
  }
  for (const managed of managedLayers) {
    const merged = mergeLayer(config, managed, true, provenance, ignored);
    config = merged.config;
    sources.push(merged.source);
  }

  config = mergeConfigs(config, {
    configVersion: CANONICAL_CONFIG_VERSION,
  });

  return Object.freeze({
    config,
    home,
    projectRoot,
    sources: Object.freeze(sources),
    provenance: Object.freeze(provenance),
    ignored: Object.freeze(ignored),
  });
}

export async function loadLayeredConfig(
  options: LayeredConfigRepositoryOptions = {},
): Promise<ResolvedLayeredConfig> {
  return loadLayeredConfigInternal(options, true);
}

function resolveCanonicalLoadHome(
  env: EnvSnapshot,
  home: HomeContext | string | undefined,
): HomeContext {
  return typeof home === "string"
    ? resolveHomeContext({ ...env, AGENC_HOME: home }, {
        ...(env.HOME ? { platformHome: env.HOME } : {}),
      })
    : home ?? resolveHomeContext(env, {
        ...(env.HOME ? { platformHome: env.HOME } : {}),
      });
}

function attachCanonicalUserPath(
  loaded: ResolvedLayeredConfig,
  home: HomeContext,
): LoadedCanonicalConfig {
  return Object.freeze({
    ...loaded,
    path: home.configTomlPath,
    exists: loaded.sources.some((item) => item.scope === "user"),
  });
}

/** Public strict-v2 runtime loader. Legacy inputs are migration-CLI-only. */
export async function loadCanonicalConfig(
  options: LoadCanonicalConfigOptions = {},
): Promise<LoadedCanonicalConfig> {
  const env = options.env ?? process.env;
  const home = resolveCanonicalLoadHome(env, options.home);
  const loaded = await loadLayeredConfig({
    ...options,
    home,
    ...(options.base !== undefined ? { pluginDefaults: options.base } : {}),
  });
  return attachCanonicalUserPath(loaded, home);
}

/**
 * Load daemon-global configuration without consulting a launcher's project,
 * local, explicit-file, trust, or CLI authorities.
 */
export async function loadCanonicalDaemonConfig(
  options: LoadCanonicalDaemonConfigOptions = {},
): Promise<LoadedCanonicalConfig> {
  const env = options.env ?? process.env;
  const home = resolveCanonicalLoadHome(env, options.home);
  const loaded = await loadLayeredConfigInternal(
    {
      env,
      home,
      managedConfigPath: options.managedConfigPath,
      managedDropInDir: options.managedDropInDir,
      profileName: options.profileName,
      onWarn: options.onWarn,
      ...(options.base !== undefined ? { pluginDefaults: options.base } : {}),
    },
    false,
  );
  return attachCanonicalUserPath(loaded, home);
}

export class LayeredConfigRepository {
  #snapshot: ResolvedLayeredConfig | null = null;
  readonly #options: LayeredConfigRepositoryOptions;

  constructor(options: LayeredConfigRepositoryOptions = {}) {
    this.#options = options;
  }

  current(): ResolvedLayeredConfig {
    if (!this.#snapshot) {
      throw new ConfigRepositoryError(
        "invalid-source",
        "LayeredConfigRepository.reload() must complete before current()",
      );
    }
    return this.#snapshot;
  }

  async reload(): Promise<ResolvedLayeredConfig> {
    const next = await loadLayeredConfig(this.#options);
    this.#snapshot = next;
    return next;
  }

  provenance(key: string): ConfigProvenanceEntry | undefined {
    return this.current().provenance[key];
  }

  source(scope: ConfigScope): readonly ConfigLayerSnapshot[] {
    return Object.freeze(this.current().sources.filter((item) => item.scope === scope));
  }
}
