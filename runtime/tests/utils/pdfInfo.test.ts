import { describe, expect, test } from 'vitest'

import { parsePDFInfoPageCount } from '../../src/utils/pdfInfo.js'

describe('parsePDFInfoPageCount', () => {
  test('returns a positive page count from pdfinfo output', () => {
    expect(parsePDFInfoPageCount('Title: Demo\nPages: 12\n')).toBe(12)
  })

  test.each(['', 'Title: Demo\n', 'Pages: 0\n', 'Pages: abc\n'])(
    'returns null for invalid page count output %s',
    stdout => {
      expect(parsePDFInfoPageCount(stdout)).toBeNull()
    },
  )
})
