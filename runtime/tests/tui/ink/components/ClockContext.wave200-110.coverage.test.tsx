import { afterEach, describe, expect, test, vi } from 'vitest'

import { createClock } from './ClockContext.js'

afterEach(() => {
  vi.useRealTimers()
})

describe('ClockContext clock coverage', () => {
  test('ticks only while keep-alive subscribers are present and returns live time when paused', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)

    const clock = createClock(20)
    const passiveTicks: number[] = []
    const activeTicks: number[] = []

    const unsubscribePassive = clock.subscribe(() => {
      passiveTicks.push(clock.now())
    }, false)

    expect(clock.now()).toBe(0)

    vi.advanceTimersByTime(40)

    expect(passiveTicks).toEqual([])
    expect(clock.now()).toBe(40)

    const unsubscribeActive = clock.subscribe(() => {
      activeTicks.push(clock.now())
    }, true)

    vi.advanceTimersByTime(20)

    expect(passiveTicks).toEqual([60])
    expect(activeTicks).toEqual([60])
    expect(clock.now()).toBe(60)

    clock.setTickInterval(20)
    vi.advanceTimersByTime(20)

    expect(passiveTicks).toEqual([60, 80])
    expect(activeTicks).toEqual([60, 80])

    clock.setTickInterval(5)
    vi.advanceTimersByTime(4)

    expect(activeTicks).toEqual([60, 80])

    vi.advanceTimersByTime(1)

    expect(passiveTicks).toEqual([60, 80, 85])
    expect(activeTicks).toEqual([60, 80, 85])

    unsubscribeActive()
    vi.advanceTimersByTime(10)

    expect(passiveTicks).toEqual([60, 80, 85])
    expect(activeTicks).toEqual([60, 80, 85])
    expect(clock.now()).toBe(95)

    unsubscribePassive()
    vi.advanceTimersByTime(5)

    expect(clock.now()).toBe(100)
  })
})
