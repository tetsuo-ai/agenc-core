import { describe, expect, test } from 'vitest'

import { findTextObject } from './text-objects.js'

function sliceObject(
  text: string,
  needle: string,
  objectType: string,
  isInner: boolean,
): string | null {
  const range = findTextObject(text, text.indexOf(needle), objectType, isInner)
  return range ? text.slice(range.start, range.end) : null
}

describe('vim text objects', () => {
  test('finds word and WORD objects', () => {
    expect(sliceObject('alpha beta', 'l', 'w', true)).toBe('alpha')
    expect(sliceObject('alpha beta', 'l', 'w', false)).toBe('alpha ')
    expect(sliceObject('alpha-beta gamma', '-', 'W', true)).toBe('alpha-beta')
  })

  test('handles word objects at empty and terminal offsets', () => {
    expect(findTextObject('', 0, 'w', true)).toBeNull()
    expect(findTextObject('alpha', 'alpha'.length, 'w', true)).toEqual({
      start: 0,
      end: 5,
    })
    expect(findTextObject('   ', 3, 'w', true)).toEqual({ start: 0, end: 3 })
  })

  test('finds quote and bracket objects', () => {
    expect(sliceObject('say "hello"', 'e', '"', true)).toBe('hello')
    expect(sliceObject('say "hello"', 'e', '"', false)).toBe('"hello"')
    expect(sliceObject('say "👩‍💻"', '👩', '"', true)).toBe('👩‍💻')
    expect(sliceObject('fn(alpha)', 'p', '(', true)).toBe('alpha')
    expect(sliceObject('arr[zero]', 'e', '[', false)).toBe('[zero]')
    expect(sliceObject('obj{key}', 'e', '{', true)).toBe('key')
  })

  test('covers inner and around delimiter variants', () => {
    const cases = [
      ['fn(alpha)', 'p', '(', true, 'alpha'],
      ['fn(alpha)', 'p', '(', false, '(alpha)'],
      ['fn(alpha)', 'p', ')', false, '(alpha)'],
      ['fn(alpha)', 'p', 'b', false, '(alpha)'],
      ['arr[zero]', 'e', '[', true, 'zero'],
      ['arr[zero]', 'e', '[', false, '[zero]'],
      ['arr[zero]', 'e', ']', false, '[zero]'],
      ['obj{key}', 'e', '{', true, 'key'],
      ['obj{key}', 'e', '{', false, '{key}'],
      ['obj{key}', 'e', '}', false, '{key}'],
      ['obj{key}', 'e', 'B', false, '{key}'],
      ['x<y>z', 'y', '<', false, '<y>'],
      ['x<y>z', 'y', '>', false, '<y>'],
      ["say 'hello'", 'e', "'", true, 'hello'],
      ["say 'hello'", 'e', "'", false, "'hello'"],
      ['say `hello`', 'e', '`', true, 'hello'],
      ['say `hello`', 'e', '`', false, '`hello`'],
    ] as const

    for (const [text, needle, objectType, isInner, expected] of cases) {
      expect(sliceObject(text, needle, objectType, isInner)).toBe(expected)
    }
  })

  test('finds inner and around paragraph objects', () => {
    const text = 'first para\nline two\n\nsecond para\n\nthird'
    expect(sliceObject(text, 'second', 'p', true)).toBe('second para')
    expect(sliceObject(text, 'second', 'p', false)).toBe('second para\n\n')
  })

  test('finds balanced tag objects with attributes and nesting', () => {
    const text = '<div class="x"><span>inner</span><span>next</span></div>'
    expect(sliceObject(text, 'inner', 't', true)).toBe('inner')
    expect(sliceObject(text, 'inner', 't', false)).toBe('<span>inner</span>')

    const nestedSameName = '<div><div>inner</div></div>'
    expect(sliceObject(nestedSameName, 'inner', 't', true)).toBe('inner')
    expect(sliceObject(nestedSameName, 'inner', 't', false)).toBe(
      '<div>inner</div>',
    )
  })

  test('returns null for unsupported tag object shapes', () => {
    expect(findTextObject('<br />after', 1, 't', true)).toBeNull()
    expect(findTextObject('<div>missing', 2, 't', true)).toBeNull()
    expect(findTextObject('plain text', 2, 't', true)).toBeNull()
  })

  test('returns null for unmatched delimiter objects', () => {
    expect(findTextObject('say "missing', 6, '"', true)).toBeNull()
    expect(findTextObject('fn(alpha', 4, '(', true)).toBeNull()
    expect(findTextObject('arr[zero', 5, '[', false)).toBeNull()
  })
})
