import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import type { Task } from '../../utils/tasks.js'

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
    taskReadError: null as Error | null,
    tasksByList: new Map<string, Task[]>(),
    watchThrows: false,
    watchers: [] as WatcherRecord[],
  }

  const listTasks = vi.fn(async (taskListId: string) => {
    if (state.taskReadError) {
      throw state.taskReadError
    }
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
    (subscribe: (listener: () => void) => () => void, getSnapshot: () => unknown) => {
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
    if (state.watchThrows) {
      throw new Error('watch unavailable')
    }
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
    state.taskReadError = null
    state.tasksByList = new Map([['list-a', []]])
    state.watchThrows = false
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

vi.mock('../state/AppState.js', () => ({
  useAppState: (selector: (state: AppStateFixture) => unknown) =>
    selector(fixture.state.appState),
  useSetAppState: () => fixture.setAppState,
}))

vi.mock('../../utils/tasks.js', () => ({
  getTaskListId: () => fixture.state.taskListId,
  getTasksDir: (taskListId: string) => `/tasks/${taskListId}`,
  isTodoV2Enabled: () => fixture.state.enabled,
  listTasks: fixture.listTasks,
  onTasksUpdated: fixture.onTasksUpdated,
  resetTaskList: fixture.resetTaskList,
}))

vi.mock('../../utils/teammate.js', () => ({
  isTeamLead: () => fixture.state.isLead,
}))

vi.mock('../../utils/log.js', () => ({
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

function task(
  id: string,
  status: Task['status'],
  overrides: Partial<Task> = {},
): Task {
  return {
    activeForm: `${status} ${id}`,
    blockedBy: [],
    blocks: [],
    description: `Task ${id}`,
    id,
    subject: `Task ${id}`,
    status,
    ...overrides,
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
  initial: Task[] | undefined
  record: SubscriptionRecord
}> {
  const { useTasksV2 } = await import('./useTasksV2.js')
  const initial = useTasksV2()
  const record = fixture.state.subscriptions.at(-1)
  if (!record) {
    throw new Error('useTasksV2 did not subscribe')
  }
  return {
    dispose: record.unsubscribe,
    initial,
    record,
  }
}

describe('useTasksV2', () => {
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

  test('returns hidden initial state without starting the store when disabled', async () => {
    fixture.state.enabled = false
    fixture.state.tasksByList.set('list-a', [task('1', 'pending')])

    const mounted = await mountUseTasksV2()
    await flushPromises()

    expect(mounted.initial).toBeUndefined()
    expect(latestTasks(mounted.record)).toBeUndefined()
    expect(fixture.listTasks).not.toHaveBeenCalled()
    expect(fixture.onTasksUpdated).not.toHaveBeenCalled()
    expect(fixture.watch).not.toHaveBeenCalled()
  })

  test('does not subscribe for non-lead team members', async () => {
    fixture.state.appState.teamContext = {
      leadAgentId: 'lead-agent',
      teamName: 'alpha',
    }
    fixture.state.isLead = false
    fixture.state.tasksByList.set('list-a', [task('1', 'pending')])

    const mounted = await mountUseTasksV2()
    await flushPromises()

    expect(mounted.initial).toBeUndefined()
    expect(fixture.listTasks).not.toHaveBeenCalled()
    expect(fixture.onTasksUpdated).not.toHaveBeenCalled()
  })

  test('hides an empty initial list and continues when fs.watch setup fails', async () => {
    fixture.state.watchThrows = true

    const mounted = await mountUseTasksV2()
    await flushPromises()

    expect(fixture.watch).toHaveBeenCalledWith('/tasks/list-a', expect.any(Function))
    expect(fixture.listTasks).toHaveBeenCalledWith('list-a')
    expect(latestTasks(mounted.record)).toBeUndefined()
    // The fallback poll stays armed even on an empty list: in daemon mode the
    // board is written cross-process, so polling is the only discovery path
    // when fs.watch is unavailable (here: because setup threw).
    expect(activeTimers(5000)).toHaveLength(1)

    await fireNextTimer(5000) // poll tick → debounce
    await fireNextTimer(50) // debounce → refetch
    expect(fixture.listTasks).toHaveBeenCalledTimes(2)
  })

  test('logs initial task read failures and retries on later task updates', async () => {
    const error = new Error('tasks unavailable')
    fixture.state.taskReadError = error

    const mounted = await mountUseTasksV2()
    await flushPromises()

    expect(fixture.listTasks).toHaveBeenCalledWith('list-a')
    expect(logMock.logError).toHaveBeenCalledWith(error)
    expect(latestTasks(mounted.record)).toBeUndefined()

    fixture.state.taskReadError = null
    fixture.state.tasksByList.set('list-a', [task('1', 'pending')])
    await emitTasksUpdated()

    expect(latestTasks(mounted.record)?.map(t => t.id)).toEqual(['1'])
  })

  test('filters internal tasks and preserves source ordering across add, update, and remove events', async () => {
    fixture.state.tasksByList.set('list-a', [
      task('2', 'pending'),
      task('internal', 'pending', { metadata: { _internal: true } }),
      task('10', 'completed'),
    ])
    const mounted = await mountUseTasksV2()
    await flushPromises()

    expect(latestTasks(mounted.record)?.map(t => t.id)).toEqual(['2', '10'])

    fixture.state.tasksByList.set('list-a', [
      task('2', 'in_progress'),
      task('1', 'pending'),
      task('10', 'completed'),
    ])
    await emitTasksUpdated()

    expect(latestTasks(mounted.record)?.map(t => [t.id, t.status])).toEqual([
      ['2', 'in_progress'],
      ['1', 'pending'],
      ['10', 'completed'],
    ])

    fixture.state.tasksByList.set('list-a', [
      task('2', 'completed'),
      task('1', 'pending'),
    ])
    await emitTasksUpdated()

    expect(latestTasks(mounted.record)?.map(t => [t.id, t.status])).toEqual([
      ['2', 'completed'],
      ['1', 'pending'],
    ])
  })

  test('shares one store across subscribers and tears down watchers, listeners, and timers after the last unsubscribe', async () => {
    fixture.state.tasksByList.set('list-a', [task('1', 'pending')])

    const first = await mountUseTasksV2()
    const second = await mountUseTasksV2()
    await flushPromises()

    expect(fixture.onTasksUpdated).toHaveBeenCalledTimes(1)
    expect(fixture.listTasks).toHaveBeenCalledTimes(1)
    expect(fixture.watch).toHaveBeenCalledTimes(1)
    expect(activeTimers(5000)).toHaveLength(1)

    first.dispose()
    expect(fixture.state.watchers[0]?.close).not.toHaveBeenCalled()

    second.dispose()
    expect(fixture.state.watchers[0]?.close).toHaveBeenCalledTimes(1)
    expect(fixture.state.taskListeners).toHaveLength(0)
    expect(activeTimers()).toHaveLength(0)
  })

  test('debounces watcher events and clears stale debounce work on unmount', async () => {
    fixture.state.tasksByList.set('list-a', [task('1', 'pending')])
    const mounted = await mountUseTasksV2()
    await flushPromises()

    fixture.state.tasksByList.set('list-a', [task('1', 'in_progress')])
    fixture.state.watchers[0]?.listener()
    fixture.state.tasksByList.set('list-a', [task('1', 'completed')])
    fixture.state.watchers[0]?.listener()

    expect(activeTimers(50)).toHaveLength(1)

    mounted.dispose()
    await fireNextTimer(50).catch(() => undefined)

    expect(fixture.listTasks).toHaveBeenCalledTimes(1)
    expect(fixture.state.watchers[0]?.close).toHaveBeenCalledTimes(1)
  })

  test('does not recreate timers when an in-flight fetch resolves after final unsubscribe', async () => {
    let resolveListTasks: ((tasks: Task[]) => void) | undefined
    fixture.listTasks.mockImplementationOnce(
      () =>
        new Promise<Task[]>(resolve => {
          resolveListTasks = resolve
        }),
    )

    const mounted = await mountUseTasksV2()
    expect(fixture.listTasks).toHaveBeenCalledTimes(1)
    expect(fixture.watch).toHaveBeenCalledWith('/tasks/list-a', expect.any(Function))

    mounted.dispose()

    expect(fixture.state.watchers[0]?.close).toHaveBeenCalledTimes(1)
    expect(fixture.state.taskListeners).toHaveLength(0)
    expect(activeTimers()).toHaveLength(0)

    resolveListTasks?.([task('1', 'pending')])
    await flushPromises()

    expect(activeTimers()).toHaveLength(0)
  })

  test('ignores stale fetch results when a newer fetch resolves first', async () => {
    let resolveInitialFetch: ((tasks: Task[]) => void) | undefined
    let resolveRefreshFetch: ((tasks: Task[]) => void) | undefined
    fixture.listTasks
      .mockImplementationOnce(
        () =>
          new Promise<Task[]>(resolve => {
            resolveInitialFetch = resolve
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<Task[]>(resolve => {
            resolveRefreshFetch = resolve
          }),
      )

    const mounted = await mountUseTasksV2()
    expect(fixture.listTasks).toHaveBeenCalledTimes(1)

    for (const listener of [...fixture.state.taskListeners]) {
      listener()
    }
    await fireNextTimer(50)
    expect(fixture.listTasks).toHaveBeenCalledTimes(2)

    resolveRefreshFetch?.([task('new', 'pending')])
    await flushPromises()

    expect(latestTasks(mounted.record)?.map(t => t.id)).toEqual(['new'])

    resolveInitialFetch?.([task('old', 'completed')])
    await flushPromises()

    expect(latestTasks(mounted.record)?.map(t => t.id)).toEqual(['new'])
  })

  test('resets and hides completed tasks after the completion delay, then shows new work', async () => {
    fixture.state.tasksByList.set('list-a', [task('1', 'completed')])
    const mounted = await mountUseTasksV2()
    await flushPromises()

    expect(latestTasks(mounted.record)?.map(t => t.id)).toEqual(['1'])
    // Two 5000ms timers: the completed-task hide timer AND the fallback poll
    // (the poll stays armed so cross-process board writes are discovered).
    // fireNextTimer picks the hide timer first (scheduled before the poll).
    expect(activeTimers(5000)).toHaveLength(2)

    await fireNextTimer(5000)

    expect(fixture.resetTaskList).toHaveBeenCalledWith('list-a')
    expect(latestTasks(mounted.record)).toBeUndefined()

    fixture.state.tasksByList.set('list-a', [task('2', 'pending')])
    await emitTasksUpdated()

    expect(latestTasks(mounted.record)?.map(t => t.id)).toEqual(['2'])
  })

  test('logs completed-task hide check failures and keeps completed tasks visible', async () => {
    fixture.state.tasksByList.set('list-a', [task('1', 'completed')])
    const mounted = await mountUseTasksV2()
    await flushPromises()

    expect(latestTasks(mounted.record)?.map(t => t.id)).toEqual(['1'])

    const error = new Error('hide check unavailable')
    fixture.state.taskReadError = error
    await fireNextTimer(5000)

    expect(logMock.logError).toHaveBeenCalledWith(error)
    expect(fixture.resetTaskList).not.toHaveBeenCalled()
    expect(latestTasks(mounted.record)?.map(t => t.id)).toEqual(['1'])
  })

  test('cancels completed-task hiding when incomplete work appears before the delay', async () => {
    fixture.state.tasksByList.set('list-a', [task('1', 'completed')])
    const mounted = await mountUseTasksV2()
    await flushPromises()
    const hideTimer = activeTimers(5000)[0]
    expect(hideTimer).toBeDefined()

    fixture.state.tasksByList.set('list-a', [
      task('1', 'completed'),
      task('2', 'pending'),
    ])
    await emitTasksUpdated()

    expect(hideTimer.active).toBe(false)
    expect(fixture.resetTaskList).not.toHaveBeenCalled()
    expect(latestTasks(mounted.record)?.map(t => t.id)).toEqual(['1', '2'])
  })

  test('does not reset a stale completed list after the task-list id changes', async () => {
    fixture.state.tasksByList.set('list-a', [task('1', 'completed')])
    const mounted = await mountUseTasksV2()
    await flushPromises()

    fixture.state.taskListId = 'list-b'
    fixture.state.tasksByList.set('list-b', [task('2', 'pending')])
    await fireNextTimer(5000)

    expect(fixture.resetTaskList).not.toHaveBeenCalled()
    expect(latestTasks(mounted.record)?.map(t => t.id)).toEqual(['1'])

    await emitTasksUpdated()

    expect(fixture.state.watchers.map(watcher => watcher.dir)).toEqual([
      '/tasks/list-a',
      '/tasks/list-b',
    ])
    expect(fixture.state.watchers[0]?.close).toHaveBeenCalledTimes(1)
    expect(latestTasks(mounted.record)?.map(t => t.id)).toEqual(['2'])
  })

  test('collapses expanded task view when the hook is hidden', async () => {
    fixture.state.enabled = false
    fixture.state.appState = {
      expandedView: 'tasks',
    }
    const { useTasksV2WithCollapseEffect } = await import('./useTasksV2.js')

    const tasks = useTasksV2WithCollapseEffect()

    expect(tasks).toBeUndefined()
    expect(fixture.setAppState).toHaveBeenCalledTimes(1)
    expect(fixture.state.appState.expandedView).toBe('none')
  })
})
