import { describe, expect, it } from 'vitest'

import {
  computeFuzzyPickerPreviewBudget,
  computeFuzzyPickerVisibleCount,
  getFuzzyPickerDefaultPlaceholder,
  getFuzzyPickerNavigationShortcut,
} from './FuzzyPicker.js'

describe('FuzzyPicker layout helpers', () => {
  it('drops to a single result row when terminal chrome leaves no list room', () => {
    expect(computeFuzzyPickerVisibleCount(8, 8)).toBe(1)
  })

  it('caps visible rows to the terminal height after optional match labels', () => {
    expect(computeFuzzyPickerVisibleCount(8, 14, true)).toBe(3)
    expect(computeFuzzyPickerVisibleCount(8, 30, false)).toBe(8)
  })

  it('budgets preview rows from what chrome, list, and match label leave', () => {
    expect(computeFuzzyPickerPreviewBudget(30, 8)).toBe(12)
    expect(computeFuzzyPickerPreviewBudget(30, 8, true)).toBe(11)
  })

  it('hides the preview entirely when the list already fills the terminal', () => {
    expect(computeFuzzyPickerPreviewBudget(18, 8)).toBe(0)
    expect(computeFuzzyPickerPreviewBudget(11, 1, true)).toBe(0)
  })

  it('uses ascii glyph fallbacks when requested', () => {
    const env = { AGENC_TUI_GLYPHS: 'ascii' }

    expect(getFuzzyPickerDefaultPlaceholder(env)).toBe('Type to search...')
    expect(getFuzzyPickerNavigationShortcut(env)).toBe('^/v')
  })
})
