import { describe, expect, test } from 'vitest'
import {
  getEffectiveContextWindowSize,
  getAutoCompactThreshold,
} from './auto-compact.ts'

describe('getEffectiveContextWindowSize', () => {
  test('returns positive value for known models with large context windows', () => {
    // claude-sonnet-4 has 200k context
    const effective = getEffectiveContextWindowSize('claude-sonnet-4')
    expect(effective).toBeGreaterThan(0)
  })

  test('never returns negative even for unknown 3P models (issue #635)', () => {
    // Previously, unknown 3P models got 8k context → effective context was
    // 8k minus 20k summary reservation = -12k, causing infinite auto-compact.
    // Now the fallback is 128k and there's a floor, so effective is always
    // at least reservedTokensForSummary + buffer.
    process.env.AGENC_USE_OPENAI = '1'
    try {
      const effective = getEffectiveContextWindowSize('some-unknown-3p-model')
      expect(effective).toBeGreaterThan(0)
      // Must be at least summary reservation (20k) + buffer (13k) = 33k
      expect(effective).toBeGreaterThanOrEqual(33_000)
    } finally {
      delete process.env.AGENC_USE_OPENAI
    }
  })

  test('uses resolved turn context and output-token overrides', () => {
    const effective = getEffectiveContextWindowSize('unknown-local-model', {
      contextWindowTokens: 262_144,
      maxOutputTokens: 8_192,
    })

    expect(effective).toBe(253_952)
  })
})

describe('getAutoCompactThreshold', () => {
  test('returns positive threshold for known models', () => {
    const threshold = getAutoCompactThreshold('claude-sonnet-4')
    expect(threshold).toBeGreaterThan(0)
  })

  test('never returns negative threshold even for unknown 3P models (issue #635)', () => {
    process.env.AGENC_USE_OPENAI = '1'
    try {
      const threshold = getAutoCompactThreshold('some-unknown-3p-model')
      expect(threshold).toBeGreaterThan(0)
    } finally {
      delete process.env.AGENC_USE_OPENAI
    }
  })
})
