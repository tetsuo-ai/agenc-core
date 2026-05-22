import { PassThrough } from 'node:stream'

import React from 'react'
import stripAnsi from 'strip-ansi'
import { describe, expect, test, vi } from 'vitest'

import { createRoot } from '../../../src/tui/ink.js'
import { SystemTextMessage } from '../../../src/tui/message-renderers/SystemTextMessage.js'

const appState = vi.hoisted(() => {
  const state = {
    tasks: {
      shell: {
        id: 'shell',
        type: 'local_bash',
        status: 'running',
        description: 'npm test',
        command: 'npm test',
        startTime: 0,
        outputFile: 'urn:agenc:task:shell:output',
        outputOffset: 0,
        notified: false,
        isBackgrounded: true,
      },
    },
  }

  return {
    store: {
      getState: () => state,
    },
  }
})

vi.mock('bun:bundle', () => ({
  feature: () => false,
}))

vi.mock('../../../src/utils/config.js', () => ({
  getGlobalConfig: () => ({ showTurnDuration: true }),
}))

vi.mock('../../../src/utils/browser.js', () => ({
  openPath: () => {},
}))

vi.mock('../../../src/tui/state/AppState.js', () => ({
  useAppStateStore: () => appState.store,
}))

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

function renderNode(): React.ReactElement {
  return (
    <SystemTextMessage
      message={{
        type: 'system',
        subtype: 'turn_duration',
        durationMs: 2400,
        budgetTokens: 400,
        budgetLimit: 800,
        budgetNudges: 0,
      } as never}
      addMargin={false}
      verbose={false}
    />
  )
}

describe('SystemTextMessage coverage swarm 007', () => {
  test('reuses the turn-duration app-state selector across identical rerenders', async () => {
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

    try {
      root.render(renderNode())
      await sleep()
      root.render(renderNode())
      await sleep()

      const text = stripAnsi(output).replace(/\s+/g, '')
      expect(text).toContain('400/800(50%)')
      expect(text).toContain('1shellstillrunning')
    } finally {
      root.unmount()
      stdin.end()
      stdout.end()
      await sleep()
    }
  })
})
