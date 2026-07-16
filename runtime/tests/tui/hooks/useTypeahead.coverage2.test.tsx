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
  keybindings: {} as Record<string, () => unknown>,
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
    harness.keybindings = {}
  },
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
  getShellCompletions: vi.fn(async () => []),
}))

vi.mock('../../utils/sessionStorage.js', () => ({
  getSessionIdFromLog: (log: { readonly sessionId?: string }) =>
    log.sessionId ?? 'session-1',
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
  findLongestCommonPrefix: (items: readonly { readonly displayText: string }[]) =>
    items[0]?.displayText ?? '',
  onIndexBuildComplete: () => () => {},
  startBackgroundCacheRefresh: vi.fn(),
}))

vi.mock('./unifiedSuggestions', () => ({
  generateUnifiedSuggestions: vi.fn(async () => []),
}))

import { createRoot } from '../ink/root.js'
import type { SuggestionItem } from '../components/PromptInput/PromptInputFooterSuggestions.js'
import { useTypeahead } from './useTypeahead.js'

type SuggestionsState = {
  commandArgumentHint?: string
  selectedSuggestion: number
  suggestions: SuggestionItem[]
}

type HookSnapshot = ReturnType<typeof useTypeahead> & {
  suggestionsState: SuggestionsState
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
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
  readonly commands: readonly unknown[]
  readonly input: string
  readonly onInputChange: (value: string) => void
  readonly onSubmit: (value: string, isSubmittingSlashCommand?: boolean) => void
  readonly setCursorOffset: (offset: number) => void
  readonly snapshot: (value: HookSnapshot) => void
}): React.ReactNode {
  const [suggestionsState, setSuggestionsState] = React.useState<SuggestionsState>({
    commandArgumentHint: undefined,
    selectedSuggestion: -1,
    suggestions: [],
  })
  const result = useTypeahead({
    agents: [],
    commands: props.commands as never[],
    cursorOffset: props.input.length,
    input: props.input,
    markAccepted: vi.fn(),
    mode: 'prompt',
    onInputChange: props.onInputChange,
    onSubmit: props.onSubmit,
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
  readonly commands: readonly unknown[]
  readonly input: string
  readonly onInputChange: (value: string) => void
  readonly onSubmit: (value: string, isSubmittingSlashCommand?: boolean) => void
  readonly setCursorOffset: (offset: number) => void
}): Promise<{
  dispose: () => Promise<void>
  getSnapshot: () => HookSnapshot
}> {
  const { stdin, stdout } = createTestStreams()
  let snapshot: HookSnapshot | undefined
  const root = await createRoot({
    patchConsole: false,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  })
  root.render(
    <TypeaheadHarness
      {...props}
      snapshot={value => {
        snapshot = value
      }}
    />,
  )
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

const command = (name: string) => ({
  aliases: [],
  description: `${name} command`,
  isHidden: false,
  name,
  type: 'prompt',
})

describe('useTypeahead coverage gaps', () => {
  beforeEach(() => {
    harness.reset()
  })

  test('accepts mid-input slash command ghost text with autocomplete accept', async () => {
    const onInputChange = vi.fn()
    const onSubmit = vi.fn()
    const setCursorOffset = vi.fn()
    const rendered = await renderHookHarness({
      commands: [command('help')],
      input: 'ask /he',
      onInputChange,
      onSubmit,
      setCursorOffset,
    })

    try {
      await waitFor(
        () => rendered.getSnapshot().inlineGhostText?.fullCommand === 'help',
        'mid-input slash ghost text',
      )
      expect(rendered.getSnapshot().inlineGhostText).toEqual(
        expect.objectContaining({
          fullCommand: 'help',
          insertPosition: 'ask /he'.length,
          text: 'lp',
        }),
      )

      harness.keybindings['autocomplete:accept']?.()

      expect(onInputChange).toHaveBeenCalledWith('ask /help ')
      expect(setCursorOffset).toHaveBeenCalledWith('ask /help '.length)
      expect(onSubmit).not.toHaveBeenCalled()
    } finally {
      await rendered.dispose()
    }
  })
})
