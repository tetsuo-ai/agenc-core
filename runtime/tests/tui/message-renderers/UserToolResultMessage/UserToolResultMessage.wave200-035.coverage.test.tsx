import React from 'react'
import { describe, expect, test, vi } from 'vitest'

import type { Tool } from '../../../tools/Tool.js'
import {
  CANCEL_MESSAGE,
  INTERRUPT_MESSAGE_FOR_TOOL_USE,
} from '../../../utils/messages.js'
import { renderToString } from '../../../utils/staticRender.js'
import { Text } from '../../ink.js'
import { UserToolResultMessage } from './UserToolResultMessage.js'

describe('UserToolResultMessage wave200-035 coverage', () => {
  test('routes matched tool results through cancellation, rejection, error, and success renderers', async () => {
    const toolUse = {
      type: 'tool_use',
      id: 'toolu_wave200_035',
      name: 'WaveCoverageTool',
      input: { path: 'runtime/src/example.ts' },
    }
    const lookups = {
      toolUseByToolUseID: new Map([[toolUse.id, toolUse]]),
      inProgressHookCounts: new Map(),
      resolvedHookCounts: new Map(),
    }
    const progressMessagesForMessage = [
      { data: { type: 'hook_progress', hookEvent: 'PreToolUse' } },
      { data: { type: 'tool_progress', text: 'working' } },
    ]
    const message = {
      type: 'user',
      toolUseResult: { value: 'saved' },
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: 'persisted fallback',
          },
        ],
      },
    }
    const tool = {
      name: 'WaveCoverageTool',
      inputSchema: {
        safeParse: (input: unknown) => ({ success: true, data: input }),
      },
      outputSchema: {
        safeParse: (output: unknown) => ({ success: true, data: output }),
      },
      userFacingName: () => 'WaveCoverageTool',
      renderToolUseRejectedMessage: vi.fn((input, options) => (
        <Text>
          rejected {input.path} {options.progressMessagesForMessage.length}{' '}
          {String(options.isTranscriptMode)}
        </Text>
      )),
      renderToolUseErrorMessage: vi.fn((content, options) => (
        <Text>
          errored {String(content)} {options.progressMessagesForMessage.length}{' '}
          {String(options.isTranscriptMode)}
        </Text>
      )),
      renderToolResultMessage: vi.fn((result, progress, options) => (
        <Text>
          succeeded {result.value} {progress.length} {options.input.path}{' '}
          {String(options.isTranscriptMode)}
        </Text>
      )),
    } as unknown as Tool

    const render = (content: string, isError = false) =>
      renderToString(
        <UserToolResultMessage
          param={{
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content,
            is_error: isError,
          }}
          message={message}
          lookups={lookups as never}
          progressMessagesForMessage={progressMessagesForMessage as never}
          tools={[tool]}
          verbose={true}
          width={70}
          isTranscriptMode={true}
        />,
        { columns: 90, rows: 24 },
      )

    await expect(render(`${CANCEL_MESSAGE} Later.`)).resolves.toContain(
      'Interrupted by user',
    )
    await expect(render(INTERRUPT_MESSAGE_FOR_TOOL_USE)).resolves.toContain(
      'rejected runtime/src/example.ts 1 true',
    )
    await expect(render('tool failed', true)).resolves.toContain(
      'errored tool failed 1 true',
    )
    await expect(render('tool succeeded')).resolves.toContain(
      'succeeded saved 1 runtime/src/example.ts true',
    )

    expect(tool.renderToolUseRejectedMessage).toHaveBeenCalledTimes(1)
    expect(tool.renderToolUseErrorMessage).toHaveBeenCalledTimes(1)
    expect(tool.renderToolResultMessage).toHaveBeenCalledTimes(1)
  })
})
