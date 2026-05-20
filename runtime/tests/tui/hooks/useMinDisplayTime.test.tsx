import { PassThrough } from 'node:stream'

import React from 'react'
import { afterEach, describe, expect, test } from 'vitest'

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

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1_000,
): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('condition was not met')
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
})

describe('useMinDisplayTime', () => {
  test('keeps each value visible until the minimum display time elapses', async () => {
    const snapshots: string[] = []
    const { render } = await createHarness(snapshots)

    render('first')
    await waitFor(() => snapshots.includes('first'))

    render('second')
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(snapshots).not.toContain('second')

    await waitFor(() => snapshots.includes('second'))
  })

  test('cancels a pending delayed value when a newer value arrives', async () => {
    const snapshots: string[] = []
    const { render } = await createHarness(snapshots, 40)

    render('one')
    await waitFor(() => snapshots.includes('one'))

    render('two')
    await new Promise(resolve => setTimeout(resolve, 5))
    render('three')

    await waitFor(() => snapshots.includes('three'))
    expect(snapshots).not.toContain('two')
  })

  test('updates immediately once enough time has elapsed', async () => {
    const snapshots: string[] = []
    const { render } = await createHarness(snapshots, 5)

    render('initial')
    await waitFor(() => snapshots.includes('initial'))
    await new Promise(resolve => setTimeout(resolve, 10))

    render('later')
    await waitFor(() => snapshots.includes('later'))
  })
})
