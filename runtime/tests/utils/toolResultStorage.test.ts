import { expect, test } from 'bun:test'

import { createUserMessage } from '../../src/utils/messages.ts'
import {
  applyToolResultReplacementsToMessages,
  reconstructContentReplacementState,
} from '../../src/utils/toolResultStorage.ts'

test('applyToolResultReplacementsToMessages replaces matching tool results and preserves unrelated messages', () => {
  const unrelated = createUserMessage({ content: 'keep me' })
  const oversizedResult = createUserMessage({
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'tool-1',
        content: 'very large tool output',
        is_error: false,
      },
    ],
    toolUseResult: {
      stdout: 'very large tool output',
      stderr: '',
    },
  })
  const messages = [unrelated, oversizedResult]
  const replacement =
    '<persisted-output>\nOutput too large. Preview\n</persisted-output>'

  const next = applyToolResultReplacementsToMessages(
    messages,
    new Map([['tool-1', replacement]]),
  )

  expect(next).not.toBe(messages)
  expect(next[0]).toBe(unrelated)
  expect(next[1]).not.toBe(oversizedResult)
  expect((next[1]!.message.content as Array<{ content: string }>)[0]!.content).toBe(
    replacement,
  )
  expect(next[1]!.toolUseResult).toBeUndefined()
})

test('applyToolResultReplacementsToMessages is idempotent when messages are already hydrated', () => {
  const hydrated = createUserMessage({
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'tool-1',
        content: '<persisted-output>\nPreview\n</persisted-output>',
        is_error: false,
      },
    ],
  })
  const messages = [hydrated]

  const next = applyToolResultReplacementsToMessages(
    messages,
    new Map([['tool-1', '<persisted-output>\nPreview\n</persisted-output>']]),
  )

  expect(next).toBe(messages)
})

test('applyToolResultReplacementsToMessages ignores malformed transcript blocks', () => {
  const arrayShapedToolResult = Object.assign([], {
    type: 'tool_result',
    tool_use_id: 'array-tool-result',
    content: 'must remain untouched',
    is_error: false,
  })
  const validToolResult = {
    type: 'tool_result',
    tool_use_id: 'tool-1',
    content: 'very large tool output',
    is_error: false,
  }
  const message = createUserMessage({
    content: 'placeholder',
  })
  ;(message.message as { content: unknown }).content = [
    null,
    'loose text block',
    { type: 'tool_result', tool_use_id: 123, content: 'bad id' },
    { type: 'tool_result', tool_use_id: 'bad-content', content: { raw: true } },
    { type: 'tool_result', tool_use_id: 'bad-text', content: [{ type: 'text' }] },
    arrayShapedToolResult,
    validToolResult,
  ]
  const replacement =
    '<persisted-output>\nOutput too large. Preview\n</persisted-output>'

  const next = applyToolResultReplacementsToMessages(
    [message],
    new Map([
      ['tool-1', replacement],
      ['bad-content', 'must not be read'],
      ['bad-text', 'must not be read'],
      ['array-tool-result', 'must not be read'],
    ]),
  )

  const blocks = next[0]!.message.content as unknown[]
  expect(next[0]).not.toBe(message)
  expect(blocks.slice(0, 6)).toEqual([
    null,
    'loose text block',
    { type: 'tool_result', tool_use_id: 123, content: 'bad id' },
    { type: 'tool_result', tool_use_id: 'bad-content', content: { raw: true } },
    { type: 'tool_result', tool_use_id: 'bad-text', content: [{ type: 'text' }] },
    arrayShapedToolResult,
  ])
  expect((blocks[6] as { content: unknown }).content).toBe(replacement)
  expect(next[0]!.toolUseResult).toBeUndefined()
})

test('reconstructContentReplacementState ignores malformed tool result candidates', () => {
  const message = createUserMessage({
    content: 'placeholder',
  })
  ;(message.message as { content: unknown }).content = [
    { type: 'tool_result', tool_use_id: 'bad-content', content: 42 },
    { type: 'tool_result', tool_use_id: 'bad-text', content: [{ type: 'text' }] },
    { type: 'tool_result', tool_use_id: 'tool-1', content: 'large output' },
  ]

  const state = reconstructContentReplacementState(
    [message],
    [
      {
        kind: 'tool-result',
        toolUseId: 'tool-1',
        replacement: '<persisted-output>\nPreview\n</persisted-output>',
      },
      {
        kind: 'tool-result',
        toolUseId: 'bad-content',
        replacement: 'must not be restored',
      },
    ],
  )

  expect(state.seenIds.has('tool-1')).toBe(true)
  expect(state.seenIds.has('bad-content')).toBe(false)
  expect(state.seenIds.has('bad-text')).toBe(false)
  expect(state.replacements.get('tool-1')).toContain('Preview')
  expect(state.replacements.has('bad-content')).toBe(false)
})
