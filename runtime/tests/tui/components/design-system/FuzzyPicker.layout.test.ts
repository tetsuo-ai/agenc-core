import { describe, expect, it } from 'vitest'

import {
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

  it('uses ascii glyph fallbacks when requested', () => {
    const env = { AGENC_TUI_GLYPHS: 'ascii' }

    expect(getFuzzyPickerDefaultPlaceholder(env)).toBe('Type to search...')
    expect(getFuzzyPickerNavigationShortcut(env)).toBe('^/v')
  })
})
