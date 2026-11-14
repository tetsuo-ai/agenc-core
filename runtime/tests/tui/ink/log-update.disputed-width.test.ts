/**
 * A partial repaint must not corrupt a row when the terminal draws an emoji
 * wider or narrower than the program counts.
 *
 * Owner report (2026-11-11, second screenshot): lines with an emoji showed
 * "ImagenpMagisk", "fmstboot", and a stray letter stood at the right edge.
 * The program counted U+2705 as one cell, the terminal drew two, and every
 * repaint after that wrote into cells one column off.
 *
 * The width tables are fixed elsewhere. These tests pin the second line of
 * defence in the writer: after a cluster of disputed width the cursor is put
 * back to the column the program counts from, and the cell after it is
 * written again. They replay the patches on a toy terminal whose widths
 * differ from the program's.
 */
import { describe, expect, test } from 'vitest'

import type { Diff, Frame } from './frame.ts'
import { LogUpdate } from './log-update.ts'
import {
  CellWidth,
  CharPool,
  createScreen,
  HyperlinkPool,
  setCellAt,
  StylePool,
} from './screen.ts'

type Cluster = { text: string; modelWidth: 1 | 2 }
type Row = Array<string | Cluster>

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

function harness() {
  const stylePool = new StylePool()
  const charPool = new CharPool()
  const hyperlinkPool = new HyperlinkPool()
  const log = new LogUpdate({ isTTY: true, stylePool })

  /** A frame from rows of plain text and clusters with the width the program gives them. */
  function frame(rows: Row[], width: number): Frame {
    const screen = createScreen(width, rows.length, stylePool, charPool, hyperlinkPool)
    rows.forEach((row, y) => {
      let x = 0
      for (const part of row) {
        const clusters: Cluster[] =
          typeof part === 'string'
            ? [...part].map(char => ({ text: char, modelWidth: 1 as const }))
            : [part]
        for (const cluster of clusters) {
          setCellAt(screen, x, y, {
            char: cluster.text,
            styleId: stylePool.none,
            width: cluster.modelWidth === 2 ? CellWidth.Wide : CellWidth.Narrow,
          })
          x += cluster.modelWidth
        }
      }
    })
    return {
      screen,
      viewport: { width, height: rows.length },
      cursor: { x: 0, y: 0, visible: false },
    }
  }
  return { log, frame }
}

/** A terminal with its own idea of how wide a cluster is. */
class ToyTerminal {
  readonly grid: string[][]
  private x = 0
  private y = 0

  constructor(
    readonly width: number,
    height: number,
    private readonly cellsOf: (cluster: string) => number,
  ) {
    this.grid = Array.from({ length: height }, () => Array<string>(width).fill(' '))
  }

  /** Apply one frame. On the alt screen every frame starts from the home position. */
  apply(diff: Diff): void {
    this.x = 0
    this.y = 0
    for (const patch of diff) {
      if (patch.type === 'carriageReturn') this.x = 0
      else if (patch.type === 'cursorTo') this.x = Math.min(this.width - 1, patch.col - 1)
      else if (patch.type === 'cursorMove') {
        this.x = Math.max(0, Math.min(this.width - 1, this.x + patch.x))
        this.y = Math.max(0, Math.min(this.grid.length - 1, this.y + patch.y))
      } else if (patch.type === 'stdout') this.print(patch.content)
    }
  }

  private print(content: string): void {
    // Escape sequences (scroll region) do not occur in these frames.
    if (content.includes('\x1b')) return
    for (const { segment } of segmenter.segment(content)) {
      const cells = this.cellsOf(segment)
      if (this.x + cells > this.width) continue
      this.grid[this.y]![this.x] = segment
      if (cells === 2) this.grid[this.y]![this.x + 1] = ''
      this.x = Math.min(this.width - 1, this.x + cells)
    }
  }

  /** One row as text. */
  row(y: number): string {
    return this.grid[y]!.join('').trimEnd()
  }

  /** The cell index at which `needle` starts in row y. */
  columnOf(y: number, needle: string): number {
    const cells = this.grid[y]!
    for (let x = 0; x < cells.length; x += 1) {
      if (cells.slice(x).join('').startsWith(needle)) return x
    }
    return -1
  }
}

const WIDTH = 40
const CHECK = '✅'
const WARNING_TEXT = '⚠'
const WARNING_EMOJI = '⚠️'
const FAMILY = '👨‍👩‍👧'

describe('a repaint next to a cluster of disputed width', () => {
  test('a cluster the terminal draws one cell wider does not move the text after it', () => {
    // The program counts one cell (as it did for U+2705 before the fix, and
    // as it does for a text symbol that some terminals draw as an emoji).
    for (const symbol of [CHECK, WARNING_TEXT, '↔', '©']) {
      const { log, frame } = harness()
      const terminal = new ToyTerminal(WIDTH, 2, cluster => (cluster === symbol ? 2 : 1))
      const blank = frame([[''], ['']], WIDTH)
      const first = frame([['2. ', { text: symbol, modelWidth: 1 }, ' Imagen Magisk generada'], ['']], WIDTH)
      terminal.apply(log.render(blank, first, true, false))
      // "Imagen" starts where the program put it: column 5.
      expect([symbol, terminal.columnOf(0, 'Imagen Magisk generada')]).toEqual([symbol, 5])

      // A later repaint changes one word far to the right.
      const second = frame([['2. ', { text: symbol, modelWidth: 1 }, ' Imagen Magisk validada'], ['']], WIDTH)
      terminal.apply(log.render(first, second, true, false))
      expect([symbol, terminal.columnOf(0, 'Imagen Magisk validada')]).toEqual([symbol, 5])
      // Nothing is left behind after the end of the text.
      expect(terminal.row(0).endsWith('Imagen Magisk validada')).toBe(true)
    }
  })

  test('a cluster the terminal draws one cell narrower leaves no gap or stale cell', () => {
    // The program counts two cells for a symbol with U+FE0F. A terminal that
    // ignores the selector draws one.
    const { log, frame } = harness()
    const terminal = new ToyTerminal(WIDTH, 2, () => 1)
    const before = frame([['3. xxxxxxxx rechazó'], ['']], WIDTH)
    terminal.apply(log.render(frame([[''], ['']], WIDTH), before, true, false))
    const after = frame([['3. ', { text: WARNING_EMOJI, modelWidth: 2 }, ' fastboot rechazó'], ['']], WIDTH)
    terminal.apply(log.render(before, after, true, false))
    expect(terminal.columnOf(0, 'fastboot rechazó')).toBe(6)
    // The second cell of the cluster holds a space, not an old "x".
    expect(terminal.grid[0]![4]).toBe(' ')
  })

  test('the cells a cluster can cover are written again, even when they did not change', () => {
    // The terminal draws the family as three wide glyphs (six cells), as a
    // terminal without cluster support does. The program counts two cells.
    const { log, frame } = harness()
    const terminal = new ToyTerminal(WIDTH, 2, cluster => (cluster === FAMILY ? 6 : cluster === CHECK ? 2 : 1))
    const before = frame([['a ', { text: CHECK, modelWidth: 2 }, ' familia ok'], ['']], WIDTH)
    terminal.apply(log.render(frame([[''], ['']], WIDTH), before, true, false))
    // Only the emoji changes. The text after it is the same cells as before.
    const after = frame([['a ', { text: FAMILY, modelWidth: 2 }, ' familia ok'], ['']], WIDTH)
    const diff = log.render(before, after, true, false)
    const written = diff
      .filter((patch): patch is { type: 'stdout'; content: string } => patch.type === 'stdout')
      .map(patch => patch.content)
      .join('')
    // The cluster, then the four cells its extra glyphs covered.
    expect(written.endsWith(`${FAMILY} fam`)).toBe(true)
    // The cursor goes back to the column after the two cells we count.
    expect(diff.some(patch => patch.type === 'cursorTo' && patch.col === 5)).toBe(true)
    terminal.apply(diff)
    expect(terminal.columnOf(0, ' familia ok')).toBe(4)
  })

  test('plain text, box drawing and CJK get no extra cursor moves', () => {
    const { log, frame } = harness()
    const blank = frame([[''], ['']], WIDTH)
    const next = frame([['│ Fase ', { text: '日', modelWidth: 2 }, { text: '本', modelWidth: 2 }, ' ─ ok é'], ['']], WIDTH)
    const diff = log.render(blank, next, true, false)
    expect(diff.some(patch => patch.type === 'cursorTo')).toBe(false)
  })

  test('where terminal and program agree the result is the same as without the moves', () => {
    const { log, frame } = harness()
    const terminal = new ToyTerminal(WIDTH, 2, cluster => (cluster === CHECK || cluster === WARNING_EMOJI ? 2 : 1))
    const next = frame(
      [
        ['1. ', { text: CHECK, modelWidth: 2 }, ' Backup completo'],
        ['3. ', { text: WARNING_EMOJI, modelWidth: 2 }, ' fastboot'],
      ],
      WIDTH,
    )
    terminal.apply(log.render(frame([[''], ['']], WIDTH), next, true, false))
    expect(terminal.row(0)).toBe(`1. ${CHECK} Backup completo`)
    expect(terminal.row(1)).toBe(`3. ${WARNING_EMOJI} fastboot`)
  })
})
