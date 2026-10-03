import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { installGlobalErrorNet } from '../../src/utils/gracefulShutdown.js'
import { installGlobalErrorNet as installLeafErrorNet } from '../../src/utils/global-error-net.js'
import {
  _resetErrorLogForTesting,
  getInMemoryErrors,
} from '../../src/utils/log.js'
import { runWithStartupProviderSelection } from '../../src/utils/model/providers.js'

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
  test('compatibility export and leaf share one memoized installer', () => {
    expect(installGlobalErrorNet).toBe(installLeafErrorNet)
    const proc = fakeProc()
    installGlobalErrorNet(proc as never)
    installLeafErrorNet(proc as never)
    expect(proc.handlers.get('uncaughtException')).toHaveLength(1)
    expect(proc.handlers.get('unhandledRejection')).toHaveLength(1)
  })
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

// Crashes must persist to the LOCAL error-log sink even with no container diag
// file set (the common local daemon/TUI case). Without the fix the handlers
// only call logForDiagnosticsNoPII, which writes nothing when
// AGENC_DIAGNOSTICS_FILE is unset — so the crash vanishes silently.
describe('installGlobalErrorNet persists crashes to the local sink', () => {
  let savedDiagFile: string | undefined
  let savedDisableReporting: string | undefined
  let savedPrivacy: string | undefined

  beforeEach(() => {
    savedDiagFile = process.env.AGENC_DIAGNOSTICS_FILE
    savedDisableReporting = process.env.DISABLE_ERROR_REPORTING
    savedPrivacy = process.env.AGENC_DISABLE_NONESSENTIAL_TRAFFIC
    // Reproduce the local-user environment: no container diagnostics file,
    // error reporting enabled (default privacy).
    delete process.env.AGENC_DIAGNOSTICS_FILE
    delete process.env.DISABLE_ERROR_REPORTING
    delete process.env.AGENC_DISABLE_NONESSENTIAL_TRAFFIC
    _resetErrorLogForTesting()
  })

  afterEach(() => {
    if (savedDiagFile === undefined) delete process.env.AGENC_DIAGNOSTICS_FILE
    else process.env.AGENC_DIAGNOSTICS_FILE = savedDiagFile
    if (savedDisableReporting === undefined)
      delete process.env.DISABLE_ERROR_REPORTING
    else process.env.DISABLE_ERROR_REPORTING = savedDisableReporting
    if (savedPrivacy === undefined)
      delete process.env.AGENC_DISABLE_NONESSENTIAL_TRAFFIC
    else process.env.AGENC_DISABLE_NONESSENTIAL_TRAFFIC = savedPrivacy
    _resetErrorLogForTesting()
  })

  test('uncaughtException reaches the persisted error log (no diag file)', () => {
    runWithStartupProviderSelection(
      { provider: 'openai', model: 'gpt-5', environment: {} },
      () => {
        const proc = fakeProc()
        installGlobalErrorNet(proc as never)
        const uncaught = proc.handlers.get('uncaughtException')![0]!

        expect(getInMemoryErrors()).toHaveLength(0)
        uncaught(new Error('local-daemon-crash-marker'))

        const errors = getInMemoryErrors()
        expect(errors).toHaveLength(1)
        expect(errors[0]!.error).toContain('local-daemon-crash-marker')
      },
    )
  })

  test('unhandledRejection reaches the persisted error log (no diag file)', () => {
    runWithStartupProviderSelection(
      { provider: 'openai', model: 'gpt-5', environment: {} },
      () => {
        const proc = fakeProc()
        installGlobalErrorNet(proc as never)
        const rejection = proc.handlers.get('unhandledRejection')![0]!

        expect(getInMemoryErrors()).toHaveLength(0)
        rejection(new Error('local-rejection-marker'))

        const errors = getInMemoryErrors()
        expect(errors).toHaveLength(1)
        expect(errors[0]!.error).toContain('local-rejection-marker')
      },
    )
  })

  test('shared crash guard blocks reentrant persistence and releases after a sink throws', () => {
    runWithStartupProviderSelection(
      { provider: 'openai', model: 'gpt-5', environment: {} },
      () => {
        const first = fakeProc()
        const second = fakeProc()
        installGlobalErrorNet(first as never)
        installLeafErrorNet(second as never)
        const uncaught = first.handlers.get('uncaughtException')![0]!
        const rejection = second.handlers.get('unhandledRejection')![0]!
        const originalConsoleError = console.error
        const originalDaemonRun = process.env.AGENC_DAEMON_RUN
        let writes = 0
        try {
          process.env.AGENC_DAEMON_RUN = '1'
          console.error = () => {
            writes++
            rejection(new Error('nested-crash-must-not-persist'))
            throw new Error('synthetic sink failure')
          }
          expect(() => uncaught(new Error('first-outer-crash'))).not.toThrow()
          expect(() => rejection(new Error('second-outer-crash'))).not.toThrow()
          expect(writes).toBe(2)
          const errors = getInMemoryErrors()
          expect(errors).toHaveLength(2)
          expect(errors.some((entry) => entry.error.includes('nested-crash-must-not-persist'))).toBe(false)
        } finally {
          console.error = originalConsoleError
          if (originalDaemonRun === undefined) delete process.env.AGENC_DAEMON_RUN
          else process.env.AGENC_DAEMON_RUN = originalDaemonRun
        }
      },
    )
  })
})
