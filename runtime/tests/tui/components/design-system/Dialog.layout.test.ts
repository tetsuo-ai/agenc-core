import { describe, expect, it } from 'vitest'

import { getDialogBodyMaxHeight } from './Dialog.js'

describe('getDialogBodyMaxHeight', () => {
  it('keeps at least one row for the body on tiny or invalid terminals', () => {
    expect(getDialogBodyMaxHeight(Number.NaN, true)).toBe(1)
    expect(getDialogBodyMaxHeight(0, true)).toBe(1)
    expect(getDialogBodyMaxHeight(5, true)).toBe(1)
  })

  it('reserves chrome rows for title, spacing, border, and input guide', () => {
    expect(getDialogBodyMaxHeight(24, true)).toBe(18)
    expect(getDialogBodyMaxHeight(24, false)).toBe(20)
    expect(getDialogBodyMaxHeight(12.9, true)).toBe(6)
  })
})
