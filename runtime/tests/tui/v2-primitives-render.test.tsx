import React from 'react'
import { describe, expect, test } from 'vitest'

import { Msg, Tool } from '../../src/tui/components/v2/primitives.js'
import { Box, Text } from '../../src/tui/ink.js'
import { stringWidth } from '../../src/tui/ink/stringWidth.js'
import {
  ContentWidthProvider,
  useContentWidth,
} from '../../src/tui/context/contentWidthContext.js'
import { QueuedMessageProvider } from '../../src/tui/context/QueuedMessageContext.js'
import { renderToString } from '../../src/utils/staticRender.js'

// ---------------------------------------------------------------------------
// BUG 1 — queued-message preview body wrap width.
//
// Queued previews render inside QueuedMessageProvider's `<Box paddingX={2}>`
// (4 cols of horizontal padding). `Msg` propagates a ContentWidth to its body
// for downstream consumers (markdown/system messages size an explicit-width
// box from useContentWidth(), e.g. SystemTextMessage). Before the fix that
// propagated width subtracted only the 2-col marker inset and ignored the
// queued container padding, so the first wrapped body line could overshoot the
// queued highlight box's interior by up to the padding width.
//
// `WidthProbe` mirrors a real downstream consumer: it reads useContentWidth()
// and paints a solid block exactly that wide, so the propagated value is
// directly observable as a row width.
// ---------------------------------------------------------------------------

function WidthProbe(): React.ReactNode {
  const w = useContentWidth() ?? 0
  return (
    <Box width={w}>
      <Text>{'#'.repeat(Math.max(0, w))}</Text>
    </Box>
  )
}

const PARENT_CONTENT_WIDTH = 116
// Msg insets the marker glyph + row gap (2 cols) from the inherited width.
const MARKER_INSET = 2
// QueuedMessageProvider (non-brief) padding = paddingX={2} => 4 cols.
const QUEUED_PADDING = 4

async function probeBodyWidth(node: React.ReactNode): Promise<number> {
  const out = await renderToString(
    <ContentWidthProvider width={PARENT_CONTENT_WIDTH}>{node}</ContentWidthProvider>,
    { columns: 130, rows: 10 },
  )
  const row = out.split('\n').find(line => line.includes('#')) ?? ''
  return (row.match(/#/g) ?? []).length
}

// A finished step leads with a static dot (no ✶/✕ state glyphs).
const DONE = '●'

describe('Msg queued body wrap width (BUG 1)', () => {
  test('non-queued message body width is unchanged (marker inset only)', async () => {
    const width = await probeBodyWidth(
      <Msg role="user" label="you">
        <WidthProbe />
      </Msg>,
    )
    // Only the 2-col marker inset is subtracted — no queued padding double-count.
    expect(width).toBe(PARENT_CONTENT_WIDTH - MARKER_INSET)
  })

  test('queued message body width subtracts the queued container padding', async () => {
    const width = await probeBodyWidth(
      <QueuedMessageProvider isFirst>
        <Msg role="user" label="you">
          <WidthProbe />
        </Msg>
      </QueuedMessageProvider>,
    )
    // Marker inset (2) + queued padding (4). Against the pre-fix code this would
    // be PARENT_CONTENT_WIDTH - 2 (4 cols too wide), overshooting the queued
    // highlight box's padded interior — the ragged right edge from the bug.
    expect(width).toBe(PARENT_CONTENT_WIDTH - MARKER_INSET - QUEUED_PADDING)
  })

  test('the queued body never exceeds the queued box interior width', async () => {
    // The queued highlight box reserves paddingX={2} on each side, so the body
    // column (marker + content) must fit within PARENT_CONTENT_WIDTH - padding.
    const width = await probeBodyWidth(
      <QueuedMessageProvider isFirst>
        <Msg role="user" label="you">
          <WidthProbe />
        </Msg>
      </QueuedMessageProvider>,
    )
    const interior = PARENT_CONTENT_WIDTH - QUEUED_PADDING
    expect(width + MARKER_INSET).toBeLessThanOrEqual(interior)
  })
})

// ---------------------------------------------------------------------------
// BUG A — Tool call header collapses when the args overflow the content width.
//
// `● Ran cmd` renders correctly only when the args FIT. When the args overflow
// (the common case for any real bash/Read/Edit/Grep command) Yoga shrank the
// leading glyph and the bold label along with the args, so the row degraded to
// `●Run  cmd…`: the glyph/label gap collapsed (`●Run`) and a doubled space
// appeared after the label. (The row used to wrap the args in parens, and the
// opening `(` was dropped too; the A2 row has no parens.)
//
// The fix pins the glyph and the label flexShrink={0} and lets ONLY the args
// text (flexShrink={1} minWidth={0}, truncate-middle) give way. The asserted
// shape `● Ran …` is the same as the short-fitting case: dot, one space,
// past-tense verb, one space, args.
// ---------------------------------------------------------------------------

const LONG_TOOL_ARGS =
  'python3 /some/very/long/path/to/a/script/that/overflows/the/content/width.py --flag value --another-flag'

/** First (call) row of a rendered Tool, with trailing pad trimmed. */
async function firstToolRow(node: React.ReactNode, contentWidth: number): Promise<string> {
  const out = await renderToString(
    <ContentWidthProvider width={contentWidth}>{node}</ContentWidthProvider>,
    { columns: contentWidth + 10, rows: 10 },
  )
  return (out.split('\n')[0] ?? '').trimEnd()
}

describe('Tool call header under arg overflow (BUG A)', () => {
  test('a fitting arg keeps the canonical `● Ran cmd` shape', async () => {
    const row = await firstToolRow(<Tool kind="bash" label="Run" args="short cmd" />, 90)
    expect(row).toBe(`${DONE} Ran short cmd`)
  })

  test('an unfinished step keeps the present-tense verb', async () => {
    const row = await firstToolRow(
      <Tool kind="bash" label="Run" state="running" args="short cmd" />,
      90,
    )
    expect(row).toBe(`${DONE} Run short cmd`)
  })

  test('an overflowing bash arg keeps glyph/space/label/space and the args tail', async () => {
    const row = await firstToolRow(<Tool kind="bash" label="Run" args={LONG_TOOL_ARGS} />, 90)

    // Glyph, single space, bold label, single space, then the args, all
    // intact. Against the pre-fix code the row started `●Run  ` (glyph touching
    // label, no space; doubled space after label), so this exact prefix is the
    // revert-sensitive guard.
    expect(row.startsWith(`${DONE} Ran python3 `)).toBe(true)
    // The args text was truncated in the middle: the ellipsis sits inside the
    // args and the tail of the command survives.
    expect(row).toContain('…')
    expect(row.endsWith('--another-flag')).toBe(true)
    expect(stringWidth(row)).toBeLessThanOrEqual(100)
    // No parens around the args.
    expect(row).not.toContain('(')
    expect(row).not.toContain(')')
    // Revert-sensitivity, negative form: the collapsed defects must be gone.
    expect(row.startsWith(`${DONE}Ran`)).toBe(false)
    expect(row).not.toContain('Ran  ')
  })

  test.each([
    ['edit', 'Edited'],
    ['read', 'Read'],
    ['grep', 'Searched'],
  ] as const)(
    'kind=%s collapses the same way and is fixed by the same pinning',
    async (kind, expectedLabel) => {
      // The label defaults to the capitalized kind, shown in past tense once
      // the step is done (Read stays Read).
      const row = await firstToolRow(<Tool kind={kind} args={LONG_TOOL_ARGS} />, 90)
      expect(row.startsWith(`${DONE} ${expectedLabel} python3 `)).toBe(true)
      expect(row).toContain('…')
      expect(row.endsWith('--another-flag')).toBe(true)
      expect(row).not.toContain('(')
      // The collapsed `<glyph>Edited` (no space after the glyph) must not reappear.
      expect(row.startsWith(`${DONE}${expectedLabel}`)).toBe(false)
      expect(row).not.toContain(`${expectedLabel}  `)
    },
  )

  test('the defect reproduces across narrow widths and the fix holds at each', async () => {
    for (const width of [70, 60, 50]) {
      const row = await firstToolRow(<Tool kind="bash" label="Run" args={LONG_TOOL_ARGS} />, width)
      expect(row.startsWith(`${DONE} Ran python3 `)).toBe(true)
      expect(row.endsWith('--another-flag')).toBe(true)
      expect(stringWidth(row)).toBeLessThanOrEqual(width + 10)
    }
  })
})
