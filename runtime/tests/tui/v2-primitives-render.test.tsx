import React from 'react'
import { describe, expect, test } from 'vitest'

import { Msg, Tool, WelcomeColdPanel } from '../../src/tui/components/v2/primitives.js'
import { Box, Text } from '../../src/tui/ink.js'
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
// BUG 3 — welcome card meta row / recent session row grid alignment.
//
// A long workspace path (or recent-session title) must truncate IN PLACE on the
// same line as its label, keeping the 2-column label/value grid aligned —
// rather than wrapping the value onto a fresh flex line under the label.
// ---------------------------------------------------------------------------

const LONG_WORKSPACE = '/tmp/some/very/long/absolute/path/to/a/workspace/sandbox/dir'

function renderWelcome(extra?: {
  readonly recentSessions?: React.ComponentProps<typeof WelcomeColdPanel>['recentSessions']
}): Promise<string> {
  return renderToString(
    <ContentWidthProvider width={64}>
      <WelcomeColdPanel
        workspace={LONG_WORKSPACE}
        model="default model"
        lastSession="12m ago · clean"
        recentSessions={extra?.recentSessions}
      />
    </ContentWidthProvider>,
    { columns: 80, rows: 30 },
  )
}

/** Card body rows (inside the border), trimmed of trailing padding. */
function cardLines(out: string): string[] {
  return out
    .split('\n')
    .map(line => line.replace(/^│/u, '').replace(/│\s*$/u, '').trimEnd())
}

describe('WelcomeMetaRow long-path grid alignment (BUG 3)', () => {
  test('the workspace value stays on the same line as its label', async () => {
    const out = await renderWelcome()
    const lines = cardLines(out)

    // The label and (truncated) value share one row. truncate-middle inserts an
    // ellipsis, so match on the stable path head + tail around the label.
    const labelRow = lines.find(line => /\bworkspace\b/u.test(line))
    expect(labelRow).toBeDefined()
    // The value must be present on the SAME row as the label.
    expect(labelRow).toContain('/tmp/some/very/long')
    expect(labelRow).toContain('sandbox/dir')

    // Revert-sensitivity guard: there must be NO standalone value row (a row
    // that carries the path WITHOUT the label) — that is the wrapped/broken
    // layout the fix removes.
    const orphanValueRow = lines.find(
      line => line.includes('sandbox/dir') && !/\bworkspace\b/u.test(line),
    )
    expect(orphanValueRow).toBeUndefined()
  })

  test('a long recent-session title truncates in place and keeps the [n] key prefix', async () => {
    const out = await renderWelcome({
      recentSessions: [
        {
          keyName: '1',
          title: 'a-session-with-a-really-long-title-here',
          detail: 'yesterday · main · clean · plus more detail text',
        },
      ],
    })
    const lines = cardLines(out)
    const row = lines.find(line => line.includes('a-session-with-a-really'))
    expect(row).toBeDefined()
    // The fixed `[1] ` key prefix survives (not squeezed to `1]`), and the row
    // truncates rather than wrapping the detail to its own line.
    expect(row).toContain('[1]')
    // The detail keeps reading on the SAME row as the title/key.
    expect(row).toContain('yesterday')
    // Revert-sensitivity: the pre-fix `flexWrap="wrap"` row pushed the `· detail`
    // segment onto its own flex line under the `[1]` key. There must be no such
    // orphan detail row (a `yesterday …` line with no title/key on it).
    const orphanDetailRow = lines.find(
      line => line.includes('yesterday') && !line.includes('a-session-with-a-really'),
    )
    expect(orphanDetailRow).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// BUG A — Tool call header collapses when the args overflow the content width.
//
// `● Run (cmd)` renders correctly only when the args FIT. When the args overflow
// (the common case for any real bash/Read/Edit/Grep command) Yoga shrank the
// leading glyph, the bold label, AND the parens along with the args, so the row
// degraded to `●Run  cmd…)` — the glyph/label gap collapsed (`●Run`), a doubled
// space appeared after the label, the opening `(` was DROPPED, and the closing
// `)` survived (unbalanced parens).
//
// The fix pins the glyph, the label, and both parens flexShrink={0} and lets ONLY
// the inner args text (flexShrink={1} minWidth={0}, truncate-middle) give way.
// The asserted shape `● Run (…)` is the same hug as the short-fitting case.
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
  test('a fitting arg keeps the canonical `● Run (cmd)` shape', async () => {
    const row = await firstToolRow(<Tool kind="bash" label="Run" args="short cmd" />, 90)
    expect(row).toBe('● Run (short cmd)')
  })

  test('an overflowing bash arg keeps glyph/space/label/space/open-paren and the closing paren', async () => {
    const row = await firstToolRow(<Tool kind="bash" label="Run" args={LONG_TOOL_ARGS} />, 90)

    // Glyph, single space, bold label, single space, opening paren — all intact.
    // Against the pre-fix code the row started `●Run  ` (glyph touching label, no
    // space; doubled space after label) and the `(` was missing entirely, so this
    // exact prefix is the revert-sensitive guard.
    expect(row.startsWith('● Run (')).toBe(true)
    // The opening paren is present and the args text was truncated in the middle
    // (the ellipsis appears between the open paren and the close paren).
    expect(row).toContain('…')
    // The closing paren survives — and balances the opening one.
    expect(row.endsWith(')')).toBe(true)
    expect((row.match(/\(/g) ?? []).length).toBe(1)
    expect((row.match(/\)/g) ?? []).length).toBe(1)
    // Revert-sensitivity, negative form: the collapsed defects must be gone.
    expect(row.startsWith('●Run')).toBe(false)
    expect(row).not.toContain('Run  ')
  })

  test.each(['edit', 'read', 'grep'] as const)(
    'kind=%s collapses the same way and is fixed by the same pinning',
    async kind => {
      const expectedLabel = kind.charAt(0).toUpperCase() + kind.slice(1)
      const row = await firstToolRow(<Tool kind={kind} args={LONG_TOOL_ARGS} />, 90)
      expect(row.startsWith(`● ${expectedLabel} (`)).toBe(true)
      expect(row.endsWith(')')).toBe(true)
      expect((row.match(/\(/g) ?? []).length).toBe(1)
      expect((row.match(/\)/g) ?? []).length).toBe(1)
      // The collapsed `●Edit`/`●Read`/`●Grep` (no glyph space) must not reappear.
      expect(row.startsWith(`●${expectedLabel}`)).toBe(false)
    },
  )

  test('the defect reproduces across narrow widths and the fix holds at each', async () => {
    for (const width of [70, 60, 50]) {
      const row = await firstToolRow(<Tool kind="bash" label="Run" args={LONG_TOOL_ARGS} />, width)
      expect(row.startsWith('● Run (')).toBe(true)
      expect(row.endsWith(')')).toBe(true)
    }
  })
})
