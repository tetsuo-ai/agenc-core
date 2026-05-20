import { PassThrough } from 'node:stream'

import React from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'

import Text from '../ink/components/Text.js'
import { createRoot } from '../ink/root.js'
import {
  StatsProvider,
  createStatsStore,
  useCounter,
  useGauge,
  useSet,
  useStats,
  useTimer,
} from './stats.tsx'
import { saveCurrentProjectConfig } from '../../utils/config.js'

vi.mock('../../utils/config.js', () => ({
  saveCurrentProjectConfig: vi.fn(),
}))
vi.mock('../../utils/debug.js', () => ({
  logForDebugging: () => {},
}))
vi.mock('../../bootstrap/state.js', () => ({
  flushInteractionTime: () => {},
  markScrollActivity: () => {},
  updateLastInteractionTime: () => {},
}))
vi.mock('../../utils/earlyInput.js', () => ({
  stopCapturingEarlyInput: () => {},
}))
vi.mock('../../utils/envUtils.js', () => ({
  isEnvTruthy: () => false,
}))
vi.mock('../../utils/fullscreen.js', () => ({
  isMouseClicksDisabled: () => true,
}))
vi.mock('../../utils/log.js', () => ({
  logError: () => {},
}))

type TestStdin = PassThrough & {
  isTTY: boolean
  setRawMode: (mode: boolean) => void
  ref: () => void
  unref: () => void
}

function createTestStreams(): {
  stdout: PassThrough
  stdin: TestStdin
} {
  const stdout = new PassThrough()
  const stdin = new PassThrough() as TestStdin

  stdin.isTTY = true
  stdin.setRawMode = () => {}
  stdin.ref = () => {}
  stdin.unref = () => {}
  ;(stdout as unknown as { columns: number }).columns = 120
  ;(stdout as unknown as { rows: number }).rows = 24
  ;(stdout as unknown as { isTTY: boolean }).isTTY = true

  return { stdout, stdin }
}

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('Timed out waiting for stats context state')
}

function MetricsPublisher({
  snapshots,
}: {
  snapshots: Array<Record<string, number>>
}): React.ReactNode {
  const stats = useStats()
  const count = useCounter('count')
  const gauge = useGauge('gauge')
  const timer = useTimer('timer')
  const set = useSet('unique')

  React.useEffect(() => {
    count()
    count(4)
    gauge(8)
    timer(10)
    timer(30)
    set('a')
    set('a')
    set('b')
    snapshots.push(stats.getAll())
  }, [count, gauge, set, snapshots, stats, timer])

  return <Text>stats</Text>
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.mocked(saveCurrentProjectConfig).mockClear()
})

describe('createStatsStore', () => {
  test('collects counters, gauges, histograms, sets, and sampled overflow', () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0)
    const store = createStatsStore()

    store.increment('requests')
    store.increment('requests', 4)
    store.set('active', 3)
    store.add('users', 'alice')
    store.add('users', 'alice')
    store.add('users', 'bob')
    store.observe('latency', 10)
    store.observe('latency', 20)
    store.observe('latency', 30)
    for (let i = 0; i < 1_025; i++) {
      store.observe('sampled', i)
    }

    const metrics = store.getAll()

    expect(metrics.requests).toBe(5)
    expect(metrics.active).toBe(3)
    expect(metrics.users).toBe(2)
    expect(metrics.latency_count).toBe(3)
    expect(metrics.latency_min).toBe(10)
    expect(metrics.latency_max).toBe(30)
    expect(metrics.latency_avg).toBe(20)
    expect(metrics.latency_p50).toBe(20)
    expect(metrics.latency_p95).toBe(29)
    expect(metrics.latency_p99).toBeCloseTo(29.8)
    expect(metrics.sampled_count).toBe(1_025)
    expect(metrics.sampled_min).toBe(0)
    expect(metrics.sampled_max).toBe(1_024)

    random.mockRestore()
  })
})

describe('StatsProvider', () => {
  test('provides metric hooks and flushes non-empty metrics on process exit', async () => {
    const snapshots: Array<Record<string, number>> = []
    const store = createStatsStore()
    const before = new Set(process.listeners('exit'))
    const { stdout, stdin } = createTestStreams()
    const root = await createRoot({
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      patchConsole: false,
    })

    try {
      root.render(
        <StatsProvider store={store}>
          <MetricsPublisher snapshots={snapshots} />
        </StatsProvider>,
      )

      await waitForCondition(() => snapshots.length > 0)
      expect(snapshots[0]).toMatchObject({
        count: 5,
        gauge: 8,
        timer_avg: 20,
        timer_count: 2,
        unique: 2,
      })

      const exitListener = process
        .listeners('exit')
        .find(listener => !before.has(listener))
      expect(exitListener).toBeDefined()
      exitListener?.(0)

      expect(saveCurrentProjectConfig).toHaveBeenCalledWith(expect.any(Function))
      const update = vi.mocked(saveCurrentProjectConfig).mock.calls[0]![0] as (
        current: Record<string, unknown>,
      ) => Record<string, unknown>
      expect(update({ keep: true })).toEqual({
        keep: true,
        lastSessionMetrics: expect.objectContaining({
          count: 5,
          gauge: 8,
          unique: 2,
        }),
      })
    } finally {
      root.unmount()
      stdin.end()
      stdout.end()
    }
  })
})
