import { describe, expect, test } from 'vitest'

import { teamMemSavedPart } from './teamMemSaved.js'

describe('teamMemSavedPart', () => {
  test('returns null when no team memory count is present', () => {
    expect(teamMemSavedPart({})).toBeNull()
    expect(teamMemSavedPart({ teamCount: 0 })).toBeNull()
  })

  test('formats singular team memory count', () => {
    expect(teamMemSavedPart({ teamCount: 1 })).toEqual({
      count: 1,
      segment: '1 team memory',
    })
  })

  test('formats plural team memory count', () => {
    expect(teamMemSavedPart({ teamCount: 3 })).toEqual({
      count: 3,
      segment: '3 team memories',
    })
  })
})
