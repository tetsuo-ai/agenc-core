import React from 'react'
import { afterEach, describe, expect, it } from 'vitest'

import { renderToString } from '../../utils/staticRender.js'
import {
  getTagTabsMaxSingleTabWidth,
  getTagTabsOverflowPrefixes,
  TagTabs,
} from './TagTabs.js'

const previousGlyphMode = process.env.AGENC_TUI_GLYPHS

afterEach(() => {
  if (previousGlyphMode === undefined) {
    delete process.env.AGENC_TUI_GLYPHS
  } else {
    process.env.AGENC_TUI_GLYPHS = previousGlyphMode
  }
})

describe('TagTabs width and glyph behavior', () => {
  it('shrinks single-tab width below the old twenty-column floor', () => {
    expect(getTagTabsMaxSingleTabWidth(40)).toBe(20)
    expect(getTagTabsMaxSingleTabWidth(10)).toBe(5)
    expect(getTagTabsMaxSingleTabWidth(3)).toBe(4)
  })

  it('uses ASCII overflow prefixes in ASCII glyph mode', () => {
    expect(getTagTabsOverflowPrefixes({ AGENC_TUI_GLYPHS: 'ascii' })).toEqual({
      left: '< ',
      right: '>',
    })
  })

  it('renders ASCII overflow cues without Unicode arrows', async () => {
    process.env.AGENC_TUI_GLYPHS = 'ascii'

    const output = await renderToString(
      <TagTabs
        tabs={['All', 'alpha', 'beta', 'gamma', 'delta']}
        selectedIndex={3}
        availableWidth={24}
      />,
      80,
    )

    expect(output).toContain('>')
    expect(output).not.toContain('←')
    expect(output).not.toContain('→')
  })
})
