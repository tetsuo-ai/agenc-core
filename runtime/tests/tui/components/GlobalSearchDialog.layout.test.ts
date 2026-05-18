import { describe, expect, it } from 'vitest'

import { computeGlobalSearchLayout } from './GlobalSearchDialog.js'

describe('computeGlobalSearchLayout', () => {
  it('keeps all computed widths usable on tiny terminals', () => {
    const layout = computeGlobalSearchLayout(6, 8)

    expect(layout.previewOnRight).toBe(false)
    expect(layout.listWidth).toBeGreaterThanOrEqual(1)
    expect(layout.maxPathWidth).toBeGreaterThanOrEqual(1)
    expect(layout.maxTextWidth).toBeGreaterThanOrEqual(1)
    expect(layout.previewWidth).toBeGreaterThanOrEqual(1)
  })

  it('does not force old hard minimums into narrow terminals', () => {
    const layout = computeGlobalSearchLayout(30, 20)

    expect(layout.listWidth).toBe(22)
    expect(layout.maxPathWidth).toBeLessThan(20)
    expect(layout.previewWidth).toBe(24)
  })

  it('splits list and preview widths on wide terminals', () => {
    const layout = computeGlobalSearchLayout(160, 30)

    expect(layout.previewOnRight).toBe(true)
    expect(layout.listWidth).toBe(75)
    expect(layout.previewWidth).toBe(71)
  })
})
