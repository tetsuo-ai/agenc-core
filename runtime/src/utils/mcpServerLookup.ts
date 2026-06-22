import type {
  ConnectedMCPServer,
  MCPServerConnection,
} from '../services/mcp/types.js'

export type McpResourceServerLookupResult =
  | {
      readonly ok: true
      readonly client: ConnectedMCPServer
    }
  | {
      readonly ok: false
      readonly reason:
        | 'not_found'
        | 'not_connected'
        | 'resources_unsupported'
      readonly serverName: string
      readonly availableServers: string
    }

export function availableMcpServerNames(
  clients: readonly MCPServerConnection[],
): string {
  return clients.map(client => client.name).join(', ')
}

export function mcpServerNotFoundMessage(
  serverName: string,
  clients: readonly MCPServerConnection[],
): string {
  return `Server "${serverName}" not found. Available servers: ${availableMcpServerNames(clients)}`
}

export function findMcpServerByName(
  clients: readonly MCPServerConnection[],
  serverName: string,
): MCPServerConnection | null {
  return clients.find(client => client.name === serverName) ?? null
}

export function findMcpResourceServer(
  clients: readonly MCPServerConnection[],
  serverName: string,
): McpResourceServerLookupResult {
  const client = findMcpServerByName(clients, serverName)
  if (client === null) {
    return {
      ok: false,
      reason: 'not_found',
      serverName,
      availableServers: availableMcpServerNames(clients),
    }
  }
  if (client.type !== 'connected') {
    return {
      ok: false,
      reason: 'not_connected',
      serverName,
      availableServers: availableMcpServerNames(clients),
    }
  }
  if (!client.capabilities?.resources) {
    return {
      ok: false,
      reason: 'resources_unsupported',
      serverName,
      availableServers: availableMcpServerNames(clients),
    }
  }
  return { ok: true, client }
}

export function mcpResourceServerLookupErrorMessage(
  result: Exclude<McpResourceServerLookupResult, { readonly ok: true }>,
): string {
  switch (result.reason) {
    case 'not_found':
      return `Server "${result.serverName}" not found. Available servers: ${result.availableServers}`
    case 'not_connected':
      return `Server "${result.serverName}" is not connected`
    case 'resources_unsupported':
      return `Server "${result.serverName}" does not support resources`
  }
}
