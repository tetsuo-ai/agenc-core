import { createHash } from 'node:crypto'
import { join } from 'path'
import { resolveAgencHome } from '../../config/env.js'
import { getCurrentProjectConfig } from '../../utils/config.js'
import { getCwd } from '../../utils/cwd.js'
import { getGlobalAgenCFile } from '../../utils/env.js'
import { getEnterpriseMcpFilePath } from './config.js'
import { validateMcpHeaders } from './headerValidation.js'
import { mcpInfoFromString } from './mcpStringUtils.js'
import { normalizeNameForMCP } from './normalization.js'
import {
  type ConfigScope,
  ConfigScopeSchema,
  type ScopedMcpServerConfig,
} from './types.js'

/**
 * Checks if a tool name belongs to a specific MCP server
 * @param toolName The tool name to check
 * @param serverName The server name to match against
 * @returns True if the tool belongs to the specified server
 */
export function isToolFromMcpServer(
  toolName: string,
  serverName: string,
): boolean {
  const info = mcpInfoFromString(toolName)
  return info?.serverName === serverName
}

/**
 * Describe the file path for a given MCP config scope.
 * @param scope The config scope ('user', 'project', 'local', or 'dynamic')
 * @returns A description of where the config is stored
 */
export function describeMcpConfigFilePath(scope: ConfigScope): string {
  switch (scope) {
    case 'user':
      return join(resolveAgencHome(process.env), 'config.toml')
    case 'project':
      return join(getCwd(), '.mcp.json')
    case 'local':
      return `${getGlobalAgenCFile()} [project: ${getCwd()}]`
    case 'dynamic':
      return 'Dynamically configured'
    case 'enterprise':
      return getEnterpriseMcpFilePath()
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
      return 'Project config (shared via .mcp.json)'
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

/** Content-addressed identity for a parsed project MCP server definition. */
export function projectMcpServerApprovalDigest(
  config: ScopedMcpServerConfig,
): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalApprovalValue(config)))
    .digest('hex')
}

export function getProjectMcpServerStatus(
  serverName: string,
  config?: ScopedMcpServerConfig,
): 'approved' | 'rejected' | 'pending' {
  // Approval state is stored outside the repository in the per-project global
  // config. Project/local settings and non-interactive mode are deliberately
  // not authority channels.
  const settings = getCurrentProjectConfig()
  const normalizedName = normalizeNameForMCP(serverName)

  // Follow-up: This fails an e2e test if the ?. is not present. This is likely a bug in the e2e test.
  // Will fix this in a follow-up PR.
  if (
    settings?.disabledMcpjsonServers?.some(
      name => normalizeNameForMCP(name) === normalizedName,
    )
  ) {
    return 'rejected'
  }

  if (config !== undefined) {
    const expected = settings.approvedMcpjsonServerDigests?.[normalizedName]
    if (
      typeof expected === 'string' &&
      expected === projectMcpServerApprovalDigest(config)
    ) {
      return 'approved'
    }
  }

  return 'pending'
}
