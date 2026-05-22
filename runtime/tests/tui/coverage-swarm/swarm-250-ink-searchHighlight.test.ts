import { describe, expect, test } from 'vitest'

import { applySearchHighlight } from '../../../src/tui/ink/searchHighlight.js'
import {
  CellWidth,
  CharPool,
  HyperlinkPool,
  StylePool,
  cellAt,
  createScreen,
  markNoSelectRegion,
  setCellAt,
  type Screen,
} from '../../../src/tui/ink/screen.js'

function makeScreen(width: number, height: number): {
  screen: Screen
  styles: StylePool
} {
  const styles = new StylePool()
  return {
    screen: createScreen(
      width,
      height,
      styles,
      new CharPool(),
      new HyperlinkPool(),
    ),
    styles,
  }
}

function writeText(
  screen: Screen,
  styles: StylePool,
  row: number,
  text: string,
): void {
  Array.from(text).forEach((char, col) => {
    setCellAt(screen, col, row, {
      char,
      hyperlink: undefined,
      styleId: styles.none,
      width: CellWidth.Narrow,
    })
  })
}

function styleAt(screen: Screen, col: number, row = 0): number {
  return cellAt(screen, col, row)!.styleId
}

describe('searchHighlight coverage swarm row 250', () => {
  test('returns false and leaves styles unchanged for empty or missing queries', () => {
    const emptyQuery = makeScreen(6, 1)
    writeText(emptyQuery.screen, emptyQuery.styles, 0, 'Needle')

    expect(
      applySearchHighlight(emptyQuery.screen, '', emptyQuery.styles),
    ).toBe(false)
    expect(Array.from({ length: 6 }, (_, col) => styleAt(emptyQuery.screen, col)))
      .toEqual(new Array(6).fill(emptyQuery.styles.none))

    const missingQuery = makeScreen(6, 1)
    writeText(missingQuery.screen, missingQuery.styles, 0, 'Needle')

    expect(
      applySearchHighlight(missingQuery.screen, 'absent', missingQuery.styles),
    ).toBe(false)
    expect(
      Array.from({ length: 6 }, (_, col) => styleAt(missingQuery.screen, col)),
    ).toEqual(new Array(6).fill(missingQuery.styles.none))
  })

  test('highlights case-insensitive non-overlapping matches', () => {
    const { screen, styles } = makeScreen(3, 1)
    writeText(screen, styles, 0, 'aAa')

    expect(applySearchHighlight(screen, 'aa', styles)).toBe(true)

    const inverse = styles.withInverse(styles.none)
    expect(styleAt(screen, 0)).toBe(inverse)
    expect(styleAt(screen, 1)).toBe(inverse)
    expect(styleAt(screen, 2)).toBe(styles.none)
  })

  test('skips no-select cells and wide spacer tails when mapping matches', () => {
    const { screen, styles } = makeScreen(4, 1)
    writeText(screen, styles, 0, '>')
    setCellAt(screen, 1, 0, {
      char: '好',
      hyperlink: undefined,
      styleId: styles.none,
      width: CellWidth.Wide,
    })
    setCellAt(screen, 3, 0, {
      char: 'B',
      hyperlink: undefined,
      styleId: styles.none,
      width: CellWidth.Narrow,
    })
    markNoSelectRegion(screen, 0, 0, 1, 1)

    expect(applySearchHighlight(screen, '好b', styles)).toBe(true)

    const inverse = styles.withInverse(styles.none)
    expect(styleAt(screen, 0)).toBe(styles.none)
    expect(styleAt(screen, 1)).toBe(inverse)
    expect(cellAt(screen, 2, 0)!.width).toBe(CellWidth.SpacerTail)
    expect(styleAt(screen, 2)).toBe(styles.none)
    expect(styleAt(screen, 3)).toBe(inverse)
  })

  test('maps lowercase expansions back to the originating visible cell', () => {
    const { screen, styles } = makeScreen(2, 1)
    writeText(screen, styles, 0, 'İx')

    expect(applySearchHighlight(screen, 'İx', styles)).toBe(true)

    const inverse = styles.withInverse(styles.none)
    expect(styleAt(screen, 0)).toBe(inverse)
    expect(styleAt(screen, 1)).toBe(inverse)
  })
})
