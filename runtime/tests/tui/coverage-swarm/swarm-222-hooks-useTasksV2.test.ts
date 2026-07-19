import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import type { Task } from '../../../src/utils/tasks.js'

type AppStateFixture = {
  expandedView: 'none' | 'tasks' | 'teammates'
  teamContext?: { leadAgentId: string; teamName: string }
}

type ManualTimer = {
  active: boolean
  callback: () => void
  delay: number
  unref: ReturnType<typeof vi.fn>
}

type SubscriptionRecord = {
  getSnapshot: () => unknown
  snapshots: unknown[]
  unsubscribe: () => void
}

type WatcherRecord = {
  close: ReturnType<typeof vi.fn>
  dir: string
  listener: () => void
  unref: ReturnType<typeof vi.fn>
}

const fixture = vi.hoisted(() => {
  const state = {
    appState: {
      expandedView: 'none',
      teamContext: undefined,
    } as AppStateFixture,
    enabled: true,
    isLead: true,
    subscriptions: [] as SubscriptionRecord[],
    taskListId: 'list-a',
    taskListeners: new Set<() => void>(),
    tasksByList: new Map<string, Task[]>(),
    watchers: [] as WatcherRecord[],
  }

  const listTasks = vi.fn(async (taskListId: string) => {
    return state.tasksByList.get(taskListId) ?? []
  })

  const onTasksUpdated = vi.fn((listener: () => void) => {
    state.taskListeners.add(listener)
    return vi.fn(() => {
      state.taskListeners.delete(listener)
    })
  })

  const resetTaskList = vi.fn(async (taskListId: string) => {
    state.tasksByList.set(taskListId, [])
  })

  const setAppState = vi.fn(
    (
      updater:
        | AppStateFixture
        | ((previous: AppStateFixture) => AppStateFixture),
    ) => {
      state.appState =
        typeof updater === 'function' ? updater(state.appState) : updater
    },
  )

  const useSyncExternalStore = vi.fn(
    (
      subscribe: (listener: () => void) => () => void,
      getSnapshot: () => unknown,
    ) => {
      const record: SubscriptionRecord = {
        getSnapshot,
        snapshots: [],
        unsubscribe: () => {},
      }
      record.unsubscribe = subscribe(() => {
        record.snapshots.push(getSnapshot())
      })
      record.snapshots.push(getSnapshot())
      state.subscriptions.push(record)
      return record.snapshots.at(-1)
    },
  )

  const watch = vi.fn((dir: string, listener: () => void) => {
    const watcher: WatcherRecord = {
      close: vi.fn(),
      dir,
      listener,
      unref: vi.fn(),
    }
    state.watchers.push(watcher)
    return watcher
  })

  function reset(): void {
    state.appState = {
      expandedView: 'none',
      teamContext: undefined,
    }
    state.enabled = true
    state.isLead = true
    state.subscriptions = []
    state.taskListId = 'list-a'
    state.taskListeners.clear()
    state.tasksByList = new Map([['list-a', []]])
    state.watchers = []

    listTasks.mockClear()
    onTasksUpdated.mockClear()
    resetTaskList.mockClear()
    setAppState.mockClear()
    useSyncExternalStore.mockClear()
    watch.mockClear()
  }

  return {
    listTasks,
    onTasksUpdated,
    reset,
    resetTaskList,
    setAppState,
    state,
    useSyncExternalStore,
    watch,
  }
})

const logMock = vi.hoisted(() => ({
  logError: vi.fn(),
}))

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react')
  return {
    ...actual,
    useEffect: (effect: () => void | (() => void)) => effect(),
    useSyncExternalStore: fixture.useSyncExternalStore,
  }
})

vi.mock('fs', () => ({
  watch: fixture.watch,
}))

vi.mock('src/tui/state/AppState.js', () => ({
  useAppState: (selector: (state: AppStateFixture) => unknown) =>
    selector(fixture.state.appState),
  useSetAppState: () => fixture.setAppState,
}))

vi.mock('src/utils/tasks.js', () => ({
  getTaskListId: () => fixture.state.taskListId,
  getTasksDir: (taskListId: string) => `/tasks/${taskListId}`,
  isTodoV2Enabled: () => fixture.state.enabled,
  listTasks: fixture.listTasks,
  onTasksUpdated: fixture.onTasksUpdated,
  resetTaskList: fixture.resetTaskList,
}))

vi.mock('src/utils/teammate.js', () => ({
  isTeamLead: () => fixture.state.isLead,
}))

vi.mock('src/utils/log.js', () => ({
  logError: logMock.logError,
}))

let timers: ManualTimer[] = []

function installTimerMocks(): void {
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(
    (handler: TimerHandler, delay?: number, ...args: unknown[]) => {
      const timer: ManualTimer = {
        active: true,
        callback: () => {
          if (typeof handler !== 'function') {
            throw new TypeError('string timers are not supported in this test')
          }
          handler(...args)
        },
        delay: delay ?? 0,
        unref: vi.fn(),
      }
      timers.push(timer)
      return timer as unknown as ReturnType<typeof setTimeout>
    },
  )
  vi.spyOn(globalThis, 'clearTimeout').mockImplementation(
    (timer: Parameters<typeof clearTimeout>[0]) => {
      if (timer && typeof timer === 'object' && 'active' in timer) {
        ;(timer as unknown as ManualTimer).active = false
      }
    },
  )
}

function task(id: string, status: Task['status']): Task {
  return {
    activeForm: `${status} ${id}`,
    blockedBy: [],
    blocks: [],
    description: `Task ${id}`,
    id,
    subject: `Task ${id}`,
    status,
  }
}

function activeTimers(delay?: number): ManualTimer[] {
  return timers.filter(
    timer => timer.active && (delay === undefined || timer.delay === delay),
  )
}

async function flushPromises(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve()
  }
}

async function fireNextTimer(delay?: number): Promise<ManualTimer> {
  const timer = activeTimers(delay)[0]
  expect(timer).toBeDefined()
  timer.active = false
  timer.callback()
  await flushPromises()
  return timer
}

async function emitTasksUpdated(): Promise<void> {
  for (const listener of [...fixture.state.taskListeners]) {
    listener()
  }
  await fireNextTimer(50)
}

function latestTasks(record: SubscriptionRecord): Task[] | undefined {
  return record.snapshots.at(-1) as Task[] | undefined
}

async function mountUseTasksV2(): Promise<{
  dispose: () => void
  record: SubscriptionRecord
}> {
  const { useTasksV2 } = await import('src/tui/hooks/useTasksV2.js')
  useTasksV2()
  const record = fixture.state.subscriptions.at(-1)
  if (!record) {
    throw new Error('useTasksV2 did not subscribe')
  }
  return {
    dispose: record.unsubscribe,
    record,
  }
}

describe('useTasksV2 coverage swarm row 222', () => {
  beforeEach(() => {
    vi.resetModules()
    fixture.reset()
    logMock.logError.mockClear()
    timers = []
    installTimerMocks()
  })

  afterEach(() => {
    for (const subscription of fixture.state.subscriptions) {
      subscription.unsubscribe()
    }
    vi.restoreAllMocks()
  })

  test('does not reset a completed list when the hide check sees pending work', async () => {
    fixture.state.tasksByList.set('list-a', [task('done', 'completed')])
    const mounted = await mountUseTasksV2()
    await flushPromises()

    fixture.state.tasksByList.set('list-a', [
      task('done', 'completed'),
      task('new', 'pending'),
    ])
    await fireNextTimer(5000)

    expect(fixture.listTasks).toHaveBeenLastCalledWith('list-a')
    expect(fixture.resetTaskList).not.toHaveBeenCalled()
    expect(latestTasks(mounted.record)?.map(item => item.id)).toEqual(['done'])
  })

  test('keeps one hide timer and one watcher for repeated all-completed updates', async () => {
    fixture.state.tasksByList.set('list-a', [task('done', 'completed')])
    const mounted = await mountUseTasksV2()
    await flushPromises()

    // Two 5000ms timers: the completed-task hide timer AND the fallback poll
    // (the poll stays armed so cross-process board writes are discovered).
    expect(activeTimers(5000)).toHaveLength(2)

    fixture.state.tasksByList.set('list-a', [task('done-again', 'completed')])
    await emitTasksUpdated()

    expect(latestTasks(mounted.record)?.map(item => item.id)).toEqual([
      'done-again',
    ])
    // Repeated all-completed updates still keep exactly one hide timer plus
    // the re-armed fallback poll — no duplicate timers or watchers.
    expect(activeTimers(5000)).toHaveLength(2)
    expect(fixture.watch).toHaveBeenCalledTimes(1)
    expect(fixture.state.watchers[0]?.close).not.toHaveBeenCalled()
  })

  test('collapse effect leaves non-task expanded views unchanged when hidden', async () => {
    fixture.state.enabled = false
    fixture.state.appState = {
      expandedView: 'teammates',
    }
    const { useTasksV2WithCollapseEffect } = await import(
      'src/tui/hooks/useTasksV2.js'
    )

    const tasks = useTasksV2WithCollapseEffect()

    expect(tasks).toBeUndefined()
    expect(fixture.setAppState).toHaveBeenCalledTimes(1)
    expect(fixture.state.appState.expandedView).toBe('teammates')
  })

  test('collapse effect does nothing when tasks are visible', async () => {
    fixture.state.tasksByList.set('list-a', [task('open', 'pending')])
    const mounted = await mountUseTasksV2()
    await flushPromises()
    const { useTasksV2WithCollapseEffect } = await import(
      'src/tui/hooks/useTasksV2.js'
    )

    const tasks = useTasksV2WithCollapseEffect()

    expect(tasks?.map(item => item.id)).toEqual(['open'])
    expect(fixture.setAppState).not.toHaveBeenCalled()
    expect(latestTasks(mounted.record)?.map(item => item.id)).toEqual(['open'])
  })
})
