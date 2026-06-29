import { isEnvTruthy } from './envUtils.js'
import { SECRET_ENV_KEYS } from './providerSecrets.js'

// Names that subprocessEnv() owns directly (not derived from SECRET_ENV_KEYS).
// SECRET_ENV_KEYS (the single source of provider-secret env names that the
// codebase assigns to process.env in providerProfiles.ts) is unioned in below
// so any newly-added provider key is scrubbed automatically.
const SUBPROCESS_SECRET_ENV_BASE = [
  // provider auth — agenc re-reads these per-request, subprocesses don't need them
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_FOUNDRY_API_KEY',
  'ANTHROPIC_CUSTOM_HEADERS',
  'OPENAI_API_KEY',
  'OPENAI_AUTH_HEADER_VALUE',
  'OPENROUTER_API_KEY',
  'GROQ_API_KEY',
  'DEEPSEEK_API_KEY',
  'GEMINI_API_KEY',
  'GEMINI_ACCESS_TOKEN',
  'GOOGLE_API_KEY',
  'GOOGLE_GENAI_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'XAI_API_KEY',
  'GROK_API_KEY',
  'AGENC_XAI_API_KEY',
  'AGENC_API_KEY',
  'AGENC_OAUTH_TOKEN',
  'AGENC_REMOTE_AUTH_TOKEN',
  'AGENC_SESSION_ACCESS_TOKEN',

  // additional provider keys set live on process.env by provider profiles
  // (providerProfiles.ts) — these were previously MISSING and leaked to children
  'MISTRAL_API_KEY',
  'MINIMAX_API_KEY',
  'NVIDIA_API_KEY',
  'BNKR_API_KEY',

  // MCP OAuth client secret — read from process.env by services/mcp/auth.ts;
  // an MCP stdio child must not inherit the parent's OAuth client secret
  'MCP_CLIENT_SECRET',

  // Cloud provider creds — same pattern (lazy SDK reads)
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_BEARER_TOKEN_BEDROCK',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'AZURE_CLIENT_SECRET',
  'AZURE_CLIENT_CERTIFICATE_PATH',

  // GitHub Actions OIDC — consumed by the action's JS before agenc spawns;
  // leaking these allows minting an App installation token → repo takeover
  'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
  'ACTIONS_ID_TOKEN_REQUEST_URL',

  // GitHub Actions artifact/cache API — cache poisoning → supply-chain pivot
  'ACTIONS_RUNTIME_TOKEN',
  'ACTIONS_RUNTIME_URL',

  // GitHub API tokens — a leaked token grants repo write / supply-chain pivot.
  // Wrapper scripts that genuinely need gh auth can re-inject via serverRef.env
  // or the explicit opt-out below.
  'GITHUB_TOKEN',
  'GH_TOKEN',

  // agenc-code-action-specific duplicates — action JS consumes these during
  // prepare, before spawning agenc. ALL_INPUTS contains anthropic_api_key as JSON.
  'ALL_INPUTS',
  'OVERRIDE_GITHUB_TOKEN',
  'DEFAULT_WORKFLOW_TOKEN',
  'SSH_SIGNING_KEY',
] as const

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
export const SUBPROCESS_SECRET_ENV: readonly string[] = [
  ...new Set<string>([...SUBPROCESS_SECRET_ENV_BASE, ...SECRET_ENV_KEYS]),
]

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

  for (const k of SUBPROCESS_SECRET_ENV) {
    delete env[k]
    // GitHub Actions auto-creates INPUT_<NAME> for `with:` inputs, duplicating
    // secrets like INPUT_ANTHROPIC_API_KEY. No-op for vars that aren't action inputs.
    delete env[`INPUT_${k}`]
  }
  return env
}
