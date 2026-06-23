import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { resolveOtelHeadersDebounceMs } from '../../src/utils/auth.js'

const ENV_KEY = 'AGENC_OTEL_HEADERS_HELPER_DEBOUNCE_MS'
const DEFAULT_OTEL_HEADERS_DEBOUNCE_MS = 29 * 60 * 1000 // 29 minutes
const ORIGINAL_VALUE = process.env[ENV_KEY]

afterEach(() => {
  if (ORIGINAL_VALUE === undefined) {
    delete process.env[ENV_KEY]
  } else {
    process.env[ENV_KEY] = ORIGINAL_VALUE
  }
})

describe('resolveOtelHeadersDebounceMs', () => {
  beforeEach(() => {
    delete process.env[ENV_KEY]
  })

  it('returns the default debounce when the env override is unset', () => {
    expect(resolveOtelHeadersDebounceMs()).toBe(DEFAULT_OTEL_HEADERS_DEBOUNCE_MS)
  })

  it('falls back to the default for a non-numeric override instead of NaN', () => {
    process.env[ENV_KEY] = 'abc'

    const result = resolveOtelHeadersDebounceMs()

    // Regression: a non-numeric value must not propagate NaN, which would make
    // the `Date.now() - timestamp < debounceMs` comparison always false and
    // silently disable the helper debounce.
    expect(Number.isNaN(result)).toBe(false)
    expect(result).toBe(DEFAULT_OTEL_HEADERS_DEBOUNCE_MS)
  })

  it('honors a valid numeric override', () => {
    process.env[ENV_KEY] = '60000'

    expect(resolveOtelHeadersDebounceMs()).toBe(60000)
  })

  it('accepts a zero override', () => {
    process.env[ENV_KEY] = '0'

    expect(resolveOtelHeadersDebounceMs()).toBe(0)
  })

  it('falls back to the default for a negative override', () => {
    process.env[ENV_KEY] = '-5'

    expect(resolveOtelHeadersDebounceMs()).toBe(DEFAULT_OTEL_HEADERS_DEBOUNCE_MS)
  })
})
