import { PassThrough } from 'node:stream'

import React from 'react'
import { describe, expect, test } from 'vitest'

import { ClockContext, type Clock } from '../components/ClockContext.js'
import { createRoot, type Root } from '../root.js'
import { useAnimationTimer, useInterval } from './use-interval.js'

type ManualSubscription = {
  active: boolean
  readonly keepAlive: boolean
  readonly onChange: () => void
}

type HookProbeProps = {
  readonly animationIntervalMs: number
  readonly clock: Clock | null
  readonly intervalMs: number | null
  readonly onInterval: () => void
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
  readonly latestTime: () => number
  readonly render: (props: HookProbeProps) => Promise<void>
}> {
  let latestTime: number | undefined
  const { stdin, stdout } = createStreams()
  const root: Root = await createRoot({
    patchConsole: false,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  })

  function HookProbe(props: HookProbeProps): null {
    latestTime = useAnimationTimer(props.animationIntervalMs)
    useInterval(props.onInterval, props.intervalMs)
    return null
  }

  return {
    dispose: async () => {
      root.unmount()
      stdin.end()
      stdout.end()
      await flushEffects()
    },
    latestTime: () => {
      if (latestTime === undefined) throw new Error('hook did not render')
      return latestTime
    },
    render: async props => {
      root.render(
        React.createElement(
          ClockContext.Provider,
          { value: props.clock },
          React.createElement(HookProbe, props),
        ),
      )
      await flushEffects()
    },
  }
}

describe('use-interval hook coverage', () => {
  test('uses the shared clock for animation time and interval callbacks', async () => {
    const manualClock = createManualClock()
    const firstCallbackCalls: number[] = []
    const secondCallbackCalls: number[] = []
    const rendered = await renderHookHarness()

    try {
      await rendered.render({
        animationIntervalMs: 50,
        clock: null,
        intervalMs: 40,
        onInterval: () => firstCallbackCalls.push(manualClock.clock.now()),
      })

      expect(rendered.latestTime()).toBe(0)
      expect(manualClock.activeSubscriptions()).toEqual([])

      await rendered.render({
        animationIntervalMs: 50,
        clock: manualClock.clock,
        intervalMs: null,
        onInterval: () => firstCallbackCalls.push(manualClock.clock.now()),
      })

      expect(
        manualClock.activeSubscriptions().map(subscription => subscription.keepAlive),
      ).toEqual([false])

      manualClock.advance(49)
      await flushEffects()

      expect(rendered.latestTime()).toBe(0)

      manualClock.advance(1)
      await flushEffects()

      expect(rendered.latestTime()).toBe(50)
      expect(firstCallbackCalls).toEqual([])

      await rendered.render({
        animationIntervalMs: 50,
        clock: manualClock.clock,
        intervalMs: 40,
        onInterval: () => firstCallbackCalls.push(manualClock.clock.now()),
      })

      expect(
        manualClock.activeSubscriptions().map(subscription => subscription.keepAlive),
      ).toEqual([false, false])

      manualClock.advance(39)
      await flushEffects()

      expect(firstCallbackCalls).toEqual([])

      manualClock.advance(1)
      await flushEffects()

      expect(firstCallbackCalls).toEqual([90])

      await rendered.render({
        animationIntervalMs: 50,
        clock: manualClock.clock,
        intervalMs: 40,
        onInterval: () => secondCallbackCalls.push(manualClock.clock.now()),
      })

      expect(manualClock.activeSubscriptions()).toHaveLength(2)

      manualClock.advance(40)
      await flushEffects()

      expect(firstCallbackCalls).toEqual([90])
      expect(secondCallbackCalls).toEqual([130])
      expect(rendered.latestTime()).toBe(130)

      await rendered.render({
        animationIntervalMs: 50,
        clock: manualClock.clock,
        intervalMs: null,
        onInterval: () => secondCallbackCalls.push(manualClock.clock.now()),
      })

      expect(manualClock.activeSubscriptions()).toHaveLength(1)

      manualClock.advance(80)
      await flushEffects()

      expect(secondCallbackCalls).toEqual([130])
      expect(rendered.latestTime()).toBe(210)
    } finally {
      await rendered.dispose()
    }

    expect(manualClock.activeSubscriptions()).toEqual([])
  })
})
