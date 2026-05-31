/**
 * Regression test for the "tui-copy-scope" bug: mouse drag copy-on-select
 * copied the ENTIRE screen width (left file-tree + middle transcript + right
 * Agents rail) instead of only the middle transcript.
 *
 * The fix wraps the side panes (ProjectExplorer, AgentsRail) in <NoSelect> in
 * WorkbenchLayout, which marks their columns as noSelect on the shared screen
 * framebuffer. A full WorkbenchLayout render test is impractical (heavy
 * context deps), so this exercises the load-bearing primitive: a full-width
 * selection across a screen whose side columns are noSelect must yield ONLY
 * the middle (selectable) columns from getSelectedText, and applySelectionOverlay
 * must skip the noSelect cells.
 */

import { describe, expect, it } from 'vitest'

import {
  createSelectionState,
  getSelectedText,
  selectLineAt,
  applySelectionOverlay,
} from '../../../src/tui/ink/selection.js'
import {
  CharPool,
  CellWidth,
  HyperlinkPool,
  StylePool,
  cellAt,
  createScreen,
  markNoSelectRegion,
  setCellAt,
} from '../../../src/tui/ink/screen.js'

/** Build a 1-row screen and write `text` starting at column `x0`. */
function makeScreen(
  width: number,
  cells: { x: number; char: string }[],
): ReturnType<typeof createScreen> {
  const styles = new StylePool()
  const screen = createScreen(width, 1, styles, new CharPool(), new HyperlinkPool())
  for (const { x, char } of cells) {
    setCellAt(screen, x, 0, {
      char,
      styleId: styles.none,
      width: CellWidth.Narrow,
      hyperlink: undefined,
    })
  }
  return screen
}

describe('selection scope: noSelect side panes', () => {
  // Layout: [LEFT explorer | MID transcript | RIGHT agents] on one row.
  //  cols 0-2 = "LLL" (explorer, noSelect)
  //  cols 3-5 = "MID" (transcript, selectable)
  //  cols 6-8 = "RRR" (agents, noSelect)
  const width = 9
  const cellsFor = () => [
    { x: 0, char: 'L' },
    { x: 1, char: 'L' },
    { x: 2, char: 'L' },
    { x: 3, char: 'M' },
    { x: 4, char: 'I' },
    { x: 5, char: 'D' },
    { x: 6, char: 'R' },
    { x: 7, char: 'R' },
    { x: 8, char: 'R' },
  ]

  it('full-width selection copies only the middle columns when sides are noSelect', () => {
    const screen = makeScreen(width, cellsFor())
    // Mark explorer (cols 0-2) and agents (cols 6-8) noSelect, exactly as
    // wrapping the panes in <NoSelect> does via markNoSelectRegion in output.ts.
    markNoSelectRegion(screen, 0, 0, 3, 1)
    markNoSelectRegion(screen, 6, 0, 3, 1)

    const sel = createSelectionState()
    // Select the entire row (col 0 .. width-1), simulating a drag that spans
    // the whole screen width.
    selectLineAt(sel, screen, 0)

    expect(getSelectedText(sel, screen)).toBe('MID')
  })

  it('without noSelect, full-width selection copies all three panes (the bug)', () => {
    const screen = makeScreen(width, cellsFor())
    const sel = createSelectionState()
    selectLineAt(sel, screen, 0)

    // Sanity: this is the pre-fix behavior the noSelect wrapping prevents.
    expect(getSelectedText(sel, screen)).toBe('LLLMIDRRR')
  })

  it('applySelectionOverlay leaves noSelect side cells unstyled', () => {
    const styles = new StylePool()
    const screen = createScreen(width, 1, styles, new CharPool(), new HyperlinkPool())
    for (const { x, char } of cellsFor()) {
      setCellAt(screen, x, 0, {
        char,
        styleId: styles.none,
        width: CellWidth.Narrow,
        hyperlink: undefined,
      })
    }
    markNoSelectRegion(screen, 0, 0, 3, 1)
    markNoSelectRegion(screen, 6, 0, 3, 1)

    const sel = createSelectionState()
    selectLineAt(sel, screen, 0)
    applySelectionOverlay(screen, sel, styles)

    // Side (noSelect) cells keep the base style; middle cells get a
    // selection background style id (different from base).
    expect(cellAt(screen, 0, 0)!.styleId).toBe(styles.none)
    expect(cellAt(screen, 8, 0)!.styleId).toBe(styles.none)
    expect(cellAt(screen, 4, 0)!.styleId).not.toBe(styles.none)
  })
})
