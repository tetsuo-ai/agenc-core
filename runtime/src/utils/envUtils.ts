import { join } from 'path'
import { isEnvTruthy } from './envBoolean.js'
export { isEnvDefinedFalsy, isEnvTruthy } from './envBoolean.js'
import {
  resolveHomeContext,
  type HomeContext,
} from '../config/home.js'
import {
  getCurrentRuntimeSession,
  peekAmbientRuntimeSession,
} from '../session/current-session.js'
import { peekAgentRuntimeOptions } from '../session/runtime-options.js'
import { getCanonicalSettingsAuthority } from './settings/canonicalAuthority.js'

/**
 * Resolve home from the session bound to this async execution chain.
 *
 * Never memoize this value: one daemon may host sessions with different
 * homes, and a process-global cache would make the first caller authoritative
 * for every later session. `getCurrentRuntimeSession()` also rejects an
 * ambiguous multi-session fallback instead of guessing. Ambient environment
 * resolution remains only for genuine pre-session process ingress.
 */
export function getAgenCHomeContext(): HomeContext {
  let session: ReturnType<typeof getCurrentRuntimeSession>
  try {
    session = getCurrentRuntimeSession()
  } catch (error) {
    const authority = getCanonicalSettingsAuthority()
    if (authority !== null) return authority.homeContext
    throw error
  }
  if (session !== null) {
    const store = session.services?.configStore
    const boundHome = store?.homeContext
    if (boundHome === undefined) {
      throw new Error(
        'Active runtime session has no canonical ConfigStore home authority',
      )
    }
    return boundHome
  }
  const authority = getCanonicalSettingsAuthority()
  if (authority !== null) return authority.homeContext
  return resolveHomeContext(process.env)
}

export function getAgenCHomeDir(): string {
  return getAgenCHomeContext().path
}

export function getTeamsDir(): string {
  return join(getAgenCHomeDir(), 'teams')
}

/**
 * Check if NODE_OPTIONS contains a specific flag.
 * Splits on whitespace and checks for exact match to avoid false positives.
 */
export function hasNodeOption(flag: string): boolean {
  const nodeOptions = process.env.NODE_OPTIONS
  if (!nodeOptions) {
    return false
  }
  return nodeOptions.split(/\s+/).includes(flag)
}

/**
 * --bare skips hooks, LSP, plugin sync, skill dir-walk,
 * attribution, and background prefetches. Authentication stays active so
 * provider credentials can be read, refreshed, saved, and cleared normally.
 * Explicit CLI flags such as --plugin-dir and --add-dir remain honored.
 * ~30 gates across the codebase.
 *
 * Runtime consumers use the immutable options bound at the ingress boundary;
 * they never rediscover mode from process-global environment or argv.
 */
export function isBareMode(): boolean {
  return (
    peekAmbientRuntimeSession()?.services?.runtimeOptions?.simpleMode ??
    peekAgentRuntimeOptions()?.simpleMode ??
    false
  )
}

/**
 * Parses an array of environment variable strings into a key-value object
 * @param envVars Array of strings in KEY=VALUE format
 * @returns Object with key-value pairs
 */
export function parseEnvVars(
  rawEnvArgs: string[] | undefined,
): Record<string, string> {
  const parsedEnv: Record<string, string> = {}

  // Parse individual env vars
  if (rawEnvArgs) {
    for (const envStr of rawEnvArgs) {
      const [key, ...valueParts] = envStr.split('=')
      if (!key || valueParts.length === 0) {
        throw new Error(
          `Invalid environment variable format: ${envStr}, environment variables should be added as: -e KEY1=value1 -e KEY2=value2`,
        )
      }
      parsedEnv[key] = valueParts.join('=')
    }
  }
  return parsedEnv
}

/**
 * Get the default Vertex AI region
 */
export function getDefaultVertexRegion(
  env: Readonly<Record<string, string | undefined>>,
): string {
  return env.CLOUD_ML_REGION || 'us-east5'
}

/**
 * Check if bash commands should maintain project working directory (reset to original after each command)
 * @returns true if AGENC_BASH_MAINTAIN_PROJECT_WORKING_DIR is set to a truthy value
 */
export function shouldMaintainProjectWorkingDir(): boolean {
  return isEnvTruthy(process.env.AGENC_BASH_MAINTAIN_PROJECT_WORKING_DIR)
}

/**
 * Check if running on Homespace (ant-internal cloud environment)
 */
export function isRunningOnHomespace(
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  return (
    env.USER_TYPE === 'ant' &&
    isEnvTruthy(env.COO_RUNNING_ON_HOMESPACE)
  )
}

/**
 * Conservative check for whether AgenC is running inside a protected
 * (privileged or ASL3+) COO namespace or cluster.
 *
 * Conservative means: when signals are ambiguous, assume protected. We would
 * rather over-report protected usage than miss it. Unprotected environments
 * are homespace, namespaces on the open allowlist, and no k8s/COO signals
 * at all (laptop/local dev).
 *
 * Used for telemetry to measure auto-mode usage in sensitive environments.
 */
export function isInProtectedNamespace(): boolean {
  // The protectedNamespace helper was AgenC-only and has been
  // removed in the lean build. Always report false here so the bundler
  // does not try to resolve a deleted module path.
  return false
}

// @[MODEL LAUNCH]: Add a Vertex region override env var for the new model.
/**
 * Model prefix → env var for Vertex region overrides.
 * Order matters: more specific prefixes must come before less specific ones
 * (e.g., 'claude-opus-4-1' before 'claude-opus-4').
 */
const VERTEX_REGION_OVERRIDES: ReadonlyArray<[string, string]> = [
  ['claude-haiku-4-5', 'VERTEX_REGION_CLAUDE_HAIKU_4_5'],
  ['claude-3-5-haiku', 'VERTEX_REGION_CLAUDE_3_5_HAIKU'],
  ['claude-3-5-sonnet', 'VERTEX_REGION_CLAUDE_3_5_SONNET'],
  ['claude-3-7-sonnet', 'VERTEX_REGION_CLAUDE_3_7_SONNET'],
  ['claude-opus-4-1', 'VERTEX_REGION_CLAUDE_4_1_OPUS'],
  ['claude-opus-4', 'VERTEX_REGION_CLAUDE_4_0_OPUS'],
  ['claude-sonnet-4-6', 'VERTEX_REGION_CLAUDE_4_6_SONNET'],
  ['claude-sonnet-4-5', 'VERTEX_REGION_CLAUDE_4_5_SONNET'],
  ['claude-sonnet-4', 'VERTEX_REGION_CLAUDE_4_0_SONNET'],
]

/**
 * Get the Vertex AI region for a specific model.
 * Different models may be available in different regions.
 */
export function getVertexRegionForModel(
  model: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  if (model) {
    const match = VERTEX_REGION_OVERRIDES.find(([prefix]) =>
      model.startsWith(prefix),
    )
    if (match) {
      return env[match[1]] || getDefaultVertexRegion(env)
    }
  }
  return getDefaultVertexRegion(env)
}
