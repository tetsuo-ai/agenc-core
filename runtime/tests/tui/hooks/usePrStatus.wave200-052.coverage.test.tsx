import { PassThrough } from 'node:stream'

import React from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import Text from '../ink/components/Text.js'
import { createRoot } from '../ink/root.js'
import { usePrStatus, type PrStatusState } from './usePrStatus.js'

const harness = vi.hoisted(() => ({
  fetchPrStatus: vi.fn(),
  interactionTime: 1,
}))
const realSetImmediate = setImmediate

vi.mock('../../bootstrap/state.js', () => ({
  flushInteractionTime: vi.fn(),
  getActiveTimeCounter: () => 0,
  getLastInteractionTime: () => harness.interactionTime,
  markScrollActivity: vi.fn(),
  updateLastInteractionTime: vi.fn(),
}))

vi.mock('../../utils/ghPrStatus', () => ({
  fetchPrStatus: harness.fetchPrStatus,
}))

type TestStreams = {
  stdout: PassThrough & {
    columns: number
    isTTY: boolean
    rows: number
    write: ReturnType<typeof vi.fn>
  }
  stdin: PassThrough & {
    isTTY: boolean
    ref: () => void
    setRawMode: (mode: boolean) => void
    unref: () => void
  }
}

function createTestStreams(): TestStreams {
  const stdout = new PassThrough() as TestStreams['stdout']
  const stdin = new PassThrough() as TestStreams['stdin']

  stdout.columns = 120
  stdout.rows = 30
  stdout.isTTY = false
  stdout.write = vi.fn(() => true)
  stdout.resume()

  stdin.isTTY = true
  stdin.ref = () => {}
  stdin.setRawMode = () => {}
  stdin.unref = () => {}

  return { stdout, stdin }
}

async function flushEffects(): Promise<void> {
  await Promise.resolve()
  await vi.advanceTimersByTimeAsync(16)
  await new Promise(resolve => realSetImmediate(resolve))
  await Promise.resolve()
}

async function waitForCondition(
  predicate: () => boolean,
  label: string,
): Promise<void> {
  for (let attempts = 0; attempts < 20; attempts += 1) {
    await flushEffects()
    if (predicate()) return
  }

  throw new Error(`Timed out waiting for ${label}`)
}

function Harness({
  enabled,
  isLoading,
  snapshots,
}: {
  enabled: boolean
  isLoading: boolean
  snapshots: PrStatusState[]
}): React.ReactNode {
  const prStatus = usePrStatus(isLoading, enabled)

  React.useEffect(() => {
    snapshots.push(prStatus)
  }, [prStatus, snapshots])

  return <Text>{prStatus.reviewState ?? 'none'}</Text>
}

describe('usePrStatus coverage', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(120_000)
    harness.fetchPrStatus.mockReset()
    harness.interactionTime = 1
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  test('reschedules from the last fetch time and disables future polling after a slow unchanged result', async () => {
    const pr = {
      number: 52,
      reviewState: 'pending',
      url: 'https://example.test/pull/52',
    }
    const snapshots: PrStatusState[] = []
    const streams = createTestStreams()
    const root = await createRoot({
      stdin: streams.stdin as unknown as NodeJS.ReadStream,
      stdout: streams.stdout as unknown as NodeJS.WriteStream,
      patchConsole: false,
    })

    harness.fetchPrStatus.mockImplementation(async () => {
      if (harness.fetchPrStatus.mock.calls.length === 2) {
        vi.setSystemTime(Date.now() + 4_001)
      }

      return pr
    })

    try {
      root.render(
        <Harness enabled={true} isLoading={false} snapshots={snapshots} />,
      )

      await waitForCondition(
        () => snapshots.some(snapshot => snapshot.number === 52),
        'initial PR status',
      )

      expect(harness.fetchPrStatus).toHaveBeenCalledTimes(1)
      const firstUpdated = snapshots.find(
        snapshot => snapshot.number === 52,
      )?.lastUpdated
      expect(firstUpdated).toBeGreaterThanOrEqual(120_000)

      root.render(
        <Harness enabled={true} isLoading={true} snapshots={snapshots} />,
      )
      await flushEffects()
      await vi.advanceTimersByTimeAsync(59_000)
      expect(harness.fetchPrStatus).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(1_000)
      await waitForCondition(
        () => harness.fetchPrStatus.mock.calls.length === 2,
        'second PR status poll',
      )

      expect(snapshots.at(-1)?.lastUpdated).toBe(firstUpdated)

      root.render(
        <Harness enabled={true} isLoading={false} snapshots={snapshots} />,
      )
      await flushEffects()
      await vi.advanceTimersByTimeAsync(60_000)
      await flushEffects()

      expect(harness.fetchPrStatus).toHaveBeenCalledTimes(2)
    } finally {
      root.unmount()
      streams.stdin.end()
      streams.stdout.end()
    }
  })
})
