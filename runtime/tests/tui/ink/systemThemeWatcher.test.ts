import { afterEach, describe, expect, test, vi } from 'vitest'

const logMocks = vi.hoisted(() => ({
  logError: vi.fn(),
}))

vi.mock('../../../src/utils/log.js', () => ({
  logError: logMocks.logError,
}))

import type { TerminalQuerier } from '../../../src/tui/ink/terminal-querier.js'
import { watchSystemTheme } from '../../../src/utils/systemThemeWatcher.js'

afterEach(() => {
  vi.useRealTimers()
  logMocks.logError.mockReset()
})

function flushMicrotasks(): Promise<void> {
  return Promise.resolve().then(() => undefined)
}

function deferred<T>(): {
  readonly promise: Promise<T>
  readonly reject: (error: unknown) => void
  readonly resolve: (value: T) => void
} {
  let reject!: (error: unknown) => void
  let resolve!: (value: T) => void
  const promise = new Promise<T>((innerResolve, innerReject) => {
    reject = innerReject
    resolve = innerResolve
  })
  return { promise, reject, resolve }
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

  test('logs failed OSC polls and resumes polling on the next interval', async () => {
    vi.useFakeTimers()
    const pollError = new Error('osc 11 failed')
    const send = vi
      .fn()
      .mockResolvedValueOnce({ type: 'osc', code: 11, data: 'rgb:ffff/ffff/ffff' })
      .mockResolvedValueOnce({ type: 'osc', code: 11, data: 'rgb:0000/0000/0000' })
    const flush = vi
      .fn()
      .mockRejectedValueOnce(pollError)
      .mockResolvedValueOnce(undefined)
    const onThemeChange = vi.fn()
    const querier = { send, flush } as unknown as TerminalQuerier

    const cleanup = watchSystemTheme(querier, onThemeChange)
    await flushMicrotasks()

    expect(logMocks.logError).toHaveBeenCalledWith(pollError)
    expect(onThemeChange).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(2_000)
    await flushMicrotasks()

    expect(onThemeChange).toHaveBeenLastCalledWith('dark')
    expect(send).toHaveBeenCalledTimes(2)

    cleanup()
  })

  test('observes pending response failures when flush fails first', async () => {
    vi.useFakeTimers()
    const flushError = new Error('flush failed')
    const responseError = new Error('response failed after flush')
    const response = deferred<{ type: 'osc'; code: 11; data: string }>()
    const send = vi.fn().mockReturnValueOnce(response.promise)
    const flush = vi.fn().mockRejectedValueOnce(flushError)
    const onThemeChange = vi.fn()
    const querier = { send, flush } as unknown as TerminalQuerier

    const cleanup = watchSystemTheme(querier, onThemeChange)
    await flushMicrotasks()

    expect(logMocks.logError).toHaveBeenCalledWith(flushError)
    response.reject(responseError)
    await flushMicrotasks()

    expect(onThemeChange).not.toHaveBeenCalled()
    cleanup()
  })
})
