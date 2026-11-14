import React from 'react'
import { describe, expect, test } from 'vitest'

import { renderToAnsiString } from '../../utils/staticRender.js'
import { Box, Text } from '../ink.js'
import wrapText from './wrap-text.js'

describe('wrap-trim keeps the indent of a line', () => {
  test('continuation rows drop the space at the wrap point', () => {
    expect(wrapText('aaa bbb ccc', 7, 'wrap-trim')).toBe('aaa bbb\nccc')
  })

  test('an indented line keeps its indent on every row', () => {
    expect(wrapText('    foo bar baz', 9, 'wrap-trim')).toBe('    foo\n    bar\n    baz')
    expect(wrapText('  - item one two', 12, 'wrap-trim')).toBe('  - item one\n  two')
  })

  test('each source line keeps its own indent', () => {
    expect(wrapText('a\n  b\n    c d', 80, 'wrap-trim')).toBe('a\n  b\n    c d')
    expect(wrapText('if (x) {\n  return 1\n}', 80, 'wrap-trim')).toBe('if (x) {\n  return 1\n}')
  })

  test('a tab indent becomes the next tab stop', () => {
    expect(wrapText('\tx y', 80, 'wrap-trim')).toBe('        x y')
  })

  test('a very deep indent still leaves half the width for text', () => {
    expect(wrapText(`${' '.repeat(30)}abc def`, 10, 'wrap-trim')).toBe('     abc\n     def')
  })

  test('a long word breaks without losing a character', () => {
    const wrapped = wrapText('  0123456789abcdef', 10, 'wrap-trim')
    expect(wrapped).toBe('  01234567\n  89abcdef')
  })

  test('blank and space-only lines stay empty', () => {
    expect(wrapText('a\n\n   \nb', 10, 'wrap-trim')).toBe('a\n\n\nb')
  })
})

describe('styles stay on their characters when an indented line wraps', () => {
  const BOLD_ON = '\x1b[1m'
  const BOLD_OFF = '\x1b[22m'

  /** The characters between bold on and bold off, over all rows, without spaces. */
  function boldText(ansi: string): string {
    let bold = false
    let text = ''
    for (const part of ansi.split(/(\x1b\[[0-9;]*m)/)) {
      if (part === BOLD_ON) bold = true
      else if (part === BOLD_OFF || part === '\x1b[0m') bold = false
      else if (bold && !part.startsWith('\x1b')) text += part
    }
    return text.replace(/\s+/g, '')
  }

  test.each([14, 16, 18, 20, 24, 30])('at %i columns', async width => {
    const ansi = await renderToAnsiString(
      <Box width={width}>
        <Text wrap="wrap-trim">
          {'    - one two three '}
          <Text bold>BOLD WORDS</Text>
          {' four five six '}
          <Text bold>END</Text>
        </Text>
      </Box>,
      { columns: width, rows: 40, color: true },
    )
    expect(boldText(ansi)).toBe('BOLDWORDSEND')
  })
})
