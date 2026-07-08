import React from 'react'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import { renderToString } from '../../utils/staticRender.js'

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
  keybindings: new Map<string, CapturedKeybinding>(),
  addNotification: vi.fn(),
  removeNotification: vi.fn(),
  killAllRunningAgentTasks: vi.fn(),
  markAgentsNotified: vi.fn(),
  enqueuePendingNotification: vi.fn(),
  emitTaskTerminatedSdk: vi.fn(),
  exitTeammateView: vi.fn(),
  onAgentsKilled: vi.fn(),
  onCancel: vi.fn(),
  setToolUseConfirmQueue: vi.fn(),
}))

vi.mock('bun:bundle', () => ({
  feature: () => false,
}))

vi.mock('../state/AppState.js', () => ({
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

vi.mock('../components/PromptInput/utils.js', () => ({
  isVimModeEnabled: () => false,
}))

vi.mock('../context/notifications', () => ({
  useNotifications: () => ({
    addNotification: fixture.addNotification,
    removeNotification: fixture.removeNotification,
  }),
}))

vi.mock('../context/overlayContext', () => ({
  useIsOverlayActive: () => fixture.overlayActive,
  // the hook's Escape guard now keys off the modal-only variant
  useIsModalOverlayActive: () => fixture.overlayActive,
}))

vi.mock('./useCommandQueue', () => ({
  useCommandQueue: () => ({ length: fixture.queuedCommandsLength }),
}))

vi.mock('../keybindings/shortcutFormat.js', () => ({
  getShortcutDisplay: () => 'ctrl+x ctrl+k',
}))

vi.mock('../keybindings/useKeybinding.js', () => ({
  useKeybinding: (
    action: string,
    handler: () => void,
    options?: { isActive?: boolean },
  ) => {
    fixture.keybindings.set(action, {
      handler,
      isActive: options?.isActive,
    })
  },
  // useCancelRequest also registers a raw urgent-cancel input capture;
  // this test drives handlers through fixture.keybindings, so a no-op
  // capture is sufficient (without it the module mock is missing an
  // export and the hook render throws before registering any binding).
  useInputCapture: () => {},
}))

vi.mock('../state/teammateViewHelpers', () => ({
  exitTeammateView: (...args: unknown[]) => fixture.exitTeammateView(...args),
}))

vi.mock('../../tasks/LocalAgentTask/LocalAgentTask', () => ({
  killAllRunningAgentTasks: (...args: unknown[]) =>
    fixture.killAllRunningAgentTasks(...args),
  markAgentsNotified: (...args: unknown[]) =>
    fixture.markAgentsNotified(...args),
}))

vi.mock('../../utils/messageQueueManager.js', () => ({
  clearCommandQueue: vi.fn(),
  enqueuePendingNotification: (...args: unknown[]) =>
    fixture.enqueuePendingNotification(...args),
  hasCommandsInQueue: () => fixture.hasCommandsInQueue,
}))

vi.mock('../../utils/sdkEventQueue.js', () => ({
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

describe('CancelRequestHandler teammate-view interrupt coverage', () => {
  beforeEach(() => {
    fixture.state = {
      tasks: {
        agent_1: runningAgent('agent_1', 'inspect status bar', 'tool_1'),
        agent_2: runningAgent('agent_2', 'write summary', 'tool_2'),
      },
      viewSelectionMode: 'viewing-agent',
    }
    fixture.queuedCommandsLength = 0
    fixture.hasCommandsInQueue = false
    fixture.overlayActive = false
    fixture.keybindings.clear()
    vi.clearAllMocks()
  })

  test('Ctrl+C from teammate view stops all agents, returns to main, and cancels the active turn', async () => {
    const abortController = new AbortController()
    const { CancelRequestHandler } = await import('./useCancelRequest.js')

    await renderToString(
      <CancelRequestHandler
        setToolUseConfirmQueue={fixture.setToolUseConfirmQueue}
        onCancel={fixture.onCancel}
        onAgentsKilled={fixture.onAgentsKilled}
        isMessageSelectorVisible={false}
        screen="prompt"
        abortSignal={abortController.signal}
      />,
      100,
    )

    const interrupt = getKeybinding('app:interrupt')
    expect(interrupt.isActive).toBe(true)
    // The active turn overrides the Escape-to-teammate-navigation deferral so
    // the user can always interrupt AgenC (98af9cb21 / 2af458c7e).
    expect(getKeybinding('chat:cancel').isActive).toBe(true)

    interrupt.handler()

    expect(fixture.killAllRunningAgentTasks).toHaveBeenCalledWith(
      fixture.state.tasks,
      expect.any(Function),
    )
    expect(fixture.markAgentsNotified).toHaveBeenCalledWith(
      'agent_1',
      expect.any(Function),
    )
    expect(fixture.markAgentsNotified).toHaveBeenCalledWith(
      'agent_2',
      expect.any(Function),
    )
    expect(fixture.emitTaskTerminatedSdk).toHaveBeenCalledWith(
      'agent_1',
      'stopped',
      {
        toolUseId: 'tool_1',
        summary: 'inspect status bar',
      },
    )
    expect(fixture.emitTaskTerminatedSdk).toHaveBeenCalledWith(
      'agent_2',
      'stopped',
      {
        toolUseId: 'tool_2',
        summary: 'write summary',
      },
    )
    expect(fixture.enqueuePendingNotification).toHaveBeenCalledWith({
      value:
        '2 background agents were stopped by the user: "inspect status bar", "write summary".',
      mode: 'task-notification',
    })
    expect(fixture.onAgentsKilled).toHaveBeenCalledWith([
      { taskId: 'agent_1', description: 'inspect status bar' },
      { taskId: 'agent_2', description: 'write summary' },
    ])
    expect(fixture.exitTeammateView).toHaveBeenCalledWith(expect.any(Function))
    expect(fixture.setToolUseConfirmQueue).toHaveBeenCalledWith(
      expect.any(Function),
    )
    expect(fixture.onCancel).toHaveBeenCalledTimes(1)
  })

  test('Escape defers to teammate navigation while idle; Ctrl+C still stops agents and exits', async () => {
    const { CancelRequestHandler } = await import('./useCancelRequest.js')

    // No abortSignal: AgenC is idle, so Escape is left for
    // useBackgroundTaskNavigation even though stoppable agents exist.
    await renderToString(
      <CancelRequestHandler
        setToolUseConfirmQueue={fixture.setToolUseConfirmQueue}
        onCancel={fixture.onCancel}
        onAgentsKilled={fixture.onAgentsKilled}
        isMessageSelectorVisible={false}
        screen="prompt"
      />,
      100,
    )

    expect(getKeybinding('chat:cancel').isActive).toBe(false)
    const interrupt = getKeybinding('app:interrupt')
    expect(interrupt.isActive).toBe(true)

    interrupt.handler()

    expect(fixture.killAllRunningAgentTasks).toHaveBeenCalledTimes(1)
    expect(fixture.exitTeammateView).toHaveBeenCalledWith(expect.any(Function))
    // No active turn and no queue: nothing to cancel on the main thread.
    expect(fixture.onCancel).not.toHaveBeenCalled()
  })
})
