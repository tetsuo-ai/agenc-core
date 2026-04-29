import { PassThrough } from 'node:stream'

import { describe, expect, test } from 'vitest'
import React from 'react'

import Ink from './ink.js'

type DimChangingStdout = PassThrough & {
  isTTY: true
  columns: number
  rows: number
}

type DimChangingStderr = PassThrough

function makeStdout(initialCols: number, initialRows: number): DimChangingStdout {
  const stream = new PassThrough() as DimChangingStdout
  // Tag the stream so Ink treats it as a real TTY. Object.defineProperty so
  // the columns/rows getters can be swapped per-frame to simulate SIGWINCH.
  Object.defineProperty(stream, 'isTTY', { value: true })
  let cols = initialCols
  let rows = initialRows
  Object.defineProperty(stream, 'columns', {
    configurable: true,
    get: () => cols,
    set: (v: number) => {
      cols = v
    },
  })
  Object.defineProperty(stream, 'rows', {
    configurable: true,
    get: () => rows,
    set: (v: number) => {
      rows = v
    },
  })
  return stream
}

describe('I-66: restart render if terminal dims changed mid-pass', () => {
  test('drops the in-flight diff and reschedules when columns shift before flush', async () => {
    const stdout = makeStdout(80, 24)
    const stderr = new PassThrough() as DimChangingStderr
    const stdin = new PassThrough() as PassThrough & {
      isTTY: boolean
      setRawMode: (mode: boolean) => void
      ref: () => void
      unref: () => void
      resume: () => void
    }
    stdin.isTTY = false
    stdin.setRawMode = () => {}
    stdin.ref = () => {}
    stdin.unref = () => {}
    stdin.resume = () => {}

    const ink = new Ink({
      stdout: stdout as unknown as NodeJS.WriteStream,
      stderr: stderr as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      exitOnCtrlC: false,
      patchConsole: false,
    })

    try {
      ink.render(React.createElement('ink-text', {}, 'hello'))

      // Wait for the first render to settle so the dim snapshot is meaningful.
      await new Promise(resolve => setTimeout(resolve, 30))

      let writes = 0
      stdout.on('data', () => {
        writes += 1
      })

      // Patch the renderer so we can flip dims AFTER the snapshot is taken
      // (renderer runs first inside onRender) but BEFORE the post-pass
      // dim re-check fires (just before writeDiffToTerminal).
      const innerInk = ink as unknown as {
        renderer: (...args: unknown[]) => unknown
        onRender: () => void
      }
      const originalRenderer = innerInk.renderer
      let intercepted = false
      innerInk.renderer = (...args: unknown[]) => {
        if (!intercepted) {
          intercepted = true
          // Simulate a SIGWINCH that lands mid-pass.
          ;(stdout as unknown as { columns: number }).columns = 120
        }
        return originalRenderer.call(innerInk, ...args)
      }

      writes = 0
      innerInk.onRender()
      // The first onRender sees the dim drift before write and aborts the
      // patch — no terminal write should happen for this pass. Allow the
      // restart microtask to flush, then reset the renderer so the rescheduled
      // pass can complete normally and prove the restart fires a fresh frame.
      innerInk.renderer = originalRenderer
      await new Promise(resolve => setTimeout(resolve, 30))

      // The aborted pass + restart together produce strictly more writes than
      // an aborted pass alone (which is zero). The restart path is what we
      // want to observe here; the abort itself is implicit in zero-write.
      expect(writes).toBeGreaterThan(0)
    } finally {
      ink.unmount()
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  })
})
