import { PassThrough } from 'node:stream'

import React, { act } from 'react'
import { describe, expect, test } from 'vitest'

import {
  TerminalSizeContext,
  type TerminalSize,
} from '../../../src/tui/ink/components/TerminalSizeContext.js'
import type { DOMElement } from '../../../src/tui/ink/dom.js'
import { useTerminalViewport } from '../../../src/tui/ink/hooks/use-terminal-viewport.js'
import { createRoot, type Root } from '../../../src/tui/ink/root.js'

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

type LayoutNodeStub = {
  readonly getComputedHeight: () => number
  readonly getComputedTop: () => number
}

type ElementOptions = {
  readonly height: number
  readonly parentNode?: DOMElement
  readonly scrollTop?: number
  readonly top: number
  readonly withYoga?: boolean
}

type HookSnapshot = {
  readonly entry: { readonly isVisible: boolean }
  readonly ref: (element: DOMElement | null) => void
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

function createElement({
  height,
  parentNode,
  scrollTop,
  top,
  withYoga = true,
}: ElementOptions): DOMElement {
  const yogaNode: LayoutNodeStub | undefined = withYoga
    ? {
        getComputedHeight: () => height,
        getComputedTop: () => top,
      }
    : undefined

  return {
    attributes: {},
    childNodes: [],
    dirty: false,
    nodeName: 'ink-box',
    parentNode,
    scrollTop,
    style: {},
    yogaNode,
  } as unknown as DOMElement
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
}

async function renderHookHarness(): Promise<{
  readonly dispose: () => Promise<void>
  readonly latest: () => HookSnapshot
  readonly render: (props: {
    readonly element: DOMElement | null
    readonly terminalSize: TerminalSize | null
  }) => Promise<void>
  readonly renderSettled: (props: {
    readonly element: DOMElement | null
    readonly terminalSize: TerminalSize | null
  }) => Promise<HookSnapshot>
}> {
  let latest: HookSnapshot | undefined
  const { stdin, stdout } = createStreams()
  const root: Root = await createRoot({
    patchConsole: false,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  })

  function ViewportProbe({
    element,
  }: {
    readonly element: DOMElement | null
  }): null {
    const [ref, entry] = useTerminalViewport()
    ref(element)
    latest = { entry, ref }
    return null
  }

  async function render(props: {
    readonly element: DOMElement | null
    readonly terminalSize: TerminalSize | null
  }): Promise<void> {
    await act(async () => {
      root.render(
        React.createElement(
          TerminalSizeContext.Provider,
          { value: props.terminalSize },
          React.createElement(ViewportProbe, { element: props.element }),
        ),
      )
    })
    await flushEffects()
  }

  return {
    dispose: async () => {
      root.unmount()
      stdin.end()
      stdout.end()
      await flushEffects()
    },
    latest: () => {
      if (latest === undefined) throw new Error('hook did not render')
      return latest
    },
    render,
    renderSettled: async props => {
      await render(props)
      await render(props)
      if (latest === undefined) throw new Error('hook did not render')
      return latest
    },
  }
}

describe('useTerminalViewport coverage swarm row 195', () => {
  test('keeps the default visible entry when layout data is unavailable', async () => {
    const rendered = await renderHookHarness()
    const missingYoga = createElement({
      height: 1,
      top: 100,
      withYoga: false,
    })

    try {
      expect(
        (
          await rendered.renderSettled({
            element: null,
            terminalSize: { columns: 80, rows: 5 },
          })
        ).entry.isVisible,
      ).toBe(true)

      expect(
        (
          await rendered.renderSettled({
            element: missingYoga,
            terminalSize: { columns: 80, rows: 5 },
          })
        ).entry.isVisible,
      ).toBe(true)

      expect(
        (
          await rendered.renderSettled({
            element: createElement({ height: 1, top: 100 }),
            terminalSize: null,
          })
        ).entry.isVisible,
      ).toBe(true)
    } finally {
      await rendered.dispose()
    }
  })

  test('matches the cursor-restore viewport boundary when content overflows rows', async () => {
    const rendered = await renderHookHarness()
    const root = createElement({ height: 30, top: 0 })
    const boundaryElement = createElement({
      height: 1,
      parentNode: root,
      top: 20,
    })

    try {
      expect(
        (
          await rendered.renderSettled({
            element: boundaryElement,
            terminalSize: { columns: 80, rows: 10 },
          })
        ).entry.isVisible,
      ).toBe(false)

      expect(
        (
          await rendered.renderSettled({
            element: boundaryElement,
            terminalSize: { columns: 80, rows: 11 },
          })
        ).entry.isVisible,
      ).toBe(true)
    } finally {
      await rendered.dispose()
    }
  })

  test('subtracts ancestor scroll offsets when deciding visibility', async () => {
    const rendered = await renderHookHarness()
    const scrollContainer = createElement({
      height: 30,
      scrollTop: 10,
      top: 0,
    })
    const scrolledIntoView = createElement({
      height: 1,
      parentNode: scrollContainer,
      top: 35,
    })

    try {
      expect(
        (
          await rendered.renderSettled({
            element: scrolledIntoView,
            terminalSize: { columns: 80, rows: 10 },
          })
        ).entry.isVisible,
      ).toBe(true)
    } finally {
      await rendered.dispose()
    }
  })
})
