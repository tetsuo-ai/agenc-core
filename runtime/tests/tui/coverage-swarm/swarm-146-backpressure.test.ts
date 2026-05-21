import { afterEach, describe, expect, test, vi } from 'vitest'

import {
  formatTuiBackpressureWarning,
  getTuiBackpressureSnapshot,
  recordTuiBackpressure,
  resetTuiBackpressureForTesting,
  subscribeTuiBackpressure,
} from '../../../src/tui/backpressure.js'

const subscriptions: Array<() => void> = []

function subscribe(listener: () => void): () => void {
  const unsubscribe = subscribeTuiBackpressure(listener)
  subscriptions.push(unsubscribe)
  return unsubscribe
}

afterEach(() => {
  while (subscriptions.length > 0) {
    subscriptions.pop()?.()
  }
  resetTuiBackpressureForTesting()
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('TUI backpressure coverage swarm row 146', () => {
  test('ignores non-positive and non-finite durations without notifying listeners', () => {
    const listener = vi.fn()
    subscribe(listener)

    recordTuiBackpressure({ source: 'input', durationMs: 0, nowMs: 10 })
    recordTuiBackpressure({ source: 'render', durationMs: -1, nowMs: 10 })
    recordTuiBackpressure({ source: 'input', durationMs: Number.POSITIVE_INFINITY, nowMs: 10 })
    recordTuiBackpressure({ source: 'render', durationMs: Number.NaN, nowMs: 10 })

    expect(listener).not.toHaveBeenCalled()
    expect(getTuiBackpressureSnapshot()).toEqual({
      active: false,
      durationMs: 0,
      expiresAtMs: 0,
      source: null,
      startedAtMs: 0,
    })
  })

  test('uses current time and the default visible window when optional timing is omitted', () => {
    vi.useFakeTimers()
    vi.setSystemTime(12_345)

    recordTuiBackpressure({ source: 'input', durationMs: 49.4 })

    expect(getTuiBackpressureSnapshot()).toEqual({
      active: true,
      durationMs: 49.4,
      expiresAtMs: 16_345,
      source: 'input',
      startedAtMs: 12_345,
    })
    expect(formatTuiBackpressureWarning(getTuiBackpressureSnapshot())).toBe(
      'Input is catching up after 49ms of blocked key processing',
    )
  })

  test('clears expired snapshots synchronously when read after the visible window', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)

    recordTuiBackpressure({
      source: 'render',
      durationMs: 1_250,
      visibleMs: 25,
    })
    vi.setSystemTime(1_026)

    expect(getTuiBackpressureSnapshot()).toEqual({
      active: false,
      durationMs: 0,
      expiresAtMs: 0,
      source: null,
      startedAtMs: 0,
    })
  })

  test('replaces the pending clear timer and emits only for the current snapshot', () => {
    vi.useFakeTimers()
    vi.setSystemTime(2_000)
    const listener = vi.fn()
    subscribe(listener)

    recordTuiBackpressure({
      source: 'input',
      durationMs: 100,
      visibleMs: 100,
    })
    vi.advanceTimersByTime(50)
    recordTuiBackpressure({
      source: 'render',
      durationMs: 1_500,
      visibleMs: 1_000,
    })
    vi.advanceTimersByTime(100)

    expect(listener).toHaveBeenCalledTimes(2)
    expect(getTuiBackpressureSnapshot()).toMatchObject({
      active: true,
      durationMs: 1_500,
      source: 'render',
    })

    vi.advanceTimersByTime(900)

    expect(listener).toHaveBeenCalledTimes(3)
    expect(getTuiBackpressureSnapshot().active).toBe(false)
  })

  test('does not format inactive or source-less snapshots', () => {
    expect(
      formatTuiBackpressureWarning({
        active: false,
        durationMs: 900,
        expiresAtMs: 20,
        source: 'render',
        startedAtMs: 10,
      }),
    ).toBeNull()
    expect(
      formatTuiBackpressureWarning({
        active: true,
        durationMs: 900,
        expiresAtMs: 20,
        source: null,
        startedAtMs: 10,
      }),
    ).toBeNull()
  })
})
