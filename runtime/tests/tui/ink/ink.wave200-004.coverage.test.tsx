import { PassThrough } from 'node:stream'

import { describe, expect, test, vi } from 'vitest'

import type Ink from './ink.tsx'
import instances from './instances.ts'
import { createRoot, type Root } from './root.ts'

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
  prevFrameContaminated: boolean
}

function createStreams(): {
  stdout: TestStdout
  stdin: TestStdin
  stderr: PassThrough
} {
  const stdout = new PassThrough() as TestStdout
  const stdin = new PassThrough() as TestStdin
  const stderr = new PassThrough()

  stdout.columns = 24
  stdout.rows = 6
  stdout.isTTY = false

  stdin.isTTY = true
  stdin.isRaw = false
  stdin.setRawMode = mode => {
    stdin.isRaw = mode
  }
  stdin.ref = () => {}
  stdin.unref = () => {}

  return { stdout, stdin, stderr }
}

function getInkInstance(stdout: PassThrough): InkInternals {
  const instance = instances.get(stdout as unknown as NodeJS.WriteStream)
  if (!instance) throw new Error('Ink instance not found')
  return instance as InkInternals
}

describe('Ink console patch coverage', () => {
  test('restores patched console and stderr while repainting after alt-screen stderr writes', async () => {
    const originalConsoleLog = console.log
    const originalConsoleWarn = console.warn
    const originalConsoleAssert = console.assert
    const originalStderrWrite = process.stderr.write
    const { stdout, stdin, stderr } = createStreams()
    let root: Root | undefined

    try {
      root = await createRoot({
        stdout: stdout as unknown as NodeJS.WriteStream,
        stdin: stdin as unknown as NodeJS.ReadStream,
        stderr: stderr as unknown as NodeJS.WriteStream,
        patchConsole: true,
      })
      const instance = getInkInstance(stdout)

      expect(console.log).not.toBe(originalConsoleLog)
      expect(console.warn).not.toBe(originalConsoleWarn)
      expect(console.assert).not.toBe(originalConsoleAssert)
      expect(process.stderr.write).not.toBe(originalStderrWrite)

      console.log('debug %s', 'message')
      console.assert(true, 'assert %s', 'message')

      instance.setAltScreenActive(true)
      instance.prevFrameContaminated = false
      const callback = vi.fn()

      const result = process.stderr.write('direct stderr\n', callback)

      expect(result).toBe(true)
      expect(callback).toHaveBeenCalledOnce()
      expect(instance.prevFrameContaminated).toBe(true)

      root.unmount()
      root = undefined

      expect(console.log).toBe(originalConsoleLog)
      expect(console.warn).toBe(originalConsoleWarn)
      expect(console.assert).toBe(originalConsoleAssert)
      expect(process.stderr.write).toBe(originalStderrWrite)
    } finally {
      root?.unmount()
      stdin.end()
      stdout.end()
      stderr.end()
    }
  })
})
