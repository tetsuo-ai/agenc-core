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

    // No role-label or timestamp header (both removed per UX request): the
    // message renders bare under the role gutter.
    expect(output).not.toContain('YOU')
    expect(output).not.toMatch(/\d{1,2}:\d{2}/)
    expect(output).not.toContain('2026-06-24T12:34:00.000Z')
    expect(output).toContain('HEAD_START')
    expect(output).toContain('TAIL_END')
    expect(output).toMatch(/… \+\d+ lines …/)
    expect(output).not.toContain('MIDDLE_SENTINEL')
  })

  // The standard transcript user row used to carry a timestamp header. Per UX
  // request the header is gone entirely: the message speaks for itself, with
  // only the role gutter for identity. The brief layout keeps its timestamp.
  test('renders no timestamp header over a user prompt', async () => {
    const output = await renderToString(
      <UserPromptMessage
        addMargin={false}
        param={{ type: 'text', text: 'hello there' }}
        timestamp="2026-06-24T01:37:00.437Z"
      />,
      { columns: 100, rows: 12 },
    )

    expect(output).not.toContain('YOU')
    expect(output).toContain('hello there')
    // No header of any kind above the message: no raw ISO, no clock time.
    expect(output).not.toContain('2026-06-24T01:37:00.437Z')
    expect(output).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/)
    expect(output).not.toMatch(/\d{1,2}:\d{2}/)
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
      expect(output).not.toContain('YOU')
      expect(output).toContain('queued')
      // No machine timestamp of any kind.
      expect(output).not.toMatch(/\d{4}-\d{2}-\d{2}T/)
      expect(output).not.toMatch(/\d{1,2}:\d{2}/)
    }
    expect(first).toContain('first pending prompt')
    expect(second).toContain('second pending prompt')
  })
})
