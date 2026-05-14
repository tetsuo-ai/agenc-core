import { describe, expect, it } from 'vitest'

import { getFileWriteDiffWidth } from './FileWriteToolDiff.js'

describe('getFileWriteDiffWidth', () => {
  it('clamps tiny or invalid terminal widths to one column', () => {
    expect(getFileWriteDiffWidth(Number.NaN)).toBe(1)
    expect(getFileWriteDiffWidth(0)).toBe(1)
    expect(getFileWriteDiffWidth(1)).toBe(1)
    expect(getFileWriteDiffWidth(2)).toBe(1)
  })

  it('uses the available diff width for normal terminals', () => {
    expect(getFileWriteDiffWidth(80)).toBe(78)
    expect(getFileWriteDiffWidth(80.9)).toBe(78)
  })
})
