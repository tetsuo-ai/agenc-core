import { afterEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ require: vi.fn() }))
vi.mock('node:module', async importOriginal => ({
  ...await importOriginal<typeof import('node:module')>(),
  createRequire: () => state.require,
}))
afterEach(() => { vi.resetModules(); state.require.mockReset() })

describe('lazy synchronous execa loader', () => {
  it('does not load subprocess code until requested and returns it unchanged', async () => {
    const { loadExeca } = await import('../../src/utils/loadExeca.js')
    expect(state.require).not.toHaveBeenCalled()
    const implementation = { execaSync: vi.fn() }
    state.require.mockReturnValue(implementation)
    expect(loadExeca()).toBe(implementation)
    expect(state.require).toHaveBeenCalledWith('execa')
  })

  it('propagates a load failure and permits a subsequent retry', async () => {
    const { loadExeca } = await import('../../src/utils/loadExeca.js')
    const failure = new Error('execa unavailable')
    state.require.mockImplementationOnce(() => { throw failure })
    expect(loadExeca).toThrow(failure)
    const implementation = { execaSync: vi.fn() }
    state.require.mockReturnValue(implementation)
    expect(loadExeca()).toBe(implementation)
  })
})
