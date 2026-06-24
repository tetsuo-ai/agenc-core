import React from 'react'
import { describe, expect, test } from 'vitest'

import { Msg, WelcomeColdPanel } from '../../src/tui/components/v2/primitives.js'
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
