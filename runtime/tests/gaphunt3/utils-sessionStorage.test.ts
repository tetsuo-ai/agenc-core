import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createProjectForTesting,
  type TestProjectHandle,
} from 'src/utils/sessionStorage.js'

// gaphunt3 #17 — Transcript write-queue drain swallows append failures:
// unhandled rejection, hung flush() promises, and lost entries.
//
// drainWriteQueue() splices a batch out of the per-file queue BEFORE writing
// it; a persistent appendToFile() rejection (ENOSPC/EDQUOT/EROFS/EACCES) used
// to (a) leave every enqueueWrite()/flush() awaiter hanging because the
// resolve callbacks never fired, and (b) escape scheduleDrain()'s uncaught
// `await this.drainWriteQueue()` as an unhandled rejection while leaving
// activeDrain stuck non-null. These tests assert the corrected, failure-
// contained behavior and fail if either fix is reverted.

const FAILING_PATH = '/tmp/gaphunt3-sessionStorage-fail.jsonl'

function lastPromptEntry(prompt: string): Parameters<TestProjectHandle['enqueueWrite']>[1] {
  // Cast through unknown — enqueueWrite only JSON-serializes the entry, so a
  // minimal valid LastPromptMessage shape exercises the drain path faithfully.
  return {
    type: 'last-prompt',
    sessionId: '00000000-0000-4000-8000-000000000017',
    lastPrompt: prompt,
  } as unknown as Parameters<TestProjectHandle['enqueueWrite']>[1]
}

describe('gaphunt3 #17: drainWriteQueue / scheduleDrain failure containment', () => {
  let project: TestProjectHandle
  let unhandled: unknown[]
  let onUnhandled: (reason: unknown) => void

  beforeEach(() => {
    vi.useFakeTimers()
    project = createProjectForTesting()
    unhandled = []
    onUnhandled = reason => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
  })

  afterEach(() => {
    process.off('unhandledRejection', onUnhandled)
    vi.useRealTimers()
  })

  it('settles every enqueueWrite promise even when appendToFile rejects persistently', async () => {
    project.setAppendOverride(async () => {
      throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' })
    })

    let settledA = false
    let settledB = false
    // A rejected enqueueWrite would still be "settled"; the bug under test is
    // that the resolvers NEVER fire (the promise hangs forever), so we track
    // settlement of either outcome and assert it actually happens.
    const a = project
      .enqueueWrite(FAILING_PATH, lastPromptEntry('a'))
      .then(() => {
        settledA = true
      })
      .catch(() => {
        settledA = true
      })
    const b = project
      .enqueueWrite(FAILING_PATH, lastPromptEntry('b'))
      .then(() => {
        settledB = true
      })
      .catch(() => {
        settledB = true
      })

    // Drive the scheduled drain (FLUSH_INTERVAL_MS) plus enough extra ticks for
    // any reschedules. Before the fix the resolvers are never invoked, so the
    // flags stay false; after the fix they fire from the finally block.
    await vi.advanceTimersByTimeAsync(project.flushIntervalMs + 50)
    await Promise.race([
      Promise.all([a, b]),
      vi.advanceTimersByTimeAsync(project.flushIntervalMs * 4),
    ])

    expect(settledA).toBe(true)
    expect(settledB).toBe(true)
  })

  it('flush() resolves (does not hang) when the drain hits a persistent append failure', async () => {
    project.setAppendOverride(async () => {
      throw Object.assign(new Error('read-only file system'), { code: 'EROFS' })
    })

    // Enqueue without awaiting, then flush. flush() awaits activeDrain and then
    // drainWriteQueue(); before the fix a rejected drain would reject/hang
    // flush(). After the fix the drain is contained and flush() resolves.
    void project.enqueueWrite(FAILING_PATH, lastPromptEntry('x'))
    void project.enqueueWrite(FAILING_PATH, lastPromptEntry('y'))

    let flushResolved = false
    let flushRejected = false
    const flushed = project
      .flush()
      .then(() => {
        flushResolved = true
      })
      .catch(() => {
        flushRejected = true
      })

    await vi.advanceTimersByTimeAsync(project.flushIntervalMs * 4)
    await Promise.race([
      flushed,
      vi.advanceTimersByTimeAsync(project.flushIntervalMs * 4),
    ])

    // flush() must SETTLE (and specifically resolve, since the failure is now
    // contained rather than propagated). Before the fix it would hang.
    expect(flushResolved || flushRejected).toBe(true)
    expect(flushResolved).toBe(true)
    expect(flushRejected).toBe(false)
  })

  it('does not leak an unhandled rejection when the scheduled drain fails', async () => {
    project.setAppendOverride(async () => {
      throw Object.assign(new Error('disk quota exceeded'), { code: 'EDQUOT' })
    })

    void project.enqueueWrite(FAILING_PATH, lastPromptEntry('z'))

    // Trigger the scheduleDrain setTimeout callback. Pre-fix, the callback's
    // uncaught `await this.drainWriteQueue()` turns the append rejection into
    // an unhandledRejection (and never nulls activeDrain). Post-fix it is
    // caught/logged and activeDrain is reset.
    await vi.advanceTimersByTimeAsync(project.flushIntervalMs + 50)
    // Flush microtasks so any escaped rejection is reported.
    await Promise.resolve()
    await Promise.resolve()

    expect(unhandled).toHaveLength(0)

    // A subsequent flush must still complete, proving activeDrain was reset
    // (a stale non-null activeDrain would be awaited forever).
    let flushDone = false
    const flushed = project.flush().then(() => {
      flushDone = true
    })
    await vi.advanceTimersByTimeAsync(project.flushIntervalMs * 2)
    await Promise.race([
      flushed,
      vi.advanceTimersByTimeAsync(project.flushIntervalMs * 4),
    ])
    expect(flushDone).toBe(true)
  })

  it('still writes successfully through the drain when appends succeed (baseline)', async () => {
    const written: Array<{ filePath: string; data: string }> = []
    project.setAppendOverride(async (filePath, data) => {
      written.push({ filePath, data })
    })

    let settled = false
    const w = project.enqueueWrite(FAILING_PATH, lastPromptEntry('ok')).then(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(project.flushIntervalMs + 50)
    await w

    expect(settled).toBe(true)
    expect(written).toHaveLength(1)
    expect(written[0].filePath).toBe(FAILING_PATH)
    expect(written[0].data).toContain('"lastPrompt":"ok"')
  })
})
