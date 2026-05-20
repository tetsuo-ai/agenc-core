import { PassThrough } from 'node:stream'

import React from 'react'
import { describe, expect, test } from 'vitest'

import type Ink from './ink.tsx'
import type { Frame } from './frame.ts'
import instances from './instances.ts'
import { createRoot, type Root } from './root.ts'
import { CURSOR_HOME, ERASE_SCREEN, cursorPosition } from './termio/csi.ts'
import { ENABLE_MOUSE_TRACKING } from './termio/dec.ts'

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
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function textNode(children: React.ReactNode): React.ReactElement {
  return React.createElement(
    'ink-text',
    {
      style: {
        flexDirection: 'row',
        flexGrow: 0,
        flexShrink: 1,
        textWrap: 'wrap',
      },
    },
    children,
  )
}

function createTestStreams(): {
  stdout: TestStdout
  stdin: TestStdin
  stderr: PassThrough
  stdoutWrites: string[]
} {
  const stdout = new PassThrough() as TestStdout
  const stdin = new PassThrough() as TestStdin
  const stderr = new PassThrough()
  const stdoutWrites: string[] = []

  stdout.columns = 18
  stdout.rows = 5
  stdout.isTTY = true
  stdout.on('data', chunk => {
    stdoutWrites.push(Buffer.from(chunk).toString('utf8'))
  })

  stdin.isTTY = true
  stdin.isRaw = false
  stdin.setRawMode = mode => {
    stdin.isRaw = mode
  }
  stdin.ref = () => {}
  stdin.unref = () => {}

  return { stdout, stdin, stderr, stdoutWrites }
}

function getInkInstance(stdout: PassThrough): InkInternals {
  const instance = instances.get(stdout as unknown as NodeJS.WriteStream)
  if (!instance) throw new Error('Ink instance not found')
  return instance as InkInternals
}

async function createHarness(): Promise<{
  root: Root
  instance: InkInternals
  stdout: TestStdout
  stdin: TestStdin
  stderr: PassThrough
  stdoutWrites: string[]
  dispose: () => Promise<void>
}> {
  const { stdout, stdin, stderr, stdoutWrites } = createTestStreams()
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
    dispose: async () => {
      root.unmount()
      stdin.end()
      stdout.end()
      stderr.end()
      await sleep(25)
    },
  }
}

describe('Ink resize coverage', () => {
  test('resizes alt-screen frames atomically and skips same-size resize events', async () => {
    const harness = await createHarness()

    try {
      harness.root.render(textNode('resize me'))
      await sleep(30)
      harness.instance.setAltScreenActive(true, true)
      await sleep(30)

      harness.stdoutWrites.length = 0
      harness.stdout.emit('resize')
      await sleep(30)
      expect(harness.stdoutWrites).toEqual([])
      expect(harness.instance.frontFrame.screen.width).toBe(18)
      expect(harness.instance.frontFrame.screen.height).toBe(5)

      harness.stdout.columns = 24
      harness.stdout.rows = 7
      harness.stdout.emit('resize')
      await sleep(30)

      const writes = harness.stdoutWrites.join('')
      expect(writes).toContain(ENABLE_MOUSE_TRACKING)
      expect(writes).toContain(ERASE_SCREEN + CURSOR_HOME)
      expect(writes).toContain(cursorPosition(7, 1))
      expect(harness.instance.frontFrame.screen.width).toBe(24)
      expect(harness.instance.frontFrame.screen.height).toBe(7)
      expect(harness.instance.frontFrame.viewport.height).toBe(8)
    } finally {
      await harness.dispose()
    }
  })
})
