import { describe, expect, test } from 'vitest'

import type { LoadedPlugin } from '../../../src/types/plugin.js'
import {
  addPluginScopeToServers,
  loadPluginMcpServers,
} from '../../../src/utils/plugins/mcpPluginIntegration.js'

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

  test('config-only loading skips MCPB resolution entirely', async () => {
    const plugin = {
      name: 'remote-bundle',
      manifest: {
        name: 'remote-bundle',
        mcpServers: 'https://example.test/server.mcpb',
      },
      path: '/definitely-not-an-installed-plugin',
      source: 'remote-bundle@test',
      repository: 'remote-bundle@test',
      enabled: true,
    } as LoadedPlugin

    await expect(
      loadPluginMcpServers(plugin, [], { configOnly: true }),
    ).resolves.toBeUndefined()
  })
})
