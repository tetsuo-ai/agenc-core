import { describe, expect, test, vi } from 'vitest'

import type { Tool } from '../../tools/Tool.js'
import { GroupedToolUseContent } from './GroupedToolUseContent.js'

describe('GroupedToolUseContent', () => {
  test('forwards grouped tool use state, filtered progress, results, and animation intent', () => {
    const renderGroupedToolUse = vi.fn(() => 'grouped node')
    const tool = {
      name: 'Agent',
      renderGroupedToolUse,
    } as unknown as Tool
    const tools = [tool]
    const completedToolUse = {
      id: 'tool-complete',
      input: { prompt: 'summarize the change' },
      name: 'Agent',
      type: 'tool_use',
    }
    const failedToolUse = {
      id: 'tool-failed',
      input: { prompt: 'review the change' },
      name: 'Agent',
      type: 'tool_use',
    }
    const runningToolUse = {
      id: 'tool-running',
      input: { prompt: 'run focused tests' },
      name: 'Agent',
      type: 'tool_use',
    }
    const completedResultParam = {
      content: 'summary ready',
      tool_use_id: 'tool-complete',
      type: 'tool_result',
    }
    const failedResultParam = {
      content: 'review failed',
      is_error: true,
      tool_use_id: 'tool-failed',
      type: 'tool_result',
    }
    const visibleProgress = {
      data: { message: 'running tests', type: 'task_output' },
      parentToolUseID: 'tool-running',
      type: 'progress',
    }
    const hookProgress = {
      data: { hookEvent: 'PreToolUse', type: 'hook_progress' },
      parentToolUseID: 'tool-running',
      type: 'progress',
    }
    const node = GroupedToolUseContent({
      inProgressToolUseIDs: new Set(['tool-running']),
      lookups: {
        erroredToolUseIDs: new Set(['tool-failed']),
        progressMessagesByToolUseID: new Map([
          ['tool-running', [hookProgress, visibleProgress]],
        ]),
        resolvedToolUseIDs: new Set(['tool-complete', 'tool-failed']),
      } as never,
      message: {
        messages: [
          { message: { content: [completedToolUse] }, type: 'assistant' },
          { message: { content: [failedToolUse] }, type: 'assistant' },
          { message: { content: [runningToolUse] }, type: 'assistant' },
        ],
        results: [
          {
            message: { content: [completedResultParam] },
            toolUseResult: { text: 'done' },
            type: 'user',
          },
          {
            message: { content: [failedResultParam] },
            toolUseResult: { text: 'boom' },
            type: 'user',
          },
        ],
        toolName: 'Agent',
        type: 'grouped_tool_use',
      } as never,
      shouldAnimate: true,
      tools,
    })

    expect(node).toBe('grouped node')
    expect(renderGroupedToolUse).toHaveBeenCalledTimes(1)
    expect(renderGroupedToolUse).toHaveBeenCalledWith(
      [
        {
          isError: false,
          isInProgress: false,
          isResolved: true,
          param: completedToolUse,
          progressMessages: [],
          result: {
            output: { text: 'done' },
            param: completedResultParam,
          },
        },
        {
          isError: true,
          isInProgress: false,
          isResolved: true,
          param: failedToolUse,
          progressMessages: [],
          result: {
            output: { text: 'boom' },
            param: failedResultParam,
          },
        },
        {
          isError: false,
          isInProgress: true,
          isResolved: false,
          param: runningToolUse,
          progressMessages: [visibleProgress],
          result: undefined,
        },
      ],
      {
        shouldAnimate: true,
        tools,
      },
    )
  })
})
