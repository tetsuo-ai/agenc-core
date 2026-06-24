import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToString } from '../../../../src/utils/staticRender.js'

// Unlike PromptInputQueuedCommands.test.tsx, this suite deliberately renders the
// REAL Message → UserPromptMessage → Msg → HighlightedThinkingText path (no
// Message mock) so it exercises the actual queued-preview wrap + spacing.

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

// Uniform 4-char words guarantee a wrap boundary lands on a word-gap space at
// width 40, so the no-trim default reliably leaves a leading boundary space on
// each continuation line (the +1-indent bug this test guards against).
const WRAPPING_BODY =
  'aaaa bbbb cccc dddd eeee ffff gggg hhhh iiii jjjj kkkk llll mmmm nnnn oooo pppp qqqq'

// Pull out the body lines under a "▮ YOU queued" header and return their
// leading-space counts (the indent of each rendered continuation line).
function bodyLeadWidths(output: string): number[] {
  const lines = output.split('\n')
  const headerIndex = lines.findIndex((line) => line.includes('YOU queued'))
  if (headerIndex === -1) return []
  const body: number[] = []
  for (const line of lines.slice(headerIndex + 1)) {
    if (line.trim().length === 0) break
    if (line.includes('YOU queued')) break
    body.push(line.length - line.trimStart().length)
  }
  return body
}

describe('PromptInputQueuedCommands layout', () => {
  beforeEach(() => {
    queueFixture.commands = []
  })

  it('left-aligns wrapped continuation lines of a queued body with the first line', async () => {
    queueFixture.commands = [{ value: WRAPPING_BODY, mode: 'prompt' }]
    const { PromptInputQueuedCommands } = await import('./PromptInputQueuedCommands.js')

    const output = await renderToString(<PromptInputQueuedCommands />, 40)
    const leads = bodyLeadWidths(output)

    // The body must wrap onto multiple lines (otherwise the test is vacuous).
    expect(leads.length).toBeGreaterThan(1)
    // Every wrapped line shares the first line's indent — no +1-column drift
    // from a retained leading boundary space.
    for (const lead of leads) {
      expect(lead).toBe(leads[0])
    }
  })

  it('puts exactly one blank line between consecutive queued items and none before the first', async () => {
    queueFixture.commands = [
      { value: 'first queued prompt', mode: 'prompt' },
      { value: 'second queued prompt', mode: 'prompt' },
      { value: 'third queued prompt', mode: 'prompt' },
    ]
    const { PromptInputQueuedCommands } = await import('./PromptInputQueuedCommands.js')

    const output = await renderToString(<PromptInputQueuedCommands />, 60)
    const lines = output.split('\n')

    // Collect the row index of each item's "YOU queued" header.
    const headerRows = lines
      .map((line, index) => (line.includes('YOU queued') ? index : -1))
      .filter((index) => index !== -1)

    expect(headerRows).toHaveLength(3)

    // Between every adjacent pair of items there must be a separating blank
    // line (header rows at least 2 apart, with a blank between the previous
    // item's last body line and the next header).
    for (let i = 1; i < headerRows.length; i++) {
      const prevHeader = headerRows[i - 1]!
      const thisHeader = headerRows[i]!
      const between = lines.slice(prevHeader + 1, thisHeader)
      const hasBlank = between.some((line) => line.trim().length === 0)
      expect(hasBlank).toBe(true)
    }

    // The first item must NOT have an extra blank immediately above its body
    // beyond the banner gap: its header is the first "YOU queued" row, and the
    // banner (with its own marginBottom) sits above it — there is no double gap
    // before the first item.
    const firstHeader = headerRows[0]!
    expect(lines[firstHeader]).toContain('YOU queued')
  })
})
