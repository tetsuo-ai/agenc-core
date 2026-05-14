import React from 'react'
import { afterEach, describe, expect, it } from 'vitest'

import { renderToString } from '../../utils/staticRender.js'
import { Text } from '../ink.js'
import { MessageResponse } from './MessageResponse.js'

const previousGlyphMode = process.env.AGENC_TUI_GLYPHS

afterEach(() => {
  if (previousGlyphMode === undefined) {
    delete process.env.AGENC_TUI_GLYPHS
  } else {
    process.env.AGENC_TUI_GLYPHS = previousGlyphMode
  }
})

describe('MessageResponse', () => {
  it('uses the ASCII response gutter when ASCII glyph mode is requested', async () => {
    process.env.AGENC_TUI_GLYPHS = 'ascii'

    const output = await renderToString(
      <MessageResponse height={1}>
        <Text>result</Text>
      </MessageResponse>,
      40,
    )

    expect(output).toContain('|_ result')
    expect(output).not.toContain('⎿')
  })

  it('uses the unicode response gutter by default', async () => {
    delete process.env.AGENC_TUI_GLYPHS

    const output = await renderToString(
      <MessageResponse height={1}>
        <Text>result</Text>
      </MessageResponse>,
      40,
    )

    expect(output).toContain('⎿ result')
  })
})
