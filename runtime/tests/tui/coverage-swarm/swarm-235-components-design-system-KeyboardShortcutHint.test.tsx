import { PassThrough } from 'node:stream'

import React from 'react'
import { afterEach, describe, expect, test } from 'vitest'

import { KeyboardShortcutHint } from '../../../src/tui/components/design-system/KeyboardShortcutHint.js'
import type { DOMElement, DOMNode } from '../../../src/tui/ink/dom.js'
import instances from '../../../src/tui/ink/instances.js'
import { createRoot } from '../../../src/tui/ink/root.js'
import type { TextStyles } from '../../../src/tui/ink/styles.js'

type TestStdin = PassThrough & {
  isTTY: boolean
  ref: () => void
  setRawMode: (mode: boolean) => void
  unref: () => void
}

type TestRoot = Awaited<ReturnType<typeof createRoot>>

type StyledSegment = {
  text: string
  styles: TextStyles
}

const mountedRoots: Array<{
  root: TestRoot
  stdin: TestStdin
  stdout: PassThrough
}> = []

function createStreams(): { stdin: TestStdin; stdout: PassThrough } {
  const stdin = new PassThrough() as TestStdin
  const stdout = new PassThrough()

  stdin.isTTY = true
  stdin.ref = () => {}
  stdin.setRawMode = () => {}
  stdin.unref = () => {}
  stdout.resume()
  ;(stdout as unknown as { columns: number }).columns = 80
  ;(stdout as unknown as { rows: number }).rows = 24
  ;(stdout as unknown as { isTTY: boolean }).isTTY = true

  return { stdin, stdout }
}

function sleep(ms = 30): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function getRootNode(stdout: PassThrough): DOMElement {
  const instance = instances.get(stdout as unknown as NodeJS.WriteStream)

  if (!instance?.rootNode) {
    throw new Error('Ink root node not found')
  }

  return instance.rootNode
}

function collectSegments(
  node: DOMNode,
  inheritedStyles: TextStyles = {},
  segments: StyledSegment[] = [],
): StyledSegment[] {
  if (node.nodeName === '#text') {
    if (node.nodeValue !== '') {
      segments.push({ text: node.nodeValue, styles: inheritedStyles })
    }
    return segments
  }

  const nextStyles = node.textStyles
    ? { ...inheritedStyles, ...node.textStyles }
    : inheritedStyles

  for (const child of node.childNodes) {
    collectSegments(child, nextStyles, segments)
  }

  return segments
}

async function renderHint(
  node: React.ReactNode,
): Promise<{
  rerender: (next: React.ReactNode) => Promise<void>
  segments: () => StyledSegment[]
  text: () => string
}> {
  const { stdin, stdout } = createStreams()
  const root = await createRoot({
    patchConsole: false,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  })
  mountedRoots.push({ root, stdin, stdout })

  const rerender = async (next: React.ReactNode) => {
    root.render(next)
    await sleep()
  }

  await rerender(node)

  return {
    rerender,
    segments: () => collectSegments(getRootNode(stdout)),
    text: () =>
      collectSegments(getRootNode(stdout))
        .map(segment => segment.text)
        .join(''),
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

describe('KeyboardShortcutHint coverage swarm row 235', () => {
  test('renders the default shortcut action hint and reuses the cached non-parenthesized output', async () => {
    const hint = (
      <KeyboardShortcutHint shortcut="ctrl+o" action="expand" />
    )
    const rendered = await renderHint(hint)

    expect(rendered.text()).toBe('ctrl+o to expand')
    expect(rendered.segments()).toEqual([
      { text: 'ctrl+o', styles: {} },
      { text: ' to ', styles: {} },
      { text: 'expand', styles: {} },
    ])

    await rendered.rerender(hint)

    expect(rendered.text()).toBe('ctrl+o to expand')
    expect(rendered.segments()).toEqual([
      { text: 'ctrl+o', styles: {} },
      { text: ' to ', styles: {} },
      { text: 'expand', styles: {} },
    ])
  })

  test('wraps hints in parentheses and reuses the cached parenthesized output', async () => {
    const hint = (
      <KeyboardShortcutHint shortcut="tab" action="toggle" parens={true} />
    )
    const rendered = await renderHint(hint)

    expect(rendered.text()).toBe('(tab to toggle)')
    expect(rendered.segments()).toEqual([
      { text: '(', styles: {} },
      { text: 'tab', styles: {} },
      { text: ' to ', styles: {} },
      { text: 'toggle', styles: {} },
      { text: ')', styles: {} },
    ])

    await rendered.rerender(hint)

    expect(rendered.text()).toBe('(tab to toggle)')
  })

  test('applies bold styling only to the shortcut segment', async () => {
    const rendered = await renderHint(
      <KeyboardShortcutHint shortcut="Enter" action="confirm" bold={true} />,
    )

    expect(rendered.text()).toBe('Enter to confirm')
    expect(rendered.segments()).toEqual([
      { text: 'Enter', styles: { bold: true } },
      { text: ' to ', styles: {} },
      { text: 'confirm', styles: {} },
    ])
  })
})
