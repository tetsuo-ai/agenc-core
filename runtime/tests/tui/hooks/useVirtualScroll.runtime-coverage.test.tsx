import { PassThrough } from 'node:stream'

import React from 'react'
import { afterEach, describe, expect, test } from 'vitest'

import type { ScrollBoxHandle } from '../ink/components/ScrollBox.js'
import type { DOMElement } from '../ink/dom.js'
import { Box, Text } from '../ink.js'
import { createRoot } from '../ink/root.js'
import { useVirtualScroll, type VirtualScrollResult } from './useVirtualScroll.js'

type ClampCall = readonly [number | undefined, number | undefined]

class FakeScrollBox implements ScrollBoxHandle {
  readonly listeners = new Set<() => void>()
  readonly clampCalls: ClampCall[] = []
  readonly scrollToCalls: number[] = []
  pendingDelta = 0
  scrollTop = 0
  sticky = true
  viewportHeight = 0

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

type Snapshot = {
  bottomSpacer: number
  heights: Array<number | undefined>
  range: readonly [number, number]
  topSpacer: number
}

function makeKeys(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `item-${index}`)
}

function VirtualHarness({
  columns = 80,
  itemHeights = {},
  keys,
  resultRef,
  scroll,
  snapshots,
}: {
  columns?: number
  itemHeights?: Record<string, number>
  keys: readonly string[]
  resultRef: { current: VirtualScrollResult | null }
  scroll: FakeScrollBox | null
  snapshots: Snapshot[]
}): React.ReactNode {
  const result = useVirtualScroll(
    { current: scroll },
    keys,
    columns,
  )
  resultRef.current = result

  React.useLayoutEffect(() => {
    snapshots.push({
      bottomSpacer: result.bottomSpacer,
      heights: keys.map((_, index) => result.getItemHeight(index)),
      range: result.range,
      topSpacer: result.topSpacer,
    })
  })

  const [start, end] = result.range

  return (
    <Box flexDirection="column">
      <Box height={result.topSpacer} ref={result.spacerRef} />
      {keys.slice(start, end).map(key => (
        <Box
          height={itemHeights[key] ?? 1}
          key={key}
          ref={result.measureRef(key)}
        >
          <Text>{key}</Text>
        </Box>
      ))}
      <Box height={result.bottomSpacer} />
    </Box>
  )
}

function createStreams(): {
  stdin: PassThrough & {
    isTTY: boolean
    ref: () => void
    setRawMode: (mode: boolean) => void
    unref: () => void
  }
  stdout: PassThrough
} {
  const stdout = new PassThrough()
  const stdin = new PassThrough() as ReturnType<typeof createStreams>['stdin']
  stdin.isTTY = true
  stdin.setRawMode = () => {}
  stdin.ref = () => {}
  stdin.unref = () => {}
  ;(stdout as unknown as { columns: number }).columns = 120
  return { stdin, stdout }
}

async function waitForLayout(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 30))
}

async function withRoot(
  run: (root: Awaited<ReturnType<typeof createRoot>>) => Promise<void>,
): Promise<void> {
  const { stdin, stdout } = createStreams()
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  })

  try {
    await run(root)
  } finally {
    root.unmount()
    stdin.end()
  }
}

afterEach(() => {
  // The hook stores subscriptions through useSyncExternalStore; unmounting
  // each root handles cleanup, this just keeps test intent explicit.
})

describe('useVirtualScroll', () => {
  test('renders a cold-start tail range before the scroll ref attaches', async () => {
    const resultRef = { current: null as VirtualScrollResult | null }
    const snapshots: Snapshot[] = []
    const keys = makeKeys(40)

    await withRoot(async root => {
      root.render(
        <VirtualHarness
          keys={keys}
          resultRef={resultRef}
          scroll={null}
          snapshots={snapshots}
        />,
      )
      await waitForLayout()
    })

    expect(resultRef.current?.range).toEqual([10, 40])
    expect(resultRef.current?.topSpacer).toBe(30)
    expect(resultRef.current?.bottomSpacer).toBe(0)
    expect(snapshots.at(-1)?.range).toEqual([10, 40])
  })

  test('mounts the sticky tail and clears clamp bounds', async () => {
    const scroll = new FakeScrollBox()
    scroll.viewportHeight = 20
    scroll.scrollTop = 900
    scroll.sticky = true
    const resultRef = { current: null as VirtualScrollResult | null }
    const snapshots: Snapshot[] = []

    await withRoot(async root => {
      root.render(
        <VirtualHarness
          keys={makeKeys(300)}
          resultRef={resultRef}
          scroll={scroll}
          snapshots={snapshots}
        />,
      )
      await waitForLayout()
    })

    const range = resultRef.current?.range
    expect(range?.[1]).toBe(300)
    expect(range?.[0]).toBeGreaterThan(0)
    expect(range?.[0]).toBeLessThan(300)
    expect(resultRef.current?.bottomSpacer).toBe(0)
    expect(scroll.clampCalls).toContainEqual([undefined, undefined])
  })

  test('computes a non-sticky scroll window, clamps to mounted content, and scrolls by index', async () => {
    const scroll = new FakeScrollBox()
    scroll.viewportHeight = 20
    scroll.scrollTop = 300
    scroll.pendingDelta = -120
    scroll.sticky = false
    const resultRef = { current: null as VirtualScrollResult | null }
    const snapshots: Snapshot[] = []

    await withRoot(async root => {
      root.render(
        <VirtualHarness
          keys={makeKeys(300)}
          resultRef={resultRef}
          scroll={scroll}
          snapshots={snapshots}
        />,
      )
      await waitForLayout()

      resultRef.current?.scrollToIndex(10)
      resultRef.current?.scrollToIndex(-1)
      resultRef.current?.scrollToIndex(301)
    })

    const range = resultRef.current?.range
    expect(range?.[0]).toBeGreaterThan(0)
    expect(range?.[1]).toBeGreaterThan(range?.[0] ?? 0)
    expect((range?.[1] ?? 0) - (range?.[0] ?? 0)).toBeLessThanOrEqual(300)
    expect(scroll.clampCalls.some(([min, max]) => min !== undefined && max !== undefined)).toBe(true)
    expect(scroll.scrollToCalls).toEqual([30])
  })

  test('measures mounted items and exposes stable refs, DOM elements, tops, and heights', async () => {
    const scroll = new FakeScrollBox()
    scroll.viewportHeight = 12
    scroll.sticky = true
    const keys = makeKeys(8)
    const resultRef = { current: null as VirtualScrollResult | null }
    const snapshots: Snapshot[] = []
    const itemHeights = Object.fromEntries(keys.map((key, index) => [key, index + 1]))

    await withRoot(async root => {
      root.render(
        <VirtualHarness
          itemHeights={itemHeights}
          keys={keys}
          resultRef={resultRef}
          scroll={scroll}
          snapshots={snapshots}
        />,
      )
      await waitForLayout()

      const firstRef = resultRef.current?.measureRef('item-0')
      expect(resultRef.current?.measureRef('item-0')).toBe(firstRef)
      expect(resultRef.current?.getItemElement(0)).not.toBeNull()
      expect(resultRef.current?.getItemTop(0)).toBeGreaterThanOrEqual(0)
      expect(resultRef.current?.getItemHeight(0)).toBe(1)

      firstRef?.(null)
      expect(resultRef.current?.getItemElement(0)).toBeNull()
    })

    expect(snapshots.some(snapshot => snapshot.heights.some(height => height !== undefined))).toBe(true)
  })

  test('drops stale keys and scales cached heights across column changes', async () => {
    const scroll = new FakeScrollBox()
    scroll.viewportHeight = 10
    scroll.sticky = true
    const resultRef = { current: null as VirtualScrollResult | null }
    const snapshots: Snapshot[] = []

    await withRoot(async root => {
      root.render(
        <VirtualHarness
          itemHeights={{ a: 4, b: 5 }}
          keys={['a', 'b']}
          resultRef={resultRef}
          scroll={scroll}
          snapshots={snapshots}
        />,
      )
      await waitForLayout()

      expect(resultRef.current?.getItemHeight(0)).toBe(4)
      expect(resultRef.current?.getItemHeight(1)).toBe(5)

      root.render(
        <VirtualHarness
          columns={40}
          itemHeights={{ b: 5, c: 6 }}
          keys={['b', 'c']}
          resultRef={resultRef}
          scroll={scroll}
          snapshots={snapshots}
        />,
      )
      await waitForLayout()

      expect(resultRef.current?.getItemHeight(0)).toBe(10)
      expect(resultRef.current?.getItemHeight(1)).toBeUndefined()

      root.render(
        <VirtualHarness
          columns={40}
          itemHeights={{ b: 5, c: 6 }}
          keys={['b', 'c']}
          resultRef={resultRef}
          scroll={scroll}
          snapshots={snapshots}
        />,
      )
      await waitForLayout()

      expect(resultRef.current?.getItemHeight(1)).toBe(6)
    })
  })
})
