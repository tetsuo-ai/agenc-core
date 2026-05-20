import { PassThrough } from 'node:stream'

import React from 'react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { PastedContent } from '../../../utils/config.js'

const harness = vi.hoisted(() => {
  const appState = {
    coordinatorTaskIndex: -1,
    effortValue: undefined,
    expandedView: 'transcript',
    fastMode: false,
    footerSelection: null as null | 'tasks' | 'teams',
    isBriefOnly: false,
    mainLoopModel: 'gpt-5.4',
    mainLoopModelForSession: null,
    mcp: { clients: [] },
    promptSuggestion: {
      acceptedAt: 0,
      generationRequestId: null,
      promptId: null,
      shownAt: 0,
      text: null,
    },
    speculation: { status: 'inactive' },
    speculationSessionTimeSavedMs: 0,
    tasks: {},
    teamContext: undefined,
    thinkingEnabled: true,
    toolPermissionContext: {
      isAutoModeAvailable: true,
      isBypassPermissionsModeAvailable: true,
      mode: 'default',
    },
    viewingAgentTaskId: null,
    viewSelectionMode: null,
  }

  return {
    addNotification: vi.fn(),
    appState,
    baseProps: undefined as undefined | Record<string, unknown>,
    clearBuffer: vi.fn(),
    editPromptResult: { content: null, error: null } as {
      content: string | null
      error: string | null
    },
    keybindings: {} as Record<string, () => unknown>,
    inputHandlers: [] as Array<{
      handler: (input: string, key: Record<string, boolean>, event?: unknown) => unknown
      options?: Record<string, unknown>
    }>,
    logEvent: vi.fn(),
    promptSuggestionLogEvent: vi.fn(),
    processBashCommand: vi.fn(async () => ({
      messages: [],
    })),
    onRender: vi.fn(),
    pushToBuffer: vi.fn(),
    removeNotification: vi.fn(),
    updateSettingsForSource: vi.fn(),
    fastMode: {
      available: false,
      cooldown: false,
      enabled: false,
      runtimeState: { status: 'available' },
      supportedByModel: true,
      unavailableReason: null as string | null,
    },
    reset: () => {
      harness.addNotification.mockClear()
      harness.clearBuffer.mockClear()
      harness.logEvent.mockClear()
      harness.promptSuggestionLogEvent.mockClear()
      harness.processBashCommand.mockReset()
      harness.processBashCommand.mockResolvedValue({
        messages: [],
      })
      harness.onRender.mockClear()
      harness.pushToBuffer.mockClear()
      harness.removeNotification.mockClear()
      harness.baseProps = undefined
      harness.editPromptResult = { content: null, error: null }
      harness.keybindings = {}
      harness.inputHandlers = []
      appState.coordinatorTaskIndex = -1
      appState.footerSelection = null
      appState.promptSuggestion = {
        acceptedAt: 0,
        generationRequestId: null,
        promptId: null,
        shownAt: 0,
        text: null,
      }
      appState.speculation = { status: 'inactive' }
      appState.speculationSessionTimeSavedMs = 0
      appState.viewingAgentTaskId = null
      appState.viewSelectionMode = null
      harness.updateSettingsForSource.mockClear()
      harness.fastMode = {
        available: false,
        cooldown: false,
        enabled: false,
        runtimeState: { status: 'available' },
        supportedByModel: true,
        unavailableReason: null,
      }
    },
    setAppState: vi.fn((updater: unknown) => {
      const next =
        typeof updater === 'function'
          ? (updater as (prev: typeof appState) => typeof appState)(appState)
          : updater
      Object.assign(appState, next)
    }),
    setPastedContents: vi.fn(),
    undo: vi.fn(),
  }
})

vi.mock('bun:bundle', () => ({
  feature: () => false,
}))

vi.mock('../../../services/analytics/index.js', () => ({
  logEvent: harness.logEvent,
}))

vi.mock('../../../services/analytics/growthbook.js', () => ({
  getFeatureValue_CACHED_MAY_BE_STALE: () => null,
}))

vi.mock('../../../services/PromptSuggestion/promptSuggestion.js', () => ({
  abortPromptSuggestion: vi.fn(),
  logSuggestionSuppressed: vi.fn(),
}))

vi.mock('../../../services/PromptSuggestion/runtime.js', () => ({
  logEvent: harness.promptSuggestionLogEvent,
}))

vi.mock('../../../services/PromptSuggestion/speculation.js', () => ({
  abortSpeculation: vi.fn(),
}))

vi.mock('../../context/notifications.js', () => ({
  useNotifications: () => ({
    addNotification: harness.addNotification,
    removeNotification: harness.removeNotification,
  }),
}))

vi.mock('../../context/overlayContext.js', () => ({
  useIsModalOverlayActive: () => false,
  useRegisterOverlay: vi.fn(),
}))

vi.mock('../../context/promptOverlayContext.js', () => ({
  useSetPromptOverlayDialog: vi.fn(),
}))

vi.mock('../../hooks/useCommandQueue.js', () => ({
  useCommandQueue: () => [],
}))

vi.mock('../../hooks/useIdeAtMentioned.js', () => ({
  useIdeAtMentioned: vi.fn(),
}))

vi.mock('../../hooks/useArrowKeyHistory.js', () => ({
  useArrowKeyHistory: () => ({
    dismissSearchHint: vi.fn(),
    historyIndex: 0,
    onHistoryDown: vi.fn(() => false),
    onHistoryUp: vi.fn(),
    resetHistory: vi.fn(),
  }),
}))

vi.mock('../../hooks/useDoublePress.js', () => ({
  useDoublePress: (_single: () => void, doublePress: () => void) => doublePress,
}))

vi.mock('../../hooks/useHistorySearch.js', () => ({
  useHistorySearch: () => ({
    historyFailedMatch: false,
    historyMatch: null,
    historyQuery: '',
    setHistoryQuery: vi.fn(),
  }),
}))

vi.mock('../../hooks/useInputBuffer.js', () => ({
  useInputBuffer: () => ({
    canUndo: false,
    clearBuffer: harness.clearBuffer,
    pushToBuffer: harness.pushToBuffer,
    undo: harness.undo,
  }),
}))

vi.mock('../../hooks/useMainLoopModel.js', () => ({
  useMainLoopModel: () => 'gpt-5.4',
}))

vi.mock('../../hooks/useTerminalSize.js', () => ({
  useTerminalSize: () => ({ columns: 100, rows: 30 }),
}))

vi.mock('../../hooks/useTypeahead.js', () => ({
  useTypeahead: () => ({
    commandArgumentHint: undefined,
    inlineGhostText: undefined,
    maxColumnWidth: 0,
    selectedSuggestion: -1,
    suggestionType: undefined,
    suggestions: [],
  }),
}))

vi.mock('../../ink/hooks/use-terminal-focus.js', () => ({
  useTerminalFocus: () => true,
}))

vi.mock('../../ink.js', async () => {
  const ReactModule = await import('react')
  return {
    Box: ({ children }: { readonly children?: React.ReactNode }) =>
      ReactModule.createElement(ReactModule.Fragment, null, children),
    Text: ({ children }: { readonly children?: React.ReactNode }) =>
      ReactModule.createElement(ReactModule.Fragment, null, children),
    useInput: (
      handler: (input: string, key: Record<string, boolean>, event?: unknown) => unknown,
      options?: Record<string, unknown>,
    ) => {
      harness.inputHandlers.push({ handler, options })
    },
  }
})

vi.mock('../../keybindings/KeybindingContext.js', () => ({
  useOptionalKeybindingContext: () => null,
}))

vi.mock('../../keybindings/shortcutFormat.js', () => ({
  getShortcutDisplay: () => 'ctrl+v',
}))

vi.mock('../../keybindings/useKeybinding.js', () => ({
  useKeybinding: (action: string, handler: () => unknown) => {
    harness.keybindings[action] = handler
  },
  useKeybindings: (handlers: Record<string, () => unknown>) => {
    Object.assign(harness.keybindings, handlers)
  },
}))

vi.mock('../../glyphs.js', () => ({
  selectAgenCTuiGlyphs: () => ({ horizontal: '-' }),
}))

vi.mock('../../state/AppState.js', () => ({
  useAppState: (selector: (state: typeof harness.appState) => unknown) =>
    selector(harness.appState),
  useAppStateStore: () => ({ getState: () => harness.appState }),
  useSetAppState: () => harness.setAppState,
}))

vi.mock('../../state/selectors.js', () => ({
  getActiveAgentForInput: () => ({ type: 'leader' }),
  getViewedTeammateTask: () => undefined,
}))

vi.mock('../../state/teammateViewHelpers.js', () => ({
  enterTeammateView: vi.fn(),
  exitTeammateView: vi.fn(),
  stopOrDismissAgent: vi.fn(),
}))

vi.mock('../../../commands.js', () => ({
  hasCommand: () => false,
}))

vi.mock('../../../tasks/InProcessTeammateTask/InProcessTeammateTask.js', () => ({
  getRunningTeammatesSorted: () => [],
}))

vi.mock('../../../tasks/types.js', () => ({
  isBackgroundTask: () => false,
}))

vi.mock('../../../tools/AgentTool/agentColorManager.js', () => ({
  AGENT_COLORS: ['cyan', 'purple'],
  AGENT_COLOR_TO_THEME_COLOR: { cyan: 'accent', purple: 'secondary' },
}))

vi.mock('../../../utils/agentSwarmsEnabled.js', () => ({
  isAgentSwarmsEnabled: () => false,
}))

vi.mock('../../../utils/array.js', () => ({
  count: (values: readonly unknown[], predicate: (value: unknown) => boolean) =>
    values.filter(predicate).length,
}))

vi.mock('../../../utils/config.js', () => ({
  getGlobalConfig: () => ({}),
  saveGlobalConfig: vi.fn(),
}))

vi.mock('../../../utils/cwd.js', () => ({
  getCwd: () => '/repo',
}))

vi.mock('../../../utils/debug.js', () => ({
  logForDebugging: vi.fn(),
}))

vi.mock('../../../utils/directMemberMessage.js', () => ({
  parseDirectMemberMessage: () => null,
  sendDirectMemberMessage: vi.fn(),
}))

vi.mock('../../../utils/dragDropPaths.js', () => ({
  extractDraggedFilePaths: (value: string) =>
    value.startsWith('/dragged/file') ? [value.trim()] : [],
}))

vi.mock('../../../utils/env.js', () => ({
  env: {
    isSSH: () => false,
    terminal: undefined,
  },
}))

vi.mock('../../../utils/errors.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../utils/errors.js')>()
  return {
    ...actual,
    errorMessage: (value: unknown) => String(value),
  }
})

vi.mock('../../../utils/extraUsage.js', () => ({
  isBilledAsExtraUsage: () => false,
}))

vi.mock('../../../utils/fastMode.js', () => ({
  FAST_MODE_MODEL_DISPLAY: 'fast-model',
  clearFastModeCooldown: vi.fn(),
  getFastModeModel: () => 'fast-model',
  getFastModeRuntimeState: () => harness.fastMode.runtimeState,
  getFastModeUnavailableReason: () => harness.fastMode.unavailableReason,
  isFastModeAvailable: () => harness.fastMode.available,
  isFastModeCooldown: () => harness.fastMode.cooldown,
  isFastModeEnabled: () => harness.fastMode.enabled,
  isFastModeSupportedByModel: () => harness.fastMode.supportedByModel,
}))

vi.mock('../../../utils/fullscreen.js', () => ({
  isFullscreenEnvEnabled: () => false,
}))

vi.mock('../../../utils/imagePaste.js', () => ({
  PASTE_THRESHOLD: 20,
  getImageFromClipboard: vi.fn(async () => null),
}))

vi.mock('../../../utils/imageStore.js', () => ({
  cacheImagePath: vi.fn(),
  storeImage: vi.fn(),
}))

vi.mock('../../../utils/keyboardShortcuts.js', () => ({
  MACOS_OPTION_SPECIAL_CHARS: {},
  isMacosOptionChar: () => false,
}))

vi.mock('../../../utils/log.js', () => ({
  logError: vi.fn(),
}))

vi.mock('../../../utils/model/model.js', () => ({
  isOpus1mMergeEnabled: () => false,
  modelDisplayString: (model: string | null) => model ?? 'default',
}))

vi.mock('../../../utils/permissions/autoModeState.js', () => ({
  setAutoModeActive: vi.fn(),
}))

vi.mock('../../../utils/permissions/getNextPermissionMode.js', () => ({
  cyclePermissionMode: (context: unknown) => ({ context }),
  getNextPermissionMode: () => 'plan',
}))

vi.mock('../../../utils/permissions/permissionSetup.js', () => ({
  transitionPermissionMode: (_from: unknown, _to: unknown, context: unknown) => context,
}))

vi.mock('../../../utils/platform.js', () => ({
  getPlatform: () => 'linux',
}))

vi.mock('../../../utils/promptEditor.js', () => ({
  editPromptInEditor: vi.fn(async () => harness.editPromptResult),
}))

vi.mock('../../input/processBashCommand.js', () => ({
  processBashCommand: harness.processBashCommand,
}))

vi.mock('../../../utils/settings/settings.js', () => ({
  hasAutoModeOptIn: () => true,
  updateSettingsForSource: harness.updateSettingsForSource,
}))

vi.mock('../../../utils/suggestions/commandSuggestions.js', () => ({
  findSlashCommandPositions: () => [],
}))

vi.mock('../../../utils/suggestions/slackChannelSuggestions.js', () => ({
  findSlackChannelPositions: () => [],
  getKnownChannelsVersion: () => 0,
  hasSlackMcpServer: () => false,
  subscribeKnownChannels: () => () => {},
}))

vi.mock('../../../utils/swarm/backends/registry.js', () => ({
  isInProcessEnabled: () => false,
}))

vi.mock('../../../utils/swarm/teamHelpers.js', () => ({
  syncTeammateMode: vi.fn(),
}))

vi.mock('../../../utils/teammate.js', () => ({
  getTeammateColor: () => undefined,
}))

vi.mock('../../../utils/teammateContext.js', () => ({
  isInProcessTeammate: () => false,
}))

vi.mock('../../../utils/teammateMailbox.js', () => ({
  writeToMailbox: vi.fn(),
}))

vi.mock('../../../utils/thinking.js', () => ({
  findThinkingTriggerPositions: () => [],
  getRainbowColor: () => 'suggestion',
  isUltrathinkEnabled: () => false,
}))

vi.mock('../../../conversation/token-budget.js', () => ({
  findTokenBudgetPositions: () => [],
}))

vi.mock('../AutoModeOptInDialog.js', () => ({
  AutoModeOptInDialog: () => null,
}))

vi.mock('../ConfigurableShortcutHint.js', () => ({
  ConfigurableShortcutHint: () => null,
}))

vi.mock('../CoordinatorAgentStatus.js', () => ({
  getVisibleAgentTasks: () => [],
  useCoordinatorTaskCount: () => 0,
}))

vi.mock('../EffortIndicator.js', () => ({
  getEffortNotificationText: () => undefined,
}))

vi.mock('../FastIcon.js', () => ({
  getFastIconString: () => 'FAST',
}))

vi.mock('../FullscreenLayout.js', () => ({
  calculateFullscreenLayoutBudget: (rows: number) => ({
    bottomMaxHeight: Math.max(1, Math.floor(rows / 2)),
  }),
}))

vi.mock('../GlobalSearchDialog.js', () => ({
  GlobalSearchDialog: () => null,
}))

vi.mock('../../history/HistorySearchDialog.js', () => ({
  HistorySearchDialog: () => null,
}))

vi.mock('../ModelPicker.js', () => ({
  ModelPicker: () => null,
}))

vi.mock('../QuickOpenDialog.js', () => ({
  QuickOpenDialog: () => null,
}))

vi.mock('../ThinkingToggle.js', () => ({
  ThinkingToggle: () => null,
}))

vi.mock('../tasks/BackgroundTasksPanel.js', () => ({
  BackgroundTasksPanel: () => null,
}))

vi.mock('../tasks/taskStatusUtils.js', () => ({
  shouldHideTasksFooter: () => false,
}))

vi.mock('../teams/TeamsDialog.js', () => ({
  TeamsDialog: () => null,
}))

vi.mock('../v2/primitives.js', () => ({
  ModeSwitcher: () => null,
}))

vi.mock('./ConfiguredPromptTextInput.js', async () => {
  const ReactModule = await import('react')
  return {
    ConfiguredPromptTextInput: ({
      baseProps,
    }: {
      readonly baseProps: Record<string, unknown>
    }) => {
      harness.baseProps = baseProps
      harness.onRender()
      return ReactModule.createElement(ReactModule.Fragment)
    },
  }
})

vi.mock('./Notifications.js', () => ({
  FOOTER_TEMPORARY_STATUS_TIMEOUT: 3000,
  Notifications: () => null,
}))

vi.mock('./PromptInputFooter.js', () => ({
  default: () => null,
}))

vi.mock('./PromptInputModeIndicator.js', () => ({
  PromptInputModeIndicator: () => null,
}))

vi.mock('./PromptInputQueuedCommands.js', () => ({
  PromptInputQueuedCommands: () => null,
}))

vi.mock('./PromptInputStashNotice.js', () => ({
  PromptInputStashNotice: () => null,
}))

vi.mock('./useMaybeTruncateInput.js', () => ({
  useMaybeTruncateInput: vi.fn(),
}))

vi.mock('./usePromptInputPlaceholder.js', () => ({
  usePromptInputPlaceholder: () => 'Type a prompt',
}))

vi.mock('./useShowFastIconHint.js', () => ({
  useShowFastIconHint: () => false,
}))

vi.mock('./useSwarmBanner.js', () => ({
  useSwarmBanner: () => null,
}))

vi.mock('./utils.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./utils.js')>()
  return {
    ...actual,
    isVimModeEnabled: () => false,
  }
})

import { createRoot } from '../../ink/root.js'
import { getImageFromClipboard } from '../../../utils/imagePaste.js'
import { cacheImagePath, storeImage } from '../../../utils/imageStore.js'
import PromptInput from './PromptInput.js'

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
  ;(stdout as unknown as { columns: number }).columns = 120
  ;(stdout as unknown as { rows: number }).rows = 30
  stdout.resume()

  return { stdin, stdout }
}

async function waitForPromptInputProps(): Promise<Record<string, unknown>> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < 1000) {
    if (harness.baseProps) return harness.baseProps
    await sleep(10)
  }
  throw new Error('PromptInput base props were not captured')
}

async function waitForInputHandlerCount(count: number): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < 1000) {
    if (harness.inputHandlers.length >= count) return
    await sleep(10)
  }
  throw new Error(`Expected at least ${count} input handlers, got ${harness.inputHandlers.length}`)
}

function latestInputHandler(): (input: string, key: Record<string, boolean>) => unknown {
  const latest = harness.inputHandlers.at(-1)
  if (!latest) throw new Error('No input handler registered')
  return latest.handler
}

function basePromptInputProps(overrides: Record<string, unknown> = {}) {
  return {
    agents: [],
    apiKeyStatus: 'valid',
    autoUpdaterResult: null,
    commands: [],
    debug: false,
    getToolUseContext: () => ({}),
    hasSuppressedDialogs: false,
    helpOpen: false,
    ideSelection: undefined,
    input: '',
    isLoading: false,
    isLocalJSXCommandActive: false,
    isSearchingHistory: false,
    mcpClients: [],
    messages: [],
    mode: 'prompt',
    onAutoUpdaterResult: vi.fn(),
    onExit: vi.fn(),
    onInputChange: vi.fn(),
    onModeChange: vi.fn(),
    onShowMessageSelector: vi.fn(),
    onSubmit: vi.fn(async () => {}),
    pastedContents: {},
    setHelpOpen: vi.fn(),
    setIsSearchingHistory: vi.fn(),
    setPastedContents: harness.setPastedContents,
    setShowBashesDialog: vi.fn(),
    setStashedPrompt: vi.fn(),
    setToolPermissionContext: vi.fn(),
    setVimMode: vi.fn(),
    showBashesDialog: false,
    stashedPrompt: undefined,
    submitCount: 0,
    toolPermissionContext: harness.appState.toolPermissionContext,
    verbose: false,
    vimMode: 'INSERT',
    ...overrides,
  }
}

function createPastedContentsState(
  initial: Record<number, PastedContent> = {},
): {
  readonly current: Record<number, PastedContent>
  setPastedContents: ReturnType<typeof vi.fn>
} {
  let current = initial
  const setPastedContents = vi.fn(
    (next: React.SetStateAction<Record<number, PastedContent>>) => {
      current = typeof next === 'function' ? next(current) : next
    },
  )

  return {
    get current() {
      return current
    },
    setPastedContents,
  }
}

async function renderPromptInput(overrides: Record<string, unknown> = {}) {
  harness.baseProps = undefined
  const { stdin, stdout } = createTestStreams()
  const root = await createRoot({
    patchConsole: false,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  })
  const props = basePromptInputProps(overrides)

  root.render(<PromptInput {...(props as never)} />)
  await waitForPromptInputProps()

  return {
    props,
    root,
    stdin,
    stdout,
    dispose: async () => {
      root.unmount()
      stdin.end()
      stdout.end()
      await sleep(25)
    },
  }
}

describe('PromptInput render surface', () => {
  beforeEach(() => {
    harness.reset()
    vi.mocked(getImageFromClipboard).mockReset()
    vi.mocked(getImageFromClipboard).mockResolvedValue(null)
    vi.mocked(cacheImagePath).mockClear()
    vi.mocked(storeImage).mockClear()
  })

  test('wires base text input props for the idle prompt surface', async () => {
    const rendered = await renderPromptInput({ input: 'hello' })

    try {
      const baseProps = await waitForPromptInputProps()

      expect(baseProps.value).toBe('hello')
      expect(baseProps.placeholder).toBe('Type a prompt')
      expect(baseProps.focus).toBe(true)
      expect(baseProps.showCursor).toBe(true)
      expect(baseProps.columns).toBe(95)
      expect(baseProps.multiline).toBe(true)
      expect(baseProps.disableCursorMovementForUpDownKeys).toBe(false)
    } finally {
      await rendered.dispose()
    }
  })

  test('submits normal prompt input through the leader path', async () => {
    const onSubmit = vi.fn(async () => {})
    const rendered = await renderPromptInput({ input: 'hello', onSubmit })

    try {
      const baseProps = await waitForPromptInputProps()
      await (baseProps.onSubmit as (value: string) => Promise<void>)('hello')

      expect(onSubmit).toHaveBeenCalledWith(
        'hello',
        expect.objectContaining({
          clearBuffer: harness.clearBuffer,
          resetHistory: expect.any(Function),
          setCursorOffset: expect.any(Function),
        }),
        undefined,
        expect.objectContaining({
          mode: 'prompt',
          vimRoutingState: expect.objectContaining({ enabled: false }),
        }),
      )
    } finally {
      await rendered.dispose()
    }
  })

  test('updates mode, text, and paste state through captured input handlers', async () => {
    const onInputChange = vi.fn()
    const onModeChange = vi.fn()
    const setHelpOpen = vi.fn()
    const setPastedContents = vi.fn(
      (updater: (prev: Record<number, unknown>) => Record<number, unknown>) =>
        updater({}),
    )
    const rendered = await renderPromptInput({
      input: '',
      onInputChange,
      onModeChange,
      setHelpOpen,
      setPastedContents,
    })

    try {
      const baseProps = await waitForPromptInputProps()

      ;(baseProps.onChange as (value: string) => void)('?')
      expect(setHelpOpen).toHaveBeenCalledWith(expect.any(Function))

      ;(baseProps.onChange as (value: string) => void)('!echo hi')
      expect(onModeChange).toHaveBeenCalledWith('bash')
      expect(onInputChange).toHaveBeenCalledWith('echo hi')

      ;(baseProps.onPaste as (value: string) => void)('short\tpaste')
      expect(onInputChange).toHaveBeenCalledWith('short    pasteecho hi')

      ;(baseProps.onPaste as (value: string) => void)('x'.repeat(40))
      expect(setPastedContents).toHaveBeenCalled()
      expect(onInputChange).toHaveBeenCalledWith(expect.stringContaining('[Pasted text'))
    } finally {
      await rendered.dispose()
    }
  })

  test('handles stash, newline, and external editor chat actions', async () => {
    const onInputChange = vi.fn()
    const setPastedContents = vi.fn()
    const setStashedPrompt = vi.fn()
    harness.editPromptResult = { content: 'edited draft', error: null }

    const rendered = await renderPromptInput({
      input: 'draft',
      onInputChange,
      setPastedContents,
      setStashedPrompt,
    })

    try {
      await waitForPromptInputProps()

      harness.keybindings['chat:newline']?.()
      expect(onInputChange).toHaveBeenCalledWith('draft\n')

      harness.keybindings['chat:stash']?.()
      expect(setStashedPrompt).toHaveBeenCalledWith({
        text: 'draft',
        cursorOffset: 'draft'.length,
        pastedContents: {},
      })
      expect(onInputChange).toHaveBeenCalledWith('')
      expect(setPastedContents).toHaveBeenCalledWith({})

      await harness.keybindings['chat:externalEditor']?.()
      expect(onInputChange).toHaveBeenCalledWith('edited draft')

      const unstash = await renderPromptInput({
        input: '',
        onInputChange,
        setPastedContents,
        setStashedPrompt,
        stashedPrompt: {
          text: 'restored',
          cursorOffset: 4,
          pastedContents: { 7: { id: 7, type: 'text', content: 'saved' } },
        },
      })
      try {
        await waitForPromptInputProps()
        harness.keybindings['chat:stash']?.()
        expect(onInputChange).toHaveBeenCalledWith('restored')
        expect(setPastedContents).toHaveBeenCalledWith({
          7: { id: 7, type: 'text', content: 'saved' },
        })
      } finally {
        await unstash.dispose()
      }
    } finally {
      await rendered.dispose()
    }
  })

  test('handles mode cycle, image paste miss, and empty prompt submission guards', async () => {
    const onSubmit = vi.fn(async () => {})
    const setToolPermissionContext = vi.fn()
    const rendered = await renderPromptInput({
      input: '',
      onSubmit,
      setToolPermissionContext,
    })

    try {
      const baseProps = await waitForPromptInputProps()

      await (baseProps.onSubmit as (value: string) => Promise<void>)('')
      expect(onSubmit).not.toHaveBeenCalled()

      harness.keybindings['chat:cycleMode']?.()
      expect(setToolPermissionContext).toHaveBeenCalledWith(
        expect.objectContaining({ mode: 'plan' }),
      )

      await harness.keybindings['chat:imagePaste']?.()
      await sleep(0)
      expect(harness.addNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          key: 'no-image-in-clipboard',
        }),
      )
    } finally {
      await rendered.dispose()
    }
  })

  test('pastes clipboard images as pills and lazy-spaces the next typed word', async () => {
    vi.mocked(getImageFromClipboard).mockResolvedValue({
      base64: 'jpeg-data',
      mediaType: 'image/jpeg',
      dimensions: { width: 640, height: 480 },
    })
    const onInputChange = vi.fn()
    const onModeChange = vi.fn()
    const pastedContents = createPastedContentsState()
    const rendered = await renderPromptInput({
      input: '',
      onInputChange,
      onModeChange,
      pastedContents: pastedContents.current,
      setPastedContents: pastedContents.setPastedContents,
    })

    try {
      const baseProps = await waitForPromptInputProps()

      await harness.keybindings['chat:imagePaste']?.()
      await sleep(25)

      expect(getImageFromClipboard).toHaveBeenCalledTimes(1)
      expect(onModeChange).toHaveBeenCalledWith('prompt')
      expect(onInputChange).toHaveBeenCalledWith('[Image #1]')
      expect(pastedContents.current).toEqual({
        1: expect.objectContaining({
          content: 'jpeg-data',
          dimensions: { width: 640, height: 480 },
          filename: 'Pasted image',
          id: 1,
          mediaType: 'image/jpeg',
          type: 'image',
        }),
      })
      expect(cacheImagePath).toHaveBeenCalledWith(
        expect.objectContaining({ id: 1, type: 'image' }),
      )
      expect(storeImage).toHaveBeenCalledWith(
        expect.objectContaining({ id: 1, type: 'image' }),
      )

      const inputFilter = baseProps.inputFilter as (
        input: string,
        key: Record<string, boolean>,
      ) => string
      expect(inputFilter('caption', {})).toBe(' caption')
      expect(inputFilter('again', {})).toBe('again')
    } finally {
      await rendered.dispose()
    }
  })

  test('prunes pasted image state when image pills are removed from input', async () => {
    const referencedImage: PastedContent = {
      id: 1,
      type: 'image',
      content: 'kept-image',
      mediaType: 'image/png',
      filename: 'kept.png',
    }
    const removedImage: PastedContent = {
      id: 2,
      type: 'image',
      content: 'removed-image',
      mediaType: 'image/png',
      filename: 'removed.png',
    }
    const textPaste: PastedContent = {
      id: 3,
      type: 'text',
      content: 'kept text',
    }
    const pastedContents = createPastedContentsState({
      1: referencedImage,
      2: removedImage,
      3: textPaste,
    })
    const rendered = await renderPromptInput({
      input: '[Image #1] [Image #2]',
      pastedContents: pastedContents.current,
      setPastedContents: pastedContents.setPastedContents,
    })

    try {
      await sleep(25)
      expect(pastedContents.current).toEqual({
        1: referencedImage,
        2: removedImage,
        3: textPaste,
      })

      harness.baseProps = undefined
      rendered.root.render(
        <PromptInput
          {...(basePromptInputProps({
            input: '[Image #1]',
            pastedContents: pastedContents.current,
            setPastedContents: pastedContents.setPastedContents,
          }) as never)}
        />,
      )
      await waitForPromptInputProps()
      await sleep(25)

      expect(pastedContents.current).toEqual({
        1: referencedImage,
        3: textPaste,
      })
    } finally {
      await rendered.dispose()
    }
  })

  test('opens fast mode picker and enables fast mode with model switch when confirmed', async () => {
    harness.fastMode.enabled = true
    harness.fastMode.available = true
    harness.fastMode.supportedByModel = false
    const setHelpOpen = vi.fn()
    const rendered = await renderPromptInput({
      helpOpen: true,
      setHelpOpen,
    })

    try {
      await waitForPromptInputProps()
      const handlersBeforePicker = harness.inputHandlers.length
      harness.keybindings['chat:fastMode']?.()
      await waitForInputHandlerCount(handlersBeforePicker + 1)
      expect(setHelpOpen).toHaveBeenCalledWith(false)

      latestInputHandler()(' ', { tab: false })
      await sleep(25)
      latestInputHandler()('', { return: true })
      await sleep(25)

      expect(harness.updateSettingsForSource).toHaveBeenCalledWith(
        'userSettings',
        { fastMode: true },
      )
      expect(harness.appState.fastMode).toBe(true)
      expect(harness.appState.mainLoopModel).toBe('fast-model')
      expect(harness.appState.mainLoopModelForSession).toBeNull()
      expect(harness.addNotification).toHaveBeenCalledWith(
        expect.objectContaining({ key: 'fast-mode-toggled' }),
      )
    } finally {
      await rendered.dispose()
    }
  })

  test('cancels unavailable fast mode by disabling an existing fast-mode session', async () => {
    harness.appState.fastMode = true
    harness.fastMode.enabled = true
    harness.fastMode.available = true
    harness.fastMode.unavailableReason = 'Fast mode unavailable'
    const rendered = await renderPromptInput()

    try {
      await waitForPromptInputProps()
      const handlersBeforePicker = harness.inputHandlers.length
      harness.keybindings['chat:fastMode']?.()
      await waitForInputHandlerCount(handlersBeforePicker + 1)

      latestInputHandler()('', { escape: true })
      await sleep(25)

      expect(harness.updateSettingsForSource).toHaveBeenCalledWith(
        'userSettings',
        { fastMode: undefined },
      )
      expect(harness.appState.fastMode).toBe(false)
      expect(harness.addNotification).toHaveBeenCalledWith(
        expect.objectContaining({ key: 'fast-mode-toggled' }),
      )
    } finally {
      await rendered.dispose()
    }
  })

  test('accepts a visible prompt suggestion on empty submit', async () => {
    harness.appState.promptSuggestion = {
      acceptedAt: 0,
      generationRequestId: 'generation-1',
      promptId: 'prompt-1',
      shownAt: 100,
      text: 'run the test suite',
    }
    const onSubmit = vi.fn(async () => {})
    const rendered = await renderPromptInput({ input: '', onSubmit })

    try {
      const baseProps = await waitForPromptInputProps()
      await (baseProps.onSubmit as (value: string) => Promise<void>)('')

      expect(onSubmit).toHaveBeenCalledWith(
        'run the test suite',
        expect.objectContaining({
          clearBuffer: harness.clearBuffer,
          resetHistory: expect.any(Function),
          setCursorOffset: expect.any(Function),
        }),
        undefined,
        expect.objectContaining({
          mode: 'prompt',
          vimRoutingState: expect.objectContaining({ enabled: false }),
        }),
      )
      expect(harness.promptSuggestionLogEvent).toHaveBeenCalledWith(
        'agenc_prompt_suggestion',
        expect.objectContaining({
          generationRequestId: 'generation-1',
          outcome: 'accepted',
          prompt_id: 'prompt-1',
          source: 'cli',
        }),
      )
      expect(harness.appState.promptSuggestion).toEqual({
        acceptedAt: 0,
        generationRequestId: null,
        promptId: null,
        shownAt: 0,
        text: null,
      })
    } finally {
      await rendered.dispose()
    }
  })

  test('routes accepted prompt suggestions through active speculation state', async () => {
    harness.appState.promptSuggestion = {
      acceptedAt: 0,
      generationRequestId: null,
      promptId: 'prompt-spec',
      shownAt: 100,
      text: 'finish via speculation',
    }
    harness.appState.speculation = {
      status: 'active',
      taskId: 'spec-task',
    }
    harness.appState.speculationSessionTimeSavedMs = 1234
    const onSubmit = vi.fn(async () => {})
    const rendered = await renderPromptInput({ input: '', onSubmit })

    try {
      const baseProps = await waitForPromptInputProps()
      await (baseProps.onSubmit as (value: string) => Promise<void>)('')

      expect(onSubmit).toHaveBeenCalledWith(
        'finish via speculation',
        expect.objectContaining({
          clearBuffer: harness.clearBuffer,
          resetHistory: expect.any(Function),
          setCursorOffset: expect.any(Function),
        }),
        expect.objectContaining({
          speculationSessionTimeSavedMs: 1234,
          state: expect.objectContaining({
            status: 'active',
            taskId: 'spec-task',
          }),
          setAppState: harness.setAppState,
        }),
        expect.objectContaining({
          vimRoutingState: expect.objectContaining({ enabled: false }),
        }),
      )
      expect(harness.promptSuggestionLogEvent).toHaveBeenCalledWith(
        'agenc_prompt_suggestion',
        expect.objectContaining({
          outcome: 'accepted',
          prompt_id: 'prompt-spec',
          source: 'cli',
        }),
      )
      expect(harness.appState.promptSuggestion.text).toBe('finish via speculation')
      expect(harness.appState.promptSuggestion.acceptedAt).toBeGreaterThan(0)
    } finally {
      await rendered.dispose()
    }
  })

  test('executes bash-mode input locally and emits transcript events', async () => {
    const emitted: unknown[] = []
    const setToolJSX = vi.fn()
    const getToolUseContext = vi.fn(() => ({
      session: {
        emit: (event: unknown) => emitted.push(event),
        nextInternalSubId: vi.fn()
          .mockReturnValueOnce('bash-input-id')
          .mockReturnValueOnce('bash-stdout-id')
          .mockReturnValueOnce('bash-stderr-id'),
      },
      setToolJSX,
    }))
    harness.processBashCommand.mockResolvedValue({
      messages: [
        {
          message: {
            content: [
              { text: '<bash-stdout>ok</bash-stdout>', type: 'text' },
            ],
          },
          type: 'user',
        },
        {
          message: {
            content: [
              { text: '<ignored>nope</ignored>', type: 'text' },
            ],
          },
          type: 'user',
        },
        {
          message: {
            content: [
              { text: '<bash-stderr>warn</bash-stderr>', type: 'text' },
            ],
          },
          type: 'user',
        },
      ],
    })
    const onSubmit = vi.fn(async () => {})
    const onInputChange = vi.fn()
    const onModeChange = vi.fn()
    const rendered = await renderPromptInput({
      getToolUseContext,
      input: '  pwd  ',
      mode: 'bash',
      onInputChange,
      onModeChange,
      onSubmit,
    })

    try {
      const baseProps = await waitForPromptInputProps()
      await (baseProps.onSubmit as (value: string) => Promise<void>)('  pwd  ')

      expect(onSubmit).not.toHaveBeenCalled()
      expect(getToolUseContext).toHaveBeenCalled()
      expect(harness.processBashCommand).toHaveBeenCalledWith(
        'pwd',
        [],
        [],
        expect.objectContaining({ setToolJSX }),
        setToolJSX,
      )
      expect(emitted).toEqual([
        expect.objectContaining({
          id: 'bash-input-id',
          msg: expect.objectContaining({
            payload: expect.objectContaining({
              message: '<bash-input>pwd</bash-input>',
            }),
          }),
        }),
        expect.objectContaining({
          id: 'bash-stdout-id',
          msg: expect.objectContaining({
            payload: expect.objectContaining({
              message: '<bash-stdout>ok</bash-stdout>',
            }),
          }),
        }),
        expect.objectContaining({
          id: 'bash-stderr-id',
          msg: expect.objectContaining({
            payload: expect.objectContaining({
              message: '<bash-stderr>warn</bash-stderr>',
            }),
          }),
        }),
      ])
      expect(onInputChange).toHaveBeenCalledWith('')
      expect(onModeChange).toHaveBeenCalledWith('prompt')
      expect(harness.clearBuffer).toHaveBeenCalled()
    } finally {
      await rendered.dispose()
    }
  })

  test('emits bash stderr when local bash execution throws', async () => {
    const emitted: unknown[] = []
    const getToolUseContext = vi.fn(() => ({
      session: {
        emit: (event: unknown) => emitted.push(event),
      },
    }))
    harness.processBashCommand.mockRejectedValue(new Error('shell failed'))
    const onInputChange = vi.fn()
    const onModeChange = vi.fn()
    const rendered = await renderPromptInput({
      getToolUseContext,
      input: 'explode',
      mode: 'bash',
      onInputChange,
      onModeChange,
    })

    try {
      const baseProps = await waitForPromptInputProps()
      await (baseProps.onSubmit as (value: string) => Promise<void>)('explode')

      expect(emitted).toEqual([
        expect.objectContaining({
          msg: expect.objectContaining({
            payload: expect.objectContaining({
              message: '<bash-input>explode</bash-input>',
            }),
          }),
        }),
        expect.objectContaining({
          msg: expect.objectContaining({
            payload: expect.objectContaining({
              message: '<bash-stderr>shell failed</bash-stderr>',
            }),
          }),
        }),
      ])
      expect(onInputChange).toHaveBeenCalledWith('')
      expect(onModeChange).toHaveBeenCalledWith('prompt')
    } finally {
      await rendered.dispose()
    }
  })
})
