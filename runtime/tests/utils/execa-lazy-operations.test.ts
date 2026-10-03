import { afterEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ execa: vi.fn(), platform: 'linux' }))
vi.mock('execa', () => ({ execa: state.execa }))
vi.mock('../../src/utils/platform.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/utils/platform.js')>(),
  getPlatform: () => state.platform,
}))
afterEach(() => { vi.resetModules(); state.execa.mockReset(); state.platform = 'linux' })

describe('deferred subprocess operations', () => {
  it.each([
    ['linux', 'cursor', 'cursor'],
    ['macos', 'Cursor Helper', 'cursor'],
    ['windows', 'Cursor.exe', 'cursor'],
  ])('detects IDE processes on %s and preserves the cached result', async (platform, stdout, expected) => {
    const ide = await import('../../src/utils/ide.js')
    expect(state.execa).not.toHaveBeenCalled()
    state.platform = platform
    state.execa.mockResolvedValue({ exitCode: 0, stdout })
    await expect(ide.detectRunningIDEs()).resolves.toContain(expected)
    await expect(ide.detectRunningIDEsCached()).resolves.toContain(expected)
    expect(state.execa).toHaveBeenCalledOnce()
    expect(state.execa).toHaveBeenCalledWith(expect.any(String), { shell: true, reject: false })
  })

  it('preserves asynchronous executable lookup options and missing-command results', async () => {
    const { which } = await import('../../src/utils/which.js')
    state.execa.mockResolvedValueOnce({ exitCode: 0, stdout: '/bin/sh\n' })
    await expect(which('sh')).resolves.toBe('/bin/sh')
    expect(state.execa).toHaveBeenCalledWith('which sh', { shell: true, stderr: 'ignore', reject: false })
    state.execa.mockResolvedValueOnce({ exitCode: 1, stdout: '' })
    await expect(which('missing')).resolves.toBeNull()
  })

  it('preserves clipboard path subprocess options and whitespace trimming', async () => {
    const { getImagePathFromClipboard } = await import('../../src/utils/imagePaste.js')
    state.execa.mockResolvedValue({ exitCode: 0, stdout: ' /tmp/image.png\n' })
    await expect(getImagePathFromClipboard()).resolves.toBe('/tmp/image.png')
    expect(state.execa).toHaveBeenCalledWith(expect.any(String), { shell: true, reject: false })
  })
})
