import { describe, expect, it, vi } from 'vitest'

vi.mock('bun:bundle', () => ({
  feature: () => false,
}))

import { getToolResultMessageWidth } from './Message.js'

describe('Message tool-result width behavior', () => {
  it('clamps tool-result content width for tiny terminals', () => {
    expect(getToolResultMessageWidth(120)).toBe(115)
    expect(getToolResultMessageWidth(5)).toBe(1)
    expect(getToolResultMessageWidth(1)).toBe(1)
  })
})
