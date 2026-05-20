import { describe, expect, it, vi } from 'vitest'

vi.mock('bun:bundle', () => ({
  feature: () => false,
}))

import {
  areMessagePropsEqual,
  getToolResultMessageWidth,
  hasThinkingContent,
  type Props,
} from './Message.js'

describe('Message tool-result width behavior', () => {
  it('clamps tool-result content width for tiny terminals', () => {
    expect(getToolResultMessageWidth(120)).toBe(115)
    expect(getToolResultMessageWidth(5)).toBe(1)
    expect(getToolResultMessageWidth(1)).toBe(1)
  })
})

describe('hasThinkingContent', () => {
  it('only reports thinking blocks for assistant messages', () => {
    expect(hasThinkingContent({ type: 'user', message: { content: [{ type: 'thinking' }] } })).toBe(false)
    expect(hasThinkingContent({ type: 'assistant' })).toBe(false)
    expect(hasThinkingContent({ type: 'assistant', message: { content: [{ type: 'text' }] } })).toBe(false)
    expect(hasThinkingContent({ type: 'assistant', message: { content: [{ type: 'thinking' }] } })).toBe(true)
    expect(hasThinkingContent({ type: 'assistant', message: { content: [{ type: 'redacted_thinking' }] } })).toBe(true)
  })
})

describe('areMessagePropsEqual', () => {
  function props(overrides: Partial<Props> = {}): Props {
    return {
      message: {
        type: 'assistant',
        uuid: 'assistant-1',
        message: {
          id: 'assistant-message-1',
          content: [{ type: 'text', text: 'hello' }],
        },
      },
      lookups: {} as never,
      containerWidth: 80,
      addMargin: false,
      tools: [],
      commands: [],
      verbose: false,
      inProgressToolUseIDs: new Set(),
      progressMessagesForMessage: [],
      shouldAnimate: false,
      shouldShowDot: false,
      isTranscriptMode: false,
      isStatic: true,
      lastThinkingBlockId: null,
      latestBashOutputUUID: null,
      ...overrides,
    } as Props
  }

  it('re-renders when the message identity changes', () => {
    expect(
      areMessagePropsEqual(
        props(),
        props({
          message: {
            type: 'assistant',
            uuid: 'assistant-2',
            message: { id: 'assistant-message-2', content: [{ type: 'text', text: 'new' }] },
          },
        }),
      ),
    ).toBe(false)
  })

  it('ignores thinking-block cursor churn for messages without thinking content', () => {
    expect(
      areMessagePropsEqual(
        props({ lastThinkingBlockId: 'old' }),
        props({ lastThinkingBlockId: 'new' }),
      ),
    ).toBe(true)
  })

  it('re-renders thinking messages when the visible thinking block changes', () => {
    const message = {
      type: 'assistant',
      uuid: 'assistant-thinking',
      message: {
        id: 'assistant-thinking-message',
        content: [{ type: 'thinking', thinking: 'working' }],
      },
    }

    expect(
      areMessagePropsEqual(
        props({ message, lastThinkingBlockId: 'old' } as Partial<Props>),
        props({ message, lastThinkingBlockId: 'new' } as Partial<Props>),
      ),
    ).toBe(false)
  })

  it('re-renders for visible display state changes', () => {
    expect(areMessagePropsEqual(props(), props({ verbose: true }))).toBe(false)
    expect(areMessagePropsEqual(props(), props({ isTranscriptMode: true }))).toBe(false)
    expect(areMessagePropsEqual(props(), props({ containerWidth: 100 }))).toBe(false)
  })

  it('only tracks whether this message is the latest bash output', () => {
    expect(
      areMessagePropsEqual(
        props({ latestBashOutputUUID: 'other-message' }),
        props({ latestBashOutputUUID: 'another-message' }),
      ),
    ).toBe(true)

    expect(
      areMessagePropsEqual(
        props({ latestBashOutputUUID: 'assistant-1' }),
        props({ latestBashOutputUUID: 'other-message' }),
      ),
    ).toBe(false)
  })

  it('does not memoize non-static messages by default', () => {
    expect(areMessagePropsEqual(props({ isStatic: false }), props({ isStatic: false }))).toBe(false)
  })
})
