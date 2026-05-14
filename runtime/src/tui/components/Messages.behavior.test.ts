import { describe, expect, it, vi } from 'vitest'

vi.mock('bun:bundle', () => ({
  feature: () => false,
}))

import {
  dropTextInBriefTurns,
  filterForBriefTool,
} from './messagesBriefFiltering.js'
import {
  getStreamingThinkingExpiryDelayMs,
  shouldShowStreamingThinking,
  STREAMING_THINKING_GRACE_MS,
} from './Messages.js'

const BRIEF_TOOL = 'SendUserMessage'
const FILE_TOOL = 'SendUserFile'

function assistantText(id: string, text = id) {
  return {
    id,
    type: 'assistant',
    message: {
      content: [{ type: 'text', text }],
    },
  }
}

function assistantToolUse(id: string, name: string) {
  return {
    id,
    type: 'assistant',
    message: {
      content: [{ type: 'tool_use', id, name }],
    },
  }
}

function userPrompt(id: string) {
  return {
    id,
    type: 'user',
    isMeta: false,
    message: {
      content: [{ type: 'text', text: id }],
    },
  }
}

function toolResult(id: string, toolUseID: string) {
  return {
    id,
    type: 'user',
    message: {
      content: [{ type: 'tool_result', tool_use_id: toolUseID }],
    },
  }
}

describe('Messages brief-mode filtering', () => {
  it('keeps brief tool output, matching results, and real user input only', () => {
    const messages = [
      { id: 'metrics', type: 'system', subtype: 'api_metrics' },
      { id: 'notice', type: 'system', subtype: 'init' },
      assistantText('assistant-text'),
      assistantToolUse('brief-tool-use', BRIEF_TOOL),
      toolResult('brief-tool-result', 'brief-tool-use'),
      toolResult('other-tool-result', 'other-tool-use'),
      userPrompt('real-user-input'),
      { id: 'meta-user', type: 'user', isMeta: true, message: { content: [] } },
      {
        id: 'queued-prompt',
        type: 'attachment',
        attachment: { type: 'queued_command', commandMode: 'prompt' },
      },
      {
        id: 'queued-task',
        type: 'attachment',
        attachment: { type: 'queued_command', commandMode: 'task-notification' },
      },
    ]

    const filtered = filterForBriefTool(messages, [BRIEF_TOOL])

    expect(filtered.map((message) => message.id)).toEqual([
      'notice',
      'brief-tool-use',
      'brief-tool-result',
      'real-user-input',
      'queued-prompt',
    ])
  })

  it('drops assistant text only in turns that call the brief tool', () => {
    const messages = [
      userPrompt('turn-one-user'),
      assistantText('turn-one-text'),
      assistantToolUse('turn-one-brief', BRIEF_TOOL),
      userPrompt('turn-two-user'),
      assistantText('turn-two-text'),
      assistantToolUse('turn-two-file', FILE_TOOL),
    ]

    const filtered = dropTextInBriefTurns(messages, [BRIEF_TOOL])

    expect(filtered.map((message) => message.id)).toEqual([
      'turn-one-user',
      'turn-one-brief',
      'turn-two-user',
      'turn-two-text',
      'turn-two-file',
    ])
  })
})

describe('streaming thinking visibility', () => {
  it('keeps active thinking visible regardless of elapsed time', () => {
    expect(shouldShowStreamingThinking({
      thinking: 'working',
      isStreaming: true,
      streamingEndedAt: 1,
    }, 1 + STREAMING_THINKING_GRACE_MS * 10)).toBe(true)
  })

  it('expires ended thinking at the grace-period boundary', () => {
    const streamingEndedAt = 1_000
    const thinking = {
      thinking: 'done',
      isStreaming: false,
      streamingEndedAt,
    }

    expect(shouldShowStreamingThinking(
      thinking,
      streamingEndedAt + STREAMING_THINKING_GRACE_MS - 1,
    )).toBe(true)
    expect(shouldShowStreamingThinking(
      thinking,
      streamingEndedAt + STREAMING_THINKING_GRACE_MS,
    )).toBe(false)
    expect(getStreamingThinkingExpiryDelayMs(
      thinking,
      streamingEndedAt + STREAMING_THINKING_GRACE_MS - 1,
    )).toBe(1)
    expect(getStreamingThinkingExpiryDelayMs(
      thinking,
      streamingEndedAt + STREAMING_THINKING_GRACE_MS,
    )).toBe(0)
  })
})
