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
  size: { columns: 100, rows: 30 },
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

function makeShellTask(overrides: Record<string, unknown> = {}) {
  return {
    id: 'b1',
    type: 'local_bash',
    status: 'running',
    description: 'Run test command',
    startTime: 10,
    outputFile: 'urn:agenc:task:b1:output',
    outputOffset: 0,
    notified: false,
    command: 'npm test',
    isBackgrounded: true,
    ...overrides,
  }
}

function makeTeammateTask(overrides: Record<string, unknown> = {}) {
  return {
    id: 't1',
    type: 'in_process_teammate',
    status: 'running',
    description: 'Teammate work',
    startTime: Date.now(),
    outputFile: 'urn:agenc:task:t1:output',
    outputOffset: 0,
    notified: false,
    identity: {
      agentId: 'teammate-1',
      agentName: 'Planner',
      teamName: 'Core',
      planModeRequired: false,
      parentSessionId: 'session-1',
    },
    prompt: 'Inspect the TUI',
    awaitingPlanApproval: false,
    permissionMode: 'default',
    pendingUserMessages: [],
    isIdle: false,
    shutdownRequested: false,
    lastReportedToolCount: 0,
    lastReportedTokenCount: 0,
    ...overrides,
  }
}

describe('BackgroundTasksPanel', () => {
  beforeEach(() => {
    appStateMock.state = { tasks: {} }
    appStateMock.setAppState.mockClear()
    terminalSizeMock.size = { columns: 100, rows: 30 }
    inputHandler.current = undefined
    killTaskMock.mockClear()
    killAsyncAgentMock.mockClear()
    requestTeammateShutdownMock.mockClear()
  })

  it('opens the requested task directly into a detail and action surface', async () => {
    appStateMock.state = {
      tasks: {
        b1: makeShellTask(),
      },
    }

    const { BackgroundTasksPanel } = await import('./BackgroundTasksPanel.js')

    const output = await renderToString(
      <BackgroundTasksPanel initialDetailTaskId="b1" />,
      100,
    )

    expect(output).toContain('TASK DETAIL')
    expect(output).toContain('npm test')
    expect(output).toContain('command')
    expect(output).toContain('urn:agenc:task:b1:output')
    expect(output).toContain('stop')
    expect(output).toContain('← back')
  })

  it('falls back to the task list when the requested detail task no longer exists', async () => {
    appStateMock.state = {
      tasks: {
        b1: makeShellTask(),
        r1: makeTeammateTask({ id: 'r1' }),
      },
    }

    const { BackgroundTasksPanel } = await import('./BackgroundTasksPanel.js')

    const output = await renderToString(
      <BackgroundTasksPanel initialDetailTaskId="missing-task" />,
      100,
    )

    expect(output).toContain('BACKGROUND TASKS')
    expect(output).toContain('b1')
    expect(output).toContain('r1')
    expect(output).not.toContain('TASK DETAIL')
    expect(output).not.toContain('← back')
  })

  it('keeps terminal background tasks visible while the dialog is open', async () => {
    appStateMock.state = {
      tasks: {
        running: makeShellTask({
          id: 'running',
          status: 'running',
          command: 'npm test',
          startTime: 40,
        }),
        completed: makeShellTask({
          id: 'completed',
          status: 'completed',
          command: 'npm run build',
          startTime: 30,
        }),
        failed: makeShellTask({
          id: 'failed',
          status: 'failed',
          command: 'npm run lint',
          startTime: 20,
        }),
        killed: makeShellTask({
          id: 'killed',
          status: 'killed',
          command: 'npm run dev',
          startTime: 10,
        }),
      },
    }

    const { BackgroundTasksPanel } = await import('./BackgroundTasksPanel.js')
    terminalSizeMock.size = { columns: 148, rows: 30 }

    const output = await renderToString(<BackgroundTasksPanel />, 148)

    expect(output).not.toContain('No background tasks')
    expect(output).toContain('◐')
    expect(output).toContain('npm run build')
    expect(output).toContain('npm run lint')
    expect(output).toContain('npm run dev')
    expect(output).toContain('done')
    expect(output).toContain('failed')
    expect(output).toContain('cancelled')
  })

  it('renders long task logs in a scroll-bounded detail surface', async () => {
    terminalSizeMock.size = { columns: 80, rows: 26 }
    appStateMock.state = {
      tasks: {
        r1: makeTeammateTask({
          id: 'r1',
          messages: Array.from({ length: 24 }, (_, index) => ({
            message: `teammate log line ${index + 1}`,
          })),
        }),
      },
    }

    const { BackgroundTasksPanel } = await import('./BackgroundTasksPanel.js')

    const output = await renderToString(
      <BackgroundTasksPanel initialDetailTaskId="r1" />,
      80,
    )

    expect(output).toContain('TASK DETAIL')
    expect(output).toContain('scroll')
    expect(output).toContain('teammate log line 1')
    expect(output).not.toContain('teammate log line 24')
  })

  it('truncates long task list and detail text to the terminal width', async () => {
    const longCommand =
      'npm run extremely-long-background-command-name -- --with-a-very-long-argument'
    terminalSizeMock.size = { columns: 34, rows: 30 }
    appStateMock.state = {
      tasks: {
        b1: makeShellTask({
          command: longCommand,
          id: 'background-task-with-a-very-long-identifier',
          progress: {
            toolUseCount: 1234,
            tokenCount: 56789,
            lastActivity: {
              activityDescription:
                'reading a very long file path that would otherwise overflow the dialog',
            },
          },
        }),
      },
    }

    const { BackgroundTasksPanel } = await import('./BackgroundTasksPanel.js')

    const listOutput = await renderToString(<BackgroundTasksPanel />, 34)
    const detailOutput = await renderToString(
      <BackgroundTasksPanel initialDetailTaskId="b1" />,
      34,
    )

    expect(listOutput).not.toContain(longCommand)
    expect(detailOutput).not.toContain(longCommand)
    expect(`${listOutput}\n${detailOutput}`).toContain('…')
  })

  it('routes stop actions through the task helper and current tool-use context', async () => {
    const contextSetAppState = vi.fn()
    appStateMock.state = {
      tasks: {
        b1: makeShellTask(),
      },
    }

    const { BackgroundTasksPanel } = await import('./BackgroundTasksPanel.js')

    await renderToString(
      <BackgroundTasksPanel
        initialDetailTaskId="b1"
        toolUseContext={{ setAppState: contextSetAppState }}
      />,
      100,
    )

    if (!inputHandler.current) {
      throw new Error('BackgroundTasksPanel did not register input handling')
    }
    inputHandler.current('x', key())

    expect(killTaskMock).toHaveBeenCalledWith('b1', contextSetAppState)
  })

  it('does not invoke stop helpers for states those helpers cannot change', async () => {
    appStateMock.state = {
      tasks: {
        b1: makeShellTask({ status: 'pending' }),
      },
    }

    const { BackgroundTasksPanel } = await import('./BackgroundTasksPanel.js')

    const pendingShellOutput = await renderToString(
      <BackgroundTasksPanel initialDetailTaskId="b1" />,
      100,
    )
    expect(pendingShellOutput).not.toContain('x stop')

    if (!inputHandler.current) {
      throw new Error('BackgroundTasksPanel did not register input handling')
    }
    inputHandler.current('x', key())

    expect(killTaskMock).not.toHaveBeenCalled()
    expect(killAsyncAgentMock).not.toHaveBeenCalled()
    expect(requestTeammateShutdownMock).not.toHaveBeenCalled()

    appStateMock.state = {
      tasks: {
        t1: makeTeammateTask({ shutdownRequested: true }),
      },
    }
    inputHandler.current = undefined

    const shutdownTeammateOutput = await renderToString(
      <BackgroundTasksPanel initialDetailTaskId="t1" />,
      100,
    )
    expect(shutdownTeammateOutput).not.toContain('x stop')

    if (!inputHandler.current) {
      throw new Error('BackgroundTasksPanel did not register input handling')
    }
    inputHandler.current('x', key())

    expect(killTaskMock).not.toHaveBeenCalled()
    expect(killAsyncAgentMock).not.toHaveBeenCalled()
    expect(requestTeammateShutdownMock).not.toHaveBeenCalled()
  })
})
