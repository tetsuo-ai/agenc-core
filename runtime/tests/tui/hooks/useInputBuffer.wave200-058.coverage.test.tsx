import { PassThrough } from 'node:stream'

import React from 'react'
import { describe, expect, test } from 'vitest'

import { createRoot } from '../ink/root.js'
import {
  type UseInputBufferResult,
  useInputBuffer,
} from './useInputBuffer.js'

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
  readonly stdout: PassThrough
}

function createStreams(): TestStreams {
  const stdout = new PassThrough()
  const stdin = new PassThrough() as TestStreams['stdin']

  stdin.isTTY = true
  stdin.ref = () => {}
  stdin.setRawMode = () => {}
  stdin.unref = () => {}
  stdout.resume()

  return { stdin, stdout }
}

function sleep(ms = 25): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function renderHookHarness(
  options: HarnessOptions,
): Promise<{
  readonly dispose: () => Promise<void>
  readonly latest: () => UseInputBufferResult
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

  root.render(React.createElement(Harness))
  await sleep()

  return {
    dispose: async () => {
      root.unmount()
      stdin.end()
      stdout.end()
      await sleep()
    },
    latest: () => {
      if (latest === undefined) throw new Error('hook did not render')
      return latest
    },
  }
}

async function push(
  rendered: { readonly latest: () => UseInputBufferResult },
  text: string,
  cursorOffset = text.length,
): Promise<void> {
  rendered.latest().pushToBuffer(text, cursorOffset)
  await sleep()
}

describe('useInputBuffer coverage', () => {
  test('keeps undo history coherent across capped entries, branch edits, debounced clears, and duplicate pushes', async () => {
    const capped = await renderHookHarness({
      debounceMs: 0,
      maxBufferSize: 2,
    })

    try {
      await push(capped, 'one')
      await push(capped, 'two')
      await push(capped, 'three')

      expect(capped.latest().undo()).toEqual(
        expect.objectContaining({
          cursorOffset: 3,
          pastedContents: {},
          text: 'two',
        }),
      )
      await sleep()

      await push(capped, 'branch')
      expect(capped.latest().undo()).toEqual(
        expect.objectContaining({
          text: 'two',
        }),
      )
    } finally {
      await capped.dispose()
    }

    const debounced = await renderHookHarness({
      debounceMs: 50,
      maxBufferSize: 10,
    })

    try {
      debounced.latest().pushToBuffer('settled', 7)
      debounced.latest().pushToBuffer('pending', 7)
      debounced.latest().clearBuffer()
      await sleep(80)

      expect(debounced.latest().canUndo).toBe(false)
      expect(debounced.latest().undo()).toBeUndefined()
    } finally {
      await debounced.dispose()
    }

    const duplicates = await renderHookHarness({
      debounceMs: 0,
      maxBufferSize: 10,
    })

    try {
      await push(duplicates, 'alpha')
      await push(duplicates, 'beta')
      await push(duplicates, 'beta')

      expect(duplicates.latest().undo()).toEqual(
        expect.objectContaining({
          text: 'alpha',
        }),
      )
    } finally {
      await duplicates.dispose()
    }
  })
})
