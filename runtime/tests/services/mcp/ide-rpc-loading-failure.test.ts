import { expect, test, vi } from 'vitest'

const state = vi.hoisted(() => ({ loads: 0 }))
vi.mock('../../../src/services/mcp/client.js', () => {
  state.loads++
  throw new Error('MCP module unavailable')
})

test('a failed deferred MCP load rejects RPC while optional IDE cleanup keeps its original catch', async () => {
  const { callIdeRpc } = await import('../../../src/services/mcp/ideRpc.js')
  const { closeOpenDiffs } = await import('../../../src/utils/ide.js')
  expect(state.loads).toBe(0)
  await expect(callIdeRpc('openFile', {}, {} as never)).rejects.toThrow()
  expect(state.loads).toBe(1)
  await expect(closeOpenDiffs({} as never)).resolves.toBeUndefined()
})
