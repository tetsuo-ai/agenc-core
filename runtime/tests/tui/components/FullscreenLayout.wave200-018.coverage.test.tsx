import { PassThrough } from 'node:stream'

import React from 'react'
import { describe, expect, test, vi } from 'vitest'

import { createRoot } from '../ink/root.js'
import type { ScrollBoxHandle } from '../ink/components/ScrollBox.js'
import { useUnseenDivider } from './FullscreenLayout.js'

type TestScrollHandle = ScrollBoxHandle & {
  setPendingDelta: (value: number) => void
  setScrollHeight: (value: number) => void
  setScrollTop: (value: number) => void
  setViewportHeight: (value: number) => void
}

function createScrollHandle(): TestScrollHandle {
  let pendingDelta = 0
  let scrollHeight = 30
  let scrollTop = 20
  let viewportHeight = 10

  return {
    getPendingDelta: vi.fn(() => pendingDelta),
    getScrollHeight: vi.fn(() => scrollHeight),
    getScrollTop: vi.fn(() => scrollTop),
    getViewportHeight: vi.fn(() => viewportHeight),
    scrollToBottom: vi.fn(),
    setPendingDelta: (value: number) => {
      pendingDelta = value
    },
    setScrollHeight: (value: number) => {
      scrollHeight = value
    },
    setScrollTop: (value: number) => {
      scrollTop = value
    },
    setViewportHeight: (value: number) => {
      viewportHeight = value
    },
  } as unknown as TestScrollHandle
}

function createStreams(): {
  readonly stdin: PassThrough & {
    isTTY: boolean
    ref: () => void
    setRawMode: (mode: boolean) => void
    unref: () => void
  }
  readonly stdout: PassThrough
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

async function sleep(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 25))
}

describe('useUnseenDivider coverage', () => {
  test('snapshots the first scroll-away baseline, shifts it, jumps, and clears stale dividers', async () => {
    let messageCount = 3
    let latest: ReturnType<typeof useUnseenDivider> | undefined
    const { stdin, stdout } = createStreams()
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    })

    function Harness(): null {
      latest = useUnseenDivider(messageCount)
      return null
    }

    async function render(nextCount = messageCount): Promise<ReturnType<typeof useUnseenDivider>> {
      messageCount = nextCount
      root.render(<Harness />)
      await sleep()
      if (latest === undefined) throw new Error('hook did not render')
      return latest
    }

    try {
      const handle = createScrollHandle()

      let state = await render()
      state.onScrollAway(handle)
      await sleep()
      expect(state.dividerYRef.current).toBeNull()
      expect((await render()).dividerIndex).toBeNull()

      handle.setScrollTop(5)
      state.onScrollAway(handle)
      await sleep()
      state = await render()
      expect(state.dividerIndex).toBe(3)
      expect(state.dividerYRef.current).toBe(30)

      handle.setScrollHeight(50)
      state.onScrollAway(handle)
      await sleep()
      state = await render(5)
      expect(state.dividerIndex).toBe(3)
      expect(state.dividerYRef.current).toBe(30)

      state.shiftDivider(2, 7)
      await sleep()
      state = await render()
      expect(state.dividerIndex).toBe(5)
      expect(state.dividerYRef.current).toBe(37)

      state.jumpToNew(null)
      expect(handle.scrollToBottom).not.toHaveBeenCalled()
      state.jumpToNew(handle)
      expect(handle.scrollToBottom).toHaveBeenCalledTimes(1)

      state = await render(4)
      expect(state.dividerIndex).toBeNull()
      expect(state.dividerYRef.current).toBeNull()
    } finally {
      root.unmount()
      stdin.end()
      stdout.end()
      await sleep()
    }
  })
})
