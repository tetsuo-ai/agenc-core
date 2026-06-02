import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * Regression coverage for the subagent permission-response poller in
 * runtime/src/utils/swarm/inProcessRunner.ts.
 *
 * The poller is scheduled with setInterval. The original implementation passed
 * an `async` callback directly to setInterval, so the promise it returned was
 * discarded with no `.catch` attached. If any awaited step inside the tick
 * rejected (notably `markMessageAsReadByIndex`, which awaits `release()` in a
 * `finally` OUTSIDE its try/catch -- a `proper-lockfile` ERELEASED/ENOTACQUIRED
 * under FS contention escapes the function), the rejection surfaced as an
 * unhandled promise rejection. The fix wraps the async body in an IIFE that is
 * always `.catch`-ed and adds a `pollInFlight` guard so a slow tick cannot
 * overlap a fresh one.
 *
 * Part 1 is a behavioral test that reproduces the exact scheduling mechanism
 * and proves: (a) the buggy "async callback" form leaks an unhandled rejection,
 * while (b) the fixed "sync callback + caught IIFE + in-flight guard" form does
 * not, and serializes ticks.
 *
 * Part 2 anchors revert-sensitivity to the real source file: reverting the fix
 * (restoring `setInterval(async ...)` / dropping the guard or `.catch`) flips
 * these assertions and fails the test.
 */

const root = existsSync(resolve(process.cwd(), 'runtime/src'))
  ? resolve(process.cwd())
  : resolve(process.cwd(), '..')

const SOURCE_PATH = resolve(root, 'runtime/src/utils/swarm/inProcessRunner.ts')

// ---------------------------------------------------------------------------
// Part 1: behavioral reproduction of the scheduling fix
// ---------------------------------------------------------------------------

type TickBody = () => Promise<void>

/**
 * Faithful model of the ORIGINAL buggy pattern:
 *   setInterval(async () => { await body() }, ms)
 * setInterval ignores the returned promise; nothing catches it.
 */
function scheduleBuggy(body: TickBody, ms: number): NodeJS.Timeout {
  return setInterval(async () => {
    await body()
  }, ms)
}

/**
 * Faithful model of the FIXED pattern from inProcessRunner.ts:
 *   - sync interval callback
 *   - async work in an IIFE that is always `.catch`-ed
 *   - `pollInFlight` guard so a slow tick does not overlap a new one
 */
function scheduleFixed(
  body: TickBody,
  ms: number,
  onError: (err: unknown) => void,
): { timer: NodeJS.Timeout; getStartedTicks: () => number } {
  let pollInFlight = false
  let startedTicks = 0
  const timer = setInterval(() => {
    if (pollInFlight) return
    pollInFlight = true
    startedTicks += 1
    void body()
      .catch(onError)
      .finally(() => {
        pollInFlight = false
      })
  }, ms)
  return { timer, getStartedTicks: () => startedTicks }
}

describe('inProcessRunner permission poll scheduling (behavioral model)', () => {
  let captured: unknown[]
  let handler: (reason: unknown) => void

  beforeEach(() => {
    captured = []
    handler = reason => {
      captured.push(reason)
    }
    process.on('unhandledRejection', handler)
  })

  afterEach(() => {
    process.off('unhandledRejection', handler)
  })

  async function flushUnhandledRejections(): Promise<void> {
    // Unhandled-rejection detection is asynchronous; give the microtask queue
    // and the event loop enough turns to surface anything that leaked.
    for (let i = 0; i < 5; i++) {
      await new Promise(r => setImmediate(r))
    }
  }

  it('the buggy async-callback form leaks an unhandled rejection (documents the bug)', async () => {
    const rejector: TickBody = () =>
      Promise.reject(new Error('release() failed under lock contention'))

    const timer = scheduleBuggy(rejector, 5)
    await new Promise(r => setTimeout(r, 30))
    clearInterval(timer)
    await flushUnhandledRejections()

    // The whole point of the bug: the discarded promise rejects with no handler.
    expect(captured.length).toBeGreaterThan(0)
  })

  it('the fixed form never leaks an unhandled rejection even when a tick rejects', async () => {
    const errors: unknown[] = []
    const rejector: TickBody = () =>
      Promise.reject(new Error('release() failed under lock contention'))

    const { timer } = scheduleFixed(rejector, 5, err => errors.push(err))
    await new Promise(r => setTimeout(r, 30))
    clearInterval(timer)
    await flushUnhandledRejections()

    // Nothing escaped to the process; the IIFE `.catch` handled it.
    expect(captured.length).toBe(0)
    expect(errors.length).toBeGreaterThan(0)
  })

  it('the in-flight guard prevents overlapping ticks when a tick is slower than the interval', async () => {
    let concurrent = 0
    let maxConcurrent = 0
    const slow: TickBody = async () => {
      concurrent += 1
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      // Each tick takes much longer than the 5ms interval.
      await new Promise(r => setTimeout(r, 40))
      concurrent -= 1
    }

    const { timer, getStartedTicks } = scheduleFixed(slow, 5, () => {})
    await new Promise(r => setTimeout(r, 120))
    clearInterval(timer)
    // Let any final tick body settle.
    await new Promise(r => setTimeout(r, 60))
    await flushUnhandledRejections()

    expect(maxConcurrent).toBe(1)
    // Without the guard, ~24 ticks would have started in 120ms at 5ms each;
    // with serialization, far fewer bodies actually run.
    expect(getStartedTicks()).toBeLessThan(10)
    expect(captured.length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Part 2: source contract anchoring the behavioral fix to the real file
// ---------------------------------------------------------------------------

describe('inProcessRunner permission poll source contract', () => {
  const source = readFileSync(SOURCE_PATH, 'utf8')

  it('does not pass an async callback straight to the permission poll setInterval', () => {
    // The buggy form was: `const pollInterval = setInterval(\n  async (abortController, ...`
    // Reverting the fix reintroduces this exact shape.
    expect(source).not.toMatch(/pollInterval = setInterval\(\s*async\b/)
  })

  it('guards overlapping permission poll ticks with an in-flight flag', () => {
    expect(source).toContain('pollInFlight')
  })

  it('always catches the async permission poll tick body', () => {
    // The fixed IIFE is `void (async () => { ... })()\n  .catch(...)`.
    expect(source).toMatch(/void \(async \(\) => \{/)
    expect(source).toMatch(/\.catch\(error =>/)
  })
})
