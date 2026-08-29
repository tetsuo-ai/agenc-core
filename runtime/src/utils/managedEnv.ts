
import { isEnvTruthy } from './envUtils.js'
import {
  isProviderManagedEnvVar,
  SAFE_ENV_VARS,
} from './managedEnvConstants.js'
import { isSettingSourceEnabled } from './settings/constants.js'
import {
  getExecutionAuthoritySettings,
  getSettingsForSource,
} from './settings/settings.js'

/**
 * `agenc ssh` remote: ANTHROPIC_UNIX_SOCKET routes auth through a -R forwarded
 * socket to a local proxy, and the launcher sets a handful of placeholder auth
 * env vars that canonical remote configuration MUST NOT clobber (see
 * isAnthropicAuthEnabled). Strip them from any settings-sourced env object.
 */

function withoutSSHTunnelVars(
  env: Readonly<Record<string, string>> | undefined,
  processEnvironment: NodeJS.ProcessEnv,
): Record<string, string> {
  if (!env || !processEnvironment.ANTHROPIC_UNIX_SOCKET) return env || {}
  const {
    ANTHROPIC_UNIX_SOCKET: _1,
    ANTHROPIC_BASE_URL: _2,
    ANTHROPIC_API_KEY: _3,
    ANTHROPIC_AUTH_TOKEN: _4,
    AGENC_OAUTH_TOKEN: _5,
    ...rest
  } = env
  return rest
}

/**
 * When the host owns inference routing (sets
 * AGENC_PROVIDER_MANAGED_BY_HOST in spawn env), strip
 * provider-selection / model-default vars from settings-sourced env so a
 * canonical user configuration cannot redirect requests away from the
 * host-configured provider.
 */
function withoutHostManagedProviderVars(
  env: Readonly<Record<string, string>> | undefined,
  processEnvironment: NodeJS.ProcessEnv,
): Record<string, string> {
  if (!env) return {}
  if (!isEnvTruthy(processEnvironment.AGENC_PROVIDER_MANAGED_BY_HOST)) {
    return env
  }
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (!isProviderManagedEnvVar(key)) {
      out[key] = value
    }
  }
  return out
}

/**
 * Snapshot of env keys present before config environment is applied—for CCD,
 * these are the keys the desktop host set to orchestrate the subprocess.
 * Canonical config must not override them. Keys added later by a config reload
 * are not in this set, so mid-session config changes still apply.
 * Lazy-captured on first applySafeConfigEnvironmentVariables() call.
 */
let ccdSpawnEnvKeys: Set<string> | null | undefined

function withoutCcdSpawnEnvKeys(
  env: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  if (!env || !ccdSpawnEnvKeys) return env || {}
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (!ccdSpawnEnvKeys.has(key)) out[key] = value
  }
  return out
}

/**
 * Compose the strip filters applied to every config-sourced environment map.
 */
function filterSettingsEnv(
  env: Readonly<Record<string, string>> | undefined,
  processEnvironment: NodeJS.ProcessEnv,
): Record<string, string> {
  return withoutCcdSpawnEnvKeys(
    withoutHostManagedProviderVars(
      withoutSSHTunnelVars(env, processEnvironment),
      processEnvironment,
    ),
  )
}

/**
 * Trusted setting sources whose env vars can be applied before the trust dialog.
 *
 * - userSettings (user config.toml): controlled by the user, not project-specific
 * - flagSettings (explicit canonical config layer): explicitly passed by the user
 * - policySettings (canonical managed config.toml policy layer):
 *   controlled by IT/admin (highest priority, cannot be overridden)
 *
 * Project-scoped sources (projectSettings, localSettings) are excluded because they live
 * inside the project directory and could be committed by a malicious actor to redirect
 * traffic (e.g., ANTHROPIC_BASE_URL) to an attacker-controlled server.
 */
const TRUSTED_SETTING_SOURCES = [
  'userSettings',
  'flagSettings',
  'policySettings',
] as const

/**
 * Apply environment variables from trusted sources to process.env.
 * Called before the trust dialog so that user/enterprise env vars like
 * ANTHROPIC_BASE_URL take effect during first-run/onboarding.
 *
 * For trusted sources (user settings, managed settings, CLI flags), ALL env vars
 * are applied — including ones like ANTHROPIC_BASE_URL that would be dangerous
 * from project-scoped settings.
 *
 * For project-scoped sources (projectSettings, localSettings), only safe env vars
 * from the SAFE_ENV_VARS allowlist are applied. These are applied after trust is
 * fully established via applyConfigEnvironmentVariables().
 */
export function applySafeConfigEnvironmentVariables(): void {
  // Capture CCD spawn-env keys before config environment is applied (once).
  if (ccdSpawnEnvKeys === undefined) {
    ccdSpawnEnvKeys =
      process.env.AGENC_ENTRYPOINT === 'agenc-desktop'
        ? new Set(Object.keys(process.env))
        : null
  }

  // Apply ALL env vars from trusted setting sources, policySettings last.
  // Gate on isSettingSourceEnabled so SDK settingSources: [] (isolation mode)
  // does not inherit user configuration. policy/flag
  // sources are always enabled, so this only ever filters userSettings.
  for (const source of TRUSTED_SETTING_SOURCES) {
    if (source === 'policySettings') continue
    if (!isSettingSourceEnabled(source)) continue
    Object.assign(
      process.env,
      filterSettingsEnv(
        getSettingsForSource(source)?.shell_environment_policy?.set,
        process.env,
      ),
    )
  }

  Object.assign(
    process.env,
    filterSettingsEnv(
      getSettingsForSource('policySettings')?.shell_environment_policy?.set,
      process.env,
    ),
  )

  // Apply only safe env vars from the fully-merged settings (which includes
  // project-scoped sources). For safe vars that also exist in trusted sources,
  // the merged value (which may come from a higher-priority project source)
  // will overwrite the trusted value — this is acceptable since these vars are
  // in the safe allowlist. Only policySettings values are guaranteed to survive
  // unchanged (it has the highest merge priority in both loops) — except
  // provider-routing vars, which filterSettingsEnv strips from every source
  // when AGENC_PROVIDER_MANAGED_BY_HOST is set.
  const settingsEnv = filterSettingsEnv(
    getExecutionAuthoritySettings().shell_environment_policy?.set,
    process.env,
  )
  for (const [key, value] of Object.entries(settingsEnv)) {
    if (SAFE_ENV_VARS.has(key.toUpperCase())) {
      process.env[key] = value
    }
  }

}

/**
 * Apply environment variables from settings to process.env.
 * This applies ALL environment variables (except provider-routing vars when
 * AGENC_PROVIDER_MANAGED_BY_HOST is set — see filterSettingsEnv) and
 * should only be called after trust is established. This applies potentially
 * dangerous environment variables such as LD_PRELOAD, PATH, etc.
 */
export function applyConfigEnvironmentVariables(): void {
  Object.assign(
    process.env,
    filterSettingsEnv(
      getExecutionAuthoritySettings().shell_environment_policy?.set,
      process.env,
    ),
  )

}
