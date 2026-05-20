import { PassThrough } from 'node:stream'

import React from 'react'
import stripAnsi from 'strip-ansi'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import { Text } from '../ink.js'
import { createRoot } from '../ink/root.js'
import { useHistorySearch } from './useHistorySearch.js'

type Entry = {
  display: string
  pastedContents: Record<number, unknown>
}

const historyFixture = vi.hoisted(() => ({
  entries: [] as Entry[],
  featureFlags: new Set<string>(),
  inputSubscriptions: [] as Array<{
    handler: (input: string, key: unknown, event: { keypress: string }) => void
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
  readerReturns: 0,
}))

vi.mock('bun:bundle', () => ({
  feature: (name: string) => historyFixture.featureFlags.has(name),
}))

vi.mock('../history/history.js', () => ({
  makeHistoryReader: () => {
    let index = 0
    const reader = {
      async next() {
        const value = historyFixture.entries[index++]
        if (!value) return { done: true, value: undefined }
        return { done: false, value }
      },
      async return(value: undefined) {
        historyFixture.readerReturns++
        return { done: true, value }
      },
      [Symbol.asyncIterator]() {
        return this
      },
    }
    return reader
  },
}))

vi.mock('../keybindings/useKeybinding.js', () => ({
  useKeybinding: (
    action: string,
    handler: () => void,
    options: { context: string; isActive?: boolean },
  ) => {
    historyFixture.keybindingCalls.push({ action, handler, options })
  },
  useKeybindings: (
    handlers: Record<string, () => void>,
    options: { context: string; isActive?: boolean },
  ) => {
    historyFixture.keybindingsCalls.push({ handlers, options })
  },
}))

vi.mock('../ink.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../ink.js')>()
  return {
    ...actual,
    useInput: (
      handler: (input: string, key: unknown, event: { keypress: string }) => void,
      options: { isActive?: boolean },
    ) => {
      historyFixture.inputSubscriptions.push({ handler, options })
    },
  }
})

type CapturedHistory = ReturnType<typeof useHistorySearch> & {
  accepted: Entry[]
  cursor: number
  input: string
  isSearching: boolean
  mode: string
  pastedContents: Record<number, unknown>
}

function HistoryHarness({
  capture,
  initialCursor = 4,
  initialInput = 'seed',
  initialMode = 'prompt',
  initialPastedContents = {},
}: {
  capture: { current: CapturedHistory | null }
  initialCursor?: number
  initialInput?: string
  initialMode?: 'prompt' | 'bash'
  initialPastedContents?: Record<number, unknown>
}): React.ReactNode {
  const [accepted, setAccepted] = React.useState<Entry[]>([])
  const [input, setInput] = React.useState(initialInput)
  const [cursor, setCursor] = React.useState(initialCursor)
  const [mode, setMode] = React.useState(initialMode)
  const [isSearching, setIsSearching] = React.useState(false)
  const [pastedContents, setPastedContents] = React.useState(initialPastedContents)
  const history = useHistorySearch(
    entry => setAccepted(items => [...items, entry as Entry]),
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
  return <Text>{`${mode}:${input}:${cursor}:${String(isSearching)}`}</Text>
}

function createStreams(): {
  stdin: PassThrough & {
    isTTY: boolean
    ref: () => void
    setRawMode: (mode: boolean) => void
    unref: () => void
  }
  stdout: PassThrough
} {
  const stdout = new PassThrough()
  const stdin = new PassThrough() as ReturnType<typeof createStreams>['stdin']
  stdin.isTTY = true
  stdin.setRawMode = () => {}
  stdin.ref = () => {}
  stdin.unref = () => {}
  ;(stdout as unknown as { columns: number }).columns = 120
  return { stdin, stdout }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < 1_000) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('Timed out waiting for history search state')
}

function latestStartSearchHandler(): (() => void) | undefined {
  return historyFixture.keybindingCalls
    .filter(call => call.action === 'history:search')
    .at(-1)?.handler
}

function latestHistoryHandlers(): Record<string, () => void> {
  return historyFixture.keybindingsCalls.at(-1)?.handlers ?? {}
}

async function renderHarness(
  node: React.ReactNode,
  run: (output: () => string) => Promise<void>,
): Promise<string> {
  let output = ''
  const { stdin, stdout } = createStreams()
  stdout.on('data', chunk => {
    output += chunk.toString()
  })
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  })

  try {
    root.render(node)
    await waitFor(() => output.length > 0)
    await run(() => stripAnsi(output))
    await new Promise(resolve => setTimeout(resolve, 20))
    return stripAnsi(output)
  } finally {
    root.unmount()
    stdin.end()
  }
}

beforeEach(() => {
  historyFixture.entries = []
  historyFixture.featureFlags.clear()
  historyFixture.inputSubscriptions = []
  historyFixture.keybindingCalls = []
  historyFixture.keybindingsCalls = []
  historyFixture.readerReturns = 0
})

describe('useHistorySearch', () => {
  test('starts search, finds matches, resumes to the next unique match, and accepts stripped history values', async () => {
    historyFixture.entries = [
      { display: 'first npm test', pastedContents: { 1: { content: 'a' } } },
      { display: 'first npm test', pastedContents: { 1: { content: 'duplicate' } } },
      { display: '!npm test --watch', pastedContents: { 2: { content: 'b' } } },
    ]
    const capture = { current: null as CapturedHistory | null }

    await renderHarness(
      <HistoryHarness capture={capture} />,
      async () => {
        latestStartSearchHandler()?.()
        await waitFor(() => capture.current?.isSearching === true)

        capture.current?.setHistoryQuery('test')
        await waitFor(() => capture.current?.input === 'first npm test')
        expect(capture.current?.cursor).toBe('first npm '.length)
        expect(capture.current?.mode).toBe('prompt')
        expect(capture.current?.pastedContents).toEqual({
          1: { content: 'a' },
        })

        latestHistoryHandlers()['historySearch:next']?.()
        await waitFor(() => capture.current?.input === '!npm test --watch')
        expect(capture.current?.mode).toBe('bash')
        expect(capture.current?.cursor).toBe('npm '.length)

        latestHistoryHandlers()['historySearch:accept']?.()
        await waitFor(() => capture.current?.isSearching === false)
      },
    )

    expect(capture.current?.input).toBe('npm test --watch')
    expect(capture.current?.mode).toBe('bash')
    expect(capture.current?.pastedContents).toEqual({
      2: { content: 'b' },
    })
    expect(historyFixture.readerReturns).toBeGreaterThan(0)
  })

  test('marks failed searches and restores original pasted contents on accept without a match', async () => {
    historyFixture.entries = [
      { display: 'not this one', pastedContents: {} },
    ]
    const originalPastes = { 9: { content: 'original' } }
    const capture = { current: null as CapturedHistory | null }

    await renderHarness(
      <HistoryHarness
        capture={capture}
        initialInput="original prompt"
        initialPastedContents={originalPastes}
      />,
      async () => {
        latestStartSearchHandler()?.()
        await waitFor(() => capture.current?.isSearching === true)

        capture.current?.setHistoryQuery('missing')
        await waitFor(() => capture.current?.historyFailedMatch === true)
        expect(capture.current?.input).toBe('original prompt')

        latestHistoryHandlers()['historySearch:accept']?.()
        await waitFor(() => capture.current?.isSearching === false)
      },
    )

    expect(capture.current?.pastedContents).toBe(originalPastes)
    expect(capture.current?.input).toBe('original prompt')
  })

  test('executes the original prompt when query is empty and matched history when query is present', async () => {
    const capture = { current: null as CapturedHistory | null }

    await renderHarness(
      <HistoryHarness capture={capture} initialInput="submit original" />,
      async () => {
        latestStartSearchHandler()?.()
        await waitFor(() => capture.current?.isSearching === true)

        latestHistoryHandlers()['historySearch:execute']?.()
        await waitFor(() => capture.current?.accepted.length === 1)
      },
    )

    expect(capture.current?.accepted).toEqual([
      {
        display: 'submit original',
        pastedContents: {},
      },
    ])

    historyFixture.entries = [
      { display: '!npm run check', pastedContents: { 3: { content: 'c' } } },
    ]
    const matchedCapture = { current: null as CapturedHistory | null }
    await renderHarness(
      <HistoryHarness capture={matchedCapture} />,
      async () => {
        latestStartSearchHandler()?.()
        await waitFor(() => matchedCapture.current?.isSearching === true)
        matchedCapture.current?.setHistoryQuery('check')
        await waitFor(() => matchedCapture.current?.historyMatch?.display === '!npm run check')
        latestHistoryHandlers()['historySearch:execute']?.()
        await waitFor(() => matchedCapture.current?.accepted.length === 1)
      },
    )

    expect(matchedCapture.current?.mode).toBe('bash')
    expect(matchedCapture.current?.accepted).toEqual([
      {
        display: 'npm run check',
        pastedContents: { 3: { content: 'c' } },
      },
    ])
  })

  test('cancels with backspace on an empty query and through keybindings', async () => {
    const capture = { current: null as CapturedHistory | null }
    const event = {
      key: 'backspace',
      preventDefault: vi.fn(),
    }

    await renderHarness(
      <HistoryHarness capture={capture} initialCursor={7} initialInput="restore" />,
      async () => {
        latestStartSearchHandler()?.()
        await waitFor(() => capture.current?.isSearching === true)

        capture.current?.handleKeyDown(event as never)
        await waitFor(() => capture.current?.isSearching === false)
        expect(event.preventDefault).toHaveBeenCalledTimes(1)

        latestStartSearchHandler()?.()
        await waitFor(() => capture.current?.isSearching === true)
        latestHistoryHandlers()['historySearch:cancel']?.()
        await waitFor(() => capture.current?.isSearching === false)
      },
    )

    expect(capture.current?.input).toBe('restore')
    expect(capture.current?.cursor).toBe(7)
  })

  test('gates keybindings and legacy useInput bridge by active search state and feature flags', async () => {
    historyFixture.featureFlags.add('HISTORY_PICKER')
    const capture = { current: null as CapturedHistory | null }

    await renderHarness(
      <HistoryHarness capture={capture} />,
      async () => {
        await waitFor(() => historyFixture.keybindingCalls.length > 0)
        expect(
          historyFixture.keybindingCalls.at(-1)?.options,
        ).toMatchObject({
          context: 'Global',
          isActive: false,
        })
        expect(
          historyFixture.keybindingsCalls.at(-1)?.options,
        ).toMatchObject({
          context: 'HistorySearch',
          isActive: false,
        })
        expect(historyFixture.inputSubscriptions.at(-1)?.options).toEqual({
          isActive: false,
        })
      },
    )
  })
})
