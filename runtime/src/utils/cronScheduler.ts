// Token-efficient cron tick driver.
//
// The hard requirement here: **idle MUST cost ZERO model invocations.** A
// previous heartbeat that woke the model on a fixed interval to ask "anything
// to do?" silently burned tokens around the clock — this driver is built to
// make that failure mode impossible.
//
// Design (sleep-until-next-due, NOT poll-then-check):
//   - We keep one sorted view of the enabled cron tasks keyed by next-due
//     epoch ms and arm a SINGLE setTimeout to the *earliest* due moment. We
//     never `setInterval(check)` and we never walk all records on a timer.
//   - The timer wake runs only cheap, deterministic, NON-model code: read the
//     clock, find the tasks that are actually due, coalesce missed slots, take
//     the per-task lock, then enqueue. The "should I run?" decision is made in
//     local code — the model is invoked ONLY when a concretely-due, runnable
//     task dispatches.
//   - While no task is due (or there are no tasks) the process is asleep and
//     issues ZERO enqueues. An empty schedule arms no timer at all.
//   - The sleep is interruptible: reschedule() re-arms to the new earliest due
//     time (so adding an earlier task preempts the current sleep) and stop()
//     clears the timer (shutdown wakes the sleeper immediately).
//
// Coalescing: on wake, every scheduled instant already in the past for a given
// task collapses to AT MOST ONE enqueue (fire-once-now), then next_due is
// recomputed from the canonical cron schedule against the current clock — we
// never replay N missed slots as N model turns, and we never accumulate
// `next += interval` off a drifting timer.
//
// Re-entrancy: at most one tick runs at a time, and at most one turn is
// in-flight per task. A task whose previous turn has not completed SKIPS this
// occurrence (it is already coalesced) rather than starting a second turn.
//
// Bounds & observability: jitter + a min-interval floor stop a self-rescheduling
// task from tight-looping the model and stop a synchronized thundering herd;
// structured telemetry is emitted on every wake/dispatch.

import { getScheduledTasksEnabled } from '../bootstrap/state.js'
import { logForDebugging } from './debug.js'
import { monotonicMs } from './monotonic.js'
import {
  DEFAULT_CRON_JITTER_CONFIG,
  jitteredNextCronRunMs,
  listAllCronTasks,
  markCronTasksFired,
  nextCronRunMs,
  oneShotJitteredNextCronRunMs,
  removeCronTasks,
  type CronTask,
} from './cronTasks.js'

/**
 * Minimal enqueue surface the driver needs. Matches
 * {@link import('./messageQueueManager.js').enqueuePendingNotification} but is
 * injected so tests can assert ZERO model turns when idle without pulling in
 * the React/TUI command-queue module. The real call site passes the actual
 * queue function.
 */
export type CronEnqueue = (command: {
  value: string
  mode: 'task-notification'
  isMeta: true
  workload: string
  agentId?: string
}) => void

/** Injectable clocks/timer so tests can drive the driver with fake timers. */
export type CronSchedulerDeps = {
  /** Wall-clock now in epoch ms. Used for the cron (calendar) computation. */
  now: () => number
  /**
   * Monotonic now in ms, used ONLY for the min-interval floor between model
   * invocations. Immune to NTP steps / suspend-resume; never used for the
   * calendar computation (cron is inherently wall-clock).
   */
  monotonicNow: () => number
  setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer: (handle: ReturnType<typeof setTimeout>) => void
  /** Load the currently-enabled tasks (file-backed + session). */
  loadTasks: (dir?: string) => Promise<CronTask[]>
  enqueue: CronEnqueue
}

const defaultDeps: CronSchedulerDeps = {
  now: () => Date.now(),
  monotonicNow: () => monotonicMs(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: handle => clearTimeout(handle),
  loadTasks: dir => listAllCronTasks(dir),
  enqueue: () => {
    // Default stub: never invokes the model. The real call site overrides this
    // with the TUI command queue (enqueuePendingNotification). Keeping a no-op
    // default means an un-wired driver can never surprise-spend tokens.
  },
}

export type CronSchedulerOptions = {
  /**
   * Minimum ms between consecutive model invocations for a SINGLE task. If a
   * task's recomputed next_due is sooner than now + floor, it is clamped to
   * now + floor so a task whose schedule keeps resolving to ~now can never
   * tight-loop the model (the agent-cost busy-loop).
   */
  minIntervalFloorMs: number
  /**
   * Hard ceiling on enqueues per rolling window. When exceeded the schedule
   * pauses (does NOT keep firing) until resume() is called. A regressed
   * heartbeat that started spamming the model trips this instead of running up
   * a bill.
   */
  maxInvocationsPerWindow: number
  /** Rolling-window length for {@link maxInvocationsPerWindow}, in ms. */
  windowMs: number
  /** Project dir override (daemon). Undefined → getProjectRoot()/session merge. */
  dir?: string
}

export const DEFAULT_CRON_SCHEDULER_OPTIONS: CronSchedulerOptions = {
  // A self-rescheduling task can never invoke the model more than once every
  // 30s, regardless of how its cron resolves.
  minIntervalFloorMs: 30_000,
  // At most 60 fires/hour by default — far above any sane cron cadence, but a
  // hard backstop against a runaway loop.
  maxInvocationsPerWindow: 60,
  windowMs: 60 * 60 * 1000,
}

/** Per-dispatch telemetry, emitted to the debug log and exposed for tests. */
export type CronTickTelemetry = {
  /** Epoch ms when this wake fired. */
  firedAt: number
  /** Tasks dispatched (one enqueue each) this tick. */
  dispatched: number
  /** Occurrences collapsed into a single fire-once-now (sum across tasks). */
  coalescedMisses: number
  /** Occurrences skipped because the task's previous turn was still in flight. */
  skippedDueToLock: number
  /** ms until the next armed wake, or null if nothing is scheduled. */
  nextWakeInMs: number | null
}

/**
 * Single timer-driven cron dispatcher. Construct once, call start(); it arms a
 * sleep-until-next-due timer and only wakes the model when a task is genuinely
 * due. Idle = zero enqueues.
 */
export class CronScheduler {
  private readonly deps: CronSchedulerDeps
  private readonly opts: CronSchedulerOptions
  private timer: ReturnType<typeof setTimeout> | null = null
  private running = false
  /** True while a tick (the local wake path) is executing — re-entrancy guard. */
  private tickInFlight = false
  /** Task ids whose enqueued turn has not yet completed — overlap guard. */
  private readonly inFlightTasks = new Set<string>()
  /** Monotonic ms of the last enqueue per task — drives the min-interval floor. */
  private readonly lastInvokedAt = new Map<string, number>()
  /**
   * Wall-clock instant (epoch ms) through which each task has already been
   * dispatched this process. The effective schedule anchor is the LATER of
   * this and the task's persisted lastFiredAt/createdAt, so a fired task always
   * advances to its NEXT future slot instead of re-resolving to the same
   * past-due instant and re-firing in a tight loop. This is what makes "fire
   * once now, then recompute next_due from the canonical schedule" hold even
   * for session tasks whose fire time is never written to disk.
   */
  private readonly firedThrough = new Map<string, number>()
  /** Wall-clock ms of recent enqueues, trimmed to the rolling window. */
  private invocationLog: number[] = []
  private paused = false
  private lastTelemetry: CronTickTelemetry | null = null
  /**
   * Set by dispatchDue() so the immediately-following reschedule() patches the
   * dispatch telemetry's nextWakeInMs instead of clobbering it with a fresh
   * idle record. Cleared once consumed.
   */
  private dispatchAwaitingNextWake = false

  constructor(
    deps: Partial<CronSchedulerDeps> = {},
    opts: Partial<CronSchedulerOptions> = {},
  ) {
    this.deps = { ...defaultDeps, ...deps }
    this.opts = { ...DEFAULT_CRON_SCHEDULER_OPTIONS, ...opts }
  }

  /** Last tick's telemetry (for tests / observability). */
  getLastTelemetry(): CronTickTelemetry | null {
    return this.lastTelemetry
  }

  /** Whether the schedule auto-paused after tripping the invocation cap. */
  isPaused(): boolean {
    return this.paused
  }

  /**
   * Begin dispatching. Gated behind getScheduledTasksEnabled() so the default
   * (OFF) means literally zero surprise token use — start() is a no-op until a
   * CronCreate flips the flag. Idempotent.
   */
  start(): void {
    if (this.running) return
    if (!getScheduledTasksEnabled()) return
    this.running = true
    void this.reschedule()
  }

  /**
   * Stop the driver. Clears the armed timer immediately (the interruptible
   * sleep's shutdown path) so no further wakes occur. In-flight turns are not
   * cancelled but no NEW tick will run.
   */
  stop(): void {
    this.running = false
    this.clearTimer()
  }

  /** Resume after a pause (manual or post-cap), re-arming the next wake. */
  resume(): void {
    this.paused = false
    void this.reschedule()
  }

  /**
   * Mark a task's turn complete, releasing its overlap lock. The turn-runner
   * calls this when the enqueued prompt's turn fully finishes (success or
   * failure) so the next occurrence may dispatch.
   */
  markTurnComplete(taskId: string): void {
    this.inFlightTasks.delete(taskId)
  }

  /**
   * Recompute the earliest due moment across all enabled tasks and arm a
   * SINGLE timer to wake exactly then. Interruptible: calling this again (e.g.
   * after a CronCreate adds an earlier task) clears the old timer and arms the
   * new, earlier one — no polling, no oversleeping new work. An empty schedule
   * arms no timer (zero CPU, zero model calls).
   */
  async reschedule(): Promise<void> {
    if (!this.running || this.paused) return
    this.clearTimer()

    const dueAt = await this.earliestDueAt()
    if (dueAt === null) {
      // No tasks (or none with a future fire). Stay asleep. Zero model calls.
      this.recordNextWake(null)
      return
    }

    // Bound the delay to >= 0; a due-in-the-past task fires on the next tick of
    // the event loop. setTimeout clamps huge delays oddly across runtimes, so
    // cap the single sleep to the window length and re-arm on wake — this also
    // recomputes from the canonical schedule each time (no drift accumulation).
    const wait = Math.min(
      Math.max(0, dueAt - this.deps.now()),
      this.opts.windowMs,
    )
    this.recordNextWake(wait)
    this.timer = this.deps.setTimer(() => {
      void this.onWake()
    }, wait)
  }

  /**
   * The wake path. Runs ONLY local, deterministic, non-model code to decide
   * what (if anything) is due, then enqueues exactly one turn per due task.
   * Re-entrant calls are dropped (re-entrancy guard).
   */
  private async onWake(): Promise<void> {
    if (!this.running || this.paused) return
    if (this.tickInFlight) return // hard re-entrancy guard: one tick at a time
    this.tickInFlight = true
    try {
      await this.dispatchDue()
    } finally {
      this.tickInFlight = false
    }
    // Re-arm AFTER the tick so the next wake reflects post-fire next_due.
    await this.reschedule()
  }

  /**
   * Find tasks whose due time is now in the past, coalesce each to a single
   * enqueue, persist lastFiredAt / delete one-shots, and emit telemetry.
   */
  private async dispatchDue(): Promise<void> {
    const now = this.deps.now()
    const tasks = await this.deps.loadTasks(this.opts.dir)

    let dispatched = 0
    let coalescedMisses = 0
    let skippedDueToLock = 0
    const firedRecurringIds: string[] = []
    const firedOneShotIds: string[] = []

    for (const task of tasks) {
      const occurrences = this.dueOccurrences(task, now)
      if (occurrences === 0) continue

      // Coalesce: N missed slots → at most ONE enqueue. Count the extra,
      // collapsed slots for telemetry (count-1 are the "misses").
      coalescedMisses += occurrences - 1

      // Overlap guard: a previous turn for this task is still in flight → skip
      // this occurrence entirely (do NOT start a second turn). It's already
      // coalesced, so we simply drop it and advance next_due on the next wake.
      if (this.inFlightTasks.has(task.id)) {
        skippedDueToLock += 1
        continue
      }

      // Rate cap: pause the whole schedule rather than keep firing.
      if (!this.tryRecordInvocation(now)) {
        this.pauseForCap()
        break
      }

      this.inFlightTasks.add(task.id)
      this.lastInvokedAt.set(task.id, this.deps.monotonicNow())
      // Advance the effective anchor past everything we just coalesced so the
      // next reschedule resolves this task to a FUTURE slot — never the same
      // past-due instant (which would re-fire in a tight loop / busy-spin).
      this.firedThrough.set(task.id, now)
      this.deps.enqueue({
        value: task.prompt,
        mode: 'task-notification',
        isMeta: true,
        workload: 'cron',
        ...(task.agentId ? { agentId: task.agentId } : {}),
      })
      dispatched += 1

      if (task.recurring) {
        // Only file-backed tasks persist lastFiredAt; session tasks die with
        // the process. durable === false marks a session task (see
        // listAllCronTasks).
        if (task.durable !== false) firedRecurringIds.push(task.id)
      } else {
        firedOneShotIds.push(task.id)
      }
    }

    // Persist fire times for recurring file-backed tasks and delete fired
    // one-shots — both are read-modify-writes batched once per tick, not N×.
    if (firedRecurringIds.length > 0) {
      await markCronTasksFired(firedRecurringIds, now, this.opts.dir)
    }
    if (firedOneShotIds.length > 0) {
      await removeCronTasks(firedOneShotIds, this.opts.dir)
    }

    this.lastTelemetry = {
      firedAt: now,
      dispatched,
      coalescedMisses,
      skippedDueToLock,
      nextWakeInMs: null, // patched (not clobbered) by the post-tick reschedule()
    }
    this.dispatchAwaitingNextWake = true
    logForDebugging(
      `[CronScheduler] wake fired=${now} dispatched=${dispatched} ` +
        `coalescedMisses=${coalescedMisses} skippedDueToLock=${skippedDueToLock}`,
    )
  }

  /**
   * Schedule anchor for next-due computation: the LATEST of the task's
   * persisted fire time, its creation time, and the in-memory instant we have
   * already dispatched it through this process. Taking the max means a task we
   * just fired resolves to its NEXT slot rather than re-resolving to the same
   * past-due instant — the guard against a tight re-fire loop (and the OOM /
   * token-burn that comes with it) for session tasks whose fire time never
   * round-trips through disk.
   */
  private effectiveAnchor(task: CronTask): number {
    const persisted = task.lastFiredAt ?? task.createdAt
    const fired = this.firedThrough.get(task.id)
    return fired === undefined ? persisted : Math.max(persisted, fired)
  }

  /**
   * How many scheduled instants for this task are at-or-before `now` (i.e. how
   * many would have fired if we'd been awake). Drives the coalesced-miss
   * telemetry — the dispatch fires once regardless of how many slots elapsed.
   */
  private dueOccurrences(task: CronTask, now: number): number {
    const anchor = this.effectiveAnchor(task)
    let cursor = nextCronRunMs(task.cron, anchor)

    let count = 0
    // Walk forward through past-due slots. Bounded: cron resolution is 1 min,
    // and we stop at the first future instant, so this loop is O(missed slots)
    // and only runs after a real gap (suspend/restart). Cap to a sane bound so
    // a pathological clock skew can't spin here.
    const MAX_WALK = 100_000
    let guard = 0
    while (cursor !== null && cursor <= now && guard < MAX_WALK) {
      count += 1
      cursor = nextCronRunMs(task.cron, cursor)
      guard += 1
    }
    return count
  }

  /**
   * Earliest due epoch ms across all enabled tasks, applying jitter (herd
   * spreading) and the min-interval floor (anti tight-loop). Null when there
   * are no tasks with a future (or past-due) fire.
   */
  private async earliestDueAt(): Promise<number | null> {
    const now = this.deps.now()
    const tasks = await this.deps.loadTasks(this.opts.dir)
    let earliest: number | null = null
    for (const task of tasks) {
      const due = this.nextDueForTask(task, now)
      if (due === null) continue
      if (earliest === null || due < earliest) earliest = due
    }
    return earliest
  }

  /**
   * Canonical next_due for a task, recomputed from its schedule each call
   * (never accumulated). Past-due → now (fire immediately). Applies bounded
   * jitter and the min-interval floor.
   */
  private nextDueForTask(task: CronTask, now: number): number | null {
    const anchor = this.effectiveAnchor(task)
    // If a scheduled instant is already at/behind now, it's due now — return
    // `now` so the timer fires immediately and dispatchDue() coalesces.
    const plain = nextCronRunMs(task.cron, anchor)
    if (plain === null) return null
    if (plain <= now) return now

    // Future fire: apply jitter (recurring → forward, one-shot → backward) to
    // spread synchronized herds, then clamp with the min-interval floor so a
    // task can't invoke the model sooner than now + floor.
    const jittered = task.recurring
      ? jitteredNextCronRunMs(
          task.cron,
          anchor,
          task.id,
          DEFAULT_CRON_JITTER_CONFIG,
        )
      : oneShotJitteredNextCronRunMs(
          task.cron,
          anchor,
          task.id,
          DEFAULT_CRON_JITTER_CONFIG,
        )
    const target = jittered ?? plain

    const last = this.lastInvokedAt.get(task.id)
    if (last !== undefined) {
      // Floor is measured on the monotonic clock; translate to wall-clock by
      // taking the larger of (target) and (now + remaining-floor).
      const elapsed = this.deps.monotonicNow() - last
      const remainingFloor = this.opts.minIntervalFloorMs - elapsed
      if (remainingFloor > 0) {
        return Math.max(target, now + remainingFloor)
      }
    }
    return target
  }

  /**
   * Record an invocation against the rolling window. Returns false (cap hit)
   * when adding this one would exceed maxInvocationsPerWindow.
   */
  private tryRecordInvocation(now: number): boolean {
    const cutoff = now - this.opts.windowMs
    this.invocationLog = this.invocationLog.filter(t => t > cutoff)
    if (this.invocationLog.length >= this.opts.maxInvocationsPerWindow) {
      return false
    }
    this.invocationLog.push(now)
    return true
  }

  private pauseForCap(): void {
    this.paused = true
    this.clearTimer()
    logForDebugging(
      `[CronScheduler] invocation cap (${this.opts.maxInvocationsPerWindow}/` +
        `${this.opts.windowMs}ms) hit — schedule PAUSED; call resume() to continue`,
      { level: 'warn' },
    )
  }

  /**
   * Record the next armed wake into telemetry. If a dispatch just happened this
   * wake, PATCH its record's nextWakeInMs (preserving dispatched / coalesced /
   * skipped counts); otherwise emit a fresh idle record (dispatched 0). This is
   * what lets observers see "fired 1, coalesced 9, next wake in N ms" as a
   * single coherent record per wake.
   */
  private recordNextWake(wait: number | null): void {
    if (this.dispatchAwaitingNextWake && this.lastTelemetry !== null) {
      this.lastTelemetry = { ...this.lastTelemetry, nextWakeInMs: wait }
      this.dispatchAwaitingNextWake = false
      return
    }
    this.lastTelemetry = {
      firedAt: this.deps.now(),
      dispatched: 0,
      coalescedMisses: 0,
      skippedDueToLock: 0,
      nextWakeInMs: wait,
    }
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      this.deps.clearTimer(this.timer)
      this.timer = null
    }
  }
}

/**
 * Process-wide singleton. The REPL / daemon calls getCronScheduler().start()
 * once the scheduled-tasks flag is enabled, and reschedule() after any
 * CronCreate/CronDelete so an earlier-due task preempts the current sleep.
 */
let singleton: CronScheduler | null = null

export function getCronScheduler(): CronScheduler {
  if (singleton === null) {
    singleton = new CronScheduler(
      {
        // Bind to the default (non-daemon) project root + session merge.
        loadTasks: () => listAllCronTasks(),
      },
      { dir: undefined },
    )
  }
  return singleton
}

/** Test-only: drop the singleton so each test starts from a clean driver. */
export function resetCronSchedulerForTests(): void {
  singleton?.stop()
  singleton = null
}
