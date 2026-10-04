import { afterEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ load: vi.fn() }))
vi.mock('../../src/utils/sandbox/loadSandboxManager.js', () => ({
  loadSandboxManager: state.load,
}))

afterEach(() => { vi.resetModules(); state.load.mockReset() })

describe('deferred sandbox manager facade', () => {
  it('loads the facade and leaf exports without requiring the manager', async () => {
    state.load.mockImplementation(() => { throw new Error('manager unavailable') })
    const adapter = await import('../../src/utils/sandbox/sandbox-runtime.js')
    expect(state.load).not.toHaveBeenCalled()
    expect(adapter.SandboxRuntimeConfigSchema).toBeDefined()
    expect(new adapter.SandboxViolationStore()).toBeInstanceOf(adapter.SandboxViolationStore)
    expect(Object.keys(adapter.SandboxManager)).toContain('getFsReadConfig')
    expect(state.load).not.toHaveBeenCalled()
  })

  it('preserves forwarded function identity and writable fields after first access', async () => {
    const original = vi.fn(() => ({ denyOnly: ['/private'], allowWithinDeny: [] }))
    state.load.mockReturnValue({ getFsReadConfig: original })
    const { SandboxManager } = await import('../../src/utils/sandbox/sandbox-runtime.js')
    expect(state.load).not.toHaveBeenCalled()
    expect(SandboxManager.getFsReadConfig).toBe(original)
    expect(SandboxManager.getFsReadConfig()).toEqual({ denyOnly: ['/private'], allowWithinDeny: [] })
    expect(state.load).toHaveBeenCalledTimes(1)
    expect(Object.getOwnPropertyDescriptor(SandboxManager, 'getFsReadConfig')).toEqual({
      value: original, writable: true, enumerable: true, configurable: true,
    })
    const replacement = vi.fn(() => ({ denyOnly: [], allowWithinDeny: [] }))
    SandboxManager.getFsReadConfig = replacement
    expect(SandboxManager.getFsReadConfig).toBe(replacement)
  })

  it('allows replacing a forwarded method before loading the manager', async () => {
    state.load.mockImplementation(() => { throw new Error('manager unavailable') })
    const { SandboxManager } = await import('../../src/utils/sandbox/sandbox-runtime.js')
    const replacement = vi.fn(() => ({ denyOnly: [], allowWithinDeny: [] }))
    SandboxManager.getFsReadConfig = replacement
    expect(SandboxManager.getFsReadConfig).toBe(replacement)
    expect(state.load).not.toHaveBeenCalled()
  })

  it('propagates deferred failures instead of treating sandboxing as disabled', async () => {
    const failure = new Error('sandbox manager load failed')
    state.load.mockImplementation(() => { throw failure })
    const { SandboxManager } = await import('../../src/utils/sandbox/sandbox-runtime.js')
    expect(() => SandboxManager.isSupportedPlatform()).toThrow(failure)
    expect(() => SandboxManager.isSandboxingEnabled()).toThrow(failure)
    expect(() => SandboxManager.getFsReadConfig).toThrow(failure)
  })

  it('retains first-use platform results and keeps failed property resolution retryable', async () => {
    state.load.mockImplementationOnce(() => { throw new Error('temporary load failure') })
    const { SandboxManager } = await import('../../src/utils/sandbox/sandbox-runtime.js')
    expect(() => SandboxManager.getFsReadConfig).toThrow('temporary load failure')
    const original = vi.fn(() => ({ denyOnly: [], allowWithinDeny: [] }))
    const platform = vi.fn(() => false)
    state.load.mockReturnValue({ getFsReadConfig: original, isSupportedPlatform: platform })
    expect(SandboxManager.getFsReadConfig).toBe(original)
    expect(SandboxManager.isSandboxingEnabled()).toBe(false)
    expect(platform).toHaveBeenCalledTimes(1)
    expect(SandboxManager.isSupportedPlatform()).toBe(false)
    expect(platform).toHaveBeenCalledTimes(1)
  })
})
