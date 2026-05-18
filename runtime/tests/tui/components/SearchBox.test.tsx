import React from 'react'
import { afterEach, describe, expect, test } from 'vitest'

import { renderToString } from '../../utils/staticRender.js'
import { getSearchBoxDefaults, SearchBox } from './SearchBox.js'

const previousGlyphMode = process.env.AGENC_TUI_GLYPHS

afterEach(() => {
  if (previousGlyphMode === undefined) {
    delete process.env.AGENC_TUI_GLYPHS
  } else {
    process.env.AGENC_TUI_GLYPHS = previousGlyphMode
  }
})

describe('SearchBox glyph defaults', () => {
  test('uses ASCII-safe prefix and placeholder when ASCII glyph mode is requested', async () => {
    expect(getSearchBoxDefaults({ AGENC_TUI_GLYPHS: 'ascii' })).toEqual({
      placeholder: 'Search...',
      prefix: '/',
    })

    process.env.AGENC_TUI_GLYPHS = 'ascii'
    const output = await renderToString(
      <SearchBox
        query=""
        isFocused={true}
        isTerminalFocused={false}
        borderless={true}
      />,
      80,
    )

    expect(output).toContain('/ Search...')
    expect(output).not.toContain('Search…')
    expect(output).not.toContain('⌕')
  })

  test('preserves Unicode defaults outside ASCII glyph mode', () => {
    expect(getSearchBoxDefaults({})).toEqual({
      placeholder: 'Search…',
      prefix: '⌕',
    })
  })
})
