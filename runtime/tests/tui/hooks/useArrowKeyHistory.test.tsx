import { PassThrough } from 'node:stream'

import React, { useState } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

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

type HistoryEntryLike = {
  display: string
  pastedContents?: Record<number, PastedContentLike>
}

type PastedContentLike = {
  content: string
  id: number
  type: 'text'
}

vi.mock('../context/notifications.js', () => ({
  useNotifications: () => ({
    addNotification: harness.addNotification,
    removeNotification: harness.removeNotification,
  }),
}))

vi.mock('../history/history.js', () => ({
  getHistory: async function* () {
    harness.historyReadCount += 1
    for (const entry of harness.entries) {
      yield entry
    }
  },
}))

import { createRoot } from '../ink/root.js'
import {
  type HistoryMode,
  useArrowKeyHistory,
} from './useArrowKeyHistory.js'

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
  for (let i = 0; i < 20; i++) {
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

function pastedText(id: number, content: string): PastedContentLike {
  return { content, id, type: 'text' }
}

async function renderHookHarness(
  initial: {
    currentInput?: string
    currentMode?: HistoryMode
    currentPastedContents?: Record<number, PastedContentLike>
  } = {},
): Promise<{
  readonly currentInput: () => string
  readonly currentMode: () => HistoryMode
  readonly currentPastedContents: () => Record<number, PastedContentLike>
  readonly dispose: () => Promise<void>
  readonly latest: () => HookResult
  readonly onSetInput: ReturnType<typeof vi.fn>
  readonly setCursorOffset: ReturnType<typeof vi.fn>
}> {
  let latest: HookResult | undefined
  let latestInput = initial.currentInput ?? ''
  let latestMode = initial.currentMode ?? 'prompt'
  let latestPastedContents = initial.currentPastedContents ?? {}
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
    const [mode, setMode] = useState<HistoryMode>(latestMode)
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
      setCursorOffset,
      mode,
    )
    return null
  }

  root.render(<Harness />)
  await sleep()

  return {
    currentInput: () => latestInput,
    currentMode: () => latestMode,
    currentPastedContents: () => latestPastedContents,
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

describe('useArrowKeyHistory', () => {
  beforeEach(() => {
    harness.reset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  test('traverses up and down, preserves the edit buffer, and moves cursors appropriately', async () => {
    const recentMultiline = 'recent line one\nrecent line two'
    const draftPastedContents = { 7: pastedText(7, 'draft paste') }
    const recentPastedContents = { 2: pastedText(2, 'recent paste') }
    harness.entries = [
      { display: recentMultiline, pastedContents: recentPastedContents },
      { display: 'older command', pastedContents: {} },
    ]
    const rendered = await renderHookHarness({
      currentInput: 'draft input',
      currentPastedContents: draftPastedContents,
    })

    try {
      rendered.latest().onHistoryUp()
      await waitFor(() => expect(rendered.currentInput()).toBe(recentMultiline))
      expect(rendered.currentMode()).toBe('prompt')
      expect(rendered.currentPastedContents()).toEqual(recentPastedContents)
      expect(rendered.latest().historyIndex).toBe(1)
      expect(rendered.setCursorOffset).toHaveBeenLastCalledWith(0)

      rendered.latest().onHistoryUp()
      await waitFor(() => expect(rendered.currentInput()).toBe('older command'))
      expect(rendered.latest().historyIndex).toBe(2)
      expect(rendered.setCursorOffset).toHaveBeenLastCalledWith(0)
      expect(harness.addNotification).toHaveBeenCalledTimes(1)
      expect(harness.addNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          key: 'search-history-hint',
          priority: 'immediate',
        }),
      )

      expect(rendered.latest().onHistoryDown()).toBe(false)
      await waitFor(() => expect(rendered.currentInput()).toBe(recentMultiline))
      expect(rendered.latest().historyIndex).toBe(1)
      expect(rendered.setCursorOffset).toHaveBeenLastCalledWith(
        recentMultiline.length,
      )

      expect(rendered.latest().onHistoryDown()).toBe(false)
      await waitFor(() => expect(rendered.currentInput()).toBe('draft input'))
      expect(rendered.latest().historyIndex).toBe(0)
      expect(rendered.currentMode()).toBe('prompt')
      expect(rendered.currentPastedContents()).toEqual(draftPastedContents)
      expect(rendered.setCursorOffset).toHaveBeenLastCalledWith(
        'draft input'.length,
      )
    } finally {
      await rendered.dispose()
    }
  })

  test('leaves input unchanged for empty history and reports down as unhandled at the draft', async () => {
    harness.entries = []
    const rendered = await renderHookHarness({
      currentInput: 'draft input',
      currentPastedContents: { 1: pastedText(1, 'draft paste') },
    })

    try {
      rendered.latest().onHistoryUp()
      await sleep(50)

      expect(harness.historyReadCount).toBe(1)
      expect(rendered.latest().historyIndex).toBe(0)
      expect(rendered.currentInput()).toBe('draft input')
      expect(rendered.onSetInput).not.toHaveBeenCalled()
      expect(rendered.setCursorOffset).not.toHaveBeenCalled()

      expect(rendered.latest().onHistoryDown()).toBe(true)
      await sleep()
      expect(rendered.currentInput()).toBe('draft input')
      expect(rendered.onSetInput).not.toHaveBeenCalled()
    } finally {
      await rendered.dispose()
    }
  })

  test('stays on the oldest item when up traversal reaches the history boundary', async () => {
    harness.entries = [{ display: 'only command', pastedContents: {} }]
    const rendered = await renderHookHarness({ currentInput: 'draft input' })

    try {
      rendered.latest().onHistoryUp()
      await waitFor(() => expect(rendered.currentInput()).toBe('only command'))
      expect(rendered.latest().historyIndex).toBe(1)
      expect(rendered.onSetInput).toHaveBeenCalledTimes(1)

      rendered.latest().onHistoryUp()
      await sleep(50)
      expect(rendered.currentInput()).toBe('only command')
      expect(rendered.latest().historyIndex).toBe(1)
      expect(rendered.onSetInput).toHaveBeenCalledTimes(1)
      expect(harness.addNotification).not.toHaveBeenCalled()
    } finally {
      await rendered.dispose()
    }
  })

  test('reset clears navigation state, notifications, and cached history', async () => {
    harness.entries = [{ display: 'before reset', pastedContents: {} }]
    const rendered = await renderHookHarness({ currentInput: 'draft input' })

    try {
      rendered.latest().onHistoryUp()
      await waitFor(() => expect(rendered.currentInput()).toBe('before reset'))
      expect(rendered.latest().historyIndex).toBe(1)
      expect(harness.historyReadCount).toBe(1)

      rendered.latest().resetHistory()
      await waitFor(() => expect(rendered.latest().historyIndex).toBe(0))
      expect(harness.removeNotification).toHaveBeenCalledWith(
        'search-history-hint',
      )

      expect(rendered.latest().onHistoryDown()).toBe(true)
      await sleep()
      expect(rendered.currentInput()).toBe('before reset')

      harness.entries = [{ display: 'after reset', pastedContents: {} }]
      rendered.latest().onHistoryUp()
      await waitFor(() => expect(rendered.currentInput()).toBe('after reset'))
      expect(rendered.latest().historyIndex).toBe(1)
      expect(harness.historyReadCount).toBe(2)
    } finally {
      await rendered.dispose()
    }
  })

  test('filters bash history and restores a bash draft with its mode and pasted contents', async () => {
    const draftPastedContents = { 9: pastedText(9, 'shell draft paste') }
    harness.entries = [
      { display: 'prompt command', pastedContents: {} },
      { display: '!npm test', pastedContents: {} },
      { display: '!git status', pastedContents: {} },
    ]
    const rendered = await renderHookHarness({
      currentInput: 'draft shell',
      currentMode: 'bash',
      currentPastedContents: draftPastedContents,
    })

    try {
      rendered.latest().onHistoryUp()
      await waitFor(() => expect(rendered.currentInput()).toBe('npm test'))
      expect(rendered.currentMode()).toBe('bash')
      expect(rendered.latest().historyIndex).toBe(1)
      expect(rendered.setCursorOffset).toHaveBeenLastCalledWith(0)

      expect(rendered.latest().onHistoryDown()).toBe(false)
      await waitFor(() => expect(rendered.currentInput()).toBe('draft shell'))
      expect(rendered.currentMode()).toBe('bash')
      expect(rendered.currentPastedContents()).toEqual(draftPastedContents)
      expect(rendered.setCursorOffset).toHaveBeenLastCalledWith(
        'draft shell'.length,
      )
    } finally {
      await rendered.dispose()
    }
  })
})
