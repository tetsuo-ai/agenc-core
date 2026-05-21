import { PassThrough } from 'node:stream'

import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  intervalCallback: undefined as (() => void) | undefined,
  intervalDelay: undefined as number | null | undefined,
}))

vi.mock('usehooks-ts', () => ({
  useInterval: (callback: () => void, delay: number | null) => {
    fixture.intervalCallback = callback
    fixture.intervalDelay = delay
  },
}))

import { createRoot } from '../../../src/tui/ink.js'
import {
  type MemoryUsageInfo,
  useMemoryUsage,
} from '../../../src/tui/hooks/useMemoryUsage.js'

type TestStreams = {
  readonly stdin: PassThrough & {
    isTTY: boolean
    ref: () => void
    setRawMode: (mode: boolean) => void
    unref: () => void
  }
  readonly stdout: PassThrough & {
    columns: number
    isTTY: boolean
    rows: number
  }
}

const HIGH_MEMORY_THRESHOLD = 1.5 * 1024 * 1024 * 1024
const CRITICAL_MEMORY_THRESHOLD = 2.5 * 1024 * 1024 * 1024

function createStreams(): TestStreams {
  const stdin = new PassThrough() as TestStreams['stdin']
  const stdout = new PassThrough() as TestStreams['stdout']

  stdin.isTTY = true
  stdin.ref = () => {}
  stdin.setRawMode = () => {}
  stdin.unref = () => {}

  stdout.columns = 100
  stdout.rows = 24
  stdout.isTTY = true
  stdout.resume()

  return { stdin, stdout }
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
}

async function renderHookHarness(): Promise<{
  readonly dispose: () => Promise<void>
  readonly latest: () => MemoryUsageInfo | null
}> {
  let latest: MemoryUsageInfo | null | undefined
  const { stdin, stdout } = createStreams()
  const root = await createRoot({
    patchConsole: false,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  })

  function Harness(): null {
    latest = useMemoryUsage()
    return null
  }

  await act(async () => {
    root.render(React.createElement(Harness))
  })
  await flushEffects()

  return {
    dispose: async () => {
      root.unmount()
      stdin.end()
      stdout.end()
      await flushEffects()
    },
    latest: () => {
      if (latest === undefined) throw new Error('hook did not render')
      return latest
    },
  }
}

describe('useMemoryUsage coverage swarm 116', () => {
  let heapUsed = 0
  let memoryUsageSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    fixture.intervalCallback = undefined
    fixture.intervalDelay = undefined
    heapUsed = 0
    const baseMemoryUsage = process.memoryUsage()
    memoryUsageSpy = vi
      .spyOn(process, 'memoryUsage')
      .mockImplementation(() => ({ ...baseMemoryUsage, heapUsed }))
  })

  afterEach(() => {
    memoryUsageSpy.mockRestore()
  })

  test('reports high and critical heap usage while suppressing normal usage', async () => {
    const rendered = await renderHookHarness()

    async function poll(nextHeapUsed: number): Promise<void> {
      heapUsed = nextHeapUsed
      const callback = fixture.intervalCallback
      if (callback === undefined) {
        throw new Error('memory usage interval was not registered')
      }

      await act(async () => {
        callback()
      })
      await flushEffects()
    }

    try {
      expect(fixture.intervalDelay).toBe(10_000)
      expect(rendered.latest()).toBeNull()

      await poll(HIGH_MEMORY_THRESHOLD - 1)
      expect(rendered.latest()).toBeNull()

      await poll(HIGH_MEMORY_THRESHOLD)
      expect(rendered.latest()).toEqual({
        heapUsed: HIGH_MEMORY_THRESHOLD,
        status: 'high',
      })

      await poll(CRITICAL_MEMORY_THRESHOLD)
      expect(rendered.latest()).toEqual({
        heapUsed: CRITICAL_MEMORY_THRESHOLD,
        status: 'critical',
      })

      await poll(0)
      expect(rendered.latest()).toBeNull()
    } finally {
      await rendered.dispose()
    }
  })
})
