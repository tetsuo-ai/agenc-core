import { describe, expect, test } from 'vitest'

import { getTaskListTextWidth } from './TaskListV2.js'

describe('getTaskListTextWidth', () => {
  test('clamps text width to one column for tiny terminals', () => {
    expect(getTaskListTextWidth(0)).toBe(1)
    expect(getTaskListTextWidth(10)).toBe(1)
    expect(getTaskListTextWidth(15)).toBe(1)
  })

  test('subtracts reserved row chrome and owner width when space exists', () => {
    expect(getTaskListTextWidth(80)).toBe(65)
    expect(getTaskListTextWidth(80, 12)).toBe(53)
  })

  test('normalizes invalid dimensions', () => {
    expect(getTaskListTextWidth(Number.NaN)).toBe(1)
    expect(getTaskListTextWidth(80, Number.NaN)).toBe(65)
  })
})
