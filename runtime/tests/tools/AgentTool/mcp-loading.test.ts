import { expect, test, vi } from 'vitest'

const state = vi.hoisted(() => ({ loads: 0 }))
vi.mock('../../../src/services/mcp/client.js', () => {
  state.loads++
  throw new Error('MCP connection layer must wait for an approved server')
})

test('loading the agent runner does not initialize the optional MCP connection layer', async () => {
  await import('../../../src/tools/AgentTool/runAgent.js')
  expect(state.loads).toBe(0)
})
