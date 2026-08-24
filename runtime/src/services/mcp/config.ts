import mapValues from 'lodash-es/mapValues.js'
import { getPlatform } from 'src/utils/platform.js'
import type { PluginError } from '../../types/plugin.js'
import { isAgenCInChromeMCPServer } from '../../utils/agencInChrome/common.js'
import { applyCanonicalConfigPatchSync } from '../../config/update-sync.js'
import type { ManagedMcpServerPolicyEntry } from '../../config/schema.js'
import { mergeConfigLayerSnapshots } from '../../config/repository.js'
import { logForDebugging } from 'src/utils/debug.js'
import { logError } from '../../utils/log.js'
import { loadPluginMcpServerRegistrations } from '../../plugins/registration/mcp-plugin-integration.js'
import type { PluginLoadIssue } from '../../plugins/loader.js'
import { isSettingSourceEnabled } from '../../utils/settings/constants.js'
import { isRestrictedToPluginOnly } from '../../utils/settings/pluginOnlyPolicy.js'
import type { CanonicalSettingsAuthority } from '../../utils/settings/canonicalAuthority.js'
import {
  getSettingsFilePathForSource,
  getSettingsForSource,
  type RuntimeSettingsSnapshot,
} from '../../utils/settings/settings.js'
import type { ValidationError } from '../../utils/settings/validation.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { expandEnvVarsInString } from './envExpansion.js'
import {
  type ConfigScope,
  type McpHTTPServerConfig,
  type McpJsonConfig,
  McpJsonConfigSchema,
  type McpServerConfig,
  McpServerConfigSchema,
  type McpSSEServerConfig,
  type McpStdioServerConfig,
  type McpWebSocketServerConfig,
  type ScopedMcpServerConfig,
} from './types.js'
import { getProjectMcpServerStatus } from './utils.js'
import {
  canonicalMcpServerToServiceConfig,
  serviceMcpServerToCanonicalConfig,
} from './user-config-toml.js'

/**
 * Internal utility: Add scope to server configs
 */
function addScopeToServers(
  servers: Record<string, McpServerConfig> | undefined,
  scope: ConfigScope,
): Record<string, ScopedMcpServerConfig> {
  if (!servers) {
    return {}
  }
  const scopedServers: Record<string, ScopedMcpServerConfig> = {}
  for (const [name, config] of Object.entries(servers)) {
    scopedServers[name] = { ...config, scope }
  }
  return scopedServers
}


/**
 * Extract command array from server config (stdio servers only)
 * Returns null for non-stdio servers
 */
function getServerCommandArray(config: McpServerConfig): string[] | null {
  // Non-stdio servers don't have commands
  if (config.type !== undefined && config.type !== 'stdio') {
    return null
  }
  const stdioConfig = config as McpStdioServerConfig
  return [stdioConfig.command, ...(stdioConfig.args ?? [])]
}

/**
 * Check if two command arrays match exactly
 */
function commandArraysMatch(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) {
    return false
  }
  return a.every((val, idx) => val === b[idx])
}

function isMcpServerNameEntry(
  entry: ManagedMcpServerPolicyEntry,
): entry is ManagedMcpServerPolicyEntry & { readonly serverName: string } {
  return entry.serverName !== undefined
}

function isMcpServerCommandEntry(
  entry: ManagedMcpServerPolicyEntry,
): entry is ManagedMcpServerPolicyEntry & { readonly serverCommand: readonly string[] } {
  return entry.serverCommand !== undefined
}

function isMcpServerUrlEntry(
  entry: ManagedMcpServerPolicyEntry,
): entry is ManagedMcpServerPolicyEntry & { readonly serverUrl: string } {
  return entry.serverUrl !== undefined
}

/**
 * Extract URL from server config (remote servers only)
 * Returns null for stdio/sdk servers
 */
function getServerUrl(config: McpServerConfig): string | null {
  return 'url' in config ? config.url : null
}

/**
 * CCR proxy URL path markers. In remote sessions, agenc.tech connectors arrive
 * through the canonical config authority with URLs rewritten to route through the CCR/session-ingress
 * SHTTP proxy. The original vendor URL is preserved in the mcp_url query param
 * so the proxy knows where to forward. See api-go/ccr/internal/ccrshared/
 * mcp_url_rewriter.go and api-go/ccr/internal/mcpproxy/proxy.go.
 */
const CCR_PROXY_PATH_MARKERS = [
  '/v2/session_ingress/shttp/mcp/',
  '/v2/ccr-sessions/',
]

/**
 * If the URL is a CCR proxy URL, extract the original vendor URL from the
 * mcp_url query parameter. Otherwise return the URL unchanged. This lets
 * signature-based dedup match a plugin's raw vendor URL against a connector's
 * rewritten proxy URL when both point at the same MCP server.
 */
export function unwrapCcrProxyUrl(url: string): string {
  if (!CCR_PROXY_PATH_MARKERS.some(m => url.includes(m))) {
    return url
  }
  try {
    const parsed = new URL(url)
    const original = parsed.searchParams.get('mcp_url')
    return original || url
  } catch {
    return url
  }
}

/**
 * Compute a dedup signature for an MCP server config.
 * Two configs with the same signature are considered "the same server" for
 * plugin deduplication. Ignores env (plugins always inject AGENC_PLUGIN_ROOT)
 * and headers (same URL = same server regardless of auth).
 * Returns null only for configs with neither command nor url (sdk type).
 */
export function getMcpServerSignature(config: McpServerConfig): string | null {
  const cmd = getServerCommandArray(config)
  if (cmd) {
    return `stdio:${jsonStringify(cmd)}`
  }
  const url = getServerUrl(config)
  if (url) {
    return `url:${unwrapCcrProxyUrl(url)}`
  }
  return null
}

/**
 * Filter plugin MCP servers, dropping any whose signature matches a
 * manually-configured server or an earlier-loaded plugin server.
 * Manual wins over plugin; between plugins, first-loaded wins.
 *
 * Plugin servers use normalized scoped identifiers so they never key-collide
 * with manual servers in the merge — this content-based check catches the case
 * where both actually launch the same underlying process/connection.
 */
export function dedupPluginMcpServers(
  pluginServers: Record<string, ScopedMcpServerConfig>,
  manualServers: Record<string, ScopedMcpServerConfig>,
): {
  servers: Record<string, ScopedMcpServerConfig>
  suppressed: Array<{
    name: string
    duplicateOf: string
    config: ScopedMcpServerConfig
  }>
} {
  // Map signature -> server name so we can report which server a dup matches
  const manualSigs = new Map<string, string>()
  for (const [name, config] of Object.entries(manualServers)) {
    const sig = getMcpServerSignature(config)
    if (sig && !manualSigs.has(sig)) manualSigs.set(sig, name)
  }

  const servers: Record<string, ScopedMcpServerConfig> = {}
  const suppressed: Array<{
    name: string
    duplicateOf: string
    config: ScopedMcpServerConfig
  }> = []
  const seenPluginSigs = new Map<string, string>()
  for (const [name, config] of Object.entries(pluginServers)) {
    const sig = getMcpServerSignature(config)
    if (sig === null) {
      servers[name] = config
      continue
    }
    const manualDup = manualSigs.get(sig)
    if (manualDup !== undefined) {
      logForDebugging(
        `Suppressing plugin MCP server "${name}": duplicates manually-configured "${manualDup}"`,
      )
      suppressed.push({ name, duplicateOf: manualDup, config })
      continue
    }
    const pluginDup = seenPluginSigs.get(sig)
    if (pluginDup !== undefined) {
      logForDebugging(
        `Suppressing plugin MCP server "${name}": duplicates earlier plugin server "${pluginDup}"`,
      )
      suppressed.push({ name, duplicateOf: pluginDup, config })
      continue
    }
    seenPluginSigs.set(sig, name)
    servers[name] = config
  }
  return { servers, suppressed }
}

export function pluginMcpDuplicateSuppressionError(
  suppression: {
    readonly name: string
    readonly duplicateOf: string
    readonly config: ScopedMcpServerConfig
  },
): PluginError | null {
  const pluginServer = suppression.config.pluginServer
  if (pluginServer !== undefined) {
    return {
      type: 'mcp-server-suppressed-duplicate',
      source: suppression.name,
      plugin: pluginServer.pluginName,
      serverName: pluginServer.serverName,
      duplicateOf: suppression.duplicateOf,
    }
  }

  const sandbox = (
    suppression.config as {
      readonly pluginSandbox?: {
        readonly pluginName: string
        readonly serverName: string
      }
    }
  ).pluginSandbox
  if (sandbox !== undefined) {
    return {
      type: 'mcp-server-suppressed-duplicate',
      source: suppression.name,
      plugin: sandbox.pluginName,
      serverName: sandbox.serverName,
      duplicateOf: suppression.duplicateOf,
    }
  }

  const parts = suppression.name.split(':')
  if (parts[0] !== 'plugin' || parts.length < 3) return null
  return {
    type: 'mcp-server-suppressed-duplicate',
    source: suppression.name,
    plugin: parts[1]!,
    serverName: parts.slice(2).join(':'),
    duplicateOf: suppression.duplicateOf,
  }
}

/**
 * Filter agenc.tech connectors, dropping any whose signature matches an enabled
 * manually-configured server. Manual wins: a user who wrote canonical project
 * TOML or ran `agenc mcp add` expressed higher intent than a connector toggled
 * in the web UI.
 *
 * Connector keys are `agenc.tech <DisplayName>` so they never key-collide with
 * manual servers in the merge — this content-based check catches the case where
 * both point at the same underlying URL (e.g. `mcp__slack__*` and
 * `mcp__agenc_ai_Slack__*` both hitting mcp.slack.com, ~600 chars/turn wasted).
 *
 * Only enabled manual servers count as dedup targets — a disabled manual server
 * mustn't suppress its connector twin, or neither runs.
 */
export function dedupAgenCAiMcpServers(
  agencAiServers: Record<string, ScopedMcpServerConfig>,
  manualServers: Record<string, ScopedMcpServerConfig>,
): {
  servers: Record<string, ScopedMcpServerConfig>
  suppressed: Array<{ name: string; duplicateOf: string }>
} {
  const manualSigs = new Map<string, string>()
  for (const [name, config] of Object.entries(manualServers)) {
    if (isMcpServerDisabled(name, config)) continue
    const sig = getMcpServerSignature(config)
    if (sig && !manualSigs.has(sig)) manualSigs.set(sig, name)
  }

  const servers: Record<string, ScopedMcpServerConfig> = {}
  const suppressed: Array<{ name: string; duplicateOf: string }> = []
  for (const [name, config] of Object.entries(agencAiServers)) {
    const sig = getMcpServerSignature(config)
    const manualDup = sig !== null ? manualSigs.get(sig) : undefined
    if (manualDup !== undefined) {
      logForDebugging(
        `Suppressing agenc.tech connector "${name}": duplicates manually-configured "${manualDup}"`,
      )
      suppressed.push({ name, duplicateOf: manualDup })
      continue
    }
    servers[name] = config
  }
  return { servers, suppressed }
}

/**
 * Convert a URL pattern with wildcards to a RegExp
 * Supports * as wildcard matching any characters
 * Examples:
 *   "https://example.com/*" matches "https://example.com/api/v1"
 *   "https://*.example.com/*" matches "https://api.example.com/path"
 *   "https://example.com:*\/*" matches any port
 */
function urlPatternToRegex(pattern: string): RegExp {
  // Escape regex special characters except *
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
  // Replace * with regex equivalent (match any characters)
  const regexStr = escaped.replace(/\*/g, '.*')
  return new RegExp(`^${regexStr}$`)
}

/**
 * Check if a URL matches a pattern with wildcard support
 */
function urlMatchesPattern(url: string, pattern: string): boolean {
  const regex = urlPatternToRegex(pattern)
  return regex.test(url)
}

/**
 * Get the settings to use for MCP server allowlist policy.
 * When allowManagedMcpServersOnly is set in policySettings, only managed settings
 * control which servers are allowed. Otherwise, returns merged settings.
 */
function getMcpAllowlistSettings(
  authority: CanonicalSettingsAuthority,
): RuntimeSettingsSnapshot {
  if (shouldAllowManagedMcpServersOnly(authority)) {
    return getSettingsForSource('policySettings', authority) ?? {}
  }
  return authority.current()
}

/**
 * Get the settings to use for MCP server denylist policy.
 * Denylists always merge from all sources — users can always deny servers
 * for themselves, even when allowManagedMcpServersOnly is set.
 */
function getMcpDenylistSettings(
  authority: CanonicalSettingsAuthority,
): RuntimeSettingsSnapshot {
  return authority.current()
}

/**
 * Check if an MCP server is denied by enterprise policy
 * Checks name-based, command-based, and URL-based restrictions
 * @param serverName The name of the server to check
 * @param config Optional server config for command/URL-based matching
 * @returns true if denied, false if not on denylist
 */
function isMcpServerDenied(
  authority: CanonicalSettingsAuthority,
  serverName: string,
  config?: McpServerConfig,
): boolean {
  const settings = getMcpDenylistSettings(authority)
  if (!settings.deniedMcpServers) {
    return false // No restrictions
  }

  // Check name-based denial
  for (const entry of settings.deniedMcpServers) {
    if (isMcpServerNameEntry(entry) && entry.serverName === serverName) {
      return true
    }
  }

  // Check command-based denial (stdio servers only) and URL-based denial (remote servers only)
  if (config) {
    const serverCommand = getServerCommandArray(config)
    if (serverCommand) {
      for (const entry of settings.deniedMcpServers) {
        if (
          isMcpServerCommandEntry(entry) &&
          commandArraysMatch(entry.serverCommand, serverCommand)
        ) {
          return true
        }
      }
    }

    const serverUrl = getServerUrl(config)
    if (serverUrl) {
      for (const entry of settings.deniedMcpServers) {
        if (
          isMcpServerUrlEntry(entry) &&
          urlMatchesPattern(serverUrl, entry.serverUrl)
        ) {
          return true
        }
      }
    }
  }

  return false
}

/**
 * Check if an MCP server is allowed by enterprise policy
 * Checks name-based, command-based, and URL-based restrictions
 * @param serverName The name of the server to check
 * @param config Optional server config for command/URL-based matching
 * @returns true if allowed, false if blocked by policy
 */
function isMcpServerAllowedByPolicy(
  authority: CanonicalSettingsAuthority,
  serverName: string,
  config?: McpServerConfig,
): boolean {
  // Denylist takes absolute precedence
  if (isMcpServerDenied(authority, serverName, config)) {
    return false
  }

  const settings = getMcpAllowlistSettings(authority)
  if (!settings.allowedMcpServers) {
    return true // No allowlist restrictions (undefined)
  }

  // Empty allowlist means block all servers
  if (settings.allowedMcpServers.length === 0) {
    return false
  }

  // Check if allowlist contains any command-based or URL-based entries
  const hasCommandEntries = settings.allowedMcpServers.some(
    isMcpServerCommandEntry,
  )
  const hasUrlEntries = settings.allowedMcpServers.some(isMcpServerUrlEntry)

  if (config) {
    const serverCommand = getServerCommandArray(config)
    const serverUrl = getServerUrl(config)

    if (serverCommand) {
      // This is a stdio server
      if (hasCommandEntries) {
        // If ANY serverCommand entries exist, stdio servers MUST match one of them
        for (const entry of settings.allowedMcpServers) {
          if (
            isMcpServerCommandEntry(entry) &&
            commandArraysMatch(entry.serverCommand, serverCommand)
          ) {
            return true
          }
        }
        return false // Stdio server doesn't match any command entry
      } else {
        // No command entries, check name-based allowance
        for (const entry of settings.allowedMcpServers) {
          if (isMcpServerNameEntry(entry) && entry.serverName === serverName) {
            return true
          }
        }
        return false
      }
    } else if (serverUrl) {
      // This is a remote server (sse, http, ws, etc.)
      if (hasUrlEntries) {
        // If ANY serverUrl entries exist, remote servers MUST match one of them
        for (const entry of settings.allowedMcpServers) {
          if (
            isMcpServerUrlEntry(entry) &&
            urlMatchesPattern(serverUrl, entry.serverUrl)
          ) {
            return true
          }
        }
        return false // Remote server doesn't match any URL entry
      } else {
        // No URL entries, check name-based allowance
        for (const entry of settings.allowedMcpServers) {
          if (isMcpServerNameEntry(entry) && entry.serverName === serverName) {
            return true
          }
        }
        return false
      }
    } else {
      // Unknown server type - check name-based allowance only
      for (const entry of settings.allowedMcpServers) {
        if (isMcpServerNameEntry(entry) && entry.serverName === serverName) {
          return true
        }
      }
      return false
    }
  }

  // No config provided - check name-based allowance only
  for (const entry of settings.allowedMcpServers) {
    if (isMcpServerNameEntry(entry) && entry.serverName === serverName) {
      return true
    }
  }
  return false
}

/**
 * Filter a record of MCP server configs by managed policy (allowedMcpServers /
 * deniedMcpServers). Servers blocked by policy are dropped and their names
 * returned so callers can warn the user.
 *
 * Intended for user-controlled config entry points that bypass the policy filter
 * in getAgenCCodeMcpConfigs(): canonical ConfigStore inputs and the mcp_set_servers
 * control message (print.ts, SDK V2 Query.setMcpServers()).
 *
 * SDK-type servers are exempt — they are SDK-managed transport placeholders,
 * not CLI-managed connections. The CLI never spawns a process or opens a
 * network connection for them; tool calls route back to the SDK via
 * mcp_tool_call. URL/command-based allowlist entries are meaningless for them
 * (no url, no command), and gating by name would silently drop them during
 * installPluginsAndApplyMcpInBackground's sdkMcpConfigs carry-forward.
 *
 * The generic has no type constraint because the two callsites use different
 * config type families: main.tsx uses ScopedMcpServerConfig (service type,
 * args: string[] required), print.ts uses McpServerConfigForProcessTransport
 * (SDK wire type, args?: string[] optional). Both are structurally compatible
 * with what isMcpServerAllowedByPolicy actually reads (type/url/command/args)
 * — the policy check only reads, never requires any field to be present.
 * The `as McpServerConfig` widening is safe for that reason; the downstream
 * checks tolerate missing/undefined fields: `config` is optional, and
 * `getServerCommandArray` defaults `args` to `[]` via `?? []`.
 */
export function filterMcpServersByPolicy<T>(
  authority: CanonicalSettingsAuthority,
  configs: Record<string, T>,
): {
  allowed: Record<string, T>
  blocked: string[]
} {
  const allowed: Record<string, T> = {}
  const blocked: string[] = []
  for (const [name, config] of Object.entries(configs)) {
    const c = config as McpServerConfig
    if (c.type === 'sdk' || isMcpServerAllowedByPolicy(authority, name, c)) {
      allowed[name] = config
    } else {
      blocked.push(name)
    }
  }
  return { allowed, blocked }
}

/**
 * Internal utility: Expands environment variables in an MCP server config
 */
function expandEnvVars(
  config: McpServerConfig,
  environment: Readonly<Record<string, string | undefined>>,
): {
  expanded: McpServerConfig
  missingVars: string[]
} {
  const missingVars: string[] = []

  function expandString(str: string): string {
    const { expanded, missingVars: vars } = expandEnvVarsInString(
      str,
      environment,
    )
    missingVars.push(...vars)
    return expanded
  }

  let expanded: McpServerConfig

  switch (config.type) {
    case undefined:
    case 'stdio': {
      const stdioConfig = config as McpStdioServerConfig
      expanded = {
        ...stdioConfig,
        command: expandString(stdioConfig.command),
        args: stdioConfig.args.map(expandString),
        env: stdioConfig.env
          ? mapValues(stdioConfig.env, expandString)
          : undefined,
      }
      break
    }
    case 'sse':
    case 'http':
    case 'ws': {
      const remoteConfig = config as
        | McpSSEServerConfig
        | McpHTTPServerConfig
        | McpWebSocketServerConfig
      expanded = {
        ...remoteConfig,
        url: expandString(remoteConfig.url),
        headers: remoteConfig.headers
          ? mapValues(remoteConfig.headers, expandString)
          : undefined,
      }
      break
    }
    case 'sse-ide':
    case 'ws-ide':
      expanded = config
      break
    case 'sdk':
      expanded = config
      break
    case 'agencai-proxy':
      expanded = config
      break
  }

  return {
    expanded,
    missingVars: [...new Set(missingVars)],
  }
}

type WritableMcpConfigScope = 'user' | 'project' | 'local'
type ReadableMcpConfigScope = WritableMcpConfigScope | 'enterprise'

function settingsSourceForMcpScope(
  scope: WritableMcpConfigScope,
): 'userSettings' | 'projectSettings' | 'localSettings' {
  switch (scope) {
    case 'user':
      return 'userSettings'
    case 'project':
      return 'projectSettings'
    case 'local':
      return 'localSettings'
  }
}

function repositoryScopeForMcpScope(
  scope: ReadableMcpConfigScope,
): 'user' | 'project' | 'local' | 'managed' {
  return scope === 'enterprise' ? 'managed' : scope
}

function canonicalMcpConfigsByScope(
  authority: CanonicalSettingsAuthority,
  scope: ReadableMcpConfigScope,
  environment: Readonly<Record<string, string | undefined>> = {},
): {
  servers: Record<string, ScopedMcpServerConfig>
  errors: ValidationError[]
} {
  if (
    scope !== 'enterprise' &&
    !isSettingSourceEnabled(settingsSourceForMcpScope(scope))
  ) {
    return { servers: {}, errors: [] }
  }

  const layers = authority.sources(repositoryScopeForMcpScope(scope))
  const settings = mergeConfigLayerSnapshots(layers)
  if (settings?.mcp_servers === undefined) {
    return { servers: {}, errors: [] }
  }
  const mcpServers = Object.fromEntries(
    Object.entries(settings.mcp_servers).map(([name, config]) => [
      name,
      canonicalMcpServerToServiceConfig(config),
    ]),
  )
  const { config, errors } = parseMcpConfig({
    configObject: { mcpServers },
    expandVars: true,
    environment,
    scope,
    ...(layers.at(-1)?.path !== undefined
      ? { filePath: layers.at(-1)!.path }
      : {}),
  })
  return {
    servers: addScopeToServers(config?.mcpServers, scope),
    errors,
  }
}

export function hasManagedMcpAuthority(
  authority: CanonicalSettingsAuthority,
): boolean {
  return authority.sources('managed').some(layer =>
    Object.prototype.hasOwnProperty.call(layer.config, 'mcp_servers')
  )
}

async function updateMcpServerInCanonicalConfig(
  authority: CanonicalSettingsAuthority,
  scope: WritableMcpConfigScope,
  name: string,
  config: McpServerConfig | undefined,
): Promise<void> {
  const path = getSettingsFilePathForSource(
    settingsSourceForMcpScope(scope),
    authority,
  )
  if (!path) throw new Error(`No canonical ${scope} config.toml target`)
  applyCanonicalConfigPatchSync(path, {
    mcp_servers: {
      [name]:
        config === undefined
          ? undefined
          : serviceMcpServerToCanonicalConfig(config),
    },
  }, scope)
  await authority.reload()
}

/**
 * Add a new MCP server configuration
 * @param name The name of the server
 * @param config The server configuration
 * @param scope The configuration scope
 * @throws Error if name is invalid or server already exists, or if the config is invalid
 */
export async function addMcpConfig(
  name: string,
  config: unknown,
  scope: ConfigScope,
  authority: CanonicalSettingsAuthority,
): Promise<void> {
  if (name.match(/[^a-zA-Z0-9_-]/)) {
    throw new Error(
      `Invalid name ${name}. Names can only contain letters, numbers, hyphens, and underscores.`,
    )
  }

  // Block reserved server name "agenc-in-chrome"
  if (isAgenCInChromeMCPServer(name)) {
    throw new Error(`Cannot add MCP server "${name}": this name is reserved.`)
  }

  // Explicit managed mcp_servers authority is exclusive, including an empty
  // table that intentionally disables every operator/project definition.
  if (hasManagedMcpAuthority(authority)) {
    throw new Error(
      `Cannot add MCP server: canonical managed config.toml has exclusive MCP authority`,
    )
  }
  // Validate config first (needed for command-based policy checks)
  const result = McpServerConfigSchema().safeParse(config)
  if (!result.success) {
    const formattedErrors = result.error.issues
      .map(err => `${err.path.join('.')}: ${err.message}`)
      .join(', ')
    throw new Error(`Invalid configuration: ${formattedErrors}`)
  }
  const validatedConfig = result.data

  // Check denylist (with config for command-based checks)
  if (isMcpServerDenied(authority, name, validatedConfig)) {
    throw new Error(
      `Cannot add MCP server "${name}": server is explicitly blocked by enterprise policy`,
    )
  }

  // Check allowlist (with config for command-based checks)
  if (!isMcpServerAllowedByPolicy(authority, name, validatedConfig)) {
    throw new Error(
      `Cannot add MCP server "${name}": not allowed by enterprise policy`,
    )
  }

  switch (scope) {
    case 'project':
    case 'user':
    case 'local': {
      const { servers } = getMcpConfigsByScope(scope, authority)
      if (servers[name]) {
        throw new Error(
          `MCP server ${name} already exists in ${scope} config.toml`,
        )
      }
      break
    }
    case 'dynamic':
      throw new Error('Cannot add MCP server to scope: dynamic')
    case 'enterprise':
      throw new Error('Cannot add MCP server to scope: enterprise')
    case 'agencai':
      throw new Error('Cannot add MCP server to scope: agencai')
  }

  switch (scope) {
    case 'project':
    case 'user':
    case 'local': {
      await updateMcpServerInCanonicalConfig(
        authority,
        scope,
        name,
        validatedConfig,
      )
      break
    }

    default:
      throw new Error(`Cannot add MCP server to scope: ${scope}`)
  }
}

/**
 * Remove an MCP server configuration
 * @param name The name of the server to remove
 * @param scope The configuration scope
 * @throws Error if server not found in specified scope
 */
export async function removeMcpConfig(
  name: string,
  scope: ConfigScope,
  authority: CanonicalSettingsAuthority,
): Promise<void> {
  switch (scope) {
    case 'project':
    case 'user':
    case 'local': {
      const { servers } = getMcpConfigsByScope(scope, authority)
      if (!servers[name]) {
        throw new Error(
          `No ${scope}-scoped MCP server found with name: ${name}`,
        )
      }
      await updateMcpServerInCanonicalConfig(authority, scope, name, undefined)
      break
    }

    default:
      throw new Error(`Cannot remove MCP server from scope: ${scope}`)
  }
}

/**
 * Get all MCP configurations from a specific scope
 * @param scope The configuration scope
 * @returns Servers with scope information and any validation errors
 */
export function getMcpConfigsByScope(
  scope: 'project' | 'user' | 'local' | 'enterprise',
  authority: CanonicalSettingsAuthority,
  environment: Readonly<Record<string, string | undefined>> = {},
): {
  servers: Record<string, ScopedMcpServerConfig>
  errors: ValidationError[]
} {
  return canonicalMcpConfigsByScope(authority, scope, environment)
}

/**
 * Get an MCP server configuration by name
 * @param name The name of the server
 * @returns The server configuration with scope, or undefined if not found
 */
export function getMcpConfigByName(
  name: string,
  authority: CanonicalSettingsAuthority,
  environment: Readonly<Record<string, string | undefined>> = {},
): ScopedMcpServerConfig | null {
  const { servers: enterpriseServers } = getMcpConfigsByScope(
    'enterprise',
    authority,
    environment,
  )

  if (hasManagedMcpAuthority(authority)) {
    return enterpriseServers[name] ?? null
  }

  // When MCP is locked to plugin-only, only enterprise servers are reachable
  // by name. User/project/local servers are blocked — same as getAgenCCodeMcpConfigs().
  if (isRestrictedToPluginOnly('mcp', authority)) {
    return enterpriseServers[name] ?? null
  }

  const { servers: userServers } = getMcpConfigsByScope(
    'user',
    authority,
    environment,
  )
  const { servers: projectServers } = getMcpConfigsByScope(
    'project',
    authority,
    environment,
  )
  const { servers: localServers } = getMcpConfigsByScope(
    'local',
    authority,
    environment,
  )

  if (enterpriseServers[name]) {
    return enterpriseServers[name]
  }
  if (localServers[name]) {
    return localServers[name]
  }
  if (projectServers[name]) {
    return projectServers[name]
  }
  if (userServers[name]) {
    return userServers[name]
  }

  return null
}

/**
 * Execution-safe named lookup. Canonical project TOML content is returned only
 * after exact config-digest approval, and every scope is rechecked against the
 * effective MCP allow/deny policy. An unapproved project entry never shadows a
 * trusted local or user entry with the same name.
 */
export function getApprovedMcpConfigByName(
  name: string,
  authority: CanonicalSettingsAuthority,
  environment: Readonly<Record<string, string | undefined>> = {},
): ScopedMcpServerConfig | null {
  const { servers: enterpriseServers } = getMcpConfigsByScope(
    'enterprise',
    authority,
    environment,
  )
  const candidates: ScopedMcpServerConfig[] = []
  if (enterpriseServers[name]) candidates.push(enterpriseServers[name])

  if (hasManagedMcpAuthority(authority)) {
    const managed = enterpriseServers[name]
    return managed !== undefined &&
        filterMcpServersByPolicy(authority, { [name]: managed }).allowed[name]
      ? managed
      : null
  }

  if (!isRestrictedToPluginOnly('mcp', authority)) {
    const { servers: localServers } = getMcpConfigsByScope(
      'local',
      authority,
      environment,
    )
    const { servers: projectServers } = getMcpConfigsByScope(
      'project',
      authority,
      environment,
    )
    const { servers: userServers } = getMcpConfigsByScope(
      'user',
      authority,
      environment,
    )
    if (localServers[name]) candidates.push(localServers[name])
    const project = projectServers[name]
    if (
      project &&
      getProjectMcpServerStatus(authority, name, project) === 'approved'
    ) {
      candidates.push(project)
    }
    if (userServers[name]) candidates.push(userServers[name])
  }

  for (const candidate of candidates) {
    if (filterMcpServersByPolicy(authority, { [name]: candidate }).allowed[name]) {
      return candidate
    }
  }
  return null
}

/**
 * Get AgenC MCP configurations (excludes agenc.tech servers from the
 * returned set — they're fetched separately and merged by callers).
 * This is fast: only local file reads; no awaited network calls on the
 * critical path. The optional extraDedupTargets promise (e.g. the in-flight
 * agenc.tech connector fetch) is awaited only after canonical plugin
 * registration completes, so the two overlap rather than serialize.
 * @returns AgenC server configurations with appropriate scopes
 */
export async function getAgenCCodeMcpConfigs(
  authority: CanonicalSettingsAuthority,
  dynamicServers: Record<string, ScopedMcpServerConfig> = {},
  extraDedupTargets: Promise<
    Record<string, ScopedMcpServerConfig>
  > = Promise.resolve({}),
  environment: Readonly<Record<string, string | undefined>> = {},
): Promise<{
  servers: Record<string, ScopedMcpServerConfig>
  errors: PluginError[]
}> {
  const { servers: enterpriseServers } = getMcpConfigsByScope(
    'enterprise',
    authority,
    environment,
  )

  // If an enterprise mcp config exists, do not use any others; this has exclusive control over all MCP servers
  // (enterprise customers often do not want their users to be able to add their own MCP servers).
  if (hasManagedMcpAuthority(authority)) {
    // Apply policy filtering to enterprise servers
    const filtered: Record<string, ScopedMcpServerConfig> = {}

    for (const [name, serverConfig] of Object.entries(enterpriseServers)) {
      if (!isMcpServerAllowedByPolicy(authority, name, serverConfig)) {
        continue
      }
      filtered[name] = serverConfig
    }

    return { servers: filtered, errors: [] }
  }

  // Load other scopes — unless the managed policy locks MCP to plugin-only.
  // Unlike the enterprise-exclusive block above, this keeps plugin servers.
  const mcpLocked = isRestrictedToPluginOnly('mcp', authority)
  const noServers: { servers: Record<string, ScopedMcpServerConfig> } = {
    servers: {},
  }
  const { servers: userServers } = mcpLocked
    ? noServers
    : getMcpConfigsByScope('user', authority, environment)
  const { servers: projectServers } = mcpLocked
    ? noServers
    : getMcpConfigsByScope('project', authority, environment)
  const { servers: localServers } = mcpLocked
    ? noServers
    : getMcpConfigsByScope('local', authority, environment)

  // Load plugin MCP servers
  const pluginMcpServers: Record<string, ScopedMcpServerConfig> = {}

  const registrationIssues: PluginLoadIssue[] = []
  const registrations = await loadPluginMcpServerRegistrations({
    agencHome: authority.homeContext.path,
    workspaceRoot: authority.projectRoot,
    config: authority.current(),
    env: { ...environment },
    errors: registrationIssues,
  })
  const mcpErrors: PluginError[] = registrationIssues.map(issue => ({
    type: 'generic-error',
    source: issue.source,
    ...(issue.plugin !== undefined ? { plugin: issue.plugin } : {}),
    error: issue.message,
  }))
  for (const issue of registrationIssues) {
    logError(new Error(`Plugin MCP server error: ${issue.message}`))
  }
  for (const registration of registrations) {
    pluginMcpServers[registration.name] = {
      ...canonicalMcpServerToServiceConfig(registration.server),
      scope: 'dynamic',
      pluginSource: registration.pluginSource,
      pluginServer: {
        pluginName: registration.pluginName,
        serverName: registration.serverName,
      },
    }
  }

  // Filter project servers to only include approved ones
  const approvedProjectServers: Record<string, ScopedMcpServerConfig> = {}
  for (const [name, config] of Object.entries(projectServers)) {
    if (getProjectMcpServerStatus(authority, name, config) === 'approved') {
      approvedProjectServers[name] = config
    }
  }

  // Dedup plugin servers against manually-configured ones (and each other).
  // Plugin server keys use normalized plugin-scoped identifiers so they never
  // collide with manual keys in the merge below — this content-based filter
  // catches the case where both would launch the same underlying connection.
  // Only servers that will actually connect are valid dedup targets — a
  // disabled manual server mustn't suppress a plugin server, or neither runs
  // (manual is skipped by name at connection time; plugin was removed here).
  const extraTargets = await extraDedupTargets
  const enabledManualServers: Record<string, ScopedMcpServerConfig> = {}
  for (const [name, config] of Object.entries({
    ...userServers,
    ...approvedProjectServers,
    ...localServers,
    ...dynamicServers,
    ...extraTargets,
  })) {
    if (
      !isMcpServerDisabled(name, config) &&
      isMcpServerAllowedByPolicy(authority, name, config)
    ) {
      enabledManualServers[name] = config
    }
  }
  // Split off disabled/policy-blocked plugin servers so they don't win the
  // first-plugin-wins race against an enabled duplicate — same invariant as
  // above. They're merged back after dedup so they still appear in /mcp
  // (policy filtering at the end of this function drops blocked ones).
  const enabledPluginServers: Record<string, ScopedMcpServerConfig> = {}
  const disabledPluginServers: Record<string, ScopedMcpServerConfig> = {}
  for (const [name, config] of Object.entries(pluginMcpServers)) {
    if (
      isMcpServerDisabled(name, config) ||
      !isMcpServerAllowedByPolicy(authority, name, config)
    ) {
      disabledPluginServers[name] = config
    } else {
      enabledPluginServers[name] = config
    }
  }
  const { servers: dedupedPluginServers, suppressed } = dedupPluginMcpServers(
    enabledPluginServers,
    enabledManualServers,
  )
  Object.assign(dedupedPluginServers, disabledPluginServers)
  // Surface suppressions in /plugin UI. Pushed AFTER the logError loop above
  // so these don't go to the error log — they're informational, not errors.
  for (const suppression of suppressed) {
    const error = pluginMcpDuplicateSuppressionError(suppression)
    if (error !== null) mcpErrors.push(error)
  }

  // Merge in order of precedence: plugin < user < project < local
  const configs = Object.assign(
    {},
    dedupedPluginServers,
    userServers,
    approvedProjectServers,
    localServers,
  )

  // Apply policy filtering to merged configs
  const filtered: Record<string, ScopedMcpServerConfig> = {}

  for (const [name, serverConfig] of Object.entries(configs)) {
    if (
      !isMcpServerAllowedByPolicy(
        authority,
        name,
        serverConfig as unknown as McpServerConfig,
      )
    ) {
      continue
    }
    filtered[name] = serverConfig as unknown as ScopedMcpServerConfig
  }

  return { servers: filtered, errors: mcpErrors }
}

/**
 * Get all MCP configurations across all scopes, including agenc.tech servers.
 * This may be slow due to network calls - use getAgenCCodeMcpConfigs() for fast startup.
 * @returns All server configurations with appropriate scopes
 */
export async function getAllMcpConfigs(
  authority: CanonicalSettingsAuthority,
  environment: Readonly<Record<string, string | undefined>> = {},
): Promise<{
  servers: Record<string, ScopedMcpServerConfig>
  errors: PluginError[]
}> {
  // In enterprise mode, don't load agenc.tech servers (enterprise has exclusive control)
  if (hasManagedMcpAuthority(authority)) {
    return getAgenCCodeMcpConfigs(authority, {}, Promise.resolve({}), environment)
  }

  // Donor remote-MCP fetch was removed in the upstream-backend purge.
  // Until AgenC ships its own MCP discovery service, fall through to
  // the local-only MCP config path.
  const agencaiPromise: Promise<Record<string, ScopedMcpServerConfig>> =
    Promise.resolve({})
  return getAgenCCodeMcpConfigs(authority, {}, agencaiPromise, environment)
}

/**
 * Parse and validate an MCP configuration object
 * @param params Parsing parameters
 * @returns Validated configuration with any errors
 */
export function parseMcpConfig(params: {
  configObject: unknown
  expandVars: boolean
  environment?: Readonly<Record<string, string | undefined>>
  scope: ConfigScope
  filePath?: string
}): {
  config: McpJsonConfig | null
  errors: ValidationError[]
} {
  const {
    configObject,
    expandVars,
    environment = {},
    scope,
    filePath,
  } = params
  const schemaResult = McpJsonConfigSchema().safeParse(configObject)
  if (!schemaResult.success) {
    return {
      config: null,
      errors: schemaResult.error.issues.map(issue => ({
        ...(filePath && { file: filePath }),
        path: issue.path.join('.'),
        message: 'Does not adhere to MCP server configuration schema',
        mcpErrorMetadata: {
          scope,
          severity: 'fatal',
        },
      })),
    }
  }

  // Validate each server and expand variables if requested
  const errors: ValidationError[] = []
  const validatedServers: Record<string, McpServerConfig> = {}

  for (const [name, config] of Object.entries(schemaResult.data.mcpServers)) {
    let configToCheck = config

    if (expandVars) {
      const { expanded, missingVars } = expandEnvVars(config, environment)

      if (missingVars.length > 0) {
        errors.push({
          ...(filePath && { file: filePath }),
          path: `mcpServers.${name}`,
          message: `Missing environment variables: ${missingVars.join(', ')}`,
          suggestion: `Set the following environment variables: ${missingVars.join(', ')}`,
          mcpErrorMetadata: {
            scope,
            serverName: name,
            severity: 'warning',
          },
        })
      }

      configToCheck = expanded
    }

    // Check for Windows-specific npx usage without cmd wrapper
    if (
      getPlatform() === 'windows' &&
      (!configToCheck.type || configToCheck.type === 'stdio') &&
      (configToCheck.command === 'npx' ||
        configToCheck.command.endsWith('\\npx') ||
        configToCheck.command.endsWith('/npx'))
    ) {
      errors.push({
        ...(filePath && { file: filePath }),
        path: `mcpServers.${name}`,
        message: `Windows requires 'cmd /c' wrapper to execute npx`,
        suggestion: `Change command to "cmd" with args ["/c", "npx", ...]. See: https://agenc.tech/docs/en/mcp#configure-mcp-servers`,
        mcpErrorMetadata: {
          scope,
          serverName: name,
          severity: 'warning',
        },
      })
    }

    validatedServers[name] = configToCheck
  }
  return {
    config: { mcpServers: validatedServers },
    errors,
  }
}

/**
 * Check if MCP allowlist policy should only come from managed settings.
 * This is true when policySettings has allowManagedMcpServersOnly: true.
 * When enabled, allowedMcpServers is read exclusively from managed settings.
 * Users can still add their own MCP servers and deny servers via deniedMcpServers.
 */
export function shouldAllowManagedMcpServersOnly(
  authority: CanonicalSettingsAuthority,
): boolean {
  return (
    getSettingsForSource('policySettings', authority)
      ?.allowManagedMcpServersOnly === true
  )
}

/**
 * Check if all MCP servers in a config are allowed with enterprise MCP config.
 */
export function areMcpConfigsAllowedWithEnterpriseMcpConfig(
  configs: Record<string, ScopedMcpServerConfig>,
): boolean {
  // NOTE: While all SDK MCP servers should be safe from a security perspective, we are still discussing
  // what the best way to do this is. In the meantime, we are limiting this to agenc-vscode currently to
  // unbreak the VSCode extension for certain enterprise customers who have enterprise MCP config enabled.
  // https://anthropic.slack.com/archives/C093UA0KLD7/p1764975463670109
  return Object.values(configs).every(
    c => c.type === 'sdk' && c.name === 'agenc-vscode',
  )
}

/** Built-in MCP server that defaults to disabled unless its canonical
 * `mcp_servers.<name>.enabled` value is true. */
// Computer-use (Chicago) MCP server removed; no built-in is disabled by default.
const DEFAULT_DISABLED_BUILTIN: string | null = null

function isDefaultDisabledBuiltin(name: string): boolean {
  return DEFAULT_DISABLED_BUILTIN !== null && name === DEFAULT_DISABLED_BUILTIN
}

/**
 * Check if an MCP server is disabled
 * @param name The name of the server
 * @returns true if the server is disabled
 */
export function isMcpServerDisabled(
  name: string,
  config?: ScopedMcpServerConfig,
  authority?: CanonicalSettingsAuthority,
): boolean {
  if (config === undefined && authority === undefined) {
    throw new Error(
      'Canonical ConfigStore authority is required to resolve MCP server state',
    )
  }
  const resolved = config ?? getMcpConfigByName(name, authority!) ?? undefined
  const enabled = resolved && 'enabled' in resolved ? resolved.enabled : undefined
  if (isDefaultDisabledBuiltin(name) && enabled !== true) return true
  return enabled === false
}
