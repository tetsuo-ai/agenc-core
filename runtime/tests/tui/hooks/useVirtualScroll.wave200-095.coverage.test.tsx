import { PassThrough } from 'node:stream'

import React from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { createRoot } from '../ink/root.js'
import type { ScrollBoxHandle } from '../ink/components/ScrollBox.js'
import type { DOMElement } from '../ink/dom.js'
import {
  type VirtualScrollResult,
  useVirtualScroll,
} from './useVirtualScroll.js'

type FakeScrollHandle = ScrollBoxHandle & {
  lastClamp: [number | undefined, number | undefined] | undefined
  scrollToCalls: number[]
  setScrollTop: (value: number) => void
}

function createScrollHandle(): FakeScrollHandle {
  let scrollTop = 0
  const listeners = new Set<() => void>()
  const handle = {
    getPendingDelta: () => 0,
    getScrollTop: () => scrollTop,
    getViewportHeight: () => 20,
    isSticky: () => false,
    lastClamp: undefined as [number | undefined, number | undefined] | undefined,
    scrollTo: vi.fn((value: number) => {
      handle.scrollToCalls.push(value)
      scrollTop = value
    }),
    scrollToCalls: [] as number[],
    setClampBounds: vi.fn((min?: number, max?: number) => {
      handle.lastClamp = [min, max]
    }),
    setScrollTop: (value: number) => {
      scrollTop = value
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  } as FakeScrollHandle
  return handle
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
  stdout.resume()
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

function unmeasuredElement(): DOMElement {
  return {} as DOMElement
}

function sleep(ms = 25): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function renderHookHarness(initial: {
  itemKeys: readonly string[]
  scrollRef: React.RefObject<ScrollBoxHandle | null>
}): Promise<{
  readonly dispose: () => Promise<void>
  readonly latest: () => VirtualScrollResult
  readonly render: (next?: Partial<typeof initial>) => Promise<void>
}> {
  let props = initial
  let latest: VirtualScrollResult | undefined
  const { stdin, stdout } = createStreams()
  const root = await createRoot({
    patchConsole: false,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  })

  function Harness(): null {
    latest = useVirtualScroll(props.scrollRef, props.itemKeys, 80)
    return null
  }

  async function render(next: Partial<typeof initial> = {}): Promise<void> {
    props = { ...props, ...next }
    root.render(<Harness />)
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

describe('useVirtualScroll wave200-095 coverage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  test('keeps unsafe mounted rows while sliding fast-scroll ranges and clearing stale refs', async () => {
    const itemKeys = [
      'stale',
      'blocker',
      'zero',
      'final',
      ...Array.from({ length: 796 }, (_, index) => `item-${index}`),
    ]
    const scroll = createScrollHandle()
    const harness = await renderHookHarness({
      itemKeys,
      scrollRef: { current: scroll },
    })

    try {
      const initial = harness.latest()
      expect(initial.range[0]).toBe(0)

      const staleRef = initial.measureRef('stale')
      const blockerRef = initial.measureRef('blocker')
      const finalRef = initial.measureRef('final')
      staleRef(fakeElement(12, 0))
      blockerRef(unmeasuredElement())
      initial.measureRef('zero')(fakeElement(0, 12))
      finalRef(fakeElement(9, 12))
      finalRef(null)
      expect(initial.getItemHeight(3)).toBe(9)

      await harness.render()
      expect(harness.latest().getItemHeight(0)).toBe(12)
      expect(harness.latest().getItemHeight(1)).toBeUndefined()
      expect(harness.latest().getItemHeight(2)).toBe(0)
      expect(harness.latest().getItemTop(1)).toBe(-1)

      scroll.setScrollTop(600)
      await harness.render()
      const blocked = harness.latest()
      expect(blocked.range[0]).toBe(1)

      const scrollToCallCount = scroll.scrollToCalls.length
      blocked.scrollToIndex(-1)
      blocked.scrollToIndex(itemKeys.length)
      expect(scroll.scrollToCalls).toHaveLength(scrollToCallCount)

      staleRef(null)
      await harness.render({ itemKeys: itemKeys.slice(1) })
      expect(harness.latest().measureRef('stale')).not.toBe(staleRef)

      blockerRef(null)
      scroll.setScrollTop(2400)
      await harness.render()
      const fastDown = harness.latest().range
      expect(fastDown[0]).toBeGreaterThan(blocked.range[0])
      expect(fastDown[1] - fastDown[0]).toBeLessThanOrEqual(300)

      scroll.setScrollTop(0)
      await harness.render()
      const fastUp = harness.latest().range
      expect(fastUp[0]).toBeLessThan(fastDown[0])
      expect(fastUp[1] - fastUp[0]).toBeLessThanOrEqual(300)
    } finally {
      await harness.dispose()
    }
  })
})
