import { expect, test } from 'vitest'

import Output from './output.ts'
import {
  CellWidth,
  CharPool,
  HyperlinkPool,
  StylePool,
  cellAt,
  charInCellAt,
  createScreen,
} from './screen.ts'

test('write skips terminal controls while preserving terminal cell positions', () => {
  const stylePool = new StylePool()
  const screen = createScreen(
    16,
    2,
    stylePool,
    new CharPool(),
    new HyperlinkPool(),
  )
  const output = new Output({
    height: 2,
    screen,
    stylePool,
    width: 16,
  })

  output.write(
    1,
    0,
    'A\tB\x1b[2JC\x1b(BD\x1b7E\x1b]0;title\x07F\x1bPpayload\x1b\\G\x07H',
  )
  output.write(0, 1, '\u200bZ')
  output.write(15, 1, '\u597d')

  const rendered = output.get()

  expect(charInCellAt(rendered, 1, 0)).toBe('A')
  expect(charInCellAt(rendered, 8, 0)).toBe('B')
  expect(charInCellAt(rendered, 9, 0)).toBe('C')
  expect(charInCellAt(rendered, 10, 0)).toBe('D')
  expect(charInCellAt(rendered, 11, 0)).toBe('E')
  expect(charInCellAt(rendered, 12, 0)).toBe('F')
  expect(charInCellAt(rendered, 13, 0)).toBe('G')
  expect(charInCellAt(rendered, 14, 0)).toBe('H')
  expect(charInCellAt(rendered, 0, 1)).toBe('Z')
  expect(cellAt(rendered, 15, 1)).toEqual(
    expect.objectContaining({
      char: ' ',
      width: CellWidth.SpacerHead,
    }),
  )
})
