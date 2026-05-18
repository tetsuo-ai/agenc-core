import { describe, expect, it } from 'vitest'

import { selectComputerUseApprovalGlyphs } from './computerUseGlyphs.js'

describe('selectComputerUseApprovalGlyphs', () => {
  it('uses unicode glyphs by default', () => {
    const glyphs = selectComputerUseApprovalGlyphs()

    expect(glyphs.granted).toBe('✔')
    expect(glyphs.denied).toBe('✘')
    expect(glyphs.bullet).toBe('·')
  })

  it('uses ascii glyphs when requested', () => {
    const glyphs = selectComputerUseApprovalGlyphs({ AGENC_TUI_GLYPHS: 'ascii' })

    expect(glyphs.granted).toBe('OK')
    expect(glyphs.denied).toBe('ERR')
    expect(glyphs.selectedApp).toBe('(*)')
    expect(glyphs.unselectedApp).toBe('( )')
    expect(glyphs.warning).toBe('!')
    expect(glyphs.bullet).toBe('*')
  })
})
