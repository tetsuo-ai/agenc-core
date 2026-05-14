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

describe('BackgroundTasksDialog', () => {
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

    const { BackgroundTasksDialog } = await import('./BackgroundTasksDialog.js')

    const output = await renderToString(
      <BackgroundTasksDialog initialDetailTaskId="b1" />,
      100,
    )

    expect(output).toContain('Task details')
    expect(output).toContain('running · local_bash · npm test')
    expect(output).toContain('view output: urn:agenc:task:b1:output')
    expect(output).toContain('x stop')
    expect(output).toContain('back')
  })

  it('keeps terminal background tasks visible while the dialog is open', async () => {
    appStateMock.state = {
      tasks: {
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

    const { BackgroundTasksDialog } = await import('./BackgroundTasksDialog.js')

    const output = await renderToString(<BackgroundTasksDialog />, 100)

    expect(output).not.toContain('No background tasks')
    expect(output).toContain('completed · local_bash · npm run build')
    expect(output).toContain('failed · local_bash · npm run lint')
    expect(output).toContain('killed · local_bash · npm run dev')
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

    const { BackgroundTasksDialog } = await import('./BackgroundTasksDialog.js')

    const listOutput = await renderToString(<BackgroundTasksDialog />, 34)
    const detailOutput = await renderToString(
      <BackgroundTasksDialog initialDetailTaskId="b1" />,
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

    const { BackgroundTasksDialog } = await import('./BackgroundTasksDialog.js')

    await renderToString(
      <BackgroundTasksDialog
        initialDetailTaskId="b1"
        toolUseContext={{ setAppState: contextSetAppState }}
      />,
      100,
    )

    if (!inputHandler.current) {
      throw new Error('BackgroundTasksDialog did not register input handling')
    }
    inputHandler.current('x', key())

    expect(killTaskMock).toHaveBeenCalledWith('b1', contextSetAppState)
  })
})
