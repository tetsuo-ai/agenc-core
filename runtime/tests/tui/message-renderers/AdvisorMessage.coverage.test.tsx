import React from 'react'
import { describe, expect, test } from 'vitest'

import type { AdvisorBlock } from '../../utils/advisor.js'
import { renderToString } from '../../utils/staticRender.js'
import { AdvisorMessage } from './AdvisorMessage.js'

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function renderAdvisorMessage(
  block: AdvisorBlock,
  options: {
    readonly advisorModel?: string
    readonly erroredToolUseIDs?: readonly string[]
    readonly resolvedToolUseIDs?: readonly string[]
    readonly verbose?: boolean
  } = {},
): Promise<string> {
  return renderToString(
    <AdvisorMessage
      addMargin={false}
      advisorModel={options.advisorModel}
      block={block}
      erroredToolUseIDs={new Set(options.erroredToolUseIDs ?? [])}
      resolvedToolUseIDs={new Set(options.resolvedToolUseIDs ?? [])}
      shouldAnimate={false}
      verbose={options.verbose ?? false}
    />,
    120,
  )
}

describe('AdvisorMessage coverage', () => {
  test('renders advisor progress and each result outcome', async () => {
    const progress = normalize(
      await renderAdvisorMessage(
        {
          type: 'server_tool_use',
          id: 'advisor-tool-1',
          name: 'advisor',
          input: { scope: 'rendering' },
        },
        {
          advisorModel: 'advisor-model',
          erroredToolUseIDs: ['advisor-tool-1'],
          resolvedToolUseIDs: ['advisor-tool-1'],
        },
      ),
    )
    expect(progress).toContain('Advising using advisor-model')
    expect(progress).toContain('{"scope":"rendering"}')

    const compactResult = normalize(
      await renderAdvisorMessage({
        type: 'advisor_tool_result',
        tool_use_id: 'advisor-tool-1',
        content: {
          type: 'advisor_result',
          text: 'Tighten the assertions around the status line.',
        },
      }),
    )
    expect(compactResult).toContain(
      'Advisor has reviewed the conversation and will apply the feedback',
    )
    expect(compactResult).toContain('ctrl+o')
    expect(compactResult).not.toContain('Tighten the assertions')

    const verboseResult = normalize(
      await renderAdvisorMessage(
        {
          type: 'advisor_tool_result',
          tool_use_id: 'advisor-tool-1',
          content: {
            type: 'advisor_result',
            text: 'Tighten the assertions around the status line.',
          },
        },
        { verbose: true },
      ),
    )
    expect(verboseResult).toContain(
      'Tighten the assertions around the status line.',
    )

    const redactedResult = normalize(
      await renderAdvisorMessage({
        type: 'advisor_tool_result',
        tool_use_id: 'advisor-tool-1',
        content: {
          type: 'advisor_redacted_result',
          encrypted_content: 'encrypted-feedback',
        },
      }),
    )
    expect(redactedResult).toContain(
      'Advisor has reviewed the conversation and will apply the feedback',
    )
    expect(redactedResult).not.toContain('encrypted-feedback')

    const errorResult = normalize(
      await renderAdvisorMessage({
        type: 'advisor_tool_result',
        tool_use_id: 'advisor-tool-1',
        content: {
          type: 'advisor_tool_result_error',
          error_code: 'rate_limited',
        },
      }),
    )
    expect(errorResult).toContain('Advisor unavailable (rate_limited)')
  })
})
