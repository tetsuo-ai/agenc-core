import { describe, expect, it } from 'vitest'

import { computeMessageOptionTextWidth } from './MessageSelector.js'

describe('computeMessageOptionTextWidth', () => {
  it('clamps below-padding widths to one usable column', () => {
    expect(computeMessageOptionTextWidth(6, 10)).toBe(1)
    expect(computeMessageOptionTextWidth(0, 10)).toBe(1)
  })

  it('subtracts padding from normal terminal widths', () => {
    expect(computeMessageOptionTextWidth(80, 10)).toBe(70)
  })
})
