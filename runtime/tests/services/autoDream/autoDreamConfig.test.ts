import { describe, expect, it } from 'vitest'
import { resolveAutoDreamConfig } from '../../../src/services/autoDream/autoDream.js'

const DEFAULTS = { minHours: 24, minSessions: 5 }

describe('resolveAutoDreamConfig', () => {
  it('returns defaults when settings are unset (regression guard for dead null source)', () => {
    expect(resolveAutoDreamConfig({})).toEqual(DEFAULTS)
    expect(resolveAutoDreamConfig(null)).toEqual(DEFAULTS)
    expect(resolveAutoDreamConfig(undefined)).toEqual(DEFAULTS)
  })

  it('honors configured thresholds (the actual fix)', () => {
    expect(
      resolveAutoDreamConfig({
        autoDreamMinHours: 6,
        autoDreamMinSessions: 2,
      }),
    ).toEqual({ minHours: 6, minSessions: 2 })
  })

  it('falls back per-field for a partial config', () => {
    expect(resolveAutoDreamConfig({ autoDreamMinHours: 12 })).toEqual({
      minHours: 12,
      minSessions: DEFAULTS.minSessions,
    })
    expect(resolveAutoDreamConfig({ autoDreamMinSessions: 3 })).toEqual({
      minHours: DEFAULTS.minHours,
      minSessions: 3,
    })
  })

  it.each([0, -1, NaN, Infinity, -Infinity, '24', null, undefined, {}])(
    'rejects garbage minHours value %p while honoring valid sibling',
    garbage => {
      expect(
        resolveAutoDreamConfig({
          autoDreamMinHours: garbage as unknown,
          autoDreamMinSessions: 2,
        }),
      ).toEqual({ minHours: DEFAULTS.minHours, minSessions: 2 })
    },
  )

  it.each([0, -1, NaN, Infinity, -Infinity, '5', null, undefined, {}])(
    'rejects garbage minSessions value %p while honoring valid sibling',
    garbage => {
      expect(
        resolveAutoDreamConfig({
          autoDreamMinHours: 6,
          autoDreamMinSessions: garbage as unknown,
        }),
      ).toEqual({ minHours: 6, minSessions: DEFAULTS.minSessions })
    },
  )
})
