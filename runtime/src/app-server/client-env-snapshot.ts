import { assertCanonicalEnvironmentIngress } from "../config/environment-ingress.js";
import { providerEnvironmentKeys } from "../llm/registry/provider-ingress.js";
import { resolveBuiltInProviderInfo } from "../llm/registry/provider-info.js";
import {
  CANONICAL_SESSION_ENV_KEYS,
  canonicalSessionEnvironmentKeys,
  isDynamicSessionCredentialEnvironmentKey,
} from "../session/environment.js";
import { sanitizeProviderConfigValue } from "../utils/providerSecrets.js";
import { isSecretEnvKey } from "../utils/secretEnv.js";

/**
 * Session-sensitive client environment forwarded to daemon-owned runtimes.
 *
 * Every key is present in a snapshot. An empty value is a clear marker, not a
 * request to inherit the daemon's startup environment. AGENC_WORKSPACE and
 * AGENC_HOME are intentionally excluded: workspace comes from the trusted cwd
 * parameter and home identifies the daemon instance itself.
 */
export const DAEMON_CLIENT_ENV_SNAPSHOT_KEYS = CANONICAL_SESSION_ENV_KEYS;

/** Capture one complete client snapshot without process-global fallback. */
export function collectDaemonClientEnvOverrides(
  env: NodeJS.ProcessEnv,
): Record<string, string> {
  assertCanonicalEnvironmentIngress(env);
  return Object.fromEntries(
    canonicalSessionEnvironmentKeys(env).map((key) => {
      const value = env[key];
      return [
        key,
        typeof value === "string" && value.trim().length > 0 ? value : "",
      ];
    }),
  );
}

/**
 * Validate an untrusted protocol snapshot and materialize every allowlisted
 * key. Missing keys become explicit clears so a daemon client can never
 * inherit session-sensitive values from the daemon process.
 */
export function normalizeDaemonClientEnvOverrides(
  overrides: Readonly<Record<string, string>> | undefined,
  inheritedEnvironment: Readonly<Record<string, string | undefined>> = {},
): Record<string, string> {
  const provided = overrides ?? {}
  assertCanonicalEnvironmentIngress(provided)
  const allowed = new Set<string>(DAEMON_CLIENT_ENV_SNAPSHOT_KEYS)
  const unknown = Object.keys(provided).filter(
    key => !allowed.has(key) && !isDynamicSessionCredentialEnvironmentKey(key),
  )
  if (unknown.length > 0) {
    throw new Error(
      `contains unsupported key${unknown.length === 1 ? "" : "s"}: ${unknown.sort().join(", ")}`,
    )
  }
  const keys = canonicalSessionEnvironmentKeys(provided, inheritedEnvironment)
  return Object.fromEntries(
    keys.map((key) => {
      const value = provided[key]
      return [
        key,
        value !== undefined && value.trim().length > 0 ? value : "",
      ]
    }),
  )
}

/**
 * Materialize a client snapshot for runtime use.
 *
 * Empty strings are protocol-only clear markers. Runtime consumers receive
 * actual key absence, so every config/provider consumer observes the same
 * semantics without independently interpreting the wire representation.
 */
export function mergeDaemonClientEnvironment(
  inheritedEnvironment: Readonly<Record<string, string | undefined>> | undefined,
  overrides: Readonly<Record<string, string>> | undefined,
): NodeJS.ProcessEnv | undefined {
  if (inheritedEnvironment === undefined && overrides === undefined) {
    return undefined
  }
  const normalized = normalizeDaemonClientEnvOverrides(
    overrides,
    inheritedEnvironment ?? {},
  )
  const merged: NodeJS.ProcessEnv = { ...(inheritedEnvironment ?? {}) }
  for (const [key, value] of Object.entries(normalized)) {
    // PATH is command lookup infrastructure, not session credential state.
    // A client with no tool path keeps the daemon's expanded startup path.
    if (key === "PATH" && value.length === 0) continue
    if (value.length === 0) {
      delete merged[key]
    } else {
      merged[key] = value
    }
  }
  return merged
}

export function captureRecoverableCommandEnvironment(
  overrides: Readonly<Record<string, string>> | undefined,
): { readonly PATH: string } {
  return { PATH: overrides?.PATH?.trim() ? overrides.PATH : "" }
}

export function readRecoverableCommandEnvironment(
  value: unknown,
): { readonly PATH: string } | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    !("PATH" in value) ||
    typeof value.PATH !== "string" ||
    value.PATH.includes("\0")
  ) return undefined
  return { PATH: value.PATH }
}

/**
 * Snapshot keys whose names match the credential inventory but whose values
 * are configuration: auth modes, header names, schemes, endpoints, and
 * numeric switches. A restore needs them to resolve the same provider
 * endpoint and auth mode.
 */
const CONFIGURATION_KEYS_WITH_CREDENTIAL_NAMES: ReadonlySet<string> = new Set([
  "AGENC_AUTH_BACKEND",
  "AGENC_AUTH_MANAGED_KEYS_ENABLED",
  "AGENC_ENABLE_TOKEN_USAGE_ATTACHMENT",
  "AGENC_TOKEN_BUDGET_CHECK_INTERVAL",
  "DASHSCOPE_TOKEN_PLAN_BASE_URL",
  "GEMINI_AUTH_MODE",
  "GROK_AUTH_MODE",
  "OPENAI_AUTH_HEADER",
  "OPENAI_AUTH_MODE",
  "OPENAI_AUTH_SCHEME",
  "QWEN_TOKEN_PLAN_BASE_URL",
  "WEB_AUTH_HEADER",
  "WEB_AUTH_SCHEME",
]);

/** Free-form snapshot keys that can hold a credential in a header, query, or body. */
const CREDENTIAL_CARRYING_KEYS: ReadonlySet<string> = new Set([
  "WEB_BODY_TEMPLATE",
  "WEB_HEADERS",
  "WEB_PARAMS",
  "WEB_URL_TEMPLATE",
]);

/**
 * Credentials any model request may use, whatever the selected provider:
 * custom auth headers, AgenC sign-in tokens, Google access tokens, and the
 * mTLS client key.
 */
const MODEL_REQUEST_CREDENTIAL_KEYS: ReadonlySet<string> = new Set([
  "AGENC_API_KEY",
  "AGENC_API_KEY_FILE_DESCRIPTOR",
  "AGENC_CLIENT_KEY",
  "AGENC_CLIENT_KEY_PASSPHRASE",
  "AGENC_OAUTH_TOKEN",
  "AGENC_OAUTH_TOKEN_FILE_DESCRIPTOR",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_CUSTOM_HEADERS",
  "GEMINI_ACCESS_TOKEN",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "OPENAI_AUTH_HEADER_VALUE",
  "PROVIDER_CODE_API_KEY",
]);

const URL_USERINFO = /:\/\/[^/?#\s]*@/u;
const CREDENTIAL_QUERY_NAME =
  /(?:^|[_-])(?:api[_-]?key|access[_-]?key|key|token|secret|password|passwd|signature|sig|auth|credential|bearer)(?:[_-]|$)/iu;

/** True when a snapshot key's value may be a credential. Its value is never written to disk. */
export function isCredentialSessionEnvironmentKey(key: string): boolean {
  if (isDynamicSessionCredentialEnvironmentKey(key)) return true;
  if (CREDENTIAL_CARRYING_KEYS.has(key)) return true;
  return isSecretEnvKey(key) && !CONFIGURATION_KEYS_WITH_CREDENTIAL_NAMES.has(key);
}

/**
 * True when a configuration value still embeds a credential: it looks like
 * a provider key, equals a credential in the same snapshot, or names a URL
 * with user info or a credential-like query parameter.
 */
function valueCarriesCredential(
  value: string,
  snapshot: Readonly<Record<string, string | undefined>>,
): boolean {
  if (sanitizeProviderConfigValue(value, snapshot) === undefined) return true;
  for (const candidate of value.split(/[\s,;]+/u)) {
    if (!candidate.includes("://")) continue;
    if (URL_USERINFO.test(candidate)) return true;
    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      continue;
    }
    for (const name of url.searchParams.keys()) {
      if (CREDENTIAL_QUERY_NAME.test(name)) return true;
    }
  }
  return false;
}

/**
 * The non-secret part of a client snapshot, recorded with the run so a daemon
 * restart can rebuild the session with the same provider endpoint and
 * settings. PATH is recorded separately as the command environment.
 * Credential values are never recorded. Only their names are, so a restore
 * can tell that the client supplied a credential the daemon no longer holds.
 */
export interface RecoverableSessionEnvironment {
  readonly values: Readonly<Record<string, string>>;
  readonly withheldKeys: readonly string[];
}

export function captureRecoverableSessionEnvironment(
  overrides: Readonly<Record<string, string>> | undefined,
): RecoverableSessionEnvironment {
  const allowed = new Set<string>(DAEMON_CLIENT_ENV_SNAPSHOT_KEYS);
  const values: Record<string, string> = {};
  const withheldKeys: string[] = [];
  for (const key of Object.keys(overrides ?? {}).sort()) {
    const value = overrides?.[key];
    if (key === "PATH" || value === undefined || value.trim().length === 0) continue;
    if (isDynamicSessionCredentialEnvironmentKey(key)) {
      withheldKeys.push(key);
      continue;
    }
    if (!allowed.has(key)) continue;
    if (isCredentialSessionEnvironmentKey(key) || valueCarriesCredential(value, overrides ?? {})) {
      withheldKeys.push(key);
    } else {
      values[key] = value;
    }
  }
  return { values, withheldKeys };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read a recorded session environment. Anything a capture could not have
 * written (an unknown key, a credential value, a malformed field) makes the
 * record unusable, and the run is then not restored without its client.
 */
export function readRecoverableSessionEnvironment(
  value: unknown,
): RecoverableSessionEnvironment | undefined {
  if (
    !isPlainObject(value) ||
    Object.keys(value).sort().join(",") !== "values,withheldKeys" ||
    !isPlainObject(value.values) ||
    !Array.isArray(value.withheldKeys)
  ) return undefined;
  const allowed = new Set<string>(DAEMON_CLIENT_ENV_SNAPSHOT_KEYS);
  const values: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value.values)) {
    if (
      key === "PATH" ||
      !allowed.has(key) ||
      typeof entry !== "string" ||
      entry.trim().length === 0 ||
      entry.includes("\0") ||
      isCredentialSessionEnvironmentKey(key)
    ) return undefined;
    values[key] = entry;
  }
  if (Object.values(values).some((entry) => valueCarriesCredential(entry, values))) {
    return undefined;
  }
  const withheldKeys: string[] = [];
  for (const key of value.withheldKeys) {
    if (
      typeof key !== "string" ||
      key === "PATH" ||
      !(allowed.has(key) || isDynamicSessionCredentialEnvironmentKey(key)) ||
      Object.hasOwn(values, key) ||
      withheldKeys.includes(key)
    ) return undefined;
    withheldKeys.push(key);
  }
  return { values, withheldKeys };
}

/**
 * Withheld names a restored runtime would need to reach or authenticate to
 * its model provider as the client's session did: the provider's own
 * variables, credentials any model request may use, and settings withheld
 * because their value embedded a credential (a proxy or endpoint URL with
 * user info). For a provider the registry does not know, every withheld name
 * counts.
 */
export function withheldModelProviderCredentials(
  environment: RecoverableSessionEnvironment,
  provider: string | undefined,
): readonly string[] {
  if (resolveBuiltInProviderInfo(provider) === undefined) {
    return environment.withheldKeys;
  }
  const providerKeys = new Set(providerEnvironmentKeys(provider));
  return environment.withheldKeys.filter(
    (key) =>
      providerKeys.has(key) ||
      MODEL_REQUEST_CREDENTIAL_KEYS.has(key) ||
      !isCredentialSessionEnvironmentKey(key),
  );
}
