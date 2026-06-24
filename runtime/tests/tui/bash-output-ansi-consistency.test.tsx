import React from 'react'
import { describe, expect, test } from 'vitest'

import { BashOutputView } from '../../src/tui/tool-rendering.js'
import { renderToAnsiString } from '../../src/utils/staticRender.js'

// BUG 2 (MEDIUM): a Run/Bash stdout line that carries the PROGRAM'S OWN SGR
// colors used to render inconsistently. Iter-26 wrapped every stdout line in
// `<Text dimColor>`, but the program's own `ESC[39m`/`ESC[0m` resets terminate
// the dim tone mid-line, so part of the line was raw program-color and the rest
// fell back to the dim theme color — a half-dim / half-raw line, visually
// inconsistent with its uniformly-dim plain siblings.
//
// FIX (option b — matches the live-shell `OutputLine` precedent, which never
// applies dimColor OVER colored program output): a line that carries its OWN SGR
// renders through `<Ansi>` so the program color is preserved intact; only PLAIN
// lines (no SGR of their own) are dimmed. So a single report is never
// half-dim / half-raw.

// The true-color theme tone that `dimColor`/muted text resolves to in the
// rendered output (the tone the plain sibling lines + the gutter carry). Used to
// detect whether a dim color was injected INTO a program-colored line.
const THEME_DIM_FG = '\x1b[38;2;'

function plainExec(...stdoutLines: string[]): string {
  return `${stdoutLines.join('\n')}\n\n[exec exit_code=0 wall_time=0.03s tokens=10]`
}

// The dim `  ⎿  ` continuation gutter prefixes the FIRST content row and is
// ALWAYS dim (correctly). Strip it so the body-color assertions look only at the
// stdout line content, not the intentionally-dim gutter. Rows without the gutter
// glyph are returned unchanged.
function bodyAfterGutter(row: string): string {
  const idx = row.indexOf('⎿')
  return idx === -1 ? row : row.slice(idx + 1)
}

describe('BashOutputView ANSI consistency (BUG 2: no half-dim/half-raw lines)', () => {
  test('a program-colored stdout line keeps its OWN color and is NOT half-dimmed', async () => {
    // The colored line carries its own ESC[31m…ESC[39m. The plain line carries
    // no SGR of its own.
    const content = plainExec(
      '\x1b[31m[1] version\x1b[39m Expected type str',
      'plain sibling line',
    )
    const ansi = await renderToAnsiString(<BashOutputView content={content} />, {
      columns: 120,
      rows: 20,
      color: true,
    })
    // The program's red is preserved.
    expect(ansi).toContain('\x1b[31m[1] version')
    // Split the rendered output into rows and isolate the colored row.
    const coloredRow = ansi
      .split('\n')
      .find((row) => row.includes('[1] version'))
    expect(coloredRow).toBeDefined()
    // The colored line BODY (after the always-dim gutter) must NOT have the dim
    // theme foreground injected into it — that injection (after the program's
    // `[1] version`) is exactly the half-dim break the old `<Text dimColor>`
    // wrapper produced over the program text. With the fix the whole body
    // renders in the program's own color, so no theme-dim fg appears in it.
    expect(bodyAfterGutter(coloredRow!)).not.toContain(THEME_DIM_FG)
  })

  test('a PLAIN stdout line (no own SGR) is still dimmed', async () => {
    const content = plainExec('plain line one', 'plain line two')
    const ansi = await renderToAnsiString(<BashOutputView content={content} />, {
      columns: 120,
      rows: 20,
      color: true,
    })
    // Plain lines carry the dim theme tone (they have no program color of their
    // own to preserve).
    const plainRow = ansi.split('\n').find((row) => row.includes('plain line one'))
    expect(plainRow).toBeDefined()
    expect(plainRow).toContain(THEME_DIM_FG)
  })

  test('REVERT-SENSITIVITY: colored line is uniform program color, plain line is uniform dim', async () => {
    const content = plainExec(
      '\x1b[31mERR\x1b[39m the rest of the colored line',
      'a totally plain line',
    )
    const ansi = await renderToAnsiString(<BashOutputView content={content} />, {
      columns: 120,
      rows: 20,
      color: true,
    })
    const coloredRow = ansi.split('\n').find((row) => row.includes('ERR'))
    const plainRow = ansi.split('\n').find((row) => row.includes('totally plain'))
    expect(coloredRow).toBeDefined()
    expect(plainRow).toBeDefined()
    // The colored line BODY is NOT broken into program-color + dim-theme halves
    // (the old behavior injected `THEME_DIM_FG` right after `ERR`). The plain row
    // IS dim. Against the reverted code the colored BODY would contain
    // THEME_DIM_FG.
    expect(bodyAfterGutter(coloredRow!)).not.toContain(THEME_DIM_FG)
    expect(plainRow).toContain(THEME_DIM_FG)
  })
})
