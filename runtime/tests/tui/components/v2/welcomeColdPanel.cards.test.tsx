import React from 'react'
import { describe, expect, it } from 'vitest'

import { ContentWidthProvider } from '../../../../src/tui/context/contentWidthContext.js'
import { renderToAnsiString, renderToString } from '../../../utils/staticRender.js'
import { WelcomeColdPanel } from '../../../../src/tui/components/v2/primitives.js'

// Regression for the cold-start workbench welcome layout: the "workspace"
// summary card and the "recent" card used to be fixed shrink-to-content boxes,
// so (a) they rendered at MISMATCHED widths (~40 vs ~45 cols) and (b) neither
// grew with a wide transcript pane, leaving a jarring empty band on the right.
// They now share one width that grows with the available pane up to a tasteful
// cap. These tests are revert-sensitive against re-introducing the tiny fixed
// width: reverting the `width={cardWidth}` props (so the boxes shrink to their
// own content again) makes the equal-width and grow-to-cap assertions fail.

const CARD_BORDER = /^[┌└][─]+[┐┘]$/u

function cardWidths(output: string): readonly number[] {
  return output
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter((line) => CARD_BORDER.test(line))
    .map((line) => [...line].length)
}

describe('WelcomeColdPanel summary/recent cards', () => {
  it('renders both cards at the SAME width', async () => {
    const output = await renderToString(
      <ContentWidthProvider width={92}>
        <WelcomeColdPanel />
      </ContentWidthProvider>,
      { columns: 120, rows: 40 },
    )

    const widths = cardWidths(output)
    // Two cards, each contributing a top + bottom border line.
    expect(widths.length).toBe(4)
    expect(new Set(widths).size).toBe(1)
  })

  it('grows the cards with the pane up to the tasteful cap on a wide pane', async () => {
    const output = await renderToString(
      <ContentWidthProvider width={92}>
        <WelcomeColdPanel />
      </ContentWidthProvider>,
      { columns: 120, rows: 40 },
    )

    const widths = cardWidths(output)
    const width = widths[0]!
    // Caps at 64 instead of stretching to fill the ~92-col pane, but is far
    // wider than the old ~40/45 fixed boxes — the regression we are guarding.
    expect(width).toBe(64)
    expect(widths.every((value) => value === width)).toBe(true)
  })

  it('uses the available pane width when it is below the cap', async () => {
    const output = await renderToString(
      <ContentWidthProvider width={50}>
        <WelcomeColdPanel />
      </ContentWidthProvider>,
      { columns: 80, rows: 40 },
    )

    const widths = cardWidths(output)
    expect(widths.length).toBe(4)
    expect(new Set(widths).size).toBe(1)
    // Tracks the pane (50 - 2 inset) rather than a fixed tiny value, and stays
    // below the cap.
    expect(widths[0]).toBe(48)
  })

  it('never overflows a very narrow pane', async () => {
    const paneWidth = 40
    const output = await renderToString(
      <ContentWidthProvider width={paneWidth}>
        <WelcomeColdPanel />
      </ContentWidthProvider>,
      { columns: 80, rows: 40 },
    )

    const widths = cardWidths(output)
    expect(new Set(widths).size).toBe(1)
    // Clamped to the usable pane width (paneWidth - 2 inset) so the border never
    // spills past the transcript surface padding.
    expect(widths[0]).toBeLessThanOrEqual(paneWidth - 2)
  })

  it('falls back to a capped width when no content-width provider is present', async () => {
    const output = await renderToString(<WelcomeColdPanel />, {
      columns: 120,
      rows: 40,
    })

    const widths = cardWidths(output)
    expect(widths.length).toBe(4)
    expect(new Set(widths).size).toBe(1)
    expect(widths[0]).toBe(64)
  })

  // Dark-theme SGR truecolor sequences for the colors that meet on the summary
  // card. The labels ("workspace"/"model"/"last session") used to render in
  // `muted3` (rgb(64,64,70)), nearly identical to the card's `lineSoft` border
  // (rgb(34,35,39)) — so they read as chrome. They now render in the brighter,
  // clearly-readable `inactive` tone (rgb(139,120,157)).
  const INACTIVE_SGR = '[38;2;139;120;157m'
  const MUTED3_SGR = '[38;2;64;64;70m'
  const LINESOFT_SGR = '[38;2;34;35;39m'

  // The SGR escape that immediately precedes a label's text on its row.
  function sgrBefore(out: string, label: string): string | undefined {
    const match = out.match(new RegExp(`(\\u001b\\[[0-9;]*m)${label}`, 'u'))
    return match?.[1]
  }

  it('styles the summary-card labels in the readable label tone, not the dim border tone', async () => {
    const out = await renderToAnsiString(
      <WelcomeColdPanel model="qwen3.6-27b-fp8" />,
      { columns: 80, rows: 40, color: true },
    )

    // The box border still draws in the dim `lineSoft` tone.
    expect(out).toContain(LINESOFT_SGR)

    // Each summary-card label is now colored with the brighter, readable
    // `inactive` tone — NOT the near-border `muted3` tone it used to use.
    // Scoped per-label (the unrelated "recent" card legitimately still uses
    // muted3, so a global not.toContain would over-assert). Revert-sensitive:
    // switching the label color back to "muted3" flips each preceding SGR to
    // MUTED3_SGR and fails these checks.
    for (const label of ['workspace', 'model', 'last session']) {
      const sgr = sgrBefore(out, label)
      expect(sgr).toBe(INACTIVE_SGR)
      expect(sgr).not.toBe(MUTED3_SGR)
    }
  })
})
