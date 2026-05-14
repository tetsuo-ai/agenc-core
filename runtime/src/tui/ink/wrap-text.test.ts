import { afterEach, describe, expect, test } from 'vitest'

import { stringWidth } from './stringWidth.js'
import wrapText from './wrap-text.js'

describe('wrapText truncation glyphs', () => {
  const previousGlyphMode = process.env.AGENC_TUI_GLYPHS

  afterEach(() => {
    if (previousGlyphMode === undefined) {
      delete process.env.AGENC_TUI_GLYPHS
    } else {
      process.env.AGENC_TUI_GLYPHS = previousGlyphMode
    }
  })

  test('uses ASCII-safe truncation markers in ASCII glyph mode', () => {
    process.env.AGENC_TUI_GLYPHS = 'ascii'

    expect(wrapText('abcdef', 4, 'truncate')).toBe('a...')
    expect(wrapText('abcdef', 2, 'truncate')).toBe('..')
    expect(wrapText('abcdef', 1, 'truncate')).toBe('.')
    expect(wrapText('abcdef', 0, 'truncate')).toBe('')
  })

  test('keeps truncated output within the requested terminal width', () => {
    process.env.AGENC_TUI_GLYPHS = 'ascii'

    for (const columns of [1, 2, 3, 4, 5, 6]) {
      expect(stringWidth(wrapText('abcdefghi', columns, 'truncate-middle'))).toBeLessThanOrEqual(columns)
      expect(stringWidth(wrapText('abcdefghi', columns, 'truncate-start'))).toBeLessThanOrEqual(columns)
      expect(stringWidth(wrapText('abcdefghi', columns, 'truncate'))).toBeLessThanOrEqual(columns)
    }
  })
})

describe('stringWidth fallback parity', () => {
  test('counts complex-script clusters by terminal cell allocation', () => {
    expect(stringWidth('क्‍ष')).toBe(2)
  })
})
