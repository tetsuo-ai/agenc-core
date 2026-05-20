import React from 'react'
import { describe, expect, test, vi } from 'vitest'

const featureFlags = vi.hoisted(() => new Set<string>())

vi.mock('bun:bundle', () => ({
  feature: (name: string) => featureFlags.has(name),
}))

vi.mock('../../hooks/useSettings.js', () => ({
  useSettings: () => ({
    syntaxHighlightingDisabled: true,
  }),
}))

import type { Tool, Tools } from '../../../tools/Tool.js'
import type {
  AgenCToolResultBlockParam,
  ProgressMessage,
} from '../../../types/message.js'
import { renderToString } from '../../../utils/staticRender.js'
import {
  INTERRUPT_MESSAGE_FOR_TOOL_USE,
  PLAN_REJECTION_PREFIX,
  REJECT_MESSAGE_WITH_REASON_PREFIX,
} from '../../../utils/messages.js'
import { Text } from '../../ink.js'
import { UserToolErrorMessage } from './UserToolErrorMessage.js'

function toolResult(content: AgenCToolResultBlockParam['content']): AgenCToolResultBlockParam {
  return {
    type: 'tool_result',
    tool_use_id: 'toolu_error',
    is_error: true,
    content,
  }
}

describe('UserToolErrorMessage wave200-049 coverage', () => {
  test('routes denial, interruption, rejection, classifier, delegated, and fallback errors', async () => {
    featureFlags.clear()
    featureFlags.add('TRANSCRIPT_CLASSIFIER')

    const toolProgress = {
      uuid: 'progress-tool',
      data: { type: 'tool_progress', text: 'kept progress' },
    }
    const hookProgress = {
      uuid: 'progress-hook',
      data: { type: 'hook_progress', hookEvent: 'PreToolUse' },
    }
    const progressMessages = [
      hookProgress,
      toolProgress,
    ] as ProgressMessage[]
    let receivedOptions:
      | {
          readonly progressMessagesForMessage: ProgressMessage[]
          readonly tools: Tools
          readonly verbose: boolean
          readonly isTranscriptMode?: boolean
        }
      | undefined
    const delegatedTool = {
      name: 'Delegate',
      renderToolUseErrorMessage: vi.fn((content: unknown, options) => {
        receivedOptions = options
        return <Text>delegated {String(content)} transcript</Text>
      }),
    } as unknown as Tool
    const tools = [delegatedTool] as Tools

    const output = await renderToString(
      <>
        <UserToolErrorMessage
          progressMessagesForMessage={[]}
          tool={delegatedTool}
          tools={tools}
          param={toolResult({ error: 'rejected by user' } as never)}
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
          param={toolResult(
            `${PLAN_REJECTION_PREFIX}Keep this plan visible.`,
          )}
          verbose={false}
        />
        <UserToolErrorMessage
          progressMessagesForMessage={[]}
          tools={[]}
          param={toolResult(
            `${REJECT_MESSAGE_WITH_REASON_PREFIX}Use a safer path.`,
          )}
          verbose={false}
        />
        <UserToolErrorMessage
          progressMessagesForMessage={[]}
          tools={[]}
          param={toolResult(
            'Permission for this action has been denied. Reason: command looked destructive',
          )}
          verbose={false}
        />
        <UserToolErrorMessage
          progressMessagesForMessage={progressMessages}
          tool={delegatedTool}
          tools={tools}
          param={toolResult('custom failure')}
          verbose={true}
          isTranscriptMode={true}
        />
        <UserToolErrorMessage
          progressMessagesForMessage={[]}
          tools={[]}
          param={toolResult(
            '<tool_use_error><error>InputValidationError: missing path</error></tool_use_error>',
          )}
          verbose={false}
        />
      </>,
      { columns: 120, rows: 24 },
    )

    expect(output).toContain('Permission request denied by user.')
    expect(output).toContain('Interrupted')
    expect(output).toContain('What should AgenC do instead?')
    expect(output).toContain("User rejected AgenC's plan:")
    expect(output).toContain('Keep this plan visible.')
    expect(output).toContain('Tool use rejected')
    expect(output).toContain('Denied by auto mode classifier')
    expect(output).toContain('/feedback if incorrect')
    expect(output).toContain('delegated custom failure transcript')
    expect(output).toContain('Invalid tool parameters')
    expect(output).not.toContain('InputValidationError')
    expect(delegatedTool.renderToolUseErrorMessage).toHaveBeenCalledTimes(1)
    expect(receivedOptions).toMatchObject({
      tools,
      verbose: true,
      isTranscriptMode: true,
    })
    expect(receivedOptions?.progressMessagesForMessage).toEqual([toolProgress])
  })
})
