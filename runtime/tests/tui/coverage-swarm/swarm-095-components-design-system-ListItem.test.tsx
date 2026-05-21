import { PassThrough } from 'node:stream'

import figures from 'figures'
import React from 'react'
import { afterEach, describe, expect, test } from 'vitest'

import { ListItem } from '../../../src/tui/components/design-system/ListItem.js'
import type { DOMElement, DOMNode } from '../../../src/tui/ink/dom.js'
import instances from '../../../src/tui/ink/instances.js'
import { createRoot } from '../../../src/tui/ink/root.js'
import type { TextStyles } from '../../../src/tui/ink/styles.js'
import { Box, Text } from '../../../src/tui/ink.js'
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

type CursorDeclaration = {
  relativeX: number
  relativeY: number
  node: DOMElement
}

const mountedRoots: Array<{ root: TestRoot; stdin: TestStdin; stdout: PassThrough }> = []

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

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function getRootNode(stdout: PassThrough): DOMElement {
  const instance = instances.get(stdout as unknown as NodeJS.WriteStream)

  if (!instance?.rootNode) {
    throw new Error('Ink root node not found')
  }

  return instance.rootNode
}

function getCursorDeclaration(stdout: PassThrough): CursorDeclaration | null {
  const instance = instances.get(stdout as unknown as NodeJS.WriteStream) as
    | { cursorDeclaration?: CursorDeclaration | null }
    | undefined

  return instance?.cursorDeclaration ?? null
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

function findSegment(segments: StyledSegment[], text: string): StyledSegment {
  const segment = segments.find(entry => entry.text === text)
  expect(segment).toBeDefined()
  return segment!
}

async function renderListItem(node: React.ReactNode): Promise<{
  cursor: () => CursorDeclaration | null
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

  root.render(node)
  await sleep(30)

  return {
    cursor: () => getCursorDeclaration(stdout),
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
  }
})

describe('ListItem coverage swarm row 095', () => {
  test('renders focused selected content with description and active cursor declaration', async () => {
    const theme = getTheme('dark')
    const rendered = await renderListItem(
      <ListItem isFocused={true} isSelected={true} description="Extra details">
        Selected item
      </ListItem>,
    )
    const segments = rendered.segments()

    expect(segments.map(segment => segment.text)).toEqual([
      figures.pointer,
      'Selected item',
      figures.tick,
      'Extra details',
    ])
    expect(findSegment(segments, figures.pointer).styles).toMatchObject({
      color: theme.suggestion,
    })
    expect(findSegment(segments, 'Selected item').styles).toMatchObject({
      color: theme.success,
    })
    expect(findSegment(segments, figures.tick).styles).toMatchObject({
      color: theme.success,
    })
    expect(findSegment(segments, 'Extra details').styles).toMatchObject({
      color: theme.inactive,
    })
    expect(rendered.cursor()).toMatchObject({ relativeX: 0, relativeY: 0 })
  })

  test('suppresses indicators and cursor declaration for disabled selected items', async () => {
    const theme = getTheme('dark')
    const rendered = await renderListItem(
      <ListItem
        disabled={true}
        isFocused={true}
        isSelected={true}
        description="Disabled details"
      >
        Disabled choice
      </ListItem>,
    )
    const segments = rendered.segments()

    expect(rendered.text()).toContain('Disabled choice')
    expect(rendered.text()).toContain('Disabled details')
    expect(rendered.text()).not.toContain(figures.pointer)
    expect(rendered.text()).not.toContain(figures.tick)
    expect(findSegment(segments, 'Disabled choice').styles).toMatchObject({
      color: theme.inactive,
    })
    expect(findSegment(segments, 'Disabled details').styles).toMatchObject({
      color: theme.inactive,
    })
    expect(rendered.cursor()).toBeNull()
  })

  test('renders scroll affordances, default text, focused text, and unstyled children', async () => {
    const theme = getTheme('dark')
    const rendered = await renderListItem(
      <Box flexDirection="column">
        <ListItem isFocused={false} showScrollDown={true}>
          Down item
        </ListItem>
        <ListItem isFocused={false} showScrollUp={true}>
          Up item
        </ListItem>
        <ListItem isFocused={false}>Plain item</ListItem>
        <ListItem isFocused={true} declareCursor={false}>
          Focused item
        </ListItem>
        <ListItem isFocused={false} styled={false}>
          <Text color="warning">Custom child</Text>
        </ListItem>
      </Box>,
    )
    const segments = rendered.segments()

    expect(findSegment(segments, figures.arrowDown).styles).toMatchObject({
      color: theme.inactive,
    })
    expect(findSegment(segments, figures.arrowUp).styles).toMatchObject({
      color: theme.inactive,
    })
    expect(findSegment(segments, 'Plain item').styles.color).toBeUndefined()
    expect(findSegment(segments, 'Focused item').styles).toMatchObject({
      color: theme.suggestion,
    })
    expect(findSegment(segments, 'Custom child').styles).toMatchObject({
      color: theme.warning,
    })
    expect(rendered.cursor()).toBeNull()
  })
})
