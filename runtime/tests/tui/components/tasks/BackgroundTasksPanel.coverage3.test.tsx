import { PassThrough } from 'node:stream'

import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createRoot } from '../../ink.js'
import { renderToString } from '../../../utils/staticRender.js'

const appStateMock = vi.hoisted(() => ({
  state: { tasks: {} } as Record<string, unknown>,
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
const tailFileMock = vi.hoisted(() => vi.fn())
const getTaskOutputPathMock = vi.hoisted(() =>
  vi.fn((taskId: string) => `/tmp/${taskId}.log`),
)

type TestStdin = PassThrough & {
  isTTY: boolean
  ref: () => void
  setRawMode: (mode: boolean) => void
  unref: () => void
}

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

vi.mock('../../../utils/fsOperations.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../utils/fsOperations.js')>()
  return {
    ...actual,
    tailFile: tailFileMock,
  }
})

vi.mock('../../../utils/task/diskOutput.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../utils/task/diskOutput.js')>()
  return {
    ...actual,
    getTaskOutputPath: getTaskOutputPathMock,
  }
})

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
    id: 'shell-task',
    type: 'local_bash',
    status: 'running',
    description: 'Run shell task',
    startTime: Date.now() - 2_000,
    outputFile: 'urn:agenc:task:shell-task:output',
    outputOffset: 0,
    notified: false,
    command: 'npm run test',
    kind: 'bash',
    isBackgrounded: true,
    ...overrides,
  }
}

function makeLocalAgentTask(overrides: Record<string, unknown> = {}) {
  return {
    id: 'local-agent-task',
    type: 'local_agent',
    status: 'running',
    description: 'Local agent task',
    startTime: Date.now() - 5_000,
    outputFile: 'urn:agenc:task:local-agent-task:output',
    outputOffset: 0,
    notified: false,
    agentId: 'agent-local',
    agentType: 'worker',
    model: 'local-model',
    prompt: 'Check the task panel',
    retrieved: false,
    pendingMessages: [],
    messages: [],
    lastReportedToolCount: 0,
    lastReportedTokenCount: 0,
    isBackgrounded: true,
    retain: false,
    diskLoaded: false,
    ...overrides,
  }
}

function makeTeammateTask(overrides: Record<string, unknown> = {}) {
  return {
    id: 'teammate-task',
    type: 'in_process_teammate',
    status: 'running',
    description: 'Teammate task',
    startTime: Date.now() - 4_000,
    outputFile: 'urn:agenc:task:teammate-task:output',
    outputOffset: 0,
    notified: false,
    identity: {
      agentId: 'agent-teammate',
      agentName: 'Reviewer',
      teamName: 'runtime',
      planModeRequired: false,
      parentSessionId: 'parent-session',
    },
    prompt: 'Audit branches',
    model: 'teammate-model',
    selectedAgent: { agentType: 'explorer' },
    awaitingPlanApproval: false,
    permissionMode: 'default',
    pendingUserMessages: [],
    messages: [],
    isIdle: true,
    shutdownRequested: false,
    lastReportedToolCount: 0,
    lastReportedTokenCount: 0,
    ...overrides,
  }
}

describe('BackgroundTasksPanel branch coverage', () => {
  beforeEach(() => {
    appStateMock.state = { tasks: {}, agentNameRegistry: new Map() }
    appStateMock.setAppState.mockClear()
    inputHandler.current = undefined
    terminalSizeMock.size = { columns: 120, rows: 32 }
    killTaskMock.mockClear()
    killAsyncAgentMock.mockClear()
    requestTeammateShutdownMock.mockClear()
    tailFileMock.mockReset()
    tailFileMock.mockResolvedValue({ content: 'tail output', bytesTotal: 11 })
    getTaskOutputPathMock.mockClear()
  })

  it('renders tool-only current activity and registered local agent names', async () => {
    appStateMock.state = {
      agentNameRegistry: new Map([['Navigator', 'local-agent-task']]),
      tasks: {
        local: makeLocalAgentTask({
          progress: {
            toolUseCount: 1,
            lastActivity: {
              toolName: 'Edit',
              input: { file: 'src/tui/App.tsx' },
            },
          },
          messages: ['first note\n\nsecond note'],
          error: 'preview error',
        }),
      },
    }

    const { BackgroundTasksPanel } = await import('./BackgroundTasksPanel.js')
    const listOutput = await renderToString(<BackgroundTasksPanel />, 120)
    const detailOutput = await renderToString(
      <BackgroundTasksPanel initialDetailTaskId="local-agent-task" />,
      120,
    )
    const output = `${listOutput}\n${detailOutput}`

    expect(output).toContain('Navigator · Runner')
    expect(output).toContain('Edit {"file":"src/tui/App.tsx"}')
    expect(output).toContain('preview error')
    expect(output).toContain('first note')
    expect(output).toContain('second note')
  })

  it('renders selected teammate roles, idle state, and token-only usage', async () => {
    appStateMock.state = {
      tasks: {
        teammate: makeTeammateTask({
          progress: {
            tokenCount: 77,
            lastActivity: {
              toolName: 'Read',
              input: 'notes.md',
            },
          },
        }),
      },
    }

    const { BackgroundTasksPanel } = await import('./BackgroundTasksPanel.js')
    const output = await renderToString(
      <BackgroundTasksPanel initialDetailTaskId="teammate-task" />,
      120,
    )

    expect(output).toContain('Reviewer · Scanner')
    expect(output).toContain('idle')
    expect(output).toContain('77 tokens')
    expect(output).toContain('Read notes.md')
  })

  it('falls back for blank titles, missing timestamps, empty activity, and unknown selected-agent roles', async () => {
    appStateMock.state = {
      tasks: {
        blankTitle: makeLocalAgentTask({
          id: 'blank-title-task',
          status: 'completed',
          description: '   ',
          startTime: undefined,
          outputFile: 'urn:agenc:task:blank-title-task:output',
          prompt: '',
        }),
        teammate: makeTeammateTask({
          id: 'teammate-no-role',
          status: 'completed',
          startTime: undefined,
          selectedAgent: { agentType: 42 },
          progress: {
            lastActivity: {},
          },
        }),
      },
    }

    const { BackgroundTasksPanel } = await import('./BackgroundTasksPanel.js')
    const listOutput = await renderToString(<BackgroundTasksPanel />, 120)
    const detailOutput = await renderToString(
      <BackgroundTasksPanel initialDetailTaskId="teammate-no-role" />,
      120,
    )
    const output = `${listOutput}\n${detailOutput}`

    expect(output).toContain('blank-title-task')
    expect(output).toContain('Reviewer · Agent')
    expect(output).toContain('—')

    appStateMock.state = {
      tasks: {
        teammate: makeTeammateTask({
          progress: {
            lastActivity: {},
          },
        }),
      },
    }
    const emptyActivityOutput = await renderToString(<BackgroundTasksPanel />, 120)
    expect(emptyActivityOutput).toContain('teammate-task')
  })

  it('renders completed shell success details with empty output tails', async () => {
    tailFileMock.mockResolvedValue({
      content: '',
      bytesTotal: 0,
    })
    appStateMock.state = {
      tasks: {
        shell: makeShellTask({
          id: 'completed-shell',
          status: 'completed',
          command: 'true',
          result: { code: 0, interrupted: false },
        }),
      },
    }

    const { BackgroundTasksPanel } = await import('./BackgroundTasksPanel.js')
    const output = await renderToString(
      <BackgroundTasksPanel initialDetailTaskId="completed-shell" />,
      120,
    )

    expect(output).toContain('code 0')
    expect(output).toContain('no')
    expect(output).toContain('(no output)')
    expect(tailFileMock).toHaveBeenCalledTimes(1)
  })

  it('ignores shell tail completion after the detail view unmounts', async () => {
    let resolveTail:
      | undefined
      | ((value: { content: string; bytesTotal: number }) => void)
    tailFileMock.mockReturnValue(
      new Promise(resolve => {
        resolveTail = resolve
      }),
    )
    appStateMock.state = {
      tasks: {
        shell: makeShellTask({
          id: 'running-shell',
          command: 'npm run watch',
        }),
      },
    }
    const { stdin, stdout } = createStreams()
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    })

    try {
      const { BackgroundTasksPanel } = await import('./BackgroundTasksPanel.js')
      root.render(<BackgroundTasksPanel initialDetailTaskId="running-shell" />)
      await sleep()
      root.unmount()
      resolveTail?.({ content: 'late shell output', bytesTotal: 17 })
      await sleep()
    } finally {
      root.unmount()
      stdin.end()
      stdout.end()
    }

    expect(tailFileMock).toHaveBeenCalledWith('/tmp/running-shell.log', 8192)
  })

  it('covers list and detail keyboard navigation branches', async () => {
    appStateMock.state = {
      tasks: {
        finished: makeShellTask({
          id: 'finished-shell',
          status: 'completed',
          command: 'echo done',
          startTime: Date.now() - 3_000,
        }),
        running: makeShellTask({
          id: 'running-shell',
          command: 'npm run watch',
          startTime: Date.now() - 1_000,
        }),
      },
    }
    const { BackgroundTasksPanel } = await import('./BackgroundTasksPanel.js')
    await renderToString(<BackgroundTasksPanel />, 120)

    if (!inputHandler.current) {
      throw new Error('BackgroundTasksPanel did not register input handling')
    }
    inputHandler.current('', key({ upArrow: true }))
    inputHandler.current('', key({ downArrow: true }))
    inputHandler.current('', key({ rightArrow: true }))
    inputHandler.current('', key({ return: true }))
    inputHandler.current('l', key())
    inputHandler.current('z', key())

    inputHandler.current = undefined
    await renderToString(
      <BackgroundTasksPanel initialDetailTaskId="running-shell" />,
      120,
    )
    if (!inputHandler.current) {
      throw new Error('BackgroundTasksPanel detail did not register input handling')
    }
    inputHandler.current('', key({ leftArrow: true }))
    inputHandler.current('b', key())
    inputHandler.current('h', key())
    inputHandler.current('', key({ upArrow: true }))
    inputHandler.current('k', key())
    inputHandler.current('', key({ downArrow: true }))
    inputHandler.current('j', key())
    inputHandler.current('z', key())

    expect(killTaskMock).not.toHaveBeenCalled()
  })

  it('applies mounted detail scroll updates', async () => {
    appStateMock.state = {
      tasks: {
        local: makeLocalAgentTask({
          messages: ['one', 'two', 'three'],
        }),
      },
    }
    const { stdin, stdout } = createStreams()
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    })

    try {
      const { BackgroundTasksPanel } = await import('./BackgroundTasksPanel.js')
      root.render(<BackgroundTasksPanel initialDetailTaskId="local-agent-task" />)
      await sleep()
      if (!inputHandler.current) {
        throw new Error('BackgroundTasksPanel did not register mounted input handling')
      }
      inputHandler.current('', key({ downArrow: true }))
      await sleep()
      inputHandler.current('', key({ upArrow: true }))
      await sleep()
    } finally {
      root.unmount()
      stdin.end()
      stdout.end()
    }

    expect(killTaskMock).not.toHaveBeenCalled()
  })

  it('handles app state without a tasks object', async () => {
    appStateMock.state = {
      agentNameRegistry: new Map(),
    }

    const { BackgroundTasksPanel } = await import('./BackgroundTasksPanel.js')
    const output = await renderToString(<BackgroundTasksPanel />, 120)

    expect(output).toContain('No background tasks')
  })
})

function createStreams(): {
  readonly stdin: TestStdin
  readonly stdout: PassThrough
} {
  const stdout = new PassThrough()
  const stdin = new PassThrough() as TestStdin

  stdin.isTTY = true
  stdin.ref = () => {}
  stdin.setRawMode = () => {}
  stdin.unref = () => {}
  ;(stdout as unknown as { columns: number; rows: number; isTTY: boolean }).columns = 120
  ;(stdout as unknown as { columns: number; rows: number; isTTY: boolean }).rows = 32
  ;(stdout as unknown as { columns: number; rows: number; isTTY: boolean }).isTTY = true
  stdout.resume()

  return { stdin, stdout }
}

function sleep(ms = 20): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
