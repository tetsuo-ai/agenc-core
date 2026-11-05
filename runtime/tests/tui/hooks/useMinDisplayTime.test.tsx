import { PassThrough } from 'node:stream'

import React from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'

import Text from '../ink/components/Text.js'
import { createRoot } from '../ink/root.js'
import { useMinDisplayTime } from './useMinDisplayTime.js'

type TestStdin = PassThrough & {
  isTTY: boolean
  ref: () => void
  setRawMode: (mode: boolean) => void
  unref: () => void
}

type TestStreams = {
  stdin: TestStdin
  stdout: PassThrough
}

const cleanupRoots: Array<() => void> = []
// React schedules its work with setImmediate, which the fake clock leaves real.
const realSetImmediate = setImmediate

function createTestStreams(): TestStreams {
  const stdout = new PassThrough()
  ;(stdout as unknown as { columns: number }).columns = 80
  ;(stdout as unknown as { rows: number }).rows = 24

  const stdin = new PassThrough() as TestStdin
  stdin.isTTY = true
  stdin.setRawMode = () => {}
  stdin.ref = () => {}
  stdin.unref = () => {}

  return { stdin, stdout }
}

/**
 * Lets React commit pending work without moving the fake clock. Each test
 * decides when time passes, so a loaded machine cannot make the minimum
 * display time elapse early (a 5 ms real wait once outlasted 30 ms).
 */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) {
    await Promise.resolve()
    await new Promise(resolve => realSetImmediate(resolve))
  }
}

/** Starts the fake clock: timers and Date.now() move only with advance(). */
function useFakeClock(): void {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
}

async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
  await settle()
}

function MinDisplayProbe({
  minMs,
  snapshots,
  value,
}: {
  minMs: number
  snapshots: string[]
  value: string
}) {
  const displayed = useMinDisplayTime(value, minMs)

  React.useLayoutEffect(() => {
    snapshots.push(displayed)
  }, [displayed, snapshots])

  return <Text>{displayed}</Text>
}

async function createHarness(snapshots: string[], minMs = 30) {
  const { stdin, stdout } = createTestStreams()
  const root = await createRoot({
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    patchConsole: false,
  })
  cleanupRoots.push(() => {
    root.unmount()
    stdin.end()
    stdout.end()
  })

  const render = (value: string) => {
    root.render(
      <MinDisplayProbe minMs={minMs} snapshots={snapshots} value={value} />,
    )
  }

  return { render }
}

afterEach(() => {
  for (const cleanup of cleanupRoots.splice(0)) cleanup()
  vi.useRealTimers()
})

describe('useMinDisplayTime', () => {
  test('keeps each value visible until the minimum display time elapses', async () => {
    const snapshots: string[] = []
    const { render } = await createHarness(snapshots)
    useFakeClock()

    render('first')
    await settle()
    expect(snapshots).toEqual(['first'])

    render('second')
    await advance(29)
    expect(snapshots).not.toContain('second')

    await advance(1)
    expect(snapshots).toEqual(['first', 'second'])
  })

  test('cancels a pending delayed value when a newer value arrives', async () => {
    const snapshots: string[] = []
    const { render } = await createHarness(snapshots, 40)
    useFakeClock()

    render('one')
    await settle()
    expect(snapshots).toEqual(['one'])

    render('two')
    await advance(5)
    render('three')
    await advance(34)
    expect(snapshots).toEqual(['one'])

    await advance(1)
    expect(snapshots).toEqual(['one', 'three'])
    expect(snapshots).not.toContain('two')
  })

  test('updates immediately once enough time has elapsed', async () => {
    const snapshots: string[] = []
    const { render } = await createHarness(snapshots, 5)
    useFakeClock()

    render('initial')
    await settle()
    await advance(10)

    render('later')
    await settle()
    expect(snapshots).toEqual(['initial', 'later'])
  })
})
