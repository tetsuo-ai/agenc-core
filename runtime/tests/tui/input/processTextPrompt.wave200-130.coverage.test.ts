import type { ContentBlockParam } from '@anthropic-ai/sdk/resources'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import { processTextPrompt } from './processTextPrompt.js'

const mocks = vi.hoisted(() => ({
  createUserMessage: vi.fn((input: { content: unknown }) => ({
    type: 'user',
    message: { role: 'user', content: input.content },
    ...input,
  })),
  logEvent: vi.fn(),
  logOTelEvent: vi.fn(),
  redactIfDisabled: vi.fn((value: string) => `redacted:${value}`),
  setPromptId: vi.fn(),
  startInteractionSpan: vi.fn(),
}))

vi.mock('../../bootstrap/state.js', () => ({
  flushInteractionTime: vi.fn(),
  setPromptId: mocks.setPromptId,
  updateLastInteractionTime: vi.fn(),
}))

vi.mock('../../services/analytics/index.js', () => ({
  logEvent: mocks.logEvent,
}))

vi.mock('../../utils/messages.js', () => ({
  createUserMessage: mocks.createUserMessage,
}))

vi.mock('../../utils/telemetry/events.js', () => ({
  logOTelEvent: mocks.logOTelEvent,
  redactIfDisabled: mocks.redactIfDisabled,
}))

vi.mock('../../utils/telemetry/sessionTracing.js', () => ({
  startInteractionSpan: mocks.startInteractionSpan,
}))

describe('processTextPrompt array image prompt coverage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test('uses first text for interaction span and last text for prompt telemetry', () => {
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
    const promptId = mocks.setPromptId.mock.calls[0]?.[0]

    expect(result.shouldQuery).toBe(true)
    expect(mocks.startInteractionSpan).toHaveBeenCalledWith(contextBlock.text)
    expect(mocks.redactIfDisabled).toHaveBeenCalledWith(promptBlock.text)
    expect(mocks.logOTelEvent).toHaveBeenCalledWith('user_prompt', {
      prompt_length: String(promptBlock.text.length),
      prompt: `redacted:${promptBlock.text}`,
      'prompt.id': promptId,
    })
    expect(mocks.logEvent).toHaveBeenCalledWith('agenc_input_prompt', {
      is_negative: false,
      is_keep_going: false,
    })
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
