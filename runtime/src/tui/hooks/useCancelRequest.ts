/**
 * CancelRequestHandler component for handling cancel/escape keybinding.
 *
 * Must be rendered inside KeybindingSetup to have access to the keybinding context.
 * This component renders nothing - it just registers the cancel keybinding handler.
 */
import { useCallback, useLayoutEffect, useRef } from 'react'
import {
  useAppState,
  useAppStateStore,
  useSetAppState,
} from '../state/AppState.js'
import { isVimModeEnabled } from '../components/PromptInput/utils.js'
import type { ToolUseConfirm } from '../permission-types.js'
import type { SpinnerMode } from '../components/spinner/types.js'
import { useNotifications } from '../context/notifications'
import { useIsModalOverlayActive } from '../context/overlayContext'
import { useCommandQueue } from './useCommandQueue'
import { getShortcutDisplay } from '../keybindings/shortcutFormat.js'
import { useInputCapture, useKeybinding } from '../keybindings/useKeybinding.js'
import { useInput } from '../ink.js'
import type { Screen } from '../types/screen.js'
import { exitTeammateView } from '../state/teammateViewHelpers'
import {
  killAllRunningAgentTasks,
  markAgentsNotified,
} from '../../tasks/LocalAgentTask/LocalAgentTask'
import type { PromptInputMode, VimMode } from '../../types/textInputTypes'
import { isStoppableLocalAgentStatus } from '../components/spinner/agentActivity.js'
import { registerUrgentCancelInputHandler } from '../urgentCancelInput.js'
import {
  clearCommandQueue,
  enqueuePendingNotification,
  hasCommandsInQueue,
} from '../../utils/messageQueueManager.js'
import { emitTaskTerminatedSdk } from '../../utils/sdkEventQueue.js'

/** Time window in ms during which a second press kills all background agents. */
const KILL_AGENTS_CONFIRM_WINDOW_MS = 3000

type CancelRequestHandlerProps = {
  setToolUseConfirmQueue: (
    f: (toolUseConfirmQueue: ToolUseConfirm[]) => ToolUseConfirm[],
  ) => void
  onCancel: () => void
  onAgentsKilled: (
    agents: readonly { taskId: string; description: string }[],
  ) => void
  isMessageSelectorVisible: boolean
  screen: Screen
  abortSignal?: AbortSignal
  popCommandFromQueue?: () => void
  vimMode?: VimMode
  isLocalJSXCommand?: boolean
  isSearchingHistory?: boolean
  isHelpOpen?: boolean
  inputMode?: PromptInputMode
  inputValue?: string
  streamMode?: SpinnerMode
  canCancelActiveTurn?: boolean
}

/**
 * Component that handles cancel requests via keybinding.
 * Renders null but registers the 'chat:cancel' keybinding handler.
 */
export function CancelRequestHandler(props: CancelRequestHandlerProps): null {
  const {
    setToolUseConfirmQueue,
    onCancel,
    onAgentsKilled,
    isMessageSelectorVisible,
    screen,
    abortSignal,
    popCommandFromQueue,
    vimMode,
    isLocalJSXCommand,
    isSearchingHistory,
    isHelpOpen,
    inputMode,
    inputValue,
    canCancelActiveTurn,
  } = props
  const store = useAppStateStore()
  const setAppState = useSetAppState()
  const queuedCommandsLength = useCommandQueue().length
  const { addNotification, removeNotification } = useNotifications()
  const lastKillAgentsPressRef = useRef<number>(0)
  const viewSelectionMode = useAppState(s => s.viewSelectionMode)
  const hasStoppableAgents = useAppState(s =>
    Object.values(s.tasks ?? {}).some(
      t => t.type === 'local_agent' && isStoppableLocalAgentStatus(t.status),
    ),
  )
  const hasActiveTurnToCancel =
    canCancelActiveTurn ?? (abortSignal !== undefined && !abortSignal.aborted)

  const handleCancel = useCallback(() => {
    // Priority 1: If there's an active task running, cancel it first
    // This takes precedence over queue management so users can always interrupt AgenC
    if (hasActiveTurnToCancel) {
      setToolUseConfirmQueue(() => [])
      onCancel()
      return
    }

    // Priority 2: Pop queue when AgenC is idle (no running task to cancel)
    if (hasCommandsInQueue()) {
      if (popCommandFromQueue) {
        popCommandFromQueue()
        return
      }
    }

    if (hasStoppableAgents) {
      const shortcut = getShortcutDisplay(
        'chat:killAgents',
        'Chat',
        'ctrl+x ctrl+k',
      )
      addNotification({
        key: 'agents-running-cancel-hint',
        text: `Background agents are active. Press ${shortcut} twice to stop them`,
        priority: 'immediate',
        timeoutMs: 3000,
      })
      return
    }

    // Fallback: nothing to cancel or pop (shouldn't reach here if isActive is correct)
    setToolUseConfirmQueue(() => [])
    onCancel()
  }, [
    hasActiveTurnToCancel,
    popCommandFromQueue,
    setToolUseConfirmQueue,
    onCancel,
    hasStoppableAgents,
    addNotification,
  ])

  // Determine if this handler should be active
  // Other contexts (Transcript, HistorySearch, Help) have their own escape handlers
  // Overlays (ModelPicker, ThinkingToggle, etc.) register themselves via useRegisterOverlay
  // Local JSX commands handle their own input
  const isModalOverlayActive = useIsModalOverlayActive()
  const hasQueuedCommands = queuedCommandsLength > 0
  // When in bash/background mode with empty input, escape should exit the mode
  // rather than cancel the request. Let PromptInput handle mode exit.
  // This only applies to Escape, not Ctrl+C which should always cancel.
  const isInSpecialModeWithEmptyInput =
    inputMode !== undefined && inputMode !== 'prompt' && !inputValue
  // When viewing a teammate's transcript, let useBackgroundTaskNavigation handle Escape
  const isViewingTeammate = viewSelectionMode === 'viewing-agent'
  const isScreenBlockingCancel = screen === 'transcript' && !hasActiveTurnToCancel
  const shouldDeferToVimInsert =
    isVimModeEnabled() && vimMode === 'INSERT' && !hasActiveTurnToCancel
  // Context guards: other screens/overlays handle their own cancel
  const isContextActive =
    !isScreenBlockingCancel &&
    !isSearchingHistory &&
    !isMessageSelectorVisible &&
    !isLocalJSXCommand &&
    !isHelpOpen &&
    !isModalOverlayActive &&
    !shouldDeferToVimInsert

  // Escape (chat:cancel) defers to mode-exit when in special mode with empty
  // input, and to useBackgroundTaskNavigation when viewing a teammate
  const shouldDeferEscapeToModeExit =
    isInSpecialModeWithEmptyInput && !hasActiveTurnToCancel
  const shouldDeferEscapeToTeammate =
    isViewingTeammate && !hasActiveTurnToCancel
  const isEscapeActive =
    isContextActive &&
    (hasActiveTurnToCancel || hasQueuedCommands || hasStoppableAgents) &&
    !shouldDeferEscapeToModeExit &&
    !shouldDeferEscapeToTeammate

  // Ctrl+C (app:interrupt): when viewing a teammate, stops everything and
  // returns to main thread. Otherwise just handleCancel. Must NOT claim
  // ctrl+c when main is idle at the prompt — that blocks the copy-selection
  // handler and double-press-to-exit from ever seeing the keypress.
  const isCtrlCActive =
    isContextActive &&
    (hasActiveTurnToCancel || hasQueuedCommands || isViewingTeammate)

  useKeybinding('chat:cancel', handleCancel, {
    context: 'Chat',
    isActive: isEscapeActive,
  })

  // Shared kill path: stop all agents, suppress per-agent notifications,
  // emit SDK events, enqueue a single aggregate model-facing notification.
  // Returns true if anything was killed.
  const killAllAgentsAndNotify = useCallback((): boolean => {
    const tasks = store.getState().tasks
    const running = Object.entries(tasks).filter(
      ([, t]) => t.type === 'local_agent' && isStoppableLocalAgentStatus(t.status),
    )
    if (running.length === 0) return false
    killAllRunningAgentTasks(tasks, setAppState)
    const killedAgents: Array<{ taskId: string; description: string }> = []
    for (const [taskId, task] of running) {
      markAgentsNotified(taskId, setAppState)
      killedAgents.push({ taskId, description: task.description })
      emitTaskTerminatedSdk(taskId, 'stopped', {
        toolUseId: task.toolUseId,
        summary: task.description,
      })
    }
    const descriptions = killedAgents.map(agent => agent.description)
    const summary =
      descriptions.length === 1
        ? `Background agent "${descriptions[0]}" was stopped by the user.`
        : `${descriptions.length} background agents were stopped by the user: ${descriptions.map(d => `"${d}"`).join(', ')}.`
    enqueuePendingNotification({ value: summary, mode: 'task-notification' })
    onAgentsKilled(killedAgents)
    return true
  }, [store, setAppState, onAgentsKilled])

  // Ctrl+C (app:interrupt). Scoped to teammate-view: killing agents from the
  // main prompt stays a deliberate gesture (chat:killAgents), not a
  // side-effect of cancelling a turn.
  const handleInterrupt = useCallback(() => {
    if (isViewingTeammate) {
      killAllAgentsAndNotify()
      exitTeammateView(setAppState)
    }
    if (hasActiveTurnToCancel || hasQueuedCommands) {
      handleCancel()
    }
  }, [
    isViewingTeammate,
    killAllAgentsAndNotify,
    setAppState,
    hasActiveTurnToCancel,
    hasQueuedCommands,
    handleCancel,
  ])

  const urgentCancelRef = useRef(handleCancel)
  const urgentInterruptRef = useRef(handleInterrupt)
  const urgentEscapeActiveRef = useRef(isEscapeActive)
  const urgentCtrlCActiveRef = useRef(isCtrlCActive)

  useLayoutEffect(() => {
    urgentCancelRef.current = handleCancel
    urgentInterruptRef.current = handleInterrupt
    urgentEscapeActiveRef.current = isEscapeActive
    urgentCtrlCActiveRef.current = isCtrlCActive
  }, [handleCancel, handleInterrupt, isEscapeActive, isCtrlCActive])

  useLayoutEffect(() => {
    return registerUrgentCancelInputHandler((input, key) => {
      if (key.escape && urgentEscapeActiveRef.current) {
        urgentCancelRef.current()
        return true
      }
      if (input === 'c' && key.ctrl && urgentCtrlCActiveRef.current) {
        urgentInterruptRef.current()
        return true
      }
      return false
    })
  }, [])

  useKeybinding('app:interrupt', handleInterrupt, {
    context: 'Global',
    isActive: isCtrlCActive,
  })
  useInputCapture((input, key) => {
    if (key.escape && isEscapeActive) {
      handleCancel()
      return true
    }
    if (input === 'c' && key.ctrl && isCtrlCActive) {
      handleInterrupt()
      return true
    }
    return false
  }, {
    context: 'Chat',
    isActive: true,
  })
  useInput((input, key, event) => {
    if (key.escape && isEscapeActive) {
      handleCancel()
      event.stopImmediatePropagation()
      return
    }
    if (input === 'c' && key.ctrl && isCtrlCActive) {
      handleInterrupt()
      event.stopImmediatePropagation()
    }
  }, {
    isActive: true,
  })

  // chat:killAgents uses a two-press pattern: first press shows a
  // confirmation hint, second press within the window actually kills all
  // agents. Reads tasks from the store directly to avoid stale closures.
  const handleKillAgents = useCallback(() => {
    const tasks = store.getState().tasks
    const hasStoppableAgents = Object.values(tasks).some(
      t => t.type === 'local_agent' && isStoppableLocalAgentStatus(t.status),
    )
    if (!hasStoppableAgents) {
      addNotification({
        key: 'kill-agents-none',
        text: 'No background agents to stop',
        priority: 'immediate',
        timeoutMs: 2000,
      })
      return
    }
    const now = Date.now()
    const elapsed = now - lastKillAgentsPressRef.current
    if (elapsed <= KILL_AGENTS_CONFIRM_WINDOW_MS) {
      // Second press within window -- kill all background agents
      lastKillAgentsPressRef.current = 0
      removeNotification('kill-agents-confirm')
      clearCommandQueue()
      killAllAgentsAndNotify()
      return
    }
    // First press -- show confirmation hint in status bar
    lastKillAgentsPressRef.current = now
    const shortcut = getShortcutDisplay(
      'chat:killAgents',
      'Chat',
      'ctrl+x ctrl+k',
    )
    addNotification({
      key: 'kill-agents-confirm',
      text: `Press ${shortcut} again to stop background agents`,
      priority: 'immediate',
      timeoutMs: KILL_AGENTS_CONFIRM_WINDOW_MS,
    })
  }, [store, addNotification, removeNotification, killAllAgentsAndNotify])

  // Must stay always-active: ctrl+x is consumed as a chord prefix regardless
  // of isActive (because ctrl+x ctrl+e is always live), so an inactive handler
  // here would leak ctrl+k to readline kill-line. Handler gates internally.
  useKeybinding('chat:killAgents', handleKillAgents, {
    context: 'Chat',
  })

  return null
}
