/**
 * Environment variables that control inference routing: which provider to use,
 * which endpoint to hit, and which model IDs to send.
 *
 * When AGENC_PROVIDER_MANAGED_BY_HOST is truthy in the spawn env, these
 * are stripped from settings-sourced env so the host's routing config isn't
 * overridden by canonical user configuration — e.g. a Bedrock setup for
 * terminal CLI that would break a host that only supports first-party auth.
 *
 * @[MODEL LAUNCH]: Add new provider routing inputs here when host-managed
 * startup must prevent canonical user configuration from overriding them.
 */
const PROVIDER_MANAGED_ENV_VARS = new Set([
  // The flag itself — settings can't unset it once the host set it
  'AGENC_PROVIDER_MANAGED_BY_HOST',
  // Provider selection
  'AGENC_PROVIDER',
  // Endpoint config (base URLs, project/resource identifiers)
  'ANTHROPIC_BASE_URL',
  // Auth
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'AGENC_OAUTH_TOKEN',
])

export function isProviderManagedEnvVar(key: string): boolean {
  const upper = key.toUpperCase()
  return PROVIDER_MANAGED_ENV_VARS.has(upper)
}

/**
 * Dangerous shell settings that can execute arbitrary shell code
 */
export const DANGEROUS_SHELL_SETTINGS = [
  'statusLine',
] as const

/**
 * Safe environment variables that can be applied before trust dialog.
 * These are AgenC specific settings that don't pose security risks.
 *
 * IMPORTANT: This is the source of truth for which env vars are safe.
 * Any env var NOT in this list is considered dangerous and will trigger
 * a security dialog when set via remote managed settings.
 *
 * Dangerous env vars (NOT in this list):
 *
 * === REDIRECT TO ATTACKER-CONTROLLED SERVER ===
 * - ANTHROPIC_BASE_URL
 * - HTTP_PROXY, HTTPS_PROXY, NO_PROXY, http_proxy, https_proxy, no_proxy
 *
 * === TRUST ATTACKER-CONTROLLED SERVER ===
 * - NODE_TLS_REJECT_UNAUTHORIZED
 * - NODE_EXTRA_CA_CERTS
 *
 * === SWITCH TO ATTACKER-CONTROLLED PROJECT ===
 * - ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN
 */
export const SAFE_ENV_VARS = new Set([
  'ANTHROPIC_CUSTOM_HEADERS',
  'AWS_DEFAULT_REGION',
  'AWS_PROFILE',
  'AWS_REGION',
  'BASH_DEFAULT_TIMEOUT_MS',
  'BASH_MAX_OUTPUT_LENGTH',
  'BASH_MAX_TIMEOUT_MS',
  'AGENC_BASH_MAINTAIN_PROJECT_WORKING_DIR',
  'AGENC_DISABLE_NONESSENTIAL_TRAFFIC',
  'AGENC_DISABLE_TERMINAL_TITLE',
  'AGENC_EXPERIMENTAL_AGENT_TEAMS',
  'AGENC_IDE_SKIP_AUTO_INSTALL',
  'AGENC_MAX_OUTPUT_TOKENS',
  'AGENC_PROVIDER',
  'DISABLE_AUTOUPDATER',
  'DISABLE_BUG_COMMAND',
  'DISABLE_COST_WARNINGS',
  'DISABLE_ERROR_REPORTING',
  'DISABLE_FEEDBACK_COMMAND',
  'MAX_MCP_OUTPUT_TOKENS',
  'MAX_THINKING_TOKENS',
  'MCP_TIMEOUT',
  'MCP_TOOL_TIMEOUT',
  'USE_BUILTIN_RIPGREP',
])
