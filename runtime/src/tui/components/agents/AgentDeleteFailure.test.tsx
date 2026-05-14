import React from 'react'
import stripAnsi from 'strip-ansi'
import { describe, expect, test } from 'vitest'

import { renderToString } from '../../../utils/staticRender.js'
import {
  AgentDeleteFailureMessage,
  formatAgentDeleteFailureMessage,
} from './AgentDeleteFailure.js'

describe('agent delete failure display', () => {
  test('normalizes unknown delete failures into visible user text', () => {
    expect(
      formatAgentDeleteFailureMessage(
        { agentType: 'reviewer' },
        new Error('permission denied'),
      ),
    ).toBe('Failed to delete agent reviewer: permission denied')

    expect(formatAgentDeleteFailureMessage({ agentType: 'reviewer' }, 'locked')).toBe(
      'Failed to delete agent reviewer: locked',
    )
  })

  test('renders the failure message inside the dialog width', async () => {
    const output = stripAnsi(
      await renderToString(
        <AgentDeleteFailureMessage message="Failed to delete agent reviewer: permission denied" />,
        48,
      ),
    )

    const normalized = output.replace(/\s+/g, ' ')

    expect(normalized).toContain('Failed to delete agent reviewer')
    expect(normalized).toContain('permission denied')
  })
})
