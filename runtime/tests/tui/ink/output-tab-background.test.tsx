import React from 'react'
import { expect, test } from 'vitest'

import Output from '../../../src/tui/ink/output.ts'
import { RawAnsi } from '../../../src/tui/ink/components/RawAnsi.js'
import {
  CharPool,
  HyperlinkPool,
  StylePool,
  cellAt,
  createScreen,
} from '../../../src/tui/ink/screen.ts'
import { renderToAnsiString } from '../../../src/utils/staticRender.js'

// Regression: a tab-indented added line in a diff card (e.g. a Makefile recipe
// `\t@echo ...`) used to show a dark "notch" — the added-line background
// (48;5;23) ran from the `+` marker, switched OFF over the columns where the
// leading TAB expanded, then back ON for the content. The cause was
// writeLineToScreen() filling tab-expansion cells with stylePool.none instead
// of the tab character's own style, dropping the active background over the
// expanded columns. These tests pin the background as CONTINUOUS across the
// expanded tab while keeping tab width and non-tab/no-background lines
// unchanged.

const BG = '\x1b[48;5;23m' // diff added-line background

test('tab-expansion cells inherit the active background (no default-bg notch)', () => {
  const stylePool = new StylePool()
  const screen = createScreen(
    20,
    1,
    stylePool,
    new CharPool(),
    new HyperlinkPool(),
  )
  const output = new Output({ height: 1, screen, stylePool, width: 20 })

  // `<bg-on>+\tX<reset>` — a leading tab inside a background run, like a
  // ColorDiff added Makefile recipe line.
  output.write(0, 0, `${BG}+\tX\x1b[0m`)
  const rendered = output.get()

  const marker = cellAt(rendered, 0, 0)!
  expect(marker.char).toBe('+')

  // The marker carries a real background style (a visible-on-space style has a
  // non-zero styleId because StylePool.none is always 0).
  expect(marker.styleId).not.toBe(stylePool.none)

  // Tab at column 1 expands to the next 8-col stop: columns 1..7 are the
  // expansion, column 8 is the content. Every expansion cell must carry the
  // SAME background styleId as the marker — an unbroken band, no default-bg
  // gap. Against the buggy code these cells were stylePool.none (the notch).
  for (let x = 1; x <= 7; x++) {
    const cell = cellAt(rendered, x, 0)!
    expect(cell.char).toBe(' ')
    expect(cell.styleId).toBe(marker.styleId)
  }

  // Width invariant: the tab still expands to exactly 4 cells here (col 1 → 8),
  // so the content lands at column 8 — the tab is still 8-col-stop wide, not
  // collapsed or widened by the fix.
  const content = cellAt(rendered, 8, 0)!
  expect(content.char).toBe('X')
  expect(content.styleId).toBe(marker.styleId)
})

test('a tab with no active background still fills with the default (non-diff code unaffected)', () => {
  const stylePool = new StylePool()
  const screen = createScreen(
    20,
    1,
    stylePool,
    new CharPool(),
    new HyperlinkPool(),
  )
  const output = new Output({ height: 1, screen, stylePool, width: 20 })

  // No background SGR — a plain code block / command output line. The tab
  // expansion must stay background-free (no regression for non-diff content).
  output.write(0, 0, 'A\tB')
  const rendered = output.get()

  expect(cellAt(rendered, 0, 0)!.char).toBe('A')
  for (let x = 1; x <= 7; x++) {
    const cell = cellAt(rendered, x, 0)!
    expect(cell.char).toBe(' ')
    // The tab char itself has no style here, so expansion cells stay none.
    expect(cell.styleId).toBe(stylePool.none)
  }
  // Width unchanged: content still lands at the column-8 tab stop.
  expect(cellAt(rendered, 8, 0)!.char).toBe('B')
})

test('emitted ANSI keeps the background continuous across an expanded tab', async () => {
  // End-to-end through the real RawAnsi → ink-raw-ansi → writeLineToScreen
  // path, mirroring how ColorDiff output reaches the screen. The notch
  // manifested as a mid-line `49m` (default bg) over the expanded tab columns.
  const line = `${BG}+\t@echo hi\x1b[0m`
  const ansi = await renderToAnsiString(<RawAnsi lines={[line]} width={40} />, {
    columns: 80,
    color: true,
  })

  expect(ansi).toContain('@echo hi')

  // Isolate the run from the first background-on to the content. Between the
  // `+` marker and `@echo` there must be NO `49m` (default-bg reset): the
  // background stays on across the expanded tab. Against the buggy code this
  // region contained `+\x1b[49m       \x1b[48;5;23m@echo` (the notch).
  const start = ansi.indexOf('\x1b[48;5;23m')
  const contentIdx = ansi.indexOf('@echo hi')
  expect(start).toBeGreaterThanOrEqual(0)
  expect(contentIdx).toBeGreaterThan(start)
  const between = ansi.slice(start, contentIdx)
  expect(between).not.toContain('\x1b[49m')

  // The expanded tab is still present as spaces (width preserved): `+` then
  // seven spaces (column 1 → column 8 tab stop) before the content.
  expect(between).toContain('+       ')
})
