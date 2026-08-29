/**
 * Shared utilities for spawning teammates across different backends.
 */

import {
  getChromeFlagOverride,
  getInlinePlugins,
} from '../../bootstrap/state.js'
import { quote } from '../bash/shellQuote.js'
import { isInBundledMode } from '../bundledMode.js'
import type { PermissionMode } from '../permissions/PermissionMode.js'
import { getTeammateModeFromSnapshot } from './backends/teammateModeSnapshot.js'
import { TEAMMATE_COMMAND_ENV_VAR } from './constants.js'
import {
  getActiveAgentRuntimeOptions,
  projectAgentRuntimeOptionsEnvironment,
} from '../../session/runtime-options.js'
import { getAgenCHomeDir } from '../envUtils.js'
import { getSelectedProviderSelection } from '../model/providers.js'
import { requireCurrentRuntimeSession } from '../../session/current-session.js'
import { canonicalSessionEnvironmentKeys } from '../../session/environment.js'

const PORTABLE_ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u
const ENVIRONMENT_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u
const DERIVED_CHILD_ENVIRONMENT_KEYS = new Set([
  'PWD',
  'OLDPWD',
  'INIT_CWD',
  'SHLVL',
  '_',
])

function requireTeammateRuntimeOptions() {
  const options = getActiveAgentRuntimeOptions()
  if (options === undefined) {
    throw new Error(
      'Teammate spawn requires captured parent runtime-options authority',
    )
  }
  return options
}

function isSafeChildBaseEnvironmentEntry(
  entry: readonly [string, string | undefined],
): entry is [string, string] {
  const [key, value] = entry
  return (
    typeof value === 'string' &&
    PORTABLE_ENVIRONMENT_NAME.test(key) &&
    !ENVIRONMENT_CONTROL_CHARACTERS.test(value) &&
    !key.startsWith('AGENC_') &&
    key !== 'AGENCCODE' &&
    !DERIVED_CHILD_ENVIRONMENT_KEYS.has(key)
  )
}

function assertSafeAuthoritativeEnvironmentEntry(
  key: string,
  value: string,
): void {
  if (!PORTABLE_ENVIRONMENT_NAME.test(key)) {
    throw new Error(`Cannot inherit non-portable environment name: ${key}`)
  }
  if (ENVIRONMENT_CONTROL_CHARACTERS.test(value)) {
    throw new Error(
      `Cannot inherit ${key}: environment values must not contain control characters`,
    )
  }
}

function quoteEnvironmentAssignment(key: string, value: string): string {
  assertSafeAuthoritativeEnvironmentEntry(key, value)
  return quote([`${key}=${value}`])
}

/**
 * Gets the command to use for spawning teammate processes.
 * Uses TEAMMATE_COMMAND_ENV_VAR if set, otherwise falls back to the
 * current process executable path.
 */
export function getTeammateCommand(): string {
  if (process.env[TEAMMATE_COMMAND_ENV_VAR]) {
    return process.env[TEAMMATE_COMMAND_ENV_VAR]
  }
  return isInBundledMode() ? process.execPath : process.argv[1]!
}

/**
 * Builds CLI flags to propagate from the current session to spawned teammates.
 * This ensures teammates inherit important settings like permission mode,
 * model selection, and plugin configuration from their parent.
 *
 * @param options.planModeRequired - If true, don't inherit bypass permissions (plan mode takes precedence)
 * @param options.permissionMode - Permission mode to propagate
 * @param options.model - Resolved model to pass to the teammate
 */
export function buildInheritedCliFlags(options?: {
  planModeRequired?: boolean
  permissionMode?: PermissionMode
  model?: string
}): string {
  const flags: string[] = []
  const { planModeRequired, permissionMode, model } = options || {}
  const runtimeOptions = requireTeammateRuntimeOptions()

  // Propagate permission mode to teammates, but NOT if plan mode is required
  // Plan mode takes precedence over bypass permissions for safety
  if (planModeRequired) {
    // Don't inherit bypass permissions when plan mode is required
  } else if (permissionMode === 'bypassPermissions') {
    flags.push('--permission-mode bypassPermissions')
  } else if (permissionMode === 'acceptEdits') {
    flags.push('--permission-mode acceptEdits')
  } else if (permissionMode === 'auto') {
    // Teammates inherit auto mode so the classifier auto-approves their tool
    // calls too. The teammate's own startup handles feature-gate activation.
    flags.push('--permission-mode auto')
  }

  const childModel = model ?? getSelectedProviderSelection().model
  flags.push(`--model ${quote([childModel])}`)

  if (runtimeOptions.simpleMode) {
    flags.push('--bare')
  }

  // Propagate --plugin-dir for each inline plugin
  const inlinePlugins = getInlinePlugins()
  for (const pluginDir of inlinePlugins) {
    flags.push(`--plugin-dir ${quote([pluginDir])}`)
  }

  // Propagate --teammate-mode so tmux teammates use the same mode as leader
  const sessionMode = getTeammateModeFromSnapshot()
  flags.push(`--teammate-mode ${sessionMode}`)

  // Propagate --chrome / --no-chrome if explicitly set on the CLI
  const chromeFlagOverride = getChromeFlagOverride()
  if (chromeFlagOverride === true) {
    flags.push('--chrome')
  } else if (chromeFlagOverride === false) {
    flags.push('--no-chrome')
  }

  return flags.join(' ')
}

/**
 * Builds the `env -i -- KEY=VALUE ...` arguments for teammate spawn commands.
 * Always includes AGENCCODE=1 and AGENC_EXPERIMENTAL_AGENT_TEAMS=1,
 * plus the provider, home, and subprocess inputs captured for this session.
 */
export function buildInheritedEnvVars(
  explicitBaseEnvironment?: Readonly<Record<string, string | undefined>>,
): string {
  const selection = getSelectedProviderSelection()
  const runtimeOptions = requireTeammateRuntimeOptions()
  const baseEnvironment =
    explicitBaseEnvironment ??
    requireCurrentRuntimeSession('teammate child environment').services
      .userShell.childEnvironment
  const capturedEnvironment: Record<string, string> = Object.fromEntries(
    Object.entries(baseEnvironment).filter(isSafeChildBaseEnvironmentEntry),
  )
  for (const key of canonicalSessionEnvironmentKeys(
    baseEnvironment,
    selection.environment,
  )) {
    delete capturedEnvironment[key]
  }
  for (const [key, value] of Object.entries(selection.environment)) {
    // The child model is always an explicit CLI selector. Do not carry a stale
    // lower-precedence AGENC_MODEL captured before an in-session model switch.
    if (key === 'AGENC_MODEL') continue
    if (value !== undefined && value !== '') {
      assertSafeAuthoritativeEnvironmentEntry(key, value)
      capturedEnvironment[key] = value
    }
  }
  const environment = {
    ...projectAgentRuntimeOptionsEnvironment(
      runtimeOptions,
      capturedEnvironment,
    ),
    AGENCCODE: '1',
    AGENC_EXPERIMENTAL_AGENT_TEAMS: '1',
    // Teammates inherit the resolved provider route instead of replaying a
    // persisted default that may belong to another daemon client.
    AGENC_PROVIDER_MANAGED_BY_HOST: '1',
    AGENC_PROVIDER: selection.provider,
    AGENC_HOME: getAgenCHomeDir(),
  }
  return [
    '-i',
    '--',
    ...Object.entries(environment).map(([key, value]) =>
      quoteEnvironmentAssignment(key, value),
    ),
  ].join(' ')
}
