import React from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'

const featureFlags = vi.hoisted(() => new Set<string>())

vi.mock('bun:bundle', () => ({
  feature: (name: string) => featureFlags.has(name),
}))

import type { Tool, Tools } from '../../../src/tools/Tool.js'
import {
  clearClassifierApprovals,
  setYoloClassifierApproval,
} from '../../../src/utils/classifierApprovals.js'
import { renderToString } from '../../../src/utils/staticRender.js'
import { Text } from '../../../src/tui/ink.js'
import {
  getToolResultFallbackContent,
  UserToolSuccessMessage,
} from '../../../src/tui/message-renderers/UserToolResultMessage/UserToolSuccessMessage.js'

afterEach(() => {
  featureFlags.clear()
  clearClassifierApprovals()
})

function createLookups(toolUseID: string, input?: unknown) {
  return {
    inProgressHookCounts: new Map([
      [toolUseID, new Map([['PostToolUse', 1]])],
    ]),
    resolvedHookCounts: new Map(),
    toolUseByToolUseID: new Map(input === undefined ? [] : [[toolUseID, { input }]]),
  } as never
}

function messageWithToolResult(
  toolUseID: string,
  content: unknown,
  toolUseResult?: unknown,
) {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseID,
          content,
        },
      ],
    },
    toolUseResult,
  } as never
}

describe('UserToolSuccessMessage swarm-044 coverage', () => {
  test('formats fallback content from mixed recovered block shapes', () => {
    expect(getToolResultFallbackContent('not an array')).toBeNull()
    expect(getToolResultFallbackContent([{ type: 'text', text: 'ignored' }])).toBeNull()
    expect(getToolResultFallbackContent([{ type: 'tool_result' }])).toBeNull()
    expect(
      getToolResultFallbackContent([
        {
          type: 'tool_result',
          content: [
            'plain output',
            { type: 'text', text: 'text output' },
            { type: 'image', source: { type: 'base64', data: 'abc' } },
          ],
        },
      ]),
    ).toBe(
      'plain output\ntext output\n{"type":"image","source":{"type":"base64","data":"abc"}}',
    )
  })

  test('renders recovered fallback output for a missing tool result and transcript classifier approval', async () => {
    featureFlags.add('TRANSCRIPT_CLASSIFIER')
    const toolUseID = 'toolu_swarm_044_missing'
    setYoloClassifierApproval(toolUseID, 'allowed by rule')

    const output = await renderToString(
      <UserToolSuccessMessage
        message={messageWithToolResult(
          toolUseID,
          '<persisted-output>resumed fallback output</persisted-output>',
        )}
        lookups={createLookups(toolUseID)}
        toolUseID={toolUseID}
        progressMessagesForMessage={[]}
        tools={[]}
        verbose={false}
        width={60}
        isTranscriptMode={true}
      />,
      { columns: 90, rows: 12 },
    )

    expect(output).toContain('resumed fallback output')
    expect(output).toContain('Allowed by auto mode classifier')
    expect(output).toContain('1 PostToolUse hook running')
  })

  test('falls back instead of delegating when output schema validation fails', async () => {
    const toolUseID = 'toolu_swarm_044_invalid_schema'
    const renderToolResultMessage = vi.fn(() => <Text>delegated result</Text>)
    const tool = {
      outputSchema: {
        safeParse: () => ({ success: false, error: new Error('bad output') }),
      },
      renderToolResultMessage,
      userFacingName: () => 'Schema tool',
    } as unknown as Tool

    const output = await renderToString(
      <UserToolSuccessMessage
        message={messageWithToolResult(
          toolUseID,
          [{ type: 'text', text: 'schema fallback output' }],
          { unexpected: true },
        )}
        lookups={createLookups(toolUseID)}
        toolUseID={toolUseID}
        progressMessagesForMessage={[]}
        tool={tool}
        tools={[tool] as Tools}
        verbose={true}
        width={60}
      />,
      { columns: 90, rows: 12 },
    )

    expect(output).toContain('schema fallback output')
    expect(output).toContain('Running PostToolUse hook')
    expect(renderToolResultMessage).not.toHaveBeenCalled()
  })

  test('uses the raw result without a schema and allows assistant-text chrome opt out', async () => {
    const toolUseID = 'toolu_swarm_044_raw_result'
    const renderToolResultMessage = vi.fn(
      (
        result: { value: string },
        progressMessages: ReadonlyArray<{ data: { type: string } }>,
        options: { input?: { path: string }; isTranscriptMode?: boolean },
      ) => (
        <Text>
          {result.value} progress:{progressMessages.length} input:
          {options.input?.path} transcript:{String(options.isTranscriptMode)}
        </Text>
      ),
    )
    const tool = {
      renderToolResultMessage,
      userFacingName: vi.fn(() => ''),
    } as unknown as Tool
    const tools = [tool] as Tools

    const output = await renderToString(
      <UserToolSuccessMessage
        message={messageWithToolResult(
          toolUseID,
          'hidden fallback',
          { value: 'raw output' },
        )}
        lookups={createLookups(toolUseID, { path: 'src/raw.ts' })}
        toolUseID={toolUseID}
        progressMessagesForMessage={[
          { data: { type: 'hook_progress', hookEvent: 'PostToolUse' } },
          { data: { type: 'tool_progress', text: 'visible' } },
        ] as never}
        tool={tool}
        tools={tools}
        verbose={false}
        width={40}
        isTranscriptMode={true}
      />,
      { columns: 90, rows: 12 },
    )

    expect(output).toContain('raw output progress:1 input:src/raw.ts transcript:true')
    expect(output).not.toContain('hidden fallback')
    expect(renderToolResultMessage).toHaveBeenCalledTimes(1)
    expect(tool.userFacingName).toHaveBeenCalledWith(undefined)
  })

  test('renders nothing when neither fallback nor delegated content is available', async () => {
    const toolUseID = 'toolu_swarm_044_empty'
    const nullRenderingTool = {
      renderToolResultMessage: vi.fn(() => null),
      userFacingName: vi.fn(() => 'Null renderer'),
    } as unknown as Tool

    const missingWithoutFallback = await renderToString(
      <UserToolSuccessMessage
        message={{
          type: 'user',
          message: { role: 'user', content: [] },
          toolUseResult: null,
        } as never}
        lookups={createLookups(toolUseID)}
        toolUseID={toolUseID}
        progressMessagesForMessage={[]}
        tools={[]}
        verbose={false}
        width={50}
      />,
      { columns: 80, rows: 8 },
    )

    const delegatedNull = await renderToString(
      <UserToolSuccessMessage
        message={messageWithToolResult(toolUseID, 'hidden', { value: 'ignored' })}
        lookups={createLookups(toolUseID)}
        toolUseID={toolUseID}
        progressMessagesForMessage={[]}
        tool={nullRenderingTool}
        tools={[nullRenderingTool] as Tools}
        verbose={false}
        width={50}
      />,
      { columns: 80, rows: 8 },
    )

    expect(missingWithoutFallback.trim()).toBe('')
    expect(delegatedNull.trim()).toBe('')
    expect(nullRenderingTool.renderToolResultMessage).toHaveBeenCalledTimes(1)
    expect(nullRenderingTool.userFacingName).not.toHaveBeenCalled()
  })
})
