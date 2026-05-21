import { PassThrough } from 'node:stream'

import React, { useState } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

type PastedContentLike = {
  content: string
  id: number
  type: 'text'
}

type HistoryEntryLike = {
  display: string
  pastedContents?: Record<number, PastedContentLike>
}

const harness = vi.hoisted(() => ({
  addNotification: vi.fn(),
  entries: [] as HistoryEntryLike[],
  historyReadCount: 0,
  removeNotification: vi.fn(),
  reset() {
    this.addNotification.mockClear()
    this.entries = []
    this.historyReadCount = 0
    this.removeNotification.mockClear()
  },
}))

vi.mock('../../../src/tui/context/notifications.js', () => ({
  useNotifications: () => ({
    addNotification: harness.addNotification,
    removeNotification: harness.removeNotification,
  }),
}))

vi.mock('../../../src/tui/history/history.js', () => ({
  getHistory: async function* () {
    harness.historyReadCount += 1
    for (const entry of harness.entries) {
      yield entry
    }
  },
}))

import { createRoot } from '../../../src/tui/ink/root.js'
import {
  type HistoryMode,
  useArrowKeyHistory,
} from '../../../src/tui/hooks/useArrowKeyHistory.js'

type HookResult = ReturnType<typeof useArrowKeyHistory>

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

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown
  for (let i = 0; i < 30; i++) {
    try {
      assertion()
      return
    } catch (error) {
      lastError = error
      await sleep()
    }
  }
  throw lastError
}

async function renderHookHarness(
  initial: {
    currentInput?: string
    currentMode?: HistoryMode
    includeCursorSetter?: boolean
  } = {},
): Promise<{
  readonly currentInput: () => string
  readonly currentMode: () => HistoryMode | undefined
  readonly dispose: () => Promise<void>
  readonly latest: () => HookResult
  readonly onSetInput: ReturnType<typeof vi.fn>
  readonly setCursorOffset: ReturnType<typeof vi.fn>
}> {
  let latest: HookResult | undefined
  let latestInput = initial.currentInput ?? ''
  let latestMode = initial.currentMode
  let latestPastedContents: Record<number, PastedContentLike> = {}
  const onSetInput = vi.fn()
  const setCursorOffset = vi.fn()
  const { stdin, stdout } = createStreams()
  const root = await createRoot({
    patchConsole: false,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  })

  function Harness(): null {
    const [input, setInput] = useState(latestInput)
    const [mode, setMode] = useState<HistoryMode | undefined>(latestMode)
    const [pastedContents, setPastedContents] = useState(latestPastedContents)

    latestInput = input
    latestMode = mode
    latestPastedContents = pastedContents
    latest = useArrowKeyHistory(
      (value, nextMode, nextPastedContents) => {
        onSetInput(value, nextMode, nextPastedContents)
        setInput(value)
        setMode(nextMode)
        setPastedContents(nextPastedContents)
      },
      input,
      pastedContents,
      initial.includeCursorSetter === false ? undefined : setCursorOffset,
      mode,
    )

    return null
  }

  root.render(<Harness />)
  await sleep()

  return {
    currentInput: () => latestInput,
    currentMode: () => latestMode,
    dispose: async () => {
      root.unmount()
      stdin.end()
      stdout.end()
      await sleep()
    },
    latest: () => {
      if (latest === undefined) throw new Error('hook did not render')
      return latest
    },
    onSetInput,
    setCursorOffset,
  }
}

describe('useArrowKeyHistory coverage swarm 124', () => {
  beforeEach(() => {
    harness.reset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  test('batches rapid upward traversal and expands the pending history load by chunks', async () => {
    harness.entries = Array.from({ length: 12 }, (_, index) => ({
      display: `history entry ${index}`,
      pastedContents: {},
    }))
    const rendered = await renderHookHarness({ currentInput: 'draft' })

    try {
      for (let i = 0; i < 11; i++) {
        rendered.latest().onHistoryUp()
      }

      await waitFor(() =>
        expect(rendered.currentInput()).toBe('history entry 10'),
      )

      expect(rendered.latest().historyIndex).toBe(11)
      expect(harness.historyReadCount).toBe(2)
      expect(harness.addNotification).toHaveBeenCalledTimes(1)
      expect(rendered.setCursorOffset).toHaveBeenLastCalledWith(0)

      expect(rendered.latest().onHistoryDown()).toBe(false)
      await waitFor(() =>
        expect(rendered.currentInput()).toBe('history entry 9'),
      )
      expect(rendered.latest().historyIndex).toBe(10)
      expect(rendered.setCursorOffset).toHaveBeenLastCalledWith(
        'history entry 9'.length,
      )
    } finally {
      await rendered.dispose()
    }
  })

  test('clears an empty bash draft back to bash mode and exposes explicit hint dismissal', async () => {
    harness.entries = [
      { display: 'plain prompt command', pastedContents: {} },
      { display: '!npm run dev', pastedContents: {} },
    ]
    const rendered = await renderHookHarness({
      currentInput: '   ',
      currentMode: 'bash',
    })

    try {
      rendered.latest().onHistoryUp()
      await waitFor(() => expect(rendered.currentInput()).toBe('npm run dev'))
      expect(rendered.currentMode()).toBe('bash')

      expect(rendered.latest().onHistoryDown()).toBe(false)
      await waitFor(() => expect(rendered.currentInput()).toBe(''))
      expect(rendered.currentMode()).toBe('bash')
      expect(rendered.onSetInput).toHaveBeenLastCalledWith('', 'bash', {})

      rendered.latest().dismissSearchHint()
      expect(harness.removeNotification).toHaveBeenCalledWith(
        'search-history-hint',
      )
    } finally {
      await rendered.dispose()
    }
  })

  test('ignores blank history entries and derives the draft mode when no current mode was supplied', async () => {
    harness.entries = [{ display: '', pastedContents: {} }]
    const rendered = await renderHookHarness({
      currentInput: '!draft command',
      includeCursorSetter: false,
    })

    try {
      rendered.latest().onHistoryUp()
      await waitFor(() => expect(rendered.latest().historyIndex).toBe(1))
      expect(rendered.currentInput()).toBe('!draft command')
      expect(rendered.onSetInput).not.toHaveBeenCalled()
      expect(rendered.setCursorOffset).not.toHaveBeenCalled()

      expect(rendered.latest().onHistoryDown()).toBe(false)
      await waitFor(() => expect(rendered.currentInput()).toBe('draft command'))
      expect(rendered.currentMode()).toBe('bash')
      expect(rendered.onSetInput).toHaveBeenLastCalledWith(
        'draft command',
        'bash',
        {},
      )
      expect(rendered.setCursorOffset).not.toHaveBeenCalled()
    } finally {
      await rendered.dispose()
    }
  })
})
