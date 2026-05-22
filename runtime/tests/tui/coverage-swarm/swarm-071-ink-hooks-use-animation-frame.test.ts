import { PassThrough } from 'node:stream'

import React from 'react'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import { ClockContext, type Clock } from '../../../src/tui/ink/components/ClockContext.js'
import type { DOMElement } from '../../../src/tui/ink/dom.js'
import { createRoot, type Root } from '../../../src/tui/ink/root.js'
import { useAnimationFrame } from '../../../src/tui/ink/hooks/use-animation-frame.js'

const viewportMock = vi.hoisted(() => {
  const state = { isVisible: true }
  const ref = vi.fn()

  return {
    ref,
    state,
    useTerminalViewport: vi.fn(
      () => [ref, { isVisible: state.isVisible }] as const,
    ),
  }
})

vi.mock('../../../src/tui/ink/hooks/use-terminal-viewport.js', () => ({
  useTerminalViewport: viewportMock.useTerminalViewport,
}))

type ManualSubscription = {
  active: boolean
  readonly keepAlive: boolean
  readonly onChange: () => void
}

type HookProbeProps = {
  readonly intervalMs?: number | null
}

type HookState = {
  ref?: (element: DOMElement | null) => void
  time?: number
}

function createManualClock(): {
  readonly activeSubscriptions: () => ManualSubscription[]
  readonly advance: (ms: number) => void
  readonly clock: Clock
} {
  let now = 0
  const subscriptions: ManualSubscription[] = []

  return {
    activeSubscriptions: () =>
      subscriptions.filter(subscription => subscription.active),
    advance: ms => {
      now += ms

      for (const subscription of subscriptions.filter(
        candidate => candidate.active,
      )) {
        subscription.onChange()
      }
    },
    clock: {
      now: () => now,
      setTickInterval: () => {},
      subscribe: (onChange, keepAlive) => {
        const subscription: ManualSubscription = {
          active: true,
          keepAlive,
          onChange,
        }
        subscriptions.push(subscription)

        return () => {
          subscription.active = false
        }
      },
    },
  }
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
  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean
    ref: () => void
    setRawMode: (mode: boolean) => void
    unref: () => void
  }
  const stdout = new PassThrough()

  stdin.isTTY = true
  stdin.ref = () => {}
  stdin.setRawMode = () => {}
  stdin.unref = () => {}
  stdout.resume()

  return { stdin, stdout }
}

function flushEffects(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 5))
}

async function renderHookHarness(): Promise<{
  readonly dispose: () => Promise<void>
  readonly latestRef: () => (element: DOMElement | null) => void
  readonly latestTime: () => number
  readonly render: (
    props: HookProbeProps & { readonly clock: Clock | null },
  ) => Promise<void>
}> {
  const latest: HookState = {}
  const { stdin, stdout } = createStreams()
  const root: Root = await createRoot({
    patchConsole: false,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  })

  function HookProbe(props: HookProbeProps): null {
    const [ref, time] = useAnimationFrame(props.intervalMs)
    latest.ref = ref
    latest.time = time
    return null
  }

  return {
    dispose: async () => {
      root.unmount()
      stdin.end()
      stdout.end()
      await flushEffects()
    },
    latestRef: () => {
      if (latest.ref === undefined) throw new Error('hook did not render ref')
      return latest.ref
    },
    latestTime: () => {
      if (latest.time === undefined) throw new Error('hook did not render time')
      return latest.time
    },
    render: async props => {
      root.render(
        React.createElement(
          ClockContext.Provider,
          { value: props.clock },
          React.createElement(HookProbe, { intervalMs: props.intervalMs }),
        ),
      )
      await flushEffects()
    },
  }
}

beforeEach(() => {
  viewportMock.state.isVisible = true
  viewportMock.ref.mockClear()
  viewportMock.useTerminalViewport.mockClear()
})

describe('useAnimationFrame coverage swarm row 071', () => {
  test('subscribes visible animations to the shared clock and respects the interval threshold', async () => {
    const manualClock = createManualClock()
    const rendered = await renderHookHarness()

    try {
      await rendered.render({ clock: null, intervalMs: 25 })

      expect(rendered.latestRef()).toBe(viewportMock.ref)
      expect(rendered.latestTime()).toBe(0)
      expect(manualClock.activeSubscriptions()).toEqual([])

      await rendered.render({ clock: manualClock.clock, intervalMs: 25 })

      expect(
        manualClock.activeSubscriptions().map(subscription => subscription.keepAlive),
      ).toEqual([true])

      manualClock.advance(24)
      await flushEffects()

      expect(rendered.latestTime()).toBe(0)

      manualClock.advance(1)
      await flushEffects()

      expect(rendered.latestTime()).toBe(25)

      manualClock.advance(25)
      await flushEffects()

      expect(rendered.latestTime()).toBe(50)
    } finally {
      await rendered.dispose()
    }

    expect(manualClock.activeSubscriptions()).toEqual([])
  })

  test('uses the default frame interval and pauses while invisible or explicitly disabled', async () => {
    const manualClock = createManualClock()
    const rendered = await renderHookHarness()

    try {
      await rendered.render({ clock: manualClock.clock })

      expect(
        manualClock.activeSubscriptions().map(subscription => subscription.keepAlive),
      ).toEqual([true])

      manualClock.advance(15)
      await flushEffects()

      expect(rendered.latestTime()).toBe(0)

      manualClock.advance(1)
      await flushEffects()

      expect(rendered.latestTime()).toBe(16)

      viewportMock.state.isVisible = false
      await rendered.render({ clock: manualClock.clock })

      expect(manualClock.activeSubscriptions()).toEqual([])

      manualClock.advance(50)
      await flushEffects()

      expect(rendered.latestTime()).toBe(16)

      viewportMock.state.isVisible = true
      await rendered.render({ clock: manualClock.clock, intervalMs: null })

      expect(manualClock.activeSubscriptions()).toEqual([])

      manualClock.advance(50)
      await flushEffects()

      expect(rendered.latestTime()).toBe(16)

      await rendered.render({ clock: manualClock.clock, intervalMs: 20 })

      expect(manualClock.activeSubscriptions()).toHaveLength(1)

      manualClock.advance(19)
      await flushEffects()

      expect(rendered.latestTime()).toBe(16)

      manualClock.advance(1)
      await flushEffects()

      expect(rendered.latestTime()).toBe(136)
    } finally {
      await rendered.dispose()
    }

    expect(manualClock.activeSubscriptions()).toEqual([])
  })
})
