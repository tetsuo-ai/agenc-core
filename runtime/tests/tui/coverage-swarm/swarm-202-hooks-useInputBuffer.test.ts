import { PassThrough } from 'node:stream'

import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { createRoot } from '../../../src/tui/ink/root.js'
import {
  type BufferEntry,
  type UseInputBufferResult,
  useInputBuffer,
} from '../../../src/tui/hooks/useInputBuffer.js'

type HarnessOptions = {
  debounceMs: number
  maxBufferSize: number
}

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

type PastedContents = NonNullable<
  Parameters<UseInputBufferResult['pushToBuffer']>[2]
>

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

async function advanceTimers(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
  await flushEffects()
}

async function renderHookHarness(
  options: HarnessOptions,
): Promise<{
  readonly clear: () => Promise<void>
  readonly dispose: () => Promise<void>
  readonly latest: () => UseInputBufferResult
  readonly push: (
    text: string,
    cursorOffset?: number,
    pastedContents?: PastedContents,
  ) => Promise<void>
  readonly undo: () => Promise<BufferEntry | undefined>
}> {
  let latest: UseInputBufferResult | undefined
  const { stdin, stdout } = createStreams()
  const root = await createRoot({
    patchConsole: false,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  })

  function Harness(): null {
    latest = useInputBuffer(options)
    return null
  }

  await act(async () => {
    root.render(React.createElement(Harness))
  })
  await flushEffects()

  function readLatest(): UseInputBufferResult {
    if (latest === undefined) throw new Error('hook did not render')
    return latest
  }

  return {
    clear: async () => {
      await act(async () => {
        readLatest().clearBuffer()
      })
      await flushEffects()
    },
    dispose: async () => {
      await act(async () => {
        root.unmount()
      })
      stdin.end()
      stdout.end()
      await flushEffects()
    },
    latest: readLatest,
    push: async (
      text: string,
      cursorOffset = text.length,
      pastedContents?: PastedContents,
    ) => {
      await act(async () => {
        readLatest().pushToBuffer(text, cursorOffset, pastedContents)
      })
      await flushEffects()
    },
    undo: async () => {
      let entry: BufferEntry | undefined
      await act(async () => {
        entry = readLatest().undo()
      })
      await flushEffects()
      return entry
    },
  }
}

describe('useInputBuffer coverage swarm 202', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  test('flushes only the latest debounced push and preserves pasted contents', async () => {
    const pastedContents = {
      7: {
        content: 'clipboard text',
        id: 7,
        type: 'text',
      },
    } satisfies PastedContents
    const rendered = await renderHookHarness({
      debounceMs: 50,
      maxBufferSize: 10,
    })

    try {
      await rendered.push('alpha')
      await act(async () => {
        rendered.latest().pushToBuffer('beta', 4)
        rendered.latest().pushToBuffer('gamma', 5, pastedContents)
      })
      await flushEffects()

      expect(rendered.latest().canUndo).toBe(false)

      await advanceTimers(50)
      expect(rendered.latest().canUndo).toBe(true)

      await advanceTimers(50)
      await rendered.push('delta')

      await expect(rendered.undo()).resolves.toEqual(
        expect.objectContaining({
          cursorOffset: 5,
          pastedContents,
          text: 'gamma',
        }),
      )
    } finally {
      await rendered.dispose()
    }
  })

  test('clearBuffer without a pending timeout drops history and resets debounce timing', async () => {
    const rendered = await renderHookHarness({
      debounceMs: 1_000,
      maxBufferSize: 5,
    })

    try {
      await rendered.push('before-clear')
      await rendered.clear()
      await rendered.push('after-clear')

      expect(rendered.latest().canUndo).toBe(false)
      await expect(rendered.undo()).resolves.toEqual(
        expect.objectContaining({
          cursorOffset: 'after-clear'.length,
          pastedContents: {},
          text: 'after-clear',
        }),
      )
    } finally {
      await rendered.dispose()
    }
  })
})
