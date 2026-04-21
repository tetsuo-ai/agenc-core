import { PassThrough } from 'node:stream'

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import React from 'react'

import Ink, {
  FRAME_INTERVAL_MS,
  I70_IDLE_INTERVAL_MS,
  I70_IDLE_THRESHOLD_MS,
} from './ink.js'

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

describe('I-70: throttle to 1fps on idle unless alt-screen mode', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  test('exports the documented threshold + interval constants', () => {
    expect(FRAME_INTERVAL_FROM_CONSTANTS).toBe(FRAME_INTERVAL_MS)
    expect(I70_IDLE_THRESHOLD_MS).toBe(5000)
    expect(I70_IDLE_INTERVAL_MS).toBe(1000)
  })

  test('drops the render interval to 1fps after 5001ms without a keystroke', () => {
    const { stdout, stderr, stdin } = makeStreams()
    const ink = new Ink({
      stdout: stdout as unknown as NodeJS.WriteStream,
      stderr: stderr as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      exitOnCtrlC: false,
      patchConsole: false,
    })
    const probe = ink as unknown as {
      i70LastStdinEventAt: number
      i70CurrentInterval: number
      altScreenActive: boolean
      scheduleRender: () => void
    }

    try {
      ink.render(React.createElement('ink-text', {}, 'idle test'))
      // Active path: timestamp is fresh, interval should reflect the active
      // 60fps cadence.
      probe.i70LastStdinEventAt = Date.now()
      probe.altScreenActive = false
      probe.scheduleRender()
      expect(probe.i70CurrentInterval).toBe(FRAME_INTERVAL_MS)

      // Advance just past the 5s threshold without any stdin event.
      vi.advanceTimersByTime(I70_IDLE_THRESHOLD_MS + 1)
      probe.scheduleRender()
      expect(probe.i70CurrentInterval).toBe(I70_IDLE_INTERVAL_MS)

      // A keystroke restores the active cadence on the next schedule.
      ink.dispatchKeyboardEvent({
        kind: 'key',
        name: 'a',
        fn: false,
        ctrl: false,
        meta: false,
        shift: false,
        option: false,
        super: false,
        sequence: 'a',
        raw: 'a',
        isPasted: false,
      } as unknown as Parameters<typeof ink.dispatchKeyboardEvent>[0])
      probe.scheduleRender()
      expect(probe.i70CurrentInterval).toBe(FRAME_INTERVAL_MS)
    } finally {
      ink.unmount()
    }
  })

  test('keeps the active cadence in alt-screen mode even when idle', () => {
    const { stdout, stderr, stdin } = makeStreams()
    const ink = new Ink({
      stdout: stdout as unknown as NodeJS.WriteStream,
      stderr: stderr as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      exitOnCtrlC: false,
      patchConsole: false,
    })
    const probe = ink as unknown as {
      i70LastStdinEventAt: number
      i70CurrentInterval: number
      altScreenActive: boolean
      scheduleRender: () => void
    }

    try {
      ink.render(React.createElement('ink-text', {}, 'alt screen'))
      probe.altScreenActive = true
      probe.i70LastStdinEventAt = Date.now()
      vi.advanceTimersByTime(I70_IDLE_THRESHOLD_MS + 1)
      probe.scheduleRender()
      // Alt-screen apps (full-screen TUIs, video-driven content, animations)
      // still need 60fps even when keyboard is idle.
      expect(probe.i70CurrentInterval).toBe(FRAME_INTERVAL_MS)
    } finally {
      ink.unmount()
    }
  })
})
