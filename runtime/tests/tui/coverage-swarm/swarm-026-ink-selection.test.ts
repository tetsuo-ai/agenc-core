import { describe, expect, test } from 'vitest'

import {
  createSelectionState,
  findPlainTextUrlAt,
  getSelectedText,
  hasSelection,
  selectLineAt,
  shiftSelectionForFollow,
} from '../ink/selection.ts'
import {
  CellWidth,
  CharPool,
  HyperlinkPool,
  StylePool,
  createScreen,
  setCellAt,
  type Screen,
} from '../ink/screen.ts'

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
  for (let col = 0; col < text.length; col++) {
    setCellAt(screen, col, row, {
      char: text[col]!,
      hyperlink: undefined,
      styleId: styles.none,
      width: CellWidth.Narrow,
    })
  }
}

describe('selection coverage swarm row 026', () => {
  test('splits a plain-text URL run at the next scheme after the clicked URL', () => {
    const row = 'urls https://first.test/ahttps://second.test/b'
    const { screen, styles } = makeScreen(row.length, 1)
    writeText(screen, styles, 0, row)

    expect(findPlainTextUrlAt(screen, row.indexOf('first'), 0)).toBe(
      'https://first.test/a',
    )
    expect(findPlainTextUrlAt(screen, row.indexOf('second'), 0)).toBe(
      'https://second.test/b',
    )
  })

  test('stops URL expansion at wide cells and still trims unbalanced closers', () => {
    const prefix = 'https://first.test/path)'
    const { screen, styles } = makeScreen(prefix.length + 2, 1)
    writeText(screen, styles, 0, prefix)
    setCellAt(screen, prefix.length, 0, {
      char: '好',
      hyperlink: undefined,
      styleId: styles.none,
      width: CellWidth.Wide,
    })

    expect(findPlainTextUrlAt(screen, prefix.indexOf('first'), 0)).toBe(
      'https://first.test/path',
    )
  })

  test('extracts selections across captured rows and skips wide-cell spacers', () => {
    const { screen, styles } = makeScreen(5, 1)
    writeText(screen, styles, 0, 'A   ')
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

    const selection = createSelectionState()
    selection.anchor = { col: 0, row: 0 }
    selection.focus = { col: 4, row: 0 }
    selection.scrolledOffAbove = ['top ', 'wrap']
    selection.scrolledOffAboveSW = [false, true]
    selection.scrolledOffBelow = [' tail', 'bottom']
    selection.scrolledOffBelowSW = [true, false]

    expect(getSelectedText(selection, screen)).toBe(
      'top wrap\nA好B tail\nbottom',
    )
  })

  test('line selection ignores out-of-bounds rows without disturbing state', () => {
    const { screen } = makeScreen(4, 2)
    const selection = createSelectionState()

    selectLineAt(selection, screen, -1)
    selectLineAt(selection, screen, 2)

    expect(hasSelection(selection)).toBe(false)
    expect(selection.isDragging).toBe(false)
    expect(selection.anchorSpan).toBeNull()
  })

  test('follow scrolling tracks anchor-only selections through bottom clamps', () => {
    const selection = createSelectionState()
    selection.anchor = { col: 2, row: 2 }

    expect(shiftSelectionForFollow(selection, 4, 0, 3)).toBe(false)

    expect(selection.anchor).toEqual({ col: 2, row: 3 })
    expect(selection.focus).toBeNull()
    expect(selection.virtualAnchorRow).toBe(6)
    expect(selection.virtualFocusRow).toBeUndefined()
  })
})
