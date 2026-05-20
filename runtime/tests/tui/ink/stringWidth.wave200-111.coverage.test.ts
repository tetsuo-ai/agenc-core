import { afterEach, expect, test, vi } from 'vitest'

type StringWidthModule = typeof import('./stringWidth.js')

async function loadStringWidth(): Promise<StringWidthModule> {
  vi.resetModules()
  return import('./stringWidth.js')
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

test('measures terminal cell widths through fallback and Bun module branches', async () => {
  vi.stubGlobal('Bun', undefined)

  const fallback = await loadStringWidth()
  const singleRegionalIndicator = String.fromCodePoint(0x1f1fa)
  const pairedRegionalIndicators = String.fromCodePoint(0x1f1fa, 0x1f1f8)
  const emojiPresentation = String.fromCodePoint(0x1f600)
  const tagCharacter = String.fromCodePoint(0xe0000)
  const variationSelectorSupplement = String.fromCodePoint(0xe0100)

  const fallbackCases: Array<readonly [input: string, width: number]> = [
    ['abc\t', 3],
    ['\x1b[31m\x1b[39m', 0],
    ['\x1b[32mgreen\x1b[39m', 5],
    [emojiPresentation, 2],
    [singleRegionalIndicator, 1],
    [pairedRegionalIndicators, 2],
    ['1\ufe0f', 1],
    ['#\ufe0f', 1],
    ['*\ufe0f', 1],
    ['1\ufe0f\u20e3', 2],
    ['a\x85', 1],
    ['\u00ad', 0],
    ['\u200b\ufeff\u2060', 0],
    ['\ufe0e' + variationSelectorSupplement, 0],
    ['e\u0301\u1ab0\u1dc0\u20d0\ufe20', 1],
    ['\u0900\u093e\u0951\u0962', 0],
    ['\u0e31\u0e34\u0e47\u0eb1\u0eb4\u0ec8', 0],
    ['\u0600\u06dd\u070f\u08e2', 0],
    ['\ud800' + tagCharacter, 0],
  ]

  for (const [input, width] of fallbackCases) {
    expect(fallback.stringWidth(input)).toBe(width)
  }

  const bunStringWidth = vi.fn(
    (
      input: string,
      options?: { readonly ambiguousIsNarrow?: boolean },
    ): number => (options?.ambiguousIsNarrow ? input.length : 0),
  )

  vi.stubGlobal('Bun', { stringWidth: bunStringWidth })

  const bunBacked = await loadStringWidth()

  expect(bunBacked.stringWidth('wide?')).toBe(5)
  expect(bunStringWidth).toHaveBeenCalledWith('wide?', {
    ambiguousIsNarrow: true,
  })
})
