import { PassThrough } from 'node:stream'

import React from 'react'
import { describe, expect, test, vi } from 'vitest'

type ParsedKeyForTest = {
  ctrl: boolean
  fn: boolean
  meta: boolean
  name: string
  option: boolean
  sequence: string
  shift: boolean
  super: boolean
}

type UseInputCallback = (
  input: string,
  key: unknown,
  event: {
    keypress: ParsedKeyForTest
    stopImmediatePropagation: () => void
  },
) => void

const harness = vi.hoisted(() => ({
  addNotification: vi.fn(),
  appState: {
    agentNameRegistry: new Map<string, string>(),
    mcp: {
      clients: [] as unknown[],
      resources: [] as unknown[],
    },
    promptSuggestion: {
      acceptedAt: 0,
      generationRequestId: null,
      promptId: null,
      shownAt: 0,
      text: null as string | null,
    },
    tasks: {} as Record<string, { status?: string }>,
    teamContext: undefined as unknown,
    viewingAgentTaskId: null as string | null,
  },
  useInputHandler: null as UseInputCallback | null,
}))

vi.mock('usehooks-ts', async () => {
  const ReactModule = await import('react')
  return {
    useDebounceCallback: (callback: (...args: unknown[]) => unknown) => {
      const callbackRef = ReactModule.useRef(callback)
      callbackRef.current = callback
      return ReactModule.useMemo(() => {
        const debounced = (...args: unknown[]) => callbackRef.current(...args)
        debounced.cancel = vi.fn()
        return debounced
      }, [])
    },
  }
})

vi.mock('../context/notifications.js', () => ({
  useNotifications: () => ({ addNotification: harness.addNotification }),
}))

vi.mock('../context/overlayContext', () => ({
  useIsModalOverlayActive: () => false,
  useRegisterOverlay: vi.fn(),
}))

vi.mock('../ink.js', async () => {
  const ReactModule = await import('react')
  return {
    Text: ({ children }: { readonly children?: React.ReactNode }) =>
      ReactModule.createElement(ReactModule.Fragment, null, children),
    useInput: vi.fn((handler: UseInputCallback) => {
      harness.useInputHandler = handler
    }),
  }
})

vi.mock('../keybindings/KeybindingContext.js', () => ({
  useOptionalKeybindingContext: () => ({ pendingChord: null }),
  useRegisterKeybindingContext: vi.fn(),
}))

vi.mock('../keybindings/useKeybinding.js', () => ({
  useKeybindings: vi.fn(),
}))

vi.mock('../keybindings/useShortcutDisplay.js', () => ({
  useShortcutDisplay: () => 'alt+t',
}))

vi.mock('../state/AppState.js', () => ({
  useAppState: (selector: (state: typeof harness.appState) => unknown) =>
    selector(harness.appState),
  useAppStateStore: () => ({ getState: () => harness.appState }),
}))

vi.mock('../../utils/agentSwarmsEnabled', () => ({
  isAgentSwarmsEnabled: () => false,
}))

vi.mock('../../utils/bash/shellCompletion.js', () => ({
  getShellCompletions: vi.fn(async () => []),
}))

vi.mock('../../utils/sessionStorage.js', () => ({
  getSessionIdFromLog: () => 'session-1',
  searchSessionsByCustomTitle: vi.fn(async () => []),
  writeAgentMetadata: vi.fn(async () => undefined),
}))

vi.mock('../../utils/suggestions/directoryCompletion.js', () => ({
  getDirectoryCompletions: vi.fn(async () => []),
  getPathCompletions: vi.fn(async () => []),
  isPathLikeToken: (token: string) =>
    token.startsWith('/') || token.startsWith('./') || token.startsWith('~/'),
}))

vi.mock('../../utils/suggestions/shellHistoryCompletion.js', () => ({
  getShellHistoryCompletion: vi.fn(async () => null),
}))

vi.mock('../../utils/suggestions/slackChannelSuggestions.js', () => ({
  getSlackChannelSuggestions: vi.fn(async () => []),
  hasSlackMcpServer: () => false,
}))

vi.mock('../../utils/swarm/constants.js', () => ({
  TEAM_LEAD_NAME: 'team-lead',
}))

vi.mock('./fileSuggestions', () => ({
  applyFileSuggestion: vi.fn(),
  findLongestCommonPrefix: vi.fn(() => ''),
  onIndexBuildComplete: () => () => {},
  startBackgroundCacheRefresh: vi.fn(),
}))

vi.mock('./unifiedSuggestions', () => ({
  generateUnifiedSuggestions: vi.fn(async () => []),
}))

import { createRoot } from '../ink/root.js'
import type { SuggestionItem } from '../components/PromptInput/PromptInputFooterSuggestions.js'
import { startBackgroundCacheRefresh } from './fileSuggestions'
import { useTypeahead } from './useTypeahead.js'

type SuggestionsState = {
  commandArgumentHint?: string
  selectedSuggestion: number
  suggestions: SuggestionItem[]
}

function createTestStreams(): {
  stdout: PassThrough
  stdin: PassThrough & {
    isTTY: boolean
    ref: () => void
    setRawMode: (mode: boolean) => void
    unref: () => void
  }
} {
  const stdout = new PassThrough()
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
  stdout.resume()
  return { stdin, stdout }
}

function TypeaheadHarness(): React.ReactNode {
  const [suggestionsState, setSuggestionsState] = React.useState<SuggestionsState>({
    commandArgumentHint: undefined,
    selectedSuggestion: -1,
    suggestions: [],
  })

  useTypeahead({
    agents: [],
    commands: [],
    cursorOffset: 0,
    input: '',
    markAccepted: vi.fn(),
    mode: 'prompt',
    onInputChange: vi.fn(),
    onSubmit: vi.fn(),
    setCursorOffset: vi.fn(),
    setSuggestionsState,
    suggestionsState,
  })

  return null
}

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function waitForUseInputHandler(): Promise<UseInputCallback> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < 1000) {
    if (harness.useInputHandler) return harness.useInputHandler
    await sleep(10)
  }
  throw new Error('Timed out waiting for useInput registration')
}

function tabKeypress(): ParsedKeyForTest {
  return {
    ctrl: false,
    fn: false,
    meta: false,
    name: 'tab',
    option: false,
    sequence: '\t',
    shift: false,
    super: false,
  }
}

describe('useTypeahead useInput bridge', () => {
  test('does not start background file prewarm under NODE_ENV=test', async () => {
    const previousNodeEnv = process.env.NODE_ENV
    process.env.NODE_ENV = 'test'
    vi.mocked(startBackgroundCacheRefresh).mockClear()
    const { stdin, stdout } = createTestStreams()
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    })

    try {
      root.render(<TypeaheadHarness />)
      await sleep(25)

      expect(startBackgroundCacheRefresh).not.toHaveBeenCalled()
    } finally {
      root.unmount()
      stdin.end()
      stdout.end()
      if (previousNodeEnv === undefined) {
        delete process.env.NODE_ENV
      } else {
        process.env.NODE_ENV = previousNodeEnv
      }
      await sleep(25)
    }
  })

  test('stops the original Ink input event when the adapted keyboard event is consumed', async () => {
    const { stdin, stdout } = createTestStreams()
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    })

    try {
      root.render(<TypeaheadHarness />)
      const useInputHandler = await waitForUseInputHandler()
      const stopImmediatePropagation = vi.fn()

      useInputHandler('', {}, {
        keypress: tabKeypress(),
        stopImmediatePropagation,
      })

      expect(stopImmediatePropagation).toHaveBeenCalledTimes(1)
      expect(harness.addNotification).toHaveBeenCalledWith(
        expect.objectContaining({ key: 'thinking-toggle-hint' }),
      )
    } finally {
      root.unmount()
      stdin.end()
      stdout.end()
      await sleep(25)
    }
  })
})
