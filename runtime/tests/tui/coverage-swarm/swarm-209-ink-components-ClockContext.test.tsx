import { PassThrough } from 'node:stream'

import React, { act } from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'

import {
  ClockContext,
  ClockProvider,
  createClock,
  type Clock,
} from '../../../src/tui/ink/components/ClockContext.js'
import TerminalFocusContext from '../../../src/tui/ink/components/TerminalFocusContext.js'
import { createRoot } from '../../../src/tui/ink/root.js'

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

const realSetImmediate = setImmediate

function createStreams(): TestStreams {
  const stdin = new PassThrough() as TestStreams['stdin']
  const stdout = new PassThrough() as TestStreams['stdout']

  stdin.isTTY = true
  stdin.ref = () => {}
  stdin.setRawMode = () => {}
  stdin.unref = () => {}

  stdout.columns = 100
  stdout.rows = 24
  stdout.isTTY = true
  stdout.resume()

  return { stdin, stdout }
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
  await new Promise<void>(resolve => realSetImmediate(resolve))
  await act(async () => {
    await Promise.resolve()
  })
}

function ClockProbe({
  onClock,
}: {
  readonly onClock: (clock: Clock | null) => void
}): null {
  onClock(React.useContext(ClockContext))
  return null
}

afterEach(() => {
  vi.useRealTimers()
})

describe('ClockContext coverage swarm row 209', () => {
  test('returns live elapsed time while an active interval is waiting for its first tick', () => {
    vi.useFakeTimers()
    vi.setSystemTime(2_000)

    const clock = createClock(10)
    const ticks: number[] = []
    const unsubscribe = clock.subscribe(() => {
      ticks.push(clock.now())
    }, true)

    try {
      expect(clock.now()).toBe(0)

      vi.advanceTimersByTime(9)

      expect(ticks).toEqual([])
      expect(clock.now()).toBe(9)

      vi.advanceTimersByTime(1)

      expect(ticks).toEqual([10])
      expect(clock.now()).toBe(10)
    } finally {
      unsubscribe()
    }
  })

  test('ClockProvider lengthens and restores the active clock interval as focus changes', async () => {
    const { stdin, stdout } = createStreams()
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    })
    let capturedClock: Clock | null = null
    let unsubscribe: (() => void) | undefined

    async function renderWithFocus(isTerminalFocused: boolean): Promise<Clock> {
      await act(async () => {
        root.render(
          <TerminalFocusContext.Provider
            value={{
              isTerminalFocused,
              terminalFocusState: isTerminalFocused ? 'focused' : 'blurred',
            }}
          >
            <ClockProvider>
              <ClockProbe
                onClock={clock => {
                  capturedClock = clock
                }}
              />
            </ClockProvider>
          </TerminalFocusContext.Provider>,
        )
      })
      await flushEffects()

      if (capturedClock === null) {
        throw new Error('ClockProvider did not expose a clock')
      }

      return capturedClock
    }

    try {
      const clock = await renderWithFocus(true)
      const ticks: number[] = []

      vi.useFakeTimers()
      vi.setSystemTime(10_000)

      unsubscribe = clock.subscribe(() => {
        ticks.push(clock.now())
      }, true)

      await vi.advanceTimersByTimeAsync(15)
      expect(ticks).toEqual([])

      await vi.advanceTimersByTimeAsync(1)
      expect(ticks).toEqual([16])

      expect(await renderWithFocus(false)).toBe(clock)

      await vi.advanceTimersByTimeAsync(31)
      expect(ticks).toEqual([16])

      await vi.advanceTimersByTimeAsync(1)
      expect(ticks).toEqual([16, 48])

      expect(await renderWithFocus(true)).toBe(clock)

      await vi.advanceTimersByTimeAsync(15)
      expect(ticks).toEqual([16, 48])

      await vi.advanceTimersByTimeAsync(1)
      expect(ticks).toEqual([16, 48, 64])
    } finally {
      unsubscribe?.()
      root.unmount()
      stdin.end()
      stdout.end()
      vi.useRealTimers()
      await flushEffects()
    }
  })
})
