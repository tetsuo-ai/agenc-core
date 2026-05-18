import { describe, expect, test } from 'vitest'

import {
  expandPastedTextRefs,
  formatImageRef,
  formatPastedTextRef,
  getPastedTextRefNumLines,
  parseReferences,
} from './history.js'

describe('history paste references', () => {
  test('formats text and image references', () => {
    expect(formatPastedTextRef(1, 0)).toBe('[Pasted text #1]')
    expect(formatPastedTextRef(2, 3)).toBe('[Pasted text #2 +3 lines]')
    expect(formatImageRef(4)).toBe('[Image #4]')
  })

  test('counts newline separators for pasted text reference labels', () => {
    expect(getPastedTextRefNumLines('one line')).toBe(0)
    expect(getPastedTextRefNumLines('one\ntwo\r\nthree\rfour')).toBe(3)
  })

  test('parses positive pasted text, image, and truncated text references', () => {
    const input = 'a [Pasted text #1 +2 lines] b [Image #2] c [...Truncated text #3.] z [Image #0]'

    expect(parseReferences(input)).toEqual([
      {
        id: 1,
        match: '[Pasted text #1 +2 lines]',
        index: 2,
      },
      {
        id: 2,
        match: '[Image #2]',
        index: 30,
      },
      {
        id: 3,
        match: '[...Truncated text #3.]',
        index: 43,
      },
    ])
  })

  test('expands text refs without re-parsing placeholders inside pasted content', () => {
    const expanded = expandPastedTextRefs('A [Pasted text #1] B [Image #2] C [Pasted text #3]', {
      1: {
        id: 1,
        type: 'text',
        content: 'first [Pasted text #3]',
      },
      2: {
        id: 2,
        type: 'image',
        content: '<binary>',
        mediaType: 'image/png',
      },
      3: {
        id: 3,
        type: 'text',
        content: 'third',
      },
    })

    expect(expanded).toBe('A first [Pasted text #3] B [Image #2] C third')
  })
})
