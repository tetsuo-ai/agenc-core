import React from 'react'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import { CompactBoundaryMessage } from '../../../src/tui/components/compact/CompactBoundaryMessage.js'

const harness = vi.hoisted(() => ({
  cache: [] as unknown[],
  shortcut: 'ctrl+o',
  shortcutCalls: [] as Array<{
    action: string
    scope: string
    fallback: string
  }>,
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

vi.mock('../../../src/tui/keybindings/useShortcutDisplay.js', () => ({
  useShortcutDisplay: (action: string, scope: string, fallback: string) => {
    harness.shortcutCalls.push({ action, scope, fallback })
    return harness.shortcut
  },
}))

describe('CompactBoundaryMessage coverage swarm', () => {
  beforeEach(() => {
    harness.cache = Array.from({ length: 2 }, () => memoSentinel)
    harness.shortcut = 'ctrl+o'
    harness.shortcutCalls = []
  })

  test('renders the configured transcript shortcut and requests the expected fallback binding', () => {
    harness.shortcut = 'alt+h'

    const output = renderPlain(<CompactBoundaryMessage />)

    expect(output).toContain('Conversation compacted (alt+h for history)')
    expect(harness.shortcutCalls).toEqual([
      {
        action: 'app:toggleTranscript',
        scope: 'Global',
        fallback: 'ctrl+o',
      },
    ])
  })

  test('reuses the cached message while the displayed shortcut is unchanged', () => {
    const first = CompactBoundaryMessage()
    const second = CompactBoundaryMessage()

    expect(second).toBe(first)
    expect(renderPlain(second)).toContain(
      'Conversation compacted (ctrl+o for history)',
    )

    harness.shortcut = 'cmd+o'

    const updated = CompactBoundaryMessage()

    expect(updated).not.toBe(first)
    expect(renderPlain(updated)).toContain(
      'Conversation compacted (cmd+o for history)',
    )
  })
})

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
