import { PassThrough } from 'node:stream'

import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const sandboxHarness = vi.hoisted(() => {
  const subscribers = new Set<() => void>()

  return {
    enabled: false,
    subscribers,
    totalCount: 0,
    reset() {
      subscribers.clear()
      this.enabled = false
      this.totalCount = 0
    },
    notify() {
      for (const subscriber of [...subscribers]) subscriber()
    },
    addViolations(count: number) {
      this.totalCount += count
      this.notify()
    },
  }
})

vi.mock('../../../src/tui/keybindings/useShortcutDisplay.js', () => ({
  useShortcutDisplay: () => 'ctrl+shift+o',
}))

vi.mock('../../../src/utils/sandbox/sandbox-runtime.js', () => ({
  SandboxManager: {
    getSandboxViolationStore: () => ({
      getTotalCount: () => sandboxHarness.totalCount,
      subscribe: (subscriber: () => void) => {
        sandboxHarness.subscribers.add(subscriber)
        return () => sandboxHarness.subscribers.delete(subscriber)
      },
    }),
    isSandboxingEnabled: () => sandboxHarness.enabled,
  },
}))

import { SandboxPromptFooterHint } from '../../../src/tui/components/PromptInput/SandboxPromptFooterHint.js'
import { createRoot } from '../../../src/tui/ink.js'
import type { DOMElement, DOMNode } from '../../../src/tui/ink/dom.js'
import instances from '../../../src/tui/ink/instances.js'

type TestStdin = PassThrough & {
  isTTY: boolean
  ref: () => void
  setRawMode: (mode: boolean) => void
  unref: () => void
}

type TestStdout = PassThrough & {
  columns: number
  isTTY: boolean
}

const realSetImmediate = setImmediate

function createStreams(): {
  stdin: TestStdin
  stdout: TestStdout
} {
  const stdin = new PassThrough() as TestStdin
  const stdout = new PassThrough() as TestStdout

  stdin.isTTY = true
  stdin.ref = () => {}
  stdin.setRawMode = () => {}
  stdin.unref = () => {}

  stdout.columns = 120
  stdout.isTTY = false
  stdout.resume()

  return { stdin, stdout }
}

async function flushReact(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
  await new Promise(resolve => realSetImmediate(resolve))
  await act(async () => {
    await Promise.resolve()
  })
}

function collectText(node: DOMNode): string {
  if (node.nodeName === '#text') return node.nodeValue
  return node.childNodes.map(collectText).join('')
}

function getRootNode(stdout: TestStdout): DOMElement {
  const instance = instances.get(stdout as unknown as NodeJS.WriteStream)
  if (!instance?.rootNode) throw new Error('Ink root node not found')
  return instance.rootNode
}

async function renderHint(): Promise<{
  dispose: () => Promise<void>
  text: () => string
}> {
  const { stdin, stdout } = createStreams()
  const root = await createRoot({
    patchConsole: false,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  })

  await act(async () => {
    root.render(<SandboxPromptFooterHint />)
  })
  await flushReact()

  return {
    dispose: async () => {
      await act(async () => {
        root.unmount()
      })
      stdin.end()
      stdout.end()
      await flushReact()
    },
    text: () => collectText(getRootNode(stdout)),
  }
}

describe('SandboxPromptFooterHint coverage swarm row 229', () => {
  beforeEach(() => {
    sandboxHarness.reset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  test('does not subscribe or render when sandboxing is disabled', async () => {
    const rendered = await renderHint()

    try {
      expect(rendered.text()).toBe('')
      expect(sandboxHarness.subscribers.size).toBe(0)
    } finally {
      await rendered.dispose()
    }
  })

  test('resets the latest violation hint after its timeout and unsubscribes on cleanup', async () => {
    sandboxHarness.enabled = true
    sandboxHarness.totalCount = 10
    const rendered = await renderHint()
    vi.useFakeTimers()

    try {
      expect(sandboxHarness.subscribers.size).toBe(1)
      expect(rendered.text()).toBe('')

      await act(async () => {
        sandboxHarness.addViolations(1)
      })
      await flushReact()
      expect(rendered.text()).toContain('Sandbox blocked 1 operation')
      expect(rendered.text()).toContain('ctrl+shift+o for details')

      await vi.advanceTimersByTimeAsync(4_999)
      await flushReact()
      expect(rendered.text()).toContain('Sandbox blocked 1 operation')

      await act(async () => {
        sandboxHarness.addViolations(2)
      })
      await flushReact()
      expect(rendered.text()).toContain('Sandbox blocked 2 operations')

      await vi.advanceTimersByTimeAsync(4_999)
      await flushReact()
      expect(rendered.text()).toContain('Sandbox blocked 2 operations')

      await vi.advanceTimersByTimeAsync(1)
      await flushReact()
      expect(rendered.text()).toBe('')
    } finally {
      await rendered.dispose()
    }

    expect(sandboxHarness.subscribers.size).toBe(0)
  })
})
