import React from 'react'
import stringWidth from 'string-width'
import { describe, expect, it } from 'vitest'

import { ContentWidthProvider } from '../../../../src/tui/context/contentWidthContext.js'
import { renderToAnsiString, renderToString } from '../../../utils/staticRender.js'
import { WelcomeColdPanel } from '../../../../src/tui/components/v2/primitives.js'
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

  // Monochrome-theme SGR truecolor sequences.
  const INACTIVE_SGR = '\u001b[38;2;112;112;112m'
  const INK_SGR = '\u001b[38;2;255;255;255m'

  // Adjacent Ink Text nodes may insert reset/style SGR codes between the
  // foreground color and the label. Read the last foreground SGR before it.
  function sgrBefore(out: string, label: string): string | undefined {
    const labelIndex = out.indexOf(label)
    if (labelIndex < 0) return undefined
    const prefix = out.slice(Math.max(0, labelIndex - 160), labelIndex)
    return prefix.match(/\u001b\[38;2;[0-9;]+m/gu)?.at(-1)
  }

  it('mutes the keys and the version and inks the labels and the name', async () => {
    const out = await renderToAnsiString(<WelcomeColdPanel />, {
      columns: 120,
      rows: 40,
      color: true,
    })

    expect(sgrBefore(out, 'shift+tab')).toBe(INACTIVE_SGR)
    expect(sgrBefore(out, 'change mode')).toBe(INK_SGR)
    expect(sgrBefore(out, 'attach files')).toBe(INK_SGR)
    expect(sgrBefore(out, 'agenc')).toBe(INK_SGR)
    expect(sgrBefore(out, VERSION)).toBe(INACTIVE_SGR)
  })
})
