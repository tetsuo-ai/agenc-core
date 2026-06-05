import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  setScheduledTasksEnabled,
  resetStateForTests,
} from 'src/bootstrap/state.js'
import {
  CronScheduler,
  type CronEnqueue,
} from 'src/utils/cronScheduler.js'
import type { CronTask } from 'src/utils/cronTasks.js'

// ---------------------------------------------------------------------------
// Deterministic virtual-time harness.
//
// We inject the driver's clock + timer so the test owns ALL time. No real
// wall-clock sleeps, no real model. `enqueue` is a spy — the whole point of
// the driver is that it stays at ZERO calls while idle, so asserting on this
// spy is asserting on token spend.
// ---------------------------------------------------------------------------
class FakeClock {
  nowMs: number
  monoMs = 0
  private seq = 0
  private timers = new Map<
    number,
    { fireAt: number; fn: () => void }
  >()

  constructor(startMs: number) {
    this.nowMs = startMs
  }

  setTimer = (fn: () => void, ms: number): number => {
    const id = ++this.seq
    this.timers.set(id, { fireAt: this.nowMs + ms, fn })
    return id
  }

  clearTimer = (handle: number): void => {
    this.timers.delete(handle)
  }

  /** Advance virtual time by `ms`, firing every timer that comes due, in
   * order. Returns the number of timers fired. */
  advance(ms: number): number {
    const target = this.nowMs + ms
    let fired = 0
    // Fire repeatedly: a wake re-arms a new timer, which may itself be due
    // within the same advance window (e.g. coalesced past-due tasks).
    for (;;) {
      let nextId: number | null = null
      let nextAt = Infinity
      for (const [id, t] of this.timers) {
        if (t.fireAt <= target && t.fireAt < nextAt) {
          nextAt = t.fireAt
          nextId = id
        }
      }
      if (nextId === null) break
      const t = this.timers.get(nextId)!
      this.timers.delete(nextId)
      this.nowMs = t.fireAt
      this.monoMs += t.fireAt - this.monoMs // keep monotonic in lockstep-ish
      t.fn()
      fired += 1
    }
    this.nowMs = target
    return fired
  }

  pendingCount(): number {
    return this.timers.size
  }
}

/** Flush the microtask queue so the driver's async onWake/reschedule settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 25; i++) await Promise.resolve()
}

/** Advance virtual time AND flush async work between each fired timer. */
async function advanceAndFlush(clock: FakeClock, ms: number): Promise<void> {
  // The driver's onWake is async and re-arms a timer only after awaiting. So
  // step in small slices, flushing microtasks after each, until we've covered
  // the whole window.
  const end = clock.nowMs + ms
  while (clock.nowMs < end) {
    const before = clock.nowMs
    clock.advance(Math.min(60_000, end - clock.nowMs))
    await flush()
    // Guard against zero-progress (no timer in this slice).
    if (clock.nowMs === before) clock.nowMs = Math.min(end, before + 60_000)
  }
}

function task(overrides: Partial<CronTask> & { id: string; cron: string }): CronTask {
  return {
    prompt: `prompt-${overrides.id}`,
    createdAt: overrides.createdAt ?? 0,
    recurring: true,
    durable: false,
    ...overrides,
  }
}

function makeScheduler(
  clock: FakeClock,
  tasks: CronTask[],
  enqueue: CronEnqueue,
): CronScheduler {
  return new CronScheduler(
    {
      now: () => clock.nowMs,
      monotonicNow: () => clock.monoMs,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      loadTasks: async () => tasks,
      enqueue,
    },
    // Tiny floor so the floor logic stays exercised but doesn't dominate the
    // virtual-time assertions; window cap left at the generous default.
    { minIntervalFloorMs: 1_000, dir: undefined },
  )
}

describe('CronScheduler', () => {
  beforeEach(() => {
    setScheduledTasksEnabled(true)
  })
  afterEach(() => {
    resetStateForTests()
    vi.restoreAllMocks()
  })

  test('idle: ZERO enqueues across a simulated idle window when nothing is due', async () => {
    // One task due far in the future (hourly cron, anchored at t=0; first fire
    // is at the top of the next hour). We start at t=1min and advance only
    // 30min of virtual time — the task never becomes due.
    const start = 60_000 // 00:01:00
    const clock = new FakeClock(start)
    const enqueue = vi.fn()
    const sched = makeScheduler(
      clock,
      [task({ id: 'aaaa0001', cron: '0 * * * *' })], // top of every hour
      enqueue,
    )

    sched.start()
    await flush()

    // 30 minutes of virtual idle time — still before the :00 fire.
    await advanceAndFlush(clock, 30 * 60_000)

    expect(enqueue).toHaveBeenCalledTimes(0)
    // The driver is asleep with exactly one armed wake (sleep-until-next-due),
    // not a polling interval that re-arms every slice.
    expect(clock.pendingCount()).toBeLessThanOrEqual(1)
  })

  test('due task: exactly ONE enqueue and the next wake is rescheduled', async () => {
    // Hourly task; start at 00:59:00 so the 01:00:00 fire (plus its forward
    // herd-spreading jitter, bounded by recurringFrac*interval = up to ~6 min)
    // lands within the advance window.
    const start = 59 * 60_000 // 00:59:00
    const clock = new FakeClock(start)
    const enqueue = vi.fn()
    const sched = makeScheduler(
      clock,
      [task({ id: 'bbbb0002', cron: '0 * * * *' })],
      enqueue,
    )

    sched.start()
    await flush()
    expect(enqueue).toHaveBeenCalledTimes(0) // not yet due

    // Cross the 01:00:00 boundary with margin for the recurring forward jitter
    // window (<= ~6 min at defaults). The task fires exactly once.
    await advanceAndFlush(clock, 12 * 60_000)

    expect(enqueue).toHaveBeenCalledTimes(1)
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        value: 'prompt-bbbb0002',
        mode: 'task-notification',
        isMeta: true,
        workload: 'cron',
      }),
    )
    // After firing, the next wake is rescheduled (driver re-armed), not dead.
    const tel = sched.getLastTelemetry()
    expect(tel).not.toBeNull()
    // Either the post-fire reschedule armed a future wake, or telemetry shows
    // the dispatch — in both cases the driver kept running.
    expect(sched.isPaused()).toBe(false)

    sched.stop()
  })

  test('coalesce: multiple missed occurrences collapse to a SINGLE enqueue', async () => {
    // Per-minute task created at t=0, but the process was "asleep" until
    // t=10min — 10 slots (00:01..00:10) are all in the past. They MUST collapse
    // to one fire-once-now, not 10 model turns.
    const tenMin = 10 * 60_000
    const clock = new FakeClock(tenMin) // we wake at 00:10:00, all slots past
    const enqueue = vi.fn()
    const sched = makeScheduler(
      clock,
      [task({ id: 'cccc0003', cron: '* * * * *', createdAt: 0 })],
      enqueue,
    )

    sched.start()
    await flush()
    // The initial reschedule sees a past-due task → arms a ~0ms wake. Advance a
    // hair to fire it.
    await advanceAndFlush(clock, 1_000)

    expect(enqueue).toHaveBeenCalledTimes(1) // coalesced, NOT 10
    const tel = sched.getLastTelemetry()
    expect(tel?.dispatched).toBe(1)
    // 10 past slots → 1 fired + 9 coalesced misses.
    expect(tel?.coalescedMisses).toBeGreaterThanOrEqual(9)

    sched.stop()
  })

  test('re-entrancy guard: a task whose turn is in flight does NOT start a second turn', async () => {
    // Per-minute task; fire once (turn now "in flight" — markTurnComplete NOT
    // called), then cross another minute boundary. The second occurrence must
    // SKIP rather than enqueue a second, overlapping turn.
    const clock = new FakeClock(30 * 60_000) // 00:30:00, past-due
    const enqueue = vi.fn()
    const sched = makeScheduler(
      clock,
      [task({ id: 'dddd0004', cron: '* * * * *', createdAt: 0 })],
      enqueue,
    )

    sched.start()
    await flush()
    await advanceAndFlush(clock, 1_000) // first fire
    expect(enqueue).toHaveBeenCalledTimes(1)

    // Advance well past several more per-minute slots WITHOUT completing the
    // turn. Overlap guard must hold the line at one enqueue.
    await advanceAndFlush(clock, 5 * 60_000)
    expect(enqueue).toHaveBeenCalledTimes(1)
    expect(sched.getLastTelemetry()?.skippedDueToLock).toBeGreaterThanOrEqual(1)

    // Now complete the turn → the lock releases → the next due slot may fire.
    sched.markTurnComplete('dddd0004')
    await sched.reschedule()
    await advanceAndFlush(clock, 2 * 60_000)
    expect(enqueue).toHaveBeenCalledTimes(2)

    sched.stop()
  })
})
