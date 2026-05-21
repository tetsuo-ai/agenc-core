import { PassThrough } from 'node:stream'

import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  ideClient: undefined as TestIdeClient | undefined,
  getConnectedIdeClient: vi.fn(),
  logError: vi.fn(),
}))

vi.mock('../../../src/utils/ide.js', () => ({
  getConnectedIdeClient: fixture.getConnectedIdeClient,
}))

vi.mock('../../../src/utils/log.js', () => ({
  logError: fixture.logError,
}))

import { createRoot } from '../../../src/tui/ink.js'
import {
  type IDEAtMentioned,
  useIdeAtMentioned,
} from '../../../src/tui/hooks/useIdeAtMentioned.js'

type AtMentionedNotificationParams = {
  readonly filePath: string
  readonly lineStart?: number
  readonly lineEnd?: number
}

type NotificationHandler = (notification: {
  readonly params: AtMentionedNotificationParams
}) => void

type TestIdeClient = {
  readonly client: {
    readonly setNotificationHandler: ReturnType<typeof vi.fn>
  }
  readonly emit: (params: AtMentionedNotificationParams) => void
}

type HookProps = {
  readonly mcpClients: unknown[]
  readonly onAtMentioned: (atMentioned: IDEAtMentioned) => void
}

type TestStreams = {
  readonly stdin: PassThrough & {
    isTTY: boolean
    ref: () => void
    setRawMode: (mode: boolean) => void
    unref: () => void
  }
  readonly stdout: PassThrough & {
    columns: number
    rows: number
    isTTY: boolean
  }
}

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
    emit: (params: AtMentionedNotificationParams) => {
      if (handler === undefined) {
        throw new Error('at-mentioned handler was not registered')
      }
      handler({ params })
    },
  }
}

function createStreams(): TestStreams {
  const stdin = new PassThrough() as TestStreams['stdin']
  const stdout = new PassThrough() as TestStreams['stdout']

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

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
}

async function renderHookHarness(
  initialProps: HookProps,
): Promise<{
  readonly dispose: () => Promise<void>
  readonly render: (next: Partial<HookProps>) => Promise<void>
}> {
  let props = initialProps
  const { stdin, stdout } = createStreams()
  const root = await createRoot({
    patchConsole: false,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  })

  function Harness(): null {
    useIdeAtMentioned(props.mcpClients as never, props.onAtMentioned)
    return null
  }

  async function render(next: Partial<HookProps> = {}): Promise<void> {
    props = { ...props, ...next }
    await act(async () => {
      root.render(React.createElement(Harness))
    })
    await flushEffects()
  }

  await render()

  return {
    dispose: async () => {
      root.unmount()
      stdin.end()
      stdout.end()
      await flushEffects()
    },
    render,
  }
}

describe('useIdeAtMentioned coverage swarm 066', () => {
  beforeEach(() => {
    fixture.ideClient = undefined
    fixture.getConnectedIdeClient.mockReset()
    fixture.getConnectedIdeClient.mockImplementation(() => fixture.ideClient)
    fixture.logError.mockClear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  test('registers only when an IDE client is available and converts line numbers to one-based positions', async () => {
    const onAtMentioned = vi.fn()
    const firstClients = [{ name: 'not-ide' }]
    const rendered = await renderHookHarness({
      mcpClients: firstClients,
      onAtMentioned,
    })

    try {
      expect(fixture.getConnectedIdeClient).toHaveBeenLastCalledWith(
        firstClients,
      )

      const ideClient = createIdeClient()
      fixture.ideClient = ideClient
      const secondClients = [{ name: 'ide' }]
      await rendered.render({ mcpClients: secondClients })

      expect(fixture.getConnectedIdeClient).toHaveBeenLastCalledWith(
        secondClients,
      )
      expect(ideClient.client.setNotificationHandler).toHaveBeenCalledTimes(1)

      ideClient.emit({
        filePath: '/workspace/src/app.ts',
        lineStart: 0,
        lineEnd: 4,
      })

      expect(onAtMentioned).toHaveBeenLastCalledWith({
        filePath: '/workspace/src/app.ts',
        lineStart: 1,
        lineEnd: 5,
      })

      ideClient.emit({
        filePath: '/workspace/src/untitled.ts',
      })

      expect(onAtMentioned).toHaveBeenLastCalledWith({
        filePath: '/workspace/src/untitled.ts',
        lineStart: undefined,
        lineEnd: undefined,
      })
      expect(fixture.logError).not.toHaveBeenCalled()
    } finally {
      await rendered.dispose()
    }
  })

  test('ignores stale handlers after the connected IDE client changes', async () => {
    const firstIdeClient = createIdeClient()
    fixture.ideClient = firstIdeClient
    const onAtMentioned = vi.fn()
    const rendered = await renderHookHarness({
      mcpClients: [{ id: 'first' }],
      onAtMentioned,
    })

    try {
      expect(firstIdeClient.client.setNotificationHandler).toHaveBeenCalledTimes(
        1,
      )

      const secondIdeClient = createIdeClient()
      fixture.ideClient = secondIdeClient
      await rendered.render({ mcpClients: [{ id: 'second' }] })

      firstIdeClient.emit({
        filePath: '/workspace/src/stale.ts',
        lineStart: 2,
      })

      expect(onAtMentioned).not.toHaveBeenCalled()

      secondIdeClient.emit({
        filePath: '/workspace/src/current.ts',
        lineEnd: 8,
      })

      expect(onAtMentioned).toHaveBeenCalledTimes(1)
      expect(onAtMentioned).toHaveBeenLastCalledWith({
        filePath: '/workspace/src/current.ts',
        lineStart: undefined,
        lineEnd: 9,
      })
    } finally {
      await rendered.dispose()
    }
  })

  test('logs notification handler errors instead of surfacing callback failures', async () => {
    const ideClient = createIdeClient()
    fixture.ideClient = ideClient
    const callbackError = new Error('callback failed')
    const rendered = await renderHookHarness({
      mcpClients: [{ name: 'ide' }],
      onAtMentioned: () => {
        throw callbackError
      },
    })

    try {
      expect(() => {
        ideClient.emit({
          filePath: '/workspace/src/failing.ts',
          lineStart: 6,
          lineEnd: 6,
        })
      }).not.toThrow()

      expect(fixture.logError).toHaveBeenCalledWith(callbackError)
    } finally {
      await rendered.dispose()
    }
  })
})
