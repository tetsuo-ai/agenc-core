import { assertCanonicalEnvironmentIngress } from "../config/environment-ingress.js";
import {
  CANONICAL_SESSION_ENV_KEYS,
  canonicalSessionEnvironmentKeys,
  isDynamicSessionCredentialEnvironmentKey,
} from "../session/environment.js";

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
    if (value.length === 0) {
      delete merged[key]
    } else {
      merged[key] = value
    }
  }
  return merged
}
