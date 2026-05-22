import { PassThrough } from 'node:stream'

import React from 'react'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { Byline } from '../../../src/tui/components/design-system/Byline.js'
import type { DOMElement, DOMNode } from '../../../src/tui/ink/dom.js'
import instances from '../../../src/tui/ink/instances.js'
import { createRoot } from '../../../src/tui/ink/root.js'
import type { TextStyles } from '../../../src/tui/ink/styles.js'
import { Text } from '../../../src/tui/ink.js'
import { selectAgenCTuiGlyphs } from '../../../src/tui/glyphs.js'
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

type TestRoot = Awaited<ReturnType<typeof createRoot>>

type StyledSegment = {
  text: string
  styles: TextStyles
}

const mountedRoots: Array<{
  root: TestRoot
  stdin: TestStdin
  stdout: TestStdout
}> = []

let originalGlyphMode: string | undefined

function createStreams(): { stdin: TestStdin; stdout: TestStdout } {
  const stdin = new PassThrough() as TestStdin
  const stdout = new PassThrough() as TestStdout

  stdin.isTTY = true
  stdin.ref = () => {}
  stdin.setRawMode = () => {}
  stdin.unref = () => {}

  stdout.columns = 80
  stdout.rows = 24
  stdout.isTTY = true
  stdout.resume()

  return { stdin, stdout }
}

function sleep(ms = 30): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function getRootNode(stdout: TestStdout): DOMElement {
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

async function renderByline(node: React.ReactNode): Promise<{
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
  await sleep()

  return {
    segments: () => collectSegments(getRootNode(stdout)),
    text: () =>
      collectSegments(getRootNode(stdout))
        .map(segment => segment.text)
        .join(''),
  }
}

beforeEach(() => {
  originalGlyphMode = process.env.AGENC_TUI_GLYPHS
  delete process.env.AGENC_TUI_GLYPHS
})

afterEach(() => {
  for (const { root, stdin, stdout } of mountedRoots.splice(0)) {
    root.unmount()
    stdin.end()
    stdout.end()
    instances.delete(stdout as unknown as NodeJS.WriteStream)
  }

  if (originalGlyphMode === undefined) {
    delete process.env.AGENC_TUI_GLYPHS
  } else {
    process.env.AGENC_TUI_GLYPHS = originalGlyphMode
  }
})

describe('Byline coverage swarm row 148', () => {
  test('renders nothing when every child is filtered out by React children traversal', async () => {
    const rendered = await renderByline(
      <Byline>
        {null}
        {false}
        {undefined}
      </Byline>,
    )

    expect(rendered.text()).toBe('')
    expect(rendered.segments()).toEqual([])
  })

  test('joins element children with a dim unicode separator', async () => {
    const separator = selectAgenCTuiGlyphs({
      AGENC_TUI_GLYPHS: 'unicode',
    }).separator
    const separatorStyles = { color: getTheme('dark').inactive }
    const rendered = await renderByline(
      <Byline>
        <Text>Alpha</Text>
        <Text>Beta</Text>
        <Text>Gamma</Text>
      </Byline>,
    )

    expect(rendered.text()).toBe(
      `Alpha ${separator} Beta ${separator} Gamma`,
    )
    expect(rendered.segments()).toEqual([
      { text: 'Alpha', styles: {} },
      { text: ` ${separator} `, styles: separatorStyles },
      { text: 'Beta', styles: {} },
      { text: ` ${separator} `, styles: separatorStyles },
      { text: 'Gamma', styles: {} },
    ])
  })

  test('uses the ascii separator and supports primitive children', async () => {
    process.env.AGENC_TUI_GLYPHS = 'ascii'

    const separator = selectAgenCTuiGlyphs({
      AGENC_TUI_GLYPHS: 'ascii',
    }).separator
    const separatorStyles = { color: getTheme('dark').inactive }
    const rendered = await renderByline(
      <Byline>
        <Text>Element child</Text>
        primitive child
      </Byline>,
    )

    expect(rendered.text()).toBe(
      `Element child ${separator} primitive child`,
    )
    expect(rendered.segments()).toEqual([
      { text: 'Element child', styles: {} },
      { text: ` ${separator} `, styles: separatorStyles },
      { text: 'primitive child', styles: {} },
    ])
  })
})
