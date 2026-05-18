import { describe, expect, test } from 'vitest'

import { TextCursor } from '../../utils/TextCursor.js'
import { isInclusiveMotion, isLinewiseMotion, resolveMotion } from './motions.js'

function cursor(text: string, offset = 0, columns = 80): TextCursor {
  return TextCursor.fromText(text, columns, offset)
}

describe('vim motions', () => {
  test('resolves character, word, line, and file motions', () => {
    const text = 'one two\nthree four'
    expect(resolveMotion('l', cursor(text), 2).offset).toBe(2)
    expect(resolveMotion('h', cursor(text, 2), 1).offset).toBe(1)
    expect(resolveMotion('w', cursor(text), 1).offset).toBe(4)
    expect(resolveMotion('b', cursor(text, 4), 1).offset).toBe(0)
    expect(resolveMotion('e', cursor(text), 1).offset).toBe(2)
    expect(resolveMotion('W', cursor(text), 1).offset).toBe(4)
    expect(resolveMotion('0', cursor(text, 4), 1).offset).toBe(0)
    expect(resolveMotion('$', cursor(text), 1).offset).toBe(7)
    expect(resolveMotion('G', cursor(text), 1).offset).toBe(8)
  })

  test('covers counted vertical, WORD, first-nonblank, and visual-line motions', () => {
    expect(resolveMotion('j', cursor('a\nb\nc'), 5).offset).toBe(5)
    expect(resolveMotion('k', cursor('a\nb\nc', 4), 2).offset).toBe(0)
    expect(resolveMotion('B', cursor('one-two three', 8), 1).offset).toBe(0)
    expect(resolveMotion('E', cursor('one-two three'), 1).offset).toBe(6)
    expect(resolveMotion('^', cursor('  one'), 1).offset).toBe(2)
    expect(resolveMotion('gj', cursor('abcd', 0, 2), 1).offset).toBe(1)
    expect(resolveMotion('gk', cursor('abcd', 2, 2), 1).offset).toBe(1)
  })

  test('resolves g-prefixed previous word-end motions', () => {
    const text = 'one two three'
    expect(resolveMotion('ge', cursor(text, text.indexOf('three')), 1).offset).toBe(6)
    expect(resolveMotion('gE', cursor(text, text.indexOf('three')), 1).offset).toBe(6)
  })

  test('classifies inclusive and linewise operator motions', () => {
    expect(isInclusiveMotion('e')).toBe(true)
    expect(isInclusiveMotion('ge')).toBe(true)
    expect(isInclusiveMotion('gE')).toBe(true)
    expect(isLinewiseMotion('gg')).toBe(true)
    expect(isLinewiseMotion('gj')).toBe(false)
  })
})
