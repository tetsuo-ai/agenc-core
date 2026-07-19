import { type FSWatcher, watch } from 'fs'
import { useEffect, useSyncExternalStore } from 'react'
import { type AppState, useAppState, useSetAppState } from '../state/AppState.js'
import { createSignal } from '../../utils/signal.js'
import { logError } from '../../utils/log.js'
import type { Task } from '../../utils/tasks.js'
import {
  getTaskListId,
  getTasksDir,
  isTodoV2Enabled,
  listTasks,
  onTasksUpdated,
  resetTaskList,
} from '../../utils/tasks.js'
import { isTeamLead } from '../../utils/teammate.js'

const HIDE_DELAY_MS = 5000
const DEBOUNCE_MS = 50
const FALLBACK_POLL_MS = 5000 // Fallback in case fs.watch misses events

/**
 * Singleton store for the TodoV2 task list. Owns the file watcher, timers,
 * and cached task list. Multiple hook instances (REPL, Spinner,
 * PromptInputFooterLeftSide) subscribe to one shared store instead of each
 * setting up their own fs.watch on the same directory. The Spinner mounts/
 * unmounts every turn — per-hook watchers caused constant watch/unwatch churn.
 *
 * Implements the useSyncExternalStore contract: subscribe/getSnapshot.
 */
class TasksV2Store {
  /** Stable array reference; replaced only on fetch. undefined until started. */
  #tasks: Task[] | undefined = undefined
  /**
   * Set when the hide timer has elapsed (all tasks completed for >5s), or
   * when the task list is empty. Starts false so the first fetch runs the
   * "all completed → schedule 5s hide" path (matches original behavior:
   * resuming a session with completed tasks shows them briefly).
   */
  #hidden = false
  #watcher: FSWatcher | null = null
  #watchedDir: string | null = null
  #hideTimer: ReturnType<typeof setTimeout> | null = null
  #debounceTimer: ReturnType<typeof setTimeout> | null = null
  #pollTimer: ReturnType<typeof setTimeout> | null = null
  #unsubscribeTasksUpdated: (() => void) | null = null
  #changed = createSignal()
  #subscriberCount = 0
  #started = false
  #generation = 0
  #fetchRequestId = 0

  /**
   * useSyncExternalStore snapshot. Returns the same Task[] reference between
   * updates (required for Object.is stability). Returns undefined when hidden.
   */
  getSnapshot = (): Task[] | undefined => {
    return this.#hidden ? undefined : this.#tasks
  }

  subscribe = (fn: () => void): (() => void) => {
    // Lazy init on first subscriber. useSyncExternalStore calls this
    // post-commit, so I/O here is safe (no render-phase side effects).
    // REPL.tsx keeps a subscription alive for the whole session, so
    // Spinner mount/unmount churn never drives the count to zero.
    const unsubscribe = this.#changed.subscribe(fn)
    this.#subscriberCount++
    if (!this.#started) {
      this.#started = true
      const generation = ++this.#generation
      this.#unsubscribeTasksUpdated = onTasksUpdated(() => {
        this.#debouncedFetch(generation)
      })
      // Fire-and-forget: subscribe is called post-commit (not in render),
      // and the store notifies subscribers when the fetch resolves.
      this.#fetchAndLog(generation)
    }
    let unsubscribed = false
    return () => {
      if (unsubscribed) return
      unsubscribed = true
      unsubscribe()
      this.#subscriberCount--
      if (this.#subscriberCount === 0) this.#stop()
    }
  }

  #notify(): void {
    this.#changed.emit()
  }

  #isCurrentGeneration(generation: number): boolean {
    return (
      this.#started &&
      this.#subscriberCount > 0 &&
      generation === this.#generation
    )
  }

  #isCurrentFetch(generation: number, requestId: number): boolean {
    return (
      this.#isCurrentGeneration(generation) &&
      requestId === this.#fetchRequestId
    )
  }

  /**
   * Point the file watcher at the current tasks directory. Called on start
   * and whenever #fetch detects the task list ID has changed (e.g. when
   * TeamCreateTool sets leaderTeamName mid-session).
   */
  #rewatch(dir: string, generation: number): void {
    // Retry even on same dir if the previous watch attempt failed (dir
    // didn't exist yet). Once the watcher is established, same-dir is a no-op.
    if (!this.#isCurrentGeneration(generation)) return
    if (dir === this.#watchedDir && this.#watcher !== null) return
    this.#watcher?.close()
    this.#watcher = null
    this.#watchedDir = dir
    try {
      this.#watcher = watch(dir, () => {
        this.#debouncedFetch(generation)
      })
      this.#watcher.unref()
    } catch {
      // Directory may not exist yet (ensureTasksDir is called by writers).
      // Not critical — onTasksUpdated covers in-process updates and the
      // poll timer covers cross-process updates.
    }
  }

  #debouncedFetch = (generation: number = this.#generation): void => {
    if (!this.#isCurrentGeneration(generation)) return
    if (this.#debounceTimer) clearTimeout(this.#debounceTimer)
    this.#debounceTimer = setTimeout(() => {
      this.#fetchAndLog(generation)
    }, DEBOUNCE_MS)
    this.#debounceTimer.unref()
  }

  #fetchAndLog = (generation: number = this.#generation): void => {
    if (!this.#isCurrentGeneration(generation)) return
    const requestId = ++this.#fetchRequestId
    void this.#fetch(generation, requestId).catch(error => {
      if (!this.#isCurrentFetch(generation, requestId)) return
      logError(error instanceof Error ? error : new Error(String(error)))
    })
  }

  #fetch = async (generation: number, requestId: number): Promise<void> => {
    if (!this.#isCurrentGeneration(generation)) return
    const taskListId = getTaskListId()
    // Task list ID can change mid-session (TeamCreateTool sets
    // leaderTeamName) — point the watcher at the current dir.
    this.#rewatch(getTasksDir(taskListId), generation)
    const current = (await listTasks(taskListId)).filter(
      t => !t.metadata?._internal,
    )
    if (!this.#isCurrentFetch(generation, requestId)) return
    this.#tasks = current

    const hasIncomplete = current.some(t => t.status !== 'completed')

    if (hasIncomplete || current.length === 0) {
      // Has unresolved tasks (open/in_progress) or empty — reset hide state
      this.#hidden = current.length === 0
      this.#clearHideTimer()
    } else if (this.#hideTimer === null && !this.#hidden) {
      // All tasks just became completed — schedule clear
      this.#hideTimer = setTimeout(
        this.#onHideTimerFired.bind(this, taskListId, generation),
        HIDE_DELAY_MS,
      )
      this.#hideTimer.unref()
    }

    this.#notify()

    // Schedule the fallback poll unconditionally while started. In daemon
    // mode the board is written by ANOTHER process: the first TodoWrite
    // creates the tasks dir itself, so the fs.watch above was never
    // established (watch on a missing dir throws) and onTasksUpdated only
    // covers in-process writes — polling when "empty" is the ONLY way the
    // store ever discovers the board. getSnapshot keeps the same array
    // reference between no-change fetches, so subscribers do not re-render.
    if (this.#pollTimer) {
      clearTimeout(this.#pollTimer)
      this.#pollTimer = null
    }
    this.#pollTimer = setTimeout(() => {
      this.#debouncedFetch(generation)
    }, FALLBACK_POLL_MS)
    this.#pollTimer.unref()
  }

  #onHideTimerFired(scheduledForTaskListId: string, generation: number): void {
    this.#hideTimer = null
    if (!this.#isCurrentGeneration(generation)) return
    // Bail if the task list ID changed since scheduling (team created/deleted
    // during the 5s window) — don't reset the wrong list.
    const currentId = getTaskListId()
    if (currentId !== scheduledForTaskListId) return
    // Verify all tasks are still completed before clearing
    void listTasks(currentId).then(async tasksToCheck => {
      if (!this.#isCurrentGeneration(generation)) return
      const allStillCompleted =
        tasksToCheck.length > 0 &&
        tasksToCheck.every(t => t.status === 'completed')
      if (allStillCompleted) {
        await resetTaskList(currentId)
        if (!this.#isCurrentGeneration(generation)) return
        this.#tasks = []
        this.#hidden = true
      }
      this.#notify()
    }).catch(error => {
      if (!this.#isCurrentGeneration(generation)) return
      logError(error instanceof Error ? error : new Error(String(error)))
      this.#notify()
    })
  }

  #clearHideTimer(): void {
    if (this.#hideTimer) {
      clearTimeout(this.#hideTimer)
      this.#hideTimer = null
    }
  }

  /**
   * Tear down the watcher, timers, and in-process subscription. Called when
   * the last subscriber unsubscribes. Preserves #tasks/#hidden cache so a
   * subsequent re-subscribe renders the last known state immediately.
   */
  #stop(): void {
    this.#generation++
    this.#watcher?.close()
    this.#watcher = null
    this.#watchedDir = null
    this.#unsubscribeTasksUpdated?.()
    this.#unsubscribeTasksUpdated = null
    this.#clearHideTimer()
    if (this.#debounceTimer) clearTimeout(this.#debounceTimer)
    if (this.#pollTimer) clearTimeout(this.#pollTimer)
    this.#debounceTimer = null
    this.#pollTimer = null
    this.#started = false
  }
}

let _store: TasksV2Store | null = null
function getStore(): TasksV2Store {
  return (_store ??= new TasksV2Store())
}

// Stable no-ops for the disabled path so useSyncExternalStore doesn't
// churn its subscription on every render.
const NOOP = (): void => {}
const NOOP_SUBSCRIBE = (): (() => void) => NOOP
const NOOP_SNAPSHOT = (): undefined => undefined

/**
 * Hook to get the current task list for the persistent UI display.
 * Returns tasks when TodoV2 is enabled, otherwise returns undefined.
 * All hook instances share a single file watcher via TasksV2Store.
 * Hides the list after 5 seconds if there are no open tasks.
 */
export function useTasksV2(): Task[] | undefined {
  const teamContext = useAppState((s: AppState) => s.teamContext)

  const enabled = isTodoV2Enabled() && (!teamContext || isTeamLead(teamContext))

  const store = enabled ? getStore() : null

  return useSyncExternalStore(
    store ? store.subscribe : NOOP_SUBSCRIBE,
    store ? store.getSnapshot : NOOP_SNAPSHOT,
  )
}

/**
 * Same as useTasksV2, plus collapses the expanded task view when the list
 * becomes hidden. Call this from exactly one always-mounted component (REPL)
 * so the collapse effect runs once instead of N× per consumer.
 */
export function useTasksV2WithCollapseEffect(): Task[] | undefined {
  const tasks = useTasksV2()
  const setAppState = useSetAppState()

  const hidden = tasks === undefined
  useEffect(() => {
    if (!hidden) return
    setAppState(prev => {
      if (prev.expandedView !== 'tasks') return prev
      return { ...prev, expandedView: 'none' as const }
    })
  }, [hidden, setAppState])

  return tasks
}
