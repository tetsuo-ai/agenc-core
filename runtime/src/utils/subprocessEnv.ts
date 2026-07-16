import { isEnvTruthy } from './envUtils.js'
import { isSecretEnvKey } from './secretEnv.js'

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

// Registered by init.ts after the upstreamproxy module is dynamically imported
// in CCR sessions. Stays undefined in non-CCR startups so we never pull in the
// upstreamproxy module graph (upstreamproxy.ts + relay.ts) via a static import.
let _getUpstreamProxyEnv: (() => Record<string, string>) | undefined

/**
 * Called from init.ts to wire up the proxy env function after the upstreamproxy
 * module has been lazily loaded. Must be called before any subprocess is spawned.
 */
export function registerUpstreamProxyEnvFn(
  fn: () => Record<string, string>,
): void {
  _getUpstreamProxyEnv = fn
}

/**
 * Returns a copy of `baseEnv` (defaults to process.env) with sensitive secrets
 * stripped, for use when spawning subprocesses (Bash tool, shell snapshot, MCP
 * stdio servers, LSP servers, shell hooks).
 *
 * Scrubbing is the DEFAULT. Set AGENC_SUBPROCESS_ENV_NO_SCRUB to opt out.
 * The legacy AGENC_SUBPROCESS_ENV_SCRUB flag is no longer required (scrubbing
 * is now unconditional) and is retained only so an explicit truthy setting
 * cannot be downgraded by the opt-out.
 */
export function subprocessEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  // CCR upstreamproxy: inject HTTPS_PROXY + CA bundle vars so curl/gh/python
  // in agent subprocesses route through the local relay. Returns {} when the
  // proxy is disabled or not registered (non-CCR), so this is a no-op outside
  // CCR containers.
  const proxyEnv = _getUpstreamProxyEnv?.() ?? {}
  const env = { ...baseEnv, ...proxyEnv }

  // Deliberate opt-out for trusted setups that genuinely need an inherited
  // token. The legacy explicit-scrub flag always wins over the opt-out so the
  // CI hardening path can never be downgraded back to inheriting secrets.
  if (
    isEnvTruthy(env.AGENC_SUBPROCESS_ENV_NO_SCRUB) &&
    !isEnvTruthy(env.AGENC_SUBPROCESS_ENV_SCRUB)
  ) {
    return env
  }

  for (const key of Object.keys(env)) {
    if (isSecretEnvKey(key)) delete env[key]
  }
  return env
}
