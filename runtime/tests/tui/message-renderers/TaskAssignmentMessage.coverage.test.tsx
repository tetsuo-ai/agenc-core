import React from 'react'
import { describe, expect, test } from 'vitest'

import { renderToString } from '../../utils/staticRender.js'
import {
  getTaskAssignmentSummary,
  tryRenderTaskAssignmentMessage,
} from './TaskAssignmentMessage.js'

describe('TaskAssignmentMessage coverage', () => {
  test('renders parsed task assignment details and ignores non-assignment content', async () => {
    const content = JSON.stringify({
      type: 'task_assignment',
      taskId: '42',
      subject: 'Inspect renderer branch coverage',
      description: 'Confirm the assignment card includes the body text.',
      assignedBy: 'lead',
      timestamp: '2026-05-20T12:00:00.000Z',
    })

    const output = await renderToString(
      <>{tryRenderTaskAssignmentMessage(content)}</>,
      { columns: 100 },
    )

    expect(output).toContain('Task #42 assigned by lead')
    expect(output).toContain('Inspect renderer branch coverage')
    expect(output).toContain('Confirm the assignment card includes the body text.')
    expect(getTaskAssignmentSummary(content)).toBe(
      '[Task Assigned] #42 - Inspect renderer branch coverage',
    )

    const nonAssignment = JSON.stringify({ type: 'teammate_message' })
    expect(tryRenderTaskAssignmentMessage(nonAssignment)).toBeNull()
    expect(getTaskAssignmentSummary(nonAssignment)).toBeNull()
  })
})
