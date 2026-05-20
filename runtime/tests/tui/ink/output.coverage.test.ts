import { expect, test } from 'vitest'

import Output from './output.ts'
import {
  CellWidth,
  CharPool,
  HyperlinkPool,
  StylePool,
  charInCellAt,
  createScreen,
  setCellAt,
} from './screen.ts'

test('absolute clears prevent clean blits from restoring stale overlay rows', () => {
  const stylePool = new StylePool()
  const charPool = new CharPool()
  const hyperlinkPool = new HyperlinkPool()
  const source = createScreen(6, 3, stylePool, charPool, hyperlinkPool)
  const target = createScreen(6, 3, stylePool, charPool, hyperlinkPool)

  const rows = ['GHOST!', 'NORMAL', 'TAIL!!']
  for (const [y, row] of rows.entries()) {
    for (const [x, char] of [...row].entries()) {
      setCellAt(source, x, y, {
        char,
        hyperlink: undefined,
        styleId: stylePool.none,
        width: CellWidth.Narrow,
      })
    }
  }

  const output = new Output({
    height: 3,
    screen: target,
    stylePool,
    width: 6,
  })

  output.clear({ height: 1, width: 6, x: 0, y: 0 }, true)
  output.blit(source, 0, 0, 6, 3)

  const screen = output.get()

  expect(charInCellAt(screen, 0, 0)).toBe(' ')
  expect(charInCellAt(screen, 5, 0)).toBe(' ')
  expect(charInCellAt(screen, 0, 1)).toBe('N')
  expect(charInCellAt(screen, 5, 1)).toBe('L')
  expect(charInCellAt(screen, 0, 2)).toBe('T')
  expect(charInCellAt(screen, 5, 2)).toBe('!')
})
