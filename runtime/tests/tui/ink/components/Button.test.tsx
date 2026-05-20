import { PassThrough } from 'node:stream'

import React from 'react'
import { describe, expect, test, vi } from 'vitest'

import Button from './Button.js'
import type { ButtonState } from './Button.js'
import Text from './Text.js'
import type { DOMElement } from '../dom.ts'
import instances from '../instances.ts'
import { createRoot } from '../root.ts'

vi.mock('../../../utils/fullscreen.js', () => ({
  isMouseClicksDisabled: () => false,
}))

type TestStdin = PassThrough & {
  isTTY: boolean
  setRawMode: (mode: boolean) => void
  ref: () => void
  unref: () => void
}

function createTestStreams(): {
  stdout: PassThrough
  stdin: TestStdin
} {
  const stdout = new PassThrough()
  const stdin = new PassThrough() as TestStdin

  stdin.isTTY = true
  stdin.setRawMode = () => {}
  stdin.ref = () => {}
  stdin.unref = () => {}
  ;(stdout as unknown as { columns: number }).columns = 80
  ;(stdout as unknown as { rows: number }).rows = 24
  ;(stdout as unknown as { isTTY: boolean }).isTTY = true

  return { stdout, stdin }
}

function getInkInstance(stdout: PassThrough) {
  const instance = instances.get(stdout as unknown as NodeJS.WriteStream)
  if (!instance) throw new Error('Ink instance not found')
  return instance
}

function findElement(node: DOMElement, type: string): DOMElement | null {
  if (node.nodeName === type) return node
  for (const child of node.childNodes) {
    const found = findElement(child, type)
    if (found) return found
  }
  return null
}

function requireElement(stdout: PassThrough, type: string): DOMElement {
  const rootNode = getInkInstance(stdout).rootNode
  if (!rootNode) throw new Error('Root node not found')
  const found = findElement(rootNode, type)
  if (!found) throw new Error(`Element ${type} not found`)
  return found
}

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

async function waitForCondition(
  predicate: () => boolean,
  message: string,
  timeoutMs = 2_000,
): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return
    await sleep(10)
  }
  throw new Error(message)
}

describe('Button', () => {
  test('wires action, focus, hover, and active state through the child render prop', async () => {
    const states: ButtonState[] = []
    const actions: string[] = []
    const { stdout, stdin } = createTestStreams()
    const root = await createRoot({
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      patchConsole: false,
    })

    try {
      root.render(
        <Button
          autoFocus
          borderStyle="single"
          onAction={() => actions.push('action')}
          tabIndex={2}
        >
          {state => {
            states.push({ ...state })
            return (
              <Text>
                {state.focused ? 'focused' : 'blurred'}-
                {state.hovered ? 'hovered' : 'plain'}-
                {state.active ? 'active' : 'idle'}
              </Text>
            )
          }}
        </Button>,
      )

      await waitForCondition(
        () => Boolean(requireElement(stdout, 'ink-box')),
        'Button box did not mount',
      )
      const box = requireElement(stdout, 'ink-box')

      expect(box.attributes.tabIndex).toBe(2)
      expect(box.attributes.autoFocus).toBe(true)
      expect(box._eventHandlers?.onKeyDown).toBeDefined()
      expect(box._eventHandlers?.onClick).toBeDefined()

      box._eventHandlers?.onMouseEnter?.()
      await waitForCondition(
        () => states.some(state => state.hovered),
        'Button hover state did not render',
      )

      box._eventHandlers?.onFocus?.({} as never)
      await waitForCondition(
        () => states.some(state => state.focused),
        'Button focus state did not render',
      )

      const ignoredPreventDefault = vi.fn()
      box._eventHandlers?.onKeyDown?.({
        key: 'x',
        preventDefault: ignoredPreventDefault,
      } as never)
      expect(ignoredPreventDefault).not.toHaveBeenCalled()
      expect(actions).toEqual([])

      const preventDefault = vi.fn()
      box._eventHandlers?.onKeyDown?.({
        key: 'return',
        preventDefault,
      } as never)
      expect(preventDefault).toHaveBeenCalled()
      expect(actions).toEqual(['action'])
      await waitForCondition(
        () => states.some(state => state.active),
        'Button active state did not render',
      )

      box._eventHandlers?.onKeyDown?.({
        key: ' ',
        preventDefault: vi.fn(),
      } as never)
      box._eventHandlers?.onClick?.({} as never)
      expect(actions).toEqual(['action', 'action', 'action'])

      box._eventHandlers?.onBlur?.({} as never)
      box._eventHandlers?.onMouseLeave?.()
      await waitForCondition(
        () => states.at(-1)?.focused === false && states.at(-1)?.hovered === false,
        'Button blur/leave state did not render',
      )
    } finally {
      root.unmount()
      stdin.end()
      stdout.end()
      await sleep(25)
    }
  })

  test('renders static children without a render prop', async () => {
    const { stdout, stdin } = createTestStreams()
    const root = await createRoot({
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      patchConsole: false,
    })

    try {
      root.render(
        <Button onAction={() => {}} tabIndex={-1}>
          <Text>static</Text>
        </Button>,
      )
      await waitForCondition(
        () => requireElement(stdout, 'ink-box').attributes.tabIndex === -1,
        'Static Button did not mount',
      )
    } finally {
      root.unmount()
      stdin.end()
      stdout.end()
      await sleep(25)
    }
  })
})
