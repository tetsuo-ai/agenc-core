import React from 'react'
import { Box } from '../../ink.js'
import stringWidth from 'string-width'
import { describe, expect, it } from 'vitest'

import { ContentWidthProvider } from '../../../../src/tui/context/contentWidthContext.js'
import { renderToAnsiString, renderToString } from '../../../utils/staticRender.js'
import { WelcomeColdPanel, welcomeColdPanelLayout, AGENC_LOGO_MARK_LINES, AGENC_LOGO_MARK_COMPACT_LINES } from '../../../../src/tui/components/v2/primitives.js'
import { VERSION } from '../../../../src/version.js'

// The cold start is the mark, the name with its version, and one line of
// keys. Whole key segments drop on narrow panes, and nothing spills past the
// transcript surface.

describe('WelcomeColdPanel layout', () => {
  it('never overflows a narrow pane and keeps whole key segments', async () => {
    const paneWidth = 40
    const output = await renderToString(
      <ContentWidthProvider width={paneWidth}>
        <WelcomeColdPanel />
      </ContentWidthProvider>,
      { columns: 80, rows: 40 },
    )

    for (const line of output.split(/\r?\n/u)) {
      expect(stringWidth(line.trimEnd())).toBeLessThanOrEqual(paneWidth)
    }
    expect(output).toContain('/ commands')
    expect(output).toContain('@ attach files')
    expect(output).not.toContain('shift+tab')
    expect(output).not.toContain('…')
  })

  it('shows every key segment on a wide pane', async () => {
    const output = await renderToString(
      <ContentWidthProvider width={110}>
        <WelcomeColdPanel />
      </ContentWidthProvider>,
      { columns: 120, rows: 40 },
    )

    expect(output).toMatch(
      /\/ commands {3}@ attach files {3}shift\+tab change mode {3}\? shortcuts/u,
    )
  })

  // Default (olive) theme SGR truecolor sequences for the same roles:
  // inactive, secondary text and primary ink.
  const INACTIVE_SGR = '\u001b[38;2;143;141;114m'
  const SECONDARY_SGR = '\u001b[38;2;201;193;172m'
  const INK_SGR = '\u001b[38;2;235;227;208m'

  // Adjacent Ink Text nodes may insert reset/style SGR codes between the
  // foreground color and the label. Read the last foreground SGR before it.
  function sgrBefore(out: string, label: string): string | undefined {
    const labelIndex = out.indexOf(label)
    if (labelIndex < 0) return undefined
    const prefix = out.slice(Math.max(0, labelIndex - 160), labelIndex)
    return prefix.match(/\u001b\[38;2;[0-9;]+m/gu)?.at(-1)
  }

  it('mutes keys and version, uses secondary labels, and keeps the name primary', async () => {
    const out = await renderToAnsiString(<WelcomeColdPanel />, {
      columns: 120,
      rows: 40,
      color: true,
    })

    expect(sgrBefore(out, 'shift+tab')).toBe(INACTIVE_SGR)
    expect(sgrBefore(out, 'change mode')).toBe(SECONDARY_SGR)
    expect(sgrBefore(out, 'attach files')).toBe(SECONDARY_SGR)
    expect(sgrBefore(out, 'agenc')).toBe(INK_SGR)
    expect(sgrBefore(out, VERSION)).toBe(INACTIVE_SGR)
  })
})

const widths = [24, 30, 40, 60, 80, 95, 96, 120]
const heights = [16, 20, 24, 40]
describe('welcome logo fit', () => {
  it.each(widths.flatMap(columns => heights.map(rows => ({ columns, rows }))))(
    'fits the logo and whole hints at $columns x $rows', async ({ columns, rows }) => {
      const layout = welcomeColdPanelLayout(columns - 4, rows)
      expect(layout).toEqual({ compactLogo: rows < 20, showHint: rows >= 22 })
      const output = await renderToString(
        <Box paddingX={2}>
          <ContentWidthProvider width={columns - 4}><WelcomeColdPanel /></ContentWidthProvider>
        </Box>,
        { columns, rows },
      )
      const logo = layout.compactLogo ? AGENC_LOGO_MARK_COMPACT_LINES : AGENC_LOGO_MARK_LINES
      for (const line of logo) expect(output).toContain(line)
      for (const line of output.split('\n')) expect(stringWidth(line)).toBeLessThanOrEqual(columns)
      expect(output.includes('/ commands')).toBe(layout.showHint)
    },
  )
  it('uses the actual mark boundaries and drops hints before shrinking', () => {
    expect(welcomeColdPanelLayout(19, 40).compactLogo).toBe(true)
    expect(welcomeColdPanelLayout(20, 40).compactLogo).toBe(false)
    expect(welcomeColdPanelLayout(20, 19).compactLogo).toBe(true)
    expect(welcomeColdPanelLayout(20, 20)).toEqual({ compactLogo: false, showHint: false })
    expect(welcomeColdPanelLayout(20, 21)).toEqual({ compactLogo: false, showHint: false })
    expect(welcomeColdPanelLayout(20, 22)).toEqual({ compactLogo: false, showHint: true })
  })
})
