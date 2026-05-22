import { describe, expect, test } from 'vitest'
import React from 'react'

import {
  applyPositionedHighlight,
  renderToScreen,
  scanPositions,
} from '../../../src/tui/ink/render-to-screen.ts'
import { Box } from '../../../src/tui/ink.ts'
import {
  CellWidth,
  CharPool,
  HyperlinkPool,
  StylePool,
  cellAt,
  createScreen,
  setCellAt,
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
  col: number,
  row: number,
  char: string,
  width = CellWidth.Narrow,
): void {
  setCellAt(screen, col, row, {
    char,
    hyperlink: undefined,
    styleId: styles.none,
    width,
  })
}

describe('render-to-screen coverage swarm row 249', () => {
  test('returns a positive screen height for empty renders', () => {
    const rendered = renderToScreen(React.createElement(Box), 10)

    expect(rendered.height).toBe(1)
    expect(rendered.screen.height).toBe(1)
  })

  test('scanPositions skips spacer heads and maps folded code units to cells', () => {
    const { screen, styles } = makeScreen(8, 1)
    ;['a', 'a', 'a', 'a', 'x', 'b', '\u0130', 'z'].forEach((char, col) => {
      writeCell(
        screen,
        styles,
        col,
        0,
        char,
        col === 4 ? CellWidth.SpacerHead : CellWidth.Narrow,
      )
    })

    expect(scanPositions(screen, 'aa')).toEqual([
      { col: 0, len: 2, row: 0 },
      { col: 2, len: 2, row: 0 },
    ])
    expect(scanPositions(screen, 'xb')).toEqual([])
    expect(scanPositions(screen, 'i\u0307')).toEqual([
      { col: 6, len: 1, row: 0 },
    ])
  })

  test('applyPositionedHighlight rejects negative indexes and bottom-clipped rows', () => {
    const { screen, styles } = makeScreen(4, 1)
    ;['t', 'e', 's', 't'].forEach((char, col) => {
      writeCell(screen, styles, col, 0, char)
    })

    expect(
      applyPositionedHighlight(
        screen,
        styles,
        [{ col: 0, len: 1, row: 0 }],
        0,
        -1,
      ),
    ).toBe(false)
    expect(
      applyPositionedHighlight(
        screen,
        styles,
        [{ col: 0, len: 1, row: 1 }],
        0,
        0,
      ),
    ).toBe(false)
    expect(cellAt(screen, 0, 0)?.styleId).toBe(styles.none)
  })
})
