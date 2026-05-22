import React from 'react'
import { describe, expect, test } from 'vitest'

import type { AdvisorBlock } from '../../utils/advisor.js'
import { renderToString } from '../../utils/staticRender.js'
import { AdvisorMessage } from '../message-renderers/AdvisorMessage.js'

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function renderAdvisorMessage(
  block: AdvisorBlock,
  options: {
    readonly addMargin?: boolean
    readonly advisorModel?: string
    readonly erroredToolUseIDs?: readonly string[]
    readonly resolvedToolUseIDs?: readonly string[]
    readonly shouldAnimate?: boolean
    readonly verbose?: boolean
  } = {},
): Promise<string> {
  return renderToString(
    <AdvisorMessage
      addMargin={options.addMargin ?? false}
      advisorModel={options.advisorModel}
      block={block}
      erroredToolUseIDs={new Set(options.erroredToolUseIDs ?? [])}
      resolvedToolUseIDs={new Set(options.resolvedToolUseIDs ?? [])}
      shouldAnimate={options.shouldAnimate ?? false}
      verbose={options.verbose ?? false}
    />,
    120,
  )
}

describe('AdvisorMessage coverage swarm row 056', () => {
  test('renders unresolved advisor progress without optional model or input text', async () => {
    const output = normalize(
      await renderAdvisorMessage(
        {
          type: 'server_tool_use',
          id: 'advisor-empty-input',
          name: 'advisor',
          input: {},
        },
        {
          addMargin: true,
          shouldAnimate: true,
        },
      ),
    )

    expect(output).toContain('Advising')
    expect(output).toContain('◐')
    expect(output).not.toContain('using')
    expect(output).not.toContain('{}')
  })

  test('renders completed and failed advisor progress with model and serialized input', async () => {
    const completed = normalize(
      await renderAdvisorMessage(
        {
          type: 'server_tool_use',
          id: 'advisor-complete',
          name: 'advisor',
          input: { files: ['src/tui/message-renderers/AdvisorMessage.tsx'] },
        },
        {
          advisorModel: 'advisor-model',
          resolvedToolUseIDs: ['advisor-complete'],
        },
      ),
    )

    expect(completed).toContain('●')
    expect(completed).toContain('Advising using advisor-model')
    expect(completed).toContain(
      '{"files":["src/tui/message-renderers/AdvisorMessage.tsx"]}',
    )

    const failed = normalize(
      await renderAdvisorMessage(
        {
          type: 'server_tool_use',
          id: 'advisor-failed',
          name: 'advisor',
          input: { reason: 'rate-limit' },
        },
        {
          erroredToolUseIDs: ['advisor-failed'],
          resolvedToolUseIDs: ['advisor-failed'],
        },
      ),
    )

    expect(failed).toContain('✕')
    expect(failed).toContain('{"reason":"rate-limit"}')
  })

  test('renders compact, verbose, redacted, and error advisor results', async () => {
    const compact = normalize(
      await renderAdvisorMessage({
        type: 'advisor_tool_result',
        tool_use_id: 'advisor-complete',
        content: {
          type: 'advisor_result',
          text: 'Apply the review feedback.',
        },
      }),
    )

    expect(compact).toContain(
      'Advisor has reviewed the conversation and will apply the feedback',
    )
    expect(compact).toContain('ctrl+o')
    expect(compact).not.toContain('Apply the review feedback.')

    const verbose = normalize(
      await renderAdvisorMessage(
        {
          type: 'advisor_tool_result',
          tool_use_id: 'advisor-complete',
          content: {
            type: 'advisor_result',
            text: 'Apply the review feedback.',
          },
        },
        { verbose: true },
      ),
    )

    expect(verbose).toContain('Apply the review feedback.')
    expect(verbose).not.toContain('ctrl+o')

    const redacted = normalize(
      await renderAdvisorMessage({
        type: 'advisor_tool_result',
        tool_use_id: 'advisor-redacted',
        content: {
          type: 'advisor_redacted_result',
          encrypted_content: 'hidden-feedback',
        },
      }),
    )

    expect(redacted).toContain(
      'Advisor has reviewed the conversation and will apply the feedback',
    )
    expect(redacted).not.toContain('hidden-feedback')

    const unavailable = normalize(
      await renderAdvisorMessage({
        type: 'advisor_tool_result',
        tool_use_id: 'advisor-error',
        content: {
          type: 'advisor_tool_result_error',
          error_code: 'temporarily_unavailable',
        },
      }),
    )

    expect(unavailable).toContain(
      'Advisor unavailable (temporarily_unavailable)',
    )
  })
})
