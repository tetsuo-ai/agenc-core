import { describe, expect, test } from 'vitest'

import {
  applySelectionOverlay,
  captureScrolledRows,
  clearSelection,
  createSelectionState,
  extendSelection,
  findPlainTextUrlAt,
  finishSelection,
  getSelectedText,
  hasSelection,
  isCellSelected,
  moveFocus,
  selectLineAt,
  selectionBounds,
  selectWordAt,
  shiftAnchor,
  shiftSelection,
  shiftSelectionForFollow,
  startSelection,
  updateSelection,
} from './selection.ts'
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
} from './screen.ts'

function makeScreen(rows: string[], width = Math.max(...rows.map(r => r.length))): {
  screen: Screen
  styles: StylePool
} {
  const styles = new StylePool()
  const screen = createScreen(
    width,
    rows.length,
    styles,
    new CharPool(),
    new HyperlinkPool(),
  )

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

  return { screen, styles }
}

describe('selection lifecycle', () => {
  test('tracks drag state, normalized bounds, and clearing', () => {
    const selection = createSelectionState()

    updateSelection(selection, 3, 1)
    expect(hasSelection(selection)).toBe(false)
    expect(selectionBounds(selection)).toBeNull()

    startSelection(selection, 2, 1)
    updateSelection(selection, 2, 1)
    expect(selection.focus).toBeNull()
    expect(hasSelection(selection)).toBe(false)

    updateSelection(selection, 5, 1)
    expect(hasSelection(selection)).toBe(true)
    expect(selectionBounds(selection)).toEqual({
      end: { col: 5, row: 1 },
      start: { col: 2, row: 1 },
    })
    expect(isCellSelected(selection, 3, 1)).toBe(true)
    expect(isCellSelected(selection, 1, 1)).toBe(false)
    expect(isCellSelected(selection, 5, 2)).toBe(false)

    updateSelection(selection, 1, 0)
    expect(selectionBounds(selection)).toEqual({
      end: { col: 2, row: 1 },
      start: { col: 1, row: 0 },
    })

    finishSelection(selection)
    expect(selection.isDragging).toBe(false)
    expect(hasSelection(selection)).toBe(true)

    selection.scrolledOffAbove = ['before']
    selection.scrolledOffBelow = ['after']
    selection.scrolledOffAboveSW = [false]
    selection.scrolledOffBelowSW = [true]
    selection.virtualAnchorRow = -1
    selection.virtualFocusRow = 3
    selection.lastPressHadAlt = true
    clearSelection(selection)

    expect(selection).toEqual(createSelectionState())
  })
})

describe('word and line selection', () => {
  test('selects word/path runs, wide characters, and no-select gaps', () => {
    const row = 'xx /usr/bin/bash -> yy'
    const { screen, styles } = makeScreen([row])
    const selection = createSelectionState()
    const pathStart = row.indexOf('/')
    const pathEnd = pathStart + '/usr/bin/bash'.length - 1

    selectWordAt(selection, screen, pathStart + 4, 0)
    expect(selectionBounds(selection)).toEqual({
      end: { col: pathEnd, row: 0 },
      start: { col: pathStart, row: 0 },
    })
    expect(selection.anchorSpan).toEqual({
      hi: { col: pathEnd, row: 0 },
      kind: 'word',
      lo: { col: pathStart, row: 0 },
    })

    clearSelection(selection)
    const arrowStart = row.indexOf('-')
    selectWordAt(selection, screen, arrowStart, 0)
    expect(selectionBounds(selection)).toEqual({
      end: { col: arrowStart, row: 0 },
      start: { col: arrowStart, row: 0 },
    })

    const wide = createScreen(
      4,
      1,
      styles,
      new CharPool(),
      new HyperlinkPool(),
    )
    setCellAt(wide, 1, 0, {
      char: '\u{597d}',
      hyperlink: undefined,
      styleId: styles.none,
      width: CellWidth.Wide,
    })
    clearSelection(selection)
    selectWordAt(selection, wide, 2, 0)
    expect(selectionBounds(selection)).toEqual({
      end: { col: 2, row: 0 },
      start: { col: 1, row: 0 },
    })

    markNoSelectRegion(screen, pathStart, 0, 1, 1)
    clearSelection(selection)
    selectWordAt(selection, screen, pathStart, 0)
    expect(selectionBounds(selection)).toBeNull()
  })

  test('extends word and line selections forward, backward, and over the anchor span', () => {
    const { screen } = makeScreen(['alpha beta', 'gamma', 'delta zeta'])
    const selection = createSelectionState()

    selectWordAt(selection, screen, 1, 0)
    extendSelection(selection, screen, 8, 0)
    expect(selectionBounds(selection)).toEqual({
      end: { col: 9, row: 0 },
      start: { col: 0, row: 0 },
    })

    extendSelection(selection, screen, 1, 0)
    expect(selectionBounds(selection)).toEqual({
      end: { col: 4, row: 0 },
      start: { col: 0, row: 0 },
    })

    extendSelection(selection, screen, 2, -1)
    expect(selection.anchor).toEqual({ col: 4, row: 0 })
    expect(selection.focus).toEqual({ col: 2, row: -1 })

    selectLineAt(selection, screen, 1)
    expect(selectionBounds(selection)).toEqual({
      end: { col: screen.width - 1, row: 1 },
      start: { col: 0, row: 1 },
    })
    extendSelection(selection, screen, 4, 2)
    expect(selectionBounds(selection)).toEqual({
      end: { col: screen.width - 1, row: 2 },
      start: { col: 0, row: 1 },
    })
    extendSelection(selection, screen, 4, 0)
    expect(selectionBounds(selection)).toEqual({
      end: { col: screen.width - 1, row: 1 },
      start: { col: 0, row: 0 },
    })
  })
})

describe('plain URL detection', () => {
  test('finds URLs at a cell and trims only terminal punctuation', () => {
    const rows = [
      'see https://a.test/path).',
      'xhttps://a.com,https://b.com/z?y=1!',
      'file:///tmp/a[0]',
      'not a url',
    ]
    const { screen } = makeScreen(rows)

    expect(findPlainTextUrlAt(screen, rows[0]!.indexOf('a.test'), 0)).toBe(
      'https://a.test/path',
    )
    expect(findPlainTextUrlAt(screen, rows[1]!.indexOf('b.com'), 1)).toBe(
      'https://b.com/z?y=1',
    )
    expect(findPlainTextUrlAt(screen, rows[2]!.indexOf('0'), 2)).toBe(
      'file:///tmp/a[0]',
    )
    expect(findPlainTextUrlAt(screen, 0, 3)).toBeUndefined()
    expect(findPlainTextUrlAt(screen, 0, -1)).toBeUndefined()

    markNoSelectRegion(screen, rows[0]!.indexOf('https'), 0, 5, 1)
    expect(findPlainTextUrlAt(screen, rows[0]!.indexOf('https'), 0)).toBeUndefined()
  })
})

describe('selected text extraction and overlays', () => {
  test('extracts selected text, joins soft-wrapped rows, and skips no-select cells', () => {
    const { screen } = makeScreen(['hello ', 'world ', 'Xskip '], 6)
    const selection = createSelectionState()
    screen.softWrap[1] = 6
    markNoSelectRegion(screen, 0, 2, 1, 1)

    selection.anchor = { col: 0, row: 0 }
    selection.focus = { col: 4, row: 2 }

    expect(getSelectedText(selection, screen)).toBe('hello world\nskip')
  })

  test('captures scrolled rows and resets consumed anchor constraints', () => {
    const { screen } = makeScreen(['abcd', 'efgh', 'ijkl'])
    const selection = createSelectionState()

    selection.anchor = { col: 1, row: 0 }
    selection.focus = { col: 2, row: 2 }
    selection.anchorSpan = {
      hi: { col: 3, row: 0 },
      kind: 'word',
      lo: { col: 1, row: 0 },
    }

    captureScrolledRows(selection, screen, 0, 0, 'above')
    expect(selection.scrolledOffAbove).toEqual(['bcd'])
    expect(selection.scrolledOffAboveSW).toEqual([false])
    expect(selection.anchor).toEqual({ col: 0, row: 0 })
    expect(selection.anchorSpan).toEqual({
      hi: { col: 3, row: 0 },
      kind: 'word',
      lo: { col: 0, row: 0 },
    })

    selection.anchor = { col: 2, row: 2 }
    selection.focus = { col: 1, row: 0 }
    captureScrolledRows(selection, screen, 2, 2, 'below')
    expect(selection.scrolledOffBelow).toEqual(['ijk'])
    expect(selection.anchor).toEqual({ col: 3, row: 2 })
  })

  test('applies selection overlay while preserving no-select cells', () => {
    const { screen, styles } = makeScreen(['abcde'])
    const selection = createSelectionState()
    selection.anchor = { col: 1, row: 0 }
    selection.focus = { col: 3, row: 0 }
    markNoSelectRegion(screen, 2, 0, 1, 1)

    applySelectionOverlay(screen, selection, styles)

    expect(cellAt(screen, 1, 0)?.styleId).not.toBe(styles.none)
    expect(cellAt(screen, 2, 0)?.styleId).toBe(styles.none)
    expect(cellAt(screen, 3, 0)?.styleId).not.toBe(styles.none)
  })
})

describe('selection scrolling adjustments', () => {
  test('moves focus and shifts selection through clamped virtual rows', () => {
    const selection = createSelectionState()
    selection.anchor = { col: 2, row: 1 }
    selection.focus = { col: 3, row: 2 }
    selection.scrolledOffAbove = ['old', 'new']
    selection.scrolledOffAboveSW = [false, true]

    shiftSelection(selection, -2, 0, 2, 5)
    expect(selection.anchor).toEqual({ col: 0, row: 0 })
    expect(selection.focus).toEqual({ col: 3, row: 0 })
    expect(selection.virtualAnchorRow).toBe(-1)

    shiftSelection(selection, 1, 0, 2, 5)
    expect(selection.anchor).toEqual({ col: 0, row: 0 })
    expect(selection.focus).toEqual({ col: 3, row: 1 })
    expect(selection.virtualAnchorRow).toBeUndefined()
    expect(selection.scrolledOffAbove).toEqual([])

    selection.virtualFocusRow = 9
    moveFocus(selection, 4, 2)
    expect(selection.focus).toEqual({ col: 4, row: 2 })
    expect(selection.anchorSpan).toBeNull()
    expect(selection.virtualFocusRow).toBeUndefined()

    shiftSelection(selection, 5, 0, 2, 5)
    expect(hasSelection(selection)).toBe(false)
  })

  test('shifts anchor and follow-scrolled selections without losing virtual debt', () => {
    const selection = createSelectionState()
    selection.anchor = { col: 2, row: 0 }
    selection.focus = { col: 4, row: 1 }
    selection.anchorSpan = {
      hi: { col: 4, row: 1 },
      kind: 'line',
      lo: { col: 0, row: 0 },
    }

    shiftAnchor(selection, -2, 0, 2)
    expect(selection.anchor).toEqual({ col: 2, row: 0 })
    expect(selection.virtualAnchorRow).toBe(-2)
    expect(selection.anchorSpan).toEqual({
      hi: { col: 4, row: 0 },
      kind: 'line',
      lo: { col: 0, row: 0 },
    })

    expect(shiftSelectionForFollow(selection, 1, 0, 2)).toBe(false)
    expect(selection.anchor).toEqual({ col: 2, row: 0 })
    expect(selection.virtualAnchorRow).toBe(-1)

    expect(shiftSelectionForFollow(selection, -5, 0, 2)).toBe(true)
    expect(selection).toEqual(createSelectionState())
  })
})
