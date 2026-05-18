import { describe, expect, test } from 'vitest'

import {
  createInitialPersistentState,
  createInitialVimState,
  TEXT_OBJ_TYPES,
} from './types.js'

describe('vim types', () => {
  test('creates insert-mode initial state and empty persistent memory', () => {
    expect(createInitialVimState()).toEqual({
      mode: 'INSERT',
      insertedText: '',
    })
    expect(createInitialPersistentState()).toEqual({
      lastChange: null,
      lastFind: null,
      register: '',
      registerIsLinewise: false,
    })
  })

  test('declares paragraph and tag text object keys', () => {
    expect(TEXT_OBJ_TYPES.has('p')).toBe(true)
    expect(TEXT_OBJ_TYPES.has('t')).toBe(true)
  })

  test('declares delimiter alias text object keys', () => {
    for (const key of [')', ']', '}', 'b', 'B', '<', '>']) {
      expect(TEXT_OBJ_TYPES.has(key)).toBe(true)
    }
  })
})
