import React from 'react'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import { CompactSummary } from '../../../src/tui/components/compact/CompactSummary.js'

const harness = vi.hoisted(() => ({
  cache: [] as unknown[],
  getUserMessageText: vi.fn(),
}))

const memoSentinel = Symbol.for('react.memo_cache_sentinel')

vi.mock('react-compiler-runtime', () => ({
  c: (size: number) => {
    if (harness.cache.length !== size) {
      harness.cache = Array.from({ length: size }, () => memoSentinel)
    }
    return harness.cache
  },
}))

vi.mock('../../../src/tui/ink.js', async () => {
  const ReactModule = await vi.importActual<typeof import('react')>('react')
  const Passthrough = ({ children }: { children?: React.ReactNode }) =>
    ReactModule.createElement(ReactModule.Fragment, null, children)

  return {
    Box: Passthrough,
    Text: Passthrough,
  }
})

vi.mock('../../../src/tui/components/ConfigurableShortcutHint', () => ({
  ConfigurableShortcutHint: ({ description }: { description: string }) => (
    <>{description}</>
  ),
}))

vi.mock('../../../src/tui/components/MessageResponse', () => ({
  MessageResponse: ({ children }: { children?: React.ReactNode }) => (
    <>{children}</>
  ),
}))

vi.mock('../../../src/utils/messages.js', () => ({
  getUserMessageText: harness.getUserMessageText,
}))

describe('CompactSummary coverage swarm', () => {
  beforeEach(() => {
    harness.cache = Array.from({ length: 24 }, () => memoSentinel)
    harness.getUserMessageText.mockReset()
  })

  test('reuses cached metadata slots and recomputes transcript-only content when the screen changes', () => {
    const message = compactMessage({
      summarizeMetadata: {
        direction: 'up_to',
        messagesSummarized: 8,
        userContext: 'preserve API notes',
      },
    })
    harness.getUserMessageText.mockReturnValue('full cached summary')

    const promptOutput = renderSummary(message, 'prompt')
    const cachedPromptOutput = renderSummary(message, 'prompt')
    const transcriptOutput = renderSummary(message, 'transcript')

    expect(promptOutput).toContain('Summarized conversation')
    expect(promptOutput).toContain('Summarized 8 messages up to this point')
    expect(promptOutput).toContain('preserve API notes')
    expect(promptOutput).toContain('expand history')
    expect(promptOutput).not.toContain('full cached summary')
    expect(cachedPromptOutput).toBe(promptOutput)

    expect(transcriptOutput).toContain('Summarized conversation')
    expect(transcriptOutput).toContain('full cached summary')
    expect(transcriptOutput).not.toContain('expand history')
    expect(harness.getUserMessageText).toHaveBeenCalledTimes(1)
  })

  test('reuses cached fallback summary slots and hides the expansion hint in transcript mode', () => {
    const message = compactMessage()
    harness.getUserMessageText.mockReturnValue('fallback compact details')

    const promptOutput = renderSummary(message, 'prompt')
    const cachedPromptOutput = renderSummary(message, 'prompt')
    const transcriptOutput = renderSummary(message, 'transcript')

    expect(promptOutput).toContain('Compact summary')
    expect(promptOutput).toContain('expand')
    expect(promptOutput).not.toContain('fallback compact details')
    expect(cachedPromptOutput).toBe(promptOutput)

    expect(transcriptOutput).toContain('Compact summary')
    expect(transcriptOutput).toContain('fallback compact details')
    expect(transcriptOutput).not.toContain('expand')
    expect(harness.getUserMessageText).toHaveBeenCalledTimes(1)
  })

  test('normalizes missing user-message text to an empty transcript response', () => {
    const message = compactMessage()
    harness.getUserMessageText.mockReturnValue(null)

    const output = renderSummary(message, 'transcript')

    expect(output).toContain('Compact summary')
    expect(output).not.toContain('null')
    expect(output).not.toContain('undefined')
    expect(output).not.toContain('expand')
  })
})

function compactMessage(input: {
  readonly summarizeMetadata?: {
    readonly direction: 'up_to' | 'from'
    readonly messagesSummarized: number
    readonly userContext?: string
  }
} = {}) {
  return {
    type: 'user',
    isCompactSummary: true,
    summarizeMetadata: input.summarizeMetadata,
    message: {
      content: [{ type: 'text', text: 'ignored by mocked extractor' }],
    },
  } as never
}

function renderSummary(
  message: React.ComponentProps<typeof CompactSummary>['message'],
  screen: React.ComponentProps<typeof CompactSummary>['screen'],
): string {
  return renderPlain(<CompactSummary message={message} screen={screen} />)
}

function renderPlain(node: React.ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') {
    return ''
  }
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node)
  }
  if (Array.isArray(node)) {
    return node.map(renderPlain).join('')
  }
  if (React.isValidElement(node)) {
    if (typeof node.type === 'function') {
      const Component = node.type as (
        props: typeof node.props,
      ) => React.ReactNode
      return renderPlain(Component(node.props))
    }
    const element = node as React.ReactElement<{
      children?: React.ReactNode
    }>
    return renderPlain(element.props.children)
  }
  return ''
}
