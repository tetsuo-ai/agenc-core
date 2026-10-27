import React from 'react'
import { Box } from '../../ink.js'
import stringWidth from 'string-width'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ContentWidthProvider } from '../../../../src/tui/context/contentWidthContext.js'
import { renderToAnsiString, renderToString } from '../../../utils/staticRender.js'
import { WelcomeColdPanel, welcomeColdPanelLayout, AGENC_LOGO_MARK_LINES, AGENC_LOGO_MARK_COMPACT_LINES } from '../../../../src/tui/components/v2/primitives.js'
import { escapeRegExp } from '../../../../src/utils/stringUtils.js'
import { VERSION } from '../../../../src/version.js'

// The cold start is the mark, the name with its version, one line of keys and
// the repository address. Whole key segments drop on narrow panes, the address
// drops whole when it does not fit, and nothing spills past the transcript
// surface.

const REPO_LABEL = 'github.com/tetsuo-ai/agenc-core'
const REPO_URL = 'https://github.com/tetsuo-ai/agenc-core'

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

  it('mutes keys, version and address, uses secondary labels, and keeps the name primary', async () => {
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
    expect(sgrBefore(out, REPO_LABEL)).toBe(INACTIVE_SGR)
  })
})

describe('WelcomeColdPanel repository address', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  const panel = (width: number): React.ReactElement => (
    <ContentWidthProvider width={width}>
      <WelcomeColdPanel />
    </ContentWidthProvider>
  )

  it('centers the bare address one blank line under the keys', async () => {
    vi.stubEnv('FORCE_HYPERLINK', '0')
    const lines = (await renderToString(panel(78), { columns: 80, rows: 24 })).split(/\r?\n/u)
    const keysRow = lines.findIndex(line => line.includes('/ commands'))
    const addressRow = lines.findIndex(line => line.includes(REPO_LABEL))

    expect(keysRow).toBeGreaterThan(0)
    expect(addressRow).toBe(keysRow + 2)
    expect(lines[keysRow + 1]!.trim()).toBe('')
    expect(lines[addressRow]!.trim()).toBe(REPO_LABEL)
    expect(lines.filter(line => line.includes('github'))).toHaveLength(1)
    const left = lines[addressRow]!.indexOf(REPO_LABEL)
    expect(Math.abs(left - (78 - left - REPO_LABEL.length))).toBeLessThanOrEqual(1)
  })

  it('links the address to the repository with OSC 8 when the terminal supports hyperlinks', async () => {
    vi.stubEnv('FORCE_HYPERLINK', '1')
    const out = await renderToAnsiString(panel(78), { columns: 80, rows: 24 })
    const osc8 = (target: string): string => `\\x1b\\]8;[^;\\x07\\x1b]*;${target}(?:\\x07|\\x1b\\\\)`
    const sgr = '(?:\\x1b\\[[0-9;]*m)*'

    expect(out).toMatch(
      new RegExp(`${osc8(escapeRegExp(REPO_URL))}${sgr}${escapeRegExp(REPO_LABEL)}${sgr}${osc8('')}`, 'u'),
    )
    expect(out.match(/\x1b\]8;[^;\x07\x1b]*;https:/gu)).toHaveLength(1)
  })

  it('prints the same address plainly when the terminal has no hyperlinks', async () => {
    vi.stubEnv('FORCE_HYPERLINK', '0')
    const out = await renderToAnsiString(panel(78), { columns: 80, rows: 24 })

    expect(out).not.toContain('\x1b]8;')
    expect(out).not.toContain('https://')
    expect(out).toContain(REPO_LABEL)
  })

  it.each([
    { width: 30, shown: false },
    { width: 31, shown: true },
  ])('shows the address on one line or not at all in a $width column pane', async ({ width, shown }) => {
    const output = await renderToString(panel(width), { columns: 80, rows: 40 })

    expect(output.includes(REPO_LABEL)).toBe(shown)
    expect(output.includes('github')).toBe(shown)
    expect(output.includes('agenc-core')).toBe(shown)
  })
})

const widths = [24, 30, 40, 60, 80, 95, 96, 120]
const heights = [16, 20, 24, 40]
describe('welcome logo fit', () => {
  it.each(widths.flatMap(columns => heights.map(rows => ({ columns, rows }))))(
    'fits the logo and whole hints at $columns x $rows', async ({ columns, rows }) => {
      const layout = welcomeColdPanelLayout(columns - 4, rows)
      expect(layout).toEqual({
        compactLogo: rows < 20,
        showHint: rows >= 22,
        showRepoLink: rows >= 24 && columns - 4 >= REPO_LABEL.length,
      })
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
      expect(output.includes(REPO_LABEL)).toBe(layout.showRepoLink)
    },
  )
  it('uses the actual mark boundaries and drops hints before shrinking', () => {
    expect(welcomeColdPanelLayout(19, 40).compactLogo).toBe(true)
    expect(welcomeColdPanelLayout(20, 40).compactLogo).toBe(false)
    expect(welcomeColdPanelLayout(20, 19).compactLogo).toBe(true)
    expect(welcomeColdPanelLayout(20, 20)).toEqual({ compactLogo: false, showHint: false, showRepoLink: false })
    expect(welcomeColdPanelLayout(20, 21)).toEqual({ compactLogo: false, showHint: false, showRepoLink: false })
    expect(welcomeColdPanelLayout(20, 22)).toEqual({ compactLogo: false, showHint: true, showRepoLink: false })
  })
  it('drops the address before the hints and whenever it cannot fit whole', () => {
    expect(welcomeColdPanelLayout(31, 23)).toEqual({ compactLogo: false, showHint: true, showRepoLink: false })
    expect(welcomeColdPanelLayout(31, 24)).toEqual({ compactLogo: false, showHint: true, showRepoLink: true })
    expect(welcomeColdPanelLayout(30, 40).showRepoLink).toBe(false)
  })
})
