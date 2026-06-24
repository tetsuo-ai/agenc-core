import React from 'react'
import { describe, expect, test } from 'vitest'

import { renderToString } from '../../utils/staticRender.js'
import { QueuedMessageProvider } from '../context/QueuedMessageContext.js'
import { UserPromptMessage } from './UserPromptMessage.js'

describe('UserPromptMessage coverage', () => {
  test('renders long prompts with head-tail truncation in the user message layout', async () => {
    const head = `HEAD_START ${'h'.repeat(2_489)}`
    const hidden = Array.from(
      { length: 900 },
      (_, index) => `MIDDLE_SENTINEL_${index}`,
    ).join('\n')
    const tail = `${'t'.repeat(2_491)} TAIL_END`

    const output = await renderToString(
      <UserPromptMessage
        addMargin={false}
        param={{ type: 'text', text: `${head}\n${hidden}\n${tail}` }}
        timestamp="2026-06-24T12:34:00.000Z"
      />,
      { columns: 6_000, rows: 24 },
    )

    expect(output).toContain('YOU')
    // Header shows a short local time, never the raw ISO machine timestamp.
    expect(output).toMatch(/\d{1,2}:\d{2}/)
    expect(output).not.toContain('2026-06-24T12:34:00.000Z')
    expect(output).toContain('HEAD_START')
    expect(output).toContain('TAIL_END')
    expect(output).toMatch(/… \+\d+ lines …/)
    expect(output).not.toContain('MIDDLE_SENTINEL')
  })

  // Regression: the standard transcript YOU header used to leak the raw
  // ISO-8601 machine timestamp (e.g. "2026-06-24T01:37:00.437Z"). It must
  // now render a short local time via formatBriefTimestamp.
  test('renders a short local time in the YOU header, never a raw ISO timestamp', async () => {
    const output = await renderToString(
      <UserPromptMessage
        addMargin={false}
        param={{ type: 'text', text: 'hello there' }}
        timestamp="2026-06-24T01:37:00.437Z"
      />,
      { columns: 100, rows: 12 },
    )

    expect(output).toContain('YOU')
    expect(output).toContain('hello there')
    // No raw ISO machine timestamp in the header.
    expect(output).not.toContain('2026-06-24T01:37:00.437Z')
    expect(output).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/)
    expect(output).not.toContain('Z')
    // A short clock time is present (e.g. "1:37 AM" or "01:37").
    expect(output).toMatch(/\d{1,2}:\d{2}/)
  })

  // Regression for the queued-input preview bug: queued previews used to all
  // share one identical render-time ISO timestamp. The queue now hands
  // createUserMessage an explicit empty timestamp (no render-time default), so
  // the preview shows a neutral "queued" marker instead of a machine clock.
  // This renders the same UserPromptMessage the queue renders, with the empty
  // timestamp the queue supplies, inside the queued context.
  test('queued preview shows a quiet "queued" marker, never a render-time ISO clock', async () => {
    const renderQueued = (text: string) =>
      renderToString(
        <QueuedMessageProvider isFirst>
          <UserPromptMessage
            addMargin={false}
            param={{ type: 'text', text }}
            isTranscriptMode={false}
            timestamp=""
          />
        </QueuedMessageProvider>,
        { columns: 100, rows: 12 },
      )

    // Body text deliberately avoids the word "queued" so the marker assertion
    // below is revert-sensitive to the header rendering.
    const first = await renderQueued('first pending prompt')
    const second = await renderQueued('second pending prompt')

    for (const output of [first, second]) {
      expect(output).toContain('YOU')
      expect(output).toContain('queued')
      // No machine timestamp of any kind.
      expect(output).not.toMatch(/\d{4}-\d{2}-\d{2}T/)
      expect(output).not.toMatch(/\d{1,2}:\d{2}/)
    }
    expect(first).toContain('first pending prompt')
    expect(second).toContain('second pending prompt')
  })
})
