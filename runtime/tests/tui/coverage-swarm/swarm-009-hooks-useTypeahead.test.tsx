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
  pendingChord: null as null | string,
  sessionTitleMatches: [] as unknown[],
  shellCompletions: [] as unknown[],
  shellCompletionRejects: false,
  shellHistoryCompletion: null as null | {
    fullCommand: string
    suffix: string
  },
  slackSuggestions: [] as unknown[],
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
    harness.pendingChord = null
    harness.sessionTitleMatches = []
    harness.shellCompletions = []
    harness.shellCompletionRejects = false
    harness.shellHistoryCompletion = null
    harness.slackSuggestions = []
    harness.unifiedSuggestions = []
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

vi.mock('src/tui/context/notifications.js', () => ({
  useNotifications: () => ({ addNotification: harness.addNotification }),
}))

vi.mock('src/tui/context/overlayContext', () => ({
  useIsModalOverlayActive: () => false,
  useRegisterOverlay: vi.fn(),
}))

vi.mock('src/tui/ink.js', async () => {
  const ReactModule = await import('react')
  return {
    Text: ({ children }: { readonly children?: React.ReactNode }) =>
      ReactModule.createElement(ReactModule.Fragment, null, children),
    useInput: vi.fn(),
  }
})

vi.mock('src/tui/keybindings/KeybindingContext.js', () => ({
  useOptionalKeybindingContext: () => ({ pendingChord: harness.pendingChord }),
  useRegisterKeybindingContext: vi.fn(),
}))

vi.mock('src/tui/keybindings/useKeybinding.js', () => ({
  useKeybindings: (handlers: Record<string, () => unknown>) => {
    Object.assign(harness.keybindings, handlers)
  },
}))

vi.mock('src/tui/keybindings/useShortcutDisplay.js', () => ({
  useShortcutDisplay: () => 'alt+t',
}))

vi.mock('src/tui/state/AppState.js', () => ({
  useAppState: (selector: (state: typeof harness.appState) => unknown) =>
    selector(harness.appState),
  useAppStateStore: () => ({ getState: () => harness.appState }),
}))

vi.mock('src/utils/agentSwarmsEnabled', () => ({
  isAgentSwarmsEnabled: () => Boolean(harness.appState.teamContext),
}))

vi.mock('src/utils/bash/shellCompletion.js', () => ({
  getShellCompletions: vi.fn(async () => {
    if (harness.shellCompletionRejects) {
      throw new Error('completion failed')
    }
    return harness.shellCompletions
  }),
}))

vi.mock('src/utils/sessionStorage.js', () => ({
  getSessionIdFromLog: (log: { readonly sessionId?: string }) =>
    log.sessionId ?? 'session-1',
  searchSessionsByCustomTitle: vi.fn(async () => harness.sessionTitleMatches),
  writeAgentMetadata: vi.fn(async () => undefined),
}))

vi.mock('src/utils/suggestions/directoryCompletion.js', () => ({
  getDirectoryCompletions: vi.fn(async () => harness.directorySuggestions),
  getPathCompletions: vi.fn(async () => harness.directorySuggestions),
  isPathLikeToken: (token: string) =>
    token.startsWith('/') || token.startsWith('./') || token.startsWith('~/'),
}))

vi.mock('src/utils/suggestions/shellHistoryCompletion.js', () => ({
  getShellHistoryCompletion: vi.fn(async () => harness.shellHistoryCompletion),
}))

vi.mock('src/utils/suggestions/slackChannelSuggestions.js', () => ({
  getSlackChannelSuggestions: vi.fn(async () => harness.slackSuggestions),
  hasSlackMcpServer: () => harness.appState.mcp.clients.length > 0,
}))

vi.mock('src/utils/swarm/constants.js', () => ({
  TEAM_LEAD_NAME: 'team-lead',
}))

vi.mock('src/tui/hooks/fileSuggestions', () => ({
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

vi.mock('src/tui/hooks/unifiedSuggestions', () => ({
  generateUnifiedSuggestions: vi.fn(async () => harness.unifiedSuggestions),
}))

import { createRoot } from 'src/tui/ink/root.js'
import { KeyboardEvent } from 'src/tui/ink/events/keyboard-event.js'
import type { SuggestionItem } from 'src/tui/components/PromptInput/PromptInputFooterSuggestions.js'
import type { PromptInputMode } from 'src/types/textInputTypes.js'
import {
  applyDirectorySuggestion,
  applyShellSuggestion,
  formatReplacementValue,
  useTypeahead,
} from 'src/tui/hooks/useTypeahead.js'

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
  options: { ctrl?: boolean; meta?: boolean; shift?: boolean } = {},
): KeyboardEvent {
  return new KeyboardEvent({
    ctrl: options.ctrl ?? false,
    fn: false,
    isPasted: false,
    kind: 'key',
    meta: options.meta ?? false,
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
  readonly initialSuggestionsState?: SuggestionsState
  readonly input: string
  readonly markAccepted?: () => void
  readonly mode?: PromptInputMode
  readonly onInputChange: (value: string) => void
  readonly onModeChange?: (mode: PromptInputMode) => void
  readonly onSubmit?: (value: string, isSubmittingSlashCommand?: boolean) => void
  readonly setCursorOffset: (offset: number) => void
  readonly snapshot: (value: HookSnapshot) => void
  readonly suppressSuggestions?: boolean
}): React.ReactNode {
  const [suggestionsState, setSuggestionsState] = React.useState<SuggestionsState>(
    props.initialSuggestionsState ?? {
      commandArgumentHint: undefined,
      selectedSuggestion: -1,
      suggestions: [],
    },
  )
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
    suppressSuggestions: props.suppressSuggestions,
  })

  React.useEffect(() => {
    props.snapshot({ ...result, suggestionsState })
  })
  return null
}

async function renderHookHarness(props: {
  readonly commands?: readonly unknown[]
  readonly cursorOffset?: number
  readonly initialSuggestionsState?: SuggestionsState
  readonly input: string
  readonly markAccepted?: () => void
  readonly mode?: PromptInputMode
  readonly onInputChange?: (value: string) => void
  readonly onModeChange?: (mode: PromptInputMode) => void
  readonly onSubmit?: (value: string, isSubmittingSlashCommand?: boolean) => void
  readonly setCursorOffset?: (offset: number) => void
  readonly suppressSuggestions?: boolean
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

const command = (
  name: string,
  options: {
    aliases?: readonly string[]
    argNames?: readonly string[]
    argumentHint?: string
    isHidden?: boolean
  } = {},
) => ({
  aliases: options.aliases ?? [],
  argNames: options.argNames,
  argumentHint: options.argumentHint,
  description: `${name} command`,
  isHidden: options.isHidden ?? false,
  name,
  type: 'prompt',
})

describe('useTypeahead coverage swarm row 009', () => {
  beforeEach(() => {
    harness.reset()
  })

  test('formats and applies exported completion helpers', () => {
    expect(
      formatReplacementValue({
        displayText: 'docs/read me.md',
        hasAtPrefix: false,
        isComplete: true,
        mode: 'prompt',
        needsQuotes: true,
      }),
    ).toBe('@"docs/read me.md" ')
    expect(
      formatReplacementValue({
        displayText: 'HOME',
        hasAtPrefix: true,
        isComplete: true,
        mode: 'bash',
        needsQuotes: false,
      }),
    ).toBe('HOME ')
    expect(
      formatReplacementValue({
        displayText: 'plain',
        hasAtPrefix: false,
        isComplete: false,
        mode: 'prompt',
        needsQuotes: false,
      }),
    ).toBe('plain')

    const onInputChange = vi.fn()
    const setCursorOffset = vi.fn()
    applyShellSuggestion(
      { displayText: 'PATH', id: 'path' } as SuggestionItem,
      'echo $PA && done',
      'echo $PA'.length,
      onInputChange,
      setCursorOffset,
      'variable',
    )
    expect(onInputChange).toHaveBeenCalledWith('echo $PATH  && done')
    expect(setCursorOffset).toHaveBeenCalledWith('echo $PATH '.length)

    onInputChange.mockClear()
    setCursorOffset.mockClear()
    applyShellSuggestion(
      { displayText: 'grep', id: 'grep' } as SuggestionItem,
      'gr file.txt',
      2,
      onInputChange,
      setCursorOffset,
      'command',
    )
    expect(onInputChange).toHaveBeenCalledWith('grep  file.txt')
    expect(setCursorOffset).toHaveBeenCalledWith('grep '.length)

    expect(applyDirectorySuggestion('open @/tm now', '/tmp', 5, 4, true)).toEqual({
      cursorPos: 'open @/tmp/'.length,
      newInput: 'open @/tmp/ now',
    })
    expect(applyDirectorySuggestion('@read', 'README.md', 0, 5, false)).toEqual({
      cursorPos: '@README.md '.length,
      newInput: '@README.md ',
    })
  })

  test('suppresses and clears an existing autocomplete state', async () => {
    const rendered = await renderHookHarness({
      initialSuggestionsState: {
        commandArgumentHint: '<old>',
        selectedSuggestion: 1,
        suggestions: [
          { displayText: 'old', id: 'old' },
        ] as SuggestionItem[],
      },
      input: '@old',
      suppressSuggestions: true,
    })

    try {
      await waitFor(
        () => rendered.getSnapshot().suggestionsState.suggestions.length === 0,
        'suppressed suggestions cleared',
      )
      expect(rendered.getSnapshot().suggestionsState).toEqual({
        commandArgumentHint: undefined,
        selectedSuggestion: -1,
        suggestions: [],
      })
      expect(rendered.getSnapshot().suggestionType).toBe('none')
    } finally {
      await rendered.dispose()
    }
  })

  test('shows progressive command argument hints and clears stale hints once arguments start', async () => {
    const rendered = await renderHookHarness({
      commands: [command('launch', { argNames: ['target', 'mode'] })],
      input: '/launch ',
    })

    try {
      await waitFor(
        () => rendered.getSnapshot().commandArgumentHint === '[target] [mode]',
        'progressive command argument hint',
      )
      expect(rendered.getSnapshot().suggestions).toEqual([])

      rendered.rerender({
        cursorOffset: '/launch target'.length - 2,
        input: '/launch target',
      })
      await waitFor(
        () => rendered.getSnapshot().commandArgumentHint === undefined,
        'stale command argument hint cleared',
      )
      expect(rendered.getSnapshot().suggestions).toEqual([])
    } finally {
      await rendered.dispose()
    }
  })

  test('clears stale command, title, Slack, file, and shell suggestions', async () => {
    harness.unifiedSuggestions = [
      { displayText: 'src/app.ts', id: 'src/app.ts' },
    ]
    const rendered = await renderHookHarness({
      commands: [command('help'), command('resume')],
      input: '/h',
    })

    try {
      await waitFor(
        () => rendered.getSnapshot().suggestionType === 'command',
        'command suggestions',
      )
      rendered.rerender({ cursorOffset: 'plain text'.length, input: 'plain text' })
      await waitFor(
        () => rendered.getSnapshot().suggestionType === 'none',
        'stale command suggestions cleared',
      )

      rendered.rerender({
        cursorOffset: '/resume missing'.length,
        input: '/resume missing',
      })
      await sleep(25)
      expect(rendered.getSnapshot().suggestionType).toBe('none')
      expect(rendered.getSnapshot().suggestions).toEqual([])

      harness.sessionTitleMatches = [
        {
          customTitle: 'Planning notes',
          messageCount: 4,
          modified: new Date('2026-05-20T00:00:00.000Z'),
          sessionId: 'session-9',
        },
      ]
      rendered.rerender({
        cursorOffset: '/resume plan'.length,
        input: '/resume plan',
      })
      await waitFor(
        () => rendered.getSnapshot().suggestionType === 'custom-title',
        'custom title suggestions',
      )
      harness.sessionTitleMatches = []
      rendered.rerender({ cursorOffset: 'not resume'.length, input: 'not resume' })
      await waitFor(
        () => rendered.getSnapshot().suggestionType === 'none',
        'stale custom title suggestions cleared',
      )

      harness.appState.mcp = { clients: [{ name: 'slack' }], resources: [] }
      harness.slackSuggestions = [
        { displayText: '#general', id: 'slack-general' },
      ]
      rendered.rerender({ cursorOffset: '#gen'.length, input: '#gen' })
      await waitFor(
        () => rendered.getSnapshot().suggestionType === 'slack-channel',
        'Slack channel suggestions',
      )
      rendered.rerender({ cursorOffset: 'plain'.length, input: 'plain' })
      await waitFor(
        () => rendered.getSnapshot().suggestionType === 'none',
        'stale Slack suggestions cleared',
      )

      harness.appState.mcp = { clients: [], resources: [] }
      rendered.rerender({ cursorOffset: '@sr'.length, input: '@sr' })
      await waitFor(
        () => rendered.getSnapshot().suggestionType === 'file',
        'file suggestions',
      )
      rendered.rerender({ cursorOffset: 'plain '.length, input: 'plain ' })
      await waitFor(
        () => rendered.getSnapshot().suggestionType === 'none',
        'stale file suggestions cleared',
      )

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
      rendered.rerender({ cursorOffset: 'g'.length, input: 'g', mode: 'bash' })
      harness.keybindings['autocomplete:accept']?.()
      await waitFor(
        () => rendered.getSnapshot().suggestionType === 'shell',
        'shell suggestions',
      )
      rendered.rerender({ cursorOffset: 'go'.length, input: 'go', mode: 'bash' })
      await waitFor(
        () => rendered.getSnapshot().suggestionType === 'none',
        'stale shell suggestions cleared',
      )
    } finally {
      await rendered.dispose()
    }
  })

  test('handles keyboard navigation branches and prompt suggestion tab acceptance', async () => {
    harness.unifiedSuggestions = [
      { displayText: 'src/app.ts', id: 'src/app.ts' },
      { displayText: 'src/api.ts', id: 'src/api.ts' },
    ]
    const markAccepted = vi.fn()
    const onInputChange = vi.fn()
    const setCursorOffset = vi.fn()
    const rendered = await renderHookHarness({
      input: '@sr',
      markAccepted,
      onInputChange,
      setCursorOffset,
    })

    try {
      await waitFor(
        () => rendered.getSnapshot().suggestions.length === 2,
        'file suggestions for key navigation',
      )

      const ctrlN = createKey('n', { ctrl: true })
      rendered.getSnapshot().handleKeyDown(ctrlN)
      expect(ctrlN.defaultPrevented).toBe(true)
      await waitFor(
        () => rendered.getSnapshot().suggestionsState.selectedSuggestion === 1,
        'ctrl-n selected next item',
      )

      const ctrlP = createKey('p', { ctrl: true })
      rendered.getSnapshot().handleKeyDown(ctrlP)
      expect(ctrlP.defaultPrevented).toBe(true)
      await waitFor(
        () => rendered.getSnapshot().suggestionsState.selectedSuggestion === 0,
        'ctrl-p selected previous item',
      )

      harness.pendingChord = 'ctrl+x'
      rendered.rerender({ input: '@sr', cursorOffset: '@sr'.length })
      const blockedCtrlN = createKey('n', { ctrl: true })
      rendered.getSnapshot().handleKeyDown(blockedCtrlN)
      expect(blockedCtrlN.defaultPrevented).toBe(false)

      harness.pendingChord = null
      harness.appState.promptSuggestion = {
        acceptedAt: 0,
        generationRequestId: null,
        promptId: 'prompt-1',
        shownAt: Date.now(),
        text: 'accepted text',
      }
      rendered.rerender({ input: '', cursorOffset: 0 })
      await waitFor(
        () => rendered.getSnapshot().suggestions.length === 0,
        'suggestions cleared before prompt suggestion tab',
      )
      const tab = createKey('tab')
      rendered.getSnapshot().handleKeyDown(tab)
      expect(tab.defaultPrevented).toBe(true)
      expect(markAccepted).toHaveBeenCalled()
      expect(onInputChange).toHaveBeenCalledWith('accepted text')
      expect(setCursorOffset).toHaveBeenCalledWith('accepted text'.length)

      const shiftTab = createKey('tab', { shift: true })
      rendered.getSnapshot().handleKeyDown(shiftTab)
      expect(shiftTab.defaultPrevented).toBe(false)
    } finally {
      await rendered.dispose()
    }
  })

  test('suppresses bash completion failures', async () => {
    harness.shellCompletionRejects = true
    const rendered = await renderHookHarness({
      input: 'g',
      mode: 'bash',
    })

    try {
      harness.keybindings['autocomplete:accept']?.()
      await sleep(50)
      expect(rendered.getSnapshot().suggestions).toEqual([])
    } finally {
      await rendered.dispose()
    }
  })

  test('runs bash shell completion from raw tab when the picker is empty', async () => {
    harness.shellCompletions = [
      {
        displayText: 'git',
        id: 'git',
        metadata: { completionType: 'command' },
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
      const tab = createKey('tab')
      rendered.getSnapshot().handleKeyDown(tab)

      expect(tab.defaultPrevented).toBe(true)
      await waitFor(
        () => onInputChange.mock.calls.length === 1,
        'raw tab shell completion',
      )
      expect(onInputChange).toHaveBeenCalledWith('git ')
      expect(setCursorOffset).toHaveBeenCalledWith('git '.length)
      expect(harness.addNotification).not.toHaveBeenCalled()
    } finally {
      await rendered.dispose()
    }
  })
})
