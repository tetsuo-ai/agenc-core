import { describe, expect, test } from 'vitest'

import type { Message } from '../../types/message.js'
import { snipCompactIfNeeded } from './snip-compact.js'

function toolMessage(size: number, toolName: string): Message {
  return {
    role: 'tool',
    content: 'x'.repeat(size),
    toolCallId: `tool-${toolName}-${size}`,
    toolName,
  } as Message
}

describe('snipCompactIfNeeded', () => {
  test('clears oversized tool results on the live path', () => {
    const messages: Message[] = [
      { role: 'user', content: 'seed' } as Message,
      toolMessage(20 * 1024, 'A'),
      { role: 'assistant', content: 'ack' } as Message,
      toolMessage(500, 'B'),
    ]

    const result = snipCompactIfNeeded(messages)

    expect(result.tokensFreed).toBeGreaterThan(0)
    expect(result.messages).not.toBe(messages)
    expect(result.messages[1]?.content).toBe('[Old tool result content cleared]')
    expect(result.messages[3]?.content).toBe('x'.repeat(500))
    expect(result.boundaryMessage?.content).toContain('[snip]')
  })

  test('no-ops for small tool results', () => {
    const messages: Message[] = [
      { role: 'user', content: 'seed' } as Message,
      toolMessage(128, 'A'),
    ]

    const result = snipCompactIfNeeded(messages)

    expect(result.tokensFreed).toBe(0)
    expect(result.messages).toBe(messages)
    expect(result.boundaryMessage).toBeUndefined()
  })
})
