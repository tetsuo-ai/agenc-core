import { PassThrough } from 'node:stream'

import React from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'

import type { ScrollBoxHandle } from '../../../src/tui/ink/components/ScrollBox.js'
import type { DOMElement } from '../../../src/tui/ink/dom.js'
import { createRoot } from '../../../src/tui/ink/root.js'
import {
  type VirtualScrollResult,
  useVirtualScroll,
} from '../../../src/tui/hooks/useVirtualScroll.js'

type ClampCall = readonly [number | undefined, number | undefined]

class FakeScrollBox implements ScrollBoxHandle {
  readonly clampCalls: ClampCall[] = []
  readonly listeners = new Set<() => void>()
  readonly scrollToCalls: number[] = []
  pendingDelta = 0
  scrollTop = 0
  sticky = false
  viewportHeight = 20

  scrollTo(y: number): void {
    this.scrollToCalls.push(y)
    this.scrollTop = Math.max(0, Math.floor(y))
    this.pendingDelta = 0
    this.sticky = false
    this.emit()
  }

  scrollBy(dy: number): void {
    this.pendingDelta += Math.floor(dy)
    this.sticky = false
    this.emit()
  }

  scrollToElement(): void {
    this.sticky = false
    this.emit()
  }

  scrollToBottom(): void {
    this.pendingDelta = 0
    this.sticky = true
    this.emit()
  }

  getScrollTop(): number {
    return this.scrollTop
  }

  getPendingDelta(): number {
    return this.pendingDelta
  }

  getScrollHeight(): number {
    return 0
  }

  getFreshScrollHeight(): number {
    return 0
  }

  getViewportHeight(): number {
    return this.viewportHeight
  }

  getViewportTop(): number {
    return 0
  }

  isSticky(): boolean {
    return this.sticky
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  setClampBounds(min: number | undefined, max: number | undefined): void {
    this.clampCalls.push([min, max])
  }

  emit(): void {
    for (const listener of this.listeners) listener()
  }
}

function createStreams(): {
  readonly stdout: PassThrough
  readonly stdin: PassThrough & {
    isTTY: boolean
    ref: () => void
    setRawMode: (mode: boolean) => void
    unref: () => void
  }
} {
  const stdout = new PassThrough()
  stdout.resume()

  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean
    ref: () => void
    setRawMode: (mode: boolean) => void
    unref: () => void
  }
  stdin.isTTY = true
  stdin.ref = () => {}
  stdin.setRawMode = () => {}
  stdin.unref = () => {}

  return { stdin, stdout }
}

function fakeElement(height: number, top: number, width = 10): DOMElement {
  return {
    yogaNode: {
      getComputedHeight: () => height,
      getComputedTop: () => top,
      getComputedWidth: () => width,
    },
  } as DOMElement
}

function makeKeys(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `item-${index}`)
}

function sleep(ms = 25): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown
  for (let i = 0; i < 30; i++) {
    try {
      assertion()
      return
    } catch (error) {
      lastError = error
      await sleep()
    }
  }
  throw lastError
}

async function renderHookHarness(initial: {
  columns?: number
  itemKeys: readonly string[]
  scrollRef: React.RefObject<ScrollBoxHandle | null>
}): Promise<{
  readonly dispose: () => Promise<void>
  readonly latest: () => VirtualScrollResult
  readonly render: (next?: Partial<typeof initial>) => Promise<void>
}> {
  let props = {
    columns: 80,
    ...initial,
  }
  let latest: VirtualScrollResult | undefined
  const { stdin, stdout } = createStreams()
  const root = await createRoot({
    patchConsole: false,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  })

  function Harness(): null {
    latest = useVirtualScroll(props.scrollRef, props.itemKeys, props.columns)
    return null
  }

  async function render(next: Partial<typeof initial> = {}): Promise<void> {
    props = { ...props, ...next }
    root.render(React.createElement(Harness))
    await sleep()
  }

  await render()
  return {
    dispose: async () => {
      root.unmount()
      stdin.end()
      stdout.end()
      await sleep()
    },
    latest: () => {
      if (latest === undefined) throw new Error('hook did not render')
      return latest
    },
    render,
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useVirtualScroll coverage swarm 182', () => {
  test('uses pending target notifications when sticky scrolling breaks', async () => {
    const scroll = new FakeScrollBox()
    scroll.sticky = true
    const rendered = await renderHookHarness({
      itemKeys: makeKeys(200),
      scrollRef: { current: scroll },
    })

    try {
      expect(rendered.latest().range[1]).toBe(200)
      expect(scroll.clampCalls.at(-1)).toEqual([undefined, undefined])

      scroll.sticky = false
      scroll.pendingDelta = 160
      scroll.emit()

      await waitFor(() => {
        expect(rendered.latest().range[1]).toBeLessThan(200)
      })
      expect(rendered.latest().range[0]).toBeGreaterThanOrEqual(0)
      expect(scroll.clampCalls.at(-1)?.[0]).toBeGreaterThanOrEqual(0)
      expect(scroll.clampCalls.at(-1)?.[1]).toBeGreaterThan(0)
    } finally {
      await rendered.dispose()
    }
  })

  test('clamps a frozen resize range when the item list shrinks', async () => {
    const scroll = new FakeScrollBox()
    scroll.scrollTop = 900
    const keys = makeKeys(500)
    const rendered = await renderHookHarness({
      itemKeys: keys,
      scrollRef: { current: scroll },
    })

    try {
      expect(rendered.latest().range[0]).toBeGreaterThan(3)

      await rendered.render({ columns: 40, itemKeys: keys.slice(0, 3) })
      expect(rendered.latest().range).toEqual([3, 3])
      expect(rendered.latest().bottomSpacer).toBe(0)
      expect(scroll.clampCalls.at(-1)).toEqual([9, Infinity])

      await rendered.render()
      expect(rendered.latest().range).toEqual([0, 3])
    } finally {
      await rendered.dispose()
    }
  })

  test('skips zero-height measurements until Yoga has a real width', async () => {
    const scroll = new FakeScrollBox()
    scroll.sticky = true
    const rendered = await renderHookHarness({
      itemKeys: ['zero-width', 'empty', 'missing-yoga'],
      scrollRef: { current: scroll },
    })

    try {
      rendered.latest().measureRef('zero-width')(fakeElement(0, 5, 0))
      rendered.latest().measureRef('empty')(fakeElement(0, 6))
      rendered.latest().measureRef('missing-yoga')({} as DOMElement)

      await rendered.render()

      expect(rendered.latest().getItemHeight(0)).toBeUndefined()
      expect(rendered.latest().getItemTop(0)).toBe(-1)
      expect(rendered.latest().getItemHeight(1)).toBe(0)
      expect(rendered.latest().getItemTop(2)).toBe(-1)
    } finally {
      await rendered.dispose()
    }
  })

  test('leaves tail clamp unbounded and uses list origin for index seeks', async () => {
    const scroll = new FakeScrollBox()
    const rendered = await renderHookHarness({
      itemKeys: makeKeys(10),
      scrollRef: { current: scroll },
    })

    try {
      rendered.latest().spacerRef.current = fakeElement(0, 7)
      await rendered.render()

      expect(rendered.latest().range).toEqual([0, 10])
      expect(scroll.clampCalls.at(-1)).toEqual([0, Infinity])

      rendered.latest().scrollToIndex(2)
      expect(scroll.scrollToCalls).toEqual([13])
    } finally {
      await rendered.dispose()
    }
  })
})
