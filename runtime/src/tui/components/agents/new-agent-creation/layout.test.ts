import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { selectAgenCTuiGlyphs } from '../../../glyphs.js'
import { stringWidth } from '../../../ink/stringWidth.js'
import {
  getAgentConfirmationPreviewColumns,
  getAgentConfirmationPreviewText,
  getAgentWizardInputColumns,
} from './layout.js'

const confirmStepSource = readFileSync(
  new URL('./wizard-steps/ConfirmStep.tsx', import.meta.url),
  'utf8',
)

describe('getAgentWizardInputColumns', () => {
  it('keeps one usable column on tiny or invalid terminals', () => {
    expect(getAgentWizardInputColumns(Number.NaN, 80)).toBe(1)
    expect(getAgentWizardInputColumns(0, 80)).toBe(1)
    expect(getAgentWizardInputColumns(8, 80)).toBe(1)
  })

  it('uses terminal width up to the preferred step width', () => {
    expect(getAgentWizardInputColumns(40, 80)).toBe(32)
    expect(getAgentWizardInputColumns(120, 80)).toBe(80)
    expect(getAgentWizardInputColumns(120, 60)).toBe(60)
  })

  it('normalizes fractional or invalid preferred widths', () => {
    expect(getAgentWizardInputColumns(40.9, 80.9)).toBe(32)
    expect(getAgentWizardInputColumns(120, Number.NaN)).toBe(80)
    expect(getAgentWizardInputColumns(120, 0)).toBe(1)
  })
})

describe('agent confirmation preview layout', () => {
  it('keeps confirmation previews inside terminal width', () => {
    expect(getAgentConfirmationPreviewColumns(120)).toBe(110)
    expect(getAgentConfirmationPreviewColumns(40)).toBe(30)
    expect(getAgentConfirmationPreviewColumns(10)).toBe(1)
    expect(getAgentConfirmationPreviewColumns(Number.NaN)).toBe(1)
  })

  it('uses the active glyph ellipsis when truncating confirmation text', () => {
    const longText = 'abcdefghijklmnopqrstuvwxyz'
    const asciiPreview = getAgentConfirmationPreviewText(
      longText,
      10,
      selectAgenCTuiGlyphs({ AGENC_TUI_GLYPHS: 'ascii' }).ellipsis,
    )
    const unicodePreview = getAgentConfirmationPreviewText(
      longText,
      10,
      selectAgenCTuiGlyphs({}).ellipsis,
    )

    expect(stringWidth(asciiPreview)).toBeLessThanOrEqual(10)
    expect(asciiPreview).toBe('abcdefg...')
    expect(unicodePreview).toBe('abcdefghi…')
    expect(unicodePreview).not.toContain('...')
  })

  it('routes confirmation preview and validation glyphs through shared helpers', () => {
    expect(confirmStepSource).toContain('getAgentConfirmationPreviewText')
    expect(confirmStepSource).toContain('glyphs.statusDot')
    expect(confirmStepSource).not.toContain('truncateToWidth(agent.getSystemPrompt(), 240)')
    expect(confirmStepSource).not.toContain('truncateToWidth(agent.whenToUse, 240)')
    expect(confirmStepSource).not.toContain('•')
  })
})
