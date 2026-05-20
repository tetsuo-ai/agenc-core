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
  size: { columns: 80, rows: 24 },
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

describe('BackgroundTasksPanel empty state coverage', () => {
  beforeEach(() => {
    appStateMock.state = { tasks: {} }
    appStateMock.setAppState.mockClear()
    terminalSizeMock.size = { columns: 80, rows: 24 }
    inputHandler.current = undefined
    killTaskMock.mockClear()
    killAsyncAgentMock.mockClear()
    requestTeammateShutdownMock.mockClear()
  })

  it('renders the empty panel and only dismisses on explicit quit input', async () => {
    const onDone = vi.fn()
    const { BackgroundTasksPanel } = await import('./BackgroundTasksPanel.js')

    const output = await renderToString(
      <BackgroundTasksPanel onDone={onDone} />,
      80,
    )

    expect(output).toContain('BACKGROUND TASKS')
    expect(output).toContain('0 running')
    expect(output).toContain('0 finished')
    expect(output).toContain('No background tasks')

    if (!inputHandler.current) {
      throw new Error('BackgroundTasksPanel did not register input handling')
    }

    inputHandler.current('', key())
    expect(onDone).not.toHaveBeenCalled()

    inputHandler.current('q', key())
    expect(onDone).toHaveBeenCalledTimes(1)

    inputHandler.current('', key({ escape: true }))
    expect(onDone).toHaveBeenCalledTimes(2)
    expect(killTaskMock).not.toHaveBeenCalled()
    expect(killAsyncAgentMock).not.toHaveBeenCalled()
    expect(requestTeammateShutdownMock).not.toHaveBeenCalled()
  })
})
