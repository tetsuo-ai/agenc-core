import { expect, test, vi } from 'vitest'
import type { ConnectedMCPServer } from '../../../src/services/mcp/types.js'

const state = vi.hoisted(() => ({ loads: 0 }))
vi.mock('../../../src/tools/MCPTool/MCPTool.js', async importOriginal => {
  state.loads++
  return importOriginal()
})

function connected(name: string, tools: unknown[]): ConnectedMCPServer {
  return {
    type: 'connected', name,
    config: { type: 'stdio', command: 'unused', scope: 'local' },
    capabilities: { tools: {} },
    client: { request: vi.fn(async () => ({ tools })) },
    cleanup: vi.fn(async () => {}),
  } as unknown as ConnectedMCPServer
}

test('loads the original tool and its renderers only for a nonempty connected catalog', async () => {
  const { fetchToolsForClient } = await import('../../../src/services/mcp/client.js')
  expect(state.loads).toBe(0)
  await expect(fetchToolsForClient({ type: 'failed', name: 'offline' } as never)).resolves.toEqual([])
  const noCapability = { ...connected('no-capability', []), capabilities: {} }
  await expect(fetchToolsForClient(noCapability)).resolves.toEqual([])
  expect(noCapability.client.request).not.toHaveBeenCalled()
  const empty = connected('empty', [])
  await expect(fetchToolsForClient(empty)).resolves.toEqual([])
  expect(empty.client.request).toHaveBeenCalledOnce()
  expect(state.loads).toBe(0)

  const server = connected('catalog', [{
    name: 'echo', description: 'Echo a value',
    inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
  }])
  const [tool] = await fetchToolsForClient(server)
  expect(state.loads).toBe(1)
  const { MCPTool } = await import('../../../src/tools/MCPTool/MCPTool.js')
  expect(tool?.name).toBe('mcp__catalog__echo')
  expect(tool?.mcpInfo).toEqual({ serverName: 'catalog', toolName: 'echo' })
  for (const key of ['validateInput', 'renderToolUseMessage', 'renderToolUseProgressMessage',
    'renderToolResultMessage', 'mapToolResultToToolResultBlockParam', 'isResultTruncated'] as const) {
    expect(tool?.[key]).toBe(MCPTool[key])
  }
  expect((await tool!.validateInput!({ value: 'ok' }, {} as never)).result).toBe(true)
  expect((await tool!.validateInput!({}, {} as never)).result).toBe(false)
  expect(await tool!.checkPermissions({}, {} as never)).toMatchObject({ behavior: 'passthrough' })
  const cached = await fetchToolsForClient(server)
  expect(cached[0]).toBe(tool)
  expect(server.client.request).toHaveBeenCalledOnce()
  expect(state.loads).toBe(1)
  fetchToolsForClient.cache.clear()
})
