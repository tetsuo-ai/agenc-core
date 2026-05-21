import { PassThrough } from 'node:stream'

import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const terminalSizeFixture = vi.hoisted(() => {
  const state = { columns: 7 }

  return {
    state,
    useTerminalSize: vi.fn(() => ({ columns: state.columns, rows: 24 })),
  }
})

vi.mock('../../../src/tui/hooks/useTerminalSize.js', () => ({
  useTerminalSize: terminalSizeFixture.useTerminalSize,
}))

vi.mock('../../../src/utils/debug.js', () => ({
  logForDebugging: () => {},
}))

vi.mock('../../../src/bootstrap/state.js', () => ({
  flushInteractionTime: () => {},
  getActiveTimeCounter: () => 0,
  markScrollActivity: () => {},
  updateLastInteractionTime: () => {},
}))

vi.mock('../../../src/utils/earlyInput.js', () => ({
  stopCapturingEarlyInput: () => {},
}))

vi.mock('../../../src/utils/envUtils.js', () => ({
  isEnvTruthy: () => false,
}))

vi.mock('../../../src/utils/fullscreen.js', () => ({
  isMouseClicksDisabled: () => true,
}))

vi.mock('../../../src/utils/log.js', () => ({
  logError: () => {},
}))

import { createRoot } from '../../../src/tui/ink/root.js'
import { clearKillRing } from '../../../src/utils/TextCursor.js'
import { useSearchInput } from '../../../src/tui/hooks/useSearchInput.js'

type SearchInputState = ReturnType<typeof useSearchInput>
type SearchInputKey = Parameters<SearchInputState['handleKeyDown']>[0]

type HookProps = {
  readonly backspaceExitsOnEmpty?: boolean
  readonly columns?: number
  readonly initialQuery?: string
  readonly isActive?: boolean
  readonly onCancel?: () => void
  readonly onExit: () => void
  readonly onExitUp?: () => void
  readonly passthroughCtrlKeys?: string[]
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
    isTTY: boolean
    rows: number
  }
}

function createStreams(): TestStreams {
  const stdin = new PassThrough() as TestStreams['stdin']
  const stdout = new PassThrough() as TestStreams['stdout']

  stdin.isTTY = true
  stdin.ref = () => {}
  stdin.setRawMode = () => {}
  stdin.unref = () => {}

  stdout.columns = 120
  stdout.rows = 30
  stdout.isTTY = true
  stdout.resume()

  return { stdin, stdout }
}

function key(
  keyName: string,
  modifiers: Partial<Pick<SearchInputKey, 'ctrl' | 'fn' | 'meta'>> = {},
): SearchInputKey & { preventDefault: ReturnType<typeof vi.fn> } {
  return {
    ctrl: modifiers.ctrl ?? false,
    fn: modifiers.fn ?? false,
    key: keyName,
    meta: modifiers.meta ?? false,
    preventDefault: vi.fn(),
  } as SearchInputKey & { preventDefault: ReturnType<typeof vi.fn> }
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0))
  })
}

async function renderSearchInput(
  initialProps: HookProps,
): Promise<{
  readonly dispose: () => Promise<void>
  readonly latest: () => SearchInputState
  readonly press: (
    event: SearchInputKey & { preventDefault: ReturnType<typeof vi.fn> },
  ) => Promise<void>
  readonly render: (next?: Partial<HookProps>) => Promise<void>
}> {
  let latest: SearchInputState | undefined
  let props: HookProps = initialProps
  const { stdin, stdout } = createStreams()
  const root = await createRoot({
    patchConsole: false,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  })

  function Harness(): null {
    latest = useSearchInput({
      backspaceExitsOnEmpty: props.backspaceExitsOnEmpty,
      columns: props.columns,
      initialQuery: props.initialQuery,
      isActive: props.isActive ?? true,
      onCancel: props.onCancel,
      onExit: props.onExit,
      onExitUp: props.onExitUp,
      passthroughCtrlKeys: props.passthroughCtrlKeys,
    })
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
    latest: () => {
      if (latest === undefined) throw new Error('hook did not render')
      return latest
    },
    press: async event => {
      await act(async () => {
        latest?.handleKeyDown(event)
      })
      await flushEffects()
    },
    render,
  }
}

describe('useSearchInput coverage swarm row 153', () => {
  beforeEach(() => {
    clearKillRing()
    terminalSizeFixture.state.columns = 7
    terminalSizeFixture.useTerminalSize.mockClear()
  })

  afterEach(() => {
    clearKillRing()
    vi.restoreAllMocks()
  })

  test('uses terminal columns by default and handles exit keys without optional callbacks', async () => {
    const onExit = vi.fn()
    const rendered = await renderSearchInput({
      initialQuery: 'query',
      onExit,
    })

    try {
      expect(rendered.latest()).toMatchObject({
        cursorOffset: 'query'.length,
        query: 'query',
      })
      expect(terminalSizeFixture.useTerminalSize).toHaveBeenCalled()

      const up = key('up')
      await rendered.press(up)
      expect(up.preventDefault).toHaveBeenCalledTimes(1)
      expect(onExit).not.toHaveBeenCalled()

      const down = key('down')
      await rendered.press(down)
      expect(down.preventDefault).toHaveBeenCalledTimes(1)
      expect(onExit).toHaveBeenCalledTimes(1)
    } finally {
      await rendered.dispose()
    }
  })

  test('routes empty-query destructive shortcuts through configured fallback exits', async () => {
    const onCancel = vi.fn()
    const onExit = vi.fn()
    const rendered = await renderSearchInput({ onExit })

    try {
      await rendered.press(key('backspace'))
      expect(onExit).toHaveBeenCalledTimes(1)

      await rendered.press(key('d', { ctrl: true }))
      expect(onExit).toHaveBeenCalledTimes(2)

      await rendered.render({ onCancel })
      await rendered.press(key('h', { ctrl: true }))
      expect(onCancel).toHaveBeenCalledTimes(1)

      await rendered.render({ backspaceExitsOnEmpty: false })
      await rendered.press(key('h', { ctrl: true }))
      expect(onCancel).toHaveBeenCalledTimes(1)
      expect(onExit).toHaveBeenCalledTimes(2)
    } finally {
      await rendered.dispose()
    }
  })

  test('leaves passthrough and no-op yank inputs untouched', async () => {
    const onExit = vi.fn()
    const rendered = await renderSearchInput({
      initialQuery: 'seed',
      onExit,
      passthroughCtrlKeys: ['n'],
    })

    try {
      const passthrough = key('N', { ctrl: true })
      await rendered.press(passthrough)
      expect(passthrough.preventDefault).not.toHaveBeenCalled()
      expect(rendered.latest()).toMatchObject({
        cursorOffset: 'seed'.length,
        query: 'seed',
      })

      const emptyYank = key('y', { ctrl: true })
      await rendered.press(emptyYank)
      expect(emptyYank.preventDefault).toHaveBeenCalledTimes(1)
      expect(rendered.latest()).toMatchObject({
        cursorOffset: 'seed'.length,
        query: 'seed',
      })

      const emptyYankPop = key('y', { meta: true })
      await rendered.press(emptyYankPop)
      expect(emptyYankPop.preventDefault).toHaveBeenCalledTimes(1)
      expect(rendered.latest()).toMatchObject({
        cursorOffset: 'seed'.length,
        query: 'seed',
      })

      const cancelWithoutHandler = key('c', { ctrl: true })
      await rendered.press(cancelWithoutHandler)
      expect(cancelWithoutHandler.preventDefault).toHaveBeenCalledTimes(1)
      expect(onExit).not.toHaveBeenCalled()

      const emptyInput = key('')
      await rendered.press(emptyInput)
      expect(emptyInput.preventDefault).not.toHaveBeenCalled()
      expect(rendered.latest()).toMatchObject({
        cursorOffset: 'seed'.length,
        query: 'seed',
      })
    } finally {
      await rendered.dispose()
    }
  })
})
