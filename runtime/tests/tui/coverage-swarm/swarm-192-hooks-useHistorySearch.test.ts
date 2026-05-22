import { PassThrough } from 'node:stream'

import React, { act, useState } from 'react'
import { beforeEach, describe, expect, test, vi } from 'vitest'

type PastedContentLike = {
  content: string
  type: 'text'
}

type HistoryEntryLike = {
  display: string
  pastedContents?: Record<number, PastedContentLike>
}

type ParsedKeyLike = {
  ctrl: boolean
  fn: boolean
  meta: boolean
  name: string
  option: boolean
  sequence?: string
  shift: boolean
  super: boolean
}

const fixture = vi.hoisted(() => ({
  entries: [] as HistoryEntryLike[],
  featureFlags: new Set<string>(),
  inputSubscriptions: [] as Array<{
    handler: (
      input: string,
      key: unknown,
      event: { keypress: ParsedKeyLike },
    ) => void
    options: { isActive?: boolean }
  }>,
  keybindingCalls: [] as Array<{
    action: string
    handler: () => void
    options: { context: string; isActive?: boolean }
  }>,
  keybindingsCalls: [] as Array<{
    handlers: Record<string, () => void>
    options: { context: string; isActive?: boolean }
  }>,
  readers: [] as Array<{
    next: ReturnType<typeof vi.fn>
    return: ReturnType<typeof vi.fn>
  }>,
}))

vi.mock('bun:bundle', () => ({
  feature: (name: string) => fixture.featureFlags.has(name),
}))

vi.mock('../../../src/tui/history/history.js', () => ({
  makeHistoryReader: () => {
    let index = 0
    const reader = {
      next: vi.fn(async () => {
        const value = fixture.entries[index++]
        if (value === undefined) return { done: true, value: undefined }
        return { done: false, value }
      }),
      return: vi.fn(async (value: undefined) => ({ done: true, value })),
      [Symbol.asyncIterator]() {
        return this
      },
    }
    fixture.readers.push(reader)
    return reader
  },
}))

vi.mock('../../../src/tui/keybindings/useKeybinding.js', () => ({
  useKeybinding: (
    action: string,
    handler: () => void,
    options: { context: string; isActive?: boolean },
  ) => {
    fixture.keybindingCalls.push({ action, handler, options })
  },
  useKeybindings: (
    handlers: Record<string, () => void>,
    options: { context: string; isActive?: boolean },
  ) => {
    fixture.keybindingsCalls.push({ handlers, options })
  },
}))

vi.mock('../../../src/tui/ink.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../src/tui/ink.js')>()

  return {
    ...actual,
    useInput: (
      handler: (
        input: string,
        key: unknown,
        event: { keypress: ParsedKeyLike },
      ) => void,
      options: { isActive?: boolean },
    ) => {
      fixture.inputSubscriptions.push({ handler, options })
    },
  }
})

import { createRoot } from '../../../src/tui/ink/root.js'
import { useHistorySearch } from '../../../src/tui/hooks/useHistorySearch.js'

type HookResult = ReturnType<typeof useHistorySearch>

type CapturedHistory = HookResult & {
  accepted: HistoryEntryLike[]
  cursor: number
  input: string
  isSearching: boolean
  mode: 'prompt' | 'bash'
  pastedContents: Record<number, PastedContentLike>
}

type TestStreams = {
  stdin: PassThrough & {
    isTTY: boolean
    ref: () => void
    setRawMode: (mode: boolean) => void
    unref: () => void
  }
  stdout: PassThrough & {
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

async function sleep(ms = 10): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown

  for (let i = 0; i < 50; i++) {
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

function parsedKey(name: string, sequence = ''): ParsedKeyLike {
  return {
    ctrl: false,
    fn: false,
    meta: false,
    name,
    option: false,
    sequence,
    shift: false,
    super: false,
  }
}

function latestStartSearchHandler(): (() => void) | undefined {
  return fixture.keybindingCalls
    .filter(call => call.action === 'history:search')
    .at(-1)?.handler
}

function latestHistoryHandlers(): Record<string, () => void> {
  return fixture.keybindingsCalls.at(-1)?.handlers ?? {}
}

function latestInputSubscription():
  | (typeof fixture.inputSubscriptions)[number]
  | undefined {
  return fixture.inputSubscriptions.at(-1)
}

async function renderHookHarness(
  initial: {
    currentCursorOffset?: number
    currentInput?: string
    currentMode?: 'prompt' | 'bash'
    currentPastedContents?: Record<number, PastedContentLike>
  } = {},
): Promise<{
  capture: { current: CapturedHistory | null }
  dispose: () => Promise<void>
}> {
  const capture = { current: null as CapturedHistory | null }
  const { stdin, stdout } = createStreams()
  const root = await createRoot({
    patchConsole: false,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  })

  function Harness(): null {
    const [accepted, setAccepted] = useState<HistoryEntryLike[]>([])
    const [input, setInput] = useState(initial.currentInput ?? 'draft prompt')
    const [cursor, setCursor] = useState(initial.currentCursorOffset ?? 5)
    const [mode, setMode] = useState<'prompt' | 'bash'>(
      initial.currentMode ?? 'prompt',
    )
    const [isSearching, setIsSearching] = useState(false)
    const [pastedContents, setPastedContents] = useState<
      Record<number, PastedContentLike>
    >(initial.currentPastedContents ?? {})
    const history = useHistorySearch(
      entry => setAccepted(items => [...items, entry as HistoryEntryLike]),
      input,
      setInput,
      setCursor,
      cursor,
      setMode,
      mode,
      isSearching,
      setIsSearching,
      setPastedContents,
      pastedContents,
    )

    capture.current = {
      ...history,
      accepted,
      cursor,
      input,
      isSearching,
      mode,
      pastedContents,
    }
    return null
  }

  await act(async () => {
    root.render(React.createElement(Harness))
    await Promise.resolve()
  })

  return {
    capture,
    dispose: async () => {
      await act(async () => {
        root.unmount()
        await Promise.resolve()
      })
      stdin.end()
      stdout.end()
      await sleep()
    },
  }
}

async function startSearch(capture: { current: CapturedHistory | null }) {
  await act(async () => {
    latestStartSearchHandler()?.()
    await Promise.resolve()
  })
  await waitFor(() => expect(capture.current?.isSearching).toBe(true))
}

beforeEach(() => {
  fixture.entries = []
  fixture.featureFlags.clear()
  fixture.inputSubscriptions = []
  fixture.keybindingCalls = []
  fixture.keybindingsCalls = []
  fixture.readers = []
})

describe('useHistorySearch coverage swarm 192', () => {
  test('uses the display match offset when the stripped command lacks the query', async () => {
    fixture.entries = [
      {
        display: '!npm run build',
        pastedContents: { 1: { content: 'build log', type: 'text' } },
      },
    ]
    const rendered = await renderHookHarness()

    try {
      await startSearch(rendered.capture)

      await act(async () => {
        rendered.capture.current?.setHistoryQuery('!')
        await Promise.resolve()
      })

      await waitFor(() =>
        expect(rendered.capture.current?.input).toBe('!npm run build'),
      )
      expect(rendered.capture.current?.cursor).toBe(0)
      expect(rendered.capture.current?.mode).toBe('bash')
      expect(rendered.capture.current?.pastedContents).toEqual({
        1: { content: 'build log', type: 'text' },
      })
      expect(rendered.capture.current?.historyFailedMatch).toBe(false)
    } finally {
      await rendered.dispose()
    }
  })

  test('executes a non-empty query without accepting when no history match exists', async () => {
    fixture.entries = [{ display: 'unrelated entry', pastedContents: {} }]
    const rendered = await renderHookHarness({
      currentInput: 'original input',
      currentPastedContents: { 2: { content: 'original', type: 'text' } },
    })

    try {
      await startSearch(rendered.capture)

      await act(async () => {
        rendered.capture.current?.setHistoryQuery('missing')
        await Promise.resolve()
      })

      await waitFor(() =>
        expect(rendered.capture.current?.historyFailedMatch).toBe(true),
      )

      await act(async () => {
        latestHistoryHandlers()['historySearch:execute']?.()
        await Promise.resolve()
      })

      await waitFor(() =>
        expect(rendered.capture.current?.isSearching).toBe(false),
      )
      expect(rendered.capture.current?.accepted).toEqual([])
      expect(rendered.capture.current?.input).toBe('original input')
      expect(rendered.capture.current?.historyQuery).toBe('')
      expect(rendered.capture.current?.pastedContents).toEqual({
        2: { content: 'original', type: 'text' },
      })
    } finally {
      await rendered.dispose()
    }
  })

  test('ignores non-cancel keydowns and cancels through the active input bridge', async () => {
    const rendered = await renderHookHarness({
      currentCursorOffset: 3,
      currentInput: 'keep',
    })

    try {
      await startSearch(rendered.capture)

      await act(async () => {
        rendered.capture.current?.setHistoryQuery('no-match')
        await Promise.resolve()
      })
      await waitFor(() =>
        expect(rendered.capture.current?.historyFailedMatch).toBe(true),
      )

      const backspaceWithQuery = {
        key: 'backspace',
        preventDefault: vi.fn(),
      }
      rendered.capture.current?.handleKeyDown(backspaceWithQuery as never)
      expect(backspaceWithQuery.preventDefault).not.toHaveBeenCalled()
      expect(rendered.capture.current?.isSearching).toBe(true)

      const returnKey = { key: 'return', preventDefault: vi.fn() }
      rendered.capture.current?.handleKeyDown(returnKey as never)
      expect(returnKey.preventDefault).not.toHaveBeenCalled()
      expect(rendered.capture.current?.isSearching).toBe(true)

      await act(async () => {
        rendered.capture.current?.setHistoryQuery('')
        await Promise.resolve()
      })
      await waitFor(() =>
        expect(rendered.capture.current?.historyQuery).toBe(''),
      )

      const activeInput = latestInputSubscription()
      expect(activeInput?.options).toMatchObject({ isActive: true })

      await act(async () => {
        activeInput?.handler('', {}, { keypress: parsedKey('backspace', '\x7f') })
        await Promise.resolve()
      })

      await waitFor(() =>
        expect(rendered.capture.current?.isSearching).toBe(false),
      )
      expect(rendered.capture.current?.input).toBe('keep')
      expect(rendered.capture.current?.cursor).toBe(3)
    } finally {
      await rendered.dispose()
    }
  })

  test('treats a stale next-match handler as a no-op after cancel closes the reader', async () => {
    fixture.entries = [
      { display: 'first match', pastedContents: {} },
      { display: 'second match', pastedContents: {} },
    ]
    const rendered = await renderHookHarness({ currentInput: 'restore me' })

    try {
      await startSearch(rendered.capture)

      await act(async () => {
        rendered.capture.current?.setHistoryQuery('match')
        await Promise.resolve()
      })
      await waitFor(() =>
        expect(rendered.capture.current?.input).toBe('first match'),
      )

      const staleNextMatch = latestHistoryHandlers()['historySearch:next']
      const activeReader = fixture.readers.at(-1)
      const nextCallsBeforeCancel = activeReader?.next.mock.calls.length

      await act(async () => {
        latestHistoryHandlers()['historySearch:cancel']?.()
        await Promise.resolve()
      })
      await waitFor(() =>
        expect(rendered.capture.current?.isSearching).toBe(false),
      )

      await act(async () => {
        staleNextMatch?.()
        await Promise.resolve()
      })

      await sleep()
      expect(rendered.capture.current?.input).toBe('restore me')
      expect(activeReader?.return).toHaveBeenCalledTimes(1)
      expect(activeReader?.next).toHaveBeenCalledTimes(
        nextCallsBeforeCancel ?? 0,
      )
    } finally {
      await rendered.dispose()
    }
  })
})
