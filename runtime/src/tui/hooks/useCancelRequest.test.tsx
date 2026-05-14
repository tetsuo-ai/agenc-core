import React from 'react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { renderToString } from '../../utils/staticRender.js'
import type { SpinnerMode } from '../components/spinner/types.js'

const fixture = vi.hoisted(() => ({
  state: {
    tasks: {} as Record<string, any>,
    viewSelectionMode: 'none',
  },
  queuedCommandsLength: 0,
  hasCommandsInQueue: false,
  overlayActive: false,
  handlers: new Map<string, { handler: () => void; isActive?: boolean }>(),
  notifications: {
    addNotification: vi.fn(),
    removeNotification: vi.fn(),
  },
  killAllRunningAgentTasks: vi.fn(),
  markAgentsNotified: vi.fn(),
  enqueuePendingNotification: vi.fn(),
  emitTaskTerminatedSdk: vi.fn(),
  onCancel: vi.fn(),
  onAgentsKilled: vi.fn(),
}))

const analyticsMock = vi.hoisted(() => ({
  logEvent: vi.fn(),
}))

vi.mock('bun:bundle', () => ({
  feature: () => false,
}))

vi.mock('../../services/analytics/index.js', () => ({
  logEvent: analyticsMock.logEvent,
}))

vi.mock('../state/AppState.js', () => ({
  useAppStateStore: () => ({
    getState: () => fixture.state,
    setState: (updater: (prev: typeof fixture.state) => typeof fixture.state) => {
      fixture.state = updater(fixture.state)
    },
  }),
  useSetAppState: () => (
    updater: (prev: typeof fixture.state) => typeof fixture.state,
  ) => {
    fixture.state = updater(fixture.state)
  },
  useAppState: (selector: (state: typeof fixture.state) => unknown) =>
    selector(fixture.state),
}))

vi.mock('../components/PromptInput/utils.js', () => ({
  isVimModeEnabled: () => false,
}))

vi.mock('../context/notifications', () => ({
  useNotifications: () => fixture.notifications,
}))

vi.mock('../context/overlayContext', () => ({
  useIsOverlayActive: () => fixture.overlayActive,
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
    fixture.handlers.set(action, { handler, isActive: options?.isActive })
  },
}))

vi.mock('../state/teammateViewHelpers', () => ({
  exitTeammateView: vi.fn(),
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

function runningAgent(id = 'agent_1'): Record<string, unknown> {
  return {
    id,
    type: 'local_agent',
    status: 'running',
    description: 'inspect status bar',
    toolUseId: 'tool_1',
  }
}

function pendingAgent(id = 'agent_1'): Record<string, unknown> {
  return {
    ...runningAgent(id),
    status: 'pending',
  }
}

async function renderHandler(
  overrides: {
    readonly abortSignal?: AbortSignal
    readonly streamMode?: SpinnerMode
  } = {},
): Promise<void> {
  const { CancelRequestHandler } = await import('./useCancelRequest.js')
  await renderToString(
    <CancelRequestHandler
      setToolUseConfirmQueue={vi.fn()}
      onCancel={fixture.onCancel}
      onAgentsKilled={fixture.onAgentsKilled}
      isMessageSelectorVisible={false}
      screen="prompt"
      {...overrides}
    />,
    100,
  )
}

describe('CancelRequestHandler local-agent cancellation visibility', () => {
  beforeEach(() => {
    fixture.state = {
      tasks: {
        agent_1: runningAgent(),
      },
      viewSelectionMode: 'none',
    }
    fixture.queuedCommandsLength = 0
    fixture.hasCommandsInQueue = false
    fixture.overlayActive = false
    fixture.handlers.clear()
    fixture.notifications.addNotification.mockClear()
    fixture.notifications.removeNotification.mockClear()
    fixture.killAllRunningAgentTasks.mockClear()
    fixture.markAgentsNotified.mockClear()
    fixture.enqueuePendingNotification.mockClear()
    fixture.emitTaskTerminatedSdk.mockClear()
    fixture.onCancel.mockClear()
    fixture.onAgentsKilled.mockClear()
    analyticsMock.logEvent.mockClear()
  })

  test('logs the visible stream mode when cancelling an active turn', async () => {
    const abortController = new AbortController()

    await renderHandler({
      abortSignal: abortController.signal,
      streamMode: 'thinking',
    })

    const cancel = fixture.handlers.get('chat:cancel')
    expect(cancel?.isActive).toBe(true)

    cancel?.handler()

    expect(analyticsMock.logEvent).toHaveBeenCalledWith('agenc_cancel', {
      source: 'escape',
      streamMode: 'thinking',
    })
    expect(fixture.onCancel).toHaveBeenCalled()
  })

  test('Escape is active during local-agent-only work and shows a visible cancel path', async () => {
    await renderHandler()

    const cancel = fixture.handlers.get('chat:cancel')
    expect(cancel?.isActive).toBe(true)

    cancel?.handler()

    expect(fixture.onCancel).not.toHaveBeenCalled()
    expect(fixture.notifications.addNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'agents-running-cancel-hint',
        text: 'Background agents are active. Press ctrl+x ctrl+k twice to stop them',
      }),
    )
  })

  test('Escape is active while a local agent is starting', async () => {
    fixture.state.tasks = {
      agent_1: pendingAgent(),
    }

    await renderHandler()

    const cancel = fixture.handlers.get('chat:cancel')
    expect(cancel?.isActive).toBe(true)

    cancel?.handler()

    expect(fixture.onCancel).not.toHaveBeenCalled()
    expect(fixture.notifications.addNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'agents-running-cancel-hint',
        text: 'Background agents are active. Press ctrl+x ctrl+k twice to stop them',
      }),
    )
  })

  test('the kill-agents chord confirms first and then stops running local agents', async () => {
    await renderHandler()

    const killAgents = fixture.handlers.get('chat:killAgents')
    expect(killAgents).toBeDefined()

    killAgents?.handler()
    expect(fixture.notifications.addNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'kill-agents-confirm',
        text: 'Press ctrl+x ctrl+k again to stop background agents',
      }),
    )
    expect(fixture.killAllRunningAgentTasks).not.toHaveBeenCalled()

    killAgents?.handler()

    expect(fixture.notifications.removeNotification).toHaveBeenCalledWith(
      'kill-agents-confirm',
    )
    expect(fixture.killAllRunningAgentTasks).toHaveBeenCalledWith(
      fixture.state.tasks,
      expect.any(Function),
    )
    expect(fixture.markAgentsNotified).toHaveBeenCalledWith(
      'agent_1',
      expect.any(Function),
    )
    expect(fixture.emitTaskTerminatedSdk).toHaveBeenCalledWith('agent_1', 'stopped', {
      toolUseId: 'tool_1',
      summary: 'inspect status bar',
    })
    expect(fixture.enqueuePendingNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'task-notification',
        value: 'Background agent "inspect status bar" was stopped by the user.',
      }),
    )
    expect(fixture.onAgentsKilled).toHaveBeenCalledTimes(1)
  })

  test('the kill-agents chord can stop starting local agents', async () => {
    fixture.state.tasks = {
      agent_1: pendingAgent(),
    }

    await renderHandler()

    const killAgents = fixture.handlers.get('chat:killAgents')
    killAgents?.handler()
    killAgents?.handler()

    expect(fixture.notifications.addNotification).not.toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'kill-agents-none',
      }),
    )
    expect(fixture.killAllRunningAgentTasks).toHaveBeenCalledWith(
      fixture.state.tasks,
      expect.any(Function),
    )
    expect(fixture.onAgentsKilled).toHaveBeenCalledWith([
      { taskId: 'agent_1', description: 'inspect status bar' },
    ])
  })
})
