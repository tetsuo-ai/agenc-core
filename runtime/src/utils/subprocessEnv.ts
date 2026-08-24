import { isEnvTruthy } from './envUtils.js'
import { isSecretEnvKey } from './secretEnv.js'
import { assertNoObsoleteConfigEnvironment } from '../config/env.js'

/**
 * Env vars stripped from EVERY subprocess environment by default.
 *
 * Child processes (Bash tool, shell snapshot, MCP stdio servers, LSP servers,
 * shell hooks) are spawned with these removed so that a prompt-injected or
 * model-run command (e.g. `printenv`, or shell expansion like
 * `${ANTHROPIC_API_KEY}`) cannot exfiltrate provider keys or CI credentials.
 *
 * Provider/API calls happen IN-PROCESS — the parent agenc process re-reads
 * these per-request (lazy credential reads), so children never need them.
 *
 * Derived as the union of the curated base list above and SECRET_ENV_KEYS (the
 * single source of provider-secret env names assigned to process.env by
 * provider profiles), so a newly-added provider key is scrubbed automatically.
 *
 * This is the DEFAULT behavior (no flag required). Set
 * AGENC_SUBPROCESS_ENV_NO_SCRUB to a truthy value to opt out (e.g. for a trusted
 * local wrapper script that genuinely needs an inherited token).
 */
export { SUBPROCESS_SECRET_ENV } from './secretEnv.js'

/**
 * Returns a copy of `baseEnv` (defaults to process.env) with sensitive secrets
 * stripped, for use when spawning subprocesses (Bash tool, shell snapshot, MCP
 * stdio servers, LSP servers, shell hooks).
 *
 * Scrubbing is the DEFAULT. Set AGENC_SUBPROCESS_ENV_NO_SCRUB to opt out.
 */
export function subprocessEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  if (baseEnv.AGENC_SUBPROCESS_ENV_SCRUB !== undefined) {
    assertNoObsoleteConfigEnvironment(baseEnv)
  }
  const env = { ...baseEnv }

  // Deliberate opt-out for trusted setups that genuinely need an inherited
  // token.
  if (isEnvTruthy(env.AGENC_SUBPROCESS_ENV_NO_SCRUB)) {
    return env
  }

  for (const key of Object.keys(env)) {
    if (isSecretEnvKey(key)) delete env[key]
  }
  return env
}
