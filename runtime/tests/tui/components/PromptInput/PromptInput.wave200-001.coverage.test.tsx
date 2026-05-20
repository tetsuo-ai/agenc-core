import { describe, expect, test, vi } from 'vitest'

vi.mock('bun:bundle', () => ({
  feature: () => false,
}))

vi.mock('../../../utils/config.js', () => ({
  getGlobalConfig: () => ({}),
  saveGlobalConfig: () => {},
}))

vi.mock('../../history/history.js', () => ({
  formatImageRef: () => '',
  formatPastedTextRef: () => '',
  getPastedTextRefNumLines: () => 0,
  parseReferences: () => [],
}))

import { calculatePromptMaxVisibleLines } from './PromptInput.js'

describe('PromptInput fullscreen sizing coverage', () => {
  test('normalizes non-finite terminal rows to the minimum fullscreen input budget', () => {
    expect(calculatePromptMaxVisibleLines(Number.POSITIVE_INFINITY, true)).toBe(1)
    expect(calculatePromptMaxVisibleLines(Number.NaN, true)).toBe(1)
  })
})
