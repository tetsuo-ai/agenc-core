import { describe, expect, it } from 'vitest'

import { getAgentWizardInputColumns } from './layout.js'

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
