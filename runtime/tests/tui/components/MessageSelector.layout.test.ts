import { describe, expect, it } from 'vitest'

import {
  buildMessageSelectorFileHistoryMetadata,
  computeMessageOptionTextWidth,
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
