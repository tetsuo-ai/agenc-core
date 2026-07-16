/**
 * SEC-01: prevent LIVE shell children from inheriting provider API keys and
 * other secrets from the host/daemon process environment.
 *
 * Strategy: start from full env (tools need PATH/locale/terminal vars) and
 * drop keys that look like credentials. Explicit per-call env maps are scrubbed
 * the same way so a leaked key cannot be reintroduced via options.env.
 */

export { isSecretEnvKey } from "../utils/secretEnv.js";
import { isSecretEnvKey } from "../utils/secretEnv.js";

/**
 * Copy env entries, dropping secret keys. Undefined values are skipped.
 */
export function scrubEnvForChildProcess(
  source: NodeJS.ProcessEnv | Record<string, string | undefined> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (source === undefined) return out;
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (isSecretEnvKey(key)) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Build spawn env for unified-exec: scrubbed process.env + scrubbed overrides.
 */
export function buildScrubbedSpawnEnv(
  overrides?: Record<string, string> | undefined,
): Record<string, string> {
  return {
    ...scrubEnvForChildProcess(process.env),
    ...scrubEnvForChildProcess(overrides),
  };
}
