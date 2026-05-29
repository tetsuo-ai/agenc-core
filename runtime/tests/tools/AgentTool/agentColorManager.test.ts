import { afterEach, describe, expect, test } from 'vitest'
import { getAgentColor, setAgentColor } from './agentColorManager.js'

describe('getAgentColor', () => {
  afterEach(() => {
    setAgentColor('code-reviewer', undefined)
  })

  test('the default/general-purpose role has no distinct color (canonicalized)', () => {
    // After unifying agents onto the role registry, the generic agent is the
    // `default` role; its public name is `netrunner` and `general-purpose` is an
    // alias. All spellings must canonicalize here and yield no color.
    for (const name of ['default', 'general-purpose', 'netrunner']) {
      expect(getAgentColor(name)).toBeUndefined()
    }
  })

  test('returns the assigned theme color for a custom agent', () => {
    setAgentColor('code-reviewer', 'red')
    expect(getAgentColor('code-reviewer')).toBe('red_FOR_SUBAGENTS_ONLY')
  })

  test('returns undefined for an unknown agent type with no color set', () => {
    expect(getAgentColor('totally-unknown-agent')).toBeUndefined()
  })
})
