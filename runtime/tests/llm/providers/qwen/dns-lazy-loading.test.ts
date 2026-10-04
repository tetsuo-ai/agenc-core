import { afterEach, describe, expect, it, vi } from 'vitest'

const loads = vi.hoisted(() => vi.fn())
vi.mock('undici', () => { loads(); throw new Error('full Undici unavailable') })
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); loads.mockClear() })

describe('Qwen DNS fallback dependency loading', () => {
  it('uses the primary fetch without the full package and rejects a failed fallback import', async () => {
    const { createQwenOfficialDnsTransport } = await import('../../../../src/llm/providers/qwen/dns-transport.js')
    const primary = vi.fn().mockResolvedValueOnce(new Response('primary'))
      .mockRejectedValueOnce(Object.assign(new Error('DNS failed'), { code: 'ENOTFOUND' }))
    vi.stubGlobal('fetch', primary)
    const transport = createQwenOfficialDnsTransport('https://dashscope.aliyuncs.com/v1', 'dashscope.aliyuncs.com')!
    try {
      expect(await (await transport.fetchImpl('https://dashscope.aliyuncs.com/v1')).text()).toBe('primary')
      expect(loads).not.toHaveBeenCalled()
      await expect(transport.fetchImpl('https://dashscope.aliyuncs.com/v1')).rejects.toThrow()
      expect(loads).toHaveBeenCalledOnce()
      expect(primary).toHaveBeenCalledTimes(2)
    } finally { await transport.dispose() }
  })
})
