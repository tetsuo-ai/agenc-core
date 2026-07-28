import React from 'react'
import { describe, expect, it } from 'vitest'

import { ContentWidthProvider } from '../../../../src/tui/context/contentWidthContext.js'
import { renderToAnsiString, renderToString } from '../../../utils/staticRender.js'
import { WelcomeColdPanel } from '../../../../src/tui/components/v2/primitives.js'

// Regression coverage for the centered cold-start hero. Workspace and model
// now share one quiet metadata line beneath the official mark; only honest
// recent-session data earns a bordered card. The hero/recent width tracks its
// pane up to a restrained cap instead of stretching across a wide transcript.

const CARD_BORDER = /[┌└][─]+[┐┘]/u

// Production no longer fabricates default recent sessions (honest-chrome
// rule), so card-width tests must supply real session data.
const RECENT_SESSIONS = [
  { keyName: '1', title: 'swap-program', detail: '12m ago · main · clean' },
  { keyName: '2', title: 'runtime coverage', detail: '1h ago · dev · dirty' },
  { keyName: '3', title: 'agent catalog', detail: '3h ago · main · clean' },
] as const

function cardWidths(output: string): readonly number[] {
  return output
    .split(/\r?\n/u)
    .map((line) => line.match(CARD_BORDER)?.[0])
    .filter((line): line is string => line !== undefined)
    .map((line) => [...line].length)
}

describe('WelcomeColdPanel centered hero', () => {
  it('renders only the honest recent-session section as a bordered card', async () => {
    const output = await renderToString(
      <ContentWidthProvider width={92}>
        <WelcomeColdPanel recentSessions={RECENT_SESSIONS} />
      </ContentWidthProvider>,
      { columns: 120, rows: 40 },
    )

    const widths = cardWidths(output)
    // One recent-session card contributes one top and one bottom border.
    expect(widths.length).toBe(2)
    expect(new Set(widths).size).toBe(1)
    expect(output).toContain('workspace')
    expect(output).toContain('model')
    expect(output).toContain('START HERE')
  })

  it('grows the recent card with the pane up to the hero cap on a wide pane', async () => {
    const output = await renderToString(
      <ContentWidthProvider width={92}>
        <WelcomeColdPanel recentSessions={RECENT_SESSIONS} />
      </ContentWidthProvider>,
      { columns: 120, rows: 40 },
    )

    const widths = cardWidths(output)
    const width = widths[0]!
    // Caps at 64 instead of stretching to fill the ~92-col pane.
    expect(width).toBe(64)
    expect(widths.every((value) => value === width)).toBe(true)
  })

  it('uses the available pane width when it is below the cap', async () => {
    const output = await renderToString(
      <ContentWidthProvider width={50}>
        <WelcomeColdPanel recentSessions={RECENT_SESSIONS} />
      </ContentWidthProvider>,
      { columns: 80, rows: 40 },
    )

    const widths = cardWidths(output)
    expect(widths.length).toBe(2)
    expect(new Set(widths).size).toBe(1)
    // Tracks the pane (50 - 2 inset) rather than a fixed tiny value, and stays
    // below the cap.
    expect(widths[0]).toBe(48)
  })

  it('never overflows a very narrow pane', async () => {
    const paneWidth = 40
    const output = await renderToString(
      <ContentWidthProvider width={paneWidth}>
        <WelcomeColdPanel recentSessions={RECENT_SESSIONS} />
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
    const output = await renderToString(<WelcomeColdPanel recentSessions={RECENT_SESSIONS} />, {
      columns: 120,
      rows: 40,
    })

    const widths = cardWidths(output)
    expect(widths.length).toBe(2)
    expect(new Set(widths).size).toBe(1)
    expect(widths[0]).toBe(64)
  })

  // Monochrome-theme SGR truecolor sequences for metadata labels.
  const INACTIVE_SGR = '[38;2;112;112;112m'
  const MUTED3_SGR = '[38;2;68;68;68m'

  // Adjacent Ink Text nodes may insert reset/style SGR codes between the
  // foreground color and the label. Read the last foreground SGR before it.
  function sgrBefore(out: string, label: string): string | undefined {
    const labelIndex = out.indexOf(label)
    if (labelIndex < 0) return undefined
    const prefix = out.slice(Math.max(0, labelIndex - 160), labelIndex)
    return prefix.match(/\u001b\[38;2;[0-9;]+m/gu)?.at(-1)
  }

  it('styles metadata labels in the readable secondary tone', async () => {
    const out = await renderToAnsiString(
      <WelcomeColdPanel model="qwen3.6-27b-fp8" lastSession="2h ago" />,
      { columns: 80, rows: 40, color: true },
    )

    // Each label uses the readable `inactive` tone, not near-black chrome.
    for (const label of ['workspace', 'model', 'agenc core', 'last session']) {
      const sgr = sgrBefore(out, label)
      expect(sgr).toBe(INACTIVE_SGR)
      expect(sgr).not.toBe(MUTED3_SGR)
    }
  })
})
