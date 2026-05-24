import { PassThrough } from 'node:stream'

import React from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  feature: vi.fn(() => false),
  getGlobalConfig: vi.fn(() => ({ theme: 'dark' })),
  getSystemThemeName: vi.fn(() => 'dark'),
  saveGlobalConfig: vi.fn(),
}))

vi.mock('bun:bundle', () => ({
  feature: mocks.feature,
}))

vi.mock('../../../src/utils/config.js', () => ({
  getGlobalConfig: mocks.getGlobalConfig,
  saveGlobalConfig: mocks.saveGlobalConfig,
}))

vi.mock('../../../src/utils/systemTheme.js', () => ({
  getSystemThemeName: mocks.getSystemThemeName,
}))

import ThemedText, {
  TextHoverColorContext,
} from '../../../src/tui/components/design-system/ThemedText.js'
import { ThemeProvider } from '../../../src/tui/components/design-system/ThemeProvider.js'
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

function collectTextElements(
  node: DOMNode,
  elements: DOMElement[] = [],
): DOMElement[] {
  if (node.nodeName === '#text') {
    return elements
  }

  if (node.nodeName === 'ink-text') {
    elements.push(node)
  }

  for (const child of node.childNodes) {
    collectTextElements(child, elements)
  }

  return elements
}

function findSegment(segments: StyledSegment[], text: string): StyledSegment {
  const segment = segments.find(entry => entry.text === text)
  expect(segment).toBeDefined()
  return segment!
}

async function renderText(node: React.ReactNode): Promise<{
  rerender: (next: React.ReactNode) => Promise<void>
  segments: () => StyledSegment[]
  textElements: () => DOMElement[]
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
    textElements: () => collectTextElements(getRootNode(stdout)),
  }
}

afterEach(() => {
  for (const { root, stdin, stdout } of mountedRoots.splice(0)) {
    root.unmount()
    stdin.end()
    stdout.end()
    instances.delete(stdout as unknown as NodeJS.WriteStream)
  }
  vi.clearAllMocks()
})

describe('ThemedText coverage swarm row 245', () => {
  test('resolves theme foreground and background colors from the active provider theme', async () => {
    const theme = getTheme('light')
    const text = (
      <ThemeProvider initialState="light">
        <ThemedText
          color="success"
          backgroundColor="background"
          bold={true}
          italic={true}
          underline={true}
          strikethrough={true}
          inverse={true}
          wrap="truncate-end"
        >
          Styled
        </ThemedText>
      </ThemeProvider>
    )
    const rendered = await renderText(text)

    expect(rendered.segments()).toEqual([
      {
        text: 'Styled',
        styles: {
          backgroundColor: theme.background,
          bold: true,
          color: theme.success,
          inverse: true,
          italic: true,
          strikethrough: true,
          underline: true,
        },
      },
    ])
    expect(rendered.textElements()[0]?.style).toMatchObject({
      textWrap: 'truncate-end',
    })

    await rendered.rerender(
      <ThemeProvider initialState="light">
        <ThemedText
          color="success"
          backgroundColor="background"
          bold={true}
          italic={true}
          underline={true}
          strikethrough={true}
          inverse={true}
          wrap="truncate-end"
        >
          Styled
        </ThemedText>
      </ThemeProvider>,
    )

    expect(rendered.segments()).toHaveLength(1)
  })

  test('passes raw color formats through without resolving them as theme keys', async () => {
    const rendered = await renderText(
      <>
        <ThemedText color="rgb(1,2,3)">rgb</ThemedText>
        <ThemedText color="#123abc">hex</ThemedText>
        <ThemedText color="ansi256(42)">ansi256</ThemedText>
        <ThemedText color="ansi:yellow">ansi</ThemedText>
      </>,
    )
    const segments = rendered.segments()

    expect(findSegment(segments, 'rgb').styles.color).toBe('rgb(1,2,3)')
    expect(findSegment(segments, 'hex').styles.color).toBe('#123abc')
    expect(findSegment(segments, 'ansi256').styles.color).toBe('ansi256(42)')
    expect(findSegment(segments, 'ansi').styles.color).toBe('ansi:yellow')
  })

  test('maps legacy gray foreground names to the inactive theme color', async () => {
    const theme = getTheme('dark')
    const rendered = await renderText(
      <>
        <ThemedText color="gray">gray</ThemedText>
        <ThemedText color="grey">grey</ThemedText>
      </>,
    )
    const segments = rendered.segments()

    expect(findSegment(segments, 'gray').styles.color).toBe(theme.inactive)
    expect(findSegment(segments, 'grey').styles.color).toBe(theme.inactive)
  })

  test('uses hover context for uncolored text and inactive color for dimmed text', async () => {
    const theme = getTheme('dark')
    const rendered = await renderText(
      <>
        <TextHoverColorContext.Provider value="warning">
          <ThemedText>Hovered</ThemedText>
          <ThemedText color="success">Explicit</ThemedText>
        </TextHoverColorContext.Provider>
        <ThemedText dimColor={true}>Dimmed</ThemedText>
        <ThemedText>Plain</ThemedText>
      </>,
    )
    const segments = rendered.segments()

    expect(findSegment(segments, 'Hovered').styles.color).toBe(theme.warning)
    expect(findSegment(segments, 'Explicit').styles.color).toBe(theme.success)
    expect(findSegment(segments, 'Dimmed').styles.color).toBe(theme.inactive)
    expect(findSegment(segments, 'Plain').styles.color).toBeUndefined()
  })
})
