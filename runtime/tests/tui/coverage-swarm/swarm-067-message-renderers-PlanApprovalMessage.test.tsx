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

import { renderToString } from '../../../src/utils/staticRender.js'
import {
  formatTeammateMessageContent,
  getPlanApprovalResponseTitle,
  tryRenderPlanApprovalMessage,
} from '../../../src/tui/message-renderers/PlanApprovalMessage.js'

function payload(value: Record<string, unknown>): string {
  return JSON.stringify(value)
}

function planResponse(approved: boolean, feedback?: string): string {
  return payload({
    type: 'plan_approval_response',
    requestId: 'row-067',
    approved,
    feedback,
    timestamp: '2026-05-20T00:00:01.000Z',
  })
}

async function renderPlanMessage(content: string): Promise<string> {
  const node = tryRenderPlanApprovalMessage(content, 'lead')
  if (!React.isValidElement(node)) {
    throw new Error('expected a rendered plan approval message')
  }
  return renderToString(<>{node}</>, { columns: 100, rows: 24 })
}

describe('PlanApprovalMessage coverage swarm 067', () => {
  test('renders request and response payload states with ascii status titles', async () => {
    const previousGlyphMode = process.env.AGENC_TUI_GLYPHS
    process.env.AGENC_TUI_GLYPHS = 'ascii'

    try {
      expect(getPlanApprovalResponseTitle(true, 'lead')).toBe(
        'OK Plan Approved by lead',
      )
      expect(getPlanApprovalResponseTitle(false, 'lead')).toBe(
        'ERR Plan Rejected by lead',
      )

      const requestOutput = await renderPlanMessage(
        payload({
          type: 'plan_approval_request',
          from: 'planner',
          timestamp: '2026-05-20T00:00:00.000Z',
          planFilePath: '/tmp/row-067-plan.md',
          planContent: '# Row 067 plan\n\n- Cover renderer branches',
          requestId: 'row-067',
        }),
      )

      expect(requestOutput).toContain('Plan Approval Request from planner')
      expect(requestOutput).toContain('Row 067 plan')
      expect(requestOutput).toContain('Cover renderer branches')
      expect(requestOutput).toContain('Plan file: /tmp/row-067-plan.md')

      const approvedOutput = await renderPlanMessage(planResponse(true))
      expect(approvedOutput).toContain('OK Plan Approved by lead')
      expect(approvedOutput).toContain(
        'You can now proceed with implementation. Your plan mode restrictions have been lifted.',
      )

      const rejectedOutput = await renderPlanMessage(
        planResponse(false, 'Add rollback coverage.'),
      )
      expect(rejectedOutput).toContain('ERR Plan Rejected by lead')
      expect(rejectedOutput).toContain('Feedback: Add rollback coverage.')
      expect(rejectedOutput).toContain(
        'Please revise your plan based on the feedback and call ExitPlanMode again.',
      )

      const rejectedWithoutFeedbackOutput = await renderPlanMessage(
        planResponse(false),
      )
      expect(rejectedWithoutFeedbackOutput).toContain(
        'ERR Plan Rejected by lead',
      )
      expect(rejectedWithoutFeedbackOutput).not.toContain('Feedback:')
      expect(rejectedWithoutFeedbackOutput).toContain(
        'Please revise your plan based on the feedback and call ExitPlanMode again.',
      )
    } finally {
      if (previousGlyphMode === undefined) {
        delete process.env.AGENC_TUI_GLYPHS
      } else {
        process.env.AGENC_TUI_GLYPHS = previousGlyphMode
      }
    }
  })

  test('returns null for malformed plan payloads and summarizes plan fallback text', () => {
    expect(
      tryRenderPlanApprovalMessage(
        payload({
          type: 'plan_approval_request',
          from: 'planner',
          timestamp: '2026-05-20T00:00:00.000Z',
          requestId: 'missing-required-fields',
        }),
        'lead',
      ),
    ).toBeNull()

    expect(formatTeammateMessageContent(planResponse(false))).toBe(
      '[Plan Rejected] Please revise your plan',
    )
  })

  test('summarizes teammate lifecycle messages before falling back to raw content', () => {
    expect(
      formatTeammateMessageContent(
        payload({
          type: 'idle_notification',
          from: 'worker',
          timestamp: '2026-05-20T00:00:00.000Z',
        }),
      ),
    ).toBe('Agent idle')

    expect(
      formatTeammateMessageContent(
        payload({
          type: 'idle_notification',
          from: 'worker',
          timestamp: '2026-05-20T00:00:00.000Z',
          completedTaskId: '067',
        }),
      ),
    ).toBe('Agent idle · Task 067 completed')

    expect(
      formatTeammateMessageContent(
        payload({
          type: 'idle_notification',
          from: 'worker',
          timestamp: '2026-05-20T00:00:00.000Z',
          completedTaskId: '067',
          completedStatus: 'blocked',
          summary: 'waiting for approval',
        }),
      ),
    ).toBe('Agent idle · Task 067 blocked · Last DM: waiting for approval')

    expect(
      formatTeammateMessageContent(
        payload({
          type: 'shutdown_request',
          requestId: 'shutdown-1',
          from: 'lead',
          timestamp: '2026-05-20T00:00:00.000Z',
        }),
      ),
    ).toBe('[Shutdown Request from lead]')

    expect(
      formatTeammateMessageContent(
        payload({
          type: 'shutdown_request',
          requestId: 'shutdown-2',
          from: 'lead',
          reason: 'handoff complete',
          timestamp: '2026-05-20T00:00:00.000Z',
        }),
      ),
    ).toBe('[Shutdown Request from lead] handoff complete')

    expect(
      formatTeammateMessageContent(
        payload({
          type: 'shutdown_approved',
          requestId: 'shutdown-3',
          from: 'worker',
          timestamp: '2026-05-20T00:00:00.000Z',
        }),
      ),
    ).toBe('[Shutdown Approved] worker is now exiting')

    expect(
      formatTeammateMessageContent(
        payload({
          type: 'shutdown_rejected',
          requestId: 'shutdown-4',
          from: 'worker',
          reason: 'tests still running',
          timestamp: '2026-05-20T00:00:00.000Z',
        }),
      ),
    ).toBe('[Shutdown Rejected] worker: tests still running')

    expect(
      formatTeammateMessageContent(
        payload({
          type: 'task_assignment',
          taskId: '067',
          subject: 'Cover PlanApprovalMessage',
          description: 'Add focused branch coverage.',
          assignedBy: 'lead',
          timestamp: '2026-05-20T00:00:00.000Z',
        }),
      ),
    ).toBe('[Task Assigned] #067 - Cover PlanApprovalMessage')

    expect(
      formatTeammateMessageContent(
        payload({
          type: 'teammate_terminated',
          message: 'worker stopped',
        }),
      ),
    ).toBe('worker stopped')

    const terminatedWithoutMessage = payload({ type: 'teammate_terminated' })
    const unrelatedStructured = payload({
      type: 'unrelated',
      message: 'leave this alone',
    })

    expect(formatTeammateMessageContent(terminatedWithoutMessage)).toBe(
      terminatedWithoutMessage,
    )
    expect(formatTeammateMessageContent(unrelatedStructured)).toBe(
      unrelatedStructured,
    )
    expect(formatTeammateMessageContent('{not json')).toBe('{not json')
  })
})
