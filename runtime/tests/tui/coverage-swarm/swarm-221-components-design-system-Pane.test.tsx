import { PassThrough } from 'node:stream'

import React from 'react'
import { afterEach, describe, expect, test } from 'vitest'

import { Pane } from '../../../src/tui/components/design-system/Pane.js'
import { ModalContext } from '../../../src/tui/context/modalContext.js'
import type { DOMElement, DOMNode } from '../../../src/tui/ink/dom.js'
import instances from '../../../src/tui/ink/instances.js'
import { createRoot } from '../../../src/tui/ink/root.js'
import { Text } from '../../../src/tui/ink.js'
import { getTheme } from '../../../src/utils/theme.js'

type TestStdin = PassThrough & {
  isTTY: boolean
  ref: () => void
  setRawMode: (mode: boolean) => void
  unref: () => void
}

type TestStdout = PassThrough & {
  columns: number
  isTTY: boolean
  rows: number
}

type MountedRoot = {
  root: Awaited<ReturnType<typeof createRoot>>
  stdin: TestStdin
  stdout: TestStdout
}

const mountedRoots: MountedRoot[] = []

function createStreams(): { stdin: TestStdin; stdout: TestStdout } {
  const stdin = new PassThrough() as TestStdin
  const stdout = new PassThrough() as TestStdout

  stdin.isTTY = true
  stdin.ref = () => {}
  stdin.setRawMode = () => {}
  stdin.unref = () => {}

  stdout.columns = 20
  stdout.rows = 10
  stdout.isTTY = true
  stdout.resume()

  return { stdin, stdout }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function waitFor(
  predicate: () => boolean,
  message: string,
): Promise<void> {
  const startedAt = Date.now()

  while (Date.now() - startedAt < 2_000) {
    if (predicate()) return
    await sleep(10)
  }

  throw new Error(message)
}

function getRootNode(stdout: TestStdout): DOMElement {
  const instance = instances.get(stdout as unknown as NodeJS.WriteStream)

  if (!instance?.rootNode) {
    throw new Error('Ink root node not found')
  }

  return instance.rootNode
}

function requireElementChild(node: DOMElement, index: number): DOMElement {
  const child = node.childNodes[index]

  if (!child || child.nodeName === '#text') {
    throw new Error(`Expected element child at index ${index}`)
  }

  return child
}

function collectText(node: DOMNode): string {
  if (node.nodeName === '#text') return node.nodeValue

  return node.childNodes.map(collectText).join('')
}

async function renderPane(node: React.ReactNode): Promise<{
  rootNode: () => DOMElement
}> {
  const { stdin, stdout } = createStreams()
  const root = await createRoot({
    patchConsole: false,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  })

  mountedRoots.push({ root, stdin, stdout })
  root.render(node)

  await waitFor(
    () => getRootNode(stdout).childNodes.length > 0,
    'Pane did not mount',
  )

  return {
    rootNode: () => getRootNode(stdout),
  }
}

afterEach(() => {
  for (const { root, stdin, stdout } of mountedRoots.splice(0)) {
    root.unmount()
    stdin.end()
    stdout.end()
    instances.delete(stdout as unknown as NodeJS.WriteStream)
  }
})

describe('Pane coverage swarm row 221', () => {
  test('renders a top divider and padded content outside the modal slot', async () => {
    const rendered = await renderPane(
      <Pane color="permission">
        <Text>Outside child</Text>
      </Pane>,
    )
    const theme = getTheme('dark')
    const paneBox = requireElementChild(rendered.rootNode(), 0)
    const divider = requireElementChild(paneBox, 0)
    const content = requireElementChild(paneBox, 1)

    expect(paneBox.style).toMatchObject({
      flexDirection: 'column',
      paddingTop: 1,
    })
    expect(paneBox.childNodes).toHaveLength(2)
    expect(divider.nodeName).toBe('ink-text')
    expect(divider.textStyles).toMatchObject({ color: theme.permission })
    expect(collectText(divider)).toHaveLength(20)
    expect(content.style).toMatchObject({
      flexDirection: 'column',
      paddingX: 2,
    })
    expect(collectText(content)).toBe('Outside child')
  })

  test('suppresses the divider and uses modal padding inside the modal slot', async () => {
    const rendered = await renderPane(
      <ModalContext.Provider
        value={{
          columns: 20,
          rows: 10,
          scrollRef: { current: null },
        }}
      >
        <Pane color="permission">
          <Text>Modal child</Text>
        </Pane>
      </ModalContext.Provider>,
    )
    const modalBox = requireElementChild(rendered.rootNode(), 0)

    expect(modalBox.style).toMatchObject({
      flexDirection: 'column',
      flexShrink: 0,
      paddingX: 1,
    })
    expect(modalBox.style).not.toHaveProperty('paddingTop')
    expect(modalBox.childNodes).toHaveLength(1)
    expect(collectText(modalBox)).toBe('Modal child')
  })
})
