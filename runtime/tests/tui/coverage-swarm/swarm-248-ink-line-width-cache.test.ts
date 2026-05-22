import { afterEach, describe, expect, test, vi } from 'vitest'

type LineWidthModule = typeof import('../../../src/tui/ink/line-width-cache.js')

async function loadLineWidth(
  implementation: (line: string) => number,
): Promise<
  LineWidthModule & {
    stringWidth: ReturnType<typeof vi.fn<(line: string) => number>>
  }
> {
  vi.resetModules()

  const stringWidth = vi.fn<(line: string) => number>(implementation)
  vi.doMock('../../../src/tui/ink/stringWidth.js', () => ({
    stringWidth,
  }))

  const module = await import('../../../src/tui/ink/line-width-cache.js')
  return { ...module, stringWidth }
}

afterEach(() => {
  vi.doUnmock('../../../src/tui/ink/stringWidth.js')
  vi.resetModules()
})

describe('lineWidth coverage swarm row 248', () => {
  test('caches measured widths including zero-width lines', async () => {
    const { lineWidth, stringWidth } = await loadLineWidth(line =>
      line.length === 0 ? 0 : line.length,
    )

    expect(lineWidth('')).toBe(0)
    expect(lineWidth('')).toBe(0)
    expect(lineWidth('abc')).toBe(3)
    expect(lineWidth('abc')).toBe(3)

    expect(stringWidth).toHaveBeenCalledTimes(2)
    expect(stringWidth).toHaveBeenNthCalledWith(1, '')
    expect(stringWidth).toHaveBeenNthCalledWith(2, 'abc')
  })

  test('clears the cache after it reaches the maximum size', async () => {
    const { lineWidth, stringWidth } = await loadLineWidth(line => line.length)

    for (let i = 0; i < 4096; i += 1) {
      expect(lineWidth(`line-${i}`)).toBe(`line-${i}`.length)
    }

    expect(lineWidth('line-4096')).toBe('line-4096'.length)
    expect(lineWidth('line-4096')).toBe('line-4096'.length)
    expect(lineWidth('line-0')).toBe('line-0'.length)

    expect(stringWidth).toHaveBeenCalledTimes(4098)
    expect(
      stringWidth.mock.calls.filter(([line]) => line === 'line-4096'),
    ).toHaveLength(1)
    expect(
      stringWidth.mock.calls.filter(([line]) => line === 'line-0'),
    ).toHaveLength(2)
  })
})
