import { PassThrough } from 'node:stream'

import React from 'react'
import stripAnsi from 'strip-ansi'
import { describe, expect, test } from 'vitest'

import { ShellProgressMessage } from '../../../src/tui/components/shell/ShellProgressMessage.js'
import { createRoot } from '../../../src/tui/ink.js'

type TestStdin = PassThrough & {
  isTTY: boolean
  ref: () => void
  setRawMode: (mode: boolean) => void
  unref: () => void
}

type TestStdout = PassThrough & {
  columns: number
  rows: number
  isTTY: boolean
}

function createStreams(): {
  readonly stdin: TestStdin
  readonly stdout: TestStdout
} {
  const stdin = new PassThrough() as TestStdin
  const stdout = new PassThrough() as TestStdout

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

function sleep(ms = 25): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function normalize(output: string): string {
  return stripAnsi(output).replace(/\s+/g, ' ')
}

describe('ShellProgressMessage coverage swarm row 074', () => {
  test('reuses cached compact output on identical rerenders', async () => {
    const { stdin, stdout } = createStreams()
    let output = ''

    stdout.on('data', chunk => {
      output += chunk.toString()
    })

    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    })
    const renderNode = () => (
      <ShellProgressMessage
        elapsedTimeSeconds={5}
        fullOutput={'first\nsecond\nthird'}
        output={'first\nsecond\nthird'}
        timeoutMs={undefined}
        totalBytes={2048}
        totalLines={undefined}
        verbose={false}
      />
    )

    try {
      root.render(renderNode())
      await sleep()
      root.render(renderNode())
      await sleep()

      const text = normalize(output)
      expect(text).toContain('first')
      expect(text).toContain('second')
      expect(text).toContain('third')
      expect(text).toContain('(5s)')
      expect(text).toContain('2KB')
      expect(text).not.toContain('lines')
    } finally {
      root.unmount()
      stdin.end()
      stdout.end()
      await sleep()
    }
  })

  test('reuses cached running output on identical rerenders', async () => {
    const { stdin, stdout } = createStreams()
    let output = ''

    stdout.on('data', chunk => {
      output += chunk.toString()
    })

    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    })
    const renderNode = () => (
      <ShellProgressMessage
        elapsedTimeSeconds={undefined}
        fullOutput={'\u001b[31m\u001b[0m   '}
        output={'   '}
        timeoutMs={undefined}
        verbose={false}
      />
    )

    try {
      root.render(renderNode())
      await sleep()
      root.render(renderNode())
      await sleep()

      const text = normalize(output)
      expect(text).toContain('Running')
      expect(text).not.toContain('timeout')
      expect(text).not.toContain('lines')
    } finally {
      root.unmount()
      stdin.end()
      stdout.end()
      await sleep()
    }
  })
})
