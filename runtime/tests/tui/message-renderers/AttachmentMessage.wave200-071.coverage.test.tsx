import React from 'react'
import { describe, expect, test, vi } from 'vitest'

import { renderToString } from '../../utils/staticRender.js'
import { AttachmentMessage } from './AttachmentMessage.js'

vi.mock('bun:bundle', () => ({
  feature: () => false,
}))

vi.mock('../../utils/agentSwarmsEnabled.js', () => ({
  isAgentSwarmsEnabled: () => true,
}))

vi.mock('../../utils/teammateMailbox.js', () => ({
  isTaskAssignment: (text: string) => {
    try {
      const parsed = JSON.parse(text)
      if (
        parsed?.type === 'task_assignment' &&
        typeof parsed.taskId === 'string' &&
        typeof parsed.subject === 'string'
      ) {
        return { assignedBy: '', description: '', timestamp: '', ...parsed }
      }
    } catch {
      // Not JSON.
    }
    return null
  },
  isShutdownApproved: (text: string) => text === 'shutdown-approved',
}))

vi.mock('../components/messageActions', () => ({
  useSelectedMessageBg: () => undefined,
}))

vi.mock('./PlanApprovalMessage', async () => {
  const ReactActual = await vi.importActual<typeof import('react')>('react')

  return {
    formatTeammateMessageContent: (text: string) =>
      text === 'plain-fallback' ? undefined : `formatted ${text}`,
    tryRenderPlanApprovalMessage: (text: string, from: string) =>
      text === 'plan-approval'
        ? ReactActual.createElement(
            'ink-text',
            null,
            `plan approval from ${from}`,
          )
        : null,
  }
})

vi.mock('./UserTeammateMessage', async () => {
  const ReactActual = await vi.importActual<typeof import('react')>('react')

  return {
    TeammateMessageContent: ({
      content,
      displayName,
    }: {
      content: string
      displayName: string
    }) => ReactActual.createElement('ink-text', null, `${displayName}: ${content}`),
  }
})

function renderAttachment(attachment: unknown): Promise<string> {
  return renderToString(
    <AttachmentMessage
      addMargin={false}
      attachment={attachment as never}
      verbose={false}
    />,
    { columns: 120 },
  )
}

describe('AttachmentMessage wave200-071 coverage', () => {
  test('handles teammate mailbox filtering and fallback render paths', async () => {
    const hiddenOutput = await renderAttachment({
      messages: [
        { from: 'system', text: 'shutdown-approved' },
        { from: 'system', text: '{"type":"idle_notification"}' },
        { from: 'system', text: '{"type":"teammate_terminated"}' },
      ],
      type: 'teammate_mailbox',
    })

    expect(hiddenOutput.trim()).toBe('')

    const output = await renderAttachment({
      messages: [
        {
          from: 'Dispatcher',
          text: JSON.stringify({
            subject: 'Audit rendering',
            taskId: 'TUI-71',
            type: 'task_assignment',
          }),
        },
        { from: 'Planner', text: 'plan-approval' },
        { from: 'Writer', text: 'plain-fallback' },
      ],
      type: 'teammate_mailbox',
    })

    expect(output).toContain('Task assigned: #TUI-71 - Audit rendering')
    expect(output).toContain('(from Dispatcher)')
    expect(output).toContain('plan approval from Planner')
    expect(output).toContain('Writer: plain-fallback')
  })
})
