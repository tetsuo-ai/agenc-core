import { describe, expect, test } from 'vitest'

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
  diff,
  diffEach,
  extractHyperlinkFromStyles,
  filterOutHyperlinkStyles,
  isCellEmpty,
  isEmptyCellAt,
  markNoSelectRegion,
  migrateScreenPools,
  resetScreen,
  setCellAt,
  setCellStyleId,
  shiftRows,
  visibleCellAtIndex,
  type Screen,
} from './screen.ts'

function makePools(): {
  styles: StylePool
  chars: CharPool
  links: HyperlinkPool
} {
  return {
    chars: new CharPool(),
    links: new HyperlinkPool(),
    styles: new StylePool(),
  }
}

function makeScreen(rows: string[]): {
  screen: Screen
  styles: StylePool
} {
  const { styles, chars, links } = makePools()
  const width = Math.max(...rows.map(row => row.length))
  const screen = createScreen(width, rows.length, styles, chars, links)

  rows.forEach((row, y) => {
    for (let x = 0; x < width; x++) {
      setCellAt(screen, x, y, {
        char: row[x] ?? ' ',
        hyperlink: undefined,
        styleId: styles.none,
        width: CellWidth.Narrow,
      })
    }
  })
  screen.damage = undefined

  return { screen, styles }
}

describe('screen pools and cell access', () => {
  test('stores cells, styles, hyperlinks, and migrates pools', () => {
    const { styles, chars, links } = makePools()
    const screen = createScreen(4, 2, styles, chars, links)
    const red = styles.intern([
      { code: '\x1b[31m', endCode: '\x1b[39m', type: 'ansi' },
    ])

    setCellAt(screen, 1, 0, {
      char: 'x',
      hyperlink: 'https://example.test',
      styleId: red,
      width: CellWidth.Narrow,
    })

    expect(charInCellAt(screen, 1, 0)).toBe('x')
    expect(charInCellAt(screen, -1, 0)).toBeUndefined()
    expect(cellAt(screen, 1, 0)).toEqual({
      char: 'x',
      hyperlink: 'https://example.test',
      styleId: red,
      width: CellWidth.Narrow,
    })
    expect(cellAt(screen, 9, 9)).toBeUndefined()
    expect(isCellEmpty(screen, cellAt(screen, 0, 0)!)).toBe(true)
    expect(isEmptyCellAt(screen, 0, 0)).toBe(true)
    expect(visibleCellAtIndex(screen.cells, chars, links, 0, -1)).toBeUndefined()
    expect(visibleCellAtIndex(screen.cells, chars, links, 1, -1)).toEqual(
      expect.objectContaining({
        char: 'x',
        hyperlink: 'https://example.test',
      }),
    )

    const newChars = new CharPool()
    const newLinks = new HyperlinkPool()
    migrateScreenPools(screen, newChars, newLinks)
    migrateScreenPools(screen, newChars, newLinks)
    expect(screen.charPool).toBe(newChars)
    expect(screen.hyperlinkPool).toBe(newLinks)
    expect(cellAt(screen, 1, 0)?.hyperlink).toBe('https://example.test')

    resetScreen(screen, 6, 3)
    expect(screen.width).toBe(6)
    expect(screen.height).toBe(3)
    expect(screen.damage).toBeUndefined()
    expect(isEmptyCellAt(screen, 1, 0)).toBe(true)
  })

  test('caches style overlays and parses OSC 8 hyperlink styles', () => {
    const styles = new StylePool()
    const base = styles.intern([
      { code: '\x1b[31m', endCode: '\x1b[39m', type: 'ansi' },
    ])
    const inverse = styles.withInverse(base)
    expect(styles.withInverse(base)).toBe(inverse)
    expect(styles.withCurrentMatch(base)).toBe(styles.withCurrentMatch(base))

    styles.setSelectionBg({
      code: '\x1b[48;2;1;2;3m',
      endCode: '\x1b[49m',
      type: 'ansi',
    })
    const selected = styles.withSelectionBg(base)
    expect(styles.withSelectionBg(base)).toBe(selected)
    styles.setSelectionBg(null)
    expect(styles.withSelectionBg(base)).toBe(inverse)
    expect(styles.transition(base, base)).toBe('')
    expect(styles.transition(styles.none, base)).toContain('\x1b[')

    const osc8 = {
      code: '\x1b]8;;https://example.test\x07',
      endCode: '\x1b]8;;\x07',
      type: 'ansi',
    }
    const invalid = { code: '\x1b]8;bad\x07', endCode: '', type: 'ansi' }
    expect(extractHyperlinkFromStyles([invalid, osc8] as never)).toBe(
      'https://example.test',
    )
    expect(filterOutHyperlinkStyles([osc8, invalid] as never)).toEqual([invalid])
  })
})

describe('screen mutations and diffs', () => {
  test('handles wide-cell cleanup, region clearing, row shifting, and no-select marks', () => {
    const { screen, styles } = makeScreen(['abcd', 'efgh', 'ijkl'])

    setCellAt(screen, 1, 0, {
      char: '\u{597d}',
      hyperlink: undefined,
      styleId: styles.none,
      width: CellWidth.Wide,
    })
    expect(cellAt(screen, 2, 0)?.width).toBe(CellWidth.SpacerTail)

    setCellAt(screen, 2, 0, {
      char: 'z',
      hyperlink: undefined,
      styleId: styles.none,
      width: CellWidth.Narrow,
    })
    expect(cellAt(screen, 1, 0)?.char).toBe(' ')
    expect(cellAt(screen, 2, 0)?.char).toBe('z')

    setCellAt(screen, 0, 1, {
      char: '\u{597d}',
      hyperlink: undefined,
      styleId: styles.none,
      width: CellWidth.Wide,
    })
    clearRegion(screen, 1, 1, 2, 1)
    expect(cellAt(screen, 0, 1)?.char).toBe(' ')
    expect(cellAt(screen, 1, 1)?.width).toBe(CellWidth.Narrow)

    markNoSelectRegion(screen, -2, 0, 3, 2)
    expect(screen.noSelect[0]).toBe(1)
    expect(screen.noSelect[screen.width]).toBe(1)

    screen.softWrap[1] = 4
    shiftRows(screen, 0, 2, 1)
    expect(charInCellAt(screen, 0, 0)).toBe(' ')
    expect(screen.softWrap[2]).toBe(0)

    shiftRows(screen, 0, 2, -1)
    expect(screen.softWrap[0]).toBe(0)

    shiftRows(screen, 0, 2, 9)
    expect(isEmptyCellAt(screen, 0, 0)).toBe(true)
  })

  test('blits regions and reports same-width and resize diffs', () => {
    const { screen: src, styles } = makeScreen(['abcd', 'efgh'])
    const dst = createScreen(4, 2, styles, src.charPool, src.hyperlinkPool)
    src.softWrap[1] = 4
    markNoSelectRegion(src, 1, 0, 1, 1)
    setCellAt(src, 3, 0, {
      char: '\u{597d}',
      hyperlink: undefined,
      styleId: styles.none,
      width: CellWidth.Wide,
    })

    blitRegion(dst, src, 0, 0, 4, 2)
    expect(charInCellAt(dst, 0, 0)).toBe('a')
    expect(dst.noSelect[1]).toBe(1)
    expect(dst.softWrap[1]).toBe(4)
    expect(dst.damage).toEqual({ height: 2, width: 4, x: 0, y: 0 })

    const highlighted = styles.withInverse(styles.none)
    setCellStyleId(dst, 0, 0, highlighted)
    setCellStyleId(dst, 4, 0, highlighted)
    expect(cellAt(dst, 0, 0)?.styleId).toBe(highlighted)

    const sameWidthChanges = diff(src, dst)
    expect(sameWidthChanges.length).toBeGreaterThan(0)

    let stopped = false
    const earlyExit = diffEach(src, dst, () => {
      stopped = true
      return true
    })
    expect(earlyExit).toBe(true)
    expect(stopped).toBe(true)

    const { screen: narrower } = makeScreen(['ab'])
    expect(diff(dst, narrower).length).toBeGreaterThan(0)

    const { screen: emptyPrev } = makeScreen([''])
    resetScreen(emptyPrev, 0, 0)
    expect(diff(emptyPrev, dst).length).toBeGreaterThan(0)
  })
})
