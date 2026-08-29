import type { AgenCConfig } from "./schema.js";

type ConfigKey = keyof AgenCConfig & string;

/**
 * Values whose only runtime authority is canonical managed TOML.
 *
 * Keeping this list typed and centralized prevents settings bridges, plugins,
 * profiles, environment adapters, or CLI patches from accidentally creating a
 * second policy plane.
 */
export const MANAGED_ONLY_CONFIG_KEYS = Object.freeze([
  "availableModels",
  "allowManagedHooksOnly",
  "allowManagedPermissionRulesOnly",
  "allowManagedMcpServersOnly",
  "strictPluginOnlyCustomization",
  "strictKnownMarketplaces",
  "blockedMarketplaces",
  "forceLoginOrgUUID",
  "skipWebFetchPreflight",
  "agencMdExcludes",
  "pluginTrustMessage",
] as const satisfies readonly ConfigKey[]);

/**
 * Operator-owned values. User, explicit flag/profile/environment/CLI, and
 * managed layers may set them; repository-controlled project/local files and
 * plugin defaults may not.
 */
export const OPERATOR_ONLY_CONFIG_KEYS = Object.freeze([
  "gateway",
  "modelOverrides",
  "allowedMcpServers",
  "allowedHttpHookUrls",
  "httpHookAllowedEnvVars",
  "minimumVersion",
] as const satisfies readonly ConfigKey[]);

/** Nested values that carry operator authority without owning their parent table. */
export const OPERATOR_ONLY_CONFIG_PATHS = Object.freeze([
  Object.freeze(["tui", "keybindings"] as const),
] as const);

/**
 * Restrictions a repository may add but never erase. Their structural merge
 * rules live beside the canonical repository merge implementation.
 */
export const REPOSITORY_MONOTONIC_CONFIG_KEYS = Object.freeze([
  "deniedMcpServers",
  "disableAllHooks",
  "disableAutoMode",
] as const satisfies readonly ConfigKey[]);

export type ManagedOnlyConfigKey = (typeof MANAGED_ONLY_CONFIG_KEYS)[number];
export type OperatorOnlyConfigKey = (typeof OPERATOR_ONLY_CONFIG_KEYS)[number];
export type RepositoryMonotonicConfigKey =
  (typeof REPOSITORY_MONOTONIC_CONFIG_KEYS)[number];

export type ConfigAuthorityClass =
  | "managed-only"
  | "operator-only"
  | "repository-monotonic";

const MANAGED_ONLY_CONFIG_KEY_SET: ReadonlySet<string> = new Set(
  MANAGED_ONLY_CONFIG_KEYS,
);
const OPERATOR_ONLY_CONFIG_KEY_SET: ReadonlySet<string> = new Set(
  OPERATOR_ONLY_CONFIG_KEYS,
);
const REPOSITORY_MONOTONIC_CONFIG_KEY_SET: ReadonlySet<string> = new Set(
  REPOSITORY_MONOTONIC_CONFIG_KEYS,
);

export function configAuthorityClass(
  key: string,
): ConfigAuthorityClass | undefined {
  if (MANAGED_ONLY_CONFIG_KEY_SET.has(key)) return "managed-only";
  if (OPERATOR_ONLY_CONFIG_KEY_SET.has(key)) return "operator-only";
  if (REPOSITORY_MONOTONIC_CONFIG_KEY_SET.has(key)) {
    return "repository-monotonic";
  }
  return undefined;
}

export function isManagedOnlyConfigKey(
  key: string,
): key is ManagedOnlyConfigKey {
  return MANAGED_ONLY_CONFIG_KEY_SET.has(key);
}

export function isOperatorOnlyConfigKey(
  key: string,
): key is OperatorOnlyConfigKey {
  return OPERATOR_ONLY_CONFIG_KEY_SET.has(key);
}

export function isRepositoryMonotonicConfigKey(
  key: string,
): key is RepositoryMonotonicConfigKey {
  return REPOSITORY_MONOTONIC_CONFIG_KEY_SET.has(key);
}

export type WritableConfigScope = "user" | "project" | "local";

function presentKeys(
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): string[] {
  return keys.filter((key) =>
    Object.prototype.hasOwnProperty.call(value, key) && value[key] !== undefined
  );
}

function presentPath(
  value: Readonly<Record<string, unknown>>,
  path: readonly string[],
): boolean {
  let cursor: unknown = value;
  for (const segment of path) {
    if (
      cursor === null ||
      typeof cursor !== "object" ||
      Array.isArray(cursor) ||
      !Object.prototype.hasOwnProperty.call(cursor, segment)
    ) return false;
    cursor = (cursor as Readonly<Record<string, unknown>>)[segment];
  }
  return cursor !== undefined;
}

export function assertUserConfigDocumentAuthority(
  raw: Readonly<Record<string, unknown>>,
  label = "user config.toml",
): void {
  const invalid = presentKeys(raw, MANAGED_ONLY_CONFIG_KEYS);
  if (invalid.length === 0) return;
  throw new Error(
    `${label} contains managed-only key${invalid.length === 1 ? "" : "s"} ${invalid.sort().join(", ")}; move ${invalid.length === 1 ? "it" : "them"} to canonical managed config.toml`,
  );
}

/** Validate a write patch before it can modify one persistent TOML layer. */
export function assertConfigPatchAuthority(
  scope: WritableConfigScope,
  patch: Readonly<Record<string, unknown>>,
): void {
  const managed = presentKeys(patch, MANAGED_ONLY_CONFIG_KEYS);
  if (managed.length > 0) {
    throw new Error(
      `${scope} config.toml cannot set managed-only key${managed.length === 1 ? "" : "s"} ${managed.sort().join(", ")}; deletions are allowed for repair`,
    );
  }
  if (scope === "user") return;
  const operator = [
    ...presentKeys(patch, OPERATOR_ONLY_CONFIG_KEYS),
    ...OPERATOR_ONLY_CONFIG_PATHS
      .filter((path) => presentPath(patch, path))
      .map((path) => path.join(".")),
  ];
  if (operator.length > 0) {
    throw new Error(
      `${scope} config.toml cannot set operator-only key${operator.length === 1 ? "" : "s"} ${operator.sort().join(", ")}; use user or managed config.toml`,
    );
  }
}
