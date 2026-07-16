import { PassThrough } from 'node:stream'

import React from 'react'
import { beforeEach, describe, expect, test, vi } from 'vitest'

const harness = vi.hoisted(() => ({
  addNotification: vi.fn(),
  logError: vi.fn(),
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
  directorySuggestions: [] as unknown[],
  directoryCompletionResponses: new Map<string, unknown[] | Promise<unknown[]>>(),
  keybindings: {} as Record<string, () => unknown>,
  sessionTitleMatches: [] as unknown[],
  sessionTitleResponses: new Map<string, unknown[] | Promise<unknown[]>>(),
  shellCompletions: [] as unknown[],
  shellHistoryCompletion: null as null | {
    fullCommand: string
    suffix: string
  },
  unifiedSuggestions: [] as unknown[],
  reset() {
    harness.addNotification.mockClear()
    harness.logError.mockClear()
    harness.appState.agentNameRegistry = new Map()
    harness.appState.mcp = { clients: [], resources: [] }
    harness.appState.promptSuggestion = {
      acceptedAt: 0,
      generationRequestId: null,
      promptId: null,
      shownAt: 0,
      text: null,
    }
    harness.appState.tasks = {}
    harness.appState.teamContext = undefined
    harness.appState.viewingAgentTaskId = null
    harness.directorySuggestions = []
    harness.directoryCompletionResponses = new Map()
    harness.keybindings = {}
    harness.sessionTitleMatches = []
    harness.sessionTitleResponses = new Map()
    harness.shellCompletions = []
    harness.shellHistoryCompletion = null
    harness.slackSuggestions = []
    harness.unifiedSuggestions = []
  },
  slackSuggestions: [] as unknown[],
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

vi.mock('../../utils/log.js', () => ({
  logError: harness.logError,
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
    useInput: vi.fn(),
  }
})

vi.mock('../keybindings/KeybindingContext.js', () => ({
  useOptionalKeybindingContext: () => ({ pendingChord: null }),
  useRegisterKeybindingContext: vi.fn(),
}))

vi.mock('../keybindings/useKeybinding.js', () => ({
  useKeybindings: (handlers: Record<string, () => unknown>) => {
    Object.assign(harness.keybindings, handlers)
  },
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
  isAgentSwarmsEnabled: () => Boolean(harness.appState.teamContext),
}))

vi.mock('../../utils/bash/shellCompletion.js', () => ({
  getShellCompletions: vi.fn(async () => harness.shellCompletions),
}))

vi.mock('../../utils/sessionStorage.js', () => ({
  getSessionIdFromLog: (log: { readonly sessionId?: string }) =>
    log.sessionId ?? 'session-1',
  searchSessionsByCustomTitle: vi.fn(async (query: string) => {
    if (harness.sessionTitleResponses.has(query)) {
      return await harness.sessionTitleResponses.get(query)
    }
    return harness.sessionTitleMatches
  }),
  writeAgentMetadata: vi.fn(async () => undefined),
}))

vi.mock('../../utils/suggestions/directoryCompletion.js', () => ({
  getDirectoryCompletions: vi.fn(async (query: string) => {
    if (harness.directoryCompletionResponses.has(query)) {
      return await harness.directoryCompletionResponses.get(query)
    }
    return harness.directorySuggestions
  }),
  getPathCompletions: vi.fn(async (query: string) => {
    if (harness.directoryCompletionResponses.has(query)) {
      return await harness.directoryCompletionResponses.get(query)
    }
    return harness.directorySuggestions
  }),
  isPathLikeToken: (token: string) =>
    token.startsWith('/') || token.startsWith('./') || token.startsWith('~/'),
}))

vi.mock('../../utils/suggestions/shellHistoryCompletion.js', () => ({
  getShellHistoryCompletion: vi.fn(async () => harness.shellHistoryCompletion),
}))

vi.mock('../../utils/suggestions/slackChannelSuggestions.js', () => ({
  getSlackChannelSuggestions: vi.fn(async () => harness.slackSuggestions),
  hasSlackMcpServer: () => harness.appState.mcp.clients.length > 0,
}))

vi.mock('../../utils/swarm/constants.js', () => ({
  TEAM_LEAD_NAME: 'team-lead',
}))

vi.mock('./fileSuggestions', () => ({
  applyFileSuggestion: (
    replacementValue: string,
    input: string,
    token: string,
    startPos: number,
    onInputChange: (value: string) => void,
    setCursorOffset: (offset: number) => void,
  ) => {
    const next =
      input.slice(0, startPos) +
      replacementValue +
      input.slice(startPos + token.length)
    onInputChange(next)
    setCursorOffset(startPos + replacementValue.length)
  },
  findLongestCommonPrefix: (items: readonly { readonly displayText: string }[]) => {
    if (items.length === 0) return ''
    let prefix = items[0]?.displayText ?? ''
    for (const item of items.slice(1)) {
      while (!item.displayText.startsWith(prefix)) prefix = prefix.slice(0, -1)
    }
    return prefix
  },
  onIndexBuildComplete: () => () => {},
  startBackgroundCacheRefresh: vi.fn(),
}))

vi.mock('./unifiedSuggestions', () => ({
  generateUnifiedSuggestions: vi.fn(async () => harness.unifiedSuggestions),
}))

import { createRoot } from '../ink/root.js'
import { KeyboardEvent } from '../ink/events/keyboard-event.js'
import type { SuggestionItem } from '../components/PromptInput/PromptInputFooterSuggestions.js'
import type { PromptInputMode } from '../../types/textInputTypes.js'
import { useTypeahead } from './useTypeahead.js'
import { generateUnifiedSuggestions } from './unifiedSuggestions'
import { getShellCompletions } from '../../utils/bash/shellCompletion.js'
import {
  getDirectoryCompletions,
  getPathCompletions,
} from '../../utils/suggestions/directoryCompletion.js'
import { getShellHistoryCompletion } from '../../utils/suggestions/shellHistoryCompletion.js'
import { getSlackChannelSuggestions } from '../../utils/suggestions/slackChannelSuggestions.js'
import { searchSessionsByCustomTitle } from '../../utils/sessionStorage.js'

type SuggestionsState = {
  commandArgumentHint?: string
  selectedSuggestion: number
  suggestions: SuggestionItem[]
}

type HookSnapshot = ReturnType<typeof useTypeahead> & {
  suggestionsState: SuggestionsState
}

const EMPTY_AGENTS: readonly never[] = []
const EMPTY_COMMANDS: readonly never[] = []

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

const generateUnifiedSuggestionsMock = vi.mocked(generateUnifiedSuggestions)
const getShellCompletionsMock = vi.mocked(getShellCompletions)
const getShellHistoryCompletionMock = vi.mocked(getShellHistoryCompletion)
const getDirectoryCompletionsMock = vi.mocked(getDirectoryCompletions)
const getPathCompletionsMock = vi.mocked(getPathCompletions)
const getSlackChannelSuggestionsMock = vi.mocked(getSlackChannelSuggestions)
const searchSessionsByCustomTitleMock = vi.mocked(searchSessionsByCustomTitle)

function createKey(
  name: string,
  options: { ctrl?: boolean; shift?: boolean } = {},
): KeyboardEvent {
  return new KeyboardEvent({
    ctrl: options.ctrl ?? false,
    fn: false,
    isPasted: false,
    kind: 'key',
    meta: false,
    name,
    option: false,
    raw: name,
    sequence: name.length === 1 ? name : '',
    shift: options.shift ?? false,
    super: false,
  })
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

function TypeaheadHarness(props: {
  readonly commands?: readonly unknown[]
  readonly cursorOffset?: number
  readonly input: string
  readonly markAccepted?: () => void
  readonly mode?: PromptInputMode
  readonly onInputChange: (value: string) => void
  readonly onModeChange?: (mode: PromptInputMode) => void
  readonly onSubmit?: (value: string, isSubmittingSlashCommand?: boolean) => void
  readonly setCursorOffset: (offset: number) => void
  readonly snapshot: (value: HookSnapshot) => void
}): React.ReactNode {
  const [suggestionsState, setSuggestionsState] = React.useState<SuggestionsState>({
    commandArgumentHint: undefined,
    selectedSuggestion: -1,
    suggestions: [],
  })
  const result = useTypeahead({
    agents: EMPTY_AGENTS as never,
    commands: (props.commands ?? EMPTY_COMMANDS) as never,
    cursorOffset: props.cursorOffset ?? props.input.length,
    input: props.input,
    markAccepted: props.markAccepted ?? vi.fn(),
    mode: props.mode ?? 'prompt',
    onInputChange: props.onInputChange,
    onModeChange: props.onModeChange,
    onSubmit: props.onSubmit ?? vi.fn(),
    setCursorOffset: props.setCursorOffset,
    setSuggestionsState,
    suggestionsState,
  })

  React.useEffect(() => {
    props.snapshot({ ...result, suggestionsState })
  })
  return null
}

async function renderHookHarness(props: {
  readonly commands?: readonly unknown[]
  readonly input: string
  readonly markAccepted?: () => void
  readonly mode?: PromptInputMode
  readonly onInputChange?: (value: string) => void
  readonly onModeChange?: (mode: PromptInputMode) => void
  readonly onSubmit?: (value: string, isSubmittingSlashCommand?: boolean) => void
  readonly setCursorOffset?: (offset: number) => void
}): Promise<{
  dispose: () => Promise<void>
  getSnapshot: () => HookSnapshot
  rerender: (next: Partial<typeof props>) => void
}> {
  const { stdin, stdout } = createTestStreams()
  let currentProps = props
  let snapshot: HookSnapshot | undefined
  const root = await createRoot({
    patchConsole: false,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  })
  const render = () => {
    root.render(
      <TypeaheadHarness
        {...currentProps}
        onInputChange={currentProps.onInputChange ?? vi.fn()}
        setCursorOffset={currentProps.setCursorOffset ?? vi.fn()}
        snapshot={value => {
          snapshot = value
        }}
      />,
    )
  }
  render()
  await waitFor(() => snapshot !== undefined, 'hook snapshot')
  return {
    dispose: async () => {
      root.unmount()
      stdin.end()
      stdout.end()
      await sleep(25)
    },
    getSnapshot: () => {
      if (!snapshot) throw new Error('Hook snapshot missing')
      return snapshot
    },
    rerender: next => {
      currentProps = { ...currentProps, ...next }
      render()
    },
  }
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < 1000) {
    if (predicate()) return
    await sleep(10)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

function createDeferred<T>(): {
  promise: Promise<T>
  reject: (reason?: unknown) => void
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, reject, resolve }
}

const command = (name: string, aliases: readonly string[] = []) => ({
  aliases,
  description: `${name} command`,
  isHidden: false,
  name,
  type: 'prompt',
})

describe('useTypeahead hook paths', () => {
  beforeEach(() => {
    harness.reset()
    generateUnifiedSuggestionsMock.mockClear()
    getShellCompletionsMock.mockClear()
    getShellHistoryCompletionMock.mockClear()
    getDirectoryCompletionsMock.mockClear()
    searchSessionsByCustomTitleMock.mockClear()
    getSlackChannelSuggestionsMock.mockClear()
  })

  test('generates slash command suggestions and navigates them with autocomplete keybindings', async () => {
    const rendered = await renderHookHarness({
      commands: [command('help'), command('history'), command('logout')],
      input: '/h',
    })

    try {
      await waitFor(
        () => rendered.getSnapshot().suggestionType === 'command',
        'command suggestions',
      )
      expect(rendered.getSnapshot().suggestions.map(item => item.displayText)).toContain(
        '/help',
      )

      harness.keybindings['autocomplete:next']?.()
      await waitFor(
        () => rendered.getSnapshot().suggestionsState.selectedSuggestion === 1,
        'next suggestion',
      )

      harness.keybindings['autocomplete:previous']?.()
      await waitFor(
        () => rendered.getSnapshot().suggestionsState.selectedSuggestion === 0,
        'previous suggestion',
      )

      harness.keybindings['autocomplete:dismiss']?.()
      await waitFor(
        () => rendered.getSnapshot().suggestions.length === 0,
        'dismissed suggestions',
      )
    } finally {
      await rendered.dispose()
    }
  })

  test('accepts prompt suggestion ghost text with right arrow and mode detection', async () => {
    harness.appState.promptSuggestion = {
      acceptedAt: 0,
      generationRequestId: null,
      promptId: 'prompt-1',
      shownAt: Date.now(),
      text: '!echo accepted',
    }
    const onInputChange = vi.fn()
    const onModeChange = vi.fn()
    const setCursorOffset = vi.fn()
    const rendered = await renderHookHarness({
      input: '',
      onInputChange,
      onModeChange,
      setCursorOffset,
    })

    try {
      rendered.getSnapshot().handleKeyDown(createKey('right'))

      expect(onModeChange).toHaveBeenCalledWith('bash')
      expect(onInputChange).toHaveBeenCalledWith('echo accepted')
      expect(setCursorOffset).toHaveBeenCalledWith('echo accepted'.length)
    } finally {
      await rendered.dispose()
    }
  })

  test('uses tab to show thinking hint on empty input and to fetch file suggestions for @ tokens', async () => {
    harness.unifiedSuggestions = [
      { id: 'src/app.ts', displayText: 'src/app.ts', description: 'file' },
    ]
    const rendered = await renderHookHarness({ input: '' })

    try {
      const emptyTab = createKey('tab')
      rendered.getSnapshot().handleKeyDown(emptyTab)
      expect(emptyTab.defaultPrevented).toBe(true)
      expect(harness.addNotification).toHaveBeenCalledWith(
        expect.objectContaining({ key: 'thinking-toggle-hint' }),
      )

      rendered.rerender({ input: '@sr', cursorOffset: 3 })
      await waitFor(() => rendered.getSnapshot().handleKeyDown !== undefined, 'rerender')
      const tokenTab = createKey('tab')
      rendered.getSnapshot().handleKeyDown(tokenTab)
      await waitFor(
        () => rendered.getSnapshot().suggestions.some(item => item.id === 'src/app.ts'),
        'file suggestions',
      )
    } finally {
      await rendered.dispose()
    }
  })

  test('drops stale Tab-fetched file suggestions after the input changes', async () => {
    const staleSuggestions = createDeferred<SuggestionItem[]>()
    generateUnifiedSuggestionsMock.mockImplementationOnce(
      async () => staleSuggestions.promise,
    )
    const rendered = await renderHookHarness({
      cursorOffset: 'old'.length,
      input: 'old',
    })

    try {
      harness.keybindings['autocomplete:accept']?.()
      await waitFor(
        () => generateUnifiedSuggestionsMock.mock.calls.length === 1,
        'Tab-triggered file suggestion fetch',
      )

      rendered.rerender({ cursorOffset: 'new'.length, input: 'new' })
      staleSuggestions.resolve([
        {
          id: 'file-old-path.ts',
          displayText: 'old/path.ts',
          description: 'file',
        },
      ])
      await sleep(25)

      expect(rendered.getSnapshot().suggestionType).toBe('none')
      expect(rendered.getSnapshot().suggestions).toEqual([])
    } finally {
      await rendered.dispose()
    }
  })

  test('drops debounced file suggestions after the mode changes', async () => {
    const staleSuggestions = createDeferred<SuggestionItem[]>()
    generateUnifiedSuggestionsMock.mockImplementationOnce(
      async () => staleSuggestions.promise,
    )
    const rendered = await renderHookHarness({
      cursorOffset: '@sr'.length,
      input: '@sr',
    })

    try {
      await waitFor(
        () => generateUnifiedSuggestionsMock.mock.calls.length === 1,
        'debounced file suggestion fetch',
      )

      rendered.rerender({
        cursorOffset: '@sr'.length,
        input: '@sr',
        mode: 'bash',
      })
      staleSuggestions.resolve([
        {
          id: 'src/app.ts',
          displayText: 'src/app.ts',
          description: 'file',
        },
      ])
      await sleep(50)

      expect(rendered.getSnapshot().suggestionType).toBe('none')
      expect(rendered.getSnapshot().suggestions).toEqual([])
    } finally {
      await rendered.dispose()
    }
  })

  test('does not apply stale single shell completion after the input changes', async () => {
    const staleCompletions = createDeferred<SuggestionItem[]>()
    getShellCompletionsMock.mockImplementationOnce(
      async () => staleCompletions.promise,
    )
    const onInputChange = vi.fn()
    const setCursorOffset = vi.fn()
    const rendered = await renderHookHarness({
      cursorOffset: 'g'.length,
      input: 'g',
      mode: 'bash',
      onInputChange,
      setCursorOffset,
    })

    try {
      harness.keybindings['autocomplete:accept']?.()
      await waitFor(
        () => getShellCompletionsMock.mock.calls.length === 1,
        'Tab-triggered shell completion fetch',
      )

      rendered.rerender({ cursorOffset: 'gi'.length, input: 'gi', mode: 'bash' })
      staleCompletions.resolve([
        {
          displayText: 'git',
          id: 'git',
          metadata: { completionType: 'command' },
        },
      ])
      await sleep(25)

      expect(onInputChange).not.toHaveBeenCalled()
      expect(setCursorOffset).not.toHaveBeenCalled()
    } finally {
      await rendered.dispose()
    }
  })

  test('accepts bash history ghost text and single shell completion through autocomplete accept', async () => {
    harness.shellHistoryCompletion = {
      fullCommand: 'git status --short',
      suffix: 'atus --short',
    }
    const onInputChange = vi.fn()
    const setCursorOffset = vi.fn()
    const rendered = await renderHookHarness({
      input: 'git st',
      mode: 'bash',
      onInputChange,
      setCursorOffset,
    })

    try {
      await waitFor(
        () => rendered.getSnapshot().inlineGhostText?.fullCommand === 'git status --short',
        'bash history ghost text',
      )

      harness.keybindings['autocomplete:accept']?.()
      expect(onInputChange).toHaveBeenCalledWith('git status --short')
      expect(setCursorOffset).toHaveBeenCalledWith('git status --short'.length)

      harness.shellHistoryCompletion = null
      harness.shellCompletions = [
        {
          displayText: 'grep',
          id: 'grep',
          metadata: { completionType: 'command' },
        },
      ]
      rendered.rerender({ input: 'gr', mode: 'bash' })
      await waitFor(
        () => rendered.getSnapshot().inlineGhostText === undefined,
        'cleared bash ghost text',
      )

      harness.keybindings['autocomplete:accept']?.()
      await waitFor(
        () => onInputChange.mock.calls.some(call => call[0] === 'grep '),
        'single shell completion applied',
      )
      expect(setCursorOffset).toHaveBeenCalledWith('grep '.length)
    } finally {
      await rendered.dispose()
    }
  })

  test('drops stale bash history ghost text after the mode changes', async () => {
    const staleHistory = createDeferred<{
      fullCommand: string
      suffix: string
    }>()
    harness.shellHistoryCompletion =
      staleHistory.promise as unknown as typeof harness.shellHistoryCompletion
    const rendered = await renderHookHarness({
      input: 'git st',
      mode: 'bash',
    })

    try {
      await waitFor(
        () => getShellHistoryCompletionMock.mock.calls.length === 1,
        'delayed bash history request',
      )

      rendered.rerender({
        input: 'git st',
        mode: 'prompt',
      })
      staleHistory.resolve({
        fullCommand: 'git status --short',
        suffix: 'atus --short',
      })
      await sleep(50)

      getShellHistoryCompletionMock.mockClear()
      const freshHistory = createDeferred<null>()
      harness.shellHistoryCompletion =
        freshHistory.promise as unknown as typeof harness.shellHistoryCompletion
      rendered.rerender({
        input: 'git st',
        mode: 'bash',
      })
      await waitFor(
        () => getShellHistoryCompletionMock.mock.calls.length === 1,
        'fresh bash history request',
      )

      expect(rendered.getSnapshot().inlineGhostText).toBeUndefined()
    } finally {
      await rendered.dispose()
    }
  })

  test('applies teammate and slack trigger suggestions with enter', async () => {
    harness.appState.teamContext = {
      teammates: {
        fixer: { name: 'Fixer' },
        lead: { name: 'team-lead' },
      },
    }
    harness.appState.agentNameRegistry.set('Planner', 'agent-planner')
    harness.appState.tasks = {
      'agent-planner': { status: 'running' },
    }
    const onInputChange = vi.fn()
    const setCursorOffset = vi.fn()
    const rendered = await renderHookHarness({
      input: '@Pl',
      onInputChange,
      setCursorOffset,
    })

    try {
      await waitFor(
        () => rendered.getSnapshot().suggestionType === 'agent',
        'agent suggestions',
      )
      expect(rendered.getSnapshot().suggestions.map(item => item.displayText)).toEqual([
        '@Planner',
      ])

      rendered.getSnapshot().handleKeyDown(createKey('return'))
      expect(onInputChange).toHaveBeenCalledWith('@Planner ')
      expect(setCursorOffset).toHaveBeenCalledWith('@Planner '.length)

      harness.appState.teamContext = undefined
      harness.appState.agentNameRegistry = new Map()
      harness.appState.mcp = {
        clients: [{ name: 'slack' }],
        resources: [],
      }
      harness.slackSuggestions = [
        { displayText: '#general', id: 'slack-general', description: 'channel' },
      ]
      rendered.rerender({ input: '#gen', cursorOffset: 4 })
      await waitFor(
        () => rendered.getSnapshot().suggestionType === 'slack-channel',
        'slack channel suggestions',
      )

      rendered.getSnapshot().handleKeyDown(createKey('return'))
      expect(onInputChange).toHaveBeenCalledWith('#general ')
      expect(setCursorOffset).toHaveBeenCalledWith('#general '.length)
    } finally {
      await rendered.dispose()
    }
  })

  test('accepting trigger suggestions replaces the whole token at the cursor', async () => {
    harness.appState.agentNameRegistry.set('Planner', 'agent-planner')
    harness.appState.tasks = {
      'agent-planner': { status: 'idle' },
    }
    const onInputChange = vi.fn()
    const setCursorOffset = vi.fn()
    const rendered = await renderHookHarness({
      cursorOffset: '@Pla'.length,
      input: '@Planner now',
      onInputChange,
      setCursorOffset,
    })

    try {
      await waitFor(
        () => rendered.getSnapshot().suggestionType === 'agent',
        'mid-token agent suggestions',
      )

      rendered.getSnapshot().handleKeyDown(createKey('return'))
      expect(onInputChange).toHaveBeenCalledWith('@Planner now')
      expect(setCursorOffset).toHaveBeenCalledWith('@Planner '.length)

      onInputChange.mockClear()
      setCursorOffset.mockClear()
      harness.appState.agentNameRegistry = new Map()
      harness.appState.mcp = {
        clients: [{ name: 'slack' }],
        resources: [],
      }
      harness.slackSuggestions = [
        { displayText: '#general', id: 'slack-general', description: 'channel' },
      ]
      rendered.rerender({
        cursorOffset: '#gen'.length,
        input: '#general now',
      })
      await waitFor(
        () => rendered.getSnapshot().suggestionType === 'slack-channel',
        'mid-token Slack suggestions',
      )

      rendered.getSnapshot().handleKeyDown(createKey('return'))
      expect(onInputChange).toHaveBeenCalledWith('#general now')
      expect(setCursorOffset).toHaveBeenCalledWith('#general '.length)
    } finally {
      await rendered.dispose()
    }
  })

  test('refreshes agent mention suggestions when the agent registry changes without editing input', async () => {
    const rendered = await renderHookHarness({
      cursorOffset: '@Pl'.length,
      input: '@Pl',
    })

    try {
      await sleep(25)
      expect(rendered.getSnapshot().suggestionType).toBe('none')

      harness.appState.agentNameRegistry = new Map([
        ['Planner', 'agent-planner'],
      ])
      harness.appState.tasks = {
        'agent-planner': { status: 'running' },
      }
      rendered.rerender({
        cursorOffset: '@Pl'.length,
        input: '@Pl',
      })

      await waitFor(
        () =>
          rendered
            .getSnapshot()
            .suggestions.some(item => item.displayText === '@Planner'),
        'agent registry suggestions after registry update',
      )
      expect(rendered.getSnapshot().suggestions[0]).toMatchObject({
        description: 'send message · running',
        displayText: '@Planner',
      })

      harness.appState.tasks = {
        'agent-planner': { status: 'completed' },
      }
      rendered.rerender({
        cursorOffset: '@Pl'.length,
        input: '@Pl',
      })

      await waitFor(
        () => rendered.getSnapshot().suggestions[0]?.description === 'send message · completed',
        'agent status refresh for same input',
      )
    } finally {
      await rendered.dispose()
    }
  })

  test('refreshes teammate mention suggestions when team context changes without editing input', async () => {
    const rendered = await renderHookHarness({
      cursorOffset: '@Fi'.length,
      input: '@Fi',
    })

    try {
      await sleep(25)
      expect(rendered.getSnapshot().suggestionType).toBe('none')

      harness.appState.teamContext = {
        teammates: {
          fixer: { name: 'Fixer' },
          lead: { name: 'team-lead' },
        },
      }
      rendered.rerender({
        cursorOffset: '@Fi'.length,
        input: '@Fi',
      })

      await waitFor(
        () =>
          rendered
            .getSnapshot()
            .suggestions.some(item => item.displayText === '@Fixer'),
        'teammate suggestions after team context update',
      )
      expect(rendered.getSnapshot().suggestions.map(item => item.displayText)).toEqual([
        '@Fixer',
      ])
    } finally {
      await rendered.dispose()
    }
  })

  test('handles directory command completion and resume title execution', async () => {
    harness.directorySuggestions = [
      {
        displayText: 'src',
        id: 'src',
        metadata: { type: 'directory' },
      },
    ]
    const onInputChange = vi.fn()
    const onSubmit = vi.fn()
    const setCursorOffset = vi.fn()
    const rendered = await renderHookHarness({
      input: '/add-dir s',
      onInputChange,
      onSubmit,
      setCursorOffset,
    })

    try {
      await waitFor(
        () => rendered.getSnapshot().suggestionType === 'directory',
        'directory suggestions',
      )

      harness.keybindings['autocomplete:accept']?.()
      await waitFor(
        () => onInputChange.mock.calls.some(call => call[0] === '/add-dir src/'),
        'directory suggestion applied',
      )
      expect(setCursorOffset).toHaveBeenCalledWith('/add-dir src/'.length)

      harness.directorySuggestions = []
      harness.sessionTitleMatches = [
        {
          customTitle: 'Sprint planning',
          messageCount: 12,
          modified: new Date('2026-05-20T00:00:00.000Z'),
          sessionId: 'session-42',
        },
      ]
      rendered.rerender({ input: '/resume Sprint', cursorOffset: '/resume Sprint'.length })
      await waitFor(
        () => rendered.getSnapshot().suggestionType === 'custom-title',
        'custom title suggestions',
      )

      rendered.getSnapshot().handleKeyDown(createKey('return'))
      expect(onInputChange).toHaveBeenCalledWith('/resume session-42')
      expect(setCursorOffset).toHaveBeenCalledWith('/resume session-42'.length)
      expect(onSubmit).toHaveBeenCalledWith('/resume session-42', true)
    } finally {
      await rendered.dispose()
    }
  })

  test('submits add-dir commands on enter while directory suggestions are visible', async () => {
    harness.directorySuggestions = [
      {
        displayText: 'src',
        id: 'src',
        metadata: { type: 'directory' },
      },
    ]
    const onSubmit = vi.fn()
    const rendered = await renderHookHarness({
      input: '/add-dir s',
      onSubmit,
    })

    try {
      await waitFor(
        () => rendered.getSnapshot().suggestionType === 'directory',
        'directory suggestions',
      )

      const enter = createKey('return')
      rendered.getSnapshot().handleKeyDown(enter)

      expect(enter.defaultPrevented).toBe(true)
      expect(onSubmit).toHaveBeenCalledWith('/add-dir s', true)
    } finally {
      await rendered.dispose()
    }
  })

  test('ignores stale /add-dir directory completions that resolve out of order', async () => {
    let resolveSlowCompletion: (items: unknown[]) => void = () => {}
    harness.directoryCompletionResponses.set(
      's',
      new Promise(resolve => {
        resolveSlowCompletion = resolve
      }),
    )
    harness.directoryCompletionResponses.set('lib', [
      {
        displayText: 'lib',
        id: 'lib',
        metadata: { type: 'directory' },
      },
    ])
    const rendered = await renderHookHarness({
      input: '/add-dir s',
      cursorOffset: '/add-dir s'.length,
    })

    try {
      await waitFor(
        () => getDirectoryCompletionsMock.mock.calls.some(call => call[0] === 's'),
        'initial delayed directory completion request',
      )

      rendered.rerender({
        input: '/add-dir lib',
        cursorOffset: '/add-dir lib'.length,
      })
      await waitFor(
        () =>
          rendered.getSnapshot().suggestionType === 'directory' &&
          rendered.getSnapshot().suggestions[0]?.id === 'lib',
        'newer directory completion result',
      )

      resolveSlowCompletion([
        {
          displayText: 'src',
          id: 'src',
          metadata: { type: 'directory' },
        },
      ])
      await sleep(50)

      expect(rendered.getSnapshot().suggestionType).toBe('directory')
      expect(rendered.getSnapshot().suggestions).toEqual([
        {
          displayText: 'lib',
          id: 'lib',
          metadata: { type: 'directory' },
        },
      ])
    } finally {
      await rendered.dispose()
    }
  })

  test('drops /add-dir directory completions after the mode changes', async () => {
    let resolveSlowCompletion: (items: unknown[]) => void = () => {}
    harness.directoryCompletionResponses.set(
      's',
      new Promise(resolve => {
        resolveSlowCompletion = resolve
      }),
    )
    const rendered = await renderHookHarness({
      input: '/add-dir s',
      cursorOffset: '/add-dir s'.length,
    })

    try {
      await waitFor(
        () => getDirectoryCompletionsMock.mock.calls.some(call => call[0] === 's'),
        'delayed directory completion request',
      )

      rendered.rerender({
        input: '/add-dir s',
        cursorOffset: '/add-dir s'.length,
        mode: 'bash',
      })
      resolveSlowCompletion([
        {
          displayText: 'src',
          id: 'src',
          metadata: { type: 'directory' },
        },
      ])
      await sleep(50)

      expect(rendered.getSnapshot().suggestionType).toBe('none')
      expect(rendered.getSnapshot().suggestions).toEqual([])
    } finally {
      await rendered.dispose()
    }
  })

  test('ignores stale @ path completions after input leaves the path token', async () => {
    let resolveSlowPathCompletion: (items: unknown[]) => void = () => {}
    harness.directoryCompletionResponses.set(
      '/tm',
      new Promise(resolve => {
        resolveSlowPathCompletion = resolve
      }),
    )
    harness.unifiedSuggestions = [
      {
        displayText: 'plain.md',
        id: 'plain.md',
        description: 'file',
      },
    ]
    const rendered = await renderHookHarness({
      input: '@/tm',
      cursorOffset: '@/tm'.length,
    })

    try {
      await waitFor(
        () => getPathCompletionsMock.mock.calls.some(call => call[0] === '/tm'),
        'initial delayed path completion request',
      )

      rendered.rerender({
        input: '@plain',
        cursorOffset: '@plain'.length,
      })
      await waitFor(
        () =>
          rendered.getSnapshot().suggestionType === 'file' &&
          rendered.getSnapshot().suggestions[0]?.id === 'plain.md',
        'newer file suggestions',
      )

      resolveSlowPathCompletion([
        {
          displayText: '/tmp/project',
          id: '/tmp/project',
          metadata: { type: 'directory' },
        },
      ])
      await sleep(50)

      expect(rendered.getSnapshot().suggestionType).toBe('file')
      expect(rendered.getSnapshot().suggestions[0]?.id).toBe('plain.md')
    } finally {
      await rendered.dispose()
    }
  })

  test('refreshes @ suggestions when MCP resources change without editing input', async () => {
    harness.unifiedSuggestions = [
      {
        displayText: 'old-doc.md',
        id: 'old-doc.md',
      },
    ]
    const rendered = await renderHookHarness({
      input: '@doc',
    })

    try {
      await waitFor(
        () =>
          rendered.getSnapshot().suggestionType === 'file' &&
          rendered.getSnapshot().suggestions[0]?.id === 'old-doc.md',
        'initial file suggestions',
      )
      expect(generateUnifiedSuggestionsMock).toHaveBeenCalledTimes(1)

      harness.appState.mcp = {
        clients: [],
        resources: [{ name: 'docs' }],
      }
      harness.unifiedSuggestions = [
        {
          displayText: 'docs://latest',
          id: 'mcp-resource-docs-latest',
        },
      ]
      rendered.rerender({ input: '@doc' })

      await waitFor(
        () => generateUnifiedSuggestionsMock.mock.calls.length === 2,
        'refetched suggestions after MCP resources changed',
      )
      await waitFor(
        () =>
          rendered.getSnapshot().suggestionType === 'file' &&
          rendered.getSnapshot().suggestions[0]?.id ===
            'mcp-resource-docs-latest',
        'fresh MCP resource suggestions',
      )
    } finally {
      await rendered.dispose()
    }
  })

  test('drops @ path completions after the mode changes', async () => {
    let resolveSlowPathCompletion: (items: unknown[]) => void = () => {}
    harness.directoryCompletionResponses.set(
      '/tm',
      new Promise(resolve => {
        resolveSlowPathCompletion = resolve
      }),
    )
    const rendered = await renderHookHarness({
      input: '@/tm',
      cursorOffset: '@/tm'.length,
    })

    try {
      await waitFor(
        () => getPathCompletionsMock.mock.calls.some(call => call[0] === '/tm'),
        'delayed path completion request',
      )

      rendered.rerender({
        input: '@/tm',
        cursorOffset: '@/tm'.length,
        mode: 'bash',
      })
      resolveSlowPathCompletion([
        {
          displayText: '/tmp/project',
          id: '/tmp/project',
          metadata: { type: 'directory' },
        },
      ])
      await sleep(50)

      expect(rendered.getSnapshot().suggestionType).toBe('none')
      expect(rendered.getSnapshot().suggestions).toEqual([])
    } finally {
      await rendered.dispose()
    }
  })

  test('ignores stale /resume title completions that resolve out of order', async () => {
    let resolveSlowTitle: (items: unknown[]) => void = () => {}
    harness.sessionTitleResponses.set(
      'Old',
      new Promise(resolve => {
        resolveSlowTitle = resolve
      }),
    )
    harness.sessionTitleResponses.set('New', [
      {
        customTitle: 'New sprint',
        messageCount: 7,
        modified: new Date('2026-05-21T00:00:00.000Z'),
        sessionId: 'session-new',
      },
    ])
    const rendered = await renderHookHarness({
      input: '/resume Old',
      cursorOffset: '/resume Old'.length,
    })

    try {
      await waitFor(
        () => searchSessionsByCustomTitleMock.mock.calls.some(call => call[0] === 'Old'),
        'initial delayed title completion request',
      )

      rendered.rerender({
        input: '/resume New',
        cursorOffset: '/resume New'.length,
      })
      await waitFor(
        () =>
          rendered.getSnapshot().suggestionType === 'custom-title' &&
          rendered.getSnapshot().suggestions[0]?.displayText === 'New sprint',
        'newer title completion result',
      )

      resolveSlowTitle([
        {
          customTitle: 'Old sprint',
          messageCount: 4,
          modified: new Date('2026-05-20T00:00:00.000Z'),
          sessionId: 'session-old',
        },
      ])
      await sleep(50)

      expect(rendered.getSnapshot().suggestionType).toBe('custom-title')
      expect(rendered.getSnapshot().suggestions[0]).toMatchObject({
        displayText: 'New sprint',
        metadata: { sessionId: 'session-new' },
      })
    } finally {
      await rendered.dispose()
    }
  })

  test('drops /resume title completions after the mode changes', async () => {
    let resolveSlowTitle: (items: unknown[]) => void = () => {}
    harness.sessionTitleResponses.set(
      'Sprint',
      new Promise(resolve => {
        resolveSlowTitle = resolve
      }),
    )
    const rendered = await renderHookHarness({
      input: '/resume Sprint',
      cursorOffset: '/resume Sprint'.length,
    })

    try {
      await waitFor(
        () =>
          searchSessionsByCustomTitleMock.mock.calls.some(
            call => call[0] === 'Sprint',
          ),
        'delayed title completion request',
      )

      rendered.rerender({
        input: '/resume Sprint',
        cursorOffset: '/resume Sprint'.length,
        mode: 'bash',
      })
      resolveSlowTitle([
        {
          customTitle: 'Sprint planning',
          messageCount: 12,
          modified: new Date('2026-05-20T00:00:00.000Z'),
          sessionId: 'session-42',
        },
      ])
      await sleep(50)

      expect(rendered.getSnapshot().suggestionType).toBe('none')
      expect(rendered.getSnapshot().suggestions).toEqual([])
    } finally {
      await rendered.dispose()
    }
  })

  test('drops Slack channel completions after the mode changes', async () => {
    let resolveSlowChannels: (items: unknown[]) => void = () => {}
    harness.appState.mcp = {
      clients: [{ name: 'slack' }],
      resources: [],
    }
    harness.slackSuggestions = new Promise(resolve => {
      resolveSlowChannels = resolve
    }) as unknown as unknown[]
    const rendered = await renderHookHarness({
      input: '#gen',
      cursorOffset: '#gen'.length,
    })

    try {
      await waitFor(
        () =>
          getSlackChannelSuggestionsMock.mock.calls.some(
            call => call[1] === 'gen',
          ),
        'delayed Slack completion request',
      )

      rendered.rerender({
        input: '#gen',
        cursorOffset: '#gen'.length,
        mode: 'bash',
      })
      resolveSlowChannels([
        {
          displayText: '#general',
          id: 'slack-general',
          description: 'channel',
        },
      ])
      await sleep(50)

      expect(rendered.getSnapshot().suggestionType).toBe('none')
      expect(rendered.getSnapshot().suggestions).toEqual([])
    } finally {
      await rendered.dispose()
    }
  })

  test('refreshes Slack channel suggestions when MCP clients change without editing input', async () => {
    const resources = harness.appState.mcp.resources
    harness.slackSuggestions = [
      { displayText: '#general', id: 'slack-general', description: 'channel' },
    ]
    const rendered = await renderHookHarness({
      cursorOffset: '#gen'.length,
      input: '#gen',
    })

    try {
      await sleep(25)
      expect(getSlackChannelSuggestionsMock).not.toHaveBeenCalled()

      harness.appState.mcp = {
        clients: [{ name: 'slack' }],
        resources,
      }
      rendered.rerender({
        cursorOffset: '#gen'.length,
        input: '#gen',
      })

      await waitFor(
        () =>
          getSlackChannelSuggestionsMock.mock.calls.some(
            call => call[1] === 'gen',
          ),
        'Slack suggestions after MCP client connection',
      )
      await waitFor(
        () => rendered.getSnapshot().suggestionType === 'slack-channel',
        'visible Slack suggestions after MCP client connection',
      )
    } finally {
      await rendered.dispose()
    }
  })

  test('clears Slack channel suggestions when the Slack MCP client disconnects', async () => {
    const resources = harness.appState.mcp.resources
    harness.appState.mcp = {
      clients: [{ name: 'slack' }],
      resources,
    }
    harness.slackSuggestions = [
      { displayText: '#general', id: 'slack-general', description: 'channel' },
    ]
    const rendered = await renderHookHarness({
      cursorOffset: '#gen'.length,
      input: '#gen',
    })

    try {
      await waitFor(
        () => rendered.getSnapshot().suggestionType === 'slack-channel',
        'initial Slack suggestions',
      )

      harness.appState.mcp = {
        clients: [],
        resources,
      }
      rendered.rerender({
        cursorOffset: '#gen'.length,
        input: '#gen',
      })

      await waitFor(
        () => rendered.getSnapshot().suggestionType === 'none',
        'cleared Slack suggestions after MCP client disconnect',
      )
      expect(rendered.getSnapshot().suggestions).toEqual([])
    } finally {
      await rendered.dispose()
    }
  })

  test('drops stale Slack channel results after the Slack MCP client disconnects', async () => {
    const resources = harness.appState.mcp.resources
    let resolveSlowChannels: (items: unknown[]) => void = () => {}
    harness.appState.mcp = {
      clients: [{ name: 'slack' }],
      resources,
    }
    harness.slackSuggestions = new Promise(resolve => {
      resolveSlowChannels = resolve
    }) as unknown as unknown[]
    const rendered = await renderHookHarness({
      cursorOffset: '#gen'.length,
      input: '#gen',
    })

    try {
      await waitFor(
        () =>
          getSlackChannelSuggestionsMock.mock.calls.some(
            call => call[1] === 'gen',
          ),
        'delayed Slack completion request',
      )

      harness.appState.mcp = {
        clients: [],
        resources,
      }
      rendered.rerender({
        cursorOffset: '#gen'.length,
        input: '#gen',
      })
      resolveSlowChannels([
        { displayText: '#general', id: 'slack-general', description: 'channel' },
      ])
      await sleep(50)

      expect(rendered.getSnapshot().suggestionType).toBe('none')
      expect(rendered.getSnapshot().suggestions).toEqual([])
    } finally {
      await rendered.dispose()
    }
  })

  test('enters partial slash commands without executing until the command text is exact', async () => {
    const onInputChange = vi.fn()
    const onSubmit = vi.fn()
    const setCursorOffset = vi.fn()
    const rendered = await renderHookHarness({
      commands: [command('help')],
      input: '/h',
      onInputChange,
      onSubmit,
      setCursorOffset,
    })

    try {
      await waitFor(
        () => rendered.getSnapshot().suggestionType === 'command',
        'partial command suggestions',
      )

      rendered.getSnapshot().handleKeyDown(createKey('return'))
      expect(onInputChange).toHaveBeenCalledWith('/help ')
      expect(setCursorOffset).toHaveBeenCalledWith('/help '.length)
      expect(onSubmit).not.toHaveBeenCalled()

      onInputChange.mockClear()
      setCursorOffset.mockClear()
      rendered.rerender({ input: '/help', cursorOffset: '/help'.length })
      await waitFor(
        () => rendered.getSnapshot().suggestionType === 'command',
        'exact command suggestions',
      )

      rendered.getSnapshot().handleKeyDown(createKey('return'))
      expect(onInputChange).toHaveBeenCalledWith('/help ')
      expect(setCursorOffset).toHaveBeenCalledWith('/help '.length)
      expect(onSubmit).toHaveBeenCalledWith('/help ', true)
    } finally {
      await rendered.dispose()
    }
  })

  test('shows command argument hints on a trailing space and clears them once args start', async () => {
    const rendered = await renderHookHarness({
      commands: [{ ...command('review'), argumentHint: '<target>' }],
      input: '/review ',
    })

    try {
      await waitFor(
        () => rendered.getSnapshot().commandArgumentHint === '<target>',
        'command argument hint',
      )
      expect(rendered.getSnapshot().suggestions).toEqual([])

      rendered.rerender({
        input: '/review src',
        cursorOffset: '/review src'.length,
      })
      await waitFor(
        () => rendered.getSnapshot().commandArgumentHint === undefined,
        'cleared command argument hint',
      )
    } finally {
      await rendered.dispose()
    }
  })

  test('does not accept prompt suggestion text while viewing a teammate', async () => {
    harness.appState.promptSuggestion = {
      acceptedAt: 0,
      generationRequestId: null,
      promptId: 'prompt-1',
      shownAt: Date.now(),
      text: '!echo hidden',
    }
    harness.appState.viewingAgentTaskId = 'task-1'
    const markAccepted = vi.fn()
    const onInputChange = vi.fn()
    const onModeChange = vi.fn()
    const setCursorOffset = vi.fn()
    const rendered = await renderHookHarness({
      input: '',
      markAccepted,
      onInputChange,
      onModeChange,
      setCursorOffset,
    })

    try {
      rendered.getSnapshot().handleKeyDown(createKey('right'))
      expect(markAccepted).not.toHaveBeenCalled()
      expect(onModeChange).not.toHaveBeenCalled()
      expect(onInputChange).not.toHaveBeenCalled()
      expect(setCursorOffset).not.toHaveBeenCalled()

      const tab = createKey('tab')
      rendered.getSnapshot().handleKeyDown(tab)
      expect(tab.defaultPrevented).toBe(true)
      expect(markAccepted).not.toHaveBeenCalled()
      expect(onInputChange).not.toHaveBeenCalled()
      expect(harness.addNotification).toHaveBeenCalledWith(
        expect.objectContaining({ key: 'thinking-toggle-hint' }),
      )
    } finally {
      await rendered.dispose()
    }
  })

  test('dismiss remembers the current input and does not immediately refetch it', async () => {
    harness.unifiedSuggestions = [
      { id: 'src/app.ts', displayText: 'src/app.ts', description: 'file' },
    ]
    const rendered = await renderHookHarness({ input: '@sr', cursorOffset: 3 })

    try {
      await waitFor(
        () => rendered.getSnapshot().suggestionType === 'file',
        'initial file suggestions',
      )

      harness.keybindings['autocomplete:dismiss']?.()
      await waitFor(
        () => rendered.getSnapshot().suggestions.length === 0,
        'dismissed suggestions',
      )

      generateUnifiedSuggestionsMock.mockClear()
      rendered.rerender({ input: '@sr', cursorOffset: 3 })
      await sleep(25)
      expect(generateUnifiedSuggestionsMock).not.toHaveBeenCalled()

      rendered.rerender({ input: '@src', cursorOffset: 4 })
      await waitFor(
        () => generateUnifiedSuggestionsMock.mock.calls.length > 0,
        'refetch after input changes',
      )
    } finally {
      await rendered.dispose()
    }
  })

  test('dismissed @ suggestions refresh when MCP resources change for the same input', async () => {
    harness.unifiedSuggestions = [
      { id: 'doc-old.md', displayText: 'doc-old.md', description: 'file' },
    ]
    const rendered = await renderHookHarness({ input: '@doc', cursorOffset: 4 })

    try {
      await waitFor(
        () => rendered.getSnapshot().suggestionType === 'file',
        'initial file suggestions',
      )

      harness.keybindings['autocomplete:dismiss']?.()
      await waitFor(
        () => rendered.getSnapshot().suggestions.length === 0,
        'dismissed suggestions',
      )

      generateUnifiedSuggestionsMock.mockClear()
      harness.appState.mcp = {
        clients: [],
        resources: [{ name: 'docs' }],
      }
      harness.unifiedSuggestions = [
        {
          displayText: 'docs://latest',
          id: 'mcp-resource-docs-latest',
          description: 'resource',
        },
      ]
      rendered.rerender({ input: '@doc', cursorOffset: 4 })

      await waitFor(
        () => generateUnifiedSuggestionsMock.mock.calls.length > 0,
        'refetch after MCP resources change',
      )
      await waitFor(
        () =>
          rendered.getSnapshot().suggestionType === 'file' &&
          rendered.getSnapshot().suggestions[0]?.id ===
            'mcp-resource-docs-latest',
        'fresh MCP resource suggestions after dismissal',
      )
    } finally {
      await rendered.dispose()
    }
  })

  test('dismissed @ file suggestions stay dismissed on unrelated task changes', async () => {
    harness.unifiedSuggestions = [
      { id: 'doc-old.md', displayText: 'doc-old.md', description: 'file' },
    ]
    const rendered = await renderHookHarness({ input: '@doc', cursorOffset: 4 })

    try {
      await waitFor(
        () => rendered.getSnapshot().suggestionType === 'file',
        'initial file suggestions',
      )

      harness.keybindings['autocomplete:dismiss']?.()
      await waitFor(
        () => rendered.getSnapshot().suggestions.length === 0,
        'dismissed suggestions',
      )

      generateUnifiedSuggestionsMock.mockClear()
      harness.appState.tasks = {
        'agent-other': { status: 'running' },
      }
      rendered.rerender({ input: '@doc', cursorOffset: 4 })
      await sleep(25)

      expect(generateUnifiedSuggestionsMock).not.toHaveBeenCalled()
      expect(rendered.getSnapshot().suggestionType).toBe('none')
    } finally {
      await rendered.dispose()
    }
  })

  test('enter clears stale file suggestions after cursor leaves their source token', async () => {
    harness.unifiedSuggestions = [
      { id: 'src/app.ts', displayText: 'src/app.ts', description: 'file' },
    ]
    const onInputChange = vi.fn()
    const rendered = await renderHookHarness({
      cursorOffset: '@sr'.length,
      input: '@sr, note',
      onInputChange,
    })

    try {
      await waitFor(
        () => rendered.getSnapshot().suggestionType === 'file',
        'initial file suggestions',
      )

      rendered.rerender({
        cursorOffset: '@sr, note'.length,
        input: '@sr, note',
      })

      const enter = createKey('return')
      rendered.getSnapshot().handleKeyDown(enter)

      expect(enter.defaultPrevented).toBe(true)
      expect(onInputChange).not.toHaveBeenCalled()
      await waitFor(
        () => rendered.getSnapshot().suggestions.length === 0,
        'cleared stale file suggestions',
      )
    } finally {
      await rendered.dispose()
    }
  })

  test('tab clears stale file suggestions after cursor leaves their source token', async () => {
    harness.unifiedSuggestions = [
      { id: 'src/app.ts', displayText: 'src/app.ts', description: 'file' },
    ]
    const onInputChange = vi.fn()
    const rendered = await renderHookHarness({
      cursorOffset: '@sr'.length,
      input: '@sr, note',
      onInputChange,
    })

    try {
      await waitFor(
        () => rendered.getSnapshot().suggestionType === 'file',
        'initial file suggestions',
      )

      rendered.rerender({
        cursorOffset: '@sr, note'.length,
        input: '@sr, note',
      })

      harness.keybindings['autocomplete:accept']?.()

      expect(onInputChange).not.toHaveBeenCalled()
      expect(generateUnifiedSuggestionsMock.mock.calls.map(call => call[0])).toEqual(['sr'])
      await waitFor(
        () => rendered.getSnapshot().suggestions.length === 0,
        'cleared stale file suggestions',
      )
    } finally {
      await rendered.dispose()
    }
  })

  test('logs file suggestion provider failures and fails closed', async () => {
    const error = new Error('unified suggestions failed')
    generateUnifiedSuggestionsMock.mockRejectedValueOnce(error)
    const rendered = await renderHookHarness({ input: '@sr', cursorOffset: 3 })

    try {
      await waitFor(
        () => harness.logError.mock.calls.some(call => call[0] === error),
        'logged suggestion failure',
      )

      expect(rendered.getSnapshot().suggestionType).toBe('none')
      expect(rendered.getSnapshot().suggestions).toEqual([])
    } finally {
      await rendered.dispose()
    }
  })

  test('tab cycles active @ file suggestions instead of accepting one', async () => {
    harness.unifiedSuggestions = [
      { id: 'src/app.ts', displayText: 'src/app.ts', description: 'file' },
      { id: 'src/api.ts', displayText: 'src/api.ts', description: 'file' },
    ]
    const onInputChange = vi.fn()
    const setCursorOffset = vi.fn()
    const rendered = await renderHookHarness({
      input: '@sr',
      onInputChange,
      setCursorOffset,
    })

    try {
      await waitFor(
        () => rendered.getSnapshot().suggestionType === 'file',
        'file suggestions',
      )
      expect(rendered.getSnapshot().suggestionsState.selectedSuggestion).toBe(0)

      harness.keybindings['autocomplete:accept']?.()
      await waitFor(
        () => rendered.getSnapshot().suggestionsState.selectedSuggestion === 1,
        'cycled file suggestion',
      )
      expect(onInputChange).not.toHaveBeenCalled()
      expect(setCursorOffset).not.toHaveBeenCalled()

      harness.keybindings['autocomplete:accept']?.()
      await waitFor(
        () => rendered.getSnapshot().suggestionsState.selectedSuggestion === 0,
        'wrapped file suggestion cycle',
      )
    } finally {
      await rendered.dispose()
    }
  })

  test('enter applies quoted file suggestions from an @ token', async () => {
    harness.unifiedSuggestions = [
      {
        id: 'docs/release notes.md',
        displayText: 'docs/release notes.md',
        description: 'file',
      },
    ]
    const onInputChange = vi.fn()
    const setCursorOffset = vi.fn()
    const rendered = await renderHookHarness({
      input: '@docs',
      onInputChange,
      setCursorOffset,
    })

    try {
      await waitFor(
        () => rendered.getSnapshot().suggestionType === 'file',
        'file suggestion',
      )

      rendered.getSnapshot().handleKeyDown(createKey('return'))
      expect(onInputChange).toHaveBeenCalledWith('@"docs/release notes.md" ')
      expect(setCursorOffset).toHaveBeenCalledWith(
        '@"docs/release notes.md" '.length,
      )
      await waitFor(
        () => rendered.getSnapshot().suggestions.length === 0,
        'cleared file suggestion',
      )
    } finally {
      await rendered.dispose()
    }
  })

  test('autocomplete confirm keybinding applies file suggestions from an @ token', async () => {
    harness.unifiedSuggestions = [
      { id: 'src/app.ts', displayText: 'src/app.ts', description: 'file' },
    ]
    const onInputChange = vi.fn()
    const setCursorOffset = vi.fn()
    const rendered = await renderHookHarness({
      input: '@sr',
      onInputChange,
      setCursorOffset,
    })

    try {
      await waitFor(
        () => rendered.getSnapshot().suggestionType === 'file',
        'file suggestion',
      )

      harness.keybindings['autocomplete:confirm']?.()
      expect(onInputChange).toHaveBeenCalledWith('@src/app.ts ')
      expect(setCursorOffset).toHaveBeenCalledWith('@src/app.ts '.length)
      await waitFor(
        () => rendered.getSnapshot().suggestions.length === 0,
        'cleared file suggestion',
      )
    } finally {
      await rendered.dispose()
    }
  })

  test('line-feed enter applies file suggestions from an @ token', async () => {
    harness.unifiedSuggestions = [
      { id: 'src/app.ts', displayText: 'src/app.ts', description: 'file' },
    ]
    const onInputChange = vi.fn()
    const setCursorOffset = vi.fn()
    const rendered = await renderHookHarness({
      input: '@sr',
      onInputChange,
      setCursorOffset,
    })

    try {
      await waitFor(
        () => rendered.getSnapshot().suggestionType === 'file',
        'file suggestion',
      )

      rendered.getSnapshot().handleKeyDown(createKey('enter'))
      expect(onInputChange).toHaveBeenCalledWith('@src/app.ts ')
      expect(setCursorOffset).toHaveBeenCalledWith('@src/app.ts '.length)
      await waitFor(
        () => rendered.getSnapshot().suggestions.length === 0,
        'cleared file suggestion',
      )
    } finally {
      await rendered.dispose()
    }
  })

  test('enter applies general path directory suggestions outside slash commands', async () => {
    harness.directorySuggestions = [
      {
        displayText: '/tmp/project',
        id: '/tmp/project',
        metadata: { type: 'directory' },
      },
    ]
    const onInputChange = vi.fn()
    const setCursorOffset = vi.fn()
    const rendered = await renderHookHarness({
      input: '@/tm',
      onInputChange,
      setCursorOffset,
    })

    try {
      await waitFor(
        () => rendered.getSnapshot().suggestionType === 'directory',
        'path directory suggestions',
      )

      rendered.getSnapshot().handleKeyDown(createKey('return'))
      expect(onInputChange).toHaveBeenCalledWith('@/tmp/project/')
      expect(setCursorOffset).toHaveBeenCalledWith('@/tmp/project/'.length)
    } finally {
      await rendered.dispose()
    }
  })

  test('tab accepts command and custom title suggestions without submitting them', async () => {
    const onInputChange = vi.fn()
    const onSubmit = vi.fn()
    const setCursorOffset = vi.fn()
    const rendered = await renderHookHarness({
      commands: [command('help'), command('resume')],
      input: '/h',
      onInputChange,
      onSubmit,
      setCursorOffset,
    })

    try {
      await waitFor(
        () => rendered.getSnapshot().suggestionType === 'command',
        'command suggestions',
      )

      harness.keybindings['autocomplete:accept']?.()
      expect(onInputChange).toHaveBeenCalledWith('/help ')
      expect(setCursorOffset).toHaveBeenCalledWith('/help '.length)
      expect(onSubmit).not.toHaveBeenCalled()

      onInputChange.mockClear()
      setCursorOffset.mockClear()
      harness.sessionTitleMatches = [
        {
          customTitle: 'Sprint planning',
          messageCount: 12,
          modified: new Date('2026-05-20T00:00:00.000Z'),
          sessionId: 'session-42',
        },
      ]
      rendered.rerender({ input: '/resume Sprint', cursorOffset: '/resume Sprint'.length })
      await waitFor(
        () => rendered.getSnapshot().suggestionType === 'custom-title',
        'custom title suggestions',
      )

      harness.keybindings['autocomplete:accept']?.()
      expect(onInputChange).toHaveBeenCalledWith('/resume session-42')
      expect(setCursorOffset).toHaveBeenCalledWith('/resume session-42'.length)
      expect(onSubmit).not.toHaveBeenCalled()
    } finally {
      await rendered.dispose()
    }
  })

  test('tab accepts shell, teammate, and Slack suggestions', async () => {
    harness.shellCompletions = [
      {
        displayText: 'grep',
        id: 'grep',
        metadata: { completionType: 'command', inputSnapshot: 'g' },
      },
      {
        displayText: 'git',
        id: 'git',
        metadata: { completionType: 'command', inputSnapshot: 'g' },
      },
    ]
    const onInputChange = vi.fn()
    const setCursorOffset = vi.fn()
    const rendered = await renderHookHarness({
      input: 'g',
      mode: 'bash',
      onInputChange,
      setCursorOffset,
    })

    try {
      harness.keybindings['autocomplete:accept']?.()
      await waitFor(
        () => rendered.getSnapshot().suggestionType === 'shell',
        'shell suggestions',
      )

      harness.keybindings['autocomplete:accept']?.()
      expect(onInputChange).toHaveBeenCalledWith('grep ')
      expect(setCursorOffset).toHaveBeenCalledWith('grep '.length)

      onInputChange.mockClear()
      setCursorOffset.mockClear()
      harness.appState.teamContext = {
        teammates: {
          lead: { name: 'team-lead' },
        },
      }
      harness.appState.agentNameRegistry.set('Planner', 'agent-planner')
      harness.appState.tasks = {
        'agent-planner': { status: 'idle' },
      }
      rendered.rerender({ input: '@Pl', mode: 'prompt', cursorOffset: 3 })
      await waitFor(
        () => rendered.getSnapshot().suggestionType === 'agent',
        'agent suggestions',
      )

      harness.keybindings['autocomplete:accept']?.()
      expect(onInputChange).toHaveBeenCalledWith('@Planner ')
      expect(setCursorOffset).toHaveBeenCalledWith('@Planner '.length)

      onInputChange.mockClear()
      setCursorOffset.mockClear()
      harness.appState.teamContext = undefined
      harness.appState.agentNameRegistry = new Map()
      harness.appState.mcp = {
        clients: [{ name: 'slack' }],
        resources: [],
      }
      harness.slackSuggestions = [
        { displayText: '#general', id: 'slack-general', description: 'channel' },
      ]
      rendered.rerender({ input: '#gen', cursorOffset: 4 })
      await waitFor(
        () => rendered.getSnapshot().suggestionType === 'slack-channel',
        'slack channel suggestions',
      )

      harness.keybindings['autocomplete:accept']?.()
      expect(onInputChange).toHaveBeenCalledWith('#general ')
      expect(setCursorOffset).toHaveBeenCalledWith('#general '.length)
    } finally {
      await rendered.dispose()
    }
  })

  test('tab applies file suggestions as common prefixes and exact selections', async () => {
    harness.unifiedSuggestions = [
      {
        id: 'src/app.ts',
        displayText: 'src/app.ts',
        description: 'file',
      },
    ]
    const onInputChange = vi.fn()
    const setCursorOffset = vi.fn()
    const rendered = await renderHookHarness({
      input: '@sr',
      onInputChange,
      setCursorOffset,
    })

    try {
      await waitFor(
        () => rendered.getSnapshot().suggestionType === 'file',
        'file suggestions',
      )

      harness.keybindings['autocomplete:accept']?.()
      expect(onInputChange).toHaveBeenCalledWith('@src/app.ts')
      expect(setCursorOffset).toHaveBeenCalledWith('@src/app.ts'.length)

      onInputChange.mockClear()
      setCursorOffset.mockClear()
      rendered.rerender({ input: '@src/app.ts', cursorOffset: '@src/app.ts'.length })
      await waitFor(
        () => rendered.getSnapshot().suggestionType === 'file',
        'exact file suggestion',
      )

      harness.keybindings['autocomplete:accept']?.()
      expect(onInputChange).toHaveBeenCalledWith('@src/app.ts ')
      expect(setCursorOffset).toHaveBeenCalledWith('@src/app.ts '.length)
    } finally {
      await rendered.dispose()
    }
  })

  test('tab refreshes common-prefix file suggestions from the replaced token', async () => {
    harness.unifiedSuggestions = [
      {
        id: 'src/app.ts',
        displayText: 'src/app.ts',
        description: 'file',
      },
    ]
    const onInputChange = vi.fn()
    const setCursorOffset = vi.fn()
    const rendered = await renderHookHarness({
      input: '@sr some filler text @sr',
      onInputChange,
      setCursorOffset,
    })

    try {
      await waitFor(
        () => rendered.getSnapshot().suggestionType === 'file',
        'file suggestions',
      )

      generateUnifiedSuggestionsMock.mockClear()
      harness.keybindings['autocomplete:accept']?.()

      expect(onInputChange).toHaveBeenCalledWith(
        '@sr some filler text @src/app.ts',
      )
      expect(setCursorOffset).toHaveBeenCalledWith(
        '@sr some filler text @src/app.ts'.length,
      )
      await waitFor(
        () =>
          generateUnifiedSuggestionsMock.mock.calls.some(
            call => call[0] === 'src/app.ts',
          ),
        'common-prefix refresh uses replaced token',
      )
    } finally {
      await rendered.dispose()
    }
  })

  test('tab handles directory suggestions in command and general path contexts', async () => {
    harness.directorySuggestions = [
      {
        displayText: 'README.md',
        id: 'README.md',
        metadata: { type: 'file' },
      },
    ]
    const onInputChange = vi.fn()
    const setCursorOffset = vi.fn()
    const rendered = await renderHookHarness({
      input: '/add-dir R',
      onInputChange,
      setCursorOffset,
    })

    try {
      await waitFor(
        () => rendered.getSnapshot().suggestionType === 'directory',
        'command file suggestion',
      )

      harness.keybindings['autocomplete:accept']?.()
      expect(onInputChange).toHaveBeenCalledWith('/add-dir README.md ')
      expect(setCursorOffset).toHaveBeenCalledWith('/add-dir README.md '.length)

      onInputChange.mockClear()
      setCursorOffset.mockClear()
      harness.directorySuggestions = [
        {
          displayText: '/tmp/project',
          id: '/tmp/project',
          metadata: { type: 'directory' },
        },
      ]
      rendered.rerender({ input: '@/tm', cursorOffset: '@/tm'.length })
      await waitFor(
        () => rendered.getSnapshot().suggestionType === 'directory',
        'general path directory suggestion',
      )

      harness.keybindings['autocomplete:accept']?.()
      expect(onInputChange).toHaveBeenCalledWith('@/tmp/project/')
      expect(setCursorOffset).toHaveBeenCalledWith('@/tmp/project/'.length)

      onInputChange.mockClear()
      setCursorOffset.mockClear()
      rendered.rerender({ input: '/add-dir /tmp', cursorOffset: '/add-dir /tmp'.length })
      await waitFor(
        () => rendered.getSnapshot().suggestionType === 'directory',
        'enter clears command directory suggestion',
      )

      rendered.getSnapshot().handleKeyDown(createKey('return'))
      expect(onInputChange).not.toHaveBeenCalled()
      expect(setCursorOffset).not.toHaveBeenCalled()
    } finally {
      await rendered.dispose()
    }
  })
})
