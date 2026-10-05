import { expect, test, vi } from 'vitest'

const state = vi.hoisted(() => ({ loads: vi.fn() }))
vi.mock('../../../src/tools/MCPTool/MCPTool.js', () => {
  state.loads()
  throw new Error('tool definition unavailable')
})

test('keeps client helpers available and returns no partial catalog when the deferred definition fails', async () => {
  const { fetchToolsForClient } = await import('../../../src/services/mcp/client.js')
  expect(state.loads).not.toHaveBeenCalled()
  const server = {
    type: 'connected', name: 'unavailable-definition',
    config: { type: 'stdio', command: 'unused', scope: 'local' },
    capabilities: { tools: {} },
    client: { request: vi.fn(async () => ({ tools: [{ name: 'echo', inputSchema: { type: 'object' } }] })) },
  }
  await expect(fetchToolsForClient(server as never)).resolves.toEqual([])
  expect(state.loads).toHaveBeenCalledOnce()
  expect(server.client.request).toHaveBeenCalledOnce()
  await expect(fetchToolsForClient({ ...server, name: 'empty', client: {
    request: vi.fn(async () => ({ tools: [] })),
  } } as never)).resolves.toEqual([])
  expect(state.loads).toHaveBeenCalledOnce()
  fetchToolsForClient.cache.clear()
})
