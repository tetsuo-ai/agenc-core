import { PassThrough } from 'node:stream'

import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const fixture = vi.hoisted(() => {
  const viewportElements: unknown[] = []

  return {
    isVisible: true,
    measureElement: vi.fn(() => ({ height: 1, width: 1 })),
    rows: 24,
    viewportElements,
    viewportRef: vi.fn((element: unknown) => {
      viewportElements.push(element)
    }),
  }
})

vi.mock('../../../src/tui/hooks/useTerminalSize.js', () => ({
  useTerminalSize: () => ({
    columns: 80,
    rows: fixture.rows,
  }),
}))

vi.mock('../../../src/tui/ink/hooks/use-terminal-viewport.js', () => ({
  useTerminalViewport: () => [
    fixture.viewportRef,
    { isVisible: fixture.isVisible },
  ],
}))

vi.mock('../../../src/tui/ink.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../src/tui/ink.js')>()

  return {
    ...actual,
    measureElement: fixture.measureElement,
  }
})

import { Ratchet } from '../../../src/tui/components/design-system/Ratchet.js'
import type { DOMElement } from '../../../src/tui/ink/dom.js'
import instances from '../../../src/tui/ink/instances.js'
import { Box, createRoot, Text, type Root } from '../../../src/tui/ink.js'

type TestStreams = {
  readonly stdin: PassThrough & {
    isTTY: boolean
    ref: () => void
    setRawMode: (mode: boolean) => void
    unref: () => void
  }
  readonly stdout: PassThrough & {
    columns: number
    isTTY: boolean
    rows: number
  }
}

type RenderedRatchet = {
  readonly dispose: () => Promise<void>
  readonly outer: () => DOMElement
  readonly render: (node: React.ReactNode) => Promise<void>
}

function createStreams(): TestStreams {
  const stdin = new PassThrough() as TestStreams['stdin']
  const stdout = new PassThrough() as TestStreams['stdout']

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

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
}

function getRootNode(stdout: TestStreams['stdout']): DOMElement {
  const instance = instances.get(stdout as unknown as NodeJS.WriteStream)

  if (!instance?.rootNode) {
    throw new Error('Ink root node not found')
  }

  return instance.rootNode
}

function onlyElementChild(node: DOMElement, label: string): DOMElement {
  const children = node.childNodes.filter(
    (child): child is DOMElement => child.nodeName !== '#text',
  )

  expect(children, label).toHaveLength(1)
  return children[0]!
}

async function renderRatchet(node: React.ReactNode): Promise<RenderedRatchet> {
  const { stdin, stdout } = createStreams()
  const root: Root = await createRoot({
    patchConsole: false,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  })

  async function render(nextNode: React.ReactNode): Promise<void> {
    await act(async () => {
      root.render(nextNode)
    })
    await flushEffects()
  }

  await render(node)

  return {
    dispose: async () => {
      root.unmount()
      stdin.end()
      stdout.end()
      await flushEffects()
    },
    outer: () => onlyElementChild(getRootNode(stdout), 'ratchet outer box'),
    render,
  }
}

function content(label: string): React.ReactNode {
  return (
    <Box flexDirection="column">
      <Text>{label}</Text>
    </Box>
  )
}

describe('Ratchet coverage swarm row 236', () => {
  beforeEach(() => {
    fixture.isVisible = true
    fixture.measureElement.mockReset()
    fixture.measureElement.mockReturnValue({ height: 1, width: 1 })
    fixture.rows = 24
    fixture.viewportElements.length = 0
    fixture.viewportRef.mockClear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  test('default lock holds the measured height but caps it at terminal rows', async () => {
    fixture.rows = 5
    fixture.measureElement.mockReturnValue({ height: 8, width: 20 })

    const rendered = await renderRatchet(<Ratchet>{content('tall')}</Ratchet>)

    try {
      const outer = rendered.outer()
      const inner = onlyElementChild(outer, 'ratchet inner box')

      expect(fixture.measureElement).toHaveBeenCalledWith(inner)
      expect(outer.style.minHeight).toBe(5)
      expect(fixture.viewportRef).toHaveBeenCalledWith(outer)
    } finally {
      await rendered.dispose()
    }
  })

  test('offscreen lock stores height while visible and engages it when hidden', async () => {
    fixture.rows = 20
    fixture.measureElement.mockReturnValue({ height: 6, width: 10 })

    const rendered = await renderRatchet(
      <Ratchet lock="offscreen">{content('visible')}</Ratchet>,
    )

    try {
      expect(rendered.outer().style.minHeight).toBeUndefined()

      fixture.isVisible = false
      await rendered.render(
        <Ratchet lock="offscreen">{content('hidden')}</Ratchet>,
      )

      expect(rendered.outer().style.minHeight).toBe(6)
    } finally {
      await rendered.dispose()
    }
  })

  test('keeps the largest measured height across later shorter renders', async () => {
    fixture.rows = 20
    fixture.measureElement
      .mockReturnValueOnce({ height: 7, width: 10 })
      .mockReturnValueOnce({ height: 3, width: 10 })

    const rendered = await renderRatchet(
      <Ratchet>{content('initial height')}</Ratchet>,
    )

    try {
      expect(rendered.outer().style.minHeight).toBe(7)

      await rendered.render(<Ratchet>{content('shorter height')}</Ratchet>)

      expect(rendered.outer().style.minHeight).toBe(7)
      expect(fixture.measureElement.mock.calls.length).toBeGreaterThanOrEqual(2)
    } finally {
      await rendered.dispose()
    }
  })
})
