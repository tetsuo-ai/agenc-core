import { afterEach, describe, expect, it, vi } from 'vitest'

import { createCombinedAbortSignal } from '../../src/utils/combinedAbortSignal.js'

describe('createCombinedAbortSignal', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('preserves the primary signal abort reason', () => {
    const primary = new AbortController()
    const combined = createCombinedAbortSignal(primary.signal)
    const reason = new Error('primary cancelled')

    primary.abort(reason)

    expect(combined.signal.aborted).toBe(true)
    expect(combined.signal.reason).toBe(reason)
    combined.cleanup()
  })

  it('preserves the secondary signal abort reason', () => {
    const primary = new AbortController()
    const secondary = new AbortController()
    const combined = createCombinedAbortSignal(primary.signal, {
      signalB: secondary.signal,
    })
    const reason = new Error('secondary cancelled')

    secondary.abort(reason)

    expect(combined.signal.aborted).toBe(true)
    expect(combined.signal.reason).toBe(reason)
    combined.cleanup()
  })

  it('uses primary-signal precedence when both inputs are already aborted', () => {
    const primary = new AbortController()
    const secondary = new AbortController()
    const primaryReason = new Error('primary first')
    primary.abort(primaryReason)
    secondary.abort(new Error('secondary first'))

    const combined = createCombinedAbortSignal(primary.signal, {
      signalB: secondary.signal,
    })

    expect(combined.signal.aborted).toBe(true)
    expect(combined.signal.reason).toBe(primaryReason)
  })

  it('retains the existing timeout abort behavior', () => {
    vi.useFakeTimers()
    const combined = createCombinedAbortSignal(undefined, { timeoutMs: 25 })

    vi.advanceTimersByTime(24)
    expect(combined.signal.aborted).toBe(false)

    vi.advanceTimersByTime(1)
    expect(combined.signal.aborted).toBe(true)
    expect(combined.signal.reason).toBeInstanceOf(DOMException)
    expect((combined.signal.reason as DOMException).name).toBe('AbortError')
    combined.cleanup()
  })

  it('cleanup detaches both inputs and cancels the timeout', () => {
    vi.useFakeTimers()
    const primary = new AbortController()
    const secondary = new AbortController()
    const combined = createCombinedAbortSignal(primary.signal, {
      signalB: secondary.signal,
      timeoutMs: 25,
    })

    combined.cleanup()
    primary.abort(new Error('primary cancelled'))
    secondary.abort(new Error('secondary cancelled'))
    vi.advanceTimersByTime(25)

    expect(combined.signal.aborted).toBe(false)
  })
})
