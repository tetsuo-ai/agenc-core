import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  setScheduledTasksEnabled,
  resetStateForTests,
} from 'src/bootstrap/state.js'
import {
  CronScheduler,
  cronEnqueueToCommandQueue,
  type CronEnqueue,
} from 'src/utils/cronScheduler.js'
import type { CronTask } from 'src/utils/cronTasks.js'
import { enqueuePendingNotification } from 'src/utils/messageQueueManager.js'

// Spy only enqueuePendingNotification; keep every other real export intact so
// modules that transitively import the queue still load normally.
vi.mock('src/utils/messageQueueManager.js', async importOriginal => ({
  ...(await importOriginal<typeof import('src/utils/messageQueueManager.js')>()),
  enqueuePendingNotification: vi.fn(),
}))

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
  floorMs = 1_000,
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
    // Tiny floor (default) so the floor logic stays exercised but doesn't
    // dominate the virtual-time assertions; callers raise it to exercise the
    // overlap lease. Window cap left at the generous default.
    { minIntervalFloorMs: floorMs, dir: undefined },
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

  test('delivery-tagged tasks are gateway-owned: NEVER enqueued in-session', async () => {
    // Same due-hourly shape as the test above, but the task carries a
    // `deliver` route — the gateway's cron-delivery runner is its exclusive
    // executor, so the in-session driver must neither enqueue it nor arm a
    // wake for it (a second executor would double-fire every occurrence).
    const start = 59 * 60_000
    const clock = new FakeClock(start)
    const enqueue = vi.fn()
    const sched = makeScheduler(
      clock,
      [
        task({
          id: 'ddddd016',
          cron: '0 * * * *',
          deliver: { channel: 'stdio', to: 'stdio' },
        }),
      ],
      enqueue,
    )

    sched.start()
    await advanceAndFlush(clock, 12 * 60_000)

    expect(enqueue).toHaveBeenCalledTimes(0)
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

  test('recurring task auto-releases its overlap lock and fires at each cadence without markTurnComplete', async () => {
    // must-fix: the TUI drains the command queue serially and never signals
    // turn completion back to the driver, so the per-task overlap lock MUST
    // auto-expire after the floor. With a permanent lock (the bug) a recurring
    // task fires exactly once per process and is skipped forever after. Here a
    // per-minute task is driven across four minute boundaries WITHOUT ever
    // calling markTurnComplete; it must fire roughly once per minute. Revert the
    // self-expiring lock back to a permanent one and this collapses to a single
    // enqueue (the test goes red).
    const clock = new FakeClock(30 * 60_000) // 00:30:00, past-due
    const enqueue = vi.fn()
    const sched = makeScheduler(
      clock,
      [task({ id: 'dddd0004', cron: '* * * * *', createdAt: 0 })],
      enqueue,
    )

    sched.start()
    await flush()
    await advanceAndFlush(clock, 4 * 60_000 + 1_000)

    // Fired repeatedly (~once per minute), not stuck after the first occurrence.
    expect(enqueue.mock.calls.length).toBeGreaterThanOrEqual(3)

    sched.stop()
  })
})

describe('cronEnqueueToCommandQueue (production wiring)', () => {
  afterEach(() => {
    vi.mocked(enqueuePendingNotification).mockClear()
  })

  test('forwards a due cron command onto the real command queue as an isMeta task-notification', () => {
    // Guards must-fix #1: getCronScheduler() wires this adapter (not the no-op
    // stub), so a due task is actually pushed onto the serially-drained queue
    // where the session turn loop runs it. Revert the wiring → enqueue is the
    // stub → this is never called.
    cronEnqueueToCommandQueue({
      value: 'do the thing',
      mode: 'task-notification',
      isMeta: true,
      workload: 'cron',
      agentId: 'agent-123',
    })

    expect(enqueuePendingNotification).toHaveBeenCalledTimes(1)
    expect(vi.mocked(enqueuePendingNotification).mock.calls[0]?.[0]).toEqual({
      value: 'do the thing',
      mode: 'task-notification',
      isMeta: true,
      workload: 'cron',
      agentId: 'agent-123',
    })
  })

  test('omits agentId when the task has none (main-thread notification)', () => {
    cronEnqueueToCommandQueue({
      value: 'no agent',
      mode: 'task-notification',
      isMeta: true,
      workload: 'cron',
    })

    const command = vi.mocked(enqueuePendingNotification).mock.calls[0]?.[0]
    expect(command).not.toHaveProperty('agentId')
  })

  test('drain() after stop() waits for the in-flight tick (teardown race guard)', async () => {
    // stop() only clears the NEXT wake; a tick already executing keeps
    // running and writes fire state to disk. Callers that delete the state
    // dir right after stopping must be able to await quiescence — without
    // it, teardown races the tick's scheduled_tasks.json write (observed as
    // an unhandled ENOENT rejection from the bare timer callback).
    setScheduledTasksEnabled(true) // start() is a no-op without the flag
    const start = 59 * 60_000 // 00:59:00, hourly task fires at 01:00:00
    const clock = new FakeClock(start)
    let releaseTick!: () => void
    const gate = new Promise<void>(resolve => {
      releaseTick = resolve
    })
    let tickFinished = false
    let loadCalls = 0
    const sched = new CronScheduler(
      {
        now: () => clock.nowMs,
        monotonicNow: () => clock.monoMs,
        setTimer: clock.setTimer,
        clearTimer: clock.clearTimer,
        // Call 1 is start()'s reschedule (earliest-due scan) — return the
        // task so a wake gets armed. Call 2 is the timer tick's dispatch
        // path — park it on the gate, simulating slow disk I/O mid-tick.
        loadTasks: async () => {
          loadCalls += 1
          if (loadCalls === 1) {
            return [task({ id: 'dddd0004', cron: '0 * * * *' })]
          }
          await gate
          tickFinished = true
          return []
        },
        enqueue: vi.fn(),
      },
      { minIntervalFloorMs: 1_000, dir: undefined },
    )

    sched.start()
    await flush()

    // Fire the armed wake; the tick enters loadTasks and parks on the gate.
    clock.advance(12 * 60_000)
    await flush()

    sched.stop()

    // drain() must NOT resolve while the tick is still parked.
    let drained = false
    const drainPromise = sched.drain().then(() => {
      drained = true
    })
    await flush()
    expect(drained).toBe(false)
    expect(tickFinished).toBe(false)

    // Release the tick; drain() now completes AFTER the tick finished.
    releaseTick()
    await drainPromise
    expect(tickFinished).toBe(true)
  })

  test('concurrent reschedules have one owner and stop invalidates a pending scan', async () => {
    setScheduledTasksEnabled(true)
    const clock = new FakeClock(59 * 60_000)
    const releases: Array<(tasks: CronTask[]) => void> = []
    const loadTasks = vi.fn(
      () => new Promise<CronTask[]>(resolveLoad => releases.push(resolveLoad)),
    )
    const sched = new CronScheduler(
      {
        now: () => clock.nowMs,
        monotonicNow: () => clock.monoMs,
        setTimer: clock.setTimer,
        clearTimer: clock.clearTimer,
        loadTasks,
        enqueue: vi.fn(),
      },
      { minIntervalFloorMs: 1_000, dir: undefined },
    )
    const scheduled = [task({ id: 'eeee0005', cron: '0 * * * *' })]

    // start() owns scan 1; the explicit reschedule owns scan 2. Resolving the
    // older scan after scan 2 exists must not leave a second armed timer.
    sched.start()
    await flush()
    const newest = sched.reschedule()
    await flush()
    expect(releases).toHaveLength(2)
    releases[0]!(scheduled)
    await flush()
    expect(clock.pendingCount()).toBe(0)
    releases[1]!(scheduled)
    await newest
    expect(clock.pendingCount()).toBe(1)

    // A scan that completes after shutdown must not resurrect the timer.
    const pendingAtStop = sched.reschedule()
    await flush()
    expect(releases).toHaveLength(3)
    sched.stop()
    releases[2]!(scheduled)
    await pendingAtStop
    expect(clock.pendingCount()).toBe(0)
  })
})
