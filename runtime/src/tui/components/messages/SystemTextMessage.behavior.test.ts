import { describe, expect, it, vi } from 'vitest'

vi.mock('bun:bundle', () => ({
  feature: () => false,
}))

import {
  formatHookDuration,
  getStopHookTotalDurationMs,
  getSystemMessageContentWidth,
  shouldRenderStopHookSummary,
} from './SystemTextMessage.js'
import { HOOK_TIMING_DISPLAY_THRESHOLD_MS } from '../../../tools/hooks.js'

function stopHookSummary(overrides = {}) {
  return {
    subtype: 'stop_hook_summary',
    hookCount: 1,
    hookInfos: [],
    hookErrors: [],
    preventedContinuation: false,
    stopReason: undefined,
    hookLabel: undefined,
    ...overrides,
  } as never
}

describe('SystemTextMessage stop-hook summary behavior', () => {
  it('renders successful unlabeled stop hooks only above the timing threshold', () => {
    expect(shouldRenderStopHookSummary(stopHookSummary({
      totalDurationMs: HOOK_TIMING_DISPLAY_THRESHOLD_MS,
    }))).toBe(false)
    expect(shouldRenderStopHookSummary(stopHookSummary({
      totalDurationMs: HOOK_TIMING_DISPLAY_THRESHOLD_MS + 1,
    }))).toBe(true)
  })

  it('always renders error, blocking, and labeled summaries', () => {
    expect(shouldRenderStopHookSummary(stopHookSummary({
      hookErrors: ['failed'],
      totalDurationMs: 0,
    }))).toBe(true)
    expect(shouldRenderStopHookSummary(stopHookSummary({
      preventedContinuation: true,
      totalDurationMs: 0,
    }))).toBe(true)
    expect(shouldRenderStopHookSummary(stopHookSummary({
      hookLabel: 'notification',
      totalDurationMs: 0,
    }))).toBe(true)
  })

  it('uses total duration from hook info records and formats timing details', () => {
    const message = stopHookSummary({
      hookInfos: [
        { command: 'one', durationMs: 200 },
        { command: 'two', durationMs: 350 },
      ],
    })

    expect(getStopHookTotalDurationMs(message)).toBe(550)
    expect(formatHookDuration(550)).toContain('(')
    expect(formatHookDuration(undefined)).toBe('')
  })
})

describe('SystemTextMessage width behavior', () => {
  it('clamps content width for tiny terminals', () => {
    expect(getSystemMessageContentWidth(120)).toBe(110)
    expect(getSystemMessageContentWidth(10)).toBe(1)
    expect(getSystemMessageContentWidth(1)).toBe(1)
  })
})
