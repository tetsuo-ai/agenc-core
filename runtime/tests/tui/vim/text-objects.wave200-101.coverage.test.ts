import { describe, expect, test } from 'vitest'

import { findTextObject } from './text-objects.js'

function sliceAt(
  text: string,
  offset: number,
  objectType: string,
  isInner: boolean,
): string | null {
  const range = findTextObject(text, offset, objectType, isInner)
  return range ? text.slice(range.start, range.end) : null
}

describe('vim text objects wave200-101 coverage', () => {
  test('covers edge paths for words, delimiters, paragraphs, and tags', () => {
    expect(findTextObject('alpha', 0, 'x', true)).toBeNull()

    const punctuation = 'alpha,; beta'
    expect(sliceAt(punctuation, punctuation.indexOf(','), 'w', true)).toBe(',;')
    expect(sliceAt('alpha beta', 'alpha beta'.indexOf('beta'), 'w', false))
      .toBe(' beta')

    const quotedLine = 'first "one"\nsecond "two"'
    expect(sliceAt(quotedLine, quotedLine.indexOf('one'), '"', true)).toBe('one')
    expect(sliceAt(quotedLine, quotedLine.indexOf('two'), '"', false)).toBe(
      '"two"',
    )

    const nestedCall = 'fn(a(b)c)'
    expect(sliceAt(nestedCall, nestedCall.indexOf('c'), '(', true)).toBe(
      'a(b)c',
    )
    expect(findTextObject('alpha)', 2, '(', true)).toBeNull()

    expect(findTextObject('', 0, 'p', true)).toBeNull()
    expect(sliceAt('single paragraph', 3, 'p', true)).toBe('single paragraph')
    expect(sliceAt('first\n \t\nsecond', 1, 'p', false)).toBe('first\n \t\n')
    expect(sliceAt('first\n\nsecond', 'first\n\nsecond'.indexOf('second'), 'p', false))
      .toBe('\n\nsecond')

    const mismatchedTag = '<div></span><p>ok</p></div>'
    expect(sliceAt(mismatchedTag, mismatchedTag.indexOf('ok'), 't', true))
      .toBe('ok')
  })
})
