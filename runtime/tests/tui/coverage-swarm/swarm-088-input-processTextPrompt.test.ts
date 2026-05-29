import type { ContentBlockParam } from '@anthropic-ai/sdk/resources'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import {
  finalizeVimInputForRouting,
  processTextPrompt,
} from '../../../src/tui/input/processTextPrompt.js'

const mocks = vi.hoisted(() => ({
  createUserMessage: vi.fn((input: { content: unknown }) => ({
    type: 'user',
    message: { role: 'user', content: input.content },
    ...input,
  })),
  setPromptId: vi.fn(),
}))

vi.mock('../../../src/bootstrap/state.js', () => ({
  flushInteractionTime: vi.fn(),
  setPromptId: mocks.setPromptId,
  updateLastInteractionTime: vi.fn(),
}))

vi.mock('../../../src/utils/messages.js', () => ({
  createUserMessage: mocks.createUserMessage,
}))

function imageBlock(data = 'iVBORw0KGgo='): ContentBlockParam {
  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: 'image/png',
      data,
    },
  }
}

describe('processTextPrompt coverage swarm row 088', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test('finalizes insert-mode vim routing with clamped offsets and escape back to normal mode', () => {
    expect(finalizeVimInputForRouting('alpha', undefined)).toBe('alpha')
    expect(
      finalizeVimInputForRouting('alpha', {
        enabled: false,
        mode: 'INSERT',
        keys: ['!'],
      }),
    ).toBe('alpha')

    expect(
      finalizeVimInputForRouting('abc', {
        enabled: true,
        mode: 'INSERT',
        cursorOffset: -20,
        columns: 12,
        keys: ['X', 'Y', '\x1b', 'x'],
      }),
    ).toBe('XYbc')
  })

  test('omits whitespace-only text and empty paste ids when creating image prompts', () => {
    const pastedImage = imageBlock()
    const result = processTextPrompt(
      '   ',
      [pastedImage],
      [],
      [],
      'prompt-uuid',
      'acceptEdits',
      false,
    )

    expect(result.shouldQuery).toBe(true)
    expect(mocks.createUserMessage).toHaveBeenCalledWith({
      content: [pastedImage],
      uuid: 'prompt-uuid',
      imagePasteIds: undefined,
      permissionMode: 'acceptEdits',
      isMeta: undefined,
    })
    expect(result.messages).toEqual([
      expect.objectContaining({
        content: [pastedImage],
        imagePasteIds: undefined,
        isMeta: undefined,
      }),
    ])
  })

  test('builds a user message from array input that has no text blocks', () => {
    const inlineImage = imageBlock('inline-image')
    const result = processTextPrompt([inlineImage], [], [], [])

    expect(result.shouldQuery).toBe(true)
    expect(mocks.createUserMessage).toHaveBeenCalledWith({
      content: [inlineImage],
      uuid: undefined,
      permissionMode: undefined,
      isMeta: undefined,
    })
  })

  test('creates a user message from string prompt content', () => {
    processTextPrompt('This sucks, keep going', [], [], [])

    expect(mocks.createUserMessage).toHaveBeenCalledWith({
      content: 'This sucks, keep going',
      uuid: undefined,
      permissionMode: undefined,
      isMeta: undefined,
    })
  })
})
