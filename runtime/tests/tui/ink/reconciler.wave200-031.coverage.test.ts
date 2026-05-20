import { PassThrough } from 'node:stream'

import React from 'react'
import { expect, test, vi } from 'vitest'

import type { DOMElement, ElementNames } from './dom.ts'
import { LayoutDisplay } from './layout/node.ts'
import { createRoot, type Root } from './root.ts'
import instances from './instances.ts'

vi.mock('../../utils/fullscreen.js', () => ({
  isMouseClicksDisabled: () => false,
}))

type TestStdout = PassThrough & {
  columns: number
  rows: number
  isTTY: boolean
}

type TestStdin = PassThrough & {
  isTTY: boolean
  setRawMode: (mode: boolean) => void
  ref: () => void
  unref: () => void
}

const RAW_TEXT_STYLE = {
  flexDirection: 'row',
  flexGrow: 0,
  flexShrink: 1,
  textWrap: 'wrap',
} as const

const Activity = React.Activity as React.ElementType<{
  mode: 'visible' | 'hidden'
  children: React.ReactNode
}>

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function createTestStreams(): {
  stdout: TestStdout
  stdin: TestStdin
} {
  const stdout = new PassThrough() as TestStdout
  const stdin = new PassThrough() as TestStdin

  stdout.columns = 80
  stdout.rows = 24
  stdout.isTTY = true

  stdin.isTTY = true
  stdin.setRawMode = () => {}
  stdin.ref = () => {}
  stdin.unref = () => {}

  return { stdout, stdin }
}

function getRootNode(stdout: TestStdout): DOMElement {
  const instance = instances.get(stdout as unknown as NodeJS.WriteStream) as
    | { rootNode?: DOMElement }
    | undefined

  if (!instance?.rootNode) {
    throw new Error('Ink root node not found')
  }

  return instance.rootNode
}

function findElement(
  node: DOMElement,
  nodeName: ElementNames,
): DOMElement | undefined {
  if (node.nodeName === nodeName) {
    return node
  }

  for (const child of node.childNodes) {
    if (child.nodeName === '#text') {
      continue
    }

    const found = findElement(child, nodeName)
    if (found) {
      return found
    }
  }

  return undefined
}

function requireElement(
  stdout: TestStdout,
  nodeName: ElementNames,
): DOMElement {
  const found = findElement(getRootNode(stdout), nodeName)

  if (!found) {
    throw new Error(`Expected to find ${nodeName}`)
  }

  return found
}

async function createHarness(): Promise<{
  root: Root
  stdout: TestStdout
  stdin: TestStdin
  dispose: () => Promise<void>
}> {
  const { stdout, stdin } = createTestStreams()
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  })

  return {
    root,
    stdout,
    stdin,
    dispose: async () => {
      root.unmount()
      stdin.end()
      stdout.end()
      await sleep(25)
    },
  }
}

function renderNestedText(mode: 'visible' | 'hidden'): React.ReactElement {
  return React.createElement(
    Activity,
    { mode },
    React.createElement(
      'ink-text',
      {
        style: RAW_TEXT_STYLE,
      },
      'outer ',
      React.createElement(
        'ink-text',
        {
          style: RAW_TEXT_STYLE,
        },
        'inner',
      ),
    ),
  )
}

test('reconciler virtualizes nested text and toggles Activity visibility in place', async () => {
  const harness = await createHarness()

  try {
    harness.root.render(renderNestedText('visible'))
    await sleep(25)

    const hostText = requireElement(harness.stdout, 'ink-text')
    const virtualText = requireElement(harness.stdout, 'ink-virtual-text')

    expect(virtualText.parentNode).toBe(hostText)
    expect(hostText.isHidden).toBeUndefined()
    expect(hostText.yogaNode?.getDisplay()).toBe(LayoutDisplay.Flex)

    harness.root.render(renderNestedText('hidden'))
    await sleep(25)

    const hiddenHostText = requireElement(harness.stdout, 'ink-text')
    expect(hiddenHostText).toBe(hostText)
    expect(hiddenHostText.isHidden).toBe(true)
    expect(hiddenHostText.yogaNode?.getDisplay()).toBe(LayoutDisplay.None)

    harness.root.render(renderNestedText('visible'))
    await sleep(25)

    const visibleHostText = requireElement(harness.stdout, 'ink-text')
    expect(visibleHostText).toBe(hostText)
    expect(visibleHostText.isHidden).toBe(false)
    expect(visibleHostText.yogaNode?.getDisplay()).toBe(LayoutDisplay.Flex)
  } finally {
    await harness.dispose()
  }
})
