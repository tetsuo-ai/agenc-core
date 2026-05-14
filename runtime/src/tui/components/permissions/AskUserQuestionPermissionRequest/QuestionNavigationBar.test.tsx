import React from 'react'
import { describe, expect, it, vi } from 'vitest'

import { renderToString } from '../../../../utils/staticRender.js'
import { QuestionNavigationBar } from './QuestionNavigationBar.js'

vi.mock('../../../hooks/useTerminalSize.js', () => ({
  useTerminalSize: () => ({ columns: 80, rows: 24 }),
}))

const questions = [
  { question: 'Choose one', header: 'Pick' },
  { question: 'Explain why', header: 'Notes' },
] as never

describe('QuestionNavigationBar glyph fallbacks', () => {
  it('uses ascii navigation and status glyphs when requested', async () => {
    const previousGlyphMode = process.env.AGENC_TUI_GLYPHS
    process.env.AGENC_TUI_GLYPHS = 'ascii'
    try {
      const output = await renderToString(
        <QuestionNavigationBar
          questions={questions}
          currentQuestionIndex={0}
          answers={{ 'Choose one': 'A' }}
        />,
        80,
      )

      expect(output).toContain('<')
      expect(output).toContain('>')
      expect(output).toContain('[x]')
      expect(output).toContain('[ ]')
      expect(output).toContain('OK Submit')
      expect(output).not.toMatch(/[←→✓☐☑]/u)
    } finally {
      if (previousGlyphMode === undefined) {
        delete process.env.AGENC_TUI_GLYPHS
      } else {
        process.env.AGENC_TUI_GLYPHS = previousGlyphMode
      }
    }
  })
})
