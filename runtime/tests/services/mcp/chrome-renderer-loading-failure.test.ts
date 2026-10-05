import { expect, test, vi } from 'vitest'

const state = vi.hoisted(() => ({ loads: 0 }))
vi.mock('../../../src/utils/agencInChrome/toolRendering.js', () => {
  state.loads++
  throw new Error('Chrome renderer import unavailable')
})

test('keeps ordinary catalogs usable and handles a Chrome renderer import failure in discovery', async () => {
  const { fetchToolsForClient } = await import('../../../src/services/mcp/client.js')
  const client = {
    type: 'connected', name: 'ordinary', capabilities: { tools: {} },
    config: { type: 'stdio', command: 'unused', scope: 'local' },
    client: { request: vi.fn(async () => ({ tools: [{ name: 'echo', inputSchema: { type: 'object' } }] })) },
  }
  expect(await fetchToolsForClient(client as never)).toHaveLength(1)
  expect(state.loads).toBe(0)
  await expect(fetchToolsForClient({ ...client, name: 'agenc-in-chrome' } as never)).resolves.toEqual([])
  expect(state.loads).toBe(1)
  fetchToolsForClient.cache.clear()
})
