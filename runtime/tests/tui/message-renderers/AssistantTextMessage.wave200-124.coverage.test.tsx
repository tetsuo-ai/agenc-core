import { PassThrough } from 'node:stream'

import React from 'react'
import stripAnsi from 'strip-ansi'
import { afterEach, describe, expect, test } from 'vitest'

import { API_TIMEOUT_ERROR_MESSAGE } from '../../services/api/errors.js'
import { createRoot } from '../ink/root.js'
import { AssistantTextMessage } from './AssistantTextMessage.js'

const originalApiTimeoutMs = process.env.API_TIMEOUT_MS

function createStreams(): {
  readonly stdin: PassThrough & {
    isTTY: boolean
    ref: () => void
    setRawMode: (mode: boolean) => void
    unref: () => void
  }
  readonly stdout: PassThrough
} {
  const stdout = new PassThrough()
  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean
    ref: () => void
    setRawMode: (mode: boolean) => void
    unref: () => void
  }

  stdin.isTTY = true
  stdin.ref = () => {}
  stdin.setRawMode = () => {}
  stdin.unref = () => {}
  stdout.resume()
  ;(stdout as unknown as { columns: number; rows: number }).columns = 100
  ;(stdout as unknown as { columns: number; rows: number }).rows = 24

  return { stdin, stdout }
}

function sleep(ms = 25): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

afterEach(() => {
  if (originalApiTimeoutMs === undefined) {
    delete process.env.API_TIMEOUT_MS
  } else {
    process.env.API_TIMEOUT_MS = originalApiTimeoutMs
  }
})

describe('AssistantTextMessage wave200-124 coverage', () => {
  test('renders the configured API timeout hint across identical TUI rerenders', async () => {
    process.env.API_TIMEOUT_MS = '4321'
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
      <AssistantTextMessage
        addMargin={false}
        param={{ type: 'text', text: API_TIMEOUT_ERROR_MESSAGE }}
        shouldShowDot={false}
        verbose={false}
      />
    )

    try {
      root.render(renderNode())
      await sleep()
      root.render(renderNode())
      await sleep()

      const text = stripAnsi(output)
      expect(text).toContain(API_TIMEOUT_ERROR_MESSAGE)
      expect(text).toContain('(API_TIMEOUT_MS=4321ms, try increasing it)')
    } finally {
      root.unmount()
      stdin.end()
      stdout.end()
      await sleep()
    }
  })
})
