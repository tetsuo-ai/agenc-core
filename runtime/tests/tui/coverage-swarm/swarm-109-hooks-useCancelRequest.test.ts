import React from 'react'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import { renderToString } from 'src/utils/staticRender.js'

type AppState = {
  tasks: Record<string, any>
  viewSelectionMode: string
}

type CapturedKeybinding = {
  handler: () => void
  isActive?: boolean
}

const fixture = vi.hoisted(() => ({
  state: {
    tasks: {} as Record<string, any>,
    viewSelectionMode: 'none',
  } as AppState,
  queuedCommandsLength: 0,
  hasCommandsInQueue: false,
  overlayActive: false,
  vimEnabled: false,
  keybindings: new Map<string, CapturedKeybinding>(),
  addNotification: vi.fn(),
  removeNotification: vi.fn(),
  clearCommandQueue: vi.fn(),
  enqueuePendingNotification: vi.fn(),
  emitTaskTerminatedSdk: vi.fn(),
  exitTeammateView: vi.fn(),
  killAllRunningAgentTasks: vi.fn(),
  markAgentsNotified: vi.fn(),
  onAgentsKilled: vi.fn(),
  onCancel: vi.fn(),
  popCommandFromQueue: vi.fn(),
  setToolUseConfirmQueue: vi.fn(),
}))

vi.mock('bun:bundle', () => ({
  feature: () => false,
}))

vi.mock('src/tui/state/AppState.js', () => ({
  useAppState: (selector: (state: AppState) => unknown) =>
    selector(fixture.state),
  useAppStateStore: () => ({
    getState: () => fixture.state,
  }),
  useSetAppState: () => (updater: AppState | ((prev: AppState) => AppState)) => {
    fixture.state =
      typeof updater === 'function' ? updater(fixture.state) : updater
  },
}))

vi.mock('src/tui/components/PromptInput/utils.js', () => ({
  isVimModeEnabled: () => fixture.vimEnabled,
}))

vi.mock('src/tui/context/notifications', () => ({
  useNotifications: () => ({
    addNotification: fixture.addNotification,
    removeNotification: fixture.removeNotification,
  }),
}))

vi.mock('src/tui/context/overlayContext', () => ({
  useIsOverlayActive: () => fixture.overlayActive,
  // the hook's Escape guard now keys off the modal-only variant
  useIsModalOverlayActive: () => fixture.overlayActive,
}))

vi.mock('src/tui/hooks/useCommandQueue', () => ({
  useCommandQueue: () => ({ length: fixture.queuedCommandsLength }),
}))

vi.mock('src/tui/keybindings/shortcutFormat.js', () => ({
  getShortcutDisplay: () => 'ctrl+x ctrl+k',
}))

vi.mock('src/tui/keybindings/useKeybinding.js', () => ({
  useKeybinding: (
    action: string,
    handler: () => void,
    options?: { readonly isActive?: boolean },
  ) => {
    fixture.keybindings.set(action, {
      handler,
      isActive: options?.isActive,
    })
  },
  // useCancelRequest also registers a raw urgent-cancel input capture;
  // these tests drive handlers through fixture.keybindings, so a no-op
  // capture is sufficient (without it the module mock is missing an
  // export and the hook render throws before registering any binding).
  useInputCapture: () => {},
}))

vi.mock('src/tui/state/teammateViewHelpers', () => ({
  exitTeammateView: (...args: unknown[]) => fixture.exitTeammateView(...args),
}))

vi.mock('src/tasks/LocalAgentTask/LocalAgentTask', () => ({
  killAllRunningAgentTasks: (...args: unknown[]) =>
    fixture.killAllRunningAgentTasks(...args),
  markAgentsNotified: (...args: unknown[]) =>
    fixture.markAgentsNotified(...args),
}))

vi.mock('src/utils/messageQueueManager.js', () => ({
  clearCommandQueue: (...args: unknown[]) => fixture.clearCommandQueue(...args),
  enqueuePendingNotification: (...args: unknown[]) =>
    fixture.enqueuePendingNotification(...args),
  hasCommandsInQueue: () => fixture.hasCommandsInQueue,
}))

vi.mock('src/utils/sdkEventQueue.js', () => ({
  emitTaskTerminatedSdk: (...args: unknown[]) =>
    fixture.emitTaskTerminatedSdk(...args),
}))

function runningAgent(
  id: string,
  description: string,
  toolUseId: string,
): Record<string, unknown> {
  return {
    id,
    type: 'local_agent',
    status: 'running',
    description,
    toolUseId,
  }
}

function getKeybinding(action: string): CapturedKeybinding {
  const keybinding = fixture.keybindings.get(action)
  if (keybinding === undefined) {
    throw new Error(`Missing keybinding: ${action}`)
  }
  return keybinding
}

async function renderHandler(
  overrides: {
    readonly abortSignal?: AbortSignal
    readonly inputMode?: 'bash' | 'prompt' | 'orphaned-permission'
    readonly inputValue?: string
    readonly isHelpOpen?: boolean
    readonly isLocalJSXCommand?: boolean
    readonly isMessageSelectorVisible?: boolean
    readonly isSearchingHistory?: boolean
    readonly popCommandFromQueue?: () => void
    readonly screen?: 'prompt' | 'transcript'
    readonly vimMode?: 'INSERT' | 'NORMAL'
  } = {},
): Promise<void> {
  const { CancelRequestHandler } = await import(
    'src/tui/hooks/useCancelRequest.js'
  )

  await renderToString(
    React.createElement(CancelRequestHandler, {
      setToolUseConfirmQueue: fixture.setToolUseConfirmQueue,
      onCancel: fixture.onCancel,
      onAgentsKilled: fixture.onAgentsKilled,
      isMessageSelectorVisible: false,
      screen: 'prompt',
      popCommandFromQueue: fixture.popCommandFromQueue,
      ...overrides,
    }),
    100,
  )
}

describe('CancelRequestHandler coverage swarm 109', () => {
  beforeEach(() => {
    fixture.state = {
      tasks: {},
      viewSelectionMode: 'none',
    }
    fixture.queuedCommandsLength = 0
    fixture.hasCommandsInQueue = false
    fixture.overlayActive = false
    fixture.vimEnabled = false
    fixture.keybindings.clear()
    vi.clearAllMocks()
  })

  test('Escape pops a queued command while idle instead of cancelling the turn', async () => {
    fixture.queuedCommandsLength = 1
    fixture.hasCommandsInQueue = true

    await renderHandler()

    const cancel = getKeybinding('chat:cancel')
    expect(cancel.isActive).toBe(true)

    cancel.handler()

    expect(fixture.popCommandFromQueue).toHaveBeenCalledTimes(1)
    expect(fixture.onCancel).not.toHaveBeenCalled()
    expect(fixture.setToolUseConfirmQueue).not.toHaveBeenCalled()
  })

  test('queued-command fallback cancels when no pop handler was supplied', async () => {
    fixture.queuedCommandsLength = 1
    fixture.hasCommandsInQueue = true

    await renderHandler({ popCommandFromQueue: undefined })

    const cancel = getKeybinding('chat:cancel')
    expect(cancel.isActive).toBe(true)

    cancel.handler()

    expect(fixture.popCommandFromQueue).not.toHaveBeenCalled()
    expect(fixture.setToolUseConfirmQueue).toHaveBeenCalledWith(
      expect.any(Function),
    )
    expect(fixture.onCancel).toHaveBeenCalledTimes(1)
  })

  test('Escape and Ctrl+C both stay available for an active turn in bash mode with empty input', async () => {
    const abortController = new AbortController()

    await renderHandler({
      abortSignal: abortController.signal,
      inputMode: 'bash',
      inputValue: '',
    })

    // An active turn overrides the Escape-to-mode-exit deferral so the user
    // can always interrupt AgenC (98af9cb21 / 2af458c7e).
    expect(getKeybinding('chat:cancel').isActive).toBe(true)
    expect(getKeybinding('app:interrupt').isActive).toBe(true)

    getKeybinding('app:interrupt').handler()

    expect(fixture.onCancel).toHaveBeenCalledTimes(1)
    expect(fixture.setToolUseConfirmQueue).toHaveBeenCalledWith(
      expect.any(Function),
    )
  })

  test('Escape defers to mode exit while idle in bash mode, keeping Ctrl+C for the queue', async () => {
    fixture.queuedCommandsLength = 1
    fixture.hasCommandsInQueue = true

    await renderHandler({
      inputMode: 'bash',
      inputValue: '',
    })

    // Without an active turn, Escape exits the special input mode
    // (PromptInput handles it) even though a command is queued; Ctrl+C is
    // unaffected by the mode-exit deferral and can still manage the queue.
    expect(getKeybinding('chat:cancel').isActive).toBe(false)
    expect(getKeybinding('app:interrupt').isActive).toBe(true)
  })

  test.each([
    ['history search', { isSearchingHistory: true }],
    ['message selector', { isMessageSelectorVisible: true }],
    ['local JSX command', { isLocalJSXCommand: true }],
    ['help dialog', { isHelpOpen: true }],
    ['overlay', {}, true],
  ])(
    'deactivates cancel keybindings while %s handles Escape',
    async (_name, overrides, overlayActive = false) => {
      fixture.overlayActive = overlayActive
      const abortController = new AbortController()

      await renderHandler({
        abortSignal: abortController.signal,
        ...overrides,
      })

      expect(getKeybinding('chat:cancel').isActive).toBe(false)
      expect(getKeybinding('app:interrupt').isActive).toBe(false)
    },
  )

  // transcript screen and vim INSERT only claim Escape while AgenC is idle;
  // during an active turn the interrupt keys stay live (98af9cb21).
  test.each([
    ['transcript screen', { screen: 'transcript' as const }, false],
    ['vim insert mode', { vimMode: 'INSERT' as const }, true],
  ])(
    'keeps cancel keybindings active during an active turn despite %s',
    async (_name, overrides, vimEnabled) => {
      fixture.vimEnabled = vimEnabled
      const abortController = new AbortController()

      await renderHandler({
        abortSignal: abortController.signal,
        ...overrides,
      })

      expect(getKeybinding('chat:cancel').isActive).toBe(true)
      expect(getKeybinding('app:interrupt').isActive).toBe(true)
    },
  )

  test.each([
    ['transcript screen', { screen: 'transcript' as const }, false],
    ['vim insert mode', { vimMode: 'INSERT' as const }, true],
  ])(
    'defers cancel keybindings to %s while idle even with queued commands',
    async (_name, overrides, vimEnabled) => {
      fixture.vimEnabled = vimEnabled
      fixture.queuedCommandsLength = 1
      fixture.hasCommandsInQueue = true

      await renderHandler(overrides)

      expect(getKeybinding('chat:cancel').isActive).toBe(false)
      expect(getKeybinding('app:interrupt').isActive).toBe(false)
    },
  )

  test('kill-agents chord reports when there are no stoppable background agents', async () => {
    fixture.state.tasks = {
      finished: {
        id: 'finished',
        type: 'local_agent',
        status: 'completed',
        description: 'finished task',
      },
    }

    await renderHandler()

    getKeybinding('chat:killAgents').handler()

    expect(fixture.addNotification).toHaveBeenCalledWith({
      key: 'kill-agents-none',
      text: 'No background agents to stop',
      priority: 'immediate',
      timeoutMs: 2000,
    })
    expect(fixture.killAllRunningAgentTasks).not.toHaveBeenCalled()
    expect(fixture.clearCommandQueue).not.toHaveBeenCalled()
  })

  test('kill-agents confirmation expires before stopping agents', async () => {
    fixture.state.tasks = {
      agent_1: runningAgent('agent_1', 'inspect status bar', 'tool_1'),
    }
    const nowSpy = vi.spyOn(Date, 'now')
    nowSpy.mockReturnValueOnce(1_000).mockReturnValueOnce(4_500)

    try {
      await renderHandler()

      const killAgents = getKeybinding('chat:killAgents')
      killAgents.handler()
      killAgents.handler()

      expect(fixture.addNotification).toHaveBeenCalledTimes(2)
      expect(fixture.addNotification).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          key: 'kill-agents-confirm',
        }),
      )
      expect(fixture.removeNotification).not.toHaveBeenCalled()
      expect(fixture.clearCommandQueue).not.toHaveBeenCalled()
      expect(fixture.killAllRunningAgentTasks).not.toHaveBeenCalled()
    } finally {
      nowSpy.mockRestore()
    }
  })
})
