import { describe, expect, test } from 'vitest'

import { addPluginScopeToServers } from '../../../src/utils/plugins/mcpPluginIntegration.js'

describe('addPluginScopeToServers', () => {
  test('normalizes active runtime plugin MCP scoped server names', () => {
    const scoped = addPluginScopeToServers(
      {
        '123/../Escape Server!': { command: 'node' },
        'admin:Local Server': { command: 'node' },
      },
      'sample',
      'sample@official',
    )

    expect(Object.keys(scoped).sort()).toEqual([
      'plugin:sample:admin:local_server',
      'plugin:sample:cmd_123_escape_server',
    ])
    expect(scoped['plugin:sample:cmd_123_escape_server']).toMatchObject({
      command: 'node',
      scope: 'dynamic',
      pluginSource: 'sample@official',
    })
  })
})
