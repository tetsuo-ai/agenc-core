import React from 'react'
import { describe, expect, test, vi } from 'vitest'

vi.mock('bun:bundle', () => ({
  feature: () => false,
}))

vi.mock('../../../src/tui/hooks/useSettings.js', () => ({
  useSettings: () => ({
    syntaxHighlightingDisabled: true,
  }),
}))

import { TEAMMATE_MESSAGE_TAG } from '../../../src/constants/xml.js'
import { UserTeammateMessage } from '../../../src/tui/message-renderers/UserTeammateMessage.js'
import { renderToString } from '../../../src/utils/staticRender.js'

function teammateMessage({
  teammateId,
  color,
  summary,
  content,
}: {
  readonly teammateId: string
  readonly color?: string
  readonly summary?: string
  readonly content: string
}): string {
  const colorAttribute = color ? ` color="${color}"` : ''
  const summaryAttribute = summary ? ` summary="${summary}"` : ''

  return `<${TEAMMATE_MESSAGE_TAG} teammate_id="${teammateId}"${colorAttribute}${summaryAttribute}>
${content}
</${TEAMMATE_MESSAGE_TAG}>`
}

function payload(value: Record<string, unknown>): string {
  return JSON.stringify(value)
}

async function renderUserTeammateMessage(
  text: string,
  options: {
    readonly addMargin?: boolean
    readonly isTranscriptMode?: boolean
  } = {},
): Promise<string> {
  return renderToString(
    <UserTeammateMessage
      addMargin={options.addMargin ?? false}
      isTranscriptMode={options.isTranscriptMode}
      param={{ type: 'text', text }}
    />,
    { columns: 120, rows: 30 },
  )
}

describe('UserTeammateMessage coverage swarm 105', () => {
  test('renders nothing for unmatched input, empty teammate content, and lifecycle-only messages', async () => {
    expect((await renderUserTeammateMessage('plain text')).trim()).toBe('')
    expect(
      (
        await renderUserTeammateMessage(
          `<${TEAMMATE_MESSAGE_TAG} teammate_id="empty"></${TEAMMATE_MESSAGE_TAG}>`,
        )
      ).trim(),
    ).toBe('')
    expect(
      (
        await renderUserTeammateMessage(
          teammateMessage({
            teammateId: 'worker',
            content: payload({
              type: 'shutdown_approved',
              requestId: 'shutdown-105',
              from: 'worker',
              timestamp: '2026-05-20T00:00:00.000Z',
            }),
          }),
        )
      ).trim(),
    ).toBe('')
  })

  test('renders plan approval request and response payloads from teammate messages', async () => {
    const output = await renderUserTeammateMessage(
      [
        teammateMessage({
          teammateId: 'planner',
          color: 'cyan',
          content: payload({
            type: 'plan_approval_request',
            from: 'planner',
            timestamp: '2026-05-20T00:00:00.000Z',
            planFilePath: '/tmp/row-105-plan.md',
            planContent: '# Row 105\n\n- Add teammate renderer coverage',
            requestId: 'plan-105',
          }),
        }),
        teammateMessage({
          teammateId: 'leader',
          color: 'green',
          content: payload({
            type: 'plan_approval_response',
            requestId: 'plan-105',
            approved: false,
            feedback: 'Tighten the branch assertions.',
            timestamp: '2026-05-20T00:00:01.000Z',
          }),
        }),
      ].join('\n'),
    )

    expect(output).toContain('Plan Approval Request from planner')
    expect(output).toContain('Row 105')
    expect(output).toContain('Plan file: /tmp/row-105-plan.md')
    expect(output).toContain('Plan Rejected by leader')
    expect(output).toContain('Feedback: Tighten the branch assertions.')
  })

  test('renders shutdown request, shutdown rejection, and task assignment payloads', async () => {
    const output = await renderUserTeammateMessage(
      [
        teammateMessage({
          teammateId: 'leader',
          content: payload({
            type: 'shutdown_request',
            requestId: 'shutdown-105',
            from: 'leader',
            reason: 'coverage pass complete',
            timestamp: '2026-05-20T00:00:00.000Z',
          }),
        }),
        teammateMessage({
          teammateId: 'worker',
          content: payload({
            type: 'shutdown_rejected',
            requestId: 'shutdown-105',
            from: 'worker',
            reason: 'target test still running',
            timestamp: '2026-05-20T00:00:01.000Z',
          }),
        }),
        teammateMessage({
          teammateId: 'leader',
          content: payload({
            type: 'task_assignment',
            taskId: '105',
            subject: 'Cover UserTeammateMessage',
            description: 'Exercise structured payload branches.',
            assignedBy: 'leader',
            timestamp: '2026-05-20T00:00:02.000Z',
          }),
        }),
      ].join('\n'),
    )

    expect(output).toContain('Shutdown request from leader')
    expect(output).toContain('Reason: coverage pass complete')
    expect(output).toContain('Shutdown rejected by worker')
    expect(output).toContain('Reason: target test still running')
    expect(output).toContain('Task #105 assigned by leader')
    expect(output).toContain('Cover UserTeammateMessage')
    expect(output).toContain('Exercise structured payload branches.')
  })

  test('renders completed tasks without a subject and plain transcript content with summaries', async () => {
    const transcript = await renderUserTeammateMessage(
      [
        teammateMessage({
          teammateId: 'worker',
          color: 'magenta',
          summary: 'shared raw notes',
          content: '{not json',
        }),
        teammateMessage({
          teammateId: 'worker',
          content: payload({
            type: 'task_completed',
            from: 'worker',
            taskId: '105',
          }),
        }),
      ].join('\n'),
      { addMargin: true, isTranscriptMode: true },
    )

    expect(transcript).toContain('@worker')
    expect(transcript).toContain('shared raw notes')
    expect(transcript).toContain('{not json')
    expect(transcript).toContain('Completed task #105')
    expect(transcript).not.toContain('(undefined)')

    const compact = await renderUserTeammateMessage(
      teammateMessage({
        teammateId: 'worker',
        content: 'hidden outside transcript mode',
      }),
      { isTranscriptMode: false },
    )

    expect(compact).toContain('@worker')
    expect(compact).not.toContain('hidden outside transcript mode')
  })
})
