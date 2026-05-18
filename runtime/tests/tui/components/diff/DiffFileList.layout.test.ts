import { describe, expect, it } from 'vitest'

import { selectAgenCTuiGlyphs } from '../../glyphs.js'
import { stringWidth } from '../../ink/stringWidth.js'
import {
  getDiffFilePathWidth,
  truncateDiffFilePath,
} from './DiffFileList.js'

describe('getDiffFilePathWidth', () => {
  it('uses the available row space for normal terminals', () => {
    expect(getDiffFilePathWidth(80)).toBe(57)
  })

  it('does not reserve a hard minimum that can overflow narrow terminals', () => {
    expect(getDiffFilePathWidth(24)).toBe(1)
    expect(getDiffFilePathWidth(20)).toBe(1)
    expect(getDiffFilePathWidth(0)).toBe(1)
  })

  it('normalizes invalid terminal widths', () => {
    expect(getDiffFilePathWidth(Number.NaN)).toBe(1)
    expect(getDiffFilePathWidth(Number.POSITIVE_INFINITY)).toBe(1)
    expect(getDiffFilePathWidth(24.9)).toBe(1)
    expect(getDiffFilePathWidth(25.9)).toBe(2)
  })

  it('uses the selected ellipsis when truncating long paths', () => {
    const asciiPath = truncateDiffFilePath(
      'src/components/diff/really-long-file-name.ts',
      15,
      selectAgenCTuiGlyphs({ AGENC_TUI_GLYPHS: 'ascii' }).ellipsis,
    )

    expect(stringWidth(asciiPath)).toBeLessThanOrEqual(15)
    expect(asciiPath).toBe('...file-name.ts')
    expect(asciiPath).not.toContain('…')
  })
})
