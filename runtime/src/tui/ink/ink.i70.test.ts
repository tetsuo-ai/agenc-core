import { PassThrough } from 'node:stream'

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import React from 'react'

import Ink, { FRAME_INTERVAL_MS } from './ink.js'
import { FRAME_INTERVAL_MS as FRAME_INTERVAL_FROM_CONSTANTS } from './constants.js'

type TestStdout = PassThrough & {
  isTTY: true
  columns: number
  rows: number
}

type TestStdin = PassThrough & {
  isTTY: boolean
  setRawMode: (mode: boolean) => void
  ref: () => void
  unref: () => void
  resume: () => void
}

function makeStreams(): { stdout: TestStdout; stderr: PassThrough; stdin: TestStdin } {
  const stdout = new PassThrough() as TestStdout
  Object.defineProperty(stdout, 'isTTY', { value: true })
  Object.defineProperty(stdout, 'columns', { value: 80, writable: true })
  Object.defineProperty(stdout, 'rows', { value: 24, writable: true })

  const stderr = new PassThrough()

  const stdin = new PassThrough() as TestStdin
  stdin.isTTY = false
  stdin.setRawMode = () => {}
  stdin.ref = () => {}
  stdin.unref = () => {}
  stdin.resume = () => {}

  return { stdout, stderr, stdin }
}

describe('render scheduling', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  test('still exports the shared frame interval constant', () => {
    expect(FRAME_INTERVAL_FROM_CONSTANTS).toBe(FRAME_INTERVAL_MS)
  })

  test('keeps the normal frame cadence after a long idle gap', async () => {
    const { stdout, stderr, stdin } = makeStreams()
    const frames: number[] = []
    const ink = new Ink({
      stdout: stdout as unknown as NodeJS.WriteStream,
      stderr: stderr as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      exitOnCtrlC: false,
      patchConsole: false,
      onFrame: () => {
        frames.push(Date.now())
      },
    })
    const probe = ink as unknown as {
      scheduleRender: () => void
    }

    try {
      ink.render(React.createElement('ink-text', {}, 'fixed cadence'))
      await vi.runAllTimersAsync()
      frames.length = 0

      await vi.advanceTimersByTimeAsync(5001)

      probe.scheduleRender()
      await vi.runAllTimersAsync()
      expect(frames).toHaveLength(1)

      probe.scheduleRender()
      await vi.advanceTimersByTimeAsync(FRAME_INTERVAL_MS + 1)
      await vi.runAllTimersAsync()
      expect(frames).toHaveLength(2)
    } finally {
      ink.unmount()
    }
  })
})
