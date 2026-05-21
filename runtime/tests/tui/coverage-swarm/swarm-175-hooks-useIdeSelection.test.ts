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
  type IDESelection,
  useIdeSelection,
} from '../../../src/tui/hooks/useIdeSelection.js'

type SelectionPoint = {
  readonly line: number
  readonly character: number
}

type SelectionNotificationParams = {
  readonly selection?: {
    readonly start?: SelectionPoint
    readonly end?: SelectionPoint
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

type HookProps = {
  readonly mcpClients: unknown[]
  readonly onSelect: (selection: IDESelection) => void
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
    emit: (params: SelectionNotificationParams) => {
      if (handler === undefined) {
        throw new Error('selection handler was not registered')
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
  readonly render: (next?: Partial<HookProps>) => Promise<void>
}> {
  let props = initialProps
  const { stdin, stdout } = createStreams()
  const root = await createRoot({
    patchConsole: false,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  })

  function Harness(): null {
    useIdeSelection(props.mcpClients as never, props.onSelect)
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

describe('useIdeSelection coverage swarm 175', () => {
  beforeEach(() => {
    fixture.ideClient = undefined
    fixture.getConnectedIdeClient.mockReset()
    fixture.getConnectedIdeClient.mockImplementation(() => fixture.ideClient)
    fixture.logError.mockClear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  test('waits for an IDE client and registers once for the same connected IDE', async () => {
    const onSelect = vi.fn()
    const initialClients = [{ name: 'not-ide' }]
    const rendered = await renderHookHarness({
      mcpClients: initialClients,
      onSelect,
    })

    try {
      expect(fixture.getConnectedIdeClient).toHaveBeenLastCalledWith(
        initialClients,
      )
      expect(onSelect).not.toHaveBeenCalled()

      const ideClient = createIdeClient()
      fixture.ideClient = ideClient
      const connectedClients = [{ name: 'ide' }]
      await rendered.render({ mcpClients: connectedClients })

      expect(fixture.getConnectedIdeClient).toHaveBeenLastCalledWith(
        connectedClients,
      )
      expect(onSelect).toHaveBeenCalledTimes(1)
      expect(onSelect).toHaveBeenLastCalledWith({
        lineCount: 0,
        lineStart: undefined,
        text: undefined,
        filePath: undefined,
      })
      expect(ideClient.client.setNotificationHandler).toHaveBeenCalledTimes(1)

      await rendered.render({ mcpClients: [{ name: 'same-ide' }] })

      expect(onSelect).toHaveBeenCalledTimes(1)
      expect(ideClient.client.setNotificationHandler).toHaveBeenCalledTimes(1)

      ideClient.emit({
        selection: {
          start: { line: 2, character: 4 },
          end: { line: 4, character: 9 },
        },
        text: 'selected text',
        filePath: '/workspace/src/current.ts',
      })

      expect(onSelect).toHaveBeenLastCalledWith({
        lineCount: 3,
        lineStart: 2,
        text: 'selected text',
        filePath: '/workspace/src/current.ts',
      })
      expect(fixture.logError).not.toHaveBeenCalled()
    } finally {
      await rendered.dispose()
    }
  })

  test('ignores stale handlers after the connected IDE client changes', async () => {
    const firstIdeClient = createIdeClient()
    fixture.ideClient = firstIdeClient
    const onSelect = vi.fn()
    const rendered = await renderHookHarness({
      mcpClients: [{ id: 'first' }],
      onSelect,
    })

    try {
      expect(firstIdeClient.client.setNotificationHandler).toHaveBeenCalledTimes(
        1,
      )
      expect(onSelect).toHaveBeenCalledTimes(1)

      const secondIdeClient = createIdeClient()
      fixture.ideClient = secondIdeClient
      await rendered.render({ mcpClients: [{ id: 'second' }] })

      expect(onSelect).toHaveBeenCalledTimes(2)
      expect(onSelect).toHaveBeenLastCalledWith({
        lineCount: 0,
        lineStart: undefined,
        text: undefined,
        filePath: undefined,
      })
      expect(secondIdeClient.client.setNotificationHandler).toHaveBeenCalledTimes(
        1,
      )

      firstIdeClient.emit({
        selection: {
          start: { line: 8, character: 1 },
          end: { line: 8, character: 2 },
        },
        text: 'stale',
        filePath: '/workspace/src/stale.ts',
      })

      expect(onSelect).toHaveBeenCalledTimes(2)

      secondIdeClient.emit({
        selection: {
          start: { line: 9, character: 1 },
          end: { line: 10, character: 0 },
        },
        text: 'current',
        filePath: '/workspace/src/current.ts',
      })

      expect(onSelect).toHaveBeenCalledTimes(3)
      expect(onSelect).toHaveBeenLastCalledWith({
        lineCount: 1,
        lineStart: 9,
        text: 'current',
        filePath: '/workspace/src/current.ts',
      })
    } finally {
      await rendered.dispose()
    }
  })

  test('ignores selection payloads that lack both a complete range and text', async () => {
    const ideClient = createIdeClient()
    fixture.ideClient = ideClient
    const onSelect = vi.fn()
    const rendered = await renderHookHarness({
      mcpClients: [{ name: 'ide' }],
      onSelect,
    })

    try {
      onSelect.mockClear()

      ideClient.emit({
        selection: {
          start: { line: 3, character: 0 },
        },
        filePath: '/workspace/src/incomplete.ts',
      })

      expect(onSelect).not.toHaveBeenCalled()
      expect(fixture.logError).not.toHaveBeenCalled()
    } finally {
      await rendered.dispose()
    }
  })

  test('uses the latest callback for the same registered IDE handler', async () => {
    const ideClient = createIdeClient()
    fixture.ideClient = ideClient
    const firstOnSelect = vi.fn()
    const secondOnSelect = vi.fn()
    const rendered = await renderHookHarness({
      mcpClients: [{ name: 'ide' }],
      onSelect: firstOnSelect,
    })

    try {
      firstOnSelect.mockClear()
      await rendered.render({ onSelect: secondOnSelect })

      ideClient.emit({
        selection: {
          start: { line: 7, character: 1 },
          end: { line: 8, character: 4 },
        },
        text: 'fresh callback',
        filePath: '/workspace/src/fresh.ts',
      })

      expect(firstOnSelect).not.toHaveBeenCalled()
      expect(secondOnSelect).toHaveBeenCalledWith({
        lineCount: 2,
        lineStart: 7,
        text: 'fresh callback',
        filePath: '/workspace/src/fresh.ts',
      })
      expect(ideClient.client.setNotificationHandler).toHaveBeenCalledTimes(1)
    } finally {
      await rendered.dispose()
    }
  })

  test('logs notification handler errors instead of surfacing callback failures', async () => {
    const ideClient = createIdeClient()
    fixture.ideClient = ideClient
    const callbackError = new Error('callback failed')
    let shouldThrow = false
    const onSelect = vi.fn(() => {
      if (shouldThrow) {
        throw callbackError
      }
    })
    const rendered = await renderHookHarness({
      mcpClients: [{ name: 'ide' }],
      onSelect,
    })

    try {
      fixture.logError.mockClear()
      shouldThrow = true

      expect(() => {
        ideClient.emit({
          selection: {
            start: { line: 5, character: 1 },
            end: { line: 5, character: 3 },
          },
          text: 'broken',
          filePath: '/workspace/src/failing.ts',
        })
      }).not.toThrow()

      expect(fixture.logError).toHaveBeenCalledWith(callbackError)
    } finally {
      await rendered.dispose()
    }
  })
})
