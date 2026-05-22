import { afterEach, describe, expect, test, vi } from 'vitest'

type StringWidthModule = typeof import('../../../src/tui/ink/stringWidth.js')

async function loadStringWidth(): Promise<StringWidthModule> {
  vi.resetModules()
  return import('../../../src/tui/ink/stringWidth.js')
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('stringWidth coverage swarm row 208', () => {
  test('uses the JavaScript fallback for empty, non-string, and incomplete Bun APIs', async () => {
    vi.stubGlobal('Bun', {})

    const { stringWidth } = await loadStringWidth()
    const unsafeStringWidth = stringWidth as unknown as (
      value: unknown,
    ) => number

    expect(unsafeStringWidth(undefined)).toBe(0)
    expect(unsafeStringWidth(7)).toBe(0)
    expect(stringWidth('')).toBe(0)
    expect(stringWidth('plain')).toBe(5)
  })

  test('counts printable Unicode that should not be treated as zero width', async () => {
    vi.stubGlobal('Bun', undefined)

    const { stringWidth } = await loadStringWidth()

    expect(stringWidth('\u00a0')).toBe(1)
    expect(stringWidth('\u03a9')).toBe(1)
    expect(stringWidth('\u26a0')).toBe(1)
    expect(stringWidth('\u26a0\ufe0e')).toBe(1)
    expect(stringWidth('\u26a0\ufe0f')).toBe(2)
    expect(stringWidth('\u0905')).toBe(1)
    expect(stringWidth('\u0e32\u0e33\u0eb2\u0eb3')).toBe(4)
    expect(stringWidth('\u0627')).toBe(1)
  })

  test('segments symbol and joiner inputs without counting joiners as cells', async () => {
    vi.stubGlobal('Bun', undefined)

    const { stringWidth } = await loadStringWidth()

    expect(stringWidth('\u2600\ufe0f')).toBe(2)
    expect(stringWidth('A\u200dB')).toBe(2)
  })

  test('uses the fallback for text-presentation symbols even when Bun is available', async () => {
    const bunStringWidth = vi.fn(() => 2)
    vi.stubGlobal('Bun', { stringWidth: bunStringWidth })

    const { stringWidth } = await loadStringWidth()

    expect(stringWidth('\u26a0')).toBe(1)
    expect(stringWidth('plain')).toBe(2)
    expect(bunStringWidth).toHaveBeenCalledWith('plain', {
      ambiguousIsNarrow: true,
    })
  })
})
