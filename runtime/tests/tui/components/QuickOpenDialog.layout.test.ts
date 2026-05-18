import { describe, expect, it } from 'vitest'

import { computeQuickOpenLayout } from './QuickOpenDialog.js'

describe('computeQuickOpenLayout', () => {
  it('keeps all computed dimensions usable on tiny terminals', () => {
    const layout = computeQuickOpenLayout(6, 8)

    expect(layout.previewOnRight).toBe(false)
    expect(layout.visibleResults).toBe(1)
    expect(layout.maxPathWidth).toBeGreaterThanOrEqual(1)
    expect(layout.previewWidth).toBeGreaterThanOrEqual(1)
  })

  it('does not force old hard minimums into narrow terminals', () => {
    const layout = computeQuickOpenLayout(18, 20)

    expect(layout.visibleResults).toBe(6)
    expect(layout.maxPathWidth).toBe(10)
    expect(layout.previewWidth).toBe(12)
  })

  it('splits path and preview widths on wide terminals', () => {
    const layout = computeQuickOpenLayout(160, 30)

    expect(layout.previewOnRight).toBe(true)
    expect(layout.visibleResults).toBe(8)
    expect(layout.effectivePreviewLines).toBe(7)
    expect(layout.maxPathWidth).toBe(60)
    expect(layout.previewWidth).toBe(86)
  })
})
