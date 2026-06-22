import { describe, expect, test } from 'vitest'

import type { MCPServerConnection } from '../../src/services/mcp/types.js'
import {
  availableMcpServerNames,
  findMcpResourceServer,
  mcpResourceServerLookupErrorMessage,
  mcpServerNotFoundMessage,
} from '../../src/utils/mcpServerLookup.js'

function mcpClient(
  name: string,
  options: {
    readonly type?: MCPServerConnection['type']
    readonly resources?: boolean
  } = {},
): MCPServerConnection {
  const type = options.type ?? 'connected'
  if (type === 'connected') {
    return {
      name,
      type,
      capabilities: options.resources === false ? {} : { resources: {} },
      client: { request: async () => ({}) },
      config: { type: 'sdk' },
      cleanup: async () => {},
    } as unknown as MCPServerConnection
  }
  return {
    name,
    type,
    config: { type: 'sdk' },
  } as unknown as MCPServerConnection
}

describe('mcp server lookup helpers', () => {
  test('formats available server names in input order', () => {
    const clients = [mcpClient('alpha'), mcpClient('beta')]

    expect(availableMcpServerNames(clients)).toBe('alpha, beta')
    expect(mcpServerNotFoundMessage('missing', clients)).toBe(
      'Server "missing" not found. Available servers: alpha, beta',
    )
  })

  test('resolves connected servers that advertise resources', () => {
    const client = mcpClient('docs')
    const result = findMcpResourceServer([client], 'docs')

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.client.name).toBe('docs')
    }
  })

  test.each([
    [
      'not found',
      [],
      'missing',
      'not_found',
      'Server "missing" not found. Available servers: ',
    ],
    [
      'not connected',
      [mcpClient('docs', { type: 'failed' })],
      'docs',
      'not_connected',
      'Server "docs" is not connected',
    ],
    [
      'resources unsupported',
      [mcpClient('docs', { resources: false })],
      'docs',
      'resources_unsupported',
      'Server "docs" does not support resources',
    ],
  ] as const)(
    'reports %s lookup failures',
    (_label, clients, serverName, reason, expectedMessage) => {
      const result = findMcpResourceServer(clients, serverName)

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.reason).toBe(reason)
        expect(mcpResourceServerLookupErrorMessage(result)).toBe(
          expectedMessage,
        )
      }
    },
  )
})
