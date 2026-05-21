import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { renderToString } from '../../../utils/staticRender.js'

const appStateMock = vi.hoisted(() => ({
  state: { tasks: {} as Record<string, unknown> },
  setAppState: vi.fn(),
}))

const inputHandler = vi.hoisted(() => ({
  current: undefined as
    | undefined
    | ((input: string, key: Record<string, boolean>) => void),
}))

const terminalSizeMock = vi.hoisted(() => ({
  size: { columns: 120, rows: 32 },
}))

const killTaskMock = vi.hoisted(() => vi.fn())
const killAsyncAgentMock = vi.hoisted(() => vi.fn())
const requestTeammateShutdownMock = vi.hoisted(() => vi.fn())

vi.mock('../../state/AppState.js', () => ({
  useAppState: (selector: (state: typeof appStateMock.state) => unknown) =>
    selector(appStateMock.state),
  useSetAppState: () => appStateMock.setAppState,
}))

vi.mock('../../hooks/useTerminalSize.js', () => ({
  useTerminalSize: () => terminalSizeMock.size,
}))

vi.mock('../../ink.js', async () => {
  const actual = await vi.importActual<typeof import('../../ink.js')>(
    '../../ink.js',
  )
  return {
    ...actual,
    useInput: (
      handler: (input: string, key: Record<string, boolean>) => void,
    ) => {
      inputHandler.current = handler
    },
  }
})

vi.mock('../../../tasks/LocalShellTask/killShellTasks.js', () => ({
  killTask: killTaskMock,
}))

vi.mock('../../../tasks/LocalAgentTask/LocalAgentTask.js', () => ({
  killAsyncAgent: killAsyncAgentMock,
}))

vi.mock('../../../tasks/InProcessTeammateTask/InProcessTeammateTask.js', () => ({
  requestTeammateShutdown: requestTeammateShutdownMock,
}))

function key(overrides: Record<string, boolean> = {}) {
  return {
    upArrow: false,
    downArrow: false,
    leftArrow: false,
    rightArrow: false,
    return: false,
    escape: false,
    ...overrides,
  }
}

function makeTeammateTask(overrides: Record<string, unknown> = {}) {
  return {
    id: 'teammate-1',
    type: 'in_process_teammate',
    status: 'running',
    description: 'Review implementation plan',
    startTime: Date.now() - 72_000,
    outputFile: 'urn:agenc:task:teammate-1:output',
    outputOffset: 0,
    notified: false,
    identity: {
      agentId: 'agent-reviewer',
      agentName: 'Reviewer',
      teamName: 'planning',
      planModeRequired: true,
      parentSessionId: 'parent-session',
    },
    prompt: 'Review the staged changes',
    model: 'review-model',
    awaitingPlanApproval: true,
    permissionMode: 'plan',
    pendingUserMessages: ['Please check edge cases'],
    messages: [{ role: 'assistant', content: 'Found one ordering issue' }],
    progress: {
      toolUseCount: 3,
      tokenCount: 1200,
      lastActivity: {
        activityDescription: 'reading related tests',
      },
      recentActivities: [
        { toolName: 'read', input: { path: 'runtime/src/tui' } },
      ],
    },
    isIdle: false,
    shutdownRequested: true,
    lastReportedToolCount: 3,
    lastReportedTokenCount: 1200,
    ...overrides,
  }
}

describe('BackgroundTasksPanel coverage', () => {
  beforeEach(() => {
    appStateMock.state = { tasks: {} }
    appStateMock.setAppState.mockClear()
    terminalSizeMock.size = { columns: 120, rows: 32 }
    inputHandler.current = undefined
    killTaskMock.mockClear()
    killAsyncAgentMock.mockClear()
    requestTeammateShutdownMock.mockClear()
  })

  it('renders teammate detail rows and stops the selected teammate task', async () => {
    appStateMock.state = {
      tasks: {
        'teammate-1': makeTeammateTask(),
      },
    }

    const { BackgroundTasksPanel } = await import('./BackgroundTasksPanel.js')

    const output = await renderToString(
      <BackgroundTasksPanel initialDetailTaskId="teammate-1" />,
      120,
    )

    expect(output).toContain('TASK DETAIL')
    expect(output).toContain('identity')
    expect(output).toContain('Reviewer · Agent')
    expect(output).toContain('agent-reviewer')
    expect(output).toContain('awaiting plan approval')
    expect(output).toContain('shutdown requested')
    expect(output).toContain('reading related tests')
    expect(output).toContain('Please check edge cases')

    if (!inputHandler.current) {
      throw new Error('BackgroundTasksPanel did not register input handling')
    }
    inputHandler.current('x', key())

    expect(requestTeammateShutdownMock).toHaveBeenCalledWith(
      'teammate-1',
      appStateMock.setAppState,
    )
    expect(killTaskMock).not.toHaveBeenCalled()
    expect(killAsyncAgentMock).not.toHaveBeenCalled()
  })
})
