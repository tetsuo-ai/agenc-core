/**
 * Queued inputs inside the prompt band (owner pick 2026-11-14, queue
 * option A "In the input box").
 *
 * While inputs wait for the next turn they sit inside the prompt band, above
 * the line the user types on:
 *
 *   next                                   ctrl+x backspace drops the last
 *   1  check the vbmeta flags too
 *   2  then flash boot_b, reboot into slot b and tell me if root works
 *   ──────────────────────────────────────────────────────────────────
 *
 * The block starts under the typed text (two cells, the "❯ " glyph), lists
 * at most five inputs and then a count, and drops the hint before it cuts an
 * entry on a narrow band. These tests render the real component and read the
 * frame in terminal cells.
 */
import React from 'react'
import stripAnsi from 'strip-ansi'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { renderToAnsiString, renderToString } from '../../../../src/utils/staticRender.js'
import { ThemeProvider } from '../../../../src/tui/components/design-system/ThemeProvider.js'
import { terminalCells } from '../markdown/fixtures/terminalCells.js'

vi.mock('bun:bundle', () => ({ feature: () => false }))

const queueFixture = vi.hoisted(() => ({ commands: [] as Array<{ value: string; mode: string; isMeta?: boolean }> }))
const viewFixture = vi.hoisted(() => ({ viewingAgentTaskId: undefined as string | undefined }))

vi.mock('../../../../src/tui/hooks/useCommandQueue.js', () => ({
  useCommandQueue: () => queueFixture.commands,
}))

vi.mock('../../../../src/tui/state/AppState.js', () => ({
  useAppState: (
    selector: (state: { viewingAgentTaskId?: string; isBriefOnly: boolean }) => unknown,
  ) => selector({ viewingAgentTaskId: viewFixture.viewingAgentTaskId, isBriefOnly: false }),
}))

const HINT = 'ctrl+x backspace drops the last'
const LONG_MESSAGE = Array.from({ length: 60 }, (_, index) => `word${index + 1}`).join(' ')
const prompts = (...values: string[]) => values.map(value => ({ value, mode: 'prompt' }))

/** The band's inner width at a terminal width: margin 2 and padding 1 on each side. */
const inner = (columns: number) => columns - 6

async function frame(columns: number, listAll = false): Promise<string[]> {
  const { PromptBandQueuedInputs } = await import(
    '../../../../src/tui/components/PromptInput/PromptInputQueuedCommands.js'
  )
  const output = await renderToString(
    <PromptBandQueuedInputs width={inner(columns)} listAll={listAll} />,
    inner(columns),
  )
  return output.split('\n').map(line => line.trimEnd()).filter(line => line.length > 0)
}

describe('queued inputs inside the prompt band', () => {
  beforeEach(() => {
    queueFixture.commands = []
    viewFixture.viewingAgentTaskId = undefined
  })

  it('draws nothing when nothing is queued, so the band keeps its height', async () => {
    expect(await frame(100)).toEqual([])
  })

  it.each([80, 140])('two inputs at %i columns: header, numbered entries, hairline', async columns => {
    queueFixture.commands = prompts('check the vbmeta flags too', 'then flash boot_b')
    const rows = await frame(columns)
    const width = inner(columns) - 2
    expect(rows).toHaveLength(4)
    // The block starts under the typed text: two cells in from the band edge.
    expect(rows[0]!.startsWith('  next')).toBe(true)
    expect(rows[0]!.endsWith(HINT)).toBe(true)
    // The hint sits at the right edge of the block.
    expect(terminalCells(rows[0]!)).toBe(2 + width)
    expect(rows[1]).toBe('  1  check the vbmeta flags too')
    expect(rows[2]).toBe('  2  then flash boot_b')
    expect(rows[3]).toBe(`  ${'─'.repeat(width)}`)
    // No prompt glyph, band label or old header inside the block.
    const text = rows.join('\n')
    expect(text).not.toContain('❯')
    expect(text).not.toContain('queued for next turn')
  })

  it('a long input wraps under its own first character and ends with an ellipsis', async () => {
    queueFixture.commands = prompts(LONG_MESSAGE, 'check now')
    const rows = await frame(80)
    expect(rows).toHaveLength(5)
    expect(rows[1]!.startsWith('  1  word1 word2 ')).toBe(true)
    expect(rows[2]!.startsWith('     word')).toBe(true)
    expect(rows[2]!.endsWith('…')).toBe(true)
    expect(rows[3]).toBe('  2  check now')
    for (const row of rows) expect(terminalCells(row)).toBeLessThanOrEqual(inner(80))
  })

  it('seven inputs: five are listed, then one row counts the rest', async () => {
    queueFixture.commands = prompts(...Array.from({ length: 7 }, (_, index) => `input number ${index + 1}`))
    const rows = await frame(100)
    expect(rows.slice(1, 7)).toEqual([
      '  1  input number 1',
      '  2  input number 2',
      '  3  input number 3',
      '  4  input number 4',
      '  5  input number 5',
      '     2 more queued',
    ])
    expect(rows[7]!.trim()).toMatch(/^─+$/)
  })

  it('lists every input while they cannot be sent, however many wait', async () => {
    queueFixture.commands = prompts(...Array.from({ length: 12 }, (_, index) => `input number ${index + 1}`))
    const rows = await frame(100, true)
    expect(rows).toHaveLength(14)
    expect(rows[1]).toBe('   1  input number 1')
    expect(rows[12]).toBe('  12  input number 12')
    expect(rows.join('\n')).not.toContain('more queued')
  })

  it('a narrow band drops the hint before it cuts an entry', async () => {
    queueFixture.commands = prompts('check the vbmeta flags', 'flash it')
    const rows = await frame(40)
    expect(rows[0]).toBe('  next')
    expect(rows[1]).toBe('  1  check the vbmeta flags')
    expect(rows[2]).toBe('  2  flash it')
  })

  it('only typed inputs are listed; hidden and system items are not', async () => {
    queueFixture.commands = [
      { value: 'visible prompt', mode: 'prompt' },
      { value: 'echo queued', mode: 'bash' },
      { value: 'hidden tick', mode: 'prompt', isMeta: true },
      { value: '<task-notification>done</task-notification>', mode: 'task-notification' },
    ]
    const rows = await frame(100)
    expect(rows.slice(1, -1)).toEqual(['  1  visible prompt', '  2  ! echo queued'])
  })

  it('is not drawn while another agent is viewed', async () => {
    viewFixture.viewingAgentTaskId = 'agent-1'
    queueFixture.commands = prompts('check now')
    expect(await frame(100)).toEqual([])
  })

  it.each([
    ['dark', { text2: '178;178;178', text3: '138;138;138', ink: '255;255;255', subtle: '82;82;82' }],
    ['light', { text2: '86;86;86', text3: '118;118;118', ink: '0;0;0', subtle: '158;158;158' }],
  ] as const)('the %s theme: gray header, gray numbers, ink text, a subtle hairline', async (theme, gray) => {
    queueFixture.commands = prompts('check the vbmeta flags too', 'then flash boot_b')
    const { PromptBandQueuedInputs } = await import(
      '../../../../src/tui/components/PromptInput/PromptInputQueuedCommands.js'
    )
    const ansi = await renderToAnsiString(
      <ThemeProvider initialState={theme}>
        <PromptBandQueuedInputs width={94} />
      </ThemeProvider>,
      { columns: 94, color: true },
    )
    const lines = ansi.split('\n')
    const plain = stripAnsi(ansi)
    expect(plain).toContain('next')
    expect(plain).toContain(HINT)
    // The header word is bold in text2, the hint in text3.
    expect(lines[0]).toMatch(new RegExp(`\\x1b\\[(?:1;)?38;2;${gray.text2}m(?:\\x1b\\[1m)?next|\\x1b\\[1m\\x1b\\[38;2;${gray.text2}mnext`))
    expect(lines[0]).toContain(`38;2;${gray.text3}m${HINT}`)
    // Numbers in text3, input text in ink.
    expect(lines[1]).toContain(`38;2;${gray.text3}m1  `)
    expect(lines[1]).toContain(`38;2;${gray.ink}mcheck the vbmeta flags too`)
    // The hairline in the subtle gray.
    expect(lines[3]).toContain(`38;2;${gray.subtle}m─`)
    // The block paints no background of its own: the band behind it does.
    expect(ansi).not.toMatch(/\x1b\[(?:[0-9;]*;)?(?:4[0-8]|10[0-7])[;m]/)
  })
})
