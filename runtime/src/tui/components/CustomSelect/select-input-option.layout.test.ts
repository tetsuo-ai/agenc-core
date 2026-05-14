import { describe, expect, it } from 'vitest'

import { computeSelectInputColumns } from './select-input-option.js'

describe('computeSelectInputColumns', () => {
  it('clamps tiny select input widths to one usable column', () => {
    expect(computeSelectInputColumns(6, 3, false, 'Prompt')).toBe(1)
  })

  it('subtracts index and label chrome from labeled inputs', () => {
    expect(computeSelectInputColumns(80, 2, true, 'Reason', ': ')).toBe(66)
  })

  it('does not charge non-string labels as fixed text width', () => {
    expect(computeSelectInputColumns(30, 2, true, { type: 'label' } as never)).toBe(24)
  })
})
