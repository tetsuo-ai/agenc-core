import { PassThrough } from 'node:stream'

import React from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const keybindingMock = vi.hoisted(() => ({
  registrations: [] as Array<{
    handlers: Record<string, () => void>
    options: { context?: string; isActive?: boolean }
  }>,
}))

vi.mock('../../../src/tui/keybindings/useKeybinding.js', () => ({
  useKeybindings: (
    handlers: Record<string, () => void>,
    options: { context?: string; isActive?: boolean },
  ) => {
    keybindingMock.registrations.push({ handlers, options })
  },
}))

import {
  Tab,
  Tabs,
  useTabHeaderFocus,
  useTabsWidth,
} from '../../../src/tui/components/design-system/Tabs.js'
import { ModalContext } from '../../../src/tui/context/modalContext.js'
import type { DOMElement, DOMNode } from '../../../src/tui/ink/dom.js'
import instances from '../../../src/tui/ink/instances.js'
import { createRoot } from '../../../src/tui/ink/root.js'
import { Text } from '../../../src/tui/ink.js'
import type { ScrollBoxHandle } from '../../../src/tui/ink/components/ScrollBox.js'

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

  stdout.columns = 42
  stdout.rows = 12
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

function collectText(node: DOMNode): string {
  if (node.nodeName === '#text') return node.nodeValue

  return node.childNodes.map(collectText).join('')
}

function findKeyboardElement(node: DOMNode): DOMElement | undefined {
  if (node.nodeName !== '#text' && node._eventHandlers?.onKeyDown) {
    return node
  }

  for (const child of node.childNodes) {
    const found = findKeyboardElement(child)
    if (found) return found
  }

  return undefined
}

function findScrollBox(node: DOMNode): DOMElement | undefined {
  if (
    node.nodeName !== '#text' &&
    node.nodeName === 'ink-box' &&
    node.style.overflowX === 'scroll' &&
    node.style.overflowY === 'scroll'
  ) {
    return node
  }

  if (node.nodeName === '#text') return undefined

  for (const child of node.childNodes) {
    const found = findScrollBox(child)
    if (found) return found
  }

  return undefined
}

function latestActiveTabsRegistration(): {
  handlers: Record<string, () => void>
  options: { context?: string; isActive?: boolean }
} {
  const registration = keybindingMock.registrations
    .toReversed()
    .find(reg => reg.options.context === 'Tabs' && reg.options.isActive)

  if (!registration) {
    throw new Error('Expected active Tabs keybindings')
  }

  return registration
}

async function renderNode(node: React.ReactNode): Promise<MountedRoot> {
  const { stdin, stdout } = createStreams()
  const root = await createRoot({
    patchConsole: false,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  })

  const mounted = { root, stdin, stdout }
  mountedRoots.push(mounted)
  root.render(node)

  await waitFor(
    () => getRootNode(stdout).childNodes.length > 0,
    'Tabs test tree did not mount',
  )

  return mounted
}

function HeaderFocusProbe({ snapshots }: { snapshots: boolean[] }) {
  const { headerFocused } = useTabHeaderFocus()

  React.useEffect(() => {
    snapshots.push(headerFocused)
  }, [headerFocused, snapshots])

  return <Text>{`focus:${String(headerFocused)}`}</Text>
}

describe('Tabs coverage swarm row 139', () => {
  beforeEach(() => {
    keybindingMock.registrations = []
  })

  afterEach(() => {
    for (const { root, stdin, stdout } of mountedRoots.splice(0)) {
      root.unmount()
      stdin.end()
      stdout.end()
      instances.delete(stdout as unknown as NodeJS.WriteStream)
    }
  })

  test('falls back from unknown tab ids and keeps controlled navigation external', async () => {
    const rendered = await renderNode(
      <Tabs defaultTab="missing">
        <Tab title="Alpha">
          <Text>alpha content</Text>
        </Tab>
        <Tab id="beta" title="Beta">
          <Text>beta content</Text>
        </Tab>
      </Tabs>,
    )

    expect(collectText(getRootNode(rendered.stdout))).toContain('alpha content')
    expect(collectText(getRootNode(rendered.stdout))).not.toContain(
      'beta content',
    )

    latestActiveTabsRegistration().handlers['tabs:next']()
    await waitFor(
      () => collectText(getRootNode(rendered.stdout)).includes('beta content'),
      'uncontrolled next navigation did not select the second tab',
    )

    const onTabChange = vi.fn()
    keybindingMock.registrations = []
    rendered.root.render(
      <Tabs selectedTab="missing" onTabChange={onTabChange}>
        <Tab id="first" title="First">
          <Text>controlled first</Text>
        </Tab>
        <Tab id="second" title="Second">
          <Text>controlled second</Text>
        </Tab>
      </Tabs>,
    )

    await waitFor(
      () => collectText(getRootNode(rendered.stdout)).includes('controlled first'),
      'controlled fallback did not render the first tab',
    )

    latestActiveTabsRegistration().handlers['tabs:previous']()
    expect(onTabChange).toHaveBeenCalledWith('second')
    expect(collectText(getRootNode(rendered.stdout))).not.toContain(
      'controlled second',
    )
  })

  test('ignores non-down header key events and blurs only opted-in content on down', async () => {
    const snapshots: boolean[] = []
    const rendered = await renderNode(
      <Tabs color="permission">
        <Tab id="first" title="First">
          <HeaderFocusProbe snapshots={snapshots} />
        </Tab>
        <Tab id="second" title="Second">
          <Text>second content</Text>
        </Tab>
      </Tabs>,
    )

    await waitFor(
      () => snapshots.includes(true),
      'header focus probe did not report initial focus',
    )

    const keyboardElement = findKeyboardElement(getRootNode(rendered.stdout))
    expect(keyboardElement).toBeDefined()

    const nonDownPreventDefault = vi.fn()
    keyboardElement?._eventHandlers?.onKeyDown?.({
      key: 'up',
      preventDefault: nonDownPreventDefault,
    } as never)
    await sleep(20)

    expect(nonDownPreventDefault).not.toHaveBeenCalled()
    expect(snapshots.at(-1)).toBe(true)

    const downPreventDefault = vi.fn()
    keyboardElement?._eventHandlers?.onKeyDown?.({
      key: 'down',
      preventDefault: downPreventDefault,
    } as never)

    await waitFor(
      () => snapshots.includes(false),
      'down key did not hand focus to opted-in tab content',
    )
    expect(downPreventDefault).toHaveBeenCalledTimes(1)
  })

  test('provides stable hook defaults outside a Tabs provider', async () => {
    let captured:
      | {
          blurHeader: () => void
          focusHeader: () => void
          headerFocused: boolean
          width: number | undefined
        }
      | undefined

    function OutsideProbe() {
      const focus = useTabHeaderFocus()
      const width = useTabsWidth()

      React.useEffect(() => {
        captured = { ...focus, width }
      }, [focus, width])

      return <Text>{`outside:${String(focus.headerFocused)}:${String(width)}`}</Text>
    }

    const rendered = await renderNode(<OutsideProbe />)

    await waitFor(
      () => captured !== undefined,
      'outside Tabs hook defaults were not captured',
    )

    expect(collectText(getRootNode(rendered.stdout))).toContain(
      'outside:false:undefined',
    )
    expect(captured?.headerFocused).toBe(false)
    expect(captured?.width).toBeUndefined()
    expect(() => captured?.blurHeader()).not.toThrow()
    expect(() => captured?.focusHeader()).not.toThrow()
  })

  test('uses the modal scroll ref path and modal tab content layout', async () => {
    const scrollRef = React.createRef<ScrollBoxHandle>()
    const rendered = await renderNode(
      <ModalContext.Provider
        value={{ columns: 30, rows: 8, scrollRef }}
      >
        <Tabs hidden useFullWidth defaultTab="modal">
          <Tab id="modal" title="Modal">
            <Text>modal content</Text>
          </Tab>
          <Tab id="other" title="Other">
            <Text>other content</Text>
          </Tab>
        </Tabs>
      </ModalContext.Provider>,
    )

    await waitFor(
      () => scrollRef.current !== null,
      'Tabs did not attach the modal scroll ref',
    )

    const rootNode = getRootNode(rendered.stdout)
    const scrollBox = findScrollBox(rootNode)

    expect(collectText(rootNode)).toContain('modal content')
    expect(collectText(rootNode)).not.toContain('other content')
    expect(collectText(rootNode)).not.toContain('Modal')
    expect(scrollBox).toBeDefined()
    expect(scrollBox?.style.flexShrink).toBe(0)
    expect(scrollRef.current?.getScrollTop()).toBe(0)
  })
})
