import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SlashCommandContext } from '../../src/commands/types.js'

const loads = vi.hoisted(() => vi.fn())
beforeEach(() => {
  const unavailable = () => { loads(); throw new Error('plugin operation module unavailable') }
  vi.doMock('../../src/plugins/cli/pluginOperations.js', unavailable)
  vi.doMock('../../src/plugins/marketplace/marketplace.js', unavailable)
  vi.doMock('../../src/plugins/marketplace/catalog-cli.js', unavailable)
})
afterEach(() => {
  vi.doUnmock('../../src/plugins/cli/pluginOperations.js')
  vi.doUnmock('../../src/plugins/marketplace/marketplace.js')
  vi.doUnmock('../../src/plugins/marketplace/catalog-cli.js')
  vi.resetModules()
  loads.mockClear()
})

const options = {
  agencHome: '/tmp/lazy-plugin-home',
  pluginStorageRoot: '/tmp/lazy-plugin-store',
  workspaceRoot: '/tmp/lazy-plugin-workspace',
}

describe('lazy plugin management operations', () => {
  it('registers the command and creates menu actions without loading management code', async () => {
    const { pluginsCommand, createPluginMenuActions } = await import('../../src/commands/plugins.js')
    expect(createPluginMenuActions(options)).toHaveProperty('installFromMarketplace')
    const context = { session: { services: {} }, argsRaw: '', cwd: options.workspaceRoot, home: options.agencHome } as unknown as SlashCommandContext
    await expect(pluginsCommand.execute(context)).resolves.toEqual({
      kind: 'text', text: 'Plugin state is not available in this session.',
    })
    expect(loads).not.toHaveBeenCalled()
  })

  it.each(['setEnabled', 'uninstall', 'listMarketplaces', 'installFromMarketplace'] as const)(
    'rejects %s when the deferred dependency cannot load', async action => {
      const { createPluginMenuActions } = await import('../../src/commands/plugins.js')
      const actions = createPluginMenuActions(options)
      expect(loads).not.toHaveBeenCalled()
      const operation = action === 'setEnabled' ? actions.setEnabled('test', true)
        : action === 'uninstall' ? actions.uninstall('test')
        : action === 'listMarketplaces' ? actions.listMarketplaces()
        : actions.installFromMarketplace({} as Parameters<typeof actions.installFromMarketplace>[0], 'test')
      await expect(operation).rejects.toThrow()
      expect(loads).toHaveBeenCalled()
    },
  )

  it('retains workspace authority rejection before loading uninstall code', async () => {
    const { createPluginMenuActions } = await import('../../src/commands/plugins.js')
    const actions = createPluginMenuActions({ ...options, workspaceRoot: undefined })
    await expect(actions.uninstall('test')).rejects.toThrow('explicit workspace root')
    expect(loads).not.toHaveBeenCalled()
  })
})
