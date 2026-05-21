import { PassThrough } from 'node:stream'

import React from 'react'
import { afterEach, describe, expect, test } from 'vitest'

import { Divider } from '../../../src/tui/components/design-system/Divider.js'
import type { DOMElement, DOMNode } from '../../../src/tui/ink/dom.js'
import instances from '../../../src/tui/ink/instances.js'
import { createRoot } from '../../../src/tui/ink/root.js'
import type { TextStyles } from '../../../src/tui/ink/styles.js'
import { getTheme } from '../../../src/utils/theme.js'

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

function createStreams(columns = 12): { stdin: TestStdin; stdout: PassThrough } {
  const stdin = new PassThrough() as TestStdin
  const stdout = new PassThrough()

  stdin.isTTY = true
  stdin.ref = () => {}
  stdin.setRawMode = () => {}
  stdin.unref = () => {}
  stdout.resume()
  ;(stdout as unknown as { columns: number }).columns = columns
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

async function renderDivider(
  node: React.ReactNode,
  columns?: number,
): Promise<{
  rerender: (next: React.ReactNode) => Promise<void>
  segments: () => StyledSegment[]
  text: () => string
}> {
  const { stdin, stdout } = createStreams(columns)
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

describe('Divider coverage swarm row 149', () => {
  test('rerenders the terminal-width divider through the cached untitled branch', async () => {
    const theme = getTheme('dark')
    const divider = <Divider char="*" padding={2} />
    const rendered = await renderDivider(divider, 8)

    expect(rendered.text()).toBe('******')
    expect(rendered.segments()).toEqual([
      { text: '******', styles: { color: theme.inactive } },
    ])

    await rendered.rerender(divider)

    expect(rendered.text()).toBe('******')
    expect(rendered.segments()).toEqual([
      { text: '******', styles: { color: theme.inactive } },
    ])
  })

  test('rerenders a colored titled divider through cached side and title branches', async () => {
    const theme = getTheme('dark')
    const divider = (
      <Divider
        char="-"
        color="suggestion"
        title={'\u001b[1mGo\u001b[22m'}
        width={8}
      />
    )
    const rendered = await renderDivider(divider)

    expect(rendered.text()).toBe('-- Go --')
    expect(rendered.segments()).toEqual([
      { text: '--', styles: { color: theme.suggestion } },
      { text: ' ', styles: { color: theme.suggestion } },
      { text: 'Go', styles: { color: theme.inactive, bold: true } },
      { text: ' ', styles: { color: theme.suggestion } },
      { text: '--', styles: { color: theme.suggestion } },
    ])

    await rendered.rerender(divider)

    expect(rendered.text()).toBe('-- Go --')
    expect(rendered.segments()).toEqual([
      { text: '--', styles: { color: theme.suggestion } },
      { text: ' ', styles: { color: theme.suggestion } },
      { text: 'Go', styles: { color: theme.inactive, bold: true } },
      { text: ' ', styles: { color: theme.suggestion } },
      { text: '--', styles: { color: theme.suggestion } },
    ])
  })
})
