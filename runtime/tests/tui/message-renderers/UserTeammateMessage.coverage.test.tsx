import React from 'react'
import { describe, expect, test } from 'vitest'

import { TEAMMATE_MESSAGE_TAG } from '../../constants/xml.js'
import { renderToString } from '../../utils/staticRender.js'
import { UserTeammateMessage } from './UserTeammateMessage.js'

function teammateMessage({
  teammateId,
  color,
  summary,
  content,
}: {
  teammateId: string
  color?: string
  summary?: string
  content: string
}): string {
  const colorAttribute = color ? ` color="${color}"` : ''
  const summaryAttribute = summary ? ` summary="${summary}"` : ''

  return `<${TEAMMATE_MESSAGE_TAG} teammate_id="${teammateId}"${colorAttribute}${summaryAttribute}>
${content}
</${TEAMMATE_MESSAGE_TAG}>`
}

describe('UserTeammateMessage coverage', () => {
  test('renders visible teammate updates and hides lifecycle noise', async () => {
    const output = await renderToString(
      <UserTeammateMessage
        addMargin={false}
        isTranscriptMode={true}
        param={{
          type: 'text',
          text: [
            teammateMessage({
              teammateId: 'builder',
              color: 'green',
              summary: 'ready for review',
              content: 'Investigated renderer output\nCaptured the terminal text',
            }),
            teammateMessage({
              teammateId: 'leader',
              color: 'yellow',
              content: JSON.stringify({
                type: 'task_completed',
                from: 'leader',
                taskId: 'TUI-17',
                taskSubject: 'write renderer coverage',
              }),
            }),
            teammateMessage({
              teammateId: 'builder',
              content: JSON.stringify({
                type: 'idle_notification',
                from: 'builder',
                timestamp: '2026-05-20T00:00:00.000Z',
              }),
            }),
            teammateMessage({
              teammateId: 'builder',
              content: JSON.stringify({
                type: 'teammate_terminated',
                message: 'terminated message should stay hidden',
              }),
            }),
            teammateMessage({
              teammateId: 'builder',
              content: JSON.stringify({
                type: 'shutdown_approved',
                requestId: 'shutdown-builder',
                from: 'builder',
                timestamp: '2026-05-20T00:00:01.000Z',
              }),
            }),
          ].join('\n'),
        }}
      />,
      { columns: 120 },
    )

    expect(output).toContain('@builder')
    expect(output).toContain('ready for review')
    expect(output).toContain('Investigated renderer output')
    expect(output).toContain('Captured the terminal text')
    expect(output).toContain('@leader')
    expect(output).toContain('Completed task #TUI-17')
    expect(output).toContain('(write renderer coverage)')
    expect(output).not.toContain('idle_notification')
    expect(output).not.toContain('terminated message should stay hidden')
    expect(output).not.toContain('shutdown_approved')
  })
})
