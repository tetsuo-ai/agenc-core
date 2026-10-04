import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ load: vi.fn(), attempts: vi.fn(), platform: 'linux' }))
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
vi.mock('../../src/utils/loadExeca.js', () => ({ loadExeca: state.load }))
vi.mock('../../src/utils/platform.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/utils/platform.js')>(),
  getPlatform: () => state.platform,
}))
beforeEach(() => {
  vi.doMock('execa', () => { state.attempts(); throw new Error('execa unavailable') })
})

afterEach(() => {
  vi.resetModules()
  vi.doUnmock('execa')
  vi.restoreAllMocks()
  Object.defineProperty(process, 'platform', originalPlatform)
  state.load.mockReset()
  state.attempts.mockClear()
  state.platform = 'linux'
})

describe('deferred subprocess load failures', () => {
  it('imports secure storage without loading execa and surfaces a real read failure', async () => {
    const { runSecureStorageCommand } = await import('../../src/utils/secureStorage/subprocess.js')
    expect(state.load).not.toHaveBeenCalled()
    const failure = new Error('execa unavailable')
    state.load.mockImplementation(() => { throw failure })
    expect(() => runSecureStorageCommand('/nonexistent/helper', ['read'], { reject: false })).toThrow(failure)
  })

  it('retains portable execution fallback and pre-aborted cancellation', async () => {
    const { execSyncWithDefaults_DEPRECATED: exec } = await import('../../src/utils/execFileNoThrowPortable.js')
    expect(state.load).not.toHaveBeenCalled()
    state.load.mockImplementation(() => { throw new Error('execa unavailable') })
    expect(exec('unused command')).toBeNull()
    state.load.mockClear()
    const abort = new AbortController()
    const failure = new Error('cancelled')
    abort.abort(failure)
    expect(() => exec('unused command', abort.signal)).toThrow(failure)
    expect(state.load).not.toHaveBeenCalled()
  })

  it('does not load execa for synchronous executable discovery', async () => {
    const { whichSync, which } = await import('../../src/utils/which.js')
    expect(whichSync('sh')).toMatch(/sh$/)
    expect(state.attempts).not.toHaveBeenCalled()
    // Vitest wraps a failing dynamic-import mock factory; retain its cause.
    await expect(which('sh')).rejects.toMatchObject({ cause: new Error('execa unavailable') })
    expect(state.attempts).toHaveBeenCalledOnce()
  })

  it('preserves the macOS lock-query fallback when loading fails', async () => {
    const { isMacOsKeychainLocked } = await import('../../src/utils/secureStorage/macOsKeychainStorage.js')
    expect(state.load).not.toHaveBeenCalled()
    expect(state.attempts).not.toHaveBeenCalled()
    Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'darwin' })
    state.load.mockImplementation(() => { throw new Error('execa unavailable') })
    expect(isMacOsKeychainLocked()).toBe(false)
    expect(state.load).toHaveBeenCalledOnce()
  })

  it('reports a deferred keychain read failure without caching a successful empty record', async () => {
    const { createMacOsKeychainStorage } = await import('../../src/utils/secureStorage/macOsKeychainStorage.js')
    const { resolveHomeContext } = await import('../../src/config/home.js')
    const storage = createMacOsKeychainStorage(resolveHomeContext({}), undefined, 'lazy-execa-test', true, 'test', () => '/nonexistent/helper')
    await expect(storage.readAsync()).rejects.toThrow('macOS Keychain lookup could not start')
    await expect(storage.readAsync()).rejects.toThrow('macOS Keychain lookup could not start')
  })

  it('retains clipboard null fallbacks when subprocess loading fails', async () => {
    const clipboard = await import('../../src/utils/imagePaste.js')
    expect(state.attempts).not.toHaveBeenCalled()
    await expect(clipboard.getImageFromClipboard()).resolves.toBeNull()
    expect(state.attempts).toHaveBeenCalledOnce()
    await expect(clipboard.getImagePathFromClipboard()).resolves.toBeNull()
    expect(state.attempts).toHaveBeenCalledTimes(2)
  })

  it('retains the Windows shell snapshot failure fallback', async () => {
    const { createAndSaveSnapshot } = await import('../../src/utils/bash/ShellSnapshot.js')
    expect(state.attempts).not.toHaveBeenCalled()
    state.platform = 'windows'
    await expect(createAndSaveSnapshot('/nonexistent/bash', { PATH: '/bin' })).resolves.toBeUndefined()
    expect(state.attempts).toHaveBeenCalledOnce()
  })

  it.each(['linux', 'macos', 'windows'])('retains empty IDE detection on %s when loading fails', async platform => {
    const { detectRunningIDEs } = await import('../../src/utils/ide.js')
    expect(state.attempts).not.toHaveBeenCalled()
    state.platform = platform
    await expect(detectRunningIDEs()).resolves.toEqual([])
    expect(state.attempts).toHaveBeenCalledOnce()
  })
})
