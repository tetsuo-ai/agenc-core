import { createHash } from 'node:crypto'
import { join } from 'path'
import { getProjectMcpServerApprovalStatusSync } from '../../permissions/trust/project-trust.js'
import type { CanonicalSettingsAuthority } from '../../utils/settings/canonicalAuthority.js'
import { validateMcpHeaders } from './headerValidation.js'
import { normalizeNameForMCP } from './normalization.js'
import {
  type ConfigScope,
  ConfigScopeSchema,
  type ScopedMcpServerConfig,
} from './types.js'

/**
 * Describe the file path for a given MCP config scope.
 * @param scope The config scope ('user', 'project', 'local', or 'dynamic')
 * @returns A description of where the config is stored
 */
export function describeMcpConfigFilePath(
  scope: ConfigScope,
  authority: CanonicalSettingsAuthority,
): string {
  switch (scope) {
    case 'user':
      return authority.homeContext.configTomlPath
    case 'project':
      return join(authority.projectRoot, '.agenc', 'config.toml')
    case 'local':
      return join(authority.projectRoot, '.agenc', 'config.local.toml')
    case 'dynamic':
      return 'Dynamically configured'
    case 'enterprise':
      return authority.sources('managed')
        .findLast(layer => layer.config.mcp_servers !== undefined)?.path ??
        'Canonical managed config.toml'
    case 'agencai':
      return 'agenc.tech'
    default:
      return scope
  }
}

export function getScopeLabel(scope: ConfigScope): string {
  switch (scope) {
    case 'local':
      return 'Local config (private to you in this project)'
    case 'project':
      return 'Project config (shared via .agenc/config.toml)'
    case 'user':
      return 'User config (available in all your projects)'
    case 'dynamic':
      return 'Dynamic config (from command line)'
    case 'enterprise':
      return 'Enterprise config (managed by your organization)'
    case 'agencai':
      return 'agenc.tech config'
    default:
      return scope
  }
}

export function ensureConfigScope(scope?: string): ConfigScope {
  if (!scope) return 'local'

  if (!ConfigScopeSchema().options.includes(scope as ConfigScope)) {
    throw new Error(
      `Invalid scope: ${scope}. Must be one of: ${ConfigScopeSchema().options.join(', ')}`,
    )
  }

  return scope as ConfigScope
}

export function ensureTransport(type?: string): 'stdio' | 'sse' | 'http' {
  if (!type) return 'stdio'

  if (type !== 'stdio' && type !== 'sse' && type !== 'http') {
    throw new Error(
      `Invalid transport type: ${type}. Must be one of: stdio, sse, http`,
    )
  }

  return type as 'stdio' | 'sse' | 'http'
}

export function parseHeaders(headerArray: string[]): Record<string, string> {
  const headers: Record<string, string> = {}

  for (const header of headerArray) {
    const colonIndex = header.indexOf(':')
    if (colonIndex === -1) {
      throw new Error(
        `Invalid header format: "${header}". Expected format: "Header-Name: value"`,
      )
    }

    const key = header.substring(0, colonIndex).trim()
    const value = header.substring(colonIndex + 1).trim()

    if (!key) {
      throw new Error(
        `Invalid header: "${header}". Header name cannot be empty.`,
      )
    }

    headers[key] = value
  }

  return validateMcpHeaders(headers, 'MCP CLI headers')
}

function canonicalApprovalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalApprovalValue)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalApprovalValue(child)]),
  )
}

export type McpServerDefinitionOrigin =
  | 'default'
  | 'managed'
  | 'user'
  | 'project'
  | 'local'
  | 'flag'
  | 'profile'
  | 'environment'
  | 'cli'
  | 'plugin'
  | 'session'

export function mcpServerDefinitionOrigin(
  config: ScopedMcpServerConfig,
): McpServerDefinitionOrigin {
  if (config.authoritySource !== undefined) return config.authoritySource
  if (config.scope === 'enterprise' || config.scope === 'managed') {
    return 'managed'
  }
  if (config.scope === 'dynamic' && config.pluginServer !== undefined) {
    return 'plugin'
  }
  if (config.scope === 'dynamic' || config.scope === 'agencai') {
    return 'session'
  }
  return config.scope
}

/**
 * Content identity for the exact policy-resolved definition behind a live
 * server. Values such as headers and environment entries are hashed and are
 * never returned or logged.
 */
export function mcpServerDefinitionId(
  name: string,
  config: ScopedMcpServerConfig,
): string {
  const {
    scope: _scope,
    authoritySource: _authoritySource,
    pluginSource,
    pluginServer,
    ...definition
  } = config
  const canonical = canonicalApprovalValue({
    name,
    origin: {
      scope: mcpServerDefinitionOrigin(config),
      pluginSource,
      pluginServer,
    },
    definition,
  })
  return createHash('sha256')
    .update('agenc:mcp-server-definition:v1\0')
    .update(JSON.stringify(canonical))
    .digest('hex')
}

/** Content-addressed identity for a parsed project MCP server definition. */
export function projectMcpServerApprovalDigest(
  config: ScopedMcpServerConfig,
): string {
  const { authoritySource: _authoritySource, ...approvalDefinition } = config
  return createHash('sha256')
    .update(JSON.stringify(canonicalApprovalValue(approvalDefinition)))
    .digest('hex')
}

export function getProjectMcpServerStatus(
  authority: CanonicalSettingsAuthority,
  serverName: string,
  config?: ScopedMcpServerConfig,
): 'approved' | 'rejected' | 'pending' {
  const normalizedName = normalizeNameForMCP(serverName)
  return getProjectMcpServerApprovalStatusSync(
    normalizedName,
    config === undefined ? undefined : projectMcpServerApprovalDigest(config),
    {
      agencHome: authority.homeContext.path,
      projectRoot: authority.projectRoot,
    },
  )
}
