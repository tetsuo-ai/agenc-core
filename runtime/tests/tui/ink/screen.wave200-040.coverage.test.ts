import { expect, test } from 'vitest'

import {
  CellWidth,
  CharPool,
  HyperlinkPool,
  StylePool,
  blitRegion,
  cellAt,
  charInCellAt,
  clearRegion,
  createScreen,
  diffEach,
  isEmptyCellAt,
  resetScreen,
  setCellAt,
  setCellStyleId,
  shiftRows,
  visibleCellAtIndex,
  type Screen,
} from './screen.ts'

function makePools(): {
  chars: CharPool
  links: HyperlinkPool
  styles: StylePool
} {
  return {
    chars: new CharPool(),
    links: new HyperlinkPool(),
    styles: new StylePool(),
  }
}

function makeScreen(width: number, height: number): {
  screen: Screen
  styles: StylePool
} {
  const { chars, links, styles } = makePools()
  return {
    screen: createScreen(width, height, styles, chars, links),
    styles,
  }
}

function writeCell(
  screen: Screen,
  styles: StylePool,
  x: number,
  y: number,
  char: string,
  width = CellWidth.Narrow,
): void {
  setCellAt(screen, x, y, {
    char,
    hyperlink: undefined,
    styleId: styles.none,
    width,
  })
}

test('preserves packed screen invariants across wide-cell edges and clipped diffs', () => {
  const pools = makePools()
  const normalized = createScreen(3.9, -2, pools.styles, pools.chars, pools.links)
  expect(normalized).toMatchObject({ height: 0, width: 3 })
  expect(isEmptyCellAt(normalized, -1, 0)).toBe(true)

  resetScreen(normalized, 4.8, 2.2)
  expect(normalized).toMatchObject({ height: 2, width: 4 })

  const charPool = new CharPool()
  expect(charPool.get(999)).toBe(' ')
  const nonAscii = charPool.intern('é')
  expect(charPool.intern('é')).toBe(nonAscii)
  expect(new HyperlinkPool().get(0)).toBeUndefined()

  const inverseBoldUnderline = pools.styles.intern([
    { code: '\x1b[7m', endCode: '\x1b[27m', type: 'ansi' },
    { code: '\x1b[1m', endCode: '\x1b[22m', type: 'ansi' },
    { code: '\x1b[4m', endCode: '\x1b[24m', type: 'ansi' },
    { code: '\x1b[31m', endCode: '\x1b[39m', type: 'ansi' },
    { code: '\x1b[48;2;2;3;4m', endCode: '\x1b[49m', type: 'ansi' },
  ])
  const currentMatch = pools.styles.withCurrentMatch(inverseBoldUnderline)
  expect(
    pools.styles.get(currentMatch).map(style => style.endCode),
  ).not.toContain('\x1b[49m')

  const selectionBg = {
    code: '\x1b[48;2;9;8;7m',
    endCode: '\x1b[49m',
    type: 'ansi' as const,
  }
  pools.styles.setSelectionBg(selectionBg)
  const selected = pools.styles.withSelectionBg(inverseBoldUnderline)
  pools.styles.setSelectionBg(selectionBg)
  expect(pools.styles.withSelectionBg(inverseBoldUnderline)).toBe(selected)

  const { screen: wide, styles } = makeScreen(5, 1)
  writeCell(wide, styles, 1, 0, '好', CellWidth.Wide)
  expect(visibleCellAtIndex(wide.cells, wide.charPool, wide.hyperlinkPool, 2, -1))
    .toBeUndefined()

  writeCell(wide, styles, 1, 0, 'x')
  expect(cellAt(wide, 2, 0)).toMatchObject({
    char: ' ',
    width: CellWidth.Narrow,
  })

  writeCell(wide, styles, 1, 0, '好', CellWidth.Wide)
  writeCell(wide, styles, 0, 0, '本', CellWidth.Wide)
  expect(cellAt(wide, 1, 0)?.width).toBe(CellWidth.SpacerTail)
  expect(cellAt(wide, 2, 0)).toMatchObject({
    char: ' ',
    width: CellWidth.Narrow,
  })

  const tailStyle = styles.intern([
    { code: '\x1b[32m', endCode: '\x1b[39m', type: 'ansi' },
  ])
  setCellStyleId(wide, 1, 0, tailStyle)
  expect(cellAt(wide, 1, 0)?.styleId).toBe(styles.none)

  const { screen: src, styles: srcStyles } = makeScreen(4, 1)
  writeCell(src, srcStyles, 1, 0, '界', CellWidth.Wide)
  const dst = createScreen(4, 1, srcStyles, src.charPool, src.hyperlinkPool)
  blitRegion(dst, src, 0, 0, 2, 1)
  expect(cellAt(dst, 2, 0)?.width).toBe(CellWidth.SpacerTail)
  expect(dst.damage).toEqual({ height: 1, width: 3, x: 0, y: 0 })
  blitRegion(dst, src, 3, 0, 2, 1)
  expect(dst.damage).toEqual({ height: 1, width: 3, x: 0, y: 0 })

  const { screen: clearFull, styles: clearStyles } = makeScreen(3, 2)
  writeCell(clearFull, clearStyles, 0, 0, 'a')
  writeCell(clearFull, clearStyles, 1, 1, 'b')
  clearFull.damage = undefined
  clearRegion(clearFull, 0, 0, 3, 2)
  expect(clearFull.damage).toEqual({ height: 2, width: 3, x: 0, y: 0 })
  expect(charInCellAt(clearFull, 1, 1)).toBe(' ')

  const { screen: clearRight, styles: clearRightStyles } = makeScreen(4, 1)
  writeCell(clearRight, clearRightStyles, 2, 0, '語', CellWidth.Wide)
  clearRight.damage = undefined
  clearRegion(clearRight, 1, 0, 2, 1)
  expect(cellAt(clearRight, 3, 0)).toMatchObject({
    char: ' ',
    width: CellWidth.Narrow,
  })
  expect(clearRight.damage).toEqual({ height: 1, width: 3, x: 1, y: 0 })

  writeCell(normalized, pools.styles, 0, 0, 'n')
  shiftRows(normalized, -1, 1, 1)
  expect(charInCellAt(normalized, 0, 0)).toBe('n')

  const { screen: prev, styles: diffStyles } = makeScreen(3, 2)
  const next = createScreen(3, 1, diffStyles, prev.charPool, prev.hyperlinkPool)
  writeCell(prev, diffStyles, 0, 1, 'r')
  let removed: string | undefined
  const stoppedOnRemoval = diffEach(prev, next, (_x, _y, oldCell) => {
    removed = oldCell?.char
    return true
  })
  expect(stoppedOnRemoval).toBe(true)
  expect(removed).toBe('r')

  const wider = createScreen(4, 1, diffStyles, prev.charPool, prev.hyperlinkPool)
  writeCell(wider, diffStyles, 3, 0, 'z')
  let added: string | undefined
  const stoppedOnAddition = diffEach(next, wider, (_x, _y, _oldCell, newCell) => {
    added = newCell?.char
    return true
  })
  expect(stoppedOnAddition).toBe(true)
  expect(added).toBe('z')
})
