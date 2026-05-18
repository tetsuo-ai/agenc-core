import React from 'react'
import { describe, expect, test, vi } from 'vitest'

import { CompactBoundaryMessage } from './CompactBoundaryMessage.js'
import { CompactSummary } from './CompactSummary.js'

vi.mock('react-compiler-runtime', () => ({
  c: (size: number) =>
    Array.from({ length: size }, () =>
      Symbol.for('react.memo_cache_sentinel'),
    ),
}))

vi.mock('../../ink.js', async () => {
  const ReactModule = await import('react')
  const Passthrough = ({
    children,
  }: {
    children?: React.ReactNode
  }) => ReactModule.createElement(ReactModule.Fragment, null, children)
  return {
    Box: Passthrough,
    Text: Passthrough,
  }
})

vi.mock('../ConfigurableShortcutHint', () => ({
  ConfigurableShortcutHint: ({
    description,
  }: {
    description: string
  }) => <>{description}</>,
}))

vi.mock('../MessageResponse', () => ({
  MessageResponse: ({ children }: { children?: React.ReactNode }) => (
    <>{children}</>
  ),
}))

vi.mock('../../keybindings/useShortcutDisplay.js', () => ({
  useShortcutDisplay: () => 'ctrl+o',
}))

vi.mock('../../../utils/messages.js', () => ({
  getUserMessageText: (message: {
    readonly text?: string
    readonly message?: {
      readonly content?: ReadonlyArray<{ readonly text?: string }>
    }
  }) =>
    message.text ??
    message.message?.content?.map((part) => part.text ?? '').join('') ??
    '',
}))

describe('compact conversation components', () => {
  test('renders summary metadata in prompt mode', () => {
    const output = renderPlain(
      <CompactSummary
        message={compactMessage({
          summarizeMetadata: {
            messagesSummarized: 3,
            direction: 'up_to',
            userContext: 'keep the API notes',
          },
          text: 'full compact summary',
        })}
        screen="prompt"
      />,
    )

    expect(output).toContain('Summarized conversation')
    expect(output).toContain('Summarized 3 messages up to this point')
    expect(output).toContain('Context: “keep the API notes”')
    expect(output).toContain('expand history')
    expect(output).not.toContain('full compact summary')
  })

  test('renders compact summary text in transcript mode', () => {
    const output = renderPlain(
      <CompactSummary
        message={compactMessage({
          summarizeMetadata: {
            messagesSummarized: 2,
            direction: 'from',
          },
          text: 'full compact summary',
        })}
        screen="transcript"
      />,
    )

    expect(output).toContain('Summarized conversation')
    expect(output).toContain('full compact summary')
    expect(output).not.toContain('from this point')
  })

  test('renders from-this-point metadata in prompt mode', () => {
    const output = renderPlain(
      <CompactSummary
        message={compactMessage({
          summarizeMetadata: {
            messagesSummarized: 4,
            direction: 'from',
          },
          text: 'full compact summary',
        })}
        screen="prompt"
      />,
    )

    expect(output).toContain('Summarized 4 messages from this point')
  })

  test('renders compact summary fallback in prompt and transcript modes', () => {
    const promptSummary = renderPlain(
      <CompactSummary
        message={compactMessage({ text: 'brief compact summary' })}
        screen="prompt"
      />,
    )
    const transcriptSummary = renderPlain(
      <CompactSummary
        message={compactMessage({ text: 'brief compact summary' })}
        screen="transcript"
      />,
    )

    expect(promptSummary).toContain('Compact summary')
    expect(promptSummary).toContain('expand')
    expect(promptSummary).not.toContain('brief compact summary')
    expect(transcriptSummary).toContain('Compact summary')
    expect(transcriptSummary).toContain('brief compact summary')
    expect(transcriptSummary).not.toContain('expand')
  })

  test('renders compact boundary cell', () => {
    const boundary = renderPlain(<CompactBoundaryMessage />)

    expect(boundary).toContain('✻ Conversation compacted (ctrl+o for history)')
  })
})

function compactMessage(input: {
  readonly text: string
  readonly summarizeMetadata?: {
    readonly messagesSummarized: number
    readonly direction: 'up_to' | 'from'
    readonly userContext?: string
  }
}) {
  return {
    type: 'user',
    isCompactSummary: true,
    summarizeMetadata: input.summarizeMetadata,
    text: input.text,
    message: {
      content: [{ type: 'text', text: input.text }],
    },
  } as never
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
