import React from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'

const featureFlags = vi.hoisted(() => new Set<string>())

vi.mock('bun:bundle', () => ({
  feature: (name: string) => featureFlags.has(name),
}))

vi.mock('../../../src/tui/hooks/useSettings.js', () => ({
  useSettings: () => ({
    syntaxHighlightingDisabled: true,
  }),
}))

import type { Tool, Tools } from '../../../src/tools/Tool.js'
import type {
  AgenCToolResultBlockParam,
  ProgressMessage,
} from '../../../src/types/message.js'
import { Text } from '../../../src/tui/ink.js'
import { UserToolErrorMessage } from '../../../src/tui/message-renderers/UserToolResultMessage/UserToolErrorMessage.js'
import { renderToString } from '../../../src/utils/staticRender.js'
import {
  INTERRUPT_MESSAGE_FOR_TOOL_USE,
  PLAN_REJECTION_PREFIX,
  REJECT_MESSAGE_WITH_REASON_PREFIX,
} from '../../../src/utils/messages.js'

afterEach(() => {
  featureFlags.clear()
})

function toolResult(
  content: AgenCToolResultBlockParam['content'],
): AgenCToolResultBlockParam {
  return {
    type: 'tool_result',
    tool_use_id: 'toolu_swarm_138',
    is_error: true,
    content,
  }
}

describe('UserToolErrorMessage swarm-138 coverage', () => {
  test('renders permission denial, interruption, plan rejection, and explicit rejection rows', async () => {
    const output = await renderToString(
      <>
        <UserToolErrorMessage
          progressMessagesForMessage={[]}
          tools={[]}
          param={toolResult(JSON.stringify({ error: 'rejected by user' }))}
          verbose={false}
        />
        <UserToolErrorMessage
          progressMessagesForMessage={[]}
          tools={[]}
          param={toolResult(`before ${INTERRUPT_MESSAGE_FOR_TOOL_USE}`)}
          verbose={false}
        />
        <UserToolErrorMessage
          progressMessagesForMessage={[]}
          tools={[]}
          param={toolResult(`${PLAN_REJECTION_PREFIX}Inspect before editing.`)}
          verbose={false}
        />
        <UserToolErrorMessage
          progressMessagesForMessage={[]}
          tools={[]}
          param={toolResult(
            `${REJECT_MESSAGE_WITH_REASON_PREFIX}Pick a narrower path.`,
          )}
          verbose={false}
        />
      </>,
      { columns: 120, rows: 18 },
    )

    expect(output).toContain('Permission request denied by user.')
    expect(output).toContain('Interrupted')
    expect(output).toContain('PLAN REJECTED')
    expect(output).toContain('Inspect before editing.')
    expect(output).toContain('Tool use rejected')
  })

  test('uses the compact classifier denial only when the transcript classifier feature is enabled', async () => {
    const deniedContent =
      'Permission for this action has been denied. Reason: command looked unsafe'

    const featureOffOutput = await renderToString(
      <UserToolErrorMessage
        progressMessagesForMessage={[]}
        tools={[]}
        param={toolResult(deniedContent)}
        verbose={false}
      />,
      { columns: 100, rows: 8 },
    )

    featureFlags.add('TRANSCRIPT_CLASSIFIER')

    const featureOnOutput = await renderToString(
      <UserToolErrorMessage
        progressMessagesForMessage={[]}
        tools={[]}
        param={toolResult(deniedContent)}
        verbose={false}
      />,
      { columns: 100, rows: 8 },
    )

    expect(featureOffOutput).toContain(`Error: ${deniedContent}`)
    expect(featureOffOutput).not.toContain('Denied by auto mode classifier')
    expect(featureOnOutput).toContain('Denied by auto mode classifier')
    expect(featureOnOutput).toContain('/feedback if incorrect')
    expect(featureOnOutput).not.toContain('command looked unsafe')
  })

  test('delegates tool errors with filtered progress and transcript options', async () => {
    const toolProgress = {
      uuid: 'tool-progress',
      data: { type: 'tool_progress', text: 'visible progress' },
    } as ProgressMessage
    const hookProgress = {
      uuid: 'hook-progress',
      data: { type: 'hook_progress', hookEvent: 'PreToolUse' },
    } as ProgressMessage
    let receivedOptions:
      | {
          readonly progressMessagesForMessage: ProgressMessage[]
          readonly tools: Tools
          readonly verbose: boolean
          readonly isTranscriptMode?: boolean
        }
      | undefined
    const delegatedTool = {
      name: 'SwarmErrorDelegate',
      renderToolUseErrorMessage: vi.fn((content: unknown, options) => {
        receivedOptions = options
        return (
          <Text>
            delegated {String(content)} progress:
            {options.progressMessagesForMessage.length} verbose:
            {String(options.verbose)} transcript:
            {String(options.isTranscriptMode)}
          </Text>
        )
      }),
    } as unknown as Tool
    const tools = [delegatedTool] as Tools

    const output = await renderToString(
      <UserToolErrorMessage
        progressMessagesForMessage={[hookProgress, toolProgress]}
        tool={delegatedTool}
        tools={tools}
        param={toolResult('custom failure')}
        verbose={true}
        isTranscriptMode={true}
      />,
      { columns: 120, rows: 8 },
    )

    expect(output).toContain(
      'delegated custom failure progress:1 verbose:true transcript:true',
    )
    expect(delegatedTool.renderToolUseErrorMessage).toHaveBeenCalledTimes(1)
    expect(receivedOptions).toMatchObject({
      tools,
      verbose: true,
      isTranscriptMode: true,
    })
    expect(receivedOptions?.progressMessagesForMessage).toEqual([toolProgress])
  })

  test('falls back when the delegated error renderer returns null', async () => {
    const nullRenderingTool = {
      name: 'SwarmNullErrorRenderer',
      renderToolUseErrorMessage: vi.fn(() => null),
    } as unknown as Tool

    const output = await renderToString(
      <UserToolErrorMessage
        progressMessagesForMessage={[]}
        tool={nullRenderingTool}
        tools={[nullRenderingTool] as Tools}
        param={toolResult(
          '<tool_use_error><error>InputValidationError: missing path</error></tool_use_error>',
        )}
        verbose={false}
      />,
      { columns: 100, rows: 8 },
    )

    expect(output).toContain('Invalid tool parameters')
    expect(output).not.toContain('InputValidationError')
    expect(nullRenderingTool.renderToolUseErrorMessage).toHaveBeenCalledTimes(1)
  })
})
