import { describe, expect, test } from 'vitest'

import { findTextObject } from 'src/tui/vim/text-objects.js'

function sliceAt(
  text: string,
  offset: number,
  objectType: string,
  isInner: boolean,
): string | null {
  const range = findTextObject(text, offset, objectType, isInner)
  return range ? text.slice(range.start, range.end) : null
}

describe('vim text objects coverage swarm row 198', () => {
  test('covers word object classification and around-whitespace branches', () => {
    expect(sliceAt('alpha   beta', 'alpha   beta'.indexOf(' '), 'w', false))
      .toBe('   ')
    expect(sliceAt('alpha,; beta', 'alpha,; beta'.indexOf(','), 'w', false))
      .toBe(',; ')
    expect(findTextObject('alpha', 1, 'w', false)).toEqual({
      start: 0,
      end: 5,
    })
  })

  test('returns null when quote pairs exist but the cursor is outside them', () => {
    const text = '"one" middle "two"'

    expect(findTextObject(text, text.indexOf('middle'), '"', true)).toBeNull()
  })

  test('extends around paragraphs across trailing and leading blank lines', () => {
    expect(sliceAt('first\n\n', 1, 'p', false)).toBe('first\n\n')
    expect(
      sliceAt(
        'first\n \t\nsecond',
        'first\n \t\nsecond'.indexOf('second'),
        'p',
        false,
      ),
    ).toBe('\nsecond')
  })

  test('clamps tag offsets and selects the smallest containing tag', () => {
    const singleTag = '<x>ok</x>'
    expect(sliceAt(singleTag, Number.POSITIVE_INFINITY, 't', true)).toBe('ok')
    expect(sliceAt(singleTag, Number.NEGATIVE_INFINITY, 't', false)).toBe(
      singleTag,
    )

    const nested = '<outer><inner>value</inner></outer>'
    expect(sliceAt(nested, nested.indexOf('value'), 't', false)).toBe(
      '<inner>value</inner>',
    )
  })
})
