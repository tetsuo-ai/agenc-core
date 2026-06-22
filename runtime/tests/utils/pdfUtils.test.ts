import { describe, expect, test } from 'vitest'

import { parsePDFPageRange } from '../../src/utils/pdfUtils.js'

describe('parsePDFPageRange', () => {
  test.each([
    ['5', { firstPage: 5, lastPage: 5 }],
    [' 1-10 ', { firstPage: 1, lastPage: 10 }],
    ['3-', { firstPage: 3, lastPage: Infinity }],
  ])('parses %s', (raw, expected) => {
    expect(parsePDFPageRange(raw)).toEqual(expected)
  })

  test.each(['', '0', '0-1', '2-1', '1abc', '1-2abc', '1-2-3'])(
    'rejects malformed page range %s',
    raw => {
      expect(parsePDFPageRange(raw)).toBeNull()
    },
  )
})
