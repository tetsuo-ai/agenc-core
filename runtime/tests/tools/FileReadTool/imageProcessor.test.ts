import { afterEach, describe, expect, it, vi } from 'vitest'

type GlobalWithBun = typeof globalThis & {
  Bun?: { embeddedFiles?: readonly unknown[] }
}

const ORIGINAL_BUN = (globalThis as GlobalWithBun).Bun

afterEach(() => {
  vi.restoreAllMocks()
  vi.resetModules()
  if (ORIGINAL_BUN === undefined) {
    delete (globalThis as GlobalWithBun).Bun
  } else {
    ;(globalThis as GlobalWithBun).Bun = ORIGINAL_BUN
  }
})

describe('getImageProcessor', () => {
  it('falls back to sharp when the bundled native module is an empty stub', async () => {
    ;(globalThis as GlobalWithBun).Bun = { embeddedFiles: [{}] }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const [{ getImageProcessor }, sharpModule] = await Promise.all([
      import('../../../src/tools/FileReadTool/imageProcessor.js'),
      import('sharp'),
    ])

    const expectedSharp =
      typeof sharpModule.default === 'function' ? sharpModule.default : sharpModule

    await expect(getImageProcessor()).resolves.toBe(expectedSharp)
    expect(warn).toHaveBeenCalledWith(
      'Native image processor not available, falling back to sharp',
    )
  })
})
