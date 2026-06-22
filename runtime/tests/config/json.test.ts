import { describe, expect, test } from 'vitest'

import {
  cloneRecord,
  isPlainRecord,
  stableJson,
} from '../../src/config/json.js'

describe('config JSON helpers', () => {
  test('recognizes plain object records only', () => {
    const nullPrototype = Object.create(null) as Record<string, unknown>
    nullPrototype.enabled = true

    expect(isPlainRecord({ enabled: true })).toBe(true)
    expect(isPlainRecord(nullPrototype)).toBe(true)
    expect(isPlainRecord([])).toBe(false)
    expect(isPlainRecord(new Date())).toBe(false)
    expect(isPlainRecord(null)).toBe(false)
  })

  test('deep clones arrays and plain records', () => {
    const input = {
      nested: { value: 1 },
      list: [{ value: 2 }],
    }

    const cloned = cloneRecord(input)

    expect(cloned).toEqual(input)
    expect(cloned).not.toBe(input)
    expect(cloned.nested).not.toBe(input.nested)
    expect((cloned.list as unknown[])[0]).not.toBe(input.list[0])
  })

  test('serializes with stable recursive key ordering', () => {
    expect(
      stableJson({
        z: 1,
        a: { d: 4, c: 3 },
        list: [{ b: 2, a: 1 }],
      }),
    ).toBe('{"a":{"c":3,"d":4},"list":[{"a":1,"b":2}],"z":1}')
  })
})
