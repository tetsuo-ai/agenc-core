import { PassThrough } from 'node:stream'

import React from 'react'
import { describe, expect, test, vi } from 'vitest'

import type Ink from '../ink/ink.tsx'
import type { Frame } from '../ink/frame.ts'
import instances from '../ink/instances.ts'
import { createRoot, type Root } from '../ink/root.ts'
import { CURSOR_HOME, DISABLE_KITTY_KEYBOARD, DISABLE_MODIFY_OTHER_KEYS, ERASE_SCREEN } from '../ink/termio/csi.ts'
import { DISABLE_MOUSE_TRACKING, ENABLE_MOUSE_TRACKING, ENTER_ALT_SCREEN, EXIT_ALT_SCREEN } from '../ink/termio/dec.ts'

type TestStdout = PassThrough & {
  columns: number
  rows: number
  isTTY: boolean
}

type TestStdin = PassThrough & {
  isTTY: boolean
  isRaw?: boolean
  setRawMode: (mode: boolean) => void
  ref: () => void
  unref: () => void
}

type InkInternals = Ink & {
  frontFrame: Frame
  handleResume: () => void
}

const RAW_TEXT_STYLE = {
  flexDirection: 'row',
  flexGrow: 0,
  flexShrink: 1,
  textWrap: 'wrap',
} as const

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function textNode(children: React.ReactNode): React.ReactElement {
  return React.createElement(
    'ink-text',
    {
      style: RAW_TEXT_STYLE,
    },
    children,
  )
}

function columnNode(...rows: string[]): React.ReactElement {
  return React.createElement(
    'ink-box',
    {
      style: {
        flexDirection: 'column',
        flexGrow: 0,
        flexShrink: 1,
      },
    },
    rows.map((row, index) =>
      React.createElement(
        'ink-text',
        {
          key: index,
          style: RAW_TEXT_STYLE,
        },
        row,
      ),
    ),
  )
}

function createTestStreams(options: {
  columns?: number
  rows?: number
  stdoutIsTTY?: boolean
  stdinIsTTY?: boolean
  stdinIsRaw?: boolean
} = {}): {
  stdout: TestStdout
  stdin: TestStdin
  stderr: PassThrough
  stdoutWrites: string[]
  rawModes: boolean[]
} {
  const stdout = new PassThrough() as TestStdout
  const stdin = new PassThrough() as TestStdin
  const stderr = new PassThrough()
  const stdoutWrites: string[] = []
  const rawModes: boolean[] = []

  stdout.columns = options.columns ?? 24
  stdout.rows = options.rows ?? 6
  stdout.isTTY = options.stdoutIsTTY ?? true
  stdout.on('data', chunk => {
    stdoutWrites.push(Buffer.from(chunk).toString('utf8'))
  })

  stdin.isTTY = options.stdinIsTTY ?? true
  stdin.isRaw = options.stdinIsRaw ?? false
  stdin.setRawMode = (mode: boolean) => {
    rawModes.push(mode)
    stdin.isRaw = mode
  }
  stdin.ref = () => {}
  stdin.unref = () => {}

  return { stdout, stdin, stderr, stdoutWrites, rawModes }
}

function getInkInstance(stdout: PassThrough): InkInternals {
  const instance = instances.get(stdout as unknown as NodeJS.WriteStream)
  if (!instance) throw new Error('Ink instance not found')
  return instance as unknown as InkInternals
}

async function createHarness(options: {
  columns?: number
  rows?: number
  stdoutIsTTY?: boolean
  stdinIsTTY?: boolean
  stdinIsRaw?: boolean
} = {}): Promise<{
  root: Root
  instance: InkInternals
  stdout: TestStdout
  stdin: TestStdin
  stderr: PassThrough
  stdoutWrites: string[]
  rawModes: boolean[]
  dispose: () => Promise<void>
}> {
  const { stdout, stdin, stderr, stdoutWrites, rawModes } =
    createTestStreams(options)
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stderr: stderr as unknown as NodeJS.WriteStream,
    patchConsole: false,
  })
  const instance = getInkInstance(stdout)

  return {
    root,
    instance,
    stdout,
    stdin,
    stderr,
    stdoutWrites,
    rawModes,
    dispose: async () => {
      root.unmount()
      stdin.end()
      stdout.end()
      stderr.end()
      await sleep(25)
    },
  }
}

describe('Ink coverage swarm row 004', () => {
  test('handles resume paths for main-screen and alt-screen buffers', async () => {
    const harness = await createHarness({ columns: 22, rows: 5 })

    try {
      harness.root.render(textNode('resume'))
      await sleep(10)

      harness.stdoutWrites.length = 0
      harness.instance.handleResume()

      expect(harness.stdoutWrites.join('')).toBe('')
      expect(harness.instance.frontFrame.screen.width).toBe(0)
      expect(harness.instance.frontFrame.screen.height).toBe(0)

      harness.instance.setAltScreenActive(true, true)
      harness.stdoutWrites.length = 0

      harness.instance.handleResume()

      const writes = harness.stdoutWrites.join('')
      expect(writes).toContain(ENTER_ALT_SCREEN + ERASE_SCREEN + CURSOR_HOME)
      expect(writes).toContain(ENABLE_MOUSE_TRACKING)
      expect(harness.instance.frontFrame.screen.width).toBe(22)
      expect(harness.instance.frontFrame.screen.height).toBe(5)
    } finally {
      await harness.dispose()
    }
  })

  test('hands off and restores external alternate-screen terminal sessions', async () => {
    const harness = await createHarness({ stdinIsRaw: true })
    const readableListener = vi.fn()

    try {
      harness.root.render(textNode('handoff'))
      await sleep(10)
      harness.stdin.on('readable', readableListener)

      harness.stdoutWrites.length = 0
      harness.instance.enterAlternateScreen()

      let writes = harness.stdoutWrites.join('')
      expect(harness.stdin.listenerCount('readable')).toBe(0)
      expect(harness.rawModes.at(-1)).toBe(false)
      expect(writes).toContain(
        DISABLE_KITTY_KEYBOARD + DISABLE_MODIFY_OTHER_KEYS,
      )
      expect(writes).toContain(ENTER_ALT_SCREEN)

      harness.stdoutWrites.length = 0
      harness.instance.exitAlternateScreen()

      writes = harness.stdoutWrites.join('')
      expect(harness.stdin.listeners('readable')).toContain(readableListener)
      expect(harness.rawModes.at(-1)).toBe(true)
      expect(writes).toContain(EXIT_ALT_SCREEN)

      harness.instance.setAltScreenActive(true, true)
      harness.stdoutWrites.length = 0
      harness.instance.enterAlternateScreen()

      writes = harness.stdoutWrites.join('')
      expect(writes).toContain(DISABLE_MOUSE_TRACKING)
      expect(writes).not.toContain(ENTER_ALT_SCREEN)

      harness.stdoutWrites.length = 0
      harness.instance.exitAlternateScreen()

      writes = harness.stdoutWrites.join('')
      expect(writes).toContain(ENTER_ALT_SCREEN + ERASE_SCREEN + CURSOR_HOME)
      expect(writes).toContain(ENABLE_MOUSE_TRACKING)
      expect(writes).not.toContain(EXIT_ALT_SCREEN)
    } finally {
      await harness.dispose()
    }
  })

  test('covers selection helpers and keyboard extension edge cases', async () => {
    const harness = await createHarness({ columns: 12, rows: 5 })
    const selectionChanges = vi.fn()

    try {
      harness.instance.setAltScreenActive(true)
      harness.root.render(columnNode('alpha', 'beta', 'gamma'))
      await sleep(10)

      harness.instance.setSelectionBgColor('not-a-real-color')
      harness.instance.setSelectionBgColor('#102030')

      const unsubscribe =
        harness.instance.subscribeToSelectionChange(selectionChanges)
      const selection = harness.instance.selection
      selection.anchor = { col: 0, row: 1 }
      selection.focus = { col: 0, row: 1 }
      selection.isDragging = false

      harness.instance.moveSelectionFocus('left')
      expect(selection.focus).toEqual({
        col: harness.instance.frontFrame.screen.width - 1,
        row: 0,
      })

      harness.instance.moveSelectionFocus('right')
      expect(selection.focus).toEqual({ col: 0, row: 1 })

      harness.instance.moveSelectionFocus('down')
      expect(selection.focus).toEqual({ col: 0, row: 2 })

      harness.instance.moveSelectionFocus('up')
      expect(selection.focus).toEqual({ col: 0, row: 1 })

      harness.instance.moveSelectionFocus('lineEnd')
      expect(selection.focus).toEqual({
        col: harness.instance.frontFrame.screen.width - 1,
        row: 1,
      })

      harness.instance.moveSelectionFocus('lineStart')
      expect(selection.focus).toEqual({ col: 0, row: 1 })

      selection.anchor = { col: 0, row: 0 }
      selection.focus = { col: 2, row: 0 }
      harness.instance.captureScrolledRows(0, 0, 'above')
      expect(selection.scrolledOffAbove).toEqual(['alp'])

      harness.instance.setAltScreenActive(false)
      harness.instance.moveSelectionFocus('right')
      expect(selection.focus).toEqual({ col: 2, row: 0 })

      harness.instance.setAltScreenActive(true)
      selection.focus = null
      harness.instance.moveSelectionFocus('right')
      expect(selection.focus).toBeNull()

      selection.anchor = { col: 0, row: 0 }
      selection.focus = { col: 1, row: 0 }
      harness.instance.shiftSelectionForScroll(-5, 0, 1)

      expect(harness.instance.hasTextSelection()).toBe(false)
      expect(selectionChanges).toHaveBeenCalled()
      unsubscribe()
    } finally {
      await harness.dispose()
    }
  })
})
