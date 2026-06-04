import { describe, expect, test } from 'bun:test'

import { installGlobalErrorNet } from '../../src/utils/gracefulShutdown.js'

type Handler = (...args: unknown[]) => void

// A throwaway stand-in for `process` so we never register swallowing handlers
// on the real process (which would mask the test runner's own rejection
// detection). A fresh object per call keeps the memoize on installGlobalErrorNet
// keyed per-process, so tests don't bleed registrations into one another.
function fakeProc(): { on: Handler; handlers: Map<string, Handler[]> } {
  const handlers = new Map<string, Handler[]>()
  const proc = {
    on(event: string, handler: Handler) {
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
      return proc
    },
    handlers,
  }
  return proc
}

describe('installGlobalErrorNet', () => {
  test('registers uncaughtException + unhandledRejection handlers', () => {
    const proc = fakeProc()
    installGlobalErrorNet(proc as never)
    expect(proc.handlers.get('uncaughtException')).toHaveLength(1)
    expect(proc.handlers.get('unhandledRejection')).toHaveLength(1)
  })

  test('is non-exiting: handlers only log and never re-throw', () => {
    const proc = fakeProc()
    installGlobalErrorNet(proc as never)
    const uncaught = proc.handlers.get('uncaughtException')![0]!
    const rejection = proc.handlers.get('unhandledRejection')![0]!
    // A real process.exit would throw here (it is not stubbed); the handlers
    // must only log. Cover an Error and a non-Error rejection reason.
    expect(() => uncaught(new TypeError('boom'))).not.toThrow()
    expect(() => rejection(new Error('y'))).not.toThrow()
    expect(() => rejection('plain string reason')).not.toThrow()
  })

  test('is idempotent per process (memoized) — a second call does not re-register', () => {
    const proc = fakeProc()
    installGlobalErrorNet(proc as never)
    installGlobalErrorNet(proc as never)
    expect(proc.handlers.get('uncaughtException')).toHaveLength(1)
    expect(proc.handlers.get('unhandledRejection')).toHaveLength(1)
  })
})
