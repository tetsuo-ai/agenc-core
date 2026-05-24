import React from 'react'
import { describe, expect, test, vi } from 'vitest'

vi.mock('bun:bundle', () => ({
  feature: () => false,
}))

import type { Tool, Tools } from '../../../src/tools/Tool.js'
import { renderToString } from '../../../src/utils/staticRender.js'
import {
  CANCEL_MESSAGE,
  INTERRUPT_MESSAGE_FOR_TOOL_USE,
  REJECT_MESSAGE,
} from '../../../src/utils/messages.js'
import { Text } from '../../../src/tui/ink.js'
import {
  formatOrphanToolResultContent,
  UserToolResultMessage,
} from '../../../src/tui/message-renderers/UserToolResultMessage/UserToolResultMessage.js'

function createMessage(toolUseID: string) {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseID,
          content: 'persisted result',
        },
      ],
    },
    toolUseResult: { summary: 'persisted summary' },
  } as never
}

function createLookups(toolUse?: {
  readonly id: string
  readonly name: string
  readonly input: Record<string, unknown>
}) {
  return {
    inProgressHookCounts: new Map(),
    resolvedHookCounts: new Map(),
    toolUseByToolUseID: new Map(
      toolUse === undefined ? [] : [[toolUse.id, toolUse]],
    ),
  } as never
}

describe('UserToolResultMessage swarm-083 coverage', () => {
  test('formats orphan tool result content from denials, arrays, nullish, and scalar values', () => {
    expect(formatOrphanToolResultContent({ error: 'rejected by user' })).toBe(
      'Permission request denied by user.',
    )
    expect(formatOrphanToolResultContent('plain recovered output')).toBe(
      'plain recovered output',
    )
    expect(
      formatOrphanToolResultContent([
        'first line',
        { type: 'text', text: 'second line' },
        { type: 'image', source: { media_type: 'image/png', data: 'abc' } },
        { text: 123 },
      ]),
    ).toBe(
      'first line\nsecond line\n{"type":"image","source":{"media_type":"image/png","data":"abc"}}\n{"text":123}',
    )
    expect(formatOrphanToolResultContent(null)).toBe('')
    expect(formatOrphanToolResultContent(42 as never)).toBe('42')
  })

  test('renders recovered orphan results without a matching tool call', async () => {
    const output = await renderToString(
      <UserToolResultMessage
        param={{
          type: 'tool_result',
          tool_use_id: 'toolu_swarm_083_orphan',
          content: [
            { type: 'text', text: 'restored text' },
            { type: 'json', value: 7 },
          ],
        }}
        message={createMessage('toolu_swarm_083_orphan')}
        lookups={createLookups()}
        progressMessagesForMessage={[]}
        tools={[]}
        verbose={false}
        width={60}
      />,
      { columns: 100, rows: 10 },
    )

    expect(output).toContain('Tool result recovered without matching tool call:')
    expect(output).toContain('restored text')
    expect(output).toContain('{"type":"json","value":7}')
  })

  test('routes orphan error results through the fallback error renderer', async () => {
    const output = await renderToString(
      <UserToolResultMessage
        param={{
          type: 'tool_result',
          tool_use_id: 'toolu_swarm_083_orphan_error',
          content: 'orphan failure',
          is_error: true,
        }}
        message={createMessage('toolu_swarm_083_orphan_error')}
        lookups={createLookups()}
        progressMessagesForMessage={[]}
        tools={[]}
        verbose={true}
        width={60}
      />,
      { columns: 100, rows: 10 },
    )

    expect(output).toContain('Error: orphan failure')
  })

  test('routes matched rejected tool results by reject-message prefix', async () => {
    const toolUse = {
      id: 'toolu_swarm_083_reject',
      name: 'SwarmRejectTool',
      input: { path: 'runtime/src/rejected.ts' },
    }
    const renderToolUseRejectedMessage = vi.fn(
      (
        input: { path: string },
        options: {
          readonly progressMessagesForMessage: ReadonlyArray<unknown>
          readonly style?: string
          readonly verbose?: boolean
          readonly isTranscriptMode?: boolean
        },
      ) => (
        <Text>
          rejected {input.path} progress:
          {options.progressMessagesForMessage.length} style:{options.style}{' '}
          verbose:{String(options.verbose)} transcript:
          {String(options.isTranscriptMode)}
        </Text>
      ),
    )
    const tool = {
      name: 'SwarmRejectTool',
      inputSchema: {
        safeParse: (input: unknown) => ({ success: true, data: input }),
      },
      renderToolUseRejectedMessage,
    } as unknown as Tool
    const tools = [tool] as Tools

    const output = await renderToString(
      <UserToolResultMessage
        param={{
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: `${REJECT_MESSAGE} extra context`,
        }}
        message={createMessage(toolUse.id)}
        lookups={createLookups(toolUse)}
        progressMessagesForMessage={[
          { data: { type: 'hook_progress', hookEvent: 'PreToolUse' } },
          { data: { type: 'tool_progress', text: 'visible progress' } },
        ] as never}
        style="condensed"
        tools={tools}
        verbose={true}
        width={72}
        isTranscriptMode={true}
      />,
      { columns: 120, rows: 10 },
    )

    expect(output).toContain(
      'rejected runtime/src/rejected.ts progress:1 style:condensed verbose:true transcript:true',
    )
    expect(renderToolUseRejectedMessage).toHaveBeenCalledTimes(1)
  })

  test('routes matched text-block control tool results before success and error fallbacks', async () => {
    const toolUse = {
      id: 'toolu_swarm_083_array_controls',
      name: 'SwarmArrayControlTool',
      input: { path: 'runtime/src/array-control.ts' },
    }
    const renderToolUseRejectedMessage = vi.fn(
      (input: { path: string }) => <Text>array rejected {input.path}</Text>,
    )
    const renderToolUseErrorMessage = vi.fn(() => <Text>array error</Text>)
    const renderToolResultMessage = vi.fn(() => <Text>array success</Text>)
    const tool = {
      name: 'SwarmArrayControlTool',
      inputSchema: {
        safeParse: (input: unknown) => ({ success: true, data: input }),
      },
      outputSchema: {
        safeParse: (output: unknown) => ({ success: true, data: output }),
      },
      userFacingName: () => 'SwarmArrayControlTool',
      renderToolUseRejectedMessage,
      renderToolUseErrorMessage,
      renderToolResultMessage,
    } as unknown as Tool
    const tools = [tool] as Tools

    const render = (
      content:
        | undefined
        | Array<
            | string
            | {
                readonly type: string
                readonly text?: string
                readonly value?: number
              }
          >,
      isError = false,
    ) =>
      renderToString(
        <UserToolResultMessage
          param={{
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content,
            is_error: isError,
          }}
          message={createMessage(toolUse.id)}
          lookups={createLookups(toolUse)}
          progressMessagesForMessage={[]}
          tools={tools}
          verbose={false}
          width={72}
        />,
        { columns: 120, rows: 10 },
      )

    await expect(render([`${CANCEL_MESSAGE} Later.`])).resolves.toContain(
      'Interrupted by user',
    )
    await expect(
      render([
        { type: 'text', text: `${REJECT_MESSAGE} extra context` },
        { type: 'json', value: 1 },
      ]),
    ).resolves.toContain('array rejected runtime/src/array-control.ts')
    await expect(
      render([{ type: 'text', text: INTERRUPT_MESSAGE_FOR_TOOL_USE }]),
    ).resolves.toContain('array rejected runtime/src/array-control.ts')
    await expect(render(undefined)).resolves.toContain('array success')
    await expect(render([{ type: 'json', value: 2 }], true)).resolves.toContain(
      'array error',
    )

    expect(renderToolUseRejectedMessage).toHaveBeenCalledTimes(2)
    expect(renderToolUseErrorMessage).toHaveBeenCalledTimes(1)
    expect(renderToolResultMessage).toHaveBeenCalledTimes(1)
  })
})
