import { PassThrough } from 'node:stream'

import React from 'react'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import { createRoot } from '../ink/root.js'
import {
  type IDESelection,
  useIdeSelection,
} from './useIdeSelection.js'

type SelectionPoint = {
  readonly line: number
  readonly character: number
}

type SelectionNotificationParams = {
  readonly selection?: {
    readonly start: SelectionPoint
    readonly end: SelectionPoint
  } | null
  readonly text?: string
  readonly filePath?: string
}

type NotificationHandler = (notification: {
  readonly params: SelectionNotificationParams
}) => void

type TestIdeClient = {
  readonly client: {
    readonly setNotificationHandler: ReturnType<typeof vi.fn>
  }
  readonly emit: (params: SelectionNotificationParams) => void
}

const fixture = vi.hoisted(() => ({
  ideClient: undefined as TestIdeClient | undefined,
  logError: vi.fn(),
}))

vi.mock('../../utils/ide', () => ({
  getConnectedIdeClient: () => fixture.ideClient,
}))

vi.mock('../../utils/log.js', () => ({
  logError: fixture.logError,
}))

function createIdeClient(): TestIdeClient {
  let handler: NotificationHandler | undefined

  return {
    client: {
      setNotificationHandler: vi.fn(
        (_schema: unknown, next: NotificationHandler) => {
          handler = next
        },
      ),
    },
    emit: (params: SelectionNotificationParams) => {
      if (handler === undefined) {
        throw new Error('selection handler was not registered')
      }
      handler({ params })
    },
  }
}

function createStreams(): {
  readonly stdout: PassThrough
  readonly stdin: PassThrough & {
    isTTY: boolean
    ref: () => void
    setRawMode: (mode: boolean) => void
    unref: () => void
  }
} {
  const stdout = new PassThrough()
  stdout.resume()
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

  return { stdin, stdout }
}

function sleep(ms = 25): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function Harness({
  mcpClients,
  onSelect,
}: {
  readonly mcpClients: unknown[]
  readonly onSelect: (selection: IDESelection) => void
}): null {
  useIdeSelection(mcpClients as never, onSelect)
  return null
}

describe('useIdeSelection wave200 coverage', () => {
  beforeEach(() => {
    fixture.ideClient = undefined
    fixture.logError.mockClear()
  })

  test('publishes IDE selections and clears stale selected text when the IDE reports an empty selection', async () => {
    const ideClient = createIdeClient()
    fixture.ideClient = ideClient
    const onSelect = vi.fn()
    const { stdin, stdout } = createStreams()
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    })

    try {
      root.render(<Harness mcpClients={[{}]} onSelect={onSelect} />)
      await sleep()

      expect(ideClient.client.setNotificationHandler).toHaveBeenCalledTimes(1)
      expect(onSelect).toHaveBeenLastCalledWith({
        lineCount: 0,
        lineStart: undefined,
        text: undefined,
        filePath: undefined,
      })

      ideClient.emit({
        selection: {
          start: { line: 4, character: 3 },
          end: { line: 6, character: 0 },
        },
        text: 'alpha\nbeta',
        filePath: '/workspace/src/app.ts',
      })

      expect(onSelect).toHaveBeenLastCalledWith({
        lineCount: 2,
        lineStart: 4,
        text: 'alpha\nbeta',
        filePath: '/workspace/src/app.ts',
      })

      ideClient.emit({
        selection: null,
        text: '',
        filePath: '/workspace/src/app.ts',
      })

      expect(onSelect).toHaveBeenLastCalledWith({
        lineCount: 0,
        lineStart: undefined,
        text: '',
        filePath: '/workspace/src/app.ts',
      })
    } finally {
      root.unmount()
      stdin.end()
      stdout.end()
      await sleep()
    }
  })
})
