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

function makeLocalAgentTask(overrides: Record<string, unknown> = {}) {
  return {
    id: 'local-agent-task',
    type: 'local_agent',
    status: 'running',
    description: 'Local agent background work',
    startTime: Date.now() - 45_000,
    outputFile: 'urn:agenc:task:local-agent-task:output',
    outputOffset: 0,
    notified: false,
    agentId: 'local-agent-1',
    agentType: 'planner',
    model: 'local-model',
    prompt: 'Review the task queue',
    retrieved: false,
    pendingMessages: ['Follow up once complete'],
    messages: ['Captured implementation notes'],
    error: 'retryable tool failure',
    result: { summary: 'ready' },
    progress: {
      toolUseCount: 2,
      tokenCount: 3456,
      recentActivities: [
        {
          toolName: 'read',
          input: {
            path: 'runtime/src/tui/components/tasks/BackgroundTasksPanel.tsx',
          },
        },
      ],
    },
    lastReportedToolCount: 2,
    lastReportedTokenCount: 3456,
    isBackgrounded: true,
    retain: false,
    diskLoaded: false,
    ...overrides,
  }
}

describe('BackgroundTasksPanel local agent coverage', () => {
  beforeEach(() => {
    appStateMock.state = { tasks: {} }
    appStateMock.setAppState.mockClear()
    terminalSizeMock.size = { columns: 120, rows: 32 }
    inputHandler.current = undefined
    killTaskMock.mockClear()
    killAsyncAgentMock.mockClear()
    requestTeammateShutdownMock.mockClear()
  })

  it('renders local agent detail rows and stops the selected local agent task', async () => {
    appStateMock.state = {
      tasks: {
        'local-agent-task': makeLocalAgentTask(),
      },
    }

    const { BackgroundTasksPanel } = await import('./BackgroundTasksPanel.js')

    const output = await renderToString(
      <BackgroundTasksPanel initialDetailTaskId="local-agent-task" />,
      120,
    )

    expect(output).toContain('TASK DETAIL')
    expect(output).toContain('local-agent-1 · planner')
    expect(output).toContain('local-model')
    expect(output).toContain('Review the task queue')
    expect(output).toContain('Follow up once complete')
    expect(output).toContain('Captured implementation notes')
    expect(output).toContain('retryable tool failure')
    expect(output).toContain('"summary":"ready"')
    expect(output).toContain(
      'read {"path":"runtime/src/tui/components/tasks/BackgroundTasksPanel.tsx"}',
    )

    if (!inputHandler.current) {
      throw new Error('BackgroundTasksPanel did not register input handling')
    }
    inputHandler.current('x', key())

    expect(killAsyncAgentMock).toHaveBeenCalledWith(
      'local-agent-task',
      appStateMock.setAppState,
    )
    expect(killTaskMock).not.toHaveBeenCalled()
    expect(requestTeammateShutdownMock).not.toHaveBeenCalled()
  })
})
