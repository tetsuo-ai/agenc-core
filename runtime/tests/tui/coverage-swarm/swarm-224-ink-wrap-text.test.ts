import { afterEach, describe, expect, test } from 'vitest'

import { stringWidth } from '../../../src/tui/ink/stringWidth.js'
import wrapText from '../../../src/tui/ink/wrap-text.js'

const originalGlyphMode = process.env.AGENC_TUI_GLYPHS

afterEach(() => {
  if (originalGlyphMode === undefined) {
    delete process.env.AGENC_TUI_GLYPHS
  } else {
    process.env.AGENC_TUI_GLYPHS = originalGlyphMode
  }
})

describe('wrapText coverage swarm row 224', () => {
  test('wraps hard lines and trims only for wrap-trim', () => {
    expect(wrapText('alpha beta', 6, 'wrap')).toBe('alpha \nbeta')
    expect(wrapText('alpha beta', 6, 'wrap-trim')).toBe('alpha\nbeta')
    expect(wrapText('abcdefghij', 4, 'wrap')).toBe('abcd\nefgh\nij')
  })

  test('truncates start, middle, and end positions with the ASCII marker', () => {
    process.env.AGENC_TUI_GLYPHS = 'ascii'

    expect(wrapText('abcdefghi', 5, 'truncate-end')).toBe('ab...')
    expect(wrapText('abcdefghi', 5, 'truncate-middle')).toBe('a...i')
    expect(wrapText('abcdefghi', 5, 'truncate-start')).toBe('...hi')
  })

  test('leaves non-truncating overflow modes untouched', () => {
    expect(wrapText('abcdef', 3, 'end')).toBe('abcdef')
    expect(wrapText('abcdef', 3, 'middle')).toBe('abcdef')
  })

  test('keeps wide-character truncation inside the requested width', () => {
    process.env.AGENC_TUI_GLYPHS = 'ascii'

    const output = wrapText('好abcdef', 4, 'truncate')

    expect(output).toBe('...')
    expect(stringWidth(output)).toBeLessThanOrEqual(4)
  })
})
