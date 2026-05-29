import type { ContentBlockParam } from '@anthropic-ai/sdk/resources'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import { processTextPrompt } from './processTextPrompt.js'

const mocks = vi.hoisted(() => ({
  createUserMessage: vi.fn((input: { content: unknown }) => ({
    type: 'user',
    message: { role: 'user', content: input.content },
    ...input,
  })),
  setPromptId: vi.fn(),
}))

vi.mock('../../bootstrap/state.js', () => ({
  flushInteractionTime: vi.fn(),
  setPromptId: mocks.setPromptId,
  updateLastInteractionTime: vi.fn(),
}))

vi.mock('../../utils/messages.js', () => ({
  createUserMessage: mocks.createUserMessage,
}))

describe('processTextPrompt array image prompt coverage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test('builds the user message from all text and image blocks', () => {
    const contextBlock = {
      type: 'text',
      text: '<selection>status panel</selection>',
    } satisfies ContentBlockParam
    const promptBlock = {
      type: 'text',
      text: 'summarize the selected status',
    } satisfies ContentBlockParam
    const imageBlock = {
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/png',
        data: 'iVBORw0KGgo=',
      },
    } satisfies ContentBlockParam
    const attachmentMessage = {
      type: 'attachment',
      attachment: {
        type: 'hook_success',
        content: 'extra diagnostic context',
      },
    }

    const result = processTextPrompt(
      [contextBlock, promptBlock],
      [imageBlock],
      [17],
      [attachmentMessage],
      'prompt-uuid',
      'plan',
      true,
    )

    expect(result.shouldQuery).toBe(true)
    expect(mocks.createUserMessage).toHaveBeenCalledWith({
      content: [contextBlock, promptBlock, imageBlock],
      uuid: 'prompt-uuid',
      imagePasteIds: [17],
      permissionMode: 'plan',
      isMeta: true,
    })
    expect(result.messages).toEqual([
      expect.objectContaining({
        content: [contextBlock, promptBlock, imageBlock],
        uuid: 'prompt-uuid',
        imagePasteIds: [17],
        permissionMode: 'plan',
        isMeta: true,
      }),
      attachmentMessage,
    ])
  })
})
