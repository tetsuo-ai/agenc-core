import { describe, expect, it } from 'vitest'

import {
  buildMessageSelectorFileHistoryMetadata,
  computeMessageOptionTextWidth,
  messagesAfterAreOnlySynthetic,
} from './MessageSelector.js'

describe('computeMessageOptionTextWidth', () => {
  it('clamps below-padding widths to one usable column', () => {
    expect(computeMessageOptionTextWidth(6, 10)).toBe(1)
    expect(computeMessageOptionTextWidth(0, 10)).toBe(1)
  })

  it('subtracts padding from normal terminal widths', () => {
    expect(computeMessageOptionTextWidth(80, 10)).toBe(70)
  })
})

describe('buildMessageSelectorFileHistoryMetadata', () => {
  it('keys loaded metadata by message UUID instead of visible row index', () => {
    const first = {
      type: 'user',
      uuid: 'message-a',
      message: { content: [{ type: 'text', text: 'first' }] },
    }
    const second = {
      type: 'user',
      uuid: 'message-b',
      message: { content: [{ type: 'text', text: 'second' }] },
    }
    const current = {
      type: 'user',
      uuid: 'current-message',
      message: { content: [{ type: 'text', text: '' }] },
    }

    const metadata = buildMessageSelectorFileHistoryMetadata({
      messageOptions: [first, second, current] as never,
      messages: [first, second] as never,
      currentUUID: current.uuid as never,
      fileHistory: {} as never,
      isFileHistoryEnabled: true,
      canRestoreMessage: (_state, messageId) => messageId === first.uuid,
    })

    expect(Object.keys(metadata)).toEqual(['message-a', 'message-b'])
    expect(metadata['message-a']).toEqual({
      filesChanged: [],
      insertions: 0,
      deletions: 0,
    })
    expect(Object.hasOwn(metadata, 'message-b')).toBe(true)
    expect(metadata['message-b']).toBeUndefined()
    expect(metadata).not.toHaveProperty('0')
    expect(metadata).not.toHaveProperty('1')
    expect(metadata).not.toHaveProperty('current-message')
  })

  it('returns an empty metadata map when file history is disabled', () => {
    const message = {
      type: 'user',
      uuid: 'message-a',
      message: { content: [{ type: 'text', text: 'first' }] },
    }

    expect(
      buildMessageSelectorFileHistoryMetadata({
        messageOptions: [message] as never,
        messages: [message] as never,
        currentUUID: 'current-message' as never,
        fileHistory: {} as never,
        isFileHistoryEnabled: false,
      }),
    ).toEqual({})
  })
})

describe('messagesAfterAreOnlySynthetic', () => {
  it('treats system, progress, attachment, meta, tool-result, and empty assistant messages as non-meaningful', () => {
    const messages = [
      {
        type: 'user',
        uuid: 'starting-message',
        message: { content: [{ type: 'text', text: 'start' }] },
      },
      { type: 'progress', uuid: 'progress-message' },
      { type: 'system', uuid: 'system-message' },
      { type: 'attachment', uuid: 'attachment-message' },
      {
        type: 'user',
        uuid: 'meta-message',
        isMeta: true,
        message: { content: [{ type: 'text', text: 'metadata' }] },
      },
      {
        type: 'user',
        uuid: 'tool-result-message',
        message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'done' }] },
      },
      {
        type: 'assistant',
        uuid: 'empty-assistant-message',
        message: { content: [{ type: 'text', text: '   ' }] },
      },
    ]

    expect(messagesAfterAreOnlySynthetic(messages as never, 0)).toBe(true)
  })

  it('flags assistant text after the selected message as meaningful', () => {
    const messages = [
      {
        type: 'user',
        uuid: 'starting-message',
        message: { content: [{ type: 'text', text: 'start' }] },
      },
      {
        type: 'assistant',
        uuid: 'assistant-message',
        message: { content: [{ type: 'text', text: 'meaningful output' }] },
      },
    ]

    expect(messagesAfterAreOnlySynthetic(messages as never, 0)).toBe(false)
  })

  it('flags assistant tool use after the selected message as meaningful', () => {
    const messages = [
      {
        type: 'user',
        uuid: 'starting-message',
        message: { content: [{ type: 'text', text: 'start' }] },
      },
      {
        type: 'assistant',
        uuid: 'assistant-tool-message',
        message: {
          content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: {} }],
        },
      },
    ]

    expect(messagesAfterAreOnlySynthetic(messages as never, 0)).toBe(false)
  })

  it('flags normal user messages after the selected message as meaningful', () => {
    const messages = [
      {
        type: 'user',
        uuid: 'starting-message',
        message: { content: [{ type: 'text', text: 'start' }] },
      },
      {
        type: 'user',
        uuid: 'next-user-message',
        message: { content: [{ type: 'text', text: 'next prompt' }] },
      },
    ]

    expect(messagesAfterAreOnlySynthetic(messages as never, 0)).toBe(false)
  })
})
