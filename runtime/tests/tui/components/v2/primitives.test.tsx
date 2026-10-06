import React from 'react'
import { inflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'

import { renderToAnsiString, renderToString } from '../../../utils/staticRender.js'
import { Box, Text } from '../../ink.js'
import { QueuedMessageProvider } from '../../context/QueuedMessageContext.js'
import { stringWidth } from '../../ink/stringWidth.js'
import {
  AGENC_LOGO_RASTER_SIZE,
  AGENC_LOGO_RGBA_ZLIB_BASE64,
} from './agencLogoGraphics.generated.js'
import {
  AGENC_LOGO_MARK_COMPACT_LINES,
  AGENC_LOGO_MARK_LINES,
  kittyLogoPlaceholderRows,
  kittyLogoUploadCommand,
  MenuModal,
  ModeSwitcher,
  Msg,
  PlanList,
  SlashPalette,
  StatusSegment,
  supportsKittyGraphics,
  TerminalFrame,
  Tool,
  WelcomeColdPanel,
} from './primitives.js'

const BRAILLE_ALPHA_THRESHOLD = 0.22
const BRAILLE_DOT_BITS = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
] as const

function renderLogoBraille(
  raster: Buffer,
  columns: number,
  rows: number,
): readonly string[] {
  const sampleColumns = columns * 2
  const sampleRows = rows * 4

  function sampleAlpha(sampleColumn: number, sampleRow: number): boolean {
    const xStart = Math.floor(
      (sampleColumn * AGENC_LOGO_RASTER_SIZE) / sampleColumns,
    )
    const xEnd = Math.floor(
      ((sampleColumn + 1) * AGENC_LOGO_RASTER_SIZE) / sampleColumns,
    )
    const yStart = Math.floor(
      (sampleRow * AGENC_LOGO_RASTER_SIZE) / sampleRows,
    )
    const yEnd = Math.floor(
      ((sampleRow + 1) * AGENC_LOGO_RASTER_SIZE) / sampleRows,
    )
    let alpha = 0
    let pixels = 0

    for (let y = yStart; y < yEnd; y += 1) {
      for (let x = xStart; x < xEnd; x += 1) {
        alpha += raster[(y * AGENC_LOGO_RASTER_SIZE + x) * 4 + 3] ?? 0
        pixels += 1
      }
    }

    return alpha / (pixels * 255) >= BRAILLE_ALPHA_THRESHOLD
  }

  return Array.from({ length: rows }, (_, row) =>
    Array.from({ length: columns }, (_, column) => {
      let dots = 0
      for (let dotRow = 0; dotRow < 4; dotRow += 1) {
        for (let dotColumn = 0; dotColumn < 2; dotColumn += 1) {
          if (sampleAlpha(column * 2 + dotColumn, row * 4 + dotRow)) {
            dots |= BRAILLE_DOT_BITS[dotRow]![dotColumn]!
          }
        }
      }
      return String.fromCodePoint(0x2800 + dots)
    }).join(''),
  )
}

describe('v2 primitives', () => {
  it('renders the runtime-bound mode switcher state with the current mode selected', async () => {
    const output = await renderToString(
      <ModeSwitcher
        currentMode="plan"
        bypassAvailable={true}
        autoAvailable={true}
      />,
      96,
    )

    expect(output).toContain('permission mode')
    expect(output).toContain('default')
    expect(output).toContain('acceptEdits')
    expect(output).toContain('plan')
    expect(output).toContain('auto')
    expect(output).toContain('bypassPermissions')
    expect(output).toContain('read-only · propose plans')
    expect(output).toContain('bypassPermissions')
    expect(output).toContain('shift+tab')
    // The advertised digit range must match the number of visible modes.
    expect(output).toContain('1–5 pick · ⇧⇥ cycle · esc')
  })

  it('hides unavailable cycle targets', async () => {
    const output = await renderToString(
      <ModeSwitcher
        currentMode="acceptEdits"
        bypassAvailable={false}
        autoAvailable={false}
      />,
      96,
    )

    expect(output).toContain('acceptEdits')
    expect(output).toContain('auto-accept file edits')
    expect(output).not.toContain('auto-approve everything')
    expect(output).not.toContain('bypassPermissions')
    // The advertised digit range shrinks with the hidden modes.
    expect(output).toContain('1–3 pick')
  })

  it('renders body overlays without requiring modal content in chat flow', async () => {
    const output = await renderToString(
      <TerminalFrame
        title="agenc ~ swap-program"
        bodyOverlay={<StatusSegment label="overlay" value="menu modal" color="agenc" />}
        statusLeft={[<StatusSegment key="model" label="model" value="haiku-4.5" />]}
        statusRight={[]}
        columns={96}
        minHeight={24}
      >
        <StatusSegment label="chat" value="prompt only" />
      </TerminalFrame>,
      { columns: 96, rows: 24 },
    )

    expect(output).toContain('CHAT prompt only')
    expect(output).toContain('OVERLAY menu modal')
    expect(output).toContain('MODEL haiku-4.5')
  })

  it('renders slash palettes with filtered command rows', async () => {
    const output = await renderToString(
      <SlashPalette
        activeCommand="/delegate"
        filter="/d"
        items={[
          { command: '/delegate', args: '<agent> <step>', description: 'delegate a step to another agent' },
          { command: '/diff', args: 'core', description: 'show the current working diff' },
        ]}
      />,
      96,
    )

    expect(output).toContain('matches · 2')
    expect(output).toContain('/delegate')
    expect(output).toContain('<agent> <step>')
    expect(output).toContain('/diff')
    expect(output).toContain('show the current working diff')
  })

  it('renders the AURA cold-start welcome without chain hero state', async () => {
    const output = await renderToString(<WelcomeColdPanel />, { columns: 120, rows: 24 })

    expect(output).toContain(AGENC_LOGO_MARK_LINES[0])
    expect(output).not.toContain('a netrunner with hands on every file')
    expect(output).not.toContain('STAKE')
    expect(output).not.toContain('18.40')
    expect(output).not.toContain('/claim')
  })

  it('carries a valid exact RGBA raster for the official logo', () => {
    const raster = inflateSync(
      Buffer.from(AGENC_LOGO_RGBA_ZLIB_BASE64, 'base64'),
    )

    expect(raster.byteLength).toBe(
      AGENC_LOGO_RASTER_SIZE * AGENC_LOGO_RASTER_SIZE * 4,
    )
    // Transparent canvas plus opaque white brand geometry.
    expect(raster.includes(Buffer.from([0, 0, 0, 0]))).toBe(true)
    expect(raster.includes(Buffer.from([255, 255, 255, 255]))).toBe(true)
  })

  it('derives both portable logo sizes from the official raster', () => {
    const raster = inflateSync(
      Buffer.from(AGENC_LOGO_RGBA_ZLIB_BASE64, 'base64'),
    )

    expect(AGENC_LOGO_MARK_LINES).toEqual(renderLogoBraille(raster, 16, 8))
    expect(AGENC_LOGO_MARK_COMPACT_LINES).toEqual(
      renderLogoBraille(raster, 14, 6),
    )
    expect(AGENC_LOGO_MARK_LINES.every(line => stringWidth(line) === 16)).toBe(
      true,
    )
    expect(
      AGENC_LOGO_MARK_COMPACT_LINES.every(line => stringWidth(line) === 14),
    ).toBe(true)
  })

  it('detects Kitty directly but keeps multiplexers and other terminals on the fallback', () => {
    expect(supportsKittyGraphics({ KITTY_WINDOW_ID: '1' })).toBe(true)
    expect(supportsKittyGraphics({ TERM: 'xterm-kitty' })).toBe(true)
    expect(
      supportsKittyGraphics({
        KITTY_WINDOW_ID: '1',
        TMUX: '/tmp/tmux-1000/default,1,0',
      }),
    ).toBe(false)
    expect(supportsKittyGraphics({ TERM: 'xterm-256color' })).toBe(false)
  })

  it('builds a quiet Kitty virtual placement and cell-perfect placeholders', () => {
    const columns = AGENC_LOGO_MARK_LINES[0].length
    const rows = AGENC_LOGO_MARK_LINES.length
    const upload = kittyLogoUploadCommand(columns, rows)
    const placeholders = kittyLogoPlaceholderRows(columns, rows)
    const compactPlaceholders = kittyLogoPlaceholderRows(
      AGENC_LOGO_MARK_COMPACT_LINES[0].length,
      AGENC_LOGO_MARK_COMPACT_LINES.length,
    )

    expect(upload).toMatch(/^\x1b_G/)
    expect(upload).toContain('a=T,q=2,o=z,f=32,C=1,U=1')
    expect(upload).toContain(
      `s=160,v=160,c=${columns},r=${rows},i=16777215;`,
    )
    expect(upload).toMatch(/\x1b\\$/)
    expect(columns).toBe(16)
    expect(placeholders).toHaveLength(rows)
    expect(placeholders.every(row => stringWidth(row) === columns)).toBe(true)
    expect(compactPlaceholders).toHaveLength(
      AGENC_LOGO_MARK_COMPACT_LINES.length,
    )
  })

  it('fabricates no session data and repeats no status fact', async () => {
    // The folder, model and mode live in the status line under the prompt,
    // and there is no real recent-session feed, so none of them render here.
    const output = await renderToString(<WelcomeColdPanel />, { columns: 120, rows: 24 })

    expect(output).toContain(AGENC_LOGO_MARK_LINES[0])
    expect(output).not.toContain('workspace')
    expect(output).not.toContain('model')
    expect(output).not.toContain('last session')
    expect(output).not.toContain('recent')
    expect(output).not.toContain('to resume')
  })

  it('tells a new user the keys in one line', async () => {
    const output = await renderToString(<WelcomeColdPanel />, { columns: 120, rows: 24 })

    expect(output).toContain('/ commands')
    expect(output).toContain('@ attach files')
    expect(output).toContain('shift+tab change mode')
    expect(output).toContain('? shortcuts')
    expect(output).not.toContain('START HERE')
    expect(output).not.toContain('⇧')
  })

  it('drops whole hint segments on a narrow pane instead of cutting mid-word', async () => {
    const output = await renderToString(<WelcomeColdPanel />, { columns: 44, rows: 24 })

    expect(output).toContain(AGENC_LOGO_MARK_COMPACT_LINES[0])
    expect(output).not.toContain(AGENC_LOGO_MARK_LINES[0])
    // The first segment always survives…
    expect(output).toContain('/ commands')
    // …and narrower panes lose trailing segments whole, with no mid-word
    // ellipsis.
    expect(output).not.toContain('shift+tab')
    expect(output).not.toContain('…')
  })

  it('centers the compact mark above the name and the keys at 80 columns', async () => {
    const output = await renderToString(<WelcomeColdPanel />, { columns: 80, rows: 30 })
    const lines = output.split(/\r?\n/u)
    const brandRowIndex = lines.findIndex(line =>
      line.includes(AGENC_LOGO_MARK_COMPACT_LINES[0]),
    )
    const nameRowIndex = lines.findIndex(line => line.includes('agenc'))
    const keysRowIndex = lines.findIndex(line => line.includes('/ commands'))

    expect(brandRowIndex).toBeGreaterThanOrEqual(0)
    expect(lines[brandRowIndex]!.indexOf(AGENC_LOGO_MARK_COMPACT_LINES[0])).toBeGreaterThan(20)
    expect(nameRowIndex).toBeGreaterThan(brandRowIndex)
    expect(keysRowIndex).toBeGreaterThan(nameRowIndex)
  })

  it('uses AURA lifecycle glyphs for plan rows', async () => {
    const output = await renderToString(
      <PlanList
        items={[
          { state: 'done', text: 'read repo state' },
          { state: 'active', text: 'apply focused patch' },
          { state: 'pending', text: 'run verification' },
          { state: 'failed', text: 'surface blocker' },
        ]}
      />,
      96,
    )

    expect(output).toContain('01 ● read repo state')
    expect(output).toContain('02 ▮ apply focused patch')
    expect(output).toContain('03 ○ run verification')
    expect(output).toContain('04 ✕ surface blocker')
    expect(output).not.toContain('✓ read repo state')
    expect(output).not.toContain('· run verification')
  })

  it('windows long menus to the active row and exposes scroll position', async () => {
    const rows = Array.from({ length: 30 }, (_, index) => ({
      status: 'available',
      name: `item-${String(index).padStart(2, '0')}`,
      detail: `detail-${index}`,
    }))

    const output = await renderToString(
      <MenuModal
        title="skills"
        count={`${rows.length}`}
        columns={[12, 12, 20]}
        headers={['status', 'name', 'detail']}
        items={rows}
        activeIndex={18}
        footer={[{ keyName: 'up/down', label: 'navigate' }]}
        renderRow={row => [
          <Text key="status">{row.status}</Text>,
          <Text key="name">{row.name}</Text>,
          <Text key="detail">{row.detail}</Text>,
        ]}
      />,
      { columns: 100, rows: 12 },
    )

    expect(output).toContain('item-18')
    expect(output).toContain('▌')
    expect(output).toContain('scroll 16-22/30')
    expect(output).not.toContain('item-00')
    expect(output).not.toContain('item-29')
  })
})

describe('Msg queued header marker', () => {
  it('shows a quiet "queued" marker (not a clock) for a queued message without a time', async () => {
    const output = await renderToString(
      <QueuedMessageProvider isFirst>
        <Msg role="user" label="you">
          <Text>pending prompt body</Text>
        </Msg>
      </QueuedMessageProvider>,
      { columns: 100, rows: 12 },
    )

    // Labels render as written (lowercase), after the user's ❯ glyph.
    expect(output).toContain('❯ you')
    expect(output).toContain('pending prompt body')
    // The neutral marker stands in for the missing per-item enqueue time.
    // (Body text deliberately avoids the word "queued" so this assertion is
    // revert-sensitive to the marker rendering.)
    expect(output).toContain('queued')
    // It must not invent a clock or leak an ISO machine timestamp.
    expect(output).not.toMatch(/\d{1,2}:\d{2}/)
    expect(output).not.toMatch(/\d{4}-\d{2}-\d{2}T/)
  })

  it('shows the provided time (not the queued marker) when a non-queued message has a time', async () => {
    const output = await renderToString(
      <Msg role="user" label="you" time="1:37 AM">
        <Text>live prompt body</Text>
      </Msg>,
      { columns: 100, rows: 12 },
    )

    expect(output).toContain('1:37 AM')
    expect(output).not.toContain('queued')
  })
})

describe('Tool call header arg spacing', () => {
  it('puts the args one space after the verb, with no parentheses', async () => {
    const output = await renderToString(
      <Tool kind="edit" label="Write" args="index.html" />,
      { columns: 100, rows: 12 },
    )

    // A finished step reads `● Wrote index.html`: static dot, past-tense
    // verb, one space from the row's gap, then the bare args. Revert-sensitive:
    // bringing the `(`/`)` wrappers back, or dropping the past tense, fails it.
    expect(output).toContain('● Wrote index.html')
    expect(output).not.toContain('(index.html)')
    expect(output).not.toContain('Wrote  index.html')
  })

  it('says the step state with the static dot color only, never a state glyph', async () => {
    const dot = async (state: 'queued' | 'running' | 'done' | 'failed') => {
      const ansi = await renderToAnsiString(<Tool kind="bash" label="Run" state={state} args="ls" />, {
        columns: 40,
        rows: 5,
        color: true,
      })
      expect(ansi).not.toMatch(/[✶✕◐○]/u)
      // eslint-disable-next-line no-control-regex
      return /(\x1b\[[0-9;]*m)●/u.exec(ansi)?.[1]
    }
    const done = await dot('done')
    const failed = await dot('failed')
    const running = await dot('running')
    expect(done).toBeDefined()
    expect(failed).toBeDefined()
    expect(running).toBeDefined()
    // Green done, red failed, gray while queued or running.
    expect(new Set([done, failed, running]).size).toBe(3)
    expect(await dot('queued')).toBe(running)
  })
})

describe('Msg role glyph', () => {

  it('marks an agenc reply with a single ● glyph and hides its label', async () => {
    const output = await renderToString(
      <Msg role="agenc" label="agenc">
        <Text>body</Text>
      </Msg>,
      { columns: 100, rows: 12 },
    )

    // The speaker is a one-cell glyph column, not a left border, and AgenC's
    // own name is not repeated on every reply. Revert-sensitive: restoring the
    // `│` gutter, the ▮ marker, or the AGENC label fails these.
    expect(output).toContain('● body')
    expect(output).not.toContain('│')
    expect(output).not.toContain('▮')
    expect(output.toLowerCase()).not.toContain('agenc')
  })

  it('renders the system role with the ● glyph and a lowercase label', async () => {
    const output = await renderToString(
      <Msg role="system" label="system">
        <Text>body</Text>
      </Msg>,
      { columns: 100, rows: 12 },
    )

    expect(output).toContain('● system')
    // The body sits in the content column, two cells in under the glyph.
    expect(output).toContain('\n  body')
    expect(output).not.toContain('SYSTEM')
    expect(output).not.toContain('│')
  })
})
