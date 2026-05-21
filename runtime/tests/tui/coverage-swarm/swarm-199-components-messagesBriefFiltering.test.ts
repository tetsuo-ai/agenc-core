import { describe, expect, test } from 'vitest'

import {
  dropTextInBriefTurns,
  filterForBriefTool,
} from '../../../src/tui/components/messagesBriefFiltering.js'

const BRIEF_TOOL = 'SendUserMessage'
const OTHER_TOOL = 'SendUserFile'

type TestContent = {
  id?: string
  name?: string
  text?: string
  tool_use_id?: string
  type: string
}

type TestMessage = {
  attachment?: {
    commandMode?: string
    isMeta?: boolean
    origin?: unknown
    type: string
  }
  id: string
  isApiErrorMessage?: boolean
  isMeta?: boolean
  message?: {
    content: TestContent[]
  }
  subtype?: string
  type: string
}

function assistantText(id: string): TestMessage {
  return {
    id,
    message: { content: [{ text: id, type: 'text' }] },
    type: 'assistant',
  }
}

function assistantToolUse(
  id: string,
  name: string,
  includeToolUseID = true,
): TestMessage {
  const block: TestContent = { name, type: 'tool_use' }
  if (includeToolUseID) block.id = id
  return {
    id,
    message: { content: [block] },
    type: 'assistant',
  }
}

function userPrompt(id: string): TestMessage {
  return {
    id,
    isMeta: false,
    message: { content: [{ text: id, type: 'text' }] },
    type: 'user',
  }
}

function toolResult(id: string, toolUseID: string): TestMessage {
  return {
    id,
    message: { content: [{ tool_use_id: toolUseID, type: 'tool_result' }] },
    type: 'user',
  }
}

function ids(messages: TestMessage[]): string[] {
  return messages.map(message => message.id)
}

describe('messages brief filtering coverage swarm row 199', () => {
  test('keeps api errors and allowed brief calls while requiring known tool ids for results', () => {
    const messages: TestMessage[] = [
      toolResult('result-before-tool-use', 'brief-tool-use'),
      {
        id: 'api-error',
        isApiErrorMessage: true,
        message: { content: [{ text: 'rate limited', type: 'text' }] },
        type: 'assistant',
      },
      assistantToolUse('brief-no-id', BRIEF_TOOL, false),
      toolResult('result-for-missing-id', 'brief-no-id'),
      assistantToolUse('other-tool-use', OTHER_TOOL),
      assistantToolUse('brief-tool-use', BRIEF_TOOL),
      toolResult('matching-result', 'brief-tool-use'),
      {
        id: 'user-with-empty-content',
        isMeta: false,
        message: { content: [] },
        type: 'user',
      },
      { id: 'unknown-message', type: 'unknown' },
    ]

    expect(ids(filterForBriefTool(messages, [BRIEF_TOOL]))).toEqual([
      'api-error',
      'brief-no-id',
      'brief-tool-use',
      'matching-result',
      'user-with-empty-content',
    ])
  })

  test('only keeps plain queued prompt attachments in brief mode', () => {
    const messages: TestMessage[] = [
      {
        attachment: { commandMode: 'prompt', type: 'queued_command' },
        id: 'queued-prompt',
        type: 'attachment',
      },
      {
        attachment: {
          commandMode: 'prompt',
          isMeta: true,
          type: 'queued_command',
        },
        id: 'meta-queued-prompt',
        type: 'attachment',
      },
      {
        attachment: {
          commandMode: 'prompt',
          origin: 'hook',
          type: 'queued_command',
        },
        id: 'origin-queued-prompt',
        type: 'attachment',
      },
      {
        attachment: { commandMode: 'prompt', type: 'file' },
        id: 'file-attachment',
        type: 'attachment',
      },
      {
        attachment: { commandMode: 'task-notification', type: 'queued_command' },
        id: 'task-queued-command',
        type: 'attachment',
      },
    ]

    expect(ids(filterForBriefTool(messages, [BRIEF_TOOL]))).toEqual([
      'queued-prompt',
    ])
  })

  test('returns the original transcript when no brief tool is used', () => {
    const messages = [
      userPrompt('user'),
      assistantText('assistant-text'),
      assistantToolUse('other-tool-use', OTHER_TOOL),
      toolResult('other-tool-result', 'other-tool-use'),
    ]

    const filtered = dropTextInBriefTurns(messages, [BRIEF_TOOL])

    expect(filtered).toBe(messages)
    expect(ids(filtered)).toEqual([
      'user',
      'assistant-text',
      'other-tool-use',
      'other-tool-result',
    ])
  })

  test('does not advance turns for meta users or tool results when dropping brief text', () => {
    const messages: TestMessage[] = [
      assistantText('preface-text'),
      assistantToolUse('preface-brief', BRIEF_TOOL),
      userPrompt('real-user'),
      {
        id: 'meta-user',
        isMeta: true,
        message: { content: [{ text: 'internal', type: 'text' }] },
        type: 'user',
      },
      toolResult('tool-result-user', 'preface-brief'),
      assistantText('same-turn-text'),
      assistantToolUse('same-turn-brief', BRIEF_TOOL),
      userPrompt('next-user'),
      assistantText('next-turn-text'),
    ]

    expect(ids(dropTextInBriefTurns(messages, [BRIEF_TOOL]))).toEqual([
      'preface-brief',
      'real-user',
      'meta-user',
      'tool-result-user',
      'same-turn-brief',
      'next-user',
      'next-turn-text',
    ])
  })
})
