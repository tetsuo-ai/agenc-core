import { PassThrough } from 'node:stream'

import React from 'react'
import { beforeEach, describe, expect, test, vi } from 'vitest'

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
  directorySuggestions: [] as unknown[],
  keybindings: {} as Record<string, () => unknown>,
  sessionTitleMatches: [] as unknown[],
  shellCompletions: [] as unknown[],
  shellHistoryCompletion: null as null | {
    fullCommand: string
    suffix: string
  },
  unifiedSuggestions: [] as unknown[],
  reset() {
    harness.addNotification.mockClear()
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
    harness.keybindings = {}
    harness.sessionTitleMatches = []
    harness.shellCompletions = []
    harness.shellHistoryCompletion = null
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

vi.mock('../../services/analytics/index.js', () => ({
  logEvent: vi.fn(),
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
  searchSessionsByCustomTitle: vi.fn(async () => harness.sessionTitleMatches),
}))

vi.mock('../../utils/suggestions/directoryCompletion.js', () => ({
  getDirectoryCompletions: vi.fn(async () => harness.directorySuggestions),
  getPathCompletions: vi.fn(async () => harness.directorySuggestions),
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
    markAccepted: vi.fn(),
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
})
