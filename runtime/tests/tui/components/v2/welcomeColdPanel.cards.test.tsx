import React from 'react'
import { describe, expect, it } from 'vitest'

import { ContentWidthProvider } from '../../../../src/tui/context/contentWidthContext.js'
import { renderToString } from '../../../utils/staticRender.js'
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
})
