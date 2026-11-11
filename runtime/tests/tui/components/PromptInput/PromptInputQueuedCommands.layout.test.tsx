/**
 * The list of queued inputs under the transcript.
 *
 * Owner report (2026-11-11, third screenshot): the queued inputs were shown
 * as tinted bands with a "queued" label each, and one message appeared
 * without its first letter. The look is now one gray header line and one
 * numbered entry per input:
 *
 *   queued for next turn · ctrl+x backspace drops the last
 *   1  START / RESTART BOOTLOADER / RECOVERY MODE / POWER OFF. what option i
 *      shoudl selecte then
 *   2  check now
 *
 * These tests render the real component (no Message mock) and read the
 * frame in terminal cells.
 */
import React from 'react'
import stripAnsi from 'strip-ansi'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { renderToAnsiString, renderToString } from '../../../../src/utils/staticRender.js'
import { ThemeProvider } from '../../../../src/tui/components/design-system/ThemeProvider.js'
import { terminalCells } from '../markdown/fixtures/terminalCells.js'

vi.mock('bun:bundle', () => ({ feature: () => false }))

const queueFixture = vi.hoisted(() => ({ commands: [] as Array<{ value: string; mode: string }> }))

vi.mock('../../../../src/tui/hooks/useCommandQueue.js', () => ({
  useCommandQueue: () => queueFixture.commands,
}))

vi.mock('../../../../src/tui/state/AppState.js', () => ({
  useAppState: (
    selector: (state: { viewingAgentTaskId?: string; isBriefOnly: boolean }) => unknown,
  ) => selector({ viewingAgentTaskId: undefined, isBriefOnly: false }),
}))

const HEADER = 'queued for next turn · ctrl+x backspace drops the last'
const OWNER_MESSAGE =
  'START / RESTART BOOTLOADER / RECOVERY MODE / POWER OFF. what option i shoudl selecte then'
const LONG_MESSAGE = Array.from({ length: 60 }, (_, index) => `word${index + 1}`).join(' ')
const EMOJI_MESSAGE =
  '✅ listo, ⚠️ revisar 日本語 y 👨‍👩‍👧 antes de seguir con el flash de boot_b en el slot b del equipo'
const WIDTHS = [80, 140]

const prompts = (...values: string[]) => values.map(value => ({ value, mode: 'prompt' }))

async function frame(width: number): Promise<string[]> {
  const { PromptInputQueuedCommands } = await import('./PromptInputQueuedCommands.js')
  const output = await renderToString(<PromptInputQueuedCommands />, width)
  return output.split('\n').map(line => line.trimEnd())
}

/** The rows of the block: no blank rows inside it. */
function block(lines: string[]): string[] {
  const start = lines.findIndex(line => line.includes(HEADER))
  expect(start).toBeGreaterThanOrEqual(0)
  const rows: string[] = []
  for (const line of lines.slice(start)) {
    if (line.trim().length === 0) break
    rows.push(line)
  }
  return rows
}

const squeeze = (text: string): string => text.replace(/\s+/g, '')

describe('queued inputs list', () => {
  beforeEach(() => {
    queueFixture.commands = []
  })

  it.each(WIDTHS)('one input at %i columns: a header and one numbered row', async width => {
    queueFixture.commands = prompts('check now')
    const lines = await frame(width)
    // One blank row above the block.
    expect(lines[0]).toBe('')
    expect(block(lines)).toEqual([`  ${HEADER}`, '  1  check now'])
  })

  it.each(WIDTHS)("the owner's two inputs at %i columns", async width => {
    queueFixture.commands = prompts(OWNER_MESSAGE, 'check now')
    const rows = block(await frame(width))
    if (width === 140) {
      expect(rows).toEqual([`  ${HEADER}`, `  1  ${OWNER_MESSAGE}`, '  2  check now'])
    } else {
      expect(rows).toEqual([
        `  ${HEADER}`,
        '  1  START / RESTART BOOTLOADER / RECOVERY MODE / POWER OFF. what option i',
        '     shoudl selecte then',
        '  2  check now',
      ])
    }
    // No band, label or prompt arrow per entry, and no count in the header.
    const text = rows.join('\n')
    expect(text).not.toContain('❯')
    expect(text).not.toMatch(/\d inputs? queued/)
    expect(rows.filter(row => row.includes('queued'))).toHaveLength(1)
  })

  it.each(WIDTHS)('seven inputs at %i columns: five are listed, one line counts the rest', async width => {
    queueFixture.commands = prompts(...Array.from({ length: 7 }, (_, index) => `input number ${index + 1}`))
    expect(block(await frame(width))).toEqual([
      `  ${HEADER}`,
      '  1  input number 1',
      '  2  input number 2',
      '  3  input number 3',
      '  4  input number 4',
      '  5  input number 5',
      '     2 more queued',
    ])
  })

  it.each(WIDTHS)('a long input at %i columns takes two rows and ends with an ellipsis', async width => {
    queueFixture.commands = prompts(LONG_MESSAGE, 'check now')
    const rows = block(await frame(width))
    expect(rows).toHaveLength(4)
    const [, first, second, next] = rows
    // Shown from its first character, never from its tail.
    expect(first!.startsWith('  1  word1 word2 ')).toBe(true)
    expect(second!.startsWith('     word')).toBe(true)
    expect(second!.endsWith('…')).toBe(true)
    expect(next).toBe('  2  check now')
    // What is shown is the start of the message, in order, with nothing left out.
    const shown = squeeze(first!.slice(5) + second!.slice(5, -1))
    expect(squeeze(LONG_MESSAGE).startsWith(shown)).toBe(true)
    for (const row of rows) expect(terminalCells(row)).toBeLessThanOrEqual(width - 1)
  })

  it.each(WIDTHS)('an input with emoji and wide characters keeps the indent at %i columns', async width => {
    queueFixture.commands = prompts(EMOJI_MESSAGE, 'check now')
    const rows = block(await frame(width))
    expect(rows[1]!.startsWith('  1  ✅ listo, ')).toBe(true)
    for (const row of rows.slice(1)) {
      // Text starts in the sixth cell of every row of an entry.
      expect(row.slice(0, 5).trim()).toMatch(/^\d?$/)
      expect(row[5]).not.toBe(' ')
      expect(terminalCells(row)).toBeLessThanOrEqual(width - 1)
    }
    expect(squeeze(rows.slice(1, -1).map(row => row.slice(5)).join(''))).toBe(squeeze(EMOJI_MESSAGE))
    expect(rows.at(-1)).toBe('  2  check now')
  })

  it('a message with line breaks is shown as one line of text from its first word', async () => {
    queueFixture.commands = prompts(`  i see a menu:\n\n${OWNER_MESSAGE}`)
    const rows = block(await frame(140))
    expect(rows[1]).toBe(`  1  i see a menu: ${OWNER_MESSAGE}`)
  })

  it('every message is shown from its first character, whatever it starts with', async () => {
    for (const start of ['S', 's', '/', '!', '#', '>', '-', '*', '1.', '`', '<', '[', '✅', '日']) {
      queueFixture.commands = prompts(`${start}TART / RESTART BOOTLOADER`)
      const rows = block(await frame(100))
      expect(rows[1]).toBe(`  1  ${start}TART / RESTART BOOTLOADER`)
    }
  })

  it.each(['dark', 'light'] as const)('the block has no fill and one gray in the %s theme', async theme => {
    queueFixture.commands = prompts(OWNER_MESSAGE, 'check now')
    const { PromptInputQueuedCommands } = await import('./PromptInputQueuedCommands.js')
    const ansi = await renderToAnsiString(
      <ThemeProvider initialState={theme}>
        <PromptInputQueuedCommands />
      </ThemeProvider>,
      { columns: 100, color: true },
    )
    expect(stripAnsi(ansi)).toContain(HEADER)
    // No background color anywhere (SGR 40-49, 100-107).
    expect(ansi).not.toMatch(/\x1b\[(?:[0-9;]*;)?(?:4[0-8]|10[0-7])[;m]/)
    // One foreground color, and it is a gray: red, green and blue are equal.
    const colors = new Set(Array.from(ansi.matchAll(/\x1b\[38;2;(\d+);(\d+);(\d+)m/g), match => match.slice(1).join(',')))
    expect(colors.size).toBe(1)
    const [red, green, blue] = [...colors][0]!.split(',')
    expect(red).toBe(green)
    expect(green).toBe(blue)
  })
})
