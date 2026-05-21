import { afterEach, describe, expect, test, vi } from 'vitest'

import {
  getTerminalFocused,
  getTerminalFocusState,
  resetTerminalFocusState,
  setTerminalFocused,
  subscribeTerminalFocus,
} from '../../../src/tui/ink/terminal-focus-state.js'

afterEach(() => {
  resetTerminalFocusState()
  vi.restoreAllMocks()
})

describe('terminal-focus-state coverage swarm row 125', () => {
  test('treats the default unknown state as focused', () => {
    expect(getTerminalFocusState()).toBe('unknown')
    expect(getTerminalFocused()).toBe(true)
  })

  test('tracks focused and blurred states', () => {
    setTerminalFocused(false)

    expect(getTerminalFocusState()).toBe('blurred')
    expect(getTerminalFocused()).toBe(false)

    setTerminalFocused(true)

    expect(getTerminalFocusState()).toBe('focused')
    expect(getTerminalFocused()).toBe(true)
  })

  test('notifies subscribers synchronously and stops after unsubscribe', () => {
    const seen: Array<{
      focused: boolean
      state: ReturnType<typeof getTerminalFocusState>
    }> = []
    const subscriber = vi.fn(() => {
      seen.push({
        focused: getTerminalFocused(),
        state: getTerminalFocusState(),
      })
    })
    const unsubscribe = subscribeTerminalFocus(subscriber)

    setTerminalFocused(false)

    expect(subscriber).toHaveBeenCalledOnce()
    expect(seen).toEqual([{ focused: false, state: 'blurred' }])

    unsubscribe()
    setTerminalFocused(true)

    expect(subscriber).toHaveBeenCalledOnce()
    expect(getTerminalFocusState()).toBe('focused')
  })

  test('notifies every current subscriber in insertion order', () => {
    const calls: string[] = []
    const unsubscribeFirst = subscribeTerminalFocus(() => {
      calls.push(`first:${getTerminalFocusState()}`)
    })
    const unsubscribeSecond = subscribeTerminalFocus(() => {
      calls.push(`second:${getTerminalFocusState()}`)
    })

    setTerminalFocused(false)
    unsubscribeFirst()
    setTerminalFocused(true)
    unsubscribeSecond()

    expect(calls).toEqual(['first:blurred', 'second:blurred', 'second:focused'])
  })

  test('reset restores unknown focus and notifies active subscribers', () => {
    setTerminalFocused(false)
    const subscriber = vi.fn()
    const unsubscribe = subscribeTerminalFocus(subscriber)

    resetTerminalFocusState()

    expect(getTerminalFocusState()).toBe('unknown')
    expect(getTerminalFocused()).toBe(true)
    expect(subscriber).toHaveBeenCalledOnce()

    unsubscribe()
  })

  test('unsubscribe is idempotent', () => {
    const subscriber = vi.fn()
    const unsubscribe = subscribeTerminalFocus(subscriber)

    unsubscribe()
    unsubscribe()
    setTerminalFocused(false)

    expect(subscriber).not.toHaveBeenCalled()
  })
})
