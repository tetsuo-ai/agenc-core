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
import { getActiveAgentRuntimeOptions } from '../../session/runtime-options.js'
import { getAgenCHomeDir } from '../envUtils.js'
import { getSelectedProviderSelection } from '../model/providers.js'
import { DANGEROUS_BYPASS_FLAG } from '../../bin/startup-flags.js'

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

  // Propagate permission mode to teammates, but NOT if plan mode is required
  // Plan mode takes precedence over bypass permissions for safety
  if (planModeRequired) {
    // Don't inherit bypass permissions when plan mode is required
  } else if (permissionMode === 'bypassPermissions') {
    flags.push(DANGEROUS_BYPASS_FLAG)
  } else if (permissionMode === 'acceptEdits') {
    flags.push('--permission-mode acceptEdits')
  } else if (permissionMode === 'auto') {
    // Teammates inherit auto mode so the classifier auto-approves their tool
    // calls too. The teammate's own startup handles feature-gate activation.
    flags.push('--permission-mode auto')
  }

  if (model) {
    flags.push(`--model ${quote([model])}`)
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
 * Captured session-environment variables that must be explicitly forwarded to
 * tmux-spawned teammates. Tmux may start a new login shell that doesn't inherit
 * the client's environment, so these values come from the session-owned
 * provider authority rather than the daemon process environment.
 */
const TEAMMATE_ENV_VARS = [
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'GEMINI_API_KEY',
  'GEMINI_BASE_URL',
  'GOOGLE_API_KEY',
  'MISTRAL_API_KEY',
  'MISTRAL_BASE_URL',
  // Custom API endpoint
  'ANTHROPIC_BASE_URL',
  // Upstream proxy — the parent's MITM relay is reachable from teammates
  // (same container network). Forward the proxy vars so teammates route
  // customer-configured upstream traffic through the relay for credential
  // injection. Without these, teammates bypass the proxy entirely.
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'NO_PROXY',
  'no_proxy',
  'SSL_CERT_FILE',
  'NODE_EXTRA_CA_CERTS',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
  // Source builds may rely on user shell PATH for rg/node/bun and other tools.
  // Forward it so teammates resolve the same toolchain as the parent session.
  'PATH',
] as const

/**
 * Builds the `env KEY=VALUE ...` string for teammate spawn commands.
 * Always includes AGENCCODE=1 and AGENC_EXPERIMENTAL_AGENT_TEAMS=1,
 * plus the provider, home, and subprocess inputs captured for this session.
 */
export function buildInheritedEnvVars(): string {
  const selection = getSelectedProviderSelection()
  const environment = selection.environment
  const envVars = [
    'AGENCCODE=1',
    'AGENC_EXPERIMENTAL_AGENT_TEAMS=1',
    // Teammates should inherit the leader-selected provider route instead of
    // replaying persisted config provider defaults.
    'AGENC_PROVIDER_MANAGED_BY_HOST=1',
    `AGENC_PROVIDER=${quote([selection.provider])}`,
    `AGENC_HOME=${quote([getAgenCHomeDir()])}`,
  ]

  const runtimeOptions = getActiveAgentRuntimeOptions()
  if (runtimeOptions?.remoteMode) envVars.push('AGENC_REMOTE=1')
  if (runtimeOptions?.remoteMemoryRoot !== undefined) {
    envVars.push(
      `AGENC_REMOTE_MEMORY_DIR=${quote([runtimeOptions.remoteMemoryRoot])}`,
    )
  }
  if (runtimeOptions?.coworkMemoryPathOverride !== undefined) {
    envVars.push(
      `AGENC_COWORK_MEMORY_PATH_OVERRIDE=${quote([runtimeOptions.coworkMemoryPathOverride])}`,
    )
  }
  if (runtimeOptions?.coworkMemoryExtraGuidelines !== undefined) {
    envVars.push(
      `AGENC_COWORK_MEMORY_EXTRA_GUIDELINES=${quote([runtimeOptions.coworkMemoryExtraGuidelines])}`,
    )
  }

  for (const key of TEAMMATE_ENV_VARS) {
    const value = environment[key]
    if (value !== undefined && value !== '') {
      envVars.push(`${key}=${quote([value])}`)
    }
  }

  return envVars.join(' ')
}
