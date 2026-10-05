import { expect, test, vi } from 'vitest'

const state = vi.hoisted(() => ({ loads: 0, fail: false, override: vi.fn((_name: string) => ({ userFacingName: () => 'chrome override' })) }))
vi.mock('../../../src/utils/agencInChrome/toolRendering.js', () => {
  state.loads++
  return { getAgenCInChromeMCPToolOverrides: (name: string) => {
    if (state.fail) throw new Error('renderer override unavailable')
    return state.override(name)
  } }
})

test('loads Chrome rendering only for nonempty local Chrome catalogs and preserves overrides', async () => {
  const { fetchToolsForClient } = await import('../../../src/services/mcp/client.js')
  const catalog = [{ name: 'read_page', inputSchema: { type: 'object' } }]
  const server = (name: string, type: string | undefined, tools: unknown[] = catalog) => ({
    type: 'connected', name, capabilities: { tools: {} },
    config: { type, command: 'unused', scope: 'local' },
    client: { request: vi.fn(async () => ({ tools })) },
  })
  expect(state.loads).toBe(0)
  await fetchToolsForClient(server('ordinary', 'stdio') as never)
  await fetchToolsForClient(server('agenc-in-chrome', 'http') as never)
  await fetchToolsForClient(server('agenc-in-chrome', 'stdio', []) as never)
  expect(state.loads).toBe(0)
  fetchToolsForClient.cache.clear()
  const [tool] = await fetchToolsForClient(server('agenc-in-chrome', 'stdio') as never)
  expect(state.loads).toBe(1)
  expect(state.override).toHaveBeenCalledWith('read_page')
  expect(tool?.userFacingName?.()).toBe('chrome override')
  fetchToolsForClient.cache.clear()
  const [legacy] = await fetchToolsForClient(server('agenc-in-chrome', undefined) as never)
  expect(legacy?.userFacingName?.()).toBe('chrome override')
  expect(state.loads).toBe(1)
  state.fail = true
  fetchToolsForClient.cache.clear()
  await expect(fetchToolsForClient(server('agenc-in-chrome', 'stdio') as never)).resolves.toEqual([])
  fetchToolsForClient.cache.clear()
})
