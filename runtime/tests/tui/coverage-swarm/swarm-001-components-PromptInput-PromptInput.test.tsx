import { PassThrough } from 'node:stream'

import React from 'react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { PastedContent } from '../../utils/config.js'

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
    tasks: {} as Record<string, Record<string, unknown>>,
    teamContext: undefined as
      | undefined
      | {
          teamName: string
          teammates: Record<string, { color?: string; name: string }>
        },
    thinkingEnabled: true,
    toolPermissionContext: {
      isAutoModeAvailable: true,
      isBypassPermissionsModeAvailable: true,
      mode: 'default',
    },
    viewingAgentTaskId: null as null | string,
    viewSelectionMode: null as null | string,
  }

  return {
    activeAgent: { type: 'leader' } as { task?: unknown; type: string },
    addNotification: vi.fn(),
    appState,
    autoModeOptInProps: undefined as undefined | Record<string, unknown>,
    backgroundTasksPanelProps: undefined as undefined | Record<string, unknown>,
    baseProps: undefined as undefined | Record<string, unknown>,
    clearBuffer: vi.fn(),
    commandQueue: [] as unknown[],
    coordinatorTaskCount: 0,
    directMessage: null as null | { message: string; recipientName: string },
    directMessageResult: { success: false } as Record<string, unknown>,
    editPromptError: null as null | Error,
    editPromptResult: { content: null, error: null } as {
      content: string | null
      error: string | null
    },
    enterTeammateView: vi.fn(),
    exitTeammateView: vi.fn(),
    features: {} as Record<string, boolean>,
    fullscreen: false,
    getGlobalConfigResult: {} as Record<string, unknown>,
    globalSearchProps: undefined as undefined | Record<string, unknown>,
    hasAutoModeOptIn: true,
    history: {
      dismissSearchHint: vi.fn(),
      historyFailedMatch: false,
      historyIndex: 0,
      historyMatch: null as unknown,
      historyQuery: '',
      onHistoryDown: vi.fn(() => false),
      onHistoryUp: vi.fn(),
      resetHistory: vi.fn(),
      setHistoryQuery: vi.fn(),
    },
    historySearchProps: undefined as undefined | Record<string, unknown>,
    ideAtMentionedHandler: undefined as
      | undefined
      | ((atMentioned: {
          filePath: string
          lineEnd?: number
          lineStart?: number
        }) => void),
    inputHandlers: [] as Array<{
      handler: (
        input: string,
        key: Record<string, boolean>,
        event?: { stopImmediatePropagation: () => void },
      ) => unknown
      options?: Record<string, unknown>
    }>,
    isAgentSwarmsEnabled: false,
    isBackgroundTask: vi.fn(() => false),
    isInProcessEnabled: false,
    isInProcessTeammate: false,
    isMacosOptionChar: false,
    isSSH: false,
    keybindingRegistrations: [] as Array<Record<string, unknown>>,
    keybindings: {} as Record<string, () => unknown>,
    modelPickerProps: undefined as undefined | Record<string, unknown>,
    nextPermissionMode: 'plan',
    cyclePermissionModeNextMode: null as null | string,
    onRender: vi.fn(),
    platform: 'linux',
    promptInputFooterProps: undefined as undefined | Record<string, unknown>,
    promptOverlayDialog: undefined as unknown,
    pushToBuffer: vi.fn(),
    quickOpenProps: undefined as undefined | Record<string, unknown>,
    removeNotification: vi.fn(),
    runningTeammates: [] as Array<{ id: string }>,
    saveGlobalConfig: vi.fn(),
    setAutoModeActive: vi.fn(),
    specialChars: {} as Record<string, string>,
    stopOrDismissAgent: vi.fn(),
    swarmBanner: null as null | { bgColor: string; text?: string },
    syncTeammateMode: vi.fn(),
    teammateColor: undefined as undefined | string,
    teamsDialogProps: undefined as undefined | Record<string, unknown>,
    terminal: undefined as undefined | string,
    thinking: {
      positions: [] as Array<{ end: number; start: number }>,
      ultrathinkEnabled: false,
    },
    thinkingToggleProps: undefined as undefined | Record<string, unknown>,
    transitionPermissionMode: vi.fn(
      (_from: unknown, _to: unknown, context: Record<string, unknown>) => ({
        ...context,
        transitioned: true,
      }),
    ),
    typeahead: {
      commandArgumentHint: undefined as undefined | string,
      inlineGhostText: undefined as undefined | string,
      maxColumnWidth: 0,
      selectedSuggestion: -1,
      suggestionType: undefined as undefined | string,
      suggestions: [] as Array<{ description?: string; label: string }>,
    },
    updateSettingsForSource: vi.fn(),
    visibleAgentTasks: [] as Array<{ id: string; status?: string }>,
    viewedTeammate: undefined as
      | undefined
      | {
          id: string
          identity: { agentName: string; color?: string }
          permissionMode: string
        },
    fastMode: {
      available: false,
      cooldown: false,
      enabled: false,
      runtimeState: { status: 'available' },
      supportedByModel: true,
      unavailableReason: null as string | null,
    },
    reset: () => {
      harness.activeAgent = { type: 'leader' }
      harness.addNotification.mockClear()
      harness.autoModeOptInProps = undefined
      harness.backgroundTasksPanelProps = undefined
      harness.baseProps = undefined
      harness.clearBuffer.mockClear()
      harness.commandQueue = []
      harness.coordinatorTaskCount = 0
      harness.directMessage = null
      harness.directMessageResult = { success: false }
      harness.editPromptError = null
      harness.editPromptResult = { content: null, error: null }
      harness.enterTeammateView.mockClear()
      harness.exitTeammateView.mockClear()
      harness.features = {}
      harness.fullscreen = false
      harness.getGlobalConfigResult = {}
      harness.globalSearchProps = undefined
      harness.hasAutoModeOptIn = true
      harness.history.dismissSearchHint.mockClear()
      harness.history.historyFailedMatch = false
      harness.history.historyIndex = 0
      harness.history.historyMatch = null
      harness.history.historyQuery = ''
      harness.history.onHistoryDown.mockReset()
      harness.history.onHistoryDown.mockReturnValue(false)
      harness.history.onHistoryUp.mockClear()
      harness.history.resetHistory.mockClear()
      harness.history.setHistoryQuery.mockClear()
      harness.historySearchProps = undefined
      harness.ideAtMentionedHandler = undefined
      harness.inputHandlers = []
      harness.isAgentSwarmsEnabled = false
      harness.isBackgroundTask.mockReset()
      harness.isBackgroundTask.mockReturnValue(false)
      harness.isInProcessEnabled = false
      harness.isInProcessTeammate = false
      harness.isMacosOptionChar = false
      harness.isSSH = false
      harness.keybindingRegistrations = []
      harness.keybindings = {}
      harness.modelPickerProps = undefined
      harness.nextPermissionMode = 'plan'
      harness.cyclePermissionModeNextMode = null
      harness.onRender.mockClear()
      harness.platform = 'linux'
      harness.promptInputFooterProps = undefined
      harness.promptOverlayDialog = undefined
      harness.pushToBuffer.mockClear()
      harness.quickOpenProps = undefined
      harness.removeNotification.mockClear()
      harness.runningTeammates = []
      harness.saveGlobalConfig.mockClear()
      harness.setAppState.mockClear()
      harness.setAutoModeActive.mockClear()
      harness.setPastedContents.mockClear()
      harness.specialChars = {}
      harness.stopOrDismissAgent.mockClear()
      harness.swarmBanner = null
      harness.syncTeammateMode.mockClear()
      harness.teammateColor = undefined
      harness.teamsDialogProps = undefined
      harness.terminal = undefined
      harness.thinking = {
        positions: [],
        ultrathinkEnabled: false,
      }
      harness.thinkingToggleProps = undefined
      harness.transitionPermissionMode.mockClear()
      harness.typeahead = {
        commandArgumentHint: undefined,
        inlineGhostText: undefined,
        maxColumnWidth: 0,
        selectedSuggestion: -1,
        suggestionType: undefined,
        suggestions: [],
      }
      harness.updateSettingsForSource.mockClear()
      harness.visibleAgentTasks = []
      harness.viewedTeammate = undefined
      harness.fastMode = {
        available: false,
        cooldown: false,
        enabled: false,
        runtimeState: { status: 'available' },
        supportedByModel: true,
        unavailableReason: null,
      }
      appState.coordinatorTaskIndex = -1
      appState.effortValue = undefined
      appState.expandedView = 'transcript'
      appState.fastMode = false
      appState.footerSelection = null
      appState.isBriefOnly = false
      appState.mainLoopModel = 'gpt-5.4'
      appState.mainLoopModelForSession = null
      appState.mcp = { clients: [] }
      appState.promptSuggestion = {
        acceptedAt: 0,
        generationRequestId: null,
        promptId: null,
        shownAt: 0,
        text: null,
      }
      appState.speculation = { status: 'inactive' }
      appState.speculationSessionTimeSavedMs = 0
      appState.tasks = {}
      appState.teamContext = undefined
      appState.thinkingEnabled = true
      appState.toolPermissionContext = {
        isAutoModeAvailable: true,
        isBypassPermissionsModeAvailable: true,
        mode: 'default',
      }
      appState.viewingAgentTaskId = null
      appState.viewSelectionMode = null
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
  feature: (name: string) => harness.features[name] === true,
}))

vi.mock('../../services/PromptSuggestion/promptSuggestion.js', () => ({
  abortPromptSuggestion: vi.fn(),
  logSuggestionSuppressed: vi.fn(),
}))

vi.mock('../../services/PromptSuggestion/speculation.js', () => ({
  abortSpeculation: vi.fn(),
}))

vi.mock('../context/notifications.js', () => ({
  useNotifications: () => ({
    addNotification: harness.addNotification,
    removeNotification: harness.removeNotification,
  }),
}))

vi.mock('../context/overlayContext.js', () => ({
  useIsModalOverlayActive: () => false,
  useRegisterOverlay: vi.fn(),
}))

vi.mock('../context/promptOverlayContext.js', () => ({
  useSetPromptOverlayDialog: () => (dialog: unknown) => {
    harness.promptOverlayDialog = dialog
  },
}))

vi.mock('../hooks/useCommandQueue.js', () => ({
  useCommandQueue: () => harness.commandQueue,
}))

vi.mock('../hooks/useIdeAtMentioned.js', () => ({
  useIdeAtMentioned: vi.fn(
    (
      _clients: unknown,
      handler: (atMentioned: {
        filePath: string
        lineEnd?: number
        lineStart?: number
      }) => void,
    ) => {
      harness.ideAtMentionedHandler = handler
    },
  ),
}))

vi.mock('../hooks/useArrowKeyHistory.js', () => ({
  useArrowKeyHistory: () => ({
    dismissSearchHint: harness.history.dismissSearchHint,
    historyIndex: harness.history.historyIndex,
    onHistoryDown: harness.history.onHistoryDown,
    onHistoryUp: harness.history.onHistoryUp,
    resetHistory: harness.history.resetHistory,
  }),
}))

vi.mock('../hooks/useDoublePress.js', () => ({
  useDoublePress: (_single: () => void, doublePress: () => void) => doublePress,
}))

vi.mock('../hooks/useHistorySearch.js', () => ({
  useHistorySearch: () => ({
    historyFailedMatch: harness.history.historyFailedMatch,
    historyMatch: harness.history.historyMatch,
    historyQuery: harness.history.historyQuery,
    setHistoryQuery: harness.history.setHistoryQuery,
  }),
}))

vi.mock('../hooks/useInputBuffer.js', () => ({
  useInputBuffer: () => ({
    canUndo: false,
    clearBuffer: harness.clearBuffer,
    pushToBuffer: harness.pushToBuffer,
    undo: harness.undo,
  }),
}))

vi.mock('../hooks/useMainLoopModel.js', () => ({
  useMainLoopModel: () => 'gpt-5.4',
}))

vi.mock('../hooks/useTerminalSize.js', () => ({
  useTerminalSize: () => ({ columns: 100, rows: 30 }),
}))

vi.mock('../hooks/useTypeahead.js', () => ({
  useTypeahead: () => harness.typeahead,
}))

vi.mock('../ink/hooks/use-terminal-focus.js', () => ({
  useTerminalFocus: () => true,
}))

vi.mock('../ink.js', async () => {
  const ReactModule = await import('react')
  return {
    Box: ({ children }: { readonly children?: React.ReactNode }) =>
      ReactModule.createElement(ReactModule.Fragment, null, children),
    Text: ({ children }: { readonly children?: React.ReactNode }) =>
      ReactModule.createElement(ReactModule.Fragment, null, children),
    useInput: (
      handler: (
        input: string,
        key: Record<string, boolean>,
        event?: { stopImmediatePropagation: () => void },
      ) => unknown,
      options?: Record<string, unknown>,
    ) => {
      harness.inputHandlers.push({ handler, options })
    },
  }
})

vi.mock('../keybindings/KeybindingContext.js', () => ({
  useOptionalKeybindingContext: () => ({
    registerHandler: (registration: Record<string, unknown>) => {
      harness.keybindingRegistrations.push(registration)
      return () => {
        harness.keybindingRegistrations =
          harness.keybindingRegistrations.filter(item => item !== registration)
      }
    },
  }),
}))

vi.mock('../keybindings/shortcutFormat.js', () => ({
  getShortcutDisplay: () => 'ctrl+v',
}))

vi.mock('../keybindings/useKeybinding.js', () => ({
  useKeybinding: (action: string, handler: () => unknown) => {
    harness.keybindings[action] = handler
  },
  useKeybindings: (handlers: Record<string, () => unknown>) => {
    Object.assign(harness.keybindings, handlers)
  },
}))

vi.mock('../glyphs.js', () => ({
  selectAgenCTuiGlyphs: () => ({ horizontal: '-' }),
}))

vi.mock('../state/AppState.js', () => ({
  useAppState: (selector: (state: typeof harness.appState) => unknown) =>
    selector(harness.appState),
  useAppStateStore: () => ({ getState: () => harness.appState }),
  useSetAppState: () => harness.setAppState,
}))

vi.mock('../state/selectors.js', () => ({
  getActiveAgentForInput: () => harness.activeAgent,
  getViewedTeammateTask: () => harness.viewedTeammate,
}))

vi.mock('../state/teammateViewHelpers.js', () => ({
  enterTeammateView: harness.enterTeammateView,
  exitTeammateView: harness.exitTeammateView,
  stopOrDismissAgent: harness.stopOrDismissAgent,
}))

vi.mock('../../commands.js', () => ({
  hasCommand: () => false,
}))

vi.mock('../../tasks/InProcessTeammateTask/InProcessTeammateTask.js', () => ({
  getRunningTeammatesSorted: () => harness.runningTeammates,
}))

vi.mock('../../tasks/types.js', () => ({
  isBackgroundTask: (task: unknown) => harness.isBackgroundTask(task),
}))

vi.mock('../../tools/AgentTool/agentColorManager.js', () => ({
  AGENT_COLORS: ['cyan', 'purple'],
  AGENT_COLOR_TO_THEME_COLOR: { cyan: 'accent', purple: 'secondary' },
}))

vi.mock('../../utils/agentSwarmsEnabled.js', () => ({
  isAgentSwarmsEnabled: () => harness.isAgentSwarmsEnabled,
}))

vi.mock('../../utils/array.js', () => ({
  count: (values: readonly unknown[], predicate: (value: unknown) => boolean) =>
    values.filter(predicate).length,
}))

vi.mock('../../utils/config.js', () => ({
  getGlobalConfig: () => harness.getGlobalConfigResult,
  saveGlobalConfig: harness.saveGlobalConfig,
}))

vi.mock('../../utils/cwd.js', () => ({
  getCwd: () => '/repo',
}))

vi.mock('../../utils/debug.js', () => ({
  logForDebugging: vi.fn(),
}))

vi.mock('../../utils/directMemberMessage.js', () => ({
  parseDirectMemberMessage: () => harness.directMessage,
  sendDirectMemberMessage: vi.fn(() => harness.directMessageResult),
}))

vi.mock('../../utils/dragDropPaths.js', () => ({
  extractDraggedFilePaths: (value: string) =>
    value.startsWith('/dragged/file') ? [value.trim()] : [],
}))

vi.mock('../../utils/env.js', () => ({
  env: {
    isSSH: () => harness.isSSH,
    get terminal() {
      return harness.terminal
    },
  },
}))

vi.mock('../../utils/errors.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../utils/errors.js')>()
  return {
    ...actual,
    errorMessage: (value: unknown) => String(value),
  }
})

vi.mock('../../utils/extraUsage.js', () => ({
  isBilledAsExtraUsage: () => false,
}))

vi.mock('../../utils/fastMode.js', () => ({
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

vi.mock('../../utils/fullscreen.js', () => ({
  isFullscreenEnvEnabled: () => harness.fullscreen,
}))

vi.mock('../../utils/imagePaste.js', () => ({
  PASTE_THRESHOLD: 20,
  getImageFromClipboard: vi.fn(async () => null),
}))

vi.mock('../../utils/imageStore.js', () => ({
  cacheImagePath: vi.fn(),
  storeImage: vi.fn(),
}))

vi.mock('../../utils/keyboardShortcuts.js', () => ({
  MACOS_OPTION_SPECIAL_CHARS: new Proxy(
    {},
    {
      get: (_target, prop) => harness.specialChars[String(prop)],
    },
  ),
  isMacosOptionChar: () => harness.isMacosOptionChar,
}))

vi.mock('../../utils/log.js', () => ({
  logError: vi.fn(),
}))

vi.mock('../../utils/model/model.js', () => ({
  isOpus1mMergeEnabled: () => false,
  modelDisplayString: (model: string | null) => model ?? 'default',
}))

vi.mock('../../utils/permissions/autoModeState.js', () => ({
  setAutoModeActive: harness.setAutoModeActive,
}))

vi.mock('../../utils/permissions/getNextPermissionMode.js', () => ({
  cyclePermissionMode: (context: unknown) => ({
    context,
    nextMode: harness.cyclePermissionModeNextMode ?? harness.nextPermissionMode,
  }),
  getNextPermissionMode: () => harness.nextPermissionMode,
}))

vi.mock('../../utils/permissions/permissionSetup.js', () => ({
  transitionPermissionMode: harness.transitionPermissionMode,
}))

vi.mock('../../utils/platform.js', () => ({
  getPlatform: () => harness.platform,
}))

vi.mock('../../utils/promptEditor.js', () => ({
  editPromptInEditor: vi.fn(async () => {
    if (harness.editPromptError) throw harness.editPromptError
    return harness.editPromptResult
  }),
}))

vi.mock('../input/processBashCommand.js', () => ({
  processBashCommand: vi.fn(async () => ({ messages: [] })),
}))

vi.mock('../../utils/settings/settings.js', () => ({
  hasAutoModeOptIn: () => harness.hasAutoModeOptIn,
  updateSettingsForSource: harness.updateSettingsForSource,
}))

vi.mock('../../utils/suggestions/commandSuggestions.js', () => ({
  findSlashCommandPositions: () => [],
}))

vi.mock('../../utils/suggestions/slackChannelSuggestions.js', () => ({
  findSlackChannelPositions: () => [],
  getKnownChannelsVersion: () => 0,
  hasSlackMcpServer: () => false,
  subscribeKnownChannels: () => () => {},
}))

vi.mock('../../utils/swarm/backends/registry.js', () => ({
  isInProcessEnabled: () => harness.isInProcessEnabled,
}))

vi.mock('../../utils/swarm/teamHelpers.js', () => ({
  syncTeammateMode: harness.syncTeammateMode,
}))

vi.mock('../../utils/teammate.js', () => ({
  getTeammateColor: () => harness.teammateColor,
}))

vi.mock('../../utils/teammateContext.js', () => ({
  isInProcessTeammate: () => harness.isInProcessTeammate,
}))

vi.mock('../../utils/teammateMailbox.js', () => ({
  writeToMailbox: vi.fn(),
}))

vi.mock('../../utils/thinking.js', () => ({
  findThinkingTriggerPositions: () => harness.thinking.positions,
  getRainbowColor: () => 'suggestion',
  isUltrathinkEnabled: () => harness.thinking.ultrathinkEnabled,
}))

vi.mock('../../conversation/token-budget.js', () => ({
  findTokenBudgetPositions: () => [],
}))

vi.mock('../components/AutoModeOptInDialog.js', () => ({
  AutoModeOptInDialog: (props: Record<string, unknown>) => {
    harness.autoModeOptInProps = props
    return null
  },
}))

vi.mock('../components/ConfigurableShortcutHint.js', () => ({
  ConfigurableShortcutHint: () => null,
}))

vi.mock('../components/CoordinatorAgentStatus.js', () => ({
  getVisibleAgentTasks: () => harness.visibleAgentTasks,
  useCoordinatorTaskCount: () => harness.coordinatorTaskCount,
}))

vi.mock('../components/EffortIndicator.js', () => ({
  getEffortNotificationText: () => undefined,
}))

vi.mock('../components/FastIcon.js', () => ({
  getFastIconString: () => 'FAST',
}))

vi.mock('../components/FullscreenLayout.js', () => ({
  calculateFullscreenLayoutBudget: (rows: number) => ({
    bottomMaxHeight: Math.max(1, Math.floor(rows / 2)),
  }),
}))

vi.mock('../components/GlobalSearchDialog.js', () => ({
  GlobalSearchDialog: (props: Record<string, unknown>) => {
    harness.globalSearchProps = props
    return null
  },
}))

vi.mock('../history/HistorySearchDialog.js', () => ({
  HistorySearchDialog: (props: Record<string, unknown>) => {
    harness.historySearchProps = props
    return null
  },
}))

vi.mock('../components/ModelPicker.js', () => ({
  ModelPicker: (props: Record<string, unknown>) => {
    harness.modelPickerProps = props
    return null
  },
}))

vi.mock('../components/QuickOpenDialog.js', () => ({
  QuickOpenDialog: (props: Record<string, unknown>) => {
    harness.quickOpenProps = props
    return null
  },
}))

vi.mock('../components/ThinkingToggle.js', () => ({
  ThinkingToggle: (props: Record<string, unknown>) => {
    harness.thinkingToggleProps = props
    return null
  },
}))

vi.mock('../components/tasks/BackgroundTasksPanel.js', () => ({
  BackgroundTasksPanel: (props: Record<string, unknown>) => {
    harness.backgroundTasksPanelProps = props
    return null
  },
}))

vi.mock('../components/tasks/taskStatusUtils.js', () => ({
  shouldHideTasksFooter: () => false,
}))

vi.mock('../components/teams/TeamsDialog.js', () => ({
  TeamsDialog: (props: Record<string, unknown>) => {
    harness.teamsDialogProps = props
    return null
  },
}))

vi.mock('../components/v2/primitives.js', () => ({
  ModeSwitcher: () => null,
}))

vi.mock('../components/PromptInput/ConfiguredPromptTextInput.js', async () => {
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

vi.mock('../components/PromptInput/Notifications.js', () => ({
  FOOTER_TEMPORARY_STATUS_TIMEOUT: 3000,
  Notifications: () => null,
}))

vi.mock('../components/PromptInput/PromptInputFooter.js', () => ({
  default: (props: Record<string, unknown>) => {
    harness.promptInputFooterProps = props
    return null
  },
}))

vi.mock('../components/PromptInput/PromptInputModeIndicator.js', () => ({
  PromptInputModeIndicator: () => null,
}))

vi.mock('../components/PromptInput/PromptInputQueuedCommands.js', () => ({
  PromptInputQueuedCommands: () => null,
}))

vi.mock('../components/PromptInput/PromptInputStashNotice.js', () => ({
  PromptInputStashNotice: () => null,
}))

vi.mock('../components/PromptInput/useMaybeTruncateInput.js', () => ({
  useMaybeTruncateInput: vi.fn(),
}))

vi.mock('../components/PromptInput/usePromptInputPlaceholder.js', () => ({
  usePromptInputPlaceholder: () => 'Type a prompt',
}))

vi.mock('../components/PromptInput/useShowFastIconHint.js', () => ({
  useShowFastIconHint: () => false,
}))

vi.mock('../components/PromptInput/useSwarmBanner.js', () => ({
  useSwarmBanner: () => harness.swarmBanner,
}))

vi.mock('../components/PromptInput/utils.js', async importOriginal => {
  const actual = await importOriginal<
    typeof import('../components/PromptInput/utils.js')
  >()
  return {
    ...actual,
    isVimModeEnabled: () => false,
  }
})

import { createRoot } from '../ink/root.js'
import PromptInput from '../components/PromptInput/PromptInput.js'

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

async function waitFor(condition: () => boolean, message: string): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < 1000) {
    if (condition()) return
    await sleep(10)
  }
  throw new Error(message)
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
    getMessages: () => [],
    hasMessages: false,
    isMidConversation: false,
    lastAssistantMessageId: null,
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
    rerender: async (next: Record<string, unknown>) => {
      harness.baseProps = undefined
      root.render(<PromptInput {...(basePromptInputProps(next) as never)} />)
      await waitForPromptInputProps()
    },
    dispose: async () => {
      root.unmount()
      stdin.end()
      stdout.end()
      await sleep(25)
    },
  }
}

describe('PromptInput coverage swarm row 001', () => {
  beforeEach(() => {
    harness.reset()
  })

  test('adds teammate mention and image chip highlights', async () => {
    harness.isAgentSwarmsEnabled = true
    harness.appState.teamContext = {
      teamName: 'runtime',
      teammates: {
        alice: { color: 'cyan', name: 'alice' },
        bob: { color: 'missing-theme', name: 'bob' },
      },
    }
    const input = 'ask @alice and @bob [Image #2]'
    const imageStart = input.indexOf('[Image')
    const rendered = await renderPromptInput({ input })

    try {
      const baseProps = await waitForPromptInputProps()
      const highlights = baseProps.highlights as Array<Record<string, unknown>>

      expect(highlights).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            color: 'accent',
            end: 'ask @alice'.length,
            priority: 5,
            start: 'ask '.length,
          }),
        ]),
      )
      expect(highlights).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            start: input.indexOf('@bob'),
            color: undefined,
          }),
        ]),
      )

      ;(baseProps.onChangeCursorOffset as (offset: number) => void)(
        imageStart + 2,
      )
      await waitFor(
        () => (harness.baseProps?.cursorOffset as number | undefined) === imageStart,
        'cursor did not snap to the image chip start',
      )

      const snappedHighlights = harness.baseProps?.highlights as Array<
        Record<string, unknown>
      >
      expect(snappedHighlights).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            inverse: true,
            start: imageStart,
          }),
        ]),
      )
    } finally {
      await rendered.dispose()
    }
  })

  test('shows the stash hint only after gradual clearing of substantial input', async () => {
    harness.getGlobalConfigResult = { hasUsedStash: false }
    const rendered = await renderPromptInput({
      input: 'this is a substantial draft prompt',
    })

    try {
      await rendered.rerender({ input: 'short draft' })
      await rendered.rerender({ input: 'tiny' })

      expect(harness.addNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          key: 'stash-hint',
          priority: 'immediate',
        }),
      )
    } finally {
      await rendered.dispose()
    }
  })

  test('detects pasted composer modes and dragged-path spacing', async () => {
    const onInputChange = vi.fn()
    const onModeChange = vi.fn()
    const rendered = await renderPromptInput({
      input: '',
      onInputChange,
      onModeChange,
    })

    try {
      const baseProps = await waitForPromptInputProps()

      ;(baseProps.onPaste as (value: string) => void)('!npm test')
      expect(onModeChange).toHaveBeenCalledWith('bash')
      expect(onInputChange).toHaveBeenCalledWith('npm test')

      await rendered.rerender({
        input: 'prefix',
        onInputChange,
        onModeChange,
      })
      ;(harness.baseProps?.onPaste as (value: string) => void)(
        '/dragged/file x',
      )
      expect(onInputChange).toHaveBeenCalledWith(
        expect.stringContaining(' @"/dragged/file x" '),
      )
    } finally {
      await rendered.dispose()
    }
  })

  test('reports external editor returned errors and thrown failures', async () => {
    harness.editPromptResult = { content: null, error: 'editor exited' }
    const rendered = await renderPromptInput({ input: 'draft' })

    try {
      await harness.keybindings['chat:externalEditor']?.()
      expect(harness.addNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          key: 'external-editor-error',
          text: 'editor exited',
        }),
      )

      harness.addNotification.mockClear()
      harness.editPromptError = new Error('spawn failed')
      await harness.keybindings['chat:externalEditor']?.()
      expect(harness.addNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          key: 'external-editor-error',
          text: 'External editor failed: Error: spawn failed',
        }),
      )
    } finally {
      await rendered.dispose()
    }
  })

  test('falls through direct message misses and routes active teammate input', async () => {
    harness.isAgentSwarmsEnabled = true
    harness.directMessage = { message: 'hello', recipientName: 'unknown' }
    harness.directMessageResult = {
      error: 'no_team_context',
      success: false,
    }
    const onSubmit = vi.fn(async () => {})
    const rendered = await renderPromptInput({
      input: '@unknown hello',
      onSubmit,
    })

    try {
      const baseProps = await waitForPromptInputProps()
      await (baseProps.onSubmit as (value: string) => Promise<void>)(
        '@unknown hello',
      )
      expect(onSubmit).toHaveBeenCalledWith(
        '@unknown hello',
        expect.anything(),
        undefined,
        expect.objectContaining({ mode: 'prompt' }),
      )
    } finally {
      await rendered.dispose()
    }

    harness.reset()
    harness.activeAgent = { task: { id: 'agent-task' }, type: 'worker' }
    const onAgentSubmit = vi.fn(async () => {})
    const leaderSubmit = vi.fn(async () => {})
    const teammateRendered = await renderPromptInput({
      input: 'status',
      onAgentSubmit,
      onSubmit: leaderSubmit,
    })

    try {
      const baseProps = await waitForPromptInputProps()
      await (baseProps.onSubmit as (value: string) => Promise<void>)('status')

      expect(leaderSubmit).not.toHaveBeenCalled()
      expect(onAgentSubmit).toHaveBeenCalledWith(
        'status',
        { id: 'agent-task' },
        expect.objectContaining({
          clearBuffer: harness.clearBuffer,
          resetHistory: expect.any(Function),
        }),
      )
    } finally {
      await teammateRendered.dispose()
    }
  })

  test('accepts and declines the first-time auto-mode dialog', async () => {
    harness.features.TRANSCRIPT_CLASSIFIER = true
    harness.hasAutoModeOptIn = false
    harness.nextPermissionMode = 'auto'
    const setToolPermissionContext = vi.fn()
    const rendered = await renderPromptInput({ setToolPermissionContext })

    try {
      await waitForPromptInputProps()
      harness.keybindings['chat:cycleMode']?.()
      await waitFor(
        () => harness.autoModeOptInProps !== undefined,
        'auto mode dialog did not render',
      )

      ;(harness.autoModeOptInProps?.onAccept as () => void)()
      expect(harness.transitionPermissionMode).toHaveBeenCalledWith(
        'default',
        'auto',
        expect.objectContaining({ mode: 'default' }),
      )
      expect(setToolPermissionContext).toHaveBeenLastCalledWith(
        expect.objectContaining({
          mode: 'auto',
          transitioned: true,
        }),
      )
    } finally {
      await rendered.dispose()
    }

    harness.reset()
    harness.features.TRANSCRIPT_CLASSIFIER = true
    harness.hasAutoModeOptIn = false
    harness.nextPermissionMode = 'auto'
    const declineSetToolPermissionContext = vi.fn()
    const declineRendered = await renderPromptInput({
      setToolPermissionContext: declineSetToolPermissionContext,
    })

    try {
      await waitForPromptInputProps()
      harness.keybindings['chat:cycleMode']?.()
      await waitFor(
        () => harness.autoModeOptInProps !== undefined,
        'auto mode dialog did not render for decline',
      )

      ;(harness.autoModeOptInProps?.onDecline as () => void)()
      expect(harness.setAutoModeActive).toHaveBeenCalledWith(false)
      expect(declineSetToolPermissionContext).toHaveBeenLastCalledWith(
        expect.objectContaining({
          isAutoModeAvailable: false,
          mode: 'default',
        }),
      )
    } finally {
      await declineRendered.dispose()
    }
  })

  test('cycles viewed teammate permission mode without touching the leader mode', async () => {
    harness.isAgentSwarmsEnabled = true
    harness.nextPermissionMode = 'plan'
    harness.appState.viewingAgentTaskId = 'worker-1'
    harness.viewedTeammate = {
      id: 'worker-1',
      identity: { agentName: 'worker', color: 'cyan' },
      permissionMode: 'default',
    }
    harness.appState.tasks = {
      'worker-1': {
        id: 'worker-1',
        permissionMode: 'default',
        type: 'in_process_teammate',
      },
    }
    const setToolPermissionContext = vi.fn()
    const rendered = await renderPromptInput({ setToolPermissionContext })

    try {
      await waitForPromptInputProps()

      harness.keybindings['chat:cycleMode']?.()

      expect(harness.appState.tasks['worker-1']).toEqual(
        expect.objectContaining({
          permissionMode: 'plan',
        }),
      )
      expect(setToolPermissionContext).not.toHaveBeenCalled()
      expect(harness.appState.toolPermissionContext.mode).toBe('default')
    } finally {
      await rendered.dispose()
    }
  })

})
