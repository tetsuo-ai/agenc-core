import { afterEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ load: vi.fn() }))
vi.mock('../../src/llm/undici-dispatcher.js', () => ({
  loadUndiciAgent: state.load,
  loadUndiciEnvHttpProxyAgent: state.load,
  getUndiciGlobalDispatcher: state.load,
}))
afterEach(() => { vi.resetModules(); state.load.mockReset() })

describe('dispatcher load failures', () => {
  it.each([{}, { HTTPS_PROXY: 'http://proxy.example:8080' }])('rejects instead of using a process-global fallback: %j', async environment => {
    const { getProxyFetchOptions } = await import('../../src/utils/proxy.js')
    expect(state.load).not.toHaveBeenCalled()
    const failure = new Error('dispatcher unavailable')
    state.load.mockImplementation(() => { throw failure })
    expect(() => getProxyFetchOptions({ environment })).toThrow(failure)
    expect(state.load).toHaveBeenCalledOnce()
  })

  it('does not replace a failed concurrent-stream dispatcher with a plain fetch', async () => {
    const { concurrentChatFetch } = await import('../../src/llm/providers/concurrent-chat-fetch.js')
    expect(state.load).not.toHaveBeenCalled()
    const failure = new Error('dispatcher unavailable')
    state.load.mockImplementation(() => { throw failure })
    expect(concurrentChatFetch).toThrow(failure)
  })
})
