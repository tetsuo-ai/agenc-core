import { isEnvTruthy } from './envBoolean.js'
import { isSecretEnvKey } from './secretEnv.js'
import { assertNoObsoleteConfigEnvironment } from '../config/env.js'
import { isAbsolute, normalize } from 'node:path'

const CHILD_TEMP_AUTHORITY_KEYS = new Set([
  'AGENC_TMPDIR',
  'TMPDIR',
  'TEMP',
  'TMP',
])

/** True when an environment key can select a child process's temp root. */
export function isChildTempAuthorityKey(key: string): boolean {
  return CHILD_TEMP_AUTHORITY_KEYS.has(key.toUpperCase())
}

/**
 * Install one captured temp-root authority at the final child-spawn boundary.
 * Ambient and caller-supplied aliases are removed case-insensitively first so
 * platform-specific environment handling cannot select a second root.
 */
export function withChildTempAuthority(
  environment: Readonly<Record<string, string | undefined>>,
  sessionTempRoot: string,
): Record<string, string> {
  const trimmedRoot = sessionTempRoot.trim()
  if (trimmedRoot.length === 0 || !isAbsolute(trimmedRoot)) {
    throw new Error('child process temp root must be a non-empty absolute path')
  }
  const root = normalize(trimmedRoot)
  const childEnvironment: Record<string, string> = {}
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined || isChildTempAuthorityKey(key)) continue
    childEnvironment[key] = value
  }
  childEnvironment.AGENC_TMPDIR = root
  childEnvironment.TMPDIR = root
  childEnvironment.TEMP = root
  childEnvironment.TMP = root
  return childEnvironment
}

/**
 * Env vars stripped from EVERY subprocess environment by default.
 *
 * Child processes (Bash tool, shell snapshot, MCP stdio servers, LSP servers,
 * shell hooks) are spawned with these removed so that a prompt-injected or
 * model-run command (e.g. `printenv`, or shell expansion like
 * `${ANTHROPIC_API_KEY}`) cannot exfiltrate provider keys or CI credentials.
 *
 * Provider calls run in-process through each session's prepared provider
 * binding. Spawned children receive a scrubbed child environment and do not
 * need provider credential variables.
 *
 * SUBPROCESS_SECRET_ENV is the canonical denylist from secretEnv.ts. It combines
 * curated CI, cloud, and OAuth names with provider credential ingress names
 * derived from the built-in provider registry.
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
