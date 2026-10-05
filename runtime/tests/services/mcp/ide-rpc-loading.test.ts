import { expect, test, vi } from 'vitest'

const state = vi.hoisted(() => ({
  loads: 0,
  call: vi.fn(async (_tool: string, _args: unknown, _client: unknown) => 'ok' as unknown),
}))
vi.mock('../../../src/services/mcp/client.js', () => {
  state.loads++
  return { callIdeRpcWithLoadedClient: state.call }
})

test('IDE and diagnostic helpers keep MCP deferred and forward the original RPC contract', async () => {
  const { callIdeRpc } = await import('../../../src/services/mcp/ideRpc.js')
  const ide = await import('../../../src/utils/ide.js')
  const { DiagnosticTrackingService } = await import('../../../src/services/diagnosticTracking.js')
  expect(ide.callIdeRpc).toBe(callIdeRpc)
  const service = DiagnosticTrackingService.getInstance()
  await service.shutdown()
  service.initialize()
  expect(await service.getNewDiagnosticsCompat()).toEqual([])
  expect(state.loads).toBe(0)
  const client = { type: 'connected', name: 'ide' } as never
  const args = { filePath: '/tmp/project/example.ts' }
  expect(await callIdeRpc('openFile', args, client)).toBe('ok')
  expect(state.loads).toBe(1)
  expect(state.call).toHaveBeenCalledWith('openFile', args, client)
  expect(state.call.mock.calls[0]![1]).toBe(args)
  expect(state.call.mock.calls[0]![2]).toBe(client)
  const result = [{ type: 'text', text: 'diagnostics' }]
  state.call.mockResolvedValueOnce(result)
  expect(await callIdeRpc('getDiagnostics', {}, client)).toBe(result)
  const error = new Error('RPC failed')
  state.call.mockRejectedValueOnce(error)
  await expect(callIdeRpc('openFile', args, client)).rejects.toBe(error)
  state.call.mockRejectedValueOnce(error)
  await expect(ide.closeOpenDiffs(client)).resolves.toBeUndefined()
  await service.shutdown()
})
