import { describe, expect, test, vi } from 'vitest'

vi.mock('bun:bundle', () => ({
  feature: () => false,
}))

import { computeSliceStart, type SliceAnchor } from './Messages.js'

const messages = Array.from({ length: 12 }, (_, index) => ({
  uuid: `message-${index}`,
}))

function anchor(current: SliceAnchor): { current: SliceAnchor } {
  return { current }
}

describe('computeSliceStart coverage', () => {
  test('keeps, heals, advances, and clears the slice anchor', () => {
    const existing = anchor({ uuid: 'message-2', idx: 2 })

    expect(computeSliceStart(messages.slice(0, 8), existing, 5, 2)).toBe(2)
    expect(existing.current).toEqual({ uuid: 'message-2', idx: 2 })

    const stale = anchor({ uuid: 'removed-message', idx: 7 })

    expect(computeSliceStart(messages, stale, 5, 1)).toBe(7)
    expect(stale.current).toEqual({ uuid: 'message-7', idx: 7 })

    const advanced = anchor({ uuid: 'removed-message', idx: 0 })

    expect(computeSliceStart(messages, advanced, 5, 1)).toBe(7)
    expect(advanced.current).toEqual({ uuid: 'message-7', idx: 7 })

    const emptied = anchor({ uuid: 'removed-message', idx: 4 })

    expect(computeSliceStart([], emptied, 5, 1)).toBe(0)
    expect(emptied.current).toBeNull()
  })
})
