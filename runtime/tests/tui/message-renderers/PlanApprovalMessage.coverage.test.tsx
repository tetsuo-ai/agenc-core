import React from 'react'
import { describe, expect, test, vi } from 'vitest'

import { renderToString } from '../../utils/staticRender.js'
import { tryRenderPlanApprovalMessage } from './PlanApprovalMessage.js'

vi.mock('bun:bundle', () => ({
  feature: () => false,
}))

vi.mock('../hooks/useSettings.js', () => ({
  useSettings: () => ({
    syntaxHighlightingDisabled: true,
  }),
}))

function renderPlanApprovalMessage(content: string): Promise<string> {
  const node = tryRenderPlanApprovalMessage(content, 'lead')
  if (!React.isValidElement(node)) {
    throw new Error('expected structured plan approval content to render')
  }
  return renderToString(node, { columns: 100, rows: 24 })
}

describe('PlanApprovalMessage coverage', () => {
  test('renders request, approval, and rejection states from structured teammate payloads', async () => {
    const previousGlyphMode = process.env.AGENC_TUI_GLYPHS
    process.env.AGENC_TUI_GLYPHS = 'ascii'

    try {
      const requestOutput = await renderPlanApprovalMessage(
        JSON.stringify({
          type: 'plan_approval_request',
          from: 'planner',
          timestamp: '2026-05-20T00:00:00.000Z',
          planFilePath: '/tmp/plan.md',
          planContent: '# Implementation Plan\n\n- Add focused TUI coverage',
          requestId: 'req-1',
        }),
      )

      expect(requestOutput).toContain('Plan Approval Request from planner')
      expect(requestOutput).toContain('Implementation Plan')
      expect(requestOutput).toContain('Add focused TUI coverage')
      expect(requestOutput).toContain('Plan file: /tmp/plan.md')

      const approvedOutput = await renderPlanApprovalMessage(
        JSON.stringify({
          type: 'plan_approval_response',
          requestId: 'req-1',
          approved: true,
          timestamp: '2026-05-20T00:00:01.000Z',
        }),
      )

      expect(approvedOutput).toContain('OK Plan Approved by lead')
      expect(approvedOutput).toContain(
        'You can now proceed with implementation. Your plan mode restrictions have been lifted.',
      )

      const rejectedOutput = await renderPlanApprovalMessage(
        JSON.stringify({
          type: 'plan_approval_response',
          requestId: 'req-1',
          approved: false,
          feedback: 'Add rollback coverage before proceeding.',
          timestamp: '2026-05-20T00:00:02.000Z',
        }),
      )

      expect(rejectedOutput).toContain('ERR Plan Rejected by lead')
      expect(rejectedOutput).toContain(
        'Feedback: Add rollback coverage before proceeding.',
      )
      expect(rejectedOutput).toContain(
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
})
