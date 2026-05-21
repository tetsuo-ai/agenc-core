import { PassThrough } from 'node:stream'

import React from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const terminalHarness = vi.hoisted(() => ({
  progressAvailable: false,
}))

vi.mock('../../../src/utils/env.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../src/utils/env.js')>()
  return {
    ...actual,
    env: {
      ...actual.env,
      terminal: 'xterm',
    },
  }
})

vi.mock('../../../src/tui/ink/terminal.js', async importOriginal => {
  const actual =
    await importOriginal<typeof import('../../../src/tui/ink/terminal.js')>()
  return {
    ...actual,
    isProgressReportingAvailable: () => terminalHarness.progressAvailable,
  }
})

import { createRoot, type Root } from '../../../src/tui/ink.js'
import {
  type TerminalNotification,
  TerminalWriteProvider,
  useTerminalNotification,
} from '../../../src/tui/ink/useTerminalNotification.js'

type TestStreams = {
  readonly stdin: PassThrough & { isTTY: boolean }
  readonly stdout: PassThrough & {
    columns: number
    isTTY: boolean
    rows: number
  }
  readonly stderr: PassThrough
}

const originalTmux = process.env['TMUX']
const originalSty = process.env['STY']

beforeEach(() => {
  terminalHarness.progressAvailable = false
  delete process.env['TMUX']
  delete process.env['STY']
})

afterEach(() => {
  restoreEnv('TMUX', originalTmux)
  restoreEnv('STY', originalSty)
})

function restoreEnv(key: 'TMUX' | 'STY', value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key]
  } else {
    process.env[key] = value
  }
}

function createStreams(): TestStreams {
  const stdin = new PassThrough() as TestStreams['stdin']
  stdin.isTTY = false

  const stdout = new PassThrough() as TestStreams['stdout']
  stdout.columns = 80
  stdout.rows = 24
  stdout.isTTY = false
  stdout.resume()

  const stderr = new PassThrough()
  return { stdin, stdout, stderr }
}

async function withRoot(
  run: (root: Root, streams: TestStreams) => Promise<void> | void,
): Promise<void> {
  const streams = createStreams()
  const root = await createRoot({
    patchConsole: false,
    stderr: streams.stderr as unknown as NodeJS.WriteStream,
    stdin: streams.stdin as unknown as NodeJS.ReadStream,
    stdout: streams.stdout as unknown as NodeJS.WriteStream,
  })

  try {
    await run(root, streams)
  } finally {
    root.unmount()
    streams.stdin.end()
    streams.stdout.end()
    streams.stderr.end()
  }
}

async function waitForCondition(
  condition: () => boolean,
  failureMessage: string,
): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (condition()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(failureMessage)
}

function osc(...parts: readonly (number | string)[]): string {
  return `\x1b]${parts.join(';')}\x07`
}

function tmuxWrap(sequence: string): string {
  return `\x1bPtmux;${sequence.replaceAll('\x1b', '\x1b\x1b')}\x1b\\`
}

function CaptureNotification({
  onCapture,
}: {
  readonly onCapture: (notification: TerminalNotification) => void
}): null {
  onCapture(useTerminalNotification())
  return null
}

let latestBoundaryError: Error | undefined

function MissingProviderProbe(): null {
  useTerminalNotification()
  return null
}

class CaptureErrorBoundary extends React.Component<
  {
    readonly children: React.ReactNode
    readonly onError: (error: Error) => void
  },
  { readonly failed: boolean }
> {
  override state = { failed: false }

  static getDerivedStateFromError(error: Error): { readonly failed: boolean } {
    latestBoundaryError = error
    return { failed: true }
  }

  override componentDidCatch(error: Error): void {
    this.props.onError(error)
  }

  override render(): React.ReactNode {
    return this.state.failed ? null : this.props.children
  }
}

describe('useTerminalNotification coverage swarm row 223', () => {
  test('reports a clear error when the terminal writer is missing', async () => {
    await withRoot(async root => {
      let capturedError: Error | undefined
      latestBoundaryError = undefined

      root.render(
        React.createElement(
          CaptureErrorBoundary,
          {
            onError: error => {
              capturedError = error
            },
          },
          React.createElement(
            TerminalWriteProvider,
            { value: null },
            React.createElement(MissingProviderProbe),
          ),
        ),
      )

      await waitForCondition(
        () => capturedError !== undefined || latestBoundaryError !== undefined,
        'Timed out waiting for TerminalWriteProvider error',
      )

      expect((capturedError ?? latestBoundaryError)?.message).toBe(
        'useTerminalNotification must be used within TerminalWriteProvider',
      )
    })
  })

  test('emits notification and reachable progress sequences', async () => {
    await withRoot(async root => {
      const writes: string[] = []
      let notification: TerminalNotification | undefined

      root.render(
        React.createElement(
          TerminalWriteProvider,
          { value: data => writes.push(data) },
          React.createElement(CaptureNotification, {
            onCapture: captured => {
              notification = captured
            },
          }),
        ),
      )

      await waitForCondition(
        () => notification !== undefined,
        'Timed out waiting for terminal notification hook',
      )

      notification?.progress('running', 41.4)
      expect(writes).toEqual([])

      notification?.notifyITerm2({ message: 'build passed', title: 'AgenC' })
      notification?.notifyITerm2({ message: 'plain notice' })
      notification?.notifyKitty({
        id: 7,
        message: 'job complete',
        title: 'Worker',
      })
      notification?.notifyGhostty({ message: 'ready', title: 'Session' })
      notification?.notifyBell()

      terminalHarness.progressAvailable = true
      notification?.progress(null)
      notification?.progress('completed')
      notification?.progress('error', -4.5)
      notification?.progress('indeterminate')
      notification?.progress('running', 100.5)
      notification?.progress('running')

      expect(writes).toEqual([
        osc(9, '\n\nAgenC:\nbuild passed'),
        osc(9, '\n\nplain notice'),
        osc(99, 'i=7:d=0:p=title', 'Worker'),
        osc(99, 'i=7:p=body', 'job complete'),
        osc(99, 'i=7:d=1:a=focus', ''),
        osc(777, 'notify', 'Session', 'ready'),
        '\x07',
        osc(9, 4, 0, ''),
        osc(9, 4, 0, ''),
        osc(9, 4, 2, 0),
        osc(9, 4, 3, ''),
        osc(9, 4, 1, 100),
        osc(9, 4, 1, 0),
      ])
    })
  })

  test('wraps OSC notifications for tmux while keeping bell raw', async () => {
    await withRoot(async root => {
      const writes: string[] = []
      let notification: TerminalNotification | undefined

      process.env['TMUX'] = '/tmp/tmux-1000/default,1,0'

      root.render(
        React.createElement(
          TerminalWriteProvider,
          { value: data => writes.push(data) },
          React.createElement(CaptureNotification, {
            onCapture: captured => {
              notification = captured
            },
          }),
        ),
      )

      await waitForCondition(
        () => notification !== undefined,
        'Timed out waiting for terminal notification hook',
      )

      notification?.notifyITerm2({ message: 'mux notice', title: 'Session' })
      notification?.notifyBell()

      expect(writes).toEqual([
        tmuxWrap(osc(9, '\n\nSession:\nmux notice')),
        '\x07',
      ])
    })
  })
})
