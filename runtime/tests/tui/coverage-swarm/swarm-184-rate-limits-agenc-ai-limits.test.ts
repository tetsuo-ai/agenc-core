import { beforeEach, describe, expect, test, vi } from 'vitest'

type LimitsSnapshot = {
  readonly status: 'allowed' | 'allowed_warning' | 'rejected'
  readonly unifiedRateLimitFallbackAvailable: boolean
  readonly isUsingOverage?: boolean
  readonly rateLimitType?: 'five_hour' | 'seven_day' | 'overage'
  readonly resetsAt?: number
  readonly utilization?: number
}

type RawWindowUtilization = {
  readonly utilization: number
  readonly resets_at: number
}

type RawUtilization = {
  readonly five_hour?: RawWindowUtilization
  readonly seven_day?: RawWindowUtilization
}

type LimitsListener = (limits: LimitsSnapshot) => void

const harness = vi.hoisted(() => ({
  cleanup: undefined as (() => void) | undefined,
  currentLimits: {
    status: 'allowed',
    unifiedRateLimitFallbackAvailable: false,
    isUsingOverage: false,
  } as LimitsSnapshot,
  currentState: undefined as LimitsSnapshot | undefined,
  effectDeps: undefined as readonly unknown[] | undefined,
  getRawUtilization: vi.fn<() => RawUtilization>(() => ({})),
  stateUpdates: [] as LimitsSnapshot[],
  statusListeners: new Set<LimitsListener>(),
  useEffect: vi.fn(
    (effect: () => void | (() => void), deps?: readonly unknown[]) => {
      harness.effectDeps = deps
      harness.cleanup = effect() ?? undefined
    },
  ),
  useState: vi.fn((initial: LimitsSnapshot) => {
    harness.currentState = initial
    return [
      harness.currentState,
      (next: LimitsSnapshot) => {
        harness.currentState = next
        harness.stateUpdates.push(next)
      },
    ] as const
  }),
}))

vi.mock('react', () => ({
  useEffect: harness.useEffect,
  useState: harness.useState,
}))

vi.mock('../../../src/services/agencAiLimits.js', () => ({
  get currentLimits() {
    return harness.currentLimits
  },
  getRawUtilization: harness.getRawUtilization,
  statusListeners: harness.statusListeners,
}))

import {
  getRawUtilization,
  useAgenCAiLimits,
} from '../../../src/tui/rate-limits/agenc-ai-limits.js'

describe('agenc-ai-limits coverage swarm row 184', () => {
  beforeEach(() => {
    harness.cleanup = undefined
    harness.currentLimits = {
      status: 'allowed',
      unifiedRateLimitFallbackAvailable: false,
      isUsingOverage: false,
    }
    harness.currentState = undefined
    harness.effectDeps = undefined
    harness.getRawUtilization.mockReset()
    harness.getRawUtilization.mockReturnValue({})
    harness.stateUpdates = []
    harness.statusListeners.clear()
    harness.useEffect.mockClear()
    harness.useState.mockClear()
  })

  test('subscribes to limit changes with cloned initial and listener snapshots', () => {
    const initialLimits: LimitsSnapshot = {
      status: 'allowed_warning',
      unifiedRateLimitFallbackAvailable: true,
      isUsingOverage: false,
      rateLimitType: 'five_hour',
      resetsAt: 1_800,
      utilization: 0.91,
    }
    harness.currentLimits = initialLimits

    const rendered = useAgenCAiLimits()

    expect(rendered).toEqual(initialLimits)
    expect(rendered).not.toBe(initialLimits)
    expect(harness.useState).toHaveBeenCalledTimes(1)
    expect(harness.useEffect).toHaveBeenCalledTimes(1)
    expect(harness.effectDeps).toEqual([])
    expect(harness.statusListeners.size).toBe(1)

    const [listener] = harness.statusListeners
    const nextLimits: LimitsSnapshot = {
      status: 'rejected',
      unifiedRateLimitFallbackAvailable: false,
      isUsingOverage: true,
      rateLimitType: 'overage',
      resetsAt: 3_600,
      utilization: 1,
    }

    listener(nextLimits)

    expect(harness.stateUpdates).toHaveLength(1)
    expect(harness.stateUpdates[0]).toEqual(nextLimits)
    expect(harness.stateUpdates[0]).not.toBe(nextLimits)

    expect(harness.cleanup).toBeTypeOf('function')
    harness.cleanup?.()
    expect(harness.statusListeners.size).toBe(0)
  })

  test('returns independent raw utilization windows when present', () => {
    const raw: RawUtilization = {
      five_hour: { utilization: 0.25, resets_at: 10 },
      seven_day: { utilization: 0.75, resets_at: 20 },
    }
    harness.getRawUtilization.mockReturnValue(raw)

    const result = getRawUtilization()

    expect(result).toEqual(raw)
    expect(result).not.toBe(raw)
    expect(result.five_hour).not.toBe(raw.five_hour)
    expect(result.seven_day).not.toBe(raw.seven_day)
  })

  test('omits raw utilization windows that are not reported', () => {
    harness.getRawUtilization.mockReturnValue({})

    expect(getRawUtilization()).toEqual({})
  })
})
