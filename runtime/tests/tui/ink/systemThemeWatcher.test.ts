import { afterEach, describe, expect, test, vi } from 'vitest'

import type { TerminalQuerier } from '../../../src/tui/ink/terminal-querier.js'
import { watchSystemTheme } from '../../../src/utils/systemThemeWatcher.js'

afterEach(() => {
  vi.useRealTimers()
})

function flushMicrotasks(): Promise<void> {
  return Promise.resolve().then(() => undefined)
}

describe('systemThemeWatcher', () => {
  test('polls OSC 11 immediately, repeats on an interval, and cleans up', async () => {
    vi.useFakeTimers()
    const send = vi
      .fn()
      .mockResolvedValueOnce({ type: 'osc', code: 11, data: 'rgb:ffff/ffff/ffff' })
      .mockResolvedValueOnce({ type: 'osc', code: 11, data: 'rgb:0000/0000/0000' })
    const flush = vi.fn().mockResolvedValue(undefined)
    const onThemeChange = vi.fn()
    const querier = { send, flush } as unknown as TerminalQuerier

    const cleanup = watchSystemTheme(querier, onThemeChange)
    await flushMicrotasks()

    expect(onThemeChange).toHaveBeenLastCalledWith('light')
    expect(send).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(2_000)
    await flushMicrotasks()

    expect(onThemeChange).toHaveBeenLastCalledWith('dark')
    expect(send).toHaveBeenCalledTimes(2)

    cleanup()
    await vi.advanceTimersByTimeAsync(2_000)

    expect(send).toHaveBeenCalledTimes(2)
  })
})
