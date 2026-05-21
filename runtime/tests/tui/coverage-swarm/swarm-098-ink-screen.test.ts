import { describe, expect, test } from 'vitest'

import {
  CellWidth,
  CharPool,
  HyperlinkPool,
  StylePool,
  cellAt,
  charInCellAt,
  createScreen,
  diffEach,
  extractHyperlinkFromStyles,
  filterOutHyperlinkStyles,
  resetScreen,
  setCellAt,
  visibleCellAtIndex,
  type Screen,
} from '../../../src/tui/ink/screen.ts'

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

function writeCell(
  screen: Screen,
  styles: StylePool,
  x: number,
  y: number,
  char: string,
  styleId = styles.none,
): void {
  setCellAt(screen, x, y, {
    char,
    hyperlink: undefined,
    styleId,
    width: CellWidth.Narrow,
  })
}

describe('screen coverage swarm row 098', () => {
  test('reset reuses larger buffers while clearing active cells and markers', () => {
    const { screen, styles } = makeScreen(4, 2)
    const cells = screen.cells
    const cells64 = screen.cells64
    const noSelect = screen.noSelect
    const softWrap = screen.softWrap

    writeCell(screen, styles, 0, 0, 'x')
    screen.noSelect[0] = 1
    screen.softWrap[0] = 2

    resetScreen(screen, 2, 1)

    expect(screen.cells).toBe(cells)
    expect(screen.cells64).toBe(cells64)
    expect(screen.noSelect).toBe(noSelect)
    expect(screen.softWrap).toBe(softWrap)
    expect(screen).toMatchObject({ height: 1, width: 2 })
    expect(charInCellAt(screen, 0, 0)).toBe(' ')
    expect(screen.noSelect[0]).toBe(0)
    expect(screen.softWrap[0]).toBe(0)
    expect(screen.damage).toBeUndefined()
  })

  test('foreground-only styled spaces are visible only when style changes', () => {
    const { screen, styles } = makeScreen(3, 1)
    const foreground = styles.intern([
      { code: '\x1b[31m', endCode: '\x1b[39m', type: 'ansi' },
    ])
    const background = styles.intern([
      { code: '\x1b[48;2;1;2;3m', endCode: '\x1b[49m', type: 'ansi' },
    ])

    writeCell(screen, styles, 0, 0, ' ', foreground)
    writeCell(screen, styles, 1, 0, ' ', background)

    expect(
      visibleCellAtIndex(
        screen.cells,
        screen.charPool,
        screen.hyperlinkPool,
        0,
        foreground,
      ),
    ).toBeUndefined()
    expect(
      visibleCellAtIndex(
        screen.cells,
        screen.charPool,
        screen.hyperlinkPool,
        0,
        styles.none,
      ),
    ).toMatchObject({ char: ' ', styleId: foreground })
    expect(
      visibleCellAtIndex(
        screen.cells,
        screen.charPool,
        screen.hyperlinkPool,
        1,
        background,
      ),
    ).toMatchObject({ char: ' ', styleId: background })
  })

  test('diffs same-width height growth while skipping empty additions', () => {
    const { screen: prev, styles } = makeScreen(3, 1)
    const next = createScreen(3, 3, styles, prev.charPool, prev.hyperlinkPool)
    writeCell(next, styles, 1, 2, 'z')
    next.damage = { x: 0, y: 1, width: 3, height: 2 }

    const changes: Array<{
      added: string | undefined
      removed: string | undefined
      x: number
      y: number
    }> = []
    const stopped = diffEach(prev, next, (x, y, removed, added) => {
      changes.push({ added: added?.char, removed: removed?.char, x, y })
    })

    expect(stopped).toBe(false)
    expect(changes).toEqual([
      { added: 'z', removed: undefined, x: 1, y: 2 },
    ])
  })

  test('empty OSC 8 hyperlinks parse as null and are filtered from styles', () => {
    const emptyOsc8 = {
      code: '\x1b]8;;\x07',
      endCode: '\x1b]8;;\x07',
      type: 'ansi' as const,
    }
    const textStyle = {
      code: '\x1b[1m',
      endCode: '\x1b[22m',
      type: 'ansi' as const,
    }

    expect(extractHyperlinkFromStyles([textStyle, emptyOsc8])).toBeNull()
    expect(filterOutHyperlinkStyles([textStyle, emptyOsc8])).toEqual([
      textStyle,
    ])
  })

  test('style overlays preserve already inverse styles without duplicate codes', () => {
    const { styles } = makeScreen(1, 1)
    const inverse = styles.intern([
      { code: '\x1b[7m', endCode: '\x1b[27m', type: 'ansi' },
    ])

    expect(styles.withInverse(inverse)).toBe(inverse)
    expect(styles.get(9999)).toEqual([])
  })

  test('cell views tolerate stale packed hyperlink ids', () => {
    const { screen, styles } = makeScreen(1, 1)

    writeCell(screen, styles, 0, 0, 'a')
    screen.cells[1] = 7 << 2

    expect(cellAt(screen, 0, 0)).toMatchObject({
      char: 'a',
      hyperlink: undefined,
    })
  })
})
