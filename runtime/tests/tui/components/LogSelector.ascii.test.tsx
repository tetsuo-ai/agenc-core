import React from 'react'
import { describe, expect, it } from 'vitest'

import { renderToString } from '../../utils/staticRender.js'
import {
  getLogSelectorExpandCollapseHintText,
  getLogSelectorGlyphParts,
} from './LogSelector.js'
import { Byline } from './design-system/Byline.js'
import { Text } from '../ink.js'

describe('LogSelector ASCII rendering helpers', () => {
  it('uses ASCII tree prefixes and expand/collapse hints in ASCII glyph mode', () => {
    const env = { AGENC_TUI_GLYPHS: 'ascii' }
    const parts = getLogSelectorGlyphParts(env)

    expect(parts.parentExpandedPrefix).toBe('v ')
    expect(parts.parentCollapsedPrefix).toBe('> ')
    expect(parts.childPrefix).toBe('  > ')
    expect(parts.metadataSeparator).toBe(' - ')
    expect(
      getLogSelectorExpandCollapseHintText({
        isExpanded: false,
        isChildNode: false,
      }, env),
    ).toBe('> to expand')
    expect(
      getLogSelectorExpandCollapseHintText({
        isExpanded: true,
        isChildNode: false,
      }, env),
    ).toBe('< to collapse')
    expect(
      getLogSelectorExpandCollapseHintText({
        isExpanded: false,
        isChildNode: true,
      }, env),
    ).toBe('< to collapse')
  })

  it('renders footer byline separators with ASCII fallback', async () => {
    const previousGlyphMode = process.env.AGENC_TUI_GLYPHS
    process.env.AGENC_TUI_GLYPHS = 'ascii'

    try {
      const output = await renderToString(
        <Text>
          <Byline>
            <Text>Ctrl+V to preview</Text>
            <Text>Esc to cancel</Text>
          </Byline>
        </Text>,
        80,
      )

      expect(output).toContain('Ctrl+V to preview - Esc to cancel')
      expect(output).not.toContain('·')
    } finally {
      if (previousGlyphMode === undefined) {
        delete process.env.AGENC_TUI_GLYPHS
      } else {
        process.env.AGENC_TUI_GLYPHS = previousGlyphMode
      }
    }
  })
})
