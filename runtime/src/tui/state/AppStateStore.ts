import type { Notification } from '../context/notifications.js'
import type { TodoList } from '../../utils/todo/types.js'
import type { Command } from '../../commands.js'
import type { ElicitationRequestEvent } from '../../services/mcp/elicitationHandler.js'
import type {
  MCPServerConnection,
  ServerResource,
} from '../../services/mcp/types.js'
import { shouldEnablePromptSuggestion } from '../../services/PromptSuggestion/promptSuggestion.js'
import {
  getEmptyToolPermissionContext,
  type Tool,
  type ToolPermissionContext,
} from '../../tools/Tool.js'
import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import type { TaskState } from '../../tasks/types.js'
import type { AgentColorName } from '../../tools/AgentTool/agentColorManager.js'
import type { AgentDefinitionsResult } from '../../tools/AgentTool/loadAgentsDir.js'
import type { AllowedPrompt } from '../../tools/ExitPlanModeTool/ExitPlanModeV2Tool.js'
import type { AgentId } from '../../types/ids.js'
import type { Message, UserMessage } from '../../types/message.js'
import type { LoadedPlugin, PluginError } from '../../types/plugin.js'
import type { DeepImmutable } from '../../types/utils.js'
import {
  type AttributionState,
  createEmptyAttributionState,
} from '../../utils/commitAttribution.js'
import type { EffortValue } from '../../utils/effort.js'
import type { FileHistoryState } from '../../utils/fileHistory.js'
import type { REPLHookContext } from '../../utils/hooks/postSamplingHooks.js'
import type { SessionHooksState } from '../../utils/hooks/sessionHooks.js'
import type { ModelSetting } from '../../utils/model/model.js'
import type { DenialTrackingState } from '../../utils/permissions/denialTracking.js'
import type { PermissionMode } from '../../utils/permissions/PermissionMode.js'
import type { WorkbenchState } from '../workbench/types.js'
import { getDefaultWorkbenchState } from '../workbench/reducer.js'
import { getInitialSettings } from '../../utils/settings/settings.js'
import type { SettingsJson } from '../../utils/settings/types.js'
import { isAgentSwarmsEnabled } from '../../utils/agentSwarmsEnabled.js'
import { shouldEnableThinkingByDefault } from '../../utils/thinking.js'
import { isPlanModeRequired, isTeammate } from '../../utils/teammate.js'
import type { Store } from './store.js'


export type CompletionBoundary =
  | { type: 'complete'; completedAt: number; outputTokens: number }
  | { type: 'bash'; command: string; completedAt: number }
  | { type: 'edit'; toolName: string; filePath: string; completedAt: number }
  | {
      type: 'denied_tool'
      toolName: string
      detail: string
      completedAt: number
    }

export type SpeculationResult = {
  messages: Message[]
  boundary: CompletionBoundary | null
  timeSavedMs: number
}

export type SpeculationState =
  | { status: 'idle' }
  | {
      status: 'active'
      id: string
      abort: () => void
      startTime: number
      messagesRef: { current: Message[] } // Mutable ref - avoids array spreading per message
      writtenPathsRef: { current: Set<string> } // Mutable ref - relative paths written to overlay
      boundary: CompletionBoundary | null
      suggestionLength: number
      toolUseCount: number
      isPipelined: boolean
      speculationEnabled?: boolean
      cwd: string
      contextRef: { current: REPLHookContext }
      pipelinedSuggestion?: {
        text: string
        promptId: 'user_intent' | 'stated_intent'
        generationRequestId: string | null
      } | null
    }

export const IDLE_SPECULATION_STATE: SpeculationState = { status: 'idle' }

export type FooterItem =
  | 'tasks'
  | 'tmux'
  | 'bagel'
  | 'teams'

export type AppState = DeepImmutable<{
  settings: SettingsJson
  verbose: boolean
  mainLoopModel: ModelSetting
  mainLoopModelForSession: ModelSetting
  statusLineText: string | undefined
  expandedView: 'none' | 'tasks' | 'teammates'
  isBriefOnly: boolean
  // Optional - only present when ENABLE_AGENT_SWARMS is true (for dead code elimination)
  showTeammateMessagePreview?: boolean
  selectedIPAgentIndex: number
  // CoordinatorTaskPanel selection: -1 = pill, 0 = main, 1..N = agent rows.
  // AppState (not local) so the panel can read it directly without prop-drilling
  // through PromptInput → PromptInputFooter.
  coordinatorTaskIndex: number
  viewSelectionMode: 'none' | 'selecting-agent' | 'viewing-agent'
  // Which footer pill is focused (arrow-key navigation below the prompt).
  // Lives in AppState so prompt-adjacent panels can read their focused state.
  footerSelection: FooterItem | null
  // Workbench navigation, active surface, and lightweight attachment state.
  workbench: WorkbenchState
  toolPermissionContext: ToolPermissionContext
  spinnerTip?: string
  // Agent name from --agent CLI flag or settings (for logo display)
  agent: string | undefined
  // Assistant mode fully enabled (settings + GrowthBook gate + trust).
  // Single source of truth - computed once in main.tsx before option
  // mutation, consumers read this instead of re-calling isAssistantMode().
  kairosEnabled: boolean
  // Remote session URL for --remote mode (shown in footer indicator)
  remoteSessionUrl: string | undefined
  // Remote session WS state (remote assistant viewer). 'connected' means the
  // live event stream is open; 'reconnecting' = transient WS drop, backoff
  // in progress; 'disconnected' = permanent close or reconnects exhausted.
  remoteConnectionStatus:
    | 'connecting'
    | 'connected'
    | 'reconnecting'
    | 'disconnected'
  // Remote assistant: count of background tasks (Agent calls, teammates,
  // workflows) running inside the REMOTE daemon child. Event-sourced from
  // system/task_started and system/task_notification on the WS. The local
  // AppState.tasks is always empty in viewer mode — the tasks live in a
  // different process.
  remoteBackgroundTaskCount: number
  // Always-on bridge: desired state (controlled by /config or footer toggle)
  replBridgeEnabled: boolean
  // Always-on bridge: true when activated via /remote-control command, false when config-driven
  replBridgeExplicit: boolean
  // Outbound-only mode: forward events to the remote bridge but reject inbound prompts/control
  replBridgeOutboundOnly: boolean
  // Always-on bridge: env registered + session created (= "Ready")
  replBridgeConnected: boolean
  // Always-on bridge: ingress WebSocket is open (= "Connected" in the remote portal)
  replBridgeSessionActive: boolean
  // Always-on bridge: poll loop is in error backoff (= "Reconnecting")
  replBridgeReconnecting: boolean
  // Always-on bridge: connect URL for Ready state (?bridge=envId)
  replBridgeConnectUrl: string | undefined
  // Always-on bridge: remote portal session URL (set when connected)
  replBridgeSessionUrl: string | undefined
  // Always-on bridge: IDs for debugging (shown in dialog when --verbose)
  replBridgeEnvironmentId: string | undefined
  replBridgeSessionId: string | undefined
  // Always-on bridge: error message when connection fails (shown in BridgeDialog)
  replBridgeError: string | undefined
  // Always-on bridge: session name set via `/remote-control <name>` (used as session title)
  replBridgeInitialName: string | undefined
  // Always-on bridge: first-time remote dialog pending (set by /remote-control command)
  showRemoteCallout: boolean
}> & {
  // Unified task state - excluded from DeepImmutable because TaskState contains function types
  tasks: { [taskId: string]: TaskState }
  // Name → AgentId registry populated by Agent tool when `name` is provided.
  // Latest-wins on collision. Used by SendMessage to route by name.
  agentNameRegistry: Map<string, AgentId>
  // Task ID that has been foregrounded - its messages are shown in main view
  foregroundedTaskId?: string
  // Task ID of in-process teammate whose transcript is being viewed (undefined = leader's view)
  viewingAgentTaskId?: string
  // Follow-up (ashwin): see if we can use utility-types DeepReadonly for this
  mcp: {
    clients: MCPServerConnection[]
    tools: Tool[]
    commands: Command[]
    resources: Record<string, ServerResource[]>
    /**
     * Incremented by session plugin refresh to trigger MCP effects to re-run
     * and pick up newly-enabled plugin MCP servers. Effects read this
     * as a dependency; the value itself is not consumed.
     */
    pluginReconnectKey: number
  }
  plugins: {
    enabled: LoadedPlugin[]
    disabled: LoadedPlugin[]
    commands: Command[]
    /**
     * Plugin system errors collected during loading and initialization.
     * See {@link PluginError} type documentation for complete details on error
     * structure, context fields, and display format.
     */
    errors: PluginError[]
    // Installation status for background plugin/marketplace installation
    installationStatus: {
      marketplaces: Array<{
        name: string
        status: 'pending' | 'installing' | 'installed' | 'failed'
        error?: string
      }>
      plugins: Array<{
        id: string
        name: string
        status: 'pending' | 'installing' | 'installed' | 'failed'
        error?: string
      }>
    }
    /**
     * Set to true when plugin state on disk has changed (background reconcile,
     * /plugin menu install, external settings edit) and active components are
     * stale. In interactive mode, user restarts AgenC to consume. In
     * headless mode, refreshPluginState() auto-consumes via refreshActivePlugins().
     */
    needsRefresh: boolean
  }
  agentDefinitions: AgentDefinitionsResult
  fileHistory: FileHistoryState
  attribution: AttributionState
  todos: { [agentId: string]: TodoList }
  notifications: {
    current: Notification | null
    queue: Notification[]
  }
  elicitation: {
    queue: ElicitationRequestEvent[]
  }
  thinkingEnabled: boolean | undefined
  promptSuggestionEnabled: boolean
  sessionHooks: SessionHooksState
  tungstenActiveSession?: {
    sessionName: string
    socketName: string
    target: string // The tmux target (e.g., "session:window.pane")
  }
  tungstenLastCapturedTime?: number // Timestamp when frame was captured for model
  tungstenLastCommand?: {
    command: string // The command string to display (e.g., "Enter", "echo hello")
    timestamp: number // When the command was sent
  }
  // Sticky tmux panel visibility — mirrors globalConfig.tungstenPanelVisible for reactivity.
  tungstenPanelVisible?: boolean
  // Transient auto-hide at turn end — separate from tungstenPanelVisible so the
  // pill stays in the footer (user can reopen) but the panel content doesn't take
  // screen space when idle. Cleared on next Tmux tool use or user toggle. NOT persisted.
  tungstenPanelAutoHidden?: boolean
  // WebBrowser tool (codename bagel): pill visible in footer
  bagelActive?: boolean
  // WebBrowser tool: current page URL shown in pill label
  bagelUrl?: string
  // WebBrowser tool: sticky panel visibility toggle
  bagelPanelVisible?: boolean
  // REPL tool VM context - persists across REPL calls for state sharing
  replContext?: {
    vmContext: import('vm').Context
    registeredTools: Map<
      string,
      {
        name: string
        description: string
        schema: Record<string, unknown>
        handler: (args: Record<string, unknown>) => Promise<unknown>
      }
    >
    console: {
      log: (...args: unknown[]) => void
      error: (...args: unknown[]) => void
      warn: (...args: unknown[]) => void
      info: (...args: unknown[]) => void
      debug: (...args: unknown[]) => void
      getStdout: () => string
      getStderr: () => string
      clear: () => void
    }
  }
  teamContext?: {
    teamName: string
    teamFilePath: string
    leadAgentId: string
    // Self-identity for swarm members (separate processes in tmux panes)
    // Note: This is different from toolUseContext.agentId which is for in-process subagents
    selfAgentId?: string // Swarm member's own ID (same as leadAgentId for leaders)
    selfAgentName?: string // Swarm member's name ('team-lead' for leaders)
    isLeader?: boolean // True if this swarm member is the team leader
    selfAgentColor?: string // Assigned color for UI (used by dynamically joined sessions)
    teammates: {
      [teammateId: string]: {
        name: string
        agentType?: string
        color?: string
        tmuxSessionName: string
        tmuxPaneId: string
        cwd: string
        worktreePath?: string
        spawnedAt: number
      }
    }
  }
  // Standalone agent context for non-swarm sessions with custom name/color
  standaloneAgentContext?: {
    name: string
    color?: AgentColorName
  }
  inbox: {
    messages: Array<{
      id: string
      from: string
      text: string
      timestamp: string
      status: 'pending' | 'processing' | 'processed'
      color?: string
      summary?: string
    }>
  }
  // Worker sandbox permission requests (leader side) - for network access approval
  workerSandboxPermissions: {
    queue: Array<{
      requestId: string
      workerId: string
      workerName: string
      workerColor?: string
      host: string
      createdAt: number
    }>
    selectedIndex: number
  }
  // Pending permission request on worker side (shown while waiting for leader approval)
  pendingWorkerRequest: {
    toolName: string
    toolUseId: string
    description: string
  } | null
  // Pending sandbox permission request on worker side
  pendingSandboxRequest: {
    requestId: string
    host: string
  } | null
  promptSuggestion: {
    text: string | null
    promptId: 'user_intent' | 'stated_intent' | null
    shownAt: number
    acceptedAt: number
    generationRequestId: string | null
  }
  speculation: SpeculationState
  speculationSessionTimeSavedMs: number
  skillImprovement: {
    suggestion: {
      skillName: string
      updates: { section: string; change: string; reason: string }[]
    } | null
  }
  // Auth version - incremented on login/logout to trigger re-fetching of auth-dependent data
  authVersion: number
  // Initial message to process (from CLI args or plan mode exit)
  // When set, REPL will process the message and trigger a query
  initialMessage: {
    message: UserMessage
    clearContext?: boolean
    mode?: PermissionMode
    // Session-scoped permission rules from plan mode (e.g., "run tests", "install dependencies")
    allowedPrompts?: AllowedPrompt[]
  } | null
  // Pending plan verification state (set when exiting plan mode)
  // Used by VerifyPlanExecution tool to trigger background verification
  pendingPlanVerification?: {
    plan: string
    verificationStarted: boolean
    verificationCompleted: boolean
  }
  // Denial tracking for classifier modes (YOLO, headless, etc.) - falls back to prompting when limits exceeded
  denialTracking?: DenialTrackingState
  // Active overlays (Select dialogs, etc.) for Escape key coordination
  activeOverlays: ReadonlySet<string>
  // Fast mode
  fastMode?: boolean
  // Advisor model for server-side advisor tool (undefined = disabled).
  advisorModel?: string
  // Effort value
  effortValue?: EffortValue
  // Swarm mode: when on, the agent is nudged to fan out divisible work to
  // parallel sub-agents by default (see the /swarm command and the
  // swarm-mode prompt attachment). Spawns still require approval per policy.
  swarmMode?: boolean
}

export type AppStateStore = Store<AppState>

export function getDefaultAppState(): AppState {
  const initialSettings = getInitialSettings()
  const initialMode: PermissionMode =
    isTeammate() && isPlanModeRequired()
      ? 'plan'
      : 'default'

  return {
    settings: initialSettings,
    tasks: {},
    agentNameRegistry: new Map(),
    verbose: false,
    mainLoopModel: null, // alias, full name (as with --model or env var), or null (default)
    mainLoopModelForSession: null,
    statusLineText: undefined,
    expandedView: 'none',
    isBriefOnly: false,
    showTeammateMessagePreview: false,
    selectedIPAgentIndex: -1,
    coordinatorTaskIndex: -1,
    viewSelectionMode: 'none',
    footerSelection: null,
    workbench: getDefaultWorkbenchState(),
    kairosEnabled: false,
    remoteSessionUrl: undefined,
    remoteConnectionStatus: 'connecting',
    remoteBackgroundTaskCount: 0,
    replBridgeEnabled: false,
    replBridgeExplicit: false,
    replBridgeOutboundOnly: false,
    replBridgeConnected: false,
    replBridgeSessionActive: false,
    replBridgeReconnecting: false,
    replBridgeConnectUrl: undefined,
    replBridgeSessionUrl: undefined,
    replBridgeEnvironmentId: undefined,
    replBridgeSessionId: undefined,
    replBridgeError: undefined,
    replBridgeInitialName: undefined,
    showRemoteCallout: false,
    toolPermissionContext: {
      ...getEmptyToolPermissionContext(),
      mode: initialMode,
    },
    agent: undefined,
    agentDefinitions: { activeAgents: [], allAgents: [] },
    fileHistory: {
      snapshots: [],
      trackedFiles: new Set(),
      snapshotSequence: 0,
    },
    attribution: createEmptyAttributionState(),
    mcp: {
      clients: [],
      tools: [],
      commands: [],
      resources: {},
      pluginReconnectKey: 0,
    },
    plugins: {
      enabled: [],
      disabled: [],
      commands: [],
      errors: [],
      installationStatus: {
        marketplaces: [],
        plugins: [],
      },
      needsRefresh: false,
    },
    todos: {},
    notifications: {
      current: null,
      queue: [],
    },
    elicitation: {
      queue: [],
    },
    thinkingEnabled: shouldEnableThinkingByDefault(),
    promptSuggestionEnabled: shouldEnablePromptSuggestion({
      ...initialSettings,
      promptSuggestionFeatureEnabled: false,
      agentSwarmsEnabled: isAgentSwarmsEnabled(),
      isNonInteractiveSession: getIsNonInteractiveSession(),
      isTeammateSession: isTeammate(),
    }),
    sessionHooks: new Map(),
    inbox: {
      messages: [],
    },
    workerSandboxPermissions: {
      queue: [],
      selectedIndex: 0,
    },
    pendingWorkerRequest: null,
    pendingSandboxRequest: null,
    promptSuggestion: {
      text: null,
      promptId: null,
      shownAt: 0,
      acceptedAt: 0,
      generationRequestId: null,
    },
    speculation: IDLE_SPECULATION_STATE,
    speculationSessionTimeSavedMs: 0,
    skillImprovement: {
      suggestion: null,
    },
    authVersion: 0,
    initialMessage: null,
    effortValue: undefined,
    // `/swarm` is persisted in user settings. A fresh TUI must reflect that
    // value immediately; waiting for a later file-change event left routing
    // enabled in the daemon while the badge and local command state said off.
    swarmMode: initialSettings.swarmMode === true,
    activeOverlays: new Set<string>(),
    fastMode: false,
  }
}
